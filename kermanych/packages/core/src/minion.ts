// «Посіпака» (code id `minion`, docs/specs/2026-10-23-minion-auto-run.md): an agent that, on a
// machine where its owner activated it, takes the owner's own backlog cards marked «Дозволити
// автовиконання» and runs them to a pull request with nobody watching.
//
// This module owns what the api, the UI and the agent agree on: the knobs, the verdict the agent
// reports through `report_outcome`, the result the card and the session record, and the machine
// state the UI shows. Pure, like findings.ts. The agent's editable instruction lives with the
// other agents in agents.ts; the outcome contract below is Kermanych's own and is appended after
// whatever that instruction says, so a rewritten instruction cannot break it.

import type { FindingKind } from "./findings";

/** How often the api asks the cloud for the next card while the minion is on. */
export const MINION_POLL_MS = 60_000;
/** Consecutive failed runs that pause the minion on this machine. */
export const MINION_FAILURE_LIMIT = 2;
/** From the spawn to the first verdict. */
export const MINION_TIME_CAP_MS = 2 * 60 * 60_000;
/** After the time-cap steer, how long the agent has to report before its turn is stopped. */
export const MINION_GRACE_MS = 10 * 60_000;
/** How long a runtime preflight verdict is trusted before the next claim asks again. */
export const MINION_PREFLIGHT_TTL_MS = 5 * 60_000;
/** Minion runs at once on this machine, across all its active projects. */
export const MINION_CAP_DEFAULT = 1;
export const MINION_CAP_MAX = 8;
/** A verdict summary is a paragraph or two, not a report; longer text is cut. */
export const MINION_SUMMARY_MAX = 4000;

export const MINION_OUTCOME_TOOL = "report_outcome";

/**
 * What the agent reports through `report_outcome`. `not_needed` (decision 14): nothing to change —
 * the problem is already fixed, the card repeats another one, or the code it names is gone.
 */
export const MINION_VERDICTS = ["ready", "needs_decision", "not_needed"] as const;
export type MinionVerdict = (typeof MINION_VERDICTS)[number];
export type MinionVerdictReport = { outcome: MinionVerdict; summary: string };

/** How a minion run ended, as the card (`session_report.minion`) and the session record it. */
export const MINION_OUTCOMES = ["pr", "needs_decision", "not_needed", "failed", "stopped"] as const;
export type MinionOutcome = (typeof MINION_OUTCOMES)[number];

/**
 * Kermanych's own reasons, which the UI words. `reason` beside one carries the free text: the
 * agent's summary for its own `needs_decision` or `not_needed`, or an error message.
 * `no_changes`: a `ready` with nothing changed on the branch. `has_changes`: a `not_needed` that
 * left changes on it.
 */
export const MINION_REASON_CODES = [
  "no_outcome",
  "no_pr",
  "time_cap",
  "docs_gate",
  "session_error",
  "launch_failed",
  "no_changes",
  "has_changes",
] as const;
export type MinionReasonCode = (typeof MINION_REASON_CODES)[number];

export type MinionResult = { outcome: MinionOutcome; code?: MinionReasonCode; reason?: string };

/**
 * The default skill with the per-kind rules for a card filed from a «Знахідка» (decision 14). The
 * supervisor pastes it into such a run's opening prompt only; skills.ts ships its default body.
 */
export const MINION_FINDINGS_SKILL = "minion-findings";

/** Why the minion is paused on this machine. */
export const MINION_PAUSE_CODES = ["operator", "failures", "signed_out"] as const;
export type MinionPauseCode = (typeof MINION_PAUSE_CODES)[number];
export type MinionPause = { code: MinionPauseCode; at: string; detail?: string };

/** The minion on this machine, as `GET /api/minion` and the `minion_update` event carry it. */
export type MinionState = {
  cap: number;
  /** Absent while it works. */
  pause?: MinionPause;
  /** Consecutive failed runs; reset by a PR or by the agent's own `needs_decision`. */
  failures: number;
  /** Minion sessions on this machine whose turn runs now. */
  running: number;
  /** Eligible cards seen by the last poll, including the one it may be starting. */
  waiting: number;
  /** Project ids activated on this machine. */
  projects: string[];
  lastPollAt?: string;
  /** Why the last poll could not ask the cloud (not signed in, offline). Cleared by a good poll. */
  pollError?: string;
};

function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

export const isMinionOutcome = (v: unknown): v is MinionOutcome => isOneOf(MINION_OUTCOMES, v);
export const isMinionReasonCode = (v: unknown): v is MinionReasonCode => isOneOf(MINION_REASON_CODES, v);
export const isMinionPauseCode = (v: unknown): v is MinionPauseCode => isOneOf(MINION_PAUSE_CODES, v);

/** An untrusted cap (a request body, a stored row) → an integer in range, or undefined. */
export function clampMinionCap(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return undefined;
  return Math.min(v, MINION_CAP_MAX);
}

/** `report_outcome`'s arguments → the verdict, or the reason the call is refused. */
export function validateOutcomeReport(
  v: unknown,
): { ok: true; report: MinionVerdictReport } | { ok: false; error: string } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { ok: false, error: "arguments must be an object" };
  const { outcome, summary } = v as Record<string, unknown>;
  if (!isOneOf(MINION_VERDICTS, outcome)) return { ok: false, error: `outcome must be one of: ${MINION_VERDICTS.join(", ")}` };
  if (typeof summary !== "string" || !summary.trim()) return { ok: false, error: "summary must be a non-empty string" };
  return { ok: true, report: { outcome, summary: summary.trim().slice(0, MINION_SUMMARY_MAX) } };
}

/** A stored value (jsonb any client version wrote, a registry column) → a result, or undefined. */
export function readMinionResult(v: unknown): MinionResult | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const { outcome, code, reason } = v as Record<string, unknown>;
  if (!isMinionOutcome(outcome)) return undefined;
  return {
    outcome,
    ...(isMinionReasonCode(code) ? { code } : {}),
    ...(typeof reason === "string" && reason ? { reason } : {}),
  };
}

/**
 * Appended after the minion's rendered instruction — the default or any override — the way the
 * pull-request agent gets `baseSyncBlock`. Model-facing, so English, like every template.
 */
export const MINION_OUTCOME_CONTRACT = [
  "How this run ends — this step is Kermanych's own and applies whatever the instruction above says:\n",
  `- When the work is done, committed on this branch and checked, call the \`${MINION_OUTCOME_TOOL}\` tool `,
  `with \`outcome: "ready"\` and a short summary of what you changed and the decisions you took, then end `,
  "your turn. Kermanych then completes the documentation if the project requires it and has you open the ",
  "pull request.\n",
  "- When there is nothing to change — the problem is already fixed on this branch, the card repeats another ",
  "one, or the code it names is gone — change nothing, remove anything you created to check it, and call ",
  `\`${MINION_OUTCOME_TOOL}\` with \`outcome: "not_needed"\` and a summary with the evidence: \`path:line\` on `,
  "this branch, a command's output, or the card it repeats. Kermanych then closes the card. A problem you ",
  "cannot reproduce and cannot show fixed is not this case.\n",
  "- When you cannot finish without a human decision — the card contradicts the code, a product choice ",
  "that is not yours to make, missing access or data, a problem you cannot reproduce — stop. Call ",
  `\`${MINION_OUTCOME_TOOL}\` with \`outcome: "needs_decision"\` and a summary that names exactly what `,
  "blocks you and which decision is needed, then end your turn. Do not guess past such a blocker.\n",
  `- Call \`${MINION_OUTCOME_TOOL}\` once, as the last action of your turn. A turn that ends without it `,
  "counts as a failed run.",
].join("");

/** What a minion run's pull-request title starts with, so a reviewer or a PR search tells it apart. */
export const MINION_PR_TITLE_PREFIX = "[Minion]";

/**
 * Appended to the PR turn of a minion session (SupervisorService.createPullRequest), after the
 * base sync, whatever the pull-request agent's instruction or the repository's conventions say:
 * the title is the one mark every Git host shows in its PR list without labels or permissions.
 */
export const MINION_PR_TITLE_RULE = [
  "The pull request's title — this rule is Kermanych's own and applies whatever the instruction above ",
  "and the repository's conventions say: this branch was worked by «Посіпака», Kermanych's unattended ",
  `agent, so the title starts with \`${MINION_PR_TITLE_PREFIX} \` followed by the title the conventions `,
  `give, e.g. \`${MINION_PR_TITLE_PREFIX} fix(api): handle an empty list\`. Pass it to \`gh pr create --title\`; `,
  "if this branch already has a pull request whose title lacks it, add it with `gh pr edit --title`.",
].join("");

/**
 * Kermanych's own line in a run of a card filed from a «Знахідка», right after the card: what kind
 * of finding it is, which the description does not say. The per-kind rules follow it as the
 * `minion-findings` skill, unless a team switched that skill off.
 */
export function minionFindingLine(kind: FindingKind): string {
  return (
    `Kermanych: this card was filed from a «Знахідка» of kind \`${kind}\` — a problem another agent ` +
    "noticed outside its own task, possibly on another branch and some time ago."
  );
}

/** Sent into a run that reached MINION_TIME_CAP_MS without a verdict. */
export const MINION_TIME_CAP_PROMPT = [
  "Time is up: this unattended run has reached its limit. Stop working now. ",
  `Call \`${MINION_OUTCOME_TOOL}\` with \`outcome: "needs_decision"\` and a summary of where you stand — `,
  "what is done, what is left, and what slowed you down — then end your turn.",
].join("");
