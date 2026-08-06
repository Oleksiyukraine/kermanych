// tests/status.test.ts
import { expect, test } from "bun:test";
import type { RpcEvent } from "../src/server/types";
import { INITIAL_STATUS, reduceStatus } from "../src/server/status";

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
