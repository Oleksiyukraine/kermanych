import { describe, expect, it } from "vitest";
import { buildQaChecklist, parseTaskActions } from "../src/task-actions";

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

describe("parseTaskActions — shared behaviour", () => {
  it("returns every artifact block in one reply, in document order", () => {
    const raw =
      block('{ "kind": "qa-checklist", "items": ["First"] }') +
      "\n\n" +
      block('{ "kind": "qa-checklist", "items": ["Second"] }');
    expect(parseTaskActions(raw).map((a) => a.items[0])).toEqual(["First", "Second"]);
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

  it("omits sessionId when none is given", () => {
    expect("sessionId" in buildQaChecklist(["A"], { generatedAt: "t" })).toBe(false);
  });
});
