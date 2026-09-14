import { describe, expect, it } from "vitest";
import { buildDocReport, buildQaChecklist, parseTaskActions } from "../src/task-actions";

function block(body: string): string {
  return "```kermanych-action\n" + body + "\n```";
}

describe("parseTaskActions — qa-checklist", () => {
  it("reads a well-formed checklist, ignoring surrounding prose", () => {
    const raw =
      "PR opened: https://github.com/o/r/pull/7\n\n" +
      block('{ "kind": "qa-checklist", "items": ["Увійти під новим юзером", "Відкрити порожню дошку"] }');
    expect(parseTaskActions(raw)).toEqual([
      { kind: "qa-checklist", items: ["Увійти під новим юзером", "Відкрити порожню дошку"] },
    ]);
  });

  it("trims items and drops blank and duplicate ones", () => {
    const raw = block('{ "kind": "qa-checklist", "items": ["  A  ", "", "A", "B", 42] }');
    expect(parseTaskActions(raw)).toEqual([{ kind: "qa-checklist", items: ["A", "B"] }]);
  });

  it("drops an all-blank checklist entirely", () => {
    expect(parseTaskActions(block('{ "kind": "qa-checklist", "items": ["", "  "] }'))).toEqual([]);
  });
});

describe("parseTaskActions — doc-report", () => {
  it("reads used and created refs, accepting bare-string and object paths", () => {
    const raw = block(
      '{ "kind": "doc-report", "used": ["docs/arch.md"], "created": [{ "path": "docs/qa.md", "note": "new" }] }',
    );
    expect(parseTaskActions(raw)).toEqual([
      { kind: "doc-report", used: [{ path: "docs/arch.md" }], created: [{ path: "docs/qa.md", note: "new" }] },
    ]);
  });

  it("dedups by path, trims, and drops pathless refs", () => {
    const raw = block(
      '{ "kind": "doc-report", "used": [" a.md ", "a.md", { "note": "x" }], "created": [] }',
    );
    expect(parseTaskActions(raw)).toEqual([{ kind: "doc-report", used: [{ path: "a.md" }], created: [] }]);
  });

  it("drops a report with neither used nor created", () => {
    expect(parseTaskActions(block('{ "kind": "doc-report", "used": [], "created": [] }'))).toEqual([]);
  });
});

describe("parseTaskActions — shared behaviour", () => {
  it("returns both artifacts from one reply, in document order", () => {
    const raw =
      block('{ "kind": "doc-report", "used": ["docs/a.md"], "created": [] }') +
      "\n\n" +
      block('{ "kind": "qa-checklist", "items": ["Check X"] }');
    expect(parseTaskActions(raw).map((a) => a.kind)).toEqual(["doc-report", "qa-checklist"]);
  });

  it("ignores unknown kinds and prose", () => {
    expect(parseTaskActions("just prose")).toEqual([]);
    expect(parseTaskActions(block('{ "kind": "unsupported", "section": "x" }'))).toEqual([]);
  });

  it("tolerates unreadable JSON rather than throwing", () => {
    expect(parseTaskActions(block('{ "kind": "qa-checklist", "items": [oops] }'))).toEqual([]);
  });
});

describe("builders", () => {
  it("buildQaChecklist stamps metadata and starts every item unchecked with a stable id", () => {
    expect(buildQaChecklist(["A", "B"], { generatedAt: "2026-09-10T00:00:00.000Z", sessionId: "s1" })).toEqual({
      generatedAt: "2026-09-10T00:00:00.000Z",
      sessionId: "s1",
      items: [
        { id: "q1", text: "A", checked: false },
        { id: "q2", text: "B", checked: false },
      ],
    });
  });

  it("buildDocReport stamps metadata and carries the refs", () => {
    expect(
      buildDocReport({ used: [{ path: "a.md" }], created: [{ path: "b.md", note: "n" }] }, { generatedAt: "2026-09-10T00:00:00.000Z" }),
    ).toEqual({
      generatedAt: "2026-09-10T00:00:00.000Z",
      used: [{ path: "a.md" }],
      created: [{ path: "b.md", note: "n" }],
    });
  });

  it("omits sessionId when none is given", () => {
    expect("sessionId" in buildDocReport({ used: [{ path: "a.md" }], created: [] }, { generatedAt: "t" })).toBe(false);
  });
});
