import { describe, expect, it } from "vitest";
import type { RpcExtensionUIRequest, TranscriptEntry } from "../src/types";
import {
  COMMENTARY_CHUNK_CHARS,
  delegationAction,
  finalReply,
  parseUiAnswer,
  shouldHangUp,
  takeUtterance,
  toCommentaryChunks,
  unwrapVoiceMessage,
  voiceMessagePrompt,
  VOICE_PHRASE_GAP_MS,
  VOICE_SILENCE_HANGUP_MS,
} from "../src/voice-bridge";
import { voiceLanguage } from "../src/voice";

const select = (options: string[]): RpcExtensionUIRequest => ({ type: "extension_ui_request", id: "q1", method: "select", title: "Pick", options });
const confirm: RpcExtensionUIRequest = { type: "extension_ui_request", id: "q2", method: "confirm", title: "Go?" };

describe("voice message wrapping", () => {
  it("round-trips the operator's words, multi-line included", () => {
    const said = "зроби кнопку\nі тест до неї";
    expect(unwrapVoiceMessage(voiceMessagePrompt(said))).toBe(said);
  });

  it("leaves a typed message alone", () => {
    expect(unwrapVoiceMessage("[Kermanych voice conversation] typed by hand")).toBeNull();
  });
});

describe("takeUtterance", () => {
  it("takes the fragments up to the delegation and keeps the later ones", () => {
    const heard = [
      { text: "Додай ", startMs: 100, endMs: 500 },
      { text: "кнопку  ", startMs: 600, endMs: 900 },
      { text: "а ще", startMs: 2500, endMs: 2800 },
    ];
    expect(takeUtterance(heard, 1000)).toEqual({ text: "Додай кнопку", rest: [{ text: "а ще", startMs: 2500, endMs: 2800 }] });
  });

  it("drops the background heard before the operator's last phrase", () => {
    const heard = [
      { text: "Завтра хмарно, ", startMs: 0, endMs: 1500 },
      { text: "дощ увечері.", startMs: 1600, endMs: 3000 },
      { text: "Запусти ", startMs: 3000 + VOICE_PHRASE_GAP_MS, endMs: 6500 },
      { text: "тести", startMs: 6600, endMs: 7000 },
    ];
    expect(takeUtterance(heard, 7000)).toEqual({ text: "Запусти тести", rest: [] });
  });

  it("keeps a phrase whole across a pause shorter than the gap", () => {
    const heard = [
      { text: "Додай кнопку, ", startMs: 0, endMs: 1000 },
      { text: "а потім тест", startMs: 1000 + VOICE_PHRASE_GAP_MS - 1, endMs: 5000 },
    ];
    expect(takeUtterance(heard, 5000).text).toBe("Додай кнопку, а потім тест");
  });
});

describe("parseUiAnswer — select", () => {
  const req = select(["Перший шлях", "Другий шлях", "Нічого не робити"]);

  it.each([
    ["давай другий", "Другий шлях"],
    ["варіант 3", "Нічого не робити"],
    ["Перший.", "Перший шлях"],
    ["останній", "Нічого не робити"],
    ["the second one", "Другий шлях"],
    ["нічого не робити", "Нічого не робити"],
  ])("«%s» picks «%s»", (said, value) => {
    expect(parseUiAnswer(req, said)).toEqual({ type: "extension_ui_response", id: "q1", value });
  });

  it.each([["перший чи другий"], ["варіант 7"], ["не знаю"]])("«%s» picks nothing", (said) => {
    expect(parseUiAnswer(req, said)).toBeNull();
  });
});

describe("parseUiAnswer — confirm", () => {
  it.each([
    ["Так, роби", true],
    ["звісно", true],
    ["ні", false],
    ["не роби цього", false],
    ["no", false],
  ])("«%s» → %s", (said, confirmed) => {
    expect(parseUiAnswer(confirm, said)).toEqual({ type: "extension_ui_response", id: "q2", confirmed });
  });

  it("refuses to choose between a yes and a no", () => {
    expect(parseUiAnswer(confirm, "так, хоча ні")).toBeNull();
    expect(parseUiAnswer(confirm, "подумаю")).toBeNull();
  });
});

describe("delegationAction", () => {
  it("sends plain speech as a message when no question is pending", () => {
    expect(delegationAction(" додай тест ", undefined)).toEqual({ kind: "send", text: "додай тест" });
  });

  it("answers the pending question, and asks for the number when the answer is unclear", () => {
    expect(delegationAction("другий", select(["a", "b"]))).toEqual({ kind: "answer", response: { type: "extension_ui_response", id: "q1", value: "b" } });
    expect(delegationAction("не знаю", select(["a", "b"]))).toMatchObject({ kind: "askAgain" });
  });

  it("takes free text for input questions verbatim", () => {
    const req: RpcExtensionUIRequest = { type: "extension_ui_request", id: "q3", method: "input", title: "Name?" };
    expect(delegationAction("feature/voice", req)).toEqual({ kind: "answer", response: { type: "extension_ui_response", id: "q3", value: "feature/voice" } });
  });

  it("asks again when nothing was heard", () => {
    expect(delegationAction("  ", undefined)).toMatchObject({ kind: "askAgain" });
  });
});

describe("toCommentaryChunks", () => {
  it("points at the chat instead of reading code and tables", () => {
    const [chunk] = toCommentaryChunks("Ось зміна:\n\n```ts\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nГотово.");
    expect(chunk).toContain("[code block — shown in the chat]");
    expect(chunk).toContain("[table — shown in the chat]");
    expect(chunk).not.toContain("const a");
    expect(chunk).not.toContain("| 1 |");
  });

  it("keeps every chunk within the limit and loses no text", () => {
    const sentence = "Це досить довге речення про архітектуру сесій і мосту. ";
    const text = Array.from({ length: 5 }, () => sentence.repeat(8).trim()).join("\n\n");
    const chunks = toCommentaryChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(COMMENTARY_CHUNK_CHARS);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });
});

describe("finalReply", () => {
  const e = (kind: "user_text" | "assistant_text", id: string): TranscriptEntry => ({ kind, id, at: 0, text: id });

  it("is the last assistant message after the operator's last message", () => {
    expect(finalReply([e("user_text", "u1"), e("assistant_text", "a1"), e("assistant_text", "a2")])?.id).toBe("a2");
  });

  it("is nothing when the operator spoke last", () => {
    expect(finalReply([e("assistant_text", "a1"), e("user_text", "u1")])).toBeUndefined();
  });
});

describe("shouldHangUp", () => {
  it("hangs up after the silence window, never while the agent works", () => {
    expect(shouldHangUp(0, false, VOICE_SILENCE_HANGUP_MS - 1)).toBe(false);
    expect(shouldHangUp(0, false, VOICE_SILENCE_HANGUP_MS)).toBe(true);
    expect(shouldHangUp(0, true, VOICE_SILENCE_HANGUP_MS * 10)).toBe(false);
  });
});

describe("voiceLanguage", () => {
  it("follows the agent language, STE as English, else the ui locale", () => {
    expect(voiceLanguage("de", "uk")).toBe("German");
    expect(voiceLanguage("en-ste-80", "uk")).toBe("English");
    expect(voiceLanguage(null, "uk")).toBe("Ukrainian");
    expect(voiceLanguage(undefined, "en")).toBe("English");
  });
});
