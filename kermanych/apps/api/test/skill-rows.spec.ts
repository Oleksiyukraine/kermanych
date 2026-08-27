import { expect, test } from "vitest";
import { reduceRpcEvents } from "../src/supervisor/transcript-reducer";
import { messagesToTranscript } from "../src/supervisor/messages-to-transcript";
import type { RpcEvent } from "@kermanych/core";

const skillSource = (name: string) =>
  name === "kermanych-session"
    ? { stat: "бібліотека", intent: "/Users/u/.kermanych/skills/p1/kermanych-session/SKILL.md" }
    : undefined;

const events = (path: string): RpcEvent[] =>
  [
    { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path } },
    {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "read",
      result: { content: [{ type: "text", text: "# body" }] },
    },
  ] as unknown as RpcEvent[];

test("a skill read becomes a skill row carrying name and source", () => {
  const { entries } = reduceRpcEvents(events("skill://kermanych-session"), { skillSource });
  const row = entries.find((e) => e.kind === "tool");
  expect(row).toMatchObject({
    kind: "tool",
    tool: "skill",
    target: "kermanych-session",
    stat: "бібліотека",
    intent: "/Users/u/.kermanych/skills/p1/kermanych-session/SKILL.md",
    status: "ok",
  });
});

test("an ordinary file read is untouched", () => {
  const { entries } = reduceRpcEvents(events("/repo/src/main.ts"), { skillSource });
  expect(entries.find((e) => e.kind === "tool")).toMatchObject({ tool: "read", target: "src/main.ts" });
});

test("the end frame still pairs with its start row when omp sends no call id", () => {
  const evs = [
    { type: "tool_execution_start", toolName: "read", args: { path: "skill://kermanych-session" } },
    { type: "tool_execution_end", toolName: "read", result: { content: [{ type: "text", text: "x" }] } },
  ] as unknown as RpcEvent[];
  const rows = reduceRpcEvents(evs, { skillSource }).entries.filter((e) => e.kind === "tool");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ tool: "skill", status: "ok" });
});

test("rehydrated history renders the same skill row", () => {
  const messages = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "skill://kermanych-session" } }],
    },
    { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "# body" }] },
  ];
  const { entries } = messagesToTranscript(messages, { skillSource });
  expect(entries.find((e) => e.kind === "tool")).toMatchObject({
    tool: "skill",
    target: "kermanych-session",
    stat: "бібліотека",
  });
});

test("an unknown skill name yields a row without a badge rather than throwing", () => {
  const { entries } = reduceRpcEvents(events("skill://not-in-library"), { skillSource });
  const row = entries.find((e) => e.kind === "tool");
  expect(row).toMatchObject({ tool: "skill", target: "not-in-library" });
  expect((row as { stat?: string }).stat).toBeUndefined();
});

test("a sub-resource read resolves the skill's badge and keeps the sub-path as the target", () => {
  const { entries } = reduceRpcEvents(events("skill://kermanych-session/reference.md"), { skillSource });
  expect(entries.find((e) => e.kind === "tool")).toMatchObject({
    tool: "skill",
    target: "kermanych-session/reference.md",
    stat: "бібліотека",
  });
});

// The live supervisor reduces ONE event per call, carrying the tool maps between them, so the
// end frame never sees the start frame's entry — the shape the five tests above cannot expose.
test("a skill row stays a skill row when the two frames arrive in separate reduce calls", () => {
  const opts = {
    startedAt: new Map<string, number>(),
    pendingArgs: new Map<string, Record<string, unknown>>(),
    skillSource,
  };
  const [start, end] = events("skill://kermanych-session");
  const body = Array.from({ length: 9 }, (_, i) => `l${i + 1}`).join("\n");
  reduceRpcEvents([start!], opts);
  // `displayContent` is what readDisplay numbers its lines from: a patch reduced as `read`
  // would carry "1"/"2" numbers, a "2/40 ln" stat and a 10-line budget instead.
  const endWithBody = {
    ...end,
    result: { content: [{ type: "text", text: body }], details: { displayContent: { text: "a\nb", lineNumbers: [1, 2] }, totalLines: 40 } },
  } as unknown as RpcEvent;
  const patch = reduceRpcEvents([endWithBody], opts).entries.find((e) => e.kind === "tool");
  expect(patch).toMatchObject({
    tool: "skill",
    target: "kermanych-session",
    stat: "бібліотека",
    intent: "/Users/u/.kermanych/skills/p1/kermanych-session/SKILL.md",
    status: "ok",
  });
  const detail = (patch as { detail?: { lines: { n?: string; text: string }[]; totalLines: number } }).detail;
  // skillDisplay's own shape: unnumbered lines off the result body, clamped at the default 8.
  expect(detail?.totalLines).toBe(9);
  expect(detail?.lines).toHaveLength(8);
  expect(detail?.lines.every((l) => l.n === undefined)).toBe(true);
  expect(detail?.lines[0]).toEqual({ t: "ctx", text: "l1" });
});
