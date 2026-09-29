import { describe, expect, it } from "vitest";
import { adfDoc, adfMarkdown, type AdfNode } from "../src/jira/jira-adf";

// The ticket body the Менеджмент chat files (renderTicketDescription's shape). Sent as text
// nodes it arrived in Jira as literal «##» and «- [ ]»; these tests pin that it now lands
// as the headings, lists and action items it spells.
const TICKET = [
  "## Context",
  "Customers **cannot** see who changed an invoice — see `InvoiceCard`.",
  "Second line of the same paragraph",
  "",
  "## User flow",
  "1. Opens an invoice",
  "2. Switches to «Історія»",
  "",
  "## Acceptance criteria",
  "- [ ] The invoice card has an «Історія» tab",
  "- [x] Every entry shows the author",
  "",
  "## Out of scope",
  "- Exporting the history to a file",
].join("\n");

// Node types top-down with the text they carry — the structure a Jira reader sees.
function outline(nodes: AdfNode[] | undefined): unknown[] {
  return (nodes ?? []).map((n) => (n.type === "text" ? n.text : n.content ? { [n.type]: outline(n.content) } : n.type));
}

describe("adfDoc", () => {
  it("turns the chat's ticket markdown into headings, lists and action items", () => {
    const doc = adfDoc(TICKET);
    expect(doc.type).toBe("doc");
    expect(doc.version).toBe(1);
    expect(outline(doc.content)).toEqual([
      { heading: ["Context"] },
      { paragraph: ["Customers ", "cannot", " see who changed an invoice — see ", "InvoiceCard", ".", "hardBreak", "Second line of the same paragraph"] },
      { heading: ["User flow"] },
      { orderedList: [{ listItem: [{ paragraph: ["Opens an invoice"] }] }, { listItem: [{ paragraph: ["Switches to «Історія»"] }] }] },
      { heading: ["Acceptance criteria"] },
      { taskList: [{ taskItem: ["The invoice card has an «Історія» tab"] }, { taskItem: ["Every entry shows the author"] }] },
      { heading: ["Out of scope"] },
      { bulletList: [{ listItem: [{ paragraph: ["Exporting the history to a file"] }] }] },
    ]);
    expect(doc.content[0]?.attrs).toEqual({ level: 2 });
    const [todo, done] = doc.content[5]!.content!;
    expect(todo?.attrs).toMatchObject({ state: "TODO" });
    expect(done?.attrs).toMatchObject({ state: "DONE" });
    // Jira needs a localId on every action item, unique within the document.
    expect(todo?.attrs?.localId).not.toBe(done?.attrs?.localId);
  });

  it("carries inline formatting as marks, never as literal punctuation", () => {
    const [p] = adfDoc("**bold** *em* ~~gone~~ `code` [site](https://x.dev) https://y.dev").content;
    const marked = p!.content!.filter((n) => n.marks).map((n) => [n.text, n.marks!.map((m) => m.type).join("+")]);
    expect(marked).toEqual([
      ["bold", "strong"],
      ["em", "em"],
      ["gone", "strike"],
      ["code", "code"],
      ["site", "link"],
      ["https://y.dev", "link"],
    ]);
    expect(p!.content!.map((n) => n.text ?? "").join("")).not.toMatch(/[*~`[\]]/);
  });

  // ADF allows `code` beside `link` only; one invalid mark would refuse the whole body.
  it("drops bold/italic around a code span instead of emitting an invalid mark pair", () => {
    const [p] = adfDoc("**a `b` c**").content;
    const code = p!.content!.find((n) => n.text === "b");
    expect(code?.marks).toEqual([{ type: "code" }]);
  });

  it("keeps nested task lists as siblings inside the parent task list", () => {
    const [list] = adfDoc("- [ ] parent\n  - [x] child").content;
    expect(outline([list!])).toEqual([{ taskList: [{ taskItem: ["parent"] }, { taskList: [{ taskItem: ["child"] }] }] }]);
  });

  it("splits a mixed list into runs, leaving plain items as bullets", () => {
    expect(outline(adfDoc("- [ ] task\n- plain\n- [ ] another").content)).toEqual([
      { taskList: [{ taskItem: ["task"] }] },
      { bulletList: [{ listItem: [{ paragraph: ["plain"] }] }] },
      { taskList: [{ taskItem: ["another"] }] },
    ]);
  });

  // ADF has no taskList inside a listItem and no heading inside one either.
  it("keeps nested checkboxes under a plain bullet and demotes a nested heading to bold", () => {
    const [list] = adfDoc("- plain\n  - [ ] sub\n- > ## deep").content;
    expect(JSON.stringify(list)).not.toContain("taskList");
    expect(JSON.stringify(list)).not.toContain("heading");
    expect(JSON.stringify(list)).toContain('"text":"deep","marks":[{"type":"strong"}]');
  });

  it("writes fenced code, quotes, rules and tables as their ADF blocks", () => {
    const doc = adfDoc("```ts\nconst x = 1;\n```\n\n> quoted\n\n---\n\n| a | b |\n|---|---|\n| 1 |  |");
    expect(doc.content.map((n) => n.type)).toEqual(["codeBlock", "blockquote", "rule", "table"]);
    expect(doc.content[0]).toEqual({ type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const x = 1;" }] });
    // Every cell holds a paragraph, an empty one included — ADF refuses a bare cell.
    expect(outline(doc.content[3]!.content)).toEqual([
      { tableRow: [{ tableHeader: [{ paragraph: ["a"] }] }, { tableHeader: [{ paragraph: ["b"] }] }] },
      { tableRow: [{ tableCell: [{ paragraph: ["1"] }] }, { tableCell: [{ paragraph: [] }] }] },
    ]);
  });

  // Jira reads a present-but-empty description as «clear it», which is exactly what an empty
  // string means here.
  it("yields an empty document for blank text", () => {
    expect(adfDoc("   \n  ").content).toEqual([]);
  });
});

describe("adfMarkdown", () => {
  it("returns empty for absent or malformed trees", () => {
    expect(adfMarkdown(undefined)).toBe("");
    expect(adfMarkdown("plain")).toBe("");
  });

  // The editor opens a ticket with this text and saves it back through adfDoc: a round trip
  // that changed the structure would reformat every ticket someone merely re-saved.
  it("round-trips the ticket markdown through ADF with its structure intact", () => {
    const markdown = adfMarkdown(adfDoc(TICKET));
    expect(markdown).toBe(
      [
        "## Context",
        "",
        "Customers **cannot** see who changed an invoice — see `InvoiceCard`.",
        "Second line of the same paragraph",
        "",
        "## User flow",
        "",
        "1. Opens an invoice",
        "2. Switches to «Історія»",
        "",
        "## Acceptance criteria",
        "",
        "- [ ] The invoice card has an «Історія» tab",
        "- [x] Every entry shows the author",
        "",
        "## Out of scope",
        "",
        "- Exporting the history to a file",
      ].join("\n"),
    );
    expect(outline(adfDoc(markdown).content)).toEqual(outline(adfDoc(TICKET).content));
  });

  it("reads what Jira's own editor writes: mentions, emoji, cards and nested lists", () => {
    const doc = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: "acc", text: "@Olha" } },
            { type: "text", text: " please check " },
            { type: "inlineCard", attrs: { url: "https://x.dev/1" } },
            { type: "emoji", attrs: { shortName: ":smile:", text: "😄" } },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "outer" }] },
                { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "inner" }] }] }] },
              ],
            },
          ],
        },
        { type: "mediaSingle", content: [{ type: "media", attrs: { id: "m" } }] },
      ],
    };
    expect(adfMarkdown(doc)).toBe("@Olha please check https://x.dev/1😄\n\n- outer\n  1. inner");
  });

  it("keeps surrounding spaces outside the emphasis delimiters", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }, { type: "text", text: " b ", marks: [{ type: "strong" }] }, { type: "text", text: "c" }] }] };
    expect(adfMarkdown(doc)).toBe("a **b** c");
  });
});
