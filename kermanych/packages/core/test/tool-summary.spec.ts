import { expect, test } from "vitest";
import { toolCallSummary } from "../src/tool-summary";

test("prefers command, then path, then pattern, then query, then i, then intent", () => {
  expect(toolCallSummary({ command: "ls", path: "a" })).toBe("ls");
  expect(toolCallSummary({ path: "a.ts" })).toBe("a.ts");
  expect(toolCallSummary({ pattern: "foo" })).toBe("foo");
  expect(toolCallSummary({ query: "bar" })).toBe("bar");
  expect(toolCallSummary({ i: "reading file" })).toBe("reading file");
  expect(toolCallSummary({}, "fallback intent")).toBe("fallback intent");
  expect(toolCallSummary(undefined)).toBeUndefined();
});

test("ignores non-string argument values", () => {
  expect(toolCallSummary({ command: 42, path: "a.ts" } as Record<string, unknown>)).toBe("a.ts");
});
