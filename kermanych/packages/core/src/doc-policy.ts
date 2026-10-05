// The project's documentation policy — the setting that makes documenting every task a
// property of the harness instead of the model's goodwill. `Project.docsRequired` is the
// master switch; `Project.docsPolicy` says, per document kind, how hard the policy asks for
// it. Pure data and a pure gate: no fs, no git, no cloud. The api feeds the gate the branch's
// changed paths (WorktreeService.changedFiles) and the bodies of the changed task documents;
// the ui reuses docsLayoutKind to badge the «Документація» tab. See
// docs/specs/2026-09-28-mandatory-documentation-design.md and
// docs/specs/2026-09-30-documentation-settings.md.

import { isDocPath, isMarkupPath } from "./docs";

// Repository-relative homes of the document kinds. They deliberately override the
// superpowers plugin's `docs/superpowers/specs|plans` defaults (the policy append says so).
export const DOCS_LAYOUT = {
  specs: "docs/specs",
  plans: "docs/plans",
  schemas: "docs/schemas",
  handoffs: "docs/handoffs",
  apiRequests: "docs/api-requests",
} as const;

export type DocsLayoutKind = "spec" | "plan" | "schema" | "handoff" | "api-request";

const LAYOUT_KINDS: readonly [string, DocsLayoutKind][] = [
  [`${DOCS_LAYOUT.specs}/`, "spec"],
  [`${DOCS_LAYOUT.plans}/`, "plan"],
  [`${DOCS_LAYOUT.schemas}/`, "schema"],
  [`${DOCS_LAYOUT.handoffs}/`, "handoff"],
  [`${DOCS_LAYOUT.apiRequests}/`, "api-request"],
];

// Which layout folder a repo-relative path sits in, judged by its repo-root prefix only — a
// nested `packages/x/docs/specs/…` is some package's own docs, not this policy's task doc.
export function docsLayoutKind(path: string): DocsLayoutKind | undefined {
  return LAYOUT_KINDS.find(([prefix]) => path.startsWith(prefix))?.[1];
}

// How hard the policy asks for one kind of document:
//   off      — never mentioned, never checked;
//   optional — the agent is told to write it where it applies; nothing blocks;
//   required — the gate refuses PR / commit / finish without it.
// A handoff or an API request the operator wants on a particular branch is asked for by name
// from the session's «Документація» tab (docsWritePrompt), whatever the rule.
export type DocsRule = "off" | "optional" | "required";

export interface DocsPolicy {
  spec: DocsRule; // docs/specs — the task document
  plan: DocsRule; // docs/plans — the implementation plan
  schemas: DocsRule; // docs/schemas — living docs; `required` is the docs-impact rule
  handoff: DocsRule; // docs/handoffs — backend → frontend
  apiRequest: DocsRule; // docs/api-requests — frontend → backend: an API that is missing
}

export type DocsPolicyKey = keyof DocsPolicy;

export const DOCS_POLICY_KEYS: readonly DocsPolicyKey[] = ["spec", "plan", "schemas", "handoff", "apiRequest"];

// The rules each kind supports, in the order the settings screen offers them. An API request
// has no `required`: one exists only when something is missing, so demanding it on every
// branch would force fake documents.
export const DOCS_RULES: { readonly [K in DocsPolicyKey]: readonly DocsRule[] } = {
  spec: ["off", "optional", "required"],
  plan: ["off", "optional", "required"],
  schemas: ["off", "optional", "required"],
  handoff: ["off", "optional", "required"],
  apiRequest: ["off", "optional"],
};

// What a project stored with an empty policy gets: the bundle the single «Обовʼязкова
// документація» switch turned on before the rules existed, with the handoff the agent writes
// where it applies (it was a finish-sheet checkbox until 2026-10-05).
export const DEFAULT_DOCS_POLICY: Readonly<DocsPolicy> = {
  spec: "required",
  plan: "optional",
  schemas: "required",
  handoff: "optional",
  apiRequest: "off",
};

// The stored policy (cloud jsonb, registry JSON text) is read through this: a missing key,
// an unknown value or a rule the kind does not support falls back to that kind's default.
export function docsPolicy(raw: unknown): DocsPolicy {
  const src = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: DocsPolicy = { ...DEFAULT_DOCS_POLICY };
  for (const key of DOCS_POLICY_KEYS) {
    const v = src[key];
    if (typeof v === "string" && (DOCS_RULES[key] as readonly string[]).includes(v)) out[key] = v as DocsRule;
  }
  return out;
}

// The documents the «Документація» tab asks the agent for mid-session.
export type DocsWriteKind = "handoff" | "apiRequest";

export type DocsGateFailure = "task-spec" | "plan" | "docs-impact" | "handoff" | "api-request";

// Display order — the gate returns its failures in this order, and the ui lists them so.
export const DOCS_GATE_FAILURES: readonly DocsGateFailure[] = ["task-spec", "plan", "docs-impact", "handoff", "api-request"];

export interface DocsGateInput {
  policy: DocsPolicy;
  // The branch's changed paths, repo-relative (the changedFiles listing).
  paths: readonly string[];
  // The text of the changed task documents (markup files under docs/specs/).
  specBodies: readonly string[];
}

export interface DocsGate {
  // False when the project's documentation switch is off: the gate then never fails.
  enabled: boolean;
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

// The gate's rules (spec §3.4, per kind since 2026-09-30). A machine cannot tell whether a
// change alters behaviour, so silence is what fails: either the living documentation moves,
// or the task document says in writing why it did not have to. An EMPTY change set fails
// nothing — the policy covers "every task that changes the repository", and a session that
// changed nothing has no task to document (finishing it must stay possible).
export function docsGateFailures(input: DocsGateInput): DocsGateFailure[] {
  const { policy, paths, specBodies } = input;
  if (paths.length === 0) return [];
  const need = (key: DocsPolicyKey) => policy[key] === "required";
  // Pushed in DOCS_GATE_FAILURES order.
  const failures: DocsGateFailure[] = [];
  const docSide = (p: string) => isDocPath(p) || DOC_DIR_RE.test(p);
  const markupIn = (kind: DocsLayoutKind) => paths.some((p) => docsLayoutKind(p) === kind && isMarkupPath(p));

  if (need("spec") && !markupIn("spec")) failures.push("task-spec");
  if (need("plan") && !markupIn("plan")) failures.push("plan");

  if (need("schemas")) {
    const codeChanged = paths.some((p) => !docSide(p));
    // Task documents, plans, handoffs and API requests describe the work, not the service.
    const livingDocChanged = paths.some((p) => {
      if (!docSide(p)) return false;
      const kind = docsLayoutKind(p);
      return kind === undefined || kind === "schema";
    });
    if (codeChanged && !livingDocChanged && !specBodies.some(declaresNoImpact)) failures.push("docs-impact");
  }

  if (need("handoff") && !markupIn("handoff")) failures.push("handoff");
  if (need("apiRequest") && !markupIn("api-request")) failures.push("api-request");

  return failures;
}

const DATED = "YYYY-MM-DD-<topic>.md";

// One line per kind and rule for the system-prompt append. `off` has none.
function policyLine(key: DocsPolicyKey, rule: DocsRule, policy: DocsPolicy): string | undefined {
  if (rule === "off") return undefined;
  switch (key) {
    case "spec": {
      const impact = policy.schemas === "required" ? ` It carries a \`${IMPACT_HEADING}\` section.` : "";
      return rule === "required"
        ? `- \`${DOCS_LAYOUT.specs}/${DATED}\` — the task document. Required for every task that changes the repository: create it before implementing and keep it current as the work evolves.${impact}`
        : `- \`${DOCS_LAYOUT.specs}/${DATED}\` — the task document, for work that is more than a trivial fix: create it before implementing and keep it current as the work evolves.${impact}`;
    }
    case "plan":
      return rule === "required"
        ? `- \`${DOCS_LAYOUT.plans}/${DATED}\` — the implementation plan. Required for every task that changes the repository: write it before implementing.`
        : `- \`${DOCS_LAYOUT.plans}/${DATED}\` — an implementation plan, when the work needs one.`;
    case "schemas": {
      const base = `- \`${DOCS_LAYOUT.schemas}/\` — living documentation of how the service works: architecture, flows, data models, API contracts. When a change alters how the service behaves, update it (or the project's other existing documentation) in the same branch.`;
      return rule === "required"
        ? `${base} When it does not, a task document in \`${DOCS_LAYOUT.specs}/\` must carry a \`${IMPACT_HEADING}\` section that begins with \`None\` followed by the reason.`
        : base;
    }
    case "handoff":
      return rule === "required"
        ? `- \`${DOCS_LAYOUT.handoffs}/${DATED}\` — a frontend handoff, required for every task that changes the repository, written for a frontend developer who did not see the work (one line when nothing changed for the frontend).`
        : `- \`${DOCS_LAYOUT.handoffs}/${DATED}\` — a frontend handoff, whenever the change affects the frontend: endpoints, events, config, breaking changes.`;
    case "apiRequest":
      return `- \`${DOCS_LAYOUT.apiRequests}/${DATED}\` — an API request. When this work needs something the API does not provide yet (an endpoint, a field, a filter, an event), do not invent the backend side and do not fake it silently: write the request — what is needed and why, the proposed contract, and what the client does until it ships — and name it in the handoff or pull request.`;
  }
}

// Joined to the language append (appendSystemPrompt) for EVERY session of a project with the
// switch on — chat, agent, discussion, review, resume, on both runtimes. Worded for "every
// task that changes the repository", so a read-only session learns only where the docs live.
// Empty when every kind is off: there is nothing to tell the agent.
export function docsPolicyAppend(policy: DocsPolicy): string {
  const lines = DOCS_POLICY_KEYS.map((k) => policyLine(k, policy[k], policy)).filter((l): l is string => l !== undefined);
  if (!lines.length) return "";
  const blocks = DOCS_POLICY_KEYS.some((k) => policy[k] === "required");
  return [
    "## Documentation policy (this project)",
    "",
    "This project keeps its task documentation in the repository, at these repository-relative paths:",
    ...lines,
    "",
    "These locations override any skill or plugin default — in particular superpowers' `docs/superpowers/specs` and `docs/superpowers/plans`: write specs and plans to the paths above instead.",
    blocks
      ? "Commit the documents on the session branch with the code. Kermanych refuses to open a pull request, commit to it, or finish the session until the required documentation is in place."
      : "Commit the documents on the session branch with the code.",
  ].join("\n");
}

// Default skills that carry the how-to; resolved by name, so a project or repository
// override wins (SkillsService.assignedForNames).
export const TASK_SPEC_SKILL = "task-spec";
export const TASK_PLAN_SKILL = "task-plan";
export const FRONTEND_HANDOFF_SKILL = "frontend-handoff";
export const API_REQUEST_SKILL = "api-request";

const FAILURE_SKILLS: Partial<Record<DocsGateFailure, string>> = {
  "task-spec": TASK_SPEC_SKILL,
  plan: TASK_PLAN_SKILL,
  handoff: FRONTEND_HANDOFF_SKILL,
  "api-request": API_REQUEST_SKILL,
};

// The skills «Доповнити документацію» inlines for a set of failures, in display order.
// `docs-impact` has none: the living docs are the project's own, in its own format.
export function docsFailureSkills(failures: readonly DocsGateFailure[]): string[] {
  return DOCS_GATE_FAILURES.filter((f) => failures.includes(f))
    .map((f) => FAILURE_SKILLS[f])
    .filter((s): s is string => s !== undefined);
}

const FAILURE_ASKS: Record<DocsGateFailure, string> = {
  "task-spec": `- Write the task document in \`${DOCS_LAYOUT.specs}/${DATED}\` for this branch's work, including a \`${IMPACT_HEADING}\` section.`,
  plan: `- Write the implementation plan in \`${DOCS_LAYOUT.plans}/${DATED}\` for this branch's work.`,
  "docs-impact": `- The code changed but no living documentation did. Update \`${DOCS_LAYOUT.schemas}/\` (or the project's other existing docs) to match the new behaviour — or, if behaviour did not change, make the task document's \`${IMPACT_HEADING}\` section begin with \`None\` followed by the reason.`,
  handoff: `- Write a frontend handoff in \`${DOCS_LAYOUT.handoffs}/${DATED}\` for a frontend developer who did not see this work.`,
  "api-request": `- Write the API request in \`${DOCS_LAYOUT.apiRequests}/${DATED}\`: what this work needs from the API that it does not provide yet, the proposed contract, and what the client does until it ships.`,
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

// The «Документація» tab's two kinds as the gate names their missing document.
export const DOCS_WRITE_FAILURE: Readonly<Record<DocsWriteKind, DocsGateFailure>> = { handoff: "handoff", apiRequest: "api-request" };

// The prompt «Написати запит на API» / «Написати хендоф» sends mid-session: one document, now,
// whatever the project's rule — the operator asked for it, and the task goes on afterwards.
// The caller appends the resolved skill block (docsFailureSkills of DOCS_WRITE_FAILURE[kind]).
export function docsWritePrompt(kind: DocsWriteKind): string {
  return [
    "The operator asks for this document now, while the task is still in progress:",
    "",
    FAILURE_ASKS[DOCS_WRITE_FAILURE[kind]],
    "",
    "Base it on what this branch has done and found so far. Commit it on this branch; do not change code in this turn. The task continues after this document.",
  ].join("\n");
}
