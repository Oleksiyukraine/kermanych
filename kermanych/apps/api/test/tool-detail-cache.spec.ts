import { expect, test } from "vitest";
import { ToolDetailCache, MAX_CALL_BYTES } from "../src/supervisor/tool-detail-cache";

const lines = (n: number, size = 1) => Array.from({ length: n }, (_, i) => ({ t: "ctx" as const, text: "x".repeat(size) + i }));

test("stores and returns lines per session and call", () => {
  const c = new ToolDetailCache();
  c.put("s1", "call-1", lines(3));
  expect(c.get("s1", "call-1")).toHaveLength(3);
  expect(c.get("s1", "missing")).toBeUndefined();
  expect(c.get("s2", "call-1")).toBeUndefined();
});

test("refuses a single payload above the per-call cap", () => {
  const c = new ToolDetailCache();
  c.put("s1", "huge", lines(1, MAX_CALL_BYTES + 1));
  expect(c.get("s1", "huge")).toBeUndefined();
});

test("evicts oldest calls once the session budget is exceeded", () => {
  const c = new ToolDetailCache({ maxSessionBytes: 500 });
  c.put("s1", "a", lines(1, 200));
  c.put("s1", "b", lines(1, 200));
  c.put("s1", "c", lines(1, 200));
  expect(c.get("s1", "a")).toBeUndefined();
  expect(c.get("s1", "c")).toHaveLength(1);
});

test("dropSession frees everything for that session only", () => {
  const c = new ToolDetailCache();
  c.put("s1", "a", lines(1));
  c.put("s2", "a", lines(1));
  c.dropSession("s1");
  expect(c.get("s1", "a")).toBeUndefined();
  expect(c.get("s2", "a")).toHaveLength(1);
});
