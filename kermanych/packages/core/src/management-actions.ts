// packages/core/src/management-actions.ts
// The wire protocol between the Менеджмент assistant and the app.
//
// omp's RPC has no structured-output mode and no way to register a custom tool
// (apps/api/src/rpc/rpc-session.ts: the only outbound verbs are prompt/follow_up/steer),
// so the model's one channel back is prose. It therefore emits an action as a fenced block
// inside its answer and the app parses it out:
//
//     ```kermanych-action
//     { "kind": "unsupported", "section": "management-releases", "request": "додай нотатку" }
//     ```
//
// Two rules make that safe rather than merely convenient:
//
//   * the app NEVER executes what it cannot validate — `parseManagementReply` returns only
//     actions that already type-check, and reports the rest as rejections the chat shows;
//   * an action that WRITES runs in the browser under the user's own JWT, so RLS decides
//     what a given member may actually change. A hallucinated action is refused by
//     Postgres, not by trust in the model.
//
// Today there is exactly ONE action kind, and it writes nothing: `unsupported`. That is not
// a placeholder — it is the whole of requirement «if the assistant cannot act on a page, it
// must say why», and it is the only kind that can exist while every section in
// ./management is `capability: "none" | "read"`. A writing kind arrives together with the
// section that can take it: see the comment on the Risk Registry row in ./management for
// the exact three edits.
import type { Usage } from "./types";

// The fence info string. Distinct from `json` on purpose: a model quoting example JSON in
// its prose must not be mistaken for an instruction to act.
export const MANAGEMENT_ACTION_FENCE = "kermanych-action";

export type ManagementAction =
  // The model was asked to change a section that cannot be changed. It reports WHICH
  // section and WHAT was asked; the reason shown to the user is read from the section
  // table (./management `limitation`), never from the model. That is what keeps the
  // refusal honest when the model would rather be agreeable.
  { kind: "unsupported"; section: string; request: string };

export type ManagementActionKind = ManagementAction["kind"];
export type ManagementUnsupported = Extract<ManagementAction, { kind: "unsupported" }>;

// ── Ask / reply ───────────────────────────────────────────────────────────────

// One project of the scoped workspace, as the BROWSER knows it. The split is deliberate and
// it is the whole reason this type exists instead of a bare `string[]`: `gitRemoteUrl` lives
// only on the cloud row (`CloudProject`) and is never mirrored into the local registry, while
// the on-disk path lives only in that registry and must never be taken from a client. So each
// side sends what only it can know, and the api joins them by id.
export type ManagementWorkspaceProject = {
  id: string;
  gitRemoteUrl?: string;
};

// One repository of the scoped workspace, as the api resolved it from its LOCAL registry.
// Paths are never taken from the client: the browser sends project ids, the api joins them
// against `~/.kermanych/kermanych.sqlite`, so the prompt cannot be talked into naming a
// directory the operator never bound.
export type ManagementRepo = {
  projectId: string;
  name: string;
  // Absolute path on this machine, empty when the project is not bound here. The assistant
  // gets read-only tools (read/grep/glob) and one --cwd, so it reaches the other repos of
  // the workspace by absolute path.
  localRepoPath: string;
  gitRemoteUrl?: string;
  defaultBranch?: string;
  conventions?: string;
};

export type ManagementContext = {
  workspaceName: string;
  projectName: string;
  // Active section, by route name — the assistant answers "about this screen" first.
  section: string;
};

export type ManagementChatAsk = {
  // One conversation per scoped project (`management:<projectId>`): switching project in the
  // sidebar switches conversation, which is also what the user sees happen on screen.
  conversationId: string;
  projectId: string;
  // Every project of the scoped workspace, INCLUDING `projectId`. The api turns these into
  // `ManagementRepo[]`; ids the local registry does not know are dropped, not guessed.
  workspaceProjects: ManagementWorkspaceProject[];
  text: string;
  context: ManagementContext;
};

export type ManagementChatReply = {
  // The model's prose, with the action blocks removed.
  text: string;
  actions: ManagementAction[];
  // One line per action block that did not validate. Shown in the chat: a silently dropped
  // instruction is how an operator ends up believing something was recorded.
  rejected: string[];
  // omp notices raised during the turn (dropped frames, provider warnings, a cancelled
  // interactive prompt).
  notices: string[];
  // What the turn cost on the connected plan. This chat runs through the same `omp` binary,
  // the same provider account and the same subscription as every agent, so a turn here is a
  // turn debited there — and the composer says so.
  usage?: Usage;
  model?: string;
  ms: number;
};

// ── Parsing ───────────────────────────────────────────────────────────────────

export type ParsedManagementReply = {
  text: string;
  actions: ManagementAction[];
  rejected: string[];
};

// Fenced blocks whose info string is exactly our fence. `[^\S\n]*` rather than `\s*` so a
// blank line cannot be eaten as part of the info string.
const BLOCK_RE = new RegExp(
  "^[^\\S\\n]*```" + MANAGEMENT_ACTION_FENCE + "[^\\S\\n]*\\n([\\s\\S]*?)\\n?[^\\S\\n]*```[^\\S\\n]*$",
  "gm",
);

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

// One parsed block -> one action, or a sentence explaining why not. The sentence is user
// facing, so it names the offending value rather than a schema path.
export function validateManagementAction(raw: unknown): ManagementAction | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { error: "блок дії має бути JSON-об'єктом" };
  const o = raw as Record<string, unknown>;
  const kind = str(o.kind);
  if (kind === "unsupported") {
    const section = str(o.section);
    if (section === undefined) return { error: "unsupported без поля section" };
    return { kind: "unsupported", section, request: str(o.request) ?? "" };
  }
  // A model that reaches for `risk.create` is not malfunctioning — it is describing a
  // capability this branch does not have yet, and the operator is better served by being
  // told that than by a silent no-op.
  return { error: `невідома дія ${JSON.stringify(o.kind)}` };
}

// Split an assistant answer into the prose the user reads and the actions the app runs.
// Pure and total: unparseable JSON and an unknown `kind` both land in `rejected` and
// NOTHING is executed on a guess.
export function parseManagementReply(raw: string): ParsedManagementReply {
  const actions: ManagementAction[] = [];
  const rejected: string[] = [];
  const text = raw
    .replace(BLOCK_RE, (_m, body: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        rejected.push(`не вдалося прочитати блок дії: ${(err as Error).message}`);
        return "";
      }
      // A model that batches two refusals into one block is being helpful, not wrong.
      for (const one of Array.isArray(parsed) ? parsed : [parsed]) {
        const res = validateManagementAction(one);
        if ("error" in res) rejected.push(res.error);
        else actions.push(res);
      }
      return "";
    })
    // Collapse the hole a removed block leaves, so the prose does not end in three
    // blank lines every time the assistant acts.
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, actions, rejected };
}
