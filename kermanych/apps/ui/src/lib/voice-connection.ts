// apps/ui/src/lib/voice-connection.ts
// The WebRTC half of a voice conversation (docs/specs/2026-11-02-voice-conversation.md): the
// microphone and GPT-Live's voice on one peer connection, GPT-Live's events on its data channel
// (`oai-events`). The SDP offer goes to the local api, which exchanges it with OpenAI under the
// operator's key (apps/api/src/voice/voice.service.ts); this module never sees the key.
//
// Kept apart from stores/voice.ts so the store's logic can be tested with a scripted connection:
// nothing here decides anything, it only moves audio and JSON.
import { levelOf } from './voice-gate';
import gateWorkletUrl from './voice-gate.worklet.ts?worker&url';

/** One server event from the data channel, as GPT-Live sent it. */
export type LiveEvent = { type: string; [k: string]: unknown };

export interface VoiceConnection {
  /** Sends one client event on the data channel; a closed channel drops it. */
  send(event: Record<string, unknown>): void;
  /** Stops the microphone track from carrying sound (GPT-Live is told separately). */
  setMicEnabled(on: boolean): void;
  /** The microphone's loudness right now, 0…1 — before the noise gate, so it can be calibrated. */
  micLevel(): number;
  /** The noise gate's threshold on `micLevel`'s scale, 0 = off. Without a gate, does nothing. */
  setGate(threshold: number): void;
  /** Tears everything down: tracks, channel, peer connection, audio element. */
  close(): void;
}

export interface VoiceConnectionHandlers {
  onEvent(event: LiveEvent): void;
  /** The channel or the peer connection died without `close()` being called. */
  onDrop(): void;
  /** The noise gate opened or closed (only with `gate`). */
  onGate?(open: boolean): void;
}

export interface VoiceConnectionOptions {
  /**
   * A noise gate in front of GPT-Live (docs/specs/2026-11-04-voice-background-noise.md,
   * decision 4): its starting threshold. Also turns the browser's automatic gain off, which would
   * otherwise lift a distant TV to the operator's level while they are silent. Dictation passes
   * none and keeps the plain microphone.
   */
  gate?: number;
}

/** Exchanges the SDP offer for GPT-Live's answer (the local api). */
export type SdpExchange = (offer: string) => Promise<{ sdp: string }>;

export type ConnectVoice = (exchange: SdpExchange, handlers: VoiceConnectionHandlers, options?: VoiceConnectionOptions) => Promise<VoiceConnection>;

/**
 * The browser's own words for a refused or missing microphone are English and technical: the
 * operator gets ours. Anything else is returned unchanged.
 */
export function micErrorWords(e: unknown, words: { denied: string; missing: string }): unknown {
  if (e instanceof DOMException && e.name === 'NotAllowedError') return new Error(words.denied);
  if (e instanceof DOMException && e.name === 'NotFoundError') return new Error(words.missing);
  return e;
}

const ICE_TIMEOUT_MS = 10_000;

export const connectVoice: ConnectVoice = async (exchange, handlers, options = {}) => {
  const pc = new RTCPeerConnection();
  const audio = new Audio();
  audio.autoplay = true;
  let mic: MediaStream | undefined;
  let ctx: AudioContext | undefined;
  let analyser: AnalyserNode | undefined;
  let gate: AudioWorkletNode | undefined;
  // What GPT-Live receives: the microphone itself, or the gate's output.
  let sent: MediaStream | undefined;
  let closed = false;

  const teardown = () => {
    closed = true;
    mic?.getTracks().forEach((track) => track.stop());
    sent?.getTracks().forEach((track) => track.stop());
    void ctx?.close().catch(() => {});
    channel.close();
    pc.close();
    audio.srcObject = null;
  };

  pc.addEventListener('track', (e) => {
    audio.srcObject = new MediaStream([e.track]);
    void audio.play().catch(() => {});
  });
  pc.addEventListener('connectionstatechange', () => {
    if (!closed && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) {
      teardown();
      handlers.onDrop();
    }
  });

  // The channel is created before the offer so the offer negotiates it.
  const channel = pc.createDataChannel('oai-events');
  channel.addEventListener('message', ({ data }) => {
    try {
      handlers.onEvent(JSON.parse(String(data)) as LiveEvent);
    } catch {
      // not JSON: nothing GPT-Live sends, nothing to act on
    }
  });
  channel.addEventListener('close', () => {
    if (closed) return;
    teardown();
    handlers.onDrop();
  });

  try {
    // The desktop app asks macOS first: Chromium alone gets a silent refusal once the operator
    // said no in System Settings, and the store words this refusal for them.
    if (window.kermanych?.voice && !(await window.kermanych.voice.requestMic()))
      throw new DOMException('microphone refused in System Settings', 'NotAllowedError');
    const gated = options.gate !== undefined;
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, ...(gated ? { autoGainControl: false } : {}) },
    });
    // The meter (and the gate) read the microphone directly; the meter's analyser is never in the
    // path of the audio GPT-Live receives.
    ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(mic);
    sent = mic;
    if (gated) {
      await ctx.audioWorklet.addModule(gateWorkletUrl);
      gate = new AudioWorkletNode(ctx, 'kermanych-voice-gate', { processorOptions: { threshold: options.gate } });
      gate.port.onmessage = ({ data }: MessageEvent<{ open?: boolean }>) => {
        if (typeof data.open === 'boolean') handlers.onGate?.(data.open);
      };
      const out = ctx.createMediaStreamDestination();
      source.connect(gate).connect(out);
      sent = out.stream;
    }
    for (const track of sent.getAudioTracks()) pc.addTrack(track, sent);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await iceGathered(pc);
    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new Error('no local SDP offer');
    const answer = await exchange(sdp);
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  } catch (e) {
    teardown();
    throw e;
  }

  const meter = analyser!;
  const samples = new Float32Array(meter.fftSize);

  return {
    send(event) {
      if (channel.readyState === 'open') channel.send(JSON.stringify(event));
    },
    setMicEnabled(on) {
      mic?.getAudioTracks().forEach((track) => (track.enabled = on));
      sent?.getAudioTracks().forEach((track) => (track.enabled = on));
    },
    micLevel() {
      meter.getFloatTimeDomainData(samples);
      return levelOf(samples);
    },
    setGate(threshold) {
      gate?.port.postMessage({ threshold });
    },
    close: teardown,
  };
};

function iceGathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    pc.removeEventListener('icegatheringstatechange', onState);
    reject(new Error('ICE gathering timed out'));
  }, ICE_TIMEOUT_MS);
  function onState() {
    if (pc.iceGatheringState !== 'complete') return;
    clearTimeout(timer);
    pc.removeEventListener('icegatheringstatechange', onState);
    resolve();
  }
  pc.addEventListener('icegatheringstatechange', onState);
  return promise;
}
