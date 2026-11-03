import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceService } from "../src/voice/voice.service";
import { RegistryService } from "../src/registry/registry.service";
import { CodedError } from "../src/management/coded-error";

const KEY = "sk-proj-abcdefgh1234";

let dir: string;
let registry: RegistryService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kermanych-voice-"));
  registry = new RegistryService(join(dir, "test.sqlite"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return e instanceof CodedError ? e.code : `not coded: ${(e as Error).message}`;
  }
  return undefined;
}

describe("VoiceService — key custody", () => {
  it("stores, reports by hint only, and deletes on an empty key", () => {
    const svc = new VoiceService(registry, vi.fn(), {});
    expect(svc.keyStatus("u1")).toEqual({ source: null });
    expect(svc.setKey("u1", `  ${KEY}  `)).toEqual({ source: "stored", hint: "…1234" });
    expect(registry.getVoiceKey("u1")).toBe(KEY);
    expect(svc.keyStatus("u2")).toEqual({ source: null });
    expect(svc.setKey("u1", " ")).toEqual({ source: null });
    expect(registry.getVoiceKey("u1")).toBeUndefined();
  });

  it("OPENAI_API_KEY wins over the stored key for status and for calls", async () => {
    const fetchFn = vi.fn(async () => json(200, { id: "gpt-live-1" }));
    const svc = new VoiceService(registry, fetchFn, { OPENAI_API_KEY: "sk-env-9999" });
    svc.setKey("u1", KEY);
    expect(svc.keyStatus("u1")).toEqual({ source: "env", hint: "…9999" });
    await svc.check("u1");
    expect(fetchFn).toHaveBeenCalledWith("https://api.openai.com/v1/models/gpt-live-1", expect.objectContaining({ headers: { authorization: "Bearer sk-env-9999" } }));
  });
});

describe("VoiceService — check", () => {
  it("refuses with no key before calling OpenAI", async () => {
    const fetchFn = vi.fn();
    const svc = new VoiceService(registry, fetchFn, {});
    expect(await codeOf(svc.check("u1"))).toBe("voice_key_missing");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    [401, "voice_key_invalid"],
    [403, "voice_no_access"],
    [404, "voice_no_access"],
    [429, "voice_quota"],
    [500, "voice_upstream"],
  ])("maps OpenAI %i to %s", async (status, code) => {
    const svc = new VoiceService(registry, async () => json(status, { error: { message: `bad key ${KEY}` } }), {});
    svc.setKey("u1", KEY);
    expect(await codeOf(svc.check("u1"))).toBe(code);
  });

  it("names an unreachable OpenAI as a network failure", async () => {
    const svc = new VoiceService(registry, async () => { throw new TypeError("fetch failed"); }, {});
    svc.setKey("u1", KEY);
    expect(await codeOf(svc.check("u1"))).toBe("voice_network");
  });
});

describe("VoiceService — createSession", () => {
  const offer = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n";

  it("exchanges the offer for GPT-Live's answer with a client-delegation session", async () => {
    const fetchFn = vi.fn(async () => json(201, { session: { id: "live_123" }, transport: { type: "webrtc", sdp: "answer-sdp" } }));
    const svc = new VoiceService(registry, fetchFn, {});
    svc.setKey("u1", KEY);
    const out = await svc.createSession("u1", { sdp: offer, voice: "cedar", language: "Ukrainian" });
    expect(out).toEqual({ id: "live_123", sdp: "answer-sdp" });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/live/sessions");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body as string);
    expect(body.transport).toEqual({ type: "webrtc", sdp: offer });
    expect(body.session.model).toBe("gpt-live-1");
    expect(body.session.delegation).toEqual({ type: "client" });
    expect(body.session.audio).toEqual({ output: { voice: "cedar" } });
    expect(body.session.instructions).toContain("Speak Ukrainian");
  });

  it("refuses an unknown voice and a missing or oversized offer without calling OpenAI", async () => {
    const fetchFn = vi.fn();
    const svc = new VoiceService(registry, fetchFn, {});
    svc.setKey("u1", KEY);
    expect(await codeOf(svc.createSession("u1", { sdp: offer, voice: "nope", language: "Ukrainian" }))).toBe("voice_voice_invalid");
    expect(await codeOf(svc.createSession("u1", { sdp: " ", voice: "marin", language: "Ukrainian" }))).toBe("voice_offer_invalid");
    expect(await codeOf(svc.createSession("u1", { sdp: "x".repeat(70 * 1024), voice: "marin", language: "Ukrainian" }))).toBe("voice_offer_invalid");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("treats a 2xx without an answer as an upstream failure", async () => {
    const svc = new VoiceService(registry, async () => json(201, { session: { id: "live_1" } }), {});
    svc.setKey("u1", KEY);
    expect(await codeOf(svc.createSession("u1", { sdp: offer, voice: "marin", language: "Ukrainian" }))).toBe("voice_upstream");
  });
});
