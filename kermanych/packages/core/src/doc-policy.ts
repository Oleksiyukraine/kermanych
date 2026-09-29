// «Обовʼязкова документація» — the project setting that makes documenting every task a
// property of the harness instead of the model's goodwill. Pure data and a pure gate: no fs,
// no git, no cloud. The api feeds the gate the branch's changed paths (WorktreeService
// .changedFiles) and the bodies of the changed task documents; the ui reuses docsLayoutKind
// to badge the «Документація» tab. See docs/specs/2026-09-28-mandatory-documentation-design.md.

import { isDocPath, isMarkupPath } from "./docs";

// Repository-relative homes of the four document kinds. They deliberately override the
// superpowers plugin's `docs/superpowers/specs|plans` defaults (the policy append says so).
export const DOCS_LAYOUT = {
  specs: "docs/specs",
  plans: "docs/plans",
  schemas: "docs/schemas",
  handoffs: "docs/handoffs",
} as const;

export type DocsLayoutKind = "spec" | "plan" | "schema" | "handoff";

const LAYOUT_KINDS: readonly [string, DocsLayoutKind][] = [
  [`${DOCS_LAYOUT.specs}/`, "spec"],
  [`${DOCS_LAYOUT.plans}/`, "plan"],
  [`${DOCS_LAYOUT.schemas}/`, "schema"],
  [`${DOCS_LAYOUT.handoffs}/`, "handoff"],
];

// Which layout folder a repo-relative path sits in, judged by its repo-root prefix only — a
// nested `packages/x/docs/specs/…` is some package's own docs, not this policy's task doc.
export function docsLayoutKind(path: string): DocsLayoutKind | undefined {
  return LAYOUT_KINDS.find(([prefix]) => path.startsWith(prefix))?.[1];
}

export type DocsGateFailure = "task-spec" | "docs-impact" | "handoff";

// Display order — the gate returns its failures in this order, and the ui lists them so.
export const DOCS_GATE_FAILURES: readonly DocsGateFailure[] = ["task-spec", "docs-impact", "handoff"];

export interface DocsGateInput {
  // The branch's changed paths, repo-relative (the changedFiles listing).
  paths: readonly string[];
  // The text of the changed task documents (markup files under docs/specs/).
  specBodies: readonly string[];
  // Whether the operator asked for a frontend handoff in the finish sheet.
  handoff: boolean;
}

export interface DocsGate {
  // False when the project setting is off: the gate then never fails.
  required: boolean;
  failures: DocsGateFailure[];
}

// Documentation, not code: a doc-family file, or ANY file under a docs/ (doc/) directory —
// so a `docs/schemas/*.svg` diagram counts as documentation although isDocPath (which keeps
// images out of the prose index) rejects it.
const DOC_DIR_RE = /(?:^|\/)docs?\//i;
const IMPACT_HEADING = "## Documentation impact";

// The explicit escape hatch: the task document's `## Documentation impact` section opens
// with `None` (then the reason). Leading quote/list markers and emphasis are ignored, so
// `- **None** — …` and `> _none: …_` both declare it; `Nonetheless …` does not.
function declaresNoImpact(body: string): boolean {
  const lines = body.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === IMPACT_HEADING);
  if (at < 0) return false;
  const first = lines.slice(at + 1).find((l) => l.trim() !== "");
  if (first === undefined) return false;
  return /^none(?![a-z0-9])/i.test(first.trim().replace(/^[\s>\-*+_]+/, ""));
}

// The gate's rules (spec §3.4). A machine cannot tell whether a change alters behaviour, so
// silence is what fails: either the living documentation moves, or the task document says
// in writing why it did not have to. An EMPTY change set fails nothing — the policy covers
// "every task that changes the repository", and a session that changed nothing has no task
// to document (finishing it must stay possible).
export function docsGateFailures(input: DocsGateInput): DocsGateFailure[] {
  const { paths, specBodies, handoff } = input;
  if (paths.length === 0) return [];
  // Pushed in DOCS_GATE_FAILURES order.
  const failures: DocsGateFailure[] = [];
  const docSide = (p: string) => isDocPath(p) || DOC_DIR_RE.test(p);
  const markupIn = (kind: DocsLayoutKind) => paths.some((p) => docsLayoutKind(p) === kind && isMarkupPath(p));

  if (!markupIn("spec")) failures.push("task-spec");

  const codeChanged = paths.some((p) => !docSide(p));
  const livingDocChanged = paths.some((p) => {
    if (!docSide(p)) return false;
    const kind = docsLayoutKind(p);
    return kind !== "spec" && kind !== "plan" && kind !== "handoff";
  });
  if (codeChanged && !livingDocChanged && !specBodies.some(declaresNoImpact)) failures.push("docs-impact");

  if (handoff && !markupIn("handoff")) failures.push("handoff");

  return failures;
}

// Joined to the language append (appendSystemPrompt) for EVERY session of a project with the
// setting on — chat, agent, discussion, review, resume, on both runtimes. Worded for "every
// task that changes the repository", so a read-only session learns only where the docs live.
export const DOCS_POLICY_APPEND = [
  "## Mandatory documentation (this project)",
  "",
  "This project requires every task to be documented. Documents live at these repository-relative paths:",
  `- \`${DOCS_LAYOUT.specs}/YYYY-MM-DD-<topic>.md\` — the task document (required for every task that changes the repository).`,
  `- \`${DOCS_LAYOUT.plans}/YYYY-MM-DD-<topic>.md\` — an implementation plan, when the work needs one (optional).`,
  `- \`${DOCS_LAYOUT.schemas}/\` — living documentation of how the service works: architecture, flows, data models, API contracts.`,
  `- \`${DOCS_LAYOUT.handoffs}/YYYY-MM-DD-<topic>.md\` — a frontend handoff, when the operator asks for one.`,
  "",
  "Rules for every task that changes the repository:",
  `1. Create the task document in \`${DOCS_LAYOUT.specs}/\` before implementing, and keep it current as the work evolves. It must contain a \`${IMPACT_HEADING}\` section.`,
  `2. When the change alters how the service behaves, update \`${DOCS_LAYOUT.schemas}/\` (or the project's other existing documentation) in the same branch. When it does not, the \`${IMPACT_HEADING}\` section must begin with \`None\` followed by the reason.`,
  `3. These locations override any skill or plugin default — in particular superpowers' \`docs/superpowers/specs\` and \`docs/superpowers/plans\`: write specs and plans to \`${DOCS_LAYOUT.specs}/\` and \`${DOCS_LAYOUT.plans}/\` instead.`,
  "4. Commit the documents on the session branch with the code. Kermanych refuses to open a pull request, commit to it, or finish the session until the documentation is in place.",
].join("\n");

// Default skills that carry the how-to; resolved by name, so a project or repository
// override wins (SkillsService.assignedForNames).
export const TASK_SPEC_SKILL = "task-spec";
export const FRONTEND_HANDOFF_SKILL = "frontend-handoff";

const FAILURE_ASKS: Record<DocsGateFailure, string> = {
  "task-spec": `- Write the task document in \`${DOCS_LAYOUT.specs}/YYYY-MM-DD-<topic>.md\` for this branch's work, including a \`${IMPACT_HEADING}\` section.`,
  "docs-impact": `- The code changed but no living documentation did. Update \`${DOCS_LAYOUT.schemas}/\` (or the project's other existing docs) to match the new behaviour — or, if behaviour did not change, make the task document's \`${IMPACT_HEADING}\` section begin with \`None\` followed by the reason.`,
  handoff: `- Write a frontend handoff in \`${DOCS_LAYOUT.handoffs}/YYYY-MM-DD-<topic>.md\` for a frontend developer who did not see this work.`,
};

// The one Kermanych prompt «Доповнити документацію» sends: exactly the failing items, then
// the delivery rule. The caller appends the resolved skill block (assignedForNames).
export function docsCompletionPrompt(failures: readonly DocsGateFailure[]): string {
  const asks = DOCS_GATE_FAILURES.filter((f) => failures.includes(f)).map((f) => FAILURE_ASKS[f]);
  return [
    "Kermanych cannot finish this session yet: the project requires documentation that this branch is missing.",
    "",
    ...asks,
    "",
    "Commit these documents; if this branch already has an open pull request, push it; do not change code in this turn.",
  ].join("\n");
}
