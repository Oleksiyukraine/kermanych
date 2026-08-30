import { expect, test } from "vitest";
import { MANAGEMENT_SECTIONS, managementSection } from "../src/management";
import { parseManagementReply, validateManagementAction } from "../src/management-actions";

function block(body: string): string {
  return "```kermanych-action\n" + body + "\n```";
}

// The refusal path, which is the whole of «if the assistant cannot act on a page, say why».
// `unsupported` carries only WHICH section and WHAT was asked; the reason the operator reads
// is looked up in the section table, so the model cannot soften it.
test("an unsupported block is parsed out and the prose survives without it", () => {
  const r = parseManagementReply(
    "Цей розділ ще не реалізований.\n\n" +
      block('{"kind":"unsupported","section":"management-releases","request":"додай нотатку релізу"}') +
      "\n\nМожу натомість почитати репозиторії.",
  );
  expect(r.rejected).toEqual([]);
  expect(r.actions).toEqual([
    { kind: "unsupported", section: "management-releases", request: "додай нотатку релізу" },
  ]);
  expect(r.text).toBe("Цей розділ ще не реалізований.\n\nМожу натомість почитати репозиторії.");
  expect(r.text).not.toContain("kermanych-action");
});

test("no block means no action and the answer is returned untouched", () => {
  const r = parseManagementReply("У воркспейсі два репозиторії: Альфа і Бета.");
  expect(r.actions).toEqual([]);
  expect(r.rejected).toEqual([]);
  expect(r.text).toBe("У воркспейсі два репозиторії: Альфа і Бета.");
});

test("an indented block inside a list item is still recognised", () => {
  const r = parseManagementReply("- відмова:\n  " + block('{"kind":"unsupported","section":"storage"}'));
  expect(r.actions).toEqual([{ kind: "unsupported", section: "storage", request: "" }]);
});

test("one block may carry an array of refusals", () => {
  const r = parseManagementReply(
    block('[{"kind":"unsupported","section":"storage"},{"kind":"unsupported","section":"management-releases"}]'),
  );
  expect(r.actions.map((a) => a.section)).toEqual(["storage", "management-releases"]);
});

test("a fence that is not ours is left alone, quoted JSON included", () => {
  const src = 'Приклад:\n\n```json\n{"kind":"unsupported","section":"не виконувати"}\n```';
  const r = parseManagementReply(src);
  expect(r.actions).toEqual([]);
  expect(r.text).toBe(src);
});

test("unreadable JSON is rejected, never executed", () => {
  const r = parseManagementReply(block('{"kind":"unsupported","section":'));
  expect(r.actions).toEqual([]);
  expect(r.rejected).toHaveLength(1);
  expect(r.rejected[0]).toContain("не вдалося прочитати блок дії");
});

test("unsupported without a section is rejected", () => {
  expect(validateManagementAction({ kind: "unsupported", request: "щось" })).toEqual({
    error: "unsupported без поля section",
  });
});

// A writing kind belongs to the branch that owns the screen it writes to. Until that lands,
// the model naming one must be REPORTED — an action silently dropped while the prose claims
// success is the one failure the operator cannot see.
test("a writing kind this branch does not have is named in the rejection", () => {
  const r = parseManagementReply(block('{"kind":"risk.create","title":"Клієнт не платить"}'));
  expect(r.actions).toEqual([]);
  expect(r.rejected).toEqual(['невідома дія "risk.create"']);
  expect(validateManagementAction({ kind: "release.publish" })).toEqual({
    error: 'невідома дія "release.publish"',
  });
});

test("a section resolves by route name, url segment or label", () => {
  expect(managementSection("management-risks")?.label).toBe("Risk Registry");
  expect(managementSection("risk-registry")?.name).toBe("management-risks");
  expect(managementSection("Risk Registry")?.name).toBe("management-risks");
  expect(managementSection("nope")).toBeUndefined();
});

// The capability column is load-bearing: the prompt is generated from it and the ui executor
// reads its `limitation` for every refusal. No section may be silently writable, and none may
// refuse without stating why.
test("no section is writable in this branch, and every one of them states why not", () => {
  expect(MANAGEMENT_SECTIONS.some((s) => s.capability === "read_write")).toBe(false);
  for (const s of MANAGEMENT_SECTIONS) {
    expect(s.limitation, `${s.name} must explain itself`).toBeTruthy();
  }
});
