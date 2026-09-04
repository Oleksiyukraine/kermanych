import { expect, test } from "vitest";
import type { RpcEvent } from "../src/types";
import { INITIAL_STATUS, reduceStatus, shouldNotify, NOTIFY_STATUSES } from "../src/status";

test("agent_start -> thinking", () => {
  expect(reduceStatus(INITIAL_STATUS, { type: "agent_start" } as unknown as RpcEvent).status).toBe("thinking");
});
test("tool start/end toggles tool then thinking", () => {
  let s = reduceStatus(INITIAL_STATUS, { type: "agent_start" } as unknown as RpcEvent);
  s = reduceStatus(s, { type: "tool_execution_start", toolName: "read" } as unknown as RpcEvent);
  expect(s.status).toBe("tool"); expect(s.currentTool).toBe("read");
  s = reduceStatus(s, { type: "tool_execution_end", toolName: "read" } as unknown as RpcEvent);
  expect(s.status).toBe("thinking"); expect(s.currentTool).toBeUndefined();
});
test("ui request -> waiting_input and remembers prior", () => {
  let s = reduceStatus(INITIAL_STATUS, { type: "agent_start" } as unknown as RpcEvent);
  s = reduceStatus(s, { type: "extension_ui_request", id: "u1", method: "confirm" } as unknown as RpcEvent);
  expect(s.status).toBe("waiting_input"); expect(s.prior).toBe("thinking");
});
test("non-interactive ui request (setWidget) does not change status", () => {
  let s = reduceStatus(INITIAL_STATUS, { type: "agent_start" } as unknown as RpcEvent);
  expect(reduceStatus(s, { type: "extension_ui_request", id: "w1", method: "setWidget", widgetKey: "x" } as unknown as RpcEvent).status).toBe("thinking");
});
test("terminal agent_end -> done, non-terminal ignored", () => {
  let s = reduceStatus(INITIAL_STATUS, { type: "agent_start" } as unknown as RpcEvent);
  expect(reduceStatus(s, { type: "agent_end", isTerminal: false } as unknown as RpcEvent).status).toBe("thinking");
  expect(reduceStatus(s, { type: "agent_end", isTerminal: true } as unknown as RpcEvent).status).toBe("done");
});

test("NOTIFY_STATUSES is the attention set", () => {
  expect([...NOTIFY_STATUSES]).toEqual(["waiting_input", "error", "conflict", "done", "in_review"]);
});

test("shouldNotify fires when a pushed PR lands the session on review", () => {
  expect(shouldNotify("tool", "in_review")).toBe(true);
  expect(shouldNotify("in_review", "in_review")).toBe(false);
});

test("shouldNotify fires on a transition INTO a notify status", () => {
  expect(shouldNotify("tool", "waiting_input")).toBe(true);
  expect(shouldNotify("thinking", "error")).toBe(true);
  expect(shouldNotify("tool", "done")).toBe(true);
  expect(shouldNotify("thinking", "conflict")).toBe(true);
  expect(shouldNotify(undefined, "error")).toBe(true);
});

test("shouldNotify ignores non-notify targets and same-status repeats", () => {
  expect(shouldNotify("thinking", "tool")).toBe(false);
  expect(shouldNotify("queued", "thinking")).toBe(false);
  expect(shouldNotify("done", "done")).toBe(false);
  expect(shouldNotify("waiting_input", "waiting_input")).toBe(false);
  expect(shouldNotify(undefined, "thinking")).toBe(false);
});
