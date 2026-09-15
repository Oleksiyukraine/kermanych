// The «task-update» mechanism: the structured artifact an agent attaches to its cloud card, and
// the one parser that reads it off its output. The «Тестувальник» skill speaks through it:
//
//   * «Тестувальник» → a `qa-checklist`: the concrete, human-checkable things to test on the
//     change. A person ticks the items on the board afterwards.
//
// The split is deliberate:
//   * the OUTPUT CONTRACT (this fence, this shape, this parser) lives HERE, in code, so a team
//     editing a library skill can enrich WHAT is produced without ever breaking the parser;
//   * the skill body / a launch directive only says WHEN and WHAT to emit.
//
// SupervisorService scans every task-born session's output with `parseTaskActions` and writes
// the artifact to the card with `patchTask` (applyTaskArtifact).
//
// The fence is the app's single action fence (MANAGEMENT_ACTION_FENCE), reused rather than
// reinvented: it already means «structured instruction to Kermanych, not prose». The surfaces
// never collide — the management parser runs only on the management chat's replies, this one
// only on a work session's output — so the same fence carrying new `kind`s is safe.

import { MANAGEMENT_ACTION_FENCE } from "./management-actions";

export const QA_CHECKLIST_KIND = "qa-checklist";

// ── stored shapes ──────────────────────────────────────────────────────────────

/** One line of a QA checklist. `text` is authored by the agent; the rest is a human ticking it. */
export type QaChecklistItem = {
  /** Stable within a checklist, so a tick addresses one row across reorders and re-renders. */
  id: string;
  text: string;
  checked: boolean;
  /** The cloud user id who ticked it, and when — set on check, dropped on uncheck. */
  checkedBy?: string;
  checkedAt?: string;
};

export type QaChecklist = {
  /** ISO timestamp of the generation that produced these items. */
  generatedAt: string;
  /** The session whose run produced it, for provenance. */
  sessionId?: string;
  items: QaChecklistItem[];
};

// ── parsed actions ─────────────────────────────────────────────────────────────

/** A validated artifact an agent emitted, ready for applyTaskArtifact to store. */
export type TaskAction =
  | { kind: typeof QA_CHECKLIST_KIND; items: string[] };

// Fenced blocks whose info string is exactly our fence. Byte-identical to management-actions'
// BLOCK_RE: `[^\S\n]*` rather than `\s*` so a blank line is never eaten as part of the info
// string, `gm` so several blocks in one reply are all seen.
const BLOCK_RE = new RegExp(
  "^[^\\S\\n]*```" + MANAGEMENT_ACTION_FENCE + "[^\\S\\n]*\\n([\\s\\S]*?)\\n?[^\\S\\n]*```[^\\S\\n]*$",
  "gm",
);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Trimmed, non-empty, de-duplicated strings — what a checklist's items reduce to. A blank or
// non-string entry is dropped rather than stored.
function cleanStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    const text = typeof item === "string" ? item.trim() : "";
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

// One parsed object → a validated action, or `undefined` when it is not one of ours or carries
// nothing usable. Tolerant on purpose: this runs on a model's free-form output, where an
// off-topic or malformed block is an ordinary event, not an error to surface.
function validateTaskAction(v: unknown): TaskAction | undefined {
  if (!isObj(v)) return undefined;
  if (v.kind === QA_CHECKLIST_KIND) {
    const items = cleanStrings(v.items);
    return items.length ? { kind: QA_CHECKLIST_KIND, items } : undefined;
  }
  return undefined;
}

/**
 * Every valid task action a piece of agent output declares, in document order. Unreadable JSON
 * and unknown/empty kinds are skipped rather than thrown — the caller wants the artifacts that
 * ARE there, not a failure over a block that is not one.
 */
export function parseTaskActions(raw: string): TaskAction[] {
  const out: TaskAction[] = [];
  for (const m of raw.matchAll(BLOCK_RE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]!);
    } catch {
      continue;
    }
    for (const one of Array.isArray(parsed) ? parsed : [parsed]) {
      const action = validateTaskAction(one);
      if (action) out.push(action);
    }
  }
  return out;
}

// ── builders (parsed action + provenance → stored shape) ─────────────────────────

/** Turn checklist item texts into the stored shape: freshly generated, nothing ticked. */
export function buildQaChecklist(
  items: readonly string[],
  meta: { generatedAt: string; sessionId?: string },
): QaChecklist {
  return {
    generatedAt: meta.generatedAt,
    ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
    items: items.map((text, i) => ({ id: `q${i + 1}`, text, checked: false })),
  };
}

// ── emit directives (the WHEN/WHAT, referencing the code-owned contract) ──────────

/**
 * Appended to the pull-request prompt (SupervisorService.createPullRequest) when the session
 * runs against a cloud task — the only case there is a card to store the result on. English,
 * like the pull-request instruction it rides with; the items themselves are asked for in the
 * task's own language, since a tester reads them, not the model.
 */
export const QA_CHECKLIST_DIRECTIVE = [
  "Then, separately from the pull request, compose a QA checklist for a human tester: the",
  "concrete, user-observable things to verify on THIS task's change, derived from the task and",
  "the diff. Each item is a single, independently checkable action in plain language, written",
  "in the language of the task. Omit anything already guaranteed by automated tests. Output the",
  "checklist as ONE fenced block, exactly this shape and nothing else inside the fence:",
  "",
  "```" + MANAGEMENT_ACTION_FENCE,
  '{ "kind": "' + QA_CHECKLIST_KIND + '", "items": ["…", "…"] }',
  "```",
].join("\n");
