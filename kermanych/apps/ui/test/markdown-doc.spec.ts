import { describe, expect, it } from "vitest";
import { renderDoc, resolveRel } from "../src/lib/markdown";

const base = { folder: "docs", dir: "guide" }; // rendering docs/guide/page.md

describe("resolveRel", () => {
  it("resolves a sibling", () => expect(resolveRel("guide", "./img.png")).toBe("guide/img.png"));
  it("resolves a parent hop still inside the folder", () => expect(resolveRel("guide/sub", "../img.png")).toBe("guide/img.png"));
  it("rejects an escape above the folder root", () => expect(resolveRel("guide", "../../etc/passwd")).toBeNull());
  it("rejects an external url", () => expect(resolveRel("guide", "https://x/y.png")).toBeNull());
  it("rejects a bare anchor", () => expect(resolveRel("guide", "#section")).toBeNull());
});

describe("renderDoc", () => {
  it("does not turn a single newline into <br> (breaks:false)", () => {
    expect(renderDoc("a\nb", base)).not.toContain("<br");
  });

  it("highlights a fenced code block", () => {
    const html = renderDoc("```js\nconst x = 1;\n```", base);
    expect(html).toContain('class="hljs');
  });

  it("rewrites a relative image to data attributes with no src", () => {
    const html = renderDoc("![logo](./logo.png)", base);
    expect(html).toContain('data-doc-folder="docs"');
    expect(html).toContain('data-doc-path="guide/logo.png"');
    expect(html).not.toMatch(/<img[^>]*\ssrc=/);
  });

  it("keeps an absolute image url as a normal src", () => {
    const html = renderDoc("![x](https://cdn/x.png)", base);
    expect(html).toContain('src="https://cdn/x.png"');
  });

  it("rewrites a relative doc link to data attributes", () => {
    const html = renderDoc("[next](./other.md)", base);
    expect(html).toContain('data-doc-folder="docs"');
    expect(html).toContain('data-doc-path="guide/other.md"');
  });

  it("escapes embedded raw HTML (html:false kept)", () => {
    expect(renderDoc("<script>alert(1)</script>", base)).not.toContain("<script>");
  });
});
