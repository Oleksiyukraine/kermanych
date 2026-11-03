import { describe, expect, it } from "vitest";
import {
  DICTATION_IDLE_MS,
  DICTATION_PAUSE_MS,
  dictationLanguages,
  emptySegments,
  insertDictated,
  isDictationLanguages,
  segmentCommitted,
  segmentSettled,
  segmentsDone,
  vadStart,
  vadStep,
} from "../src/dictation";

// Voice dictation (docs/specs/2026-11-03-voice-dictation.md): the pure decisions behind the
// dictation store — phrase ends, insertion at the caret, release order of finished phrases.

describe("dictationLanguages", () => {
  it("speaks the agent's language with English terms, falling back to the ui locale", () => {
    expect(dictationLanguages("uk", "en")).toEqual(["uk", "en"]);
    expect(dictationLanguages("en-ste-80", "uk")).toEqual(["en"]);
    expect(dictationLanguages("zh", "uk")).toEqual(["zh-cn", "en"]);
    expect(dictationLanguages(null, "uk")).toEqual(["uk", "en"]);
    expect(dictationLanguages(undefined, "en")).toEqual(["en"]);
  });

  it("the api accepts exactly what it produces", () => {
    expect(isDictationLanguages(dictationLanguages("pl", "uk"))).toBe(true);
    expect(isDictationLanguages([])).toBe(false);
    expect(isDictationLanguages(["uk", "uk"])).toBe(false);
    expect(isDictationLanguages(["xx"])).toBe(false);
    expect(isDictationLanguages(["uk", "en", "de"])).toBe(false);
    expect(isDictationLanguages("uk")).toBe(false);
  });
});

describe("vadStep", () => {
  it("commits once after a pause that follows speech", () => {
    let s = vadStart(0);
    s = vadStep(s, 0.5, 100).state;
    const early = vadStep(s, 0, 100 + DICTATION_PAUSE_MS - 1);
    expect(early.commit).toBe(false);
    const pause = vadStep(early.state, 0, 100 + DICTATION_PAUSE_MS);
    expect(pause.commit).toBe(true);
    expect(vadStep(pause.state, 0, 100 + DICTATION_PAUSE_MS + 500).commit).toBe(false);
  });

  it("never commits silence alone, and reports idle after the silence limit", () => {
    const s = vadStart(0);
    expect(vadStep(s, 0, 5_000)).toMatchObject({ commit: false, idle: false });
    expect(vadStep(s, 0, DICTATION_IDLE_MS)).toMatchObject({ commit: false, idle: true });
  });

  it("speech restarts the silence clock", () => {
    const s = vadStep(vadStart(0), 0.5, DICTATION_IDLE_MS - 10).state;
    expect(vadStep(s, 0, DICTATION_IDLE_MS + 10).idle).toBe(false);
  });
});

describe("insertDictated", () => {
  it("fills an empty field", () => {
    expect(insertDictated("", 0, 0, " Додай кнопку. ")).toEqual({ value: "Додай кнопку.", caret: 13 });
  });

  it("joins after a word with one space and leaves the caret after the phrase", () => {
    expect(insertDictated("Перше.", 6, 6, "Друге.")).toEqual({ value: "Перше. Друге.", caret: 13 });
  });

  it("adds no space after a newline or before closing punctuation", () => {
    expect(insertDictated("a\n", 2, 2, "b")).toEqual({ value: "a\nb", caret: 3 });
    expect(insertDictated("(x)", 2, 2, "y")).toEqual({ value: "(x y)", caret: 4 });
  });

  it("separates from a following word in the middle of the text", () => {
    expect(insertDictated("ab cd", 3, 3, "x")).toEqual({ value: "ab x cd", caret: 4 });
  });

  it("replaces a selection, as typing would", () => {
    expect(insertDictated("one two three", 4, 7, "2")).toEqual({ value: "one 2 three", caret: 5 });
  });

  it("ignores an empty transcript", () => {
    expect(insertDictated("abc", 1, 1, "  ")).toEqual({ value: "abc", caret: 1 });
  });
});

describe("dictation segments", () => {
  it("releases phrases in commit order even when their text arrives out of order", () => {
    let s = segmentCommitted(segmentCommitted(emptySegments(), "i1"), "i2");
    const second = segmentSettled(s, "i2", "друге");
    expect(second.release).toEqual([]);
    s = second.segments;
    const first = segmentSettled(s, "i1", "перше");
    expect(first.release).toEqual(["перше", "друге"]);
    expect(segmentsDone(first.segments)).toBe(true);
  });

  it("a failed phrase releases nothing and does not hold back the next", () => {
    let s = segmentCommitted(segmentCommitted(emptySegments(), "i1"), "i2");
    s = segmentSettled(s, "i2", "друге").segments;
    expect(segmentSettled(s, "i1", null).release).toEqual(["друге"]);
  });

  it("a completion without a seen commit is released at once", () => {
    const out = segmentSettled(emptySegments(), "i9", "текст");
    expect(out.release).toEqual(["текст"]);
    expect(segmentsDone(out.segments)).toBe(true);
  });

  it("is not done while a committed phrase has no text yet", () => {
    expect(segmentsDone(segmentCommitted(emptySegments(), "i1"))).toBe(false);
  });
});
