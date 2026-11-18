import { describe, expect, it } from "vitest";
import {
  DICTATION_IDLE_MS,
  DICTATION_PAUSE_MS,
  dictationLanguage,
  emptySegments,
  insertDictated,
  isDictationLanguage,
  isInventedPhrase,
  segmentCommitted,
  segmentSettled,
  segmentsDone,
  vadStart,
  vadStep,
} from "../src/dictation";

// Voice dictation (docs/specs/2026-11-14-local-voice-dictation.md): the pure decisions behind the
// dictation store — phrase ends, insertion at the caret, release order of finished phrases, the
// recogniser's inventions.

describe("dictationLanguage", () => {
  it("is the agent's language, falling back to the ui locale", () => {
    expect(dictationLanguage("uk", "en")).toBe("uk");
    expect(dictationLanguage("en-ste-80", "uk")).toBe("en");
    expect(dictationLanguage("zh", "uk")).toBe("zh");
    expect(dictationLanguage(null, "uk")).toBe("uk");
    expect(dictationLanguage(undefined, "en")).toBe("en");
  });

  it("the api accepts exactly what it produces", () => {
    expect(isDictationLanguage(dictationLanguage("pl", "uk"))).toBe(true);
    expect(isDictationLanguage("xx")).toBe(false);
    expect(isDictationLanguage(["uk"])).toBe(false);
  });
});

describe("isInventedPhrase", () => {
  it("drops Whisper's sign-offs heard in silence or a cough", () => {
    expect(isInventedPhrase("Дякую.")).toBe(true);
    expect(isInventedPhrase("Дякую за перегляд!")).toBe(true);
    expect(isInventedPhrase("Субтитри зроблені спільнотою Amara.org")).toBe(true);
    expect(isInventedPhrase("Thank you for watching.")).toBe(true);
    expect(isInventedPhrase(" … ")).toBe(true);
    // Sounds described instead of transcribed (seen on the cough-only recording).
    expect(isInventedPhrase("*coughs*")).toBe(true);
    expect(isInventedPhrase("*клук*")).toBe(true);
    expect(isInventedPhrase("[музика]")).toBe(true);
    // A bare «Музика» with no brackets came back for a pure 220 Hz tone.
    expect(isInventedPhrase("Музика")).toBe(true);
    expect(isInventedPhrase("Музика.")).toBe(true);
    expect(isInventedPhrase("Music")).toBe(true);
    expect(isInventedPhrase("music.")).toBe(true);
  });

  it("keeps a real request that merely contains such words", () => {
    expect(isInventedPhrase("Дякую, а тепер зроби кнопку синьою.")).toBe(false);
    expect(isInventedPhrase("Другий варіант.")).toBe(false);
    expect(isInventedPhrase("Зміни текст (той, що в хедері).")).toBe(false);
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

  it("a noise gate above the speech level raises what counts as speech", () => {
    expect(vadStep(vadStart(0), 0.12, 10).state.pending).toBe(true);
    expect(vadStep(vadStart(0), 0.12, 10, { speechLevel: 0.15 }).state.pending).toBe(false);
  });

  it("a composer's longer silence limit", () => {
    expect(vadStep(vadStart(0), 0, DICTATION_IDLE_MS, { idleMs: DICTATION_IDLE_MS * 10 }).idle).toBe(false);
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
