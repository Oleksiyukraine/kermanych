import { expect, test } from "vitest";
import {
  DEFAULT_DOCS_POLICY,
  DOCS_GATE_FAILURES,
  docsCompletionPrompt,
  docsFailureSkills,
  docsGateFailures,
  docsLayoutKind,
  docsPolicy,
  docsPolicyAppend,
  type DocsPolicy,
} from "../src/doc-policy";

const SPEC = "docs/specs/2026-09-28-x.md";
const CODE = "src/app.ts";
const impact = (line: string) => `# Task\n\n## Documentation impact\n\n${line}\n`;
const gate = (paths: string[], specBodies: string[] = []) => docsGateFailures({ policy: DEFAULT_DOCS_POLICY, paths, specBodies });
const ruled = (over: Partial<DocsPolicy>, paths: string[], specBodies: string[] = []) =>
  docsGateFailures({ policy: { ...DEFAULT_DOCS_POLICY, ...over }, paths, specBodies });
const ALL_OFF: DocsPolicy = { spec: "off", plan: "off", schemas: "off", handoff: "off", apiRequest: "off" };

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
  // Task, plan, handoff and API-request documents are not living documentation.
  expect(gate([SPEC, CODE, "docs/plans/p.md", "docs/handoffs/h.md", "docs/api-requests/r.md"], ["# no section"])).toEqual(["docs-impact"]);
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

test("an empty change set has nothing to document", () => {
  expect(ruled({ plan: "required", handoff: "required" }, [])).toEqual([]);
});

test("off and optional rules never block", () => {
  expect(docsGateFailures({ policy: ALL_OFF, paths: [CODE], specBodies: [] })).toEqual([]);
  const optional: DocsPolicy = { spec: "optional", plan: "optional", schemas: "optional", handoff: "optional", apiRequest: "optional" };
  expect(docsGateFailures({ policy: optional, paths: [CODE], specBodies: [] })).toEqual([]);
  // The default handoff is written where it applies, never demanded.
  expect(gate([SPEC])).toEqual([]);
});

test("a required plan must be present", () => {
  expect(ruled({ plan: "required" }, [SPEC, "docs/schemas/a.md", CODE])).toEqual(["plan"]);
  expect(ruled({ plan: "required" }, [SPEC, "docs/plans/2026-09-30-x.md", "docs/schemas/a.md", CODE])).toEqual([]);
});

test("a required handoff must be present", () => {
  expect(ruled({ handoff: "required" }, [SPEC])).toEqual(["handoff"]);
  expect(ruled({ handoff: "required" }, [SPEC, "docs/handoffs/x.md"])).toEqual([]);
});

test("every failure kind comes back in display order", () => {
  // An API request is never `required` in a stored policy (docsPolicy drops it); the gate
  // itself treats every kind alike.
  const strict: DocsPolicy = { spec: "required", plan: "required", schemas: "required", handoff: "required", apiRequest: "required" };
  expect(docsGateFailures({ policy: strict, paths: [CODE], specBodies: [] })).toEqual(DOCS_GATE_FAILURES);
});

test("docsPolicy fills gaps and drops unsupported rules with the kind's default", () => {
  expect(docsPolicy({})).toEqual(DEFAULT_DOCS_POLICY);
  expect(docsPolicy(null)).toEqual(DEFAULT_DOCS_POLICY);
  expect(docsPolicy(["off"])).toEqual(DEFAULT_DOCS_POLICY);
  expect(docsPolicy({ plan: "required", handoff: "off" })).toEqual({ ...DEFAULT_DOCS_POLICY, plan: "required", handoff: "off" });
  // An API request is never `required`; `ask` (the finish-sheet checkbox) is gone.
  expect(docsPolicy({ spec: "ask", handoff: "ask", apiRequest: "required", schemas: "sometimes" })).toEqual(DEFAULT_DOCS_POLICY);
});

test("docsLayoutKind classifies by repo-root prefix", () => {
  expect(docsLayoutKind("docs/specs/a.md")).toBe("spec");
  expect(docsLayoutKind("docs/plans/a.md")).toBe("plan");
  expect(docsLayoutKind("docs/schemas/sub/flow.svg")).toBe("schema");
  expect(docsLayoutKind("docs/handoffs/a.md")).toBe("handoff");
  expect(docsLayoutKind("docs/api-requests/a.md")).toBe("api-request");
  expect(docsLayoutKind("docs/other/a.md")).toBeUndefined();
  expect(docsLayoutKind("docs/specsx/a.md")).toBeUndefined();
  expect(docsLayoutKind("app/docs/specs/a.md")).toBeUndefined();
});

test("the policy append names only the kinds that are on, and blocks only when something can", () => {
  expect(docsPolicyAppend(ALL_OFF)).toBe("");

  const soft = docsPolicyAppend({ ...ALL_OFF, spec: "optional", apiRequest: "optional" });
  expect(soft).toContain("docs/specs/");
  expect(soft).toContain("docs/api-requests/");
  expect(soft).not.toContain("docs/plans/YYYY");
  expect(soft).not.toContain("docs/handoffs/");
  expect(soft).not.toMatch(/refuses/);

  const def = docsPolicyAppend(DEFAULT_DOCS_POLICY);
  for (const dir of ["docs/specs/", "docs/plans/", "docs/schemas/", "docs/handoffs/"]) expect(def).toContain(dir);
  expect(def).not.toContain("docs/api-requests/");
  expect(def).toMatch(/begins with `None`/);
  expect(def).toMatch(/refuses to open a pull request/);
});

test("the completion prompt asks only for the failing items", () => {
  const only = docsCompletionPrompt(["handoff"]);
  expect(only).toContain("docs/handoffs/");
  expect(only).not.toContain("docs/specs/");
  expect(only).not.toContain("docs/schemas/");
  const all = docsCompletionPrompt(DOCS_GATE_FAILURES);
  for (const dir of ["docs/specs/", "docs/plans/", "docs/schemas/", "docs/handoffs/", "docs/api-requests/"]) expect(all).toContain(dir);
  expect(all).toMatch(/do not change code in this turn/);
});

test("the completion skills follow the failures, none for docs-impact", () => {
  expect(docsFailureSkills(["docs-impact"])).toEqual([]);
  expect(docsFailureSkills(["api-request", "task-spec", "plan", "handoff"])).toEqual(["task-spec", "task-plan", "frontend-handoff", "api-request"]);
});
