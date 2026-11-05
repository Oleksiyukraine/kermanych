import { describe, expect, it } from "vitest";
import { markdownToPlaneHtml, planeHtmlToMarkdown } from "../src/plane/plane-html";

// Every construct the app writes, in the canonical spelling the reader produces: blocks
// separated by one blank line, `-` bullets, `*` emphasis.
const CANONICAL = [
  "# Title",
  "",
  "Some **bold**, *italic*, ~~gone~~ and `code` with a [link](https://plane.so).",
  "Next line",
  "",
  "## Steps",
  "",
  "- one",
  "- two",
  "  - nested",
  "",
  "1. first",
  "2. second",
  "",
  "- [ ] todo",
  "- [x] done",
  "",
  "> quoted",
  "",
  "```ts",
  "const a = 1 < 2;",
  "```",
  "",
  "---",
  "",
  "https://example.com",
].join("\n");

// Markup whitespace is incidental; the assertions compare structure.
const flat = (html: string): string => html.replace(/\n/g, "");

describe("markdownToPlaneHtml", () => {
  it("renders a «- [ ]» list as Plane's own task list", () => {
    expect(flat(markdownToPlaneHtml("- [ ] todo\n- [x] done"))).toBe(
      '<ul data-type="taskList">' +
        '<li data-type="taskItem" data-checked="false"><p>todo</p></li>' +
        '<li data-type="taskItem" data-checked="true"><p>done</p></li>' +
        "</ul>",
    );
  });

  it("keeps a mixed list a plain list — Plane's task list holds task items only", () => {
    const html = markdownToPlaneHtml("- [ ] todo\n- plain");
    expect(html).not.toContain("taskList");
    expect(flat(html)).toBe("<ul><li>[ ] todo</li><li>plain</li></ul>");
  });

  it("renders headings, marks, line breaks and escapes raw HTML", () => {
    expect(flat(markdownToPlaneHtml("## Context\n**a** <script>x</script>\nnext"))).toBe(
      "<h2>Context</h2><p><strong>a</strong> &lt;script&gt;x&lt;/script&gt;<br>next</p>",
    );
  });

  it("writes Plane's empty description for a blank body", () => {
    expect(markdownToPlaneHtml("  \n ")).toBe("<p></p>");
  });
});

describe("planeHtmlToMarkdown", () => {
  it("round-trips every construct the app writes", () => {
    expect(planeHtmlToMarkdown(markdownToPlaneHtml(CANONICAL))).toBe(CANONICAL);
  });

  it("reads Plane's own editor markup, task items and decorations included", () => {
    const html =
      '<h2 class="editor-heading-block">Plan</h2>' +
      '<ul class="list-disc pl-7 space-y-[--list-spacing-y] tight" data-tight="true">' +
      '<li class="not-prose space-y-2"><p class="editor-paragraph-block">first</p></li></ul>' +
      '<ul data-type="taskList"><li data-checked="true" data-type="taskItem">' +
      '<label><input type="checkbox" checked="checked"><span></span></label>' +
      '<div><p class="editor-paragraph-block">Ship it</p></div></li></ul>' +
      '<p class="editor-paragraph-block">Plain &amp; simple&nbsp;<mention-component entity_name="user_mention"></mention-component></p>' +
      '<image-component src="asset-uuid"></image-component>' +
      "<p></p>";
    expect(planeHtmlToMarkdown(html)).toBe("## Plan\n\n- first\n\n- [x] Ship it\n\nPlain & simple");
  });

  it("reads Plane's empty description as an empty body", () => {
    expect(planeHtmlToMarkdown("<p></p>")).toBe("");
    expect(planeHtmlToMarkdown("")).toBe("");
  });

  it("lets unknown tags contribute their text and survives sloppy markup", () => {
    expect(planeHtmlToMarkdown('<p>See <custom-chip data-x="1">WEB-7</custom-chip> and <b> bold </b> 1 < 2</p><ul><li>open')).toBe(
      "See WEB-7 and **bold** 1 < 2\n\n- open",
    );
  });

  it("keeps code verbatim and decodes its entities", () => {
    expect(planeHtmlToMarkdown('<pre><code class="language-sh">a  &amp;&amp;\n  b\n</code></pre>')).toBe("```sh\na  &&\n  b\n```");
  });
});
