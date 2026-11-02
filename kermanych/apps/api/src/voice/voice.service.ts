// apps/api/src/voice/voice.service.ts
// The api half of the voice conversation (docs/specs/2026-11-02-voice-conversation.md): the
// operator's OpenAI key and the one OpenAI call the window cannot make itself. The window holds
// the WebRTC connection and the bridge to the agent; it hands its SDP offer here, and this
// service exchanges it for GPT-Live's answer with the key, so the key never leaves this process.
import { Injectable, Optional } from "@nestjs/common";
import { VOICE_MODEL, isVoiceId, voiceLivePrompt } from "@kermanych/core";
import { RegistryService } from "../registry/registry.service";
import { CodedError } from "../management/coded-error";

const OPENAI = "https://api.openai.com/v1";

// An SDP offer with one audio track and a data channel is a few KiB; anything near this is not
// one, and it is the quickstart's own bound.
const MAX_OFFER_BYTES = 64 * 1024;

export type VoiceKeyStatus = { source: "env" | "stored" | null; hint?: string };
export type VoiceSessionRequest = { sdp: string; voice: string; language: string };
export type VoiceSessionAnswer = { id: string; sdp: string };

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

@Injectable()
export class VoiceService {
  constructor(
    private registry: RegistryService,
    // Test seam: specs hand in a scripted fetch. @Optional so Nest builds the real one.
    @Optional() private fetchFn: Fetch = (url, init) => fetch(url, init),
    // Test seam for the environment override.
    @Optional() private env: NodeJS.ProcessEnv = process.env,
  ) {}

  // The environment wins over the stored key: it is how a developer runs with a key they never
  // typed into the app. The hint is the last four characters — enough to tell two keys apart,
  // never enough to use one.
  keyStatus(userId: string): VoiceKeyStatus {
    const envKey = this.env.OPENAI_API_KEY?.trim();
    if (envKey) return { source: "env", hint: hint(envKey) };
    const stored = this.registry.getVoiceKey(userId);
    return stored ? { source: "stored", hint: hint(stored) } : { source: null };
  }

  setKey(userId: string, apiKey: string): VoiceKeyStatus {
    const key = apiKey.trim();
    if (key) this.registry.setVoiceKey(userId, key);
    else this.registry.deleteVoiceKey(userId);
    return this.keyStatus(userId);
  }

  // Asks OpenAI for the Live model under the key: a 200 proves both that the key is valid and
  // that its project may use GPT-Live, which a bare «list models» would not.
  async check(userId: string): Promise<void> {
    const key = this.requireKey(userId);
    const r = await this.call(`${OPENAI}/models/${VOICE_MODEL}`, { method: "GET", headers: { authorization: `Bearer ${key}` } });
    if (!r.ok) throw refusal(r.status);
  }

  async createSession(userId: string, req: VoiceSessionRequest): Promise<VoiceSessionAnswer> {
    if (typeof req.sdp !== "string" || !req.sdp.trim() || Buffer.byteLength(req.sdp) > MAX_OFFER_BYTES)
      throw new CodedError("voice_offer_invalid", "Немає опису WebRTC-з'єднання або він завеликий.");
    if (!isVoiceId(req.voice)) throw new CodedError("voice_voice_invalid", "Невідомий голос.");
    const key = this.requireKey(userId);
    const body = {
      session: {
        model: VOICE_MODEL,
        instructions: voiceLivePrompt(typeof req.language === "string" && req.language.trim() ? req.language.trim() : "Ukrainian"),
        audio: { output: { voice: req.voice } },
        delegation: { type: "client" },
      },
      transport: { type: "webrtc", sdp: req.sdp },
    };
    const r = await this.call(`${OPENAI}/live/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw refusal(r.status);
    const out = (await r.json()) as { session?: { id?: string }; transport?: { sdp?: string } };
    if (!out.session?.id || !out.transport?.sdp) throw refusal(r.status);
    return { id: out.session.id, sdp: out.transport.sdp };
  }

  private requireKey(userId: string): string {
    const key = this.env.OPENAI_API_KEY?.trim() || this.registry.getVoiceKey(userId);
    if (!key) throw new CodedError("voice_key_missing", "Ключ OpenAI не задано: Налаштування → Застосунок → «Голос».");
    return key;
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, init);
    } catch {
      throw new CodedError("voice_network", "OpenAI недоступний — перевірте з'єднання.");
    }
  }
}

function hint(key: string): string {
  return `…${key.slice(-4)}`;
}

// OpenAI's status → the reason the operator can act on. Its own error text is not relayed: it
// can echo part of the key.
function refusal(status: number): CodedError {
  if (status === 401) return new CodedError("voice_key_invalid", "OpenAI не прийняв ключ.");
  if (status === 403 || status === 404) return new CodedError("voice_no_access", "Цей ключ OpenAI не має доступу до GPT-Live.");
  if (status === 429) return new CodedError("voice_quota", "OpenAI: перевищено ліміт запитів або квоту.");
  return new CodedError("voice_upstream", `OpenAI відмовив (HTTP ${status}).`, { status });
}
