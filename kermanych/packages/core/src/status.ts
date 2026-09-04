import type { RpcEvent, SessionStatus } from "./types";

export type StatusState = { status: SessionStatus; currentTool?: string; prior?: SessionStatus };
export const INITIAL_STATUS: StatusState = { status: "queued" };
export const INTERACTIVE_UI_METHODS: Record<string, true> = { select: true, confirm: true, input: true, editor: true };

// Active = the omp process is mid-work or blocked on the user; archiving these is refused.
// Broader than a "running" bucket: waiting_input counts as active here. Check with
// ACTIVE_STATUSES.includes(status) — mirrors MainLayout's RUNNING convention.
export const ACTIVE_STATUSES: readonly SessionStatus[] = ["queued", "thinking", "tool", "waiting_input"];

// Statuses worth a native notification: the agent needs the operator, or it finished.
// `in_review` is the PR half of "it finished" — the branch is pushed and a human now owes
// it a review, which is exactly the moment the operator has to hear about.
export const NOTIFY_STATUSES: readonly SessionStatus[] = ["waiting_input", "error", "conflict", "done", "in_review"];

// True only on a transition INTO a notify status (never on same-status repeats),
// so callers fire one notification per meaningful change.
export function shouldNotify(prev: SessionStatus | undefined, next: SessionStatus): boolean {
  return prev !== next && NOTIFY_STATUSES.includes(next);
}

export function reduceStatus(s: StatusState, e: RpcEvent): StatusState {
  switch (e.type) {
    case "agent_start":
    case "turn_start":
    case "message_start":
    case "message_update":
    case "message_end":
      return { status: "thinking" };
    case "tool_execution_start": {
      const toolName = "toolName" in e && typeof e.toolName === "string" ? e.toolName : undefined;
      return { status: "tool", currentTool: toolName };
    }
    case "tool_execution_end":
      return { status: "thinking" };
    case "extension_ui_request": {
      const method = "method" in e && typeof e.method === "string" ? e.method : undefined;
      return method !== undefined && INTERACTIVE_UI_METHODS[method] === true
        ? { status: "waiting_input", prior: s.status === "waiting_input" ? s.prior : s.status }
        : s;
    }
    case "agent_end": {
      const isTerminal = "isTerminal" in e ? e.isTerminal : undefined;
      return isTerminal === false ? s : { status: "done" };
    }
    default:
      return s;
  }
}
