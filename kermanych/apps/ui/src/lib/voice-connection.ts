// apps/ui/src/lib/voice-connection.ts
// The WebRTC half of a voice conversation (docs/specs/2026-11-02-voice-conversation.md): the
// microphone and GPT-Live's voice on one peer connection, GPT-Live's events on its data channel
// (`oai-events`). The SDP offer goes to the local api, which exchanges it with OpenAI under the
// operator's key (apps/api/src/voice/voice.service.ts); this module never sees the key.
//
// Kept apart from stores/voice.ts so the store's logic can be tested with a scripted connection:
// nothing here decides anything, it only moves audio and JSON.

/** One server event from the data channel, as GPT-Live sent it. */
export type LiveEvent = { type: string; [k: string]: unknown };

export interface VoiceConnection {
  /** Sends one client event on the data channel; a closed channel drops it. */
  send(event: Record<string, unknown>): void;
  /** Stops the microphone track from carrying sound (GPT-Live is told separately). */
  setMicEnabled(on: boolean): void;
  /** The microphone's loudness right now, 0…1. */
  micLevel(): number;
  /** Tears everything down: tracks, channel, peer connection, audio element. */
  close(): void;
}

export interface VoiceConnectionHandlers {
  onEvent(event: LiveEvent): void;
  /** The channel or the peer connection died without `close()` being called. */
  onDrop(): void;
}

/** Exchanges the SDP offer for GPT-Live's answer (the local api). */
export type SdpExchange = (offer: string) => Promise<{ sdp: string }>;

export type ConnectVoice = (exchange: SdpExchange, handlers: VoiceConnectionHandlers) => Promise<VoiceConnection>;

const ICE_TIMEOUT_MS = 10_000;

export const connectVoice: ConnectVoice = async (exchange, handlers) => {
  const pc = new RTCPeerConnection();
  const audio = new Audio();
  audio.autoplay = true;
  let mic: MediaStream | undefined;
  let ctx: AudioContext | undefined;
  let closed = false;

  const teardown = () => {
    closed = true;
    mic?.getTracks().forEach((track) => track.stop());
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
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    for (const track of mic.getAudioTracks()) pc.addTrack(track, mic);

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

  // Loudness for the voice bar's level meter: an analyser on the microphone, never in the path
  // of the audio GPT-Live receives.
  ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(mic).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  return {
    send(event) {
      if (channel.readyState === 'open') channel.send(JSON.stringify(event));
    },
    setMicEnabled(on) {
      mic?.getAudioTracks().forEach((track) => (track.enabled = on));
    },
    micLevel() {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      // RMS of speech sits around 0.02–0.2; scaled so normal speech fills most of the meter.
      return Math.min(1, Math.sqrt(sum / samples.length) * 6);
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
