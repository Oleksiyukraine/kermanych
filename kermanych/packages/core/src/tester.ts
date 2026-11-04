// «Тестувальник» (docs/specs/2026-11-04-qa-tester-agent.md): the agent that walks a card's QA
// checklist in the live browser and records a verdict per item. This module is the shared
// contract between the api (launch, MCP tools, hand-off), the UI (button scope, badges, settings)
// and the model (the appended contract). The editable instruction lives in agents.ts.

import { QA_VERDICT_STATUSES, type QaAgentVerdict, type QaChecklistItem, type QaVerdictStatus } from "./task-actions";

/** The MCP tool that records one item's verdict. */
export const QA_RESULT_TOOL = "report_qa_result";
/** The MCP tool that writes a checklist the tester composed, only onto a card that has none. */
export const QA_CHECKLIST_TOOL = "set_qa_checklist";
/** The MCP tool that types a configured account's login or password without the model seeing it. */
export const CREDENTIAL_TOOL = "browser_type_credential";

/**
 * Which items a run checks (decision 11): `all`, or `open` — every item without a `passed`
 * verdict (failed, blocked, never tested).
 */
export type QaRunScope = "all" | "open";

export function isQaRunScope(v: unknown): v is QaRunScope {
  return v === "all" || v === "open";
}

export function isQaVerdictStatus(v: unknown): v is QaVerdictStatus {
  return typeof v === "string" && (QA_VERDICT_STATUSES as readonly string[]).includes(v);
}

/** The items a run of `scope` checks, in checklist order. Human ticks never matter. */
export function qaItemsInScope(items: readonly QaChecklistItem[], scope: QaRunScope): QaChecklistItem[] {
  return scope === "all" ? [...items] : items.filter((i) => i.agent?.status !== "passed");
}

/** Whether any item carries a verdict — the point where the button starts offering a scope. */
export function qaHasVerdicts(items: readonly QaChecklistItem[]): boolean {
  return items.some((i) => i.agent !== undefined);
}

/**
 * Why «Виконати тестування» cannot start on a session now (decision 12), or null when it can.
 * One function for the api's guard and the UI's disabled-with-hint button, so they never disagree.
 * `running` is checked before the rest: while a tester runs, the button leads to it.
 */
export type TesterRefusal =
  | "running" // a tester of this session is already running
  | "not-agent" // not a doer session (chat, discussion, review fork)
  | "finished" // merged, or its worktree is gone
  | "no-card" // no taskId: nowhere to store the checklist
  | "busy" // the doer is mid-turn
  | "no-browser" // no desktop browser host (web build)
  | "platform" // backend / mobile project
  | "no-preview"; // the doer's `.kermanych/preview.json` is missing or invalid

export function testerRefusal(input: {
  kind: string;
  status: string;
  worktree: boolean;
  worktreePath: string;
  taskId?: string;
  runningTester: boolean;
  browserHost: boolean;
  platformHasBrowser: boolean;
  /**
   * The doer's preview config (docs/specs/2026-11-04-session-env-and-tester-preview-gate.md,
   * decision 3); undefined while it is not known, which refuses nothing — the api always knows.
   */
  previewConfig?: "ok" | "missing" | "invalid" | undefined;
}): TesterRefusal | null {
  if (input.runningTester) return "running";
  if (input.kind !== "agent") return "not-agent";
  if (input.status === "merged" || (input.worktree && !input.worktreePath)) return "finished";
  if (!input.taskId) return "no-card";
  if (!input.platformHasBrowser) return "platform";
  if (!input.browserHost) return "no-browser";
  if (input.previewConfig === "missing" || input.previewConfig === "invalid") return "no-preview";
  if (input.status === "thinking" || input.status === "tool") return "busy";
  return null;
}

/**
 * The message ⤴ «Передати виконавцю» sends the doer (decision 13): every failed or blocked item
 * this tester session reported, with its note and screenshot. Empty when there is nothing to hand
 * over — every item of the run passed — so the caller retires the child without a message.
 */
export function qaHandoffText(testerName: string, testerSessionId: string, items: readonly QaChecklistItem[]): string {
  const bad = items.filter(
    (i): i is QaChecklistItem & { agent: QaAgentVerdict } =>
      i.agent?.sessionId === testerSessionId && (i.agent.status === "failed" || i.agent.status === "blocked"),
  );
  if (bad.length === 0) return "";
  const lines = bad.map((i) => {
    const mark = i.agent.status === "failed" ? "✗ не пройдено" : "⏸ заблоковано";
    const shot = i.agent.screenshot ? `\n  Скріншот: \`${i.agent.screenshot}\`` : "";
    return `- ${mark} — ${i.text}\n  ${i.agent.note.trim()}${shot}`;
  });
  return [
    `[${testerName}]: ${bad.length} з ${items.length} пунктів QA-чеклиста не пройшли перевірку в браузері.`,
    "",
    ...lines,
    "",
    "Виправ те, що є дефектом цієї зміни; якщо пункт хибний або заблокований не кодом — скажи про це оператору.",
  ].join("\n");
}

// ── settings (machine-local, per project; decision 4) ────────────────────────────

export type TesterAccount = {
  id: string;
  /** The role or label the agent picks the account by: «Адмін», «Звичайний користувач». */
  name: string;
  login: string;
  password: string;
  note: string;
};

export type TesterSettings = {
  /** Optional sign-in path, e.g. `/login`. Empty means «not set». */
  loginPath: string;
  /** Free text for the tester: test data, limits, what never to press. */
  notes: string;
  accounts: TesterAccount[];
};

export const EMPTY_TESTER_SETTINGS: TesterSettings = { loginPath: "", notes: "", accounts: [] };

// ── prompt pieces (model-facing, so English) ──────────────────────────────────────

/** The `{{items}}` hole: the in-scope items with their ids, or the ask to compose a checklist first. */
export function testerItemsBlock(items: readonly QaChecklistItem[]): string {
  if (items.length === 0)
    return [
      "The card has no QA checklist yet. Compose one first, following the `qa-tester` skill: the ",
      "user-observable things to verify on this branch's change, derived from the task, its task ",
      `document under \`docs/specs/\` if there is one, and \`git diff\` against the base branch. Save it with \`${QA_CHECKLIST_TOOL}\`, `,
      "which answers with the item ids, then walk every item it returned.",
    ].join("");
  return items.map((i) => `- \`${i.id}\`: ${i.text}`).join("\n");
}

/** The `{{accounts}}` hole: names, logins and notes — never a password (decision 5). */
export function testerAccountsBlock(accounts: readonly Pick<TesterAccount, "name" | "login" | "note">[]): string {
  if (accounts.length === 0)
    return "No test accounts are configured. An item that needs a signed-in user is `blocked` with that reason.";
  return accounts
    .map((a) => `- «${a.name}» — login \`${a.login}\`${a.note.trim() ? ` — ${a.note.trim()}` : ""}`)
    .join("\n");
}

export function testerLoginPathLine(loginPath: string): string {
  return loginPath.trim() || "not set — find the sign-in page yourself";
}

export function testerNotesBlock(notes: string): string {
  return notes.trim() || "None.";
}

/** Where a run's screenshots go: `docs/qa/<YYYY-MM-DD>-<branch tail>`. */
export function qaScreenshotDir(date: Date, branch: string): string {
  const day = date.toISOString().slice(0, 10);
  const tail = (branch.split("/").pop() || "session").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
  return `docs/qa/${day}-${tail}`;
}

/**
 * Appended after the tester's rendered instruction — the default or any override — the way the
 * minion gets MINION_OUTCOME_CONTRACT, so no rewrite can drop how a run reports.
 */
export function testerContract(screenshotDir: string): string {
  return [
    "How this run reports — this step is Kermanych's own and applies whatever the instruction above says:\n",
    `- For every checklist item, in order: perform it in the browser, then call \`${QA_RESULT_TOOL}\` exactly once `,
    "with its `itemId`, a `status` and a `note`. `passed` — the page did what the item says. `failed` — it did not: ",
    "the note says what you did, what you expected and what you saw. `blocked` — you could not perform the item ",
    "(no account with the needed role, a sign-in you cannot pass, the preview does not start, missing data): ",
    "the note says what stopped you. Never report a result you did not observe.\n",
    `- For every \`failed\` item, save a screenshot with \`browser_screenshot\` and \`path\` set to \`${screenshotDir}/<itemId>.png\`, `,
    `and pass that path as \`screenshot\` to \`${QA_RESULT_TOOL}\`.\n`,
    `- Type logins and passwords only with \`${CREDENTIAL_TOOL}\`; you are never given a password and must not `,
    "read one back from the page.\n",
    "- Write the notes in the language you were told to communicate in.\n",
    "- Do not edit, create or delete any file other than those screenshots, and do not commit.\n",
    "- When every item has a verdict, end your turn with one short paragraph: how many items passed, failed and ",
    "were blocked, and the most important failure.",
  ].join("");
}
