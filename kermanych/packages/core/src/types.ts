import type { BranchPrefix } from "./worktree-names";
import type { Platform } from "./platform";

export type SessionStatus =
  | "backlog" | "queued" | "thinking" | "tool" | "waiting_input" | "done" | "error" | "stopped" | "merged" | "conflict";

export type TodoTask = { id: string; content: string; status: "pending" | "in_progress" | "completed" | string };
export type TodoPhase = { id: string; name: string; tasks: TodoTask[] };

// A project is a CLOUD entity (Supabase `projects`); this shape is the LOCAL row:
// `id` is the cloud project UUID, `localRepoPath` is THIS machine's binding ("" when
// unbound), and the rest is an offline cache of the cloud config so launching never
// needs the network (design D1 / Requirement 7).
export type Project = { id: string; name: string; localRepoPath: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; defaultBranch?: string; conventions?: string; createdAt: string };

export type EnvEntry = { key: string; value: string };
export type EnvFileView = { entries: EnvEntry[]; ignored: boolean };

export type DirEntry = { name: string; isRepo: boolean };
export type DirListing = { path: string; parent: string | null; entries: DirEntry[] };

export type Session = {
  id: string; projectId: string; name: string; task: string;
  // The cloud task this session executes, when it was launched from the board.
  taskId?: string;
  worktreePath: string; branch: string;
  worktree: boolean; baseBranch?: string;
  model?: string; prefix?: BranchPrefix; platform?: Platform;
  kind: "agent" | "discussion" | "task" | "review" | "chat";
  parentSessionId?: string;
  ompSessionId?: string; ompSessionFile?: string;
  status: SessionStatus; currentTool?: string; error?: string;
  todoPhases?: TodoPhase[]; contextPercent?: number; lastEventAt?: number;
  // Lifetime accounting: every assistant turn this session ran, summed. Persisted by the
  // api, so a dormant or finished agent still states what it spent. Absent means "never
  // counted" — a zeroed shape would claim a free agent.
  usage?: Usage;
  pendingUiRequest?: RpcExtensionUIRequest; archived?: boolean; createdAt: string;
  lastActivityAt: string;
};

// The editable launch config the New-task launcher collects; startTask/updateTask patch
// these onto a backlog row. All fields optional — it is a partial patch.
export type TaskDraft = {
  name?: string | undefined; task?: string | undefined; model?: string | undefined; prefix?: BranchPrefix | undefined; platform?: Platform | undefined; worktree?: boolean | undefined; baseBranch?: string | undefined;
};

export type ImageInput = { data: string; mimeType: string };

export type ToolStatus = "pending" | "ok" | "error";

// One classified line of tool detail. `n` is the source line number when the tool
// reports one. `gap` marks an elided diff hunk boundary; `head` a file/section title.
export type ToolLine =
  | { t: "ctx"; n?: string; text: string }
  | { t: "add"; n?: string; text: string }
  | { t: "del"; n?: string; text: string }
  | { t: "hit"; n?: string; text: string }
  | { t: "head"; text: string }
  | { t: "gap" };

// A clamped, display-ready slice of a tool result. The full line list stays on the
// API behind GET /sessions/:id/tools/:callId — it never rides the WebSocket.
export type ToolDetail = {
  lines: ToolLine[];
  totalLines: number;
  truncatedUpstream?: boolean;
};

// Token + money accounting, one shape at two scales: what a single assistant turn consumed
// (`turn` entries below) and — summed on `Session` — what the whole agent consumed.
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

// What the agent's PLAN has left, as the provider itself reports it. `Usage` above counts
// what Kermanych's own sessions spent; this is the other half of the same question — the
// subscription's rolling rate-limit windows (Anthropic: 5h and 7d), which also move when the
// same account is used outside Kermanych. Providers meter these in percent of the window's
// quota, never in tokens, so `usedPercent` is the figure and there is no token count to show.
export type UsageWindow = {
  // The provider's own window id (`5h`, `7d`, `monthly`) — the UI derives its short label
  // from this, so a window Kermanych has never heard of still renders.
  id: string;
  // The provider's label for the window, e.g. "5 Hour". Carried for the tooltip.
  label: string;
  usedPercent: number;
  // Absent when the provider states no reset instant for the window.
  resetsAt?: string;
};

// One provider's plan, aggregated over every account authenticated for it: with several
// accounts `usedPercent` is their mean, which is what "how much of my capacity is gone"
// means when omp balances turns across them.
export type ProviderUsage = { provider: string; accounts: number; windows: UsageWindow[] };

// The whole answer for this machine. `providers` is empty when nothing can be reported —
// no omp on PATH, no authenticated plan, a provider that meters nothing — and the UI shows
// no figure at all rather than a zero it cannot stand behind.
export type SubscriptionUsage = { fetchedAt: string; providers: ProviderUsage[] };

export type TranscriptEntry =
  | { kind: "user_text"; id: string; at: number; text: string; images?: string[] }
  | { kind: "assistant_text"; id: string; at: number; text: string }
  | { kind: "assistant_thinking"; id: string; at: number; text: string; ms?: number; tokens?: number }
  | {
      kind: "tool"; id: string; at: number; tool: string; status: ToolStatus;
      intent?: string; target?: string; stat?: string; count?: number; ms?: number; detail?: ToolDetail;
    }
  | { kind: "notice"; id: string; at: number; level: "info" | "warn" | "error"; text: string }
  | { kind: "turn"; id: string; at: number; model?: string; ms?: number; usage?: Usage };

export type RpcExtensionUIRequest = {
  type: "extension_ui_request"; id: string;
  method: "select" | "confirm" | "input" | "editor" | "cancel" | "notify" | string;
  title?: string; message?: string; placeholder?: string; options?: string[]; timeout?: number;
};
export type RpcExtensionUIResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export type RpcEvent =
  | { type: "ready"; protocolVersion: number; supportedProtocolVersions?: number[] }
  | { type: "response"; id?: string; command: string; success: boolean; data?: any; error?: string }
  | { type: "agent_start" }
  | { type: "turn_start" }
  | { type: "message_start" }
  | { type: "message_update"; assistantMessageEvent?: { type: string; delta?: string } }
  | {
      type: "message_end";
      message?: {
        role?: string; model?: string; provider?: string; duration?: number; ttft?: number; stopReason?: string;
        toolCallId?: string; toolName?: string; content?: unknown[];
        usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
      };
    }
  | { type: "tool_execution_start"; toolName?: string; toolCallId?: string; args?: Record<string, unknown>; intent?: string }
  | {
      type: "tool_execution_end"; toolName?: string; toolCallId?: string; isError?: boolean;
      result?: { content?: { type?: string; text?: string }[]; details?: Record<string, unknown> };
    }
  | { type: "agent_end"; isTerminal?: boolean }
  // omp's `emitNotice` forwards its own level verbatim: it spells a warning `"warning"` and
  // never `"warn"`. Left as an open string because the vocabulary is omp's, not ours — the
  // transcript reducer normalises it into `TranscriptEntry`'s closed `info | warn | error`.
  | { type: "notice"; message?: string; level?: string }
  | RpcExtensionUIRequest
  | { type: "rpc_chunk"; chunkId: string; index: number; count: number; byteLength: number; data: string }
  | { type: string; [k: string]: unknown };

// Server -> client WebSocket messages
export type ServerEvent =
  | { type: "snapshot"; projects: Project[]; sessions: Session[] }
  | { type: "session_update"; session: Session }
  | { type: "transcript_append"; sessionId: string; entry: TranscriptEntry }
  | { type: "transcript_reset"; sessionId: string; entries: TranscriptEntry[] }
  // A tool row completing in place: the pending entry keeps its id and gains the reduced
  // display fields. `target` rides along because the result can improve on the one derived
  // at call time (an `edit` reporting an authoritative repo-relative path), and without it
  // the client would keep the call-time value while the server's transcript shows the better
  // one. The full line list stays on the API behind GET /sessions/:id/tools/:callId.
  | { type: "transcript_update"; sessionId: string; id: string; status: "ok" | "error"; target?: string; stat?: string; count?: number; ms?: number; detail?: ToolDetail }
  | { type: "project_update"; project: Project }
  | { type: "session_removed"; sessionId: string }
  | { type: "project_removed"; projectId: string };
