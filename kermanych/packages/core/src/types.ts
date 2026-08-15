import type { BranchPrefix } from "./worktree-names";

export type SessionStatus =
  | "backlog" | "queued" | "thinking" | "tool" | "waiting_input" | "done" | "error" | "stopped" | "merged" | "conflict";

export type TodoTask = { id: string; content: string; status: "pending" | "in_progress" | "completed" | string };
export type TodoPhase = { id: string; name: string; tasks: TodoTask[] };

export type Group = { id: string; name: string; projectDir: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; createdAt: string };

export type EnvEntry = { key: string; value: string };
export type EnvFileView = { entries: EnvEntry[]; ignored: boolean };

export type DirEntry = { name: string; isRepo: boolean };
export type DirListing = { path: string; parent: string | null; entries: DirEntry[] };

export type Session = {
  id: string; groupId: string; name: string; task: string;
  worktreePath: string; branch: string;
  worktree: boolean; baseBranch?: string;
  model?: string; prefix?: BranchPrefix;
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
  name?: string | undefined; task?: string | undefined; model?: string | undefined; prefix?: BranchPrefix | undefined; worktree?: boolean | undefined;
};

export type ImageInput = { data: string; mimeType: string };

export type ToolStatus = "pending" | "ok" | "error";

export type TranscriptEntry =
  | { kind: "user_text"; text: string; images?: string[] }
  | { kind: "assistant_text"; text: string }
  | { kind: "assistant_thinking"; text: string }
  | { kind: "tool"; id: string; tool: string; status: ToolStatus; summary?: string }
  | { kind: "notice"; text: string };

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
  | { type: "message_end"; message?: any }
  | { type: "tool_execution_start"; toolName?: string; toolCallId?: string; args?: any }
  | { type: "tool_execution_end"; toolName?: string; toolCallId?: string; isError?: boolean }
  | { type: "agent_end"; isTerminal?: boolean }
  | { type: "notice"; message?: string }
  | RpcExtensionUIRequest
  | { type: "rpc_chunk"; chunkId: string; index: number; count: number; byteLength: number; data: string }
  | { type: string; [k: string]: unknown };

// Server -> client WebSocket messages
export type ServerEvent =
  | { type: "snapshot"; groups: Group[]; sessions: Session[] }
  | { type: "session_update"; session: Session }
  | { type: "transcript_append"; sessionId: string; entry: TranscriptEntry }
  | { type: "transcript_reset"; sessionId: string; entries: TranscriptEntry[] }
  | { type: "transcript_update"; sessionId: string; id: string; status: "ok" | "error" }
  | { type: "group_update"; group: Group }
  | { type: "session_removed"; sessionId: string }
  | { type: "group_removed"; groupId: string };
