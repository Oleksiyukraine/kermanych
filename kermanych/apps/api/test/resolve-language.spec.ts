// apps/api/test/resolve-language.spec.ts
import { describe, it, expect } from "vitest";
import { resolveLanguage, languageAppendFor } from "../src/runtime/resolve-language";

describe("resolveLanguage", () => {
  it("env override wins over cached preference", () => {
    expect(resolveLanguage("en", "uk")).toBe("en");
    expect(resolveLanguage("uk", "en")).toBe("uk");
  });

  it("cached preference is used when env is absent", () => {
    expect(resolveLanguage(undefined, "uk")).toBe("uk");
  });

  it("resolves to undefined (no preference) when both are absent", () => {
    expect(resolveLanguage(undefined, undefined)).toBeUndefined();
  });

  it("ignores an invalid env value and falls back to cached or undefined", () => {
    expect(resolveLanguage("klingon", "uk")).toBe("uk");
    expect(resolveLanguage("klingon", undefined)).toBeUndefined();
    expect(resolveLanguage("", "en")).toBe("en");
  });
});

describe("languageAppendFor", () => {
  it("returns a directive naming the chosen language", () => {
    const append = languageAppendFor("uk", undefined);
    expect(append).toBeDefined();
    expect(append).toContain("Ukrainian");
  });

  it("returns undefined when no language is chosen", () => {
    expect(languageAppendFor(undefined, undefined)).toBeUndefined();
  });

  it("env override drives the directive", () => {
    expect(languageAppendFor(undefined, "en")).toContain("English");
  });
});
