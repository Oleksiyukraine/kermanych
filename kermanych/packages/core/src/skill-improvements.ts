// Skill self-improvement (docs/specs/2026-11-04-skill-self-improvement.md): a session's agent
// improves a skill of the operator's library through the `improve_skill` MCP tool. The api writes
// the result into the operator's PERSONAL layer at once (a user-scope ai_skills row) and records
// the change in the cloud (`skill_improvements`), where ЦУК's «Центр сповіщень» shows it and rolls
// it back.
//
// This module owns what every side agrees on: the tool's arguments and their limits, the edit
// rule, the record, the rollback and share plans, and the line diff the entry view draws. No I/O.

import { isSkillName } from "./skills";

/** A runaway agent stops here: the sixth `improve_skill` call of a session is refused. */
export const SKILL_IMPROVEMENTS_PER_SESSION = 5;
/** The cloud keeps this many records per user (the table's insert trigger prunes the rest). */
export const SKILL_IMPROVEMENTS_KEEP = 100;
/** The largest skill text an improvement may produce, in UTF-8 bytes — omp's cap for its own managed skills. */
export const SKILL_TEXT_MAX = 64_000;
/** The one-line summary the toast and the column show. */
export const SKILL_IMPROVEMENT_SUMMARY_MAX = 120;
export const SKILL_IMPROVEMENT_REASON_MAX = 1_000;
/** Replacements one call may carry. The table's CHECK holds the same bound. */
export const SKILL_EDITS_MAX = 5;

/** One exact replacement: `find` must occur exactly once in the text it applies to. */
export type SkillEdit = { find: string; replace: string };

/** What the agent states — `improve_skill`'s arguments after validation. */
export type ImproveSkillArgs = { skill: string; edits: SkillEdit[]; summary: string; reason: string };

export type ImproveSkillValidation = { ok: true; args: ImproveSkillArgs } | { ok: false; error: string };

function edit(v: unknown): SkillEdit | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { find, replace } = v as Record<string, unknown>;
  if (typeof find !== "string" || typeof replace !== "string") return undefined;
  return { find, replace };
}

/** A stored or received edits list → the edits, or undefined when any element is malformed. */
export function parseSkillEdits(v: unknown): SkillEdit[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: SkillEdit[] = [];
  for (const e of v) {
    const ok = edit(e);
    if (!ok) return undefined;
    out.push(ok);
  }
  return out;
}

/**
 * `improve_skill`'s arguments → the args, or the first problem in words the agent can act on.
 * Strict, like `validateFindingReport`: the agent gets the answer inside its turn and can retry.
 * `find` and `replace` are taken verbatim — whitespace is part of the text they match.
 */
export function validateImproveSkillArgs(v: unknown): ImproveSkillValidation {
  if (!v || typeof v !== "object") return { ok: false, error: "the arguments must be an object" };
  const a = v as Record<string, unknown>;
  const skill = typeof a.skill === "string" ? a.skill.trim() : "";
  if (!isSkillName(skill))
    return { ok: false, error: "`skill` must be the skill's name as the library lists it (lowercase letters, digits and hyphens)" };
  if (!Array.isArray(a.edits) || a.edits.length === 0)
    return { ok: false, error: "`edits` must hold at least one { find, replace } pair" };
  if (a.edits.length > SKILL_EDITS_MAX) return { ok: false, error: `\`edits\` holds at most ${SKILL_EDITS_MAX} pairs` };
  const edits: SkillEdit[] = [];
  for (const [i, raw] of a.edits.entries()) {
    const e = edit(raw);
    if (!e) return { ok: false, error: `edit ${i + 1} must be { find: string, replace: string }` };
    if (!e.find) return { ok: false, error: `edit ${i + 1} has an empty \`find\`` };
    if (e.find === e.replace) return { ok: false, error: `edit ${i + 1} changes nothing: \`replace\` equals \`find\`` };
    edits.push(e);
  }
  const summary = typeof a.summary === "string" ? a.summary.replace(/\s+/g, " ").trim() : "";
  if (!summary) return { ok: false, error: "`summary` is required" };
  if (summary.length > SKILL_IMPROVEMENT_SUMMARY_MAX)
    return { ok: false, error: `\`summary\` is at most ${SKILL_IMPROVEMENT_SUMMARY_MAX} characters` };
  const reason = typeof a.reason === "string" ? a.reason.trim() : "";
  if (!reason) return { ok: false, error: "`reason` is required" };
  if (reason.length > SKILL_IMPROVEMENT_REASON_MAX)
    return { ok: false, error: `\`reason\` is at most ${SKILL_IMPROVEMENT_REASON_MAX} characters` };
  return { ok: true, args: { skill, edits, summary, reason } };
}

export type SkillEditResult =
  | { ok: true; text: string }
  | { ok: false; index: number; reason: "missing" | "ambiguous" };

/**
 * The edits applied in order, each to the result of the one before. A `find` that does not occur
 * exactly once at its turn fails the whole call: an edit that matched twice would change a place
 * the agent never read, and one that matched nowhere means the agent's copy of the text is stale.
 * Overlapping occurrences count as two.
 */
export function applySkillEdits(text: string, edits: readonly SkillEdit[]): SkillEditResult {
  let out = text;
  for (const [index, e] of edits.entries()) {
    const at = out.indexOf(e.find);
    if (at < 0) return { ok: false, index, reason: "missing" };
    if (out.indexOf(e.find, at + 1) >= 0) return { ok: false, index, reason: "ambiguous" };
    out = out.slice(0, at) + e.replace + out.slice(at + e.find.length);
  }
  return { ok: true, text: out };
}

/** UTF-8 size, the unit SKILL_TEXT_MAX is stated in. */
export function skillTextBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ── the level (docs/specs/2026-11-06-skill-improvement-reflection.md) ─────────────

/**
 * How low the operator sets the bar for a lesson, in Settings → «ШІ-провайдер». `off` hands out
 * neither the tool nor the reflection step and refuses a running session's call.
 */
export const SKILL_IMPROVEMENT_LEVELS = ["off", "conservative", "moderate", "active"] as const;
export type SkillImprovementLevel = (typeof SKILL_IMPROVEMENT_LEVELS)[number];
/** A level at which agents improve skills. */
export type SkillImprovementOnLevel = Exclude<SkillImprovementLevel, "off">;
/** The cloud column's default, and what an unknown (never read) level counts as. */
export const DEFAULT_SKILL_IMPROVEMENT_LEVEL: SkillImprovementLevel = "moderate";

export function isSkillImprovementLevel(v: unknown): v is SkillImprovementLevel {
  return typeof v === "string" && (SKILL_IMPROVEMENT_LEVELS as readonly string[]).includes(v);
}

const CONSERVATIVE_WHEN =
  "Improve a skill when: the operator corrected how you did a kind of task the skill describes; the skill turned out wrong, outdated or missing a step; " +
  "or, after failed attempts, you found a working method that is not obvious.";

/** The agents whose turn Kermanych ends with `skillReflectionBlock`: «Створити ПР», «Закоміти». */
export const SKILL_REFLECTION_AGENT_IDS: readonly string[] = ["pull-request", "commit"];

const LESSON_WHEN: Record<SkillImprovementOnLevel, string> = {
  conservative: CONSERVATIVE_WHEN,
  moderate:
    `${CONSERVATIVE_WHEN} Repeated friction counts too: you went wrong more than once on a step the skill should have foreseen, ` +
    "or the operator had to clarify something the skill could have said up front.",
  active:
    "Review every library skill you used for a missing step, an unclear rule, a correction by the operator, friction that repeated, " +
    "or a working method found after failed attempts. A skill that served you well needs no change.",
};

// Shared by every level (docs/specs/2026-11-07-skill-improvement-review.md, decisions 2 and 4):
// a lesson needs an event, and Kermanych's own instruction is a finding, never a skill patch.
const LESSON_NEVER =
  "A lesson rests on something that happened in this session (the operator corrected you, a command failed or had to be redone, " +
  "a wrong step had to be undone), and `reason` names it; a risk that could have happened is not a lesson. " +
  "Never for: a one-off task; an environment or setup failure the operator can fix; an attempt that never worked; claims that some tool does not work; " +
  "facts about this one repository (commands, paths, conventions) — hand those to report_finding as a proposal for the repository's AGENTS.md or docs; " +
  "an error or gap in Kermanych's own turn instruction (the pull request or commit text, the base-sync step, the skill review step) — report it with " +
  "report_finding and leave the skills alone, even one that describes the same action; " +
  "secrets, tokens or personal data.";

/** When an agent improves a skill at `level`: the same words in the tool's description and the reflection step. */
export function skillLessonRule(level: SkillImprovementOnLevel): string {
  return `${LESSON_WHEN[level]} ${LESSON_NEVER}`;
}

/**
 * Kermanych's own last step of «Створити ПР», «Закоміти» and «Зберегти дизайн»: the moment the
 * agent looks back at the session for skill lessons. Appended after the rendered instruction — the
 * default or an override — so «Do only this» does not cancel it. The agent may meet it more than
 * once per session, hence «not yet made in this session».
 */
export function skillReflectionBlock(level: SkillImprovementOnLevel): string {
  return [
    "Before you reply, look back over this session for skill improvements. This step is Kermanych's own and applies ",
    "whatever the instruction above says. Consider the Kermanych library skills you used in this session: those you read ",
    "and those pasted into your instructions. ",
    skillLessonRule(level),
    " For each improvement you have not yet made in this session, call `improve_skill`. If there is none, do not call it. ",
    "Then finish the instruction above.",
  ].join("");
}

// ── the record ─────────────────────────────────────────────────────────────────

export const SKILL_IMPROVEMENT_STATES = ["applied", "rolled_back", "promoted"] as const;
export type SkillImprovementState = (typeof SKILL_IMPROVEMENT_STATES)[number];

export function isSkillImprovementState(v: unknown): v is SkillImprovementState {
  return typeof v === "string" && (SKILL_IMPROVEMENT_STATES as readonly string[]).includes(v);
}

/**
 * What the skill resolved to WITHOUT the personal layer when it was changed: a Kermanych default,
 * a workspace or project row, or nothing (`none`: the skill exists only as the operator's own row).
 */
export const SKILL_TEAM_SCOPES = ["default", "workspace", "project", "none"] as const;
export type SkillTeamScope = (typeof SKILL_TEAM_SCOPES)[number];

export function isSkillTeamScope(v: unknown): v is SkillTeamScope {
  return typeof v === "string" && (SKILL_TEAM_SCOPES as readonly string[]).includes(v);
}

/** One row of the column: what the list read and the Realtime binding carry — no skill text. */
export type SkillImprovementEntry = {
  id: string;
  skillName: string;
  summary: string;
  sessionName: string;
  projectId?: string;
  workspaceId?: string;
  state: SkillImprovementState;
  seenAt?: string;
  createdAt: string;
};

/** The whole record, read when an entry is opened or a rollback / share is planned. */
export type SkillImprovement = SkillImprovementEntry & {
  userId: string;
  sessionId: string;
  reason: string;
  beforeBody: string;
  edits: SkillEdit[];
  createdCopy: boolean;
  teamScope: SkillTeamScope;
  teamOwnerId?: string;
  stateAt: string;
};

/** What the api writes for one change. */
export type SkillImprovementInsert = {
  userId: string;
  skillName: string;
  teamScope: SkillTeamScope;
  teamOwnerId?: string;
  createdCopy: boolean;
  beforeBody: string;
  edits: SkillEdit[];
  summary: string;
  reason: string;
  sessionId: string;
  sessionName: string;
  projectId?: string;
  workspaceId?: string;
};

/** The text a change left: its before-text with its edits applied; undefined if they no longer apply. */
export function skillImprovementAfter(r: Pick<SkillImprovement, "beforeBody" | "edits">): string | undefined {
  const res = applySkillEdits(r.beforeBody, r.edits);
  return res.ok ? res.text : undefined;
}

// Oldest first; the id breaks a tie so two changes stamped in one millisecond keep one order.
function byAge(a: Pick<SkillImprovement, "createdAt" | "id">, b: Pick<SkillImprovement, "createdAt" | "id">): number {
  return a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1;
}

// ── rollback (decision 7) ───────────────────────────────────────────────────────

export type SkillRollbackAction =
  /** The change created the personal copy: deleting it brings the team or default text back. */
  | { kind: "delete-copy" }
  /** Write the text as it was before the change into the personal copy. */
  | { kind: "restore"; text: string }
  /** The personal copy is already gone (deleted by hand): only the records change state. */
  | { kind: "none" };

export type SkillRollbackPlan = {
  /** The records that become `rolled_back`: the target and every later applied change of the same skill, oldest first. */
  records: SkillImprovement[];
  /** How many of them came after the target — the confirmation names them. */
  later: number;
  action: SkillRollbackAction;
  /** The personal text differs from what the latest of these changes left: edits made by hand since go too. */
  handEdited: boolean;
};

/**
 * Rolling `targetId` back restores the skill to how it was before that change, and rolls back
 * every later applied change of the same skill with it. `records` is any set of the user's
 * records that holds the skill's chain (other skills and settled records are ignored);
 * `personalText` is the personal copy's current text, undefined when there is none.
 * Undefined when the target is unknown or no longer applied.
 */
export function rollbackPlan(
  records: readonly SkillImprovement[],
  targetId: string,
  personalText: string | undefined,
): SkillRollbackPlan | undefined {
  const target = records.find((r) => r.id === targetId);
  if (!target || target.state !== "applied") return undefined;
  const chain = records
    .filter((r) => r.skillName === target.skillName && r.state === "applied" && byAge(r, target) >= 0)
    .sort(byAge);
  const left = skillImprovementAfter(chain[chain.length - 1]!);
  return {
    records: chain,
    later: chain.length - 1,
    action:
      personalText === undefined
        ? { kind: "none" }
        : target.createdCopy
          ? { kind: "delete-copy" }
          : { kind: "restore", text: target.beforeBody },
    handEdited: personalText !== undefined && personalText !== left,
  };
}

// ── sharing with the team (decision 3) ─────────────────────────────────────────

export type SkillShareTarget = { scope: "workspace" | "project"; id: string };

/**
 * Where «Поширити на команду» writes: the scope the skill came from (that project or that
 * workspace). A Kermanych default, or a skill that exists only in the personal layer, goes to the
 * workspace of the record's project. Undefined when there is no workspace to share with.
 */
export function shareTarget(r: Pick<SkillImprovement, "teamScope" | "teamOwnerId" | "workspaceId">): SkillShareTarget | undefined {
  if ((r.teamScope === "project" || r.teamScope === "workspace") && r.teamOwnerId) return { scope: r.teamScope, id: r.teamOwnerId };
  return r.workspaceId ? { scope: "workspace", id: r.workspaceId } : undefined;
}

/** The applied changes of a skill, oldest first: what sharing marks `promoted`. */
export function appliedChain(records: readonly SkillImprovement[], skillName: string): SkillImprovement[] {
  return records.filter((r) => r.skillName === skillName && r.state === "applied").sort(byAge);
}

/**
 * The change the current personal copy started from — the oldest applied change of the skill,
 * when it is the one that created the copy. Undefined when that change was pruned or the copy
 * was made by hand: then nothing says what the team text was.
 */
export function copyOrigin(records: readonly SkillImprovement[], skillName: string): SkillImprovement | undefined {
  const first = appliedChain(records, skillName)[0];
  return first?.createdCopy ? first : undefined;
}

// ── the entry view's diff ──────────────────────────────────────────────────────

export type SkillDiffCell = { no: number; text: string };
/** Shaped like the kit's paired diff rows: a removed line opposite the added line that replaced it. */
export type SkillDiffRow = { kind: "ctx" | "add" | "del" | "mod"; old: SkillDiffCell | null; new: SkillDiffCell | null };
export type SkillDiffHunk = { header: string; rows: SkillDiffRow[] };
export type SkillDiff = { hunks: SkillDiffHunk[] };

// Above this many cells the changed middle is shown as removed-then-added instead of aligned.
// A skill improvement touches a few lines, so the middle left after trimming the common head
// and tail is tiny; the cap only guards a pathological pair of texts.
const LCS_CELLS_MAX = 250_000;

type Op = { kind: "eq"; a: number; b: number } | { kind: "del"; a: number } | { kind: "add"; b: number };

function middleOps(a: readonly string[], b: readonly string[], a0: number, a1: number, b0: number, b1: number): Op[] {
  const n = a1 - a0;
  const m = b1 - b0;
  const ops: Op[] = [];
  if (n * m > LCS_CELLS_MAX) {
    for (let i = a0; i < a1; i++) ops.push({ kind: "del", a: i });
    for (let j = b0; j < b1; j++) ops.push({ kind: "add", b: j });
    return ops;
  }
  // lcs[i][j] = longest common subsequence of a[a0+i..a1) and b[b0+j..b1), flattened.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * w + j] = a[a0 + i] === b[b0 + j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[a0 + i] === b[b0 + j]) {
      ops.push({ kind: "eq", a: a0 + i, b: b0 + j });
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) {
      ops.push({ kind: "del", a: a0 + i });
      i++;
    } else {
      ops.push({ kind: "add", b: b0 + j });
      j++;
    }
  }
  for (; i < n; i++) ops.push({ kind: "del", a: a0 + i });
  for (; j < m; j++) ops.push({ kind: "add", b: b0 + j });
  return ops;
}

function toRows(ops: readonly Op[], a: readonly string[], b: readonly string[]): SkillDiffRow[] {
  const rows: SkillDiffRow[] = [];
  let k = 0;
  while (k < ops.length) {
    const op = ops[k]!;
    if (op.kind === "eq") {
      rows.push({ kind: "ctx", old: { no: op.a + 1, text: a[op.a]! }, new: { no: op.b + 1, text: b[op.b]! } });
      k++;
      continue;
    }
    // A run of removals and additions: pair them line by line (a replaced line reads opposite its
    // replacement), the longer side's rest stands alone.
    const dels: number[] = [];
    const adds: number[] = [];
    while (k < ops.length && ops[k]!.kind !== "eq") {
      const o = ops[k]!;
      if (o.kind === "del") dels.push(o.a);
      else if (o.kind === "add") adds.push(o.b);
      k++;
    }
    const pairs = Math.max(dels.length, adds.length);
    for (let p = 0; p < pairs; p++) {
      const d = dels[p];
      const ad = adds[p];
      rows.push({
        kind: d !== undefined && ad !== undefined ? "mod" : d !== undefined ? "del" : "add",
        old: d !== undefined ? { no: d + 1, text: a[d]! } : null,
        new: ad !== undefined ? { no: ad + 1, text: b[ad]! } : null,
      });
    }
  }
  return rows;
}

/**
 * The line diff of two skill texts, in hunks with `context` unchanged lines around each change and
 * a git-style `@@ -a,n +b,m @@` header. No hunks when the texts are equal.
 */
export function skillTextDiff(before: string, after: string, context = 3): SkillDiff {
  if (before === after) return { hunks: [] };
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ops: Op[] = [];
  for (let i = 0; i < head; i++) ops.push({ kind: "eq", a: i, b: i });
  ops.push(...middleOps(a, b, head, a.length - tail, head, b.length - tail));
  for (let t = tail; t > 0; t--) ops.push({ kind: "eq", a: a.length - t, b: b.length - t });
  const rows = toRows(ops, a, b);

  // Keep each changed row and `context` rows on either side; touching windows merge into one hunk.
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, idx) => {
    if (r.kind === "ctx") return;
    for (let x = Math.max(0, idx - context); x <= Math.min(rows.length - 1, idx + context); x++) keep[x] = true;
  });
  const hunks: SkillDiffHunk[] = [];
  let idx = 0;
  while (idx < rows.length) {
    if (!keep[idx]) {
      idx++;
      continue;
    }
    const start = idx;
    while (idx < rows.length && keep[idx]) idx++;
    const slice = rows.slice(start, idx);
    const olds = slice.flatMap((r) => (r.old ? [r.old.no] : []));
    const news = slice.flatMap((r) => (r.new ? [r.new.no] : []));
    // An empty side starts where its previous line ended, as git writes it.
    const oldStart = olds[0] ?? (rows.slice(0, start).reverse().find((r) => r.old)?.old?.no ?? 0);
    const newStart = news[0] ?? (rows.slice(0, start).reverse().find((r) => r.new)?.new?.no ?? 0);
    hunks.push({ header: `@@ -${oldStart},${olds.length} +${newStart},${news.length} @@`, rows: slice });
  }
  return { hunks };
}
