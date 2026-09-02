import { expect, test } from "vitest";
import { buildChatBlocks, THINK_MIN_MS } from "../src/chat-blocks";
import type { TranscriptEntry } from "../src/types";

const user = (id: string, at: number, text: string): TranscriptEntry => ({ kind: "user_text", id, at, text });
const tool = (id: string, at: number, t: string, extra: Partial<Extract<TranscriptEntry, { kind: "tool" }>> = {}): TranscriptEntry =>
  ({ kind: "tool", id, at, tool: t, status: "ok", ...extra });

test("splits the transcript on user messages and keeps pre-request entries in their own block", () => {
  const blocks = buildChatBlocks([
    { kind: "notice", id: "n1", at: 1, level: "info", text: "стартую" },
    user("u1", 10, "Го"),
    tool("t1", 20, "bash"),
    user("u2", 30, "далі"),
    tool("t2", 40, "bash"),
  ]);
  expect(blocks.map((b) => b.id)).toEqual(["pre", "u1", "u2"]);
  expect(blocks[1]!.request?.text).toBe("Го");
  expect(blocks[1]!.items).toHaveLength(1);
});

test("coalesces a run of same-tool reads and sums their counts", () => {
  const blocks = buildChatBlocks([
    user("u1", 0, "x"),
    tool("t1", 1, "read", { target: "a.ts", count: 20, stat: "20 ln" }),
    tool("t2", 2, "read", { target: "b.ts", count: 13, stat: "13 ln" }),
    tool("t3", 3, "edit", { target: "a.ts", count: 2, stat: "+1 −1" }),
    tool("t4", 4, "read", { target: "c.ts", count: 5, stat: "5 ln" }),
  ]);
  const items = blocks[0]!.items;
  expect(items[0]).toMatchObject({ kind: "group", tool: "read", stat: { count: 33, unitKey: "chat.unit.lines" } });
  expect((items[0] as { members: unknown[] }).members).toHaveLength(2);
  expect(items[1]).toMatchObject({ kind: "entry" });
  expect(items[2]).toMatchObject({ kind: "entry" });
});

// A `read` whose payload carried no `totalLines` reports a byte size and no count. Adding it
// into a sum would under-report the run; summing a run of only those would print `0 ln`.
test("a group containing a count-less member reports no stat at all", () => {
  const blocks = buildChatBlocks([
    user("u1", 0, "x"),
    tool("t1", 1, "read", { target: "a.ts", count: 145, stat: "145 ln" }),
    tool("t2", 2, "read", { target: "b.ts", stat: "4.6 KB" }),
  ]);
  const group = blocks[0]!.items[0] as { kind: string; stat?: unknown; members: unknown[] };
  expect(group.kind).toBe("group");
  expect(group.members).toHaveLength(2);
  expect(group.stat).toBeUndefined();
  expect("stat" in group).toBe(false);
});

test("a group of only count-less members does not invent a zero total", () => {
  const blocks = buildChatBlocks([
    user("u1", 0, "x"),
    tool("t1", 1, "read", { target: "a.ts", stat: "4.6 KB" }),
    tool("t2", 2, "read", { target: "b.ts", stat: "1.2 KB" }),
    tool("t3", 3, "read", { target: "c.ts", stat: "820 B" }),
  ]);
  const group = blocks[0]!.items[0] as { kind: string; stat?: unknown; members: unknown[] };
  expect(group.kind).toBe("group");
  expect(group.members).toHaveLength(3);
  expect(group.stat).toBeUndefined();
  expect(group.stat).not.toBe("0 ln");
});

// The count-less member arrives after the run was already summable, so the total has to be
// withdrawn rather than left standing at its earlier value.
test("a count-less member joining a summable run withdraws the total", () => {
  const blocks = buildChatBlocks([
    user("u1", 0, "x"),
    tool("t1", 1, "grep", { target: "/a/ src", count: 4, stat: "4 збігів" }),
    tool("t2", 2, "grep", { target: "/b/ src", count: 6, stat: "6 збігів" }),
  ]);
  expect(blocks[0]!.items[0]).toMatchObject({ kind: "group", stat: { count: 10, unitKey: "chat.unit.matches" } });

  const widened = buildChatBlocks([
    user("u1", 0, "x"),
    tool("t1", 1, "grep", { target: "/a/ src", count: 4, stat: "4 збігів" }),
    tool("t2", 2, "grep", { target: "/b/ src", count: 6, stat: "6 збігів" }),
    tool("t3", 3, "grep", { target: "/c/ src" }),
  ]);
  const group = widened[0]!.items[0] as { stat?: unknown; members: unknown[] };
  expect(group.members).toHaveLength(3);
  expect(group.stat).toBeUndefined();
  expect("stat" in group).toBe(false);
});

test("a lone read is not grouped", () => {
  const blocks = buildChatBlocks([user("u1", 0, "x"), tool("t1", 1, "read", { count: 3 })]);
  expect(blocks[0]!.items[0]).toMatchObject({ kind: "entry" });
});

test("mutes short reasoning but keeps it in the block and in the think total", () => {
  const blocks = buildChatBlocks([
    user("u1", 0, "x"),
    { kind: "assistant_thinking", id: "k1", at: 1, text: "short", ms: 5_000 },
    { kind: "assistant_thinking", id: "k2", at: 2, text: "long", ms: 39_000 },
  ]);
  const items = blocks[0]!.items;
  expect(items[0]).toMatchObject({ kind: "entry", muted: true });
  expect(items[1]).toMatchObject({ kind: "entry", muted: false });
  expect(blocks[0]!.summary.thinkMs).toBe(44_000);
  expect(THINK_MIN_MS).toBe(8_000);
});

test("summary counts calls, distinct touched files and cost, and never lists turn entries as items", () => {
  const blocks = buildChatBlocks([
    user("u1", 1_000, "x"),
    tool("t1", 2_000, "edit", { target: "a.ts", count: 3 }),
    tool("t2", 3_000, "edit", { target: "a.ts", count: 1 }),
    tool("t3", 4_000, "write", { target: "b.ts", count: 9 }),
    tool("t4", 5_000, "read", { target: "c.ts", count: 2 }),
    { kind: "turn", id: "r1", at: 6_000, model: "opus-4.8", ms: 1_200, usage: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0, cost: 0.2 } },
    { kind: "turn", id: "r2", at: 7_000, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.05 } },
  ]);
  const b = blocks[0]!;
  expect(b.items.every((i) => i.kind !== "entry" || i.entry.kind !== "turn")).toBe(true);
  expect(b.summary).toEqual({ ms: 6_000, calls: 4, files: 2, thinkMs: 0, cost: 0.25 });
});
