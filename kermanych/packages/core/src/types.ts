import type { BranchPrefix } from "./worktree-names";
import type { Platform } from "./platform";

export type SessionStatus =
  | "backlog" | "queued" | "thinking" | "tool" | "waiting_input" | "done" | "error" | "stopped" | "merged" | "conflict";

export type TodoTask = { id: string; content: string; status: "pending" | "in_progress" | "completed" | string };
export type TodoPhase = { id: string; name: string; tasks: TodoTask[] };

export type Group = { id: string; name: string; projectDir: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; defaultBranch?: string; conventions?: string; createdAt: string };

export type EnvEntry = { key: string; value: string };
export type EnvFileView = { entries: EnvEntry[]; ignored: boolean };

export type DirEntry = { name: string; isRepo: boolean };
export type DirListing = { path: string; parent: string | null; entries: DirEntry[] };

export type Session = {
  id: string; groupId: string; name: string; task: string;
  worktreePath: string; branch: string;
  worktree: boolean; baseBranch?: string;
  model?: string; prefix?: BranchPrefix; platform?: Platform;
  kind: "agent" | "discussion" | "task" | "review" | "chat";
  parentSessionId?: string;
  ompSessionId?: string; ompSessionFile?: string;
  status: SessionStatus; currentTool?: string; error?: string;
  todoPhases?: TodoPhase[]; contextPercent?: number; lastEventAt?: number;
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

export type TurnUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

export type TranscriptEntry =
  | { kind: "user_text"; id: string; at: number; text: string; images?: string[] }
  | { kind: "assistant_text"; id: string; at: number; text: string }
  | { kind: "assistant_thinking"; id: string; at: number; text: string; ms?: number; tokens?: number }
  | {
      kind: "tool"; id: string; at: number; tool: string; status: ToolStatus;
      intent?: string; target?: string; stat?: string; count?: number; ms?: number; detail?: ToolDetail;
    }
  | { kind: "notice"; id: string; at: number; level: "info" | "warn" | "error"; text: string }
  | { kind: "turn"; id: string; at: number; model?: string; ms?: number; usage?: TurnUsage };

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
  | { type: "snapshot"; groups: Group[]; sessions: Session[] }
  | { type: "session_update"; session: Session }
  | { type: "transcript_append"; sessionId: string; entry: TranscriptEntry }
  | { type: "transcript_reset"; sessionId: string; entries: TranscriptEntry[] }
  // A tool row completing in place: the pending entry keeps its id and gains the reduced
  // display fields. The full line list stays on the API behind GET /sessions/:id/tools/:callId.
  | { type: "transcript_update"; sessionId: string; id: string; status: "ok" | "error"; stat?: string; count?: number; ms?: number; detail?: ToolDetail }
  | { type: "group_update"; group: Group }
  | { type: "session_removed"; sessionId: string }
  | { type: "group_removed"; groupId: string };
