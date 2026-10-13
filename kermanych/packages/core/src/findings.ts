// «Знахідки» (docs/specs/2026-10-13-agent-findings.md): a problem a session's agent noticed
// outside its own task, reported through the `report_finding` MCP tool and kept on this machine
// until the operator files it as a board card or a Jira issue, or dismisses it.
//
// The agent proposes, the operator files: nothing here writes to the board or to Jira. This
// module owns the shape both sides agree on — the tool's arguments, the stored row, and the one
// description a finding becomes wherever it is filed.

import { renderTicketDescription } from "./management-actions";

export const FINDING_KINDS = ["bug", "security", "tech-debt", "docs"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export const FINDING_STATUSES = ["open", "filed", "dismissed"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

// The kanban card's title limit the Менеджмент tickets keep too.
export const FINDING_TITLE_MAX = 120;
// A runaway agent stops here: report_finding refuses once a session holds this many open
// findings, and tells the agent to mention it to the operator instead.
export const OPEN_FINDINGS_LIMIT = 20;
// Every Jira issue filed from a finding carries this label, plus the finding's kind.
export const FINDING_JIRA_LABEL = "kermanych-finding";

export function isFindingKind(v: unknown): v is FindingKind {
  return typeof v === "string" && (FINDING_KINDS as readonly string[]).includes(v);
}

/** What the agent states — `report_finding`'s arguments after validation. */
export type FindingReport = {
  title: string;
  kind: FindingKind;
  // What is wrong and why it matters.
  context: string;
  // `path:line` references and/or reproduction commands — what was actually seen.
  evidence: string[];
  // What must be true once it is fixed.
  acceptanceCriteria: string[];
  suggestedFix?: string;
};

/** Where a filed finding went. */
export type FindingTarget = { kind: "board"; taskId: string } | { kind: "jira"; key: string; url: string };

/**
 * An untrusted value (a request body, a stored JSON blob) → the target it names, or undefined.
 * A Jira target must carry an http(s) URL: the UI opens it as a link.
 */
export function parseFindingTarget(v: unknown): FindingTarget | undefined {
  if (typeof v !== "object" || v === null || !("kind" in v)) return undefined;
  if (v.kind === "board" && "taskId" in v && typeof v.taskId === "string" && v.taskId) return { kind: "board", taskId: v.taskId };
  if (v.kind === "jira" && "key" in v && typeof v.key === "string" && v.key && "url" in v && typeof v.url === "string" && /^https?:\/\//.test(v.url))
    return { kind: "jira", key: v.key, url: v.url };
  return undefined;
}

/** One stored finding. `target` is present exactly when `status` is `filed`. */
export type AgentFinding = FindingReport & {
  id: string;
  sessionId: string;
  status: FindingStatus;
  target?: FindingTarget;
  createdAt: string;
  updatedAt: string;
};

export type FindingValidation = { ok: true; report: FindingReport } | { ok: false; error: string };

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

// Trimmed, non-empty, de-duplicated. `undefined` when the value is not an array of strings at
// all — a wrong type is the agent's mistake to fix, not something to repair silently.
function lines(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return undefined;
  return [...new Set((v as string[]).map((s) => s.trim()).filter(Boolean))];
}

/**
 * `report_finding`'s arguments → a report, or the first problem in words the agent can act on.
 * Strict, unlike the fence parsers: the agent gets this answer inside its turn and can retry.
 */
export function validateFindingReport(v: unknown): FindingValidation {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { ok: false, error: "arguments must be an object" };
  const a = v as Record<string, unknown>;
  const title = text(a.title);
  if (!title) return { ok: false, error: "`title` is required" };
  if (title.includes("\n")) return { ok: false, error: "`title` must be one line" };
  if (title.length > FINDING_TITLE_MAX) return { ok: false, error: `\`title\` must be at most ${FINDING_TITLE_MAX} characters` };
  if (!isFindingKind(a.kind)) return { ok: false, error: `\`kind\` must be one of: ${FINDING_KINDS.join(", ")}` };
  const context = text(a.context);
  if (!context) return { ok: false, error: "`context` is required" };
  const evidence = lines(a.evidence);
  if (!evidence?.length)
    return { ok: false, error: "`evidence` must be a non-empty array of `path:line` references or reproduction commands" };
  const acceptanceCriteria = lines(a.acceptanceCriteria);
  if (!acceptanceCriteria?.length) return { ok: false, error: "`acceptanceCriteria` must be a non-empty array of strings" };
  if (a.suggestedFix !== undefined && a.suggestedFix !== null && typeof a.suggestedFix !== "string")
    return { ok: false, error: "`suggestedFix` must be a string" };
  const suggestedFix = text(a.suggestedFix);
  return {
    ok: true,
    report: { title, kind: a.kind, context, evidence, acceptanceCriteria, ...(suggestedFix ? { suggestedFix } : {}) },
  };
}

/** Where the finding came from, named in the description's last line. */
export type FindingOrigin = { project: string; branch: string; session: string };

/**
 * The card / issue body: the Менеджмент ticket markdown (Context, Acceptance criteria) plus
 * Evidence and Suggested fix, then the origin. English like the fields themselves; the
 * operator edits it in the filing dialog before anything is created.
 */
export function renderFindingDescription(f: FindingReport, origin: FindingOrigin): string {
  const out = [renderTicketDescription({ title: f.title, context: f.context, acceptanceCriteria: f.acceptanceCriteria })];
  out.push("", "## Evidence");
  for (const e of f.evidence) out.push(`- \`${e.replace(/`/g, "'")}\``);
  if (f.suggestedFix) out.push("", "## Suggested fix", f.suggestedFix);
  out.push("", "---", `Reported by a Kermanych agent: project «${origin.project}», branch \`${origin.branch}\`, session «${origin.session}».`);
  return out.join("\n");
}

/** The Jira issue type a finding asks for by default; the dialog falls back when the site lacks it. */
export function findingIssueTypeName(kind: FindingKind): "Bug" | "Task" {
  return kind === "bug" || kind === "security" ? "Bug" : "Task";
}
