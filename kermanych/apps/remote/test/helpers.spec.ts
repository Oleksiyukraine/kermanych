import { describe, expect, it } from "vitest";
import { base64UrlToBytes } from "../src/lib/bytes";
import { fitSize, MAX_SIDE, stripDataUrl } from "../src/lib/images";
import { isInlineImage, splitFences } from "../src/lib/text";

describe("base64UrlToBytes", () => {
  it("decodes base64url without padding", () => {
    // "-_8" = bytes 0xfb 0xff (needs one pad char in standard base64).
    expect([...base64UrlToBytes("-_8")]).toEqual([0xfb, 0xff]);
    expect([...base64UrlToBytes("AQID")]).toEqual([1, 2, 3]);
    expect([...base64UrlToBytes("AQ")]).toEqual([1]);
  });

  it("round-trips a VAPID-sized key (65 bytes)", () => {
    const raw = Uint8Array.from({ length: 65 }, (_, i) => (i * 37 + 4) & 0xff);
    const encoded = btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect([...base64UrlToBytes(encoded)]).toEqual([...raw]);
  });
});

describe("fitSize", () => {
  it("scales the longer side down to the limit, keeping the aspect", () => {
    expect(fitSize(4032, 3024)).toEqual({ width: MAX_SIDE, height: 1200 });
    expect(fitSize(3024, 4032)).toEqual({ width: 1200, height: MAX_SIDE });
  });

  it("never upscales", () => {
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitSize(1600, 1600)).toEqual({ width: 1600, height: 1600 });
  });

  it("rounds to whole pixels and keeps at least one", () => {
    expect(fitSize(5000, 1, 1600)).toEqual({ width: 1600, height: 1 });
    expect(fitSize(1001, 333, 500)).toEqual({ width: 500, height: 166 });
  });

  it("gives nothing for an empty image", () => {
    expect(fitSize(0, 100)).toEqual({ width: 0, height: 0 });
  });
});

describe("stripDataUrl", () => {
  it("drops the data: prefix", () => {
    expect(stripDataUrl("data:image/jpeg;base64,AAAA")).toBe("AAAA");
    expect(stripDataUrl("AAAA")).toBe("AAAA");
  });
});

describe("splitFences", () => {
  it("separates text from fenced code, keeping line breaks", () => {
    expect(splitFences("Here:\n```ts\nconst a = 1;\n\nconst b = 2;\n```\nDone.\nBye")).toEqual([
      { kind: "text", text: "Here:" },
      { kind: "code", lang: "ts", text: "const a = 1;\n\nconst b = 2;" },
      { kind: "text", text: "Done.\nBye" },
    ]);
  });

  it("runs an unclosed fence to the end as code", () => {
    expect(splitFences("a\n```\nx")).toEqual([
      { kind: "text", text: "a" },
      { kind: "code", lang: "", text: "x" },
    ]);
  });

  it("keeps markup as text", () => {
    expect(splitFences("<img src=x onerror=alert(1)>")).toEqual([{ kind: "text", text: "<img src=x onerror=alert(1)>" }]);
  });
});

describe("isInlineImage", () => {
  it("accepts only base64 image data URLs", () => {
    expect(isInlineImage("data:image/jpeg;base64,AAAA")).toBe(true);
    expect(isInlineImage("data:image/svg+xml;base64,AAAA")).toBe(false);
    expect(isInlineImage("https://example.com/a.png")).toBe(false);
    expect(isInlineImage("javascript:alert(1)")).toBe(false);
  });
});
