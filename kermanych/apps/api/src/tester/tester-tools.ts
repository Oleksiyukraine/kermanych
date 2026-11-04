// apps/api/src/tester/tester-tools.ts
// «Тестувальник» (docs/specs/2026-11-04-qa-tester-agent.md, decisions 2, 5, 8, 9): the tools a
// tester run gets on the session's `kermanych` MCP server (browser/browser-mcp.service.ts), listed
// only for a `review` child stamped `tester`. The QA tools write the PARENT's card — the tester
// child has no card of its own — item by item through the SQL functions, never a whole-column
// rewrite. The credential tool resolves the value here and types it; nothing it answers, logs or
// throws ever carries the value (decision 5).
import { existsSync } from "node:fs";
import { patchQaItems, setQaChecklistIfEmpty } from "@kermanych/cloud";
import {
  CREDENTIAL_TOOL,
  QA_CHECKLIST_TOOL,
  QA_RESULT_TOOL,
  QA_VERDICT_STATUSES,
  buildQaChecklist,
  isQaVerdictStatus,
  type QaAgentVerdict,
  type QaChecklist,
  type Session,
  type TesterAccount,
} from "@kermanych/core";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RegistryService } from "../registry/registry.service";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

// The longest note a verdict keeps: a paragraph, not a log dump.
export const QA_NOTE_MAX = 4000;
// The most items a composed checklist may hold.
export const QA_CHECKLIST_MAX = 60;

export const QA_RESULT_TOOL_DEF = {
  name: QA_RESULT_TOOL,
  description:
    "Record your verdict on ONE item of this session's QA checklist, right after you performed it in the browser. Call it exactly once per item, in order; it is saved at once on the task card, beside the human tester's tick (which you never change). " +
    "`passed`: the page did what the item says. `failed`: it did not — the note says what you did, what you expected and what you saw, and `screenshot` names the PNG you saved with browser_screenshot `path`. " +
    "`blocked`: you could not perform the item (no account with the needed role, a sign-in you cannot pass, the preview does not start, missing data) — the note says what stopped you. Never report a result you did not observe.",
  inputSchema: {
    type: "object",
    properties: {
      itemId: { type: "string", description: "The item's id as given in your instructions or by set_qa_checklist, e.g. `q3`." },
      status: { type: "string", enum: [...QA_VERDICT_STATUSES] },
      note: { type: "string", maxLength: QA_NOTE_MAX, description: "What you did and saw; for failed — expected vs actual; for blocked — the reason. In the language you were told to communicate in." },
      screenshot: { type: "string", description: "Worktree-relative path of a PNG under docs/ you saved with browser_screenshot, e.g. `docs/qa/2026-11-04-branch/q3.png`." },
    },
    required: ["itemId", "status", "note"],
    additionalProperties: false,
  },
};

export const QA_CHECKLIST_TOOL_DEF = {
  name: QA_CHECKLIST_TOOL,
  description:
    "Save the QA checklist you composed for this session's task card, when the card has none yet. Each item is one independently checkable, user-observable action in plain language, in the language of the task. " +
    "Answers with the item ids to pass to report_qa_result. Refused when the card already has a checklist: then walk that one.",
  inputSchema: {
    type: "object",
    properties: {
      items: { type: "array", items: { type: "string" }, minItems: 1, maxItems: QA_CHECKLIST_MAX, description: "The checklist items, in the order to perform them." },
    },
    required: ["items"],
    additionalProperties: false,
  },
};

export const CREDENTIAL_TOOL_DEF = {
  name: CREDENTIAL_TOOL,
  description:
    "Type the login or the password of a configured test account into an input of this session's browser page, like browser_type with `clear`. You are never given a password: name the account and the field, and Kermanych types the value. " +
    "The answer never repeats the value; do not read it back from the page.",
  inputSchema: {
    type: "object",
    properties: {
      ref: { type: "string", description: "A ref from the latest browser_snapshot (e.g. e12), or a CSS selector." },
      account: { type: "string", description: "The account's name exactly as listed in your instructions." },
      field: { type: "string", enum: ["login", "password"] },
      submit: { type: "boolean", default: false, description: "Press Enter after typing (default false)." },
    },
    required: ["ref", "account", "field"],
    additionalProperties: false,
  },
};

export const TESTER_QA_TOOL_NAMES = new Set([QA_RESULT_TOOL, QA_CHECKLIST_TOOL]);

/** A tester run: a `review` child stamped `tester`. */
export function isTesterSession(s: Session | undefined): s is Session & { kind: "review"; tester: true } {
  return s?.kind === "review" && s.tester === true;
}

export type TesterToolDeps = {
  registry: RegistryService;
  client: () => SupabaseClient;
  // Every checklist write the tools make, for the socket's `qa_checklist_update`.
  changed: (taskId: string, checklist: QaChecklist) => void;
  // Throws the reason when `path` is not a worktree-relative PNG under the worktree's docs/;
  // answers the absolute file (browser-mcp.service.ts screenshotFile).
  screenshotFile: (worktreePath: string, path: string) => string;
};

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** One `report_qa_result` or `set_qa_checklist` call from `sessionId`. A refusal is a tool error. */
export async function callTesterQaTool(deps: TesterToolDeps, sessionId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const session = deps.registry.listSessions().find((s) => s.id === sessionId);
  if (!isTesterSession(session)) return fail(`Not recorded: ${name} is only for «Тестувальник» runs, and this session is not one.`);
  // The doer session whose card and worktree the tester works on.
  const parent = deps.registry.listSessions().find((s) => s.id === session.parentSessionId);
  if (!parent?.taskId) return fail("Not recorded: the tested session has no task card to store the checklist on.");
  return name === QA_RESULT_TOOL ? reportResult(deps, session, parent, parent.taskId, args) : setChecklist(deps, session, parent.taskId, args);
}

async function reportResult(deps: TesterToolDeps, session: Session, parent: Session, taskId: string, args: Record<string, unknown>): Promise<ToolResult> {
  const itemId = typeof args.itemId === "string" ? args.itemId.trim() : "";
  if (!itemId) return fail("Not recorded: `itemId` is required.");
  if (!isQaVerdictStatus(args.status)) return fail(`Not recorded: \`status\` must be one of ${QA_VERDICT_STATUSES.join(", ")}.`);
  const note = typeof args.note === "string" ? args.note.trim() : "";
  if (!note) return fail("Not recorded: `note` is required — say what you did and saw.");
  if (note.length > QA_NOTE_MAX) return fail(`Not recorded: \`note\` is longer than ${QA_NOTE_MAX} characters.`);
  let screenshot: string | undefined;
  if (args.screenshot !== undefined && args.screenshot !== null && args.screenshot !== "") {
    if (typeof args.screenshot !== "string") return fail("Not recorded: `screenshot` must be a path.");
    if (!parent.worktreePath) return fail("Not recorded: the tested session has no worktree for the screenshot.");
    let file: string;
    try {
      file = deps.screenshotFile(parent.worktreePath, args.screenshot);
    } catch (err) {
      return fail(`Not recorded: ${(err as Error).message}`);
    }
    if (!existsSync(file)) return fail(`Not recorded: ${args.screenshot} does not exist — save it with browser_screenshot \`path\` first.`);
    screenshot = args.screenshot;
  }
  const verdict: QaAgentVerdict = { status: args.status, note, ...(screenshot ? { screenshot } : {}), sessionId: session.id, at: new Date().toISOString() };
  let checklist: QaChecklist;
  try {
    checklist = await patchQaItems(deps.client(), taskId, [itemId], { agent: verdict });
  } catch (err) {
    const message = (err as Error).message;
    return fail(/item not found/.test(message) ? `Not recorded: the card's checklist has no item \`${itemId}\`.` : `Not recorded: ${message}`);
  }
  deps.changed(taskId, checklist);
  return ok(`Recorded ${itemId}: ${args.status}.`);
}

async function setChecklist(deps: TesterToolDeps, session: Session, taskId: string, args: Record<string, unknown>): Promise<ToolResult> {
  const raw = args.items;
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) return fail("Not saved: `items` must be an array of strings.");
  const items = (raw as string[]).map((x) => x.trim()).filter(Boolean);
  if (!items.length) return fail("Not saved: give at least one item.");
  if (items.length > QA_CHECKLIST_MAX) return fail(`Not saved: at most ${QA_CHECKLIST_MAX} items.`);
  const checklist = buildQaChecklist(items, { generatedAt: new Date().toISOString(), sessionId: session.id });
  let wrote: boolean;
  try {
    wrote = await setQaChecklistIfEmpty(deps.client(), taskId, checklist);
  } catch (err) {
    return fail(`Not saved: ${(err as Error).message}`);
  }
  if (!wrote) return fail("Not saved: the card already has a QA checklist. Walk the items from your instructions instead.");
  deps.changed(taskId, checklist);
  return ok(`Saved ${items.length} items. Walk them in order:\n${checklist.items.map((i) => `- \`${i.id}\`: ${i.text}`).join("\n")}`);
}

/**
 * The value `browser_type_credential` types: the named account's login or password from this
 * machine's tester settings of the project. Throws a message that names the account, never a value.
 */
export function credentialValue(registry: RegistryService, projectId: string, args: Record<string, unknown>): { account: TesterAccount; field: "login" | "password"; value: string } {
  const field = args.field;
  if (field !== "login" && field !== "password") throw new Error("`field` must be login or password");
  const name = typeof args.account === "string" ? args.account.trim() : "";
  if (!name) throw new Error("`account` is required");
  const { accounts } = registry.getTesterSettings(projectId);
  const account = accounts.find((a) => a.name === name) ?? accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!account)
    throw new Error(
      accounts.length
        ? `No test account named «${name}». Configured: ${accounts.map((a) => `«${a.name}»`).join(", ")}.`
        : "No test accounts are configured for this project. Report the item `blocked` with that reason.",
    );
  return { account, field, value: field === "login" ? account.login : account.password };
}

/** `message` with every occurrence of `secret` masked: a host error must not echo a typed value. */
export function maskSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join("•••") : message;
}
