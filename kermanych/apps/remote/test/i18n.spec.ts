import { describe, expect, it } from "vitest";
import { DICTIONARIES, langOf, relativeTime, statusText, t } from "../src/lib/i18n";

describe("dictionaries", () => {
  it("have the same keys in both languages", () => {
    expect(Object.keys(DICTIONARIES.en).sort()).toEqual(Object.keys(DICTIONARIES.uk).sort());
  });

  it("have no empty text", () => {
    for (const dict of Object.values(DICTIONARIES)) for (const text of Object.values(dict)) expect(text.trim()).not.toBe("");
  });

  it("use the same {params} in both languages", () => {
    const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(DICTIONARIES.uk) as (keyof typeof DICTIONARIES.uk)[]) {
      expect(params(DICTIONARIES.en[key]), key).toEqual(params(DICTIONARIES.uk[key]));
    }
  });
});

describe("langOf", () => {
  it("is Ukrainian for uk and English for everything else", () => {
    expect(langOf("uk")).toBe("uk");
    expect(langOf("uk-UA")).toBe("uk");
    expect(langOf("en-US")).toBe("en");
    expect(langOf("pl")).toBe("en");
    expect(langOf(undefined)).toBe("en");
  });
});

describe("t / statusText / relativeTime", () => {
  it("interpolates params", () => {
    expect(t("composer.photoLimit", { n: 4 }, "uk")).toBe("Не більше 4 фото в одному повідомленні.");
  });

  it("words every status in both languages", () => {
    expect(statusText("waiting_input", "uk")).toBe("потрібна відповідь");
    expect(statusText("waiting_input", "en")).toBe("response needed");
  });

  it("counts minutes, hours and days", () => {
    const now = Date.parse("2026-11-24T12:00:00Z");
    expect(relativeTime("2026-11-24T11:59:30Z", now, "uk")).toBe("щойно");
    expect(relativeTime("2026-11-24T11:55:00Z", now, "uk")).toBe("5 хв тому");
    expect(relativeTime("2026-11-24T09:00:00Z", now, "en")).toBe("3 h ago");
    expect(relativeTime("2026-11-22T12:00:00Z", now, "en")).toBe("2 d ago");
    expect(relativeTime("never", now, "en")).toBe("");
  });
});
