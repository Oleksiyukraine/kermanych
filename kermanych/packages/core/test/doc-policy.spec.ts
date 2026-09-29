import { expect, test } from "vitest";
import {
  DOCS_GATE_FAILURES,
  docsCompletionPrompt,
  docsGateFailures,
  docsLayoutKind,
} from "../src/doc-policy";

const SPEC = "docs/specs/2026-09-28-x.md";
const CODE = "src/app.ts";
const impact = (line: string) => `# Task\n\n## Documentation impact\n\n${line}\n`;
const gate = (paths: string[], specBodies: string[] = [], handoff = false) =>
  docsGateFailures({ paths, specBodies, handoff });

test("a change without a task document fails task-spec", () => {
  expect(gate(["README.md"])).toEqual(["task-spec"]);
  // A spec-folder file that is not markup is not a task document.
  expect(gate(["docs/specs/diagram.svg", "README.md"])).toEqual(["task-spec"]);
  // Only the repo-root layout counts, not some package's own docs/specs.
  expect(gate(["pkg/docs/specs/x.md", "README.md"])).toEqual(["task-spec"]);
});

test("a docs-only change needs no impact declaration", () => {
  expect(gate([SPEC], [impact("Updated nothing")])).toEqual([]);
  expect(gate([SPEC, "docs/plans/2026-09-28-x.md"], ["# no impact section"])).toEqual([]);
});

test("code with no living doc and no declaration fails docs-impact", () => {
  expect(gate([SPEC, CODE], [impact("Changed the login flow.")])).toEqual(["docs-impact"]);
  // Task, plan and handoff documents are not living documentation.
  expect(gate([SPEC, CODE, "docs/plans/p.md", "docs/handoffs/h.md"], ["# no section"])).toEqual(["docs-impact"]);
  expect(gate([CODE])).toEqual(["task-spec", "docs-impact"]);
});

test("a living-doc change satisfies docs-impact", () => {
  expect(gate([SPEC, CODE, "docs/schemas/flow.md"], [""])).toEqual([]);
  expect(gate([SPEC, CODE, "README.md"], [""])).toEqual([]);
  // A diagram under docs/ is documentation, not code, although images are not doc prose.
  expect(gate([SPEC, "docs/schemas/flow.svg"], [""])).toEqual([]);
  expect(gate([SPEC, CODE, "docs/schemas/flow.svg"], [""])).toEqual([]);
});

test("an explicit None declaration is the escape hatch", () => {
  for (const line of [
    "None — internal refactor.",
    "none: tests only",
    "- **None** — no behaviour change",
    "> _None_, cosmetics",
    "* None.",
  ])
    expect(gate([SPEC, CODE], [impact(line)]), line).toEqual([]);
  // Any one changed task document may carry it.
  expect(gate([SPEC, "docs/specs/b.md", CODE], ["# a", impact("None — b")])).toEqual([]);
});

test("a declaration that does not start with None does not count", () => {
  for (const body of [
    impact("No behaviour change, None needed."),
    impact("Nonetheless, nothing to update."),
    impact("## Next heading"),
    "## Documentation impact\n",
    "### Documentation impact\n\nNone — wrong heading level.",
    "None — outside the section.\n\n## Documentation impact\n\nChanged things.",
  ])
    expect(gate([SPEC, CODE], [body]), body).toEqual(["docs-impact"]);
});

test("a requested handoff must be present", () => {
  expect(gate([SPEC], [], true)).toEqual(["handoff"]);
  expect(gate([SPEC, "docs/handoffs/2026-09-28-x.md"], [], true)).toEqual([]);
  expect(gate([SPEC], [], false)).toEqual([]);
  expect(gate([CODE], [], true)).toEqual(DOCS_GATE_FAILURES);
});

test("an empty change set has nothing to document", () => {
  expect(gate([], [], true)).toEqual([]);
});

test("docsLayoutKind classifies by repo-root prefix", () => {
  expect(docsLayoutKind("docs/specs/a.md")).toBe("spec");
  expect(docsLayoutKind("docs/plans/a.md")).toBe("plan");
  expect(docsLayoutKind("docs/schemas/sub/flow.svg")).toBe("schema");
  expect(docsLayoutKind("docs/handoffs/a.md")).toBe("handoff");
  expect(docsLayoutKind("docs/other/a.md")).toBeUndefined();
  expect(docsLayoutKind("docs/specsx/a.md")).toBeUndefined();
  expect(docsLayoutKind("app/docs/specs/a.md")).toBeUndefined();
});

test("the completion prompt asks only for the failing items", () => {
  const only = docsCompletionPrompt(["handoff"]);
  expect(only).toContain("docs/handoffs/");
  expect(only).not.toContain("docs/specs/");
  expect(only).not.toContain("docs/schemas/");
  const all = docsCompletionPrompt(DOCS_GATE_FAILURES);
  for (const dir of ["docs/specs/", "docs/schemas/", "docs/handoffs/"]) expect(all).toContain(dir);
  expect(all).toMatch(/do not change code in this turn/);
});
