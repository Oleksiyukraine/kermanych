# Transcript Tool-Line Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse each tool invocation into one status-transitioning log row (`◆ pending → ✓/✗ done`), removing the redundant bare `✓ read` line, and broaden the call-summary fallback so more tools carry context.

**Architecture:** Replace the split `tool_call` + `tool_result` transcript entries with one unified `{ kind: "tool"; id; tool; status; summary? }`. The live supervisor appends a `pending` entry on `tool_execution_start` and patches it to `ok`/`error` on `tool_execution_end` via a new `transcript_update` server event; the UI store patches the entry in place (index-keyed `v-for`, no remount). The history mapper produces the same shape, pairing results to calls FIFO by tool name. Summary derivation is centralized in one `toolCallSummary` helper.

**Tech Stack:** TypeScript, NestJS (`apps/api`), Quasar/Vue 3 + Pinia (`apps/ui`), `@kermanych/core` (shared types/logic), vitest.

## Global Constraints

- Node 22.x; pnpm workspace (`packages/*`, `apps/*`).
- `@kermanych/core` is framework-agnostic; UI and API both import from it.
- No change to the omp RPC command surface, session lifecycle, or persistence.
- Clean cutover: no `tool_call`/`tool_result` kind may remain anywhere.
- Design tokens/rendering rules unchanged (green `--k-diff` reserved for diffs).

---

### Task 1: Core contract — unified entry, event, summary helper

**Files:**
- Modify: `packages/core/src/types.ts` (TranscriptEntry, ServerEvent, RpcEvent)
- Create: `packages/core/src/tool-summary.ts`
- Modify: `packages/core/src/index.ts` (barrel export)
- Test: `packages/core/test/tool-summary.spec.ts`

**Interfaces:**
- Produces: `type ToolStatus = "pending" | "ok" | "error"`;
  `TranscriptEntry` member `{ kind: "tool"; id: string; tool: string; status: ToolStatus; summary?: string }`;
  `ServerEvent` member `{ type: "transcript_update"; sessionId: string; id: string; status: "ok" | "error" }`;
  `RpcEvent`'s `tool_execution_end` gains `toolCallId?: string`;
  `toolCallSummary(args: Record<string, unknown> | undefined, fallbackIntent?: string): string | undefined`.

- [ ] **Step 1: Write the failing test** — `packages/core/test/tool-summary.spec.ts`

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kermanych/core test`
Expected: FAIL — cannot find module `../src/tool-summary`.

- [ ] **Step 3: Create the helper** — `packages/core/src/tool-summary.ts`

```ts
// Single source of truth for the inline summary of a tool call. Both the live
// supervisor and the history mapper derive their call summary from here, so the
// two paths render identically. Fallback order runs from the most specific
// argument to the near-universal `i` intent.
export function toolCallSummary(
  args: Record<string, unknown> | undefined,
  fallbackIntent?: string,
): string | undefined {
  const a = args ?? {};
  const pick = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
  return (
    pick("command") ?? pick("path") ?? pick("pattern") ?? pick("query") ?? pick("i") ?? fallbackIntent
  );
}
```

- [ ] **Step 4: Update types** — `packages/core/src/types.ts`

Add `ToolStatus` and replace the two tool members of `TranscriptEntry`:

```ts
export type ToolStatus = "pending" | "ok" | "error";

export type TranscriptEntry =
  | { kind: "user_text"; text: string; images?: string[] }
  | { kind: "assistant_text"; text: string }
  | { kind: "assistant_thinking"; text: string }
  | { kind: "tool"; id: string; tool: string; status: ToolStatus; summary?: string }
  | { kind: "notice"; text: string };
```

Add `toolCallId?` to the `tool_execution_end` member of `RpcEvent`:

```ts
  | { type: "tool_execution_end"; toolName?: string; toolCallId?: string; isError?: boolean }
```

Add the update member to `ServerEvent`:

```ts
  | { type: "transcript_update"; sessionId: string; id: string; status: "ok" | "error" }
```

- [ ] **Step 5: Export the helper** — `packages/core/src/index.ts`

```ts
export * from "./tool-summary";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @kermanych/core test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/tool-summary.ts packages/core/src/index.ts packages/core/test/tool-summary.spec.ts
git commit -m "feat(core): unified tool transcript entry + transcript_update + toolCallSummary"
```

---

### Task 2: API producers — supervisor + history mapper

**Files:**
- Modify: `apps/api/src/supervisor/messages-to-transcript.ts`
- Modify: `apps/api/src/supervisor/supervisor.service.ts:193-200` (+ a `finishTool` helper and a `toolSeq` field)
- Test: `apps/api/test/messages-to-transcript.spec.ts`

**Interfaces:**
- Consumes: `TranscriptEntry` (`kind: "tool"`), `ToolStatus`, `toolCallSummary` from `@kermanych/core`.
- Produces: unified `tool` entries from both live events and history.

- [ ] **Step 1: Update the mapper test** — `apps/api/test/messages-to-transcript.spec.ts`

Replace the `"maps user text, tool calls, and tool results"` test and add pairing/fallback cases:

```ts
test("collapses a tool call and its result into one tool entry", () => {
  const out = messagesToTranscript([
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "toolCall", name: "Read", arguments: { path: "a.ts" } }] },
    { role: "toolResult", toolName: "Read", isError: false, content: [{ type: "text", text: "ok" }] },
  ]);
  expect(out).toEqual([
    { kind: "user_text", text: "hi", images: undefined },
    { kind: "tool", id: "h1", tool: "Read", status: "ok", summary: "a.ts\nok" },
  ]);
});

test("marks failed results as error", () => {
  const out = messagesToTranscript([
    { role: "assistant", content: [{ type: "toolCall", name: "Bash", arguments: { command: "false" } }] },
    { role: "toolResult", toolName: "Bash", isError: true, content: [{ type: "text", text: "exit 1" }] },
  ]);
  expect(out).toEqual([{ kind: "tool", id: "h1", tool: "Bash", status: "error", summary: "false\nexit 1" }]);
});

test("pairs parallel same-name calls FIFO", () => {
  const out = messagesToTranscript([
    { role: "assistant", content: [
      { type: "toolCall", name: "Read", arguments: { path: "a.ts" } },
      { type: "toolCall", name: "Read", arguments: { path: "b.ts" } },
    ] },
    { role: "toolResult", toolName: "Read", isError: false, content: [{ type: "text", text: "A" }] },
    { role: "toolResult", toolName: "Read", isError: false, content: [{ type: "text", text: "B" }] },
  ]);
  expect(out).toEqual([
    { kind: "tool", id: "h1", tool: "Read", status: "ok", summary: "a.ts\nA" },
    { kind: "tool", id: "h2", tool: "Read", status: "ok", summary: "b.ts\nB" },
  ]);
});

test("falls back through pattern/query/intent for the call summary", () => {
  const out = messagesToTranscript([
    { role: "assistant", content: [{ type: "toolCall", name: "grep", arguments: { pattern: "foo" }, intent: "searching" }] },
  ]);
  expect(out).toEqual([{ kind: "tool", id: "h1", tool: "grep", status: "pending", summary: "foo" }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kermanych/api test`
Expected: FAIL — mapper still emits `tool_call`/`tool_result`.

- [ ] **Step 3: Rewrite the mapper** — `apps/api/src/supervisor/messages-to-transcript.ts`

```ts
import type { TranscriptEntry, ToolStatus } from "@kermanych/core";
import { toolCallSummary } from "@kermanych/core";

export type OmpPart = {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  intent?: string;
  data?: string;
  mimeType?: string;
};
export type OmpMessage = { role?: string; content?: OmpPart[]; toolName?: string; isError?: boolean };

// Map omp's converted message history into transcript entries, mirroring the live
// event reduction: user text/images, assistant reasoning then text, and tool
// invocations. Each tool call becomes one `pending` entry; the following
// toolResult message pairs to the oldest pending entry of the same tool name
// (FIFO), flipping its status and appending any result text to the summary.
export function messagesToTranscript(messages: unknown[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  let seq = 0;
  for (const raw of messages) {
    const m = raw as OmpMessage;
    const parts = m.content ?? [];
    if (m.role === "user") {
      const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
      const images = parts
        .filter((p) => p.type === "image" && p.data)
        .map((p) => `data:${p.mimeType ?? "image/png"};base64,${p.data}`);
      if (text.trim() || images.length) out.push({ kind: "user_text", text, images: images.length ? images : undefined });
    } else if (m.role === "assistant") {
      for (const p of parts) {
        if (p.type === "thinking" && p.thinking?.trim()) out.push({ kind: "assistant_thinking", text: p.thinking });
        else if (p.type === "text" && p.text?.trim()) out.push({ kind: "assistant_text", text: p.text });
        else if (p.type === "toolCall")
          out.push({ kind: "tool", id: `h${++seq}`, tool: p.name ?? "?", status: "pending", summary: toolCallSummary(p.arguments, p.intent) });
      }
    } else if (m.role === "toolResult") {
      const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
      const tool = m.toolName ?? "?";
      const status: ToolStatus = m.isError ? "error" : "ok";
      const entry = out.find((x) => x.kind === "tool" && x.status === "pending" && x.tool === tool);
      if (entry && entry.kind === "tool") {
        entry.status = status;
        if (text.trim()) entry.summary = entry.summary ? `${entry.summary}\n${text}` : text;
      } else {
        out.push({ kind: "tool", id: `h${++seq}`, tool, status, summary: text.trim() ? text : undefined });
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @kermanych/api test`
Expected: PASS.

- [ ] **Step 5: Rewrite the live producer** — `apps/api/src/supervisor/supervisor.service.ts`

Add a field near the other private members: `private toolSeq = 0;`. Import `toolCallSummary` alongside the existing `@kermanych/core` imports. Replace lines 193-200:

```ts
    if (e.type === "tool_execution_start") {
      const ev = e as Extract<RpcEvent, { type: "tool_execution_start" }>;
      const entryId = ev.toolCallId ?? `t${++this.toolSeq}`;
      this.appendEntry(id, { kind: "tool", id: entryId, tool: ev.toolName ?? "?", status: "pending", summary: toolCallSummary(ev.args) });
    }
    if (e.type === "tool_execution_end") {
      const ev = e as Extract<RpcEvent, { type: "tool_execution_end" }>;
      this.finishTool(id, ev.toolName ?? "?", ev.toolCallId, ev.isError ? "error" : "ok");
    }
```

Add the helper method (next to `appendEntry`):

```ts
  // Flip a pending tool entry to its terminal status in place and notify clients.
  // Match by exact toolCallId when omp provides one, else the oldest pending
  // entry of the same tool name (FIFO — correct for interchangeable parallel calls).
  private finishTool(id: string, tool: string, toolCallId: string | undefined, status: "ok" | "error") {
    const l = this.map.get(id);
    if (!l) return;
    const entry =
      (toolCallId ? l.transcript.find((x) => x.kind === "tool" && x.id === toolCallId) : undefined) ??
      l.transcript.find((x) => x.kind === "tool" && x.status === "pending" && x.tool === tool);
    if (!entry || entry.kind !== "tool") return;
    entry.status = status;
    this.events.next({ type: "transcript_update", sessionId: id, id: entry.id, status });
  }
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/supervisor/messages-to-transcript.ts apps/api/src/supervisor/supervisor.service.ts apps/api/test/messages-to-transcript.spec.ts
git commit -m "feat(api): emit unified tool entries + in-place status update"
```

---

### Task 3: UI — store patch + unified render + gallery samples

**Files:**
- Modify: `apps/ui/src/stores/orchestrator.ts` (add `transcript_update` reduce branch)
- Modify: `apps/ui/src/components/kit/KLogBlock.vue` (unify tool template + `glyph` computed)
- Modify: `apps/ui/src/pages/KitGalleryPage.vue:248-265` (migrate sample entries)

**Interfaces:**
- Consumes: `transcript_update` `ServerEvent`; `TranscriptEntry` (`kind: "tool"`).

- [ ] **Step 1: Handle the update in the store** — `apps/ui/src/stores/orchestrator.ts`

Add after the `transcript_reset` branch in `reduce`:

```ts
    } else if (e.type === 'transcript_update') {
      const list = transcripts.value[e.sessionId];
      if (list) {
        transcripts.value = {
          ...transcripts.value,
          [e.sessionId]: list.map((x) =>
            x.kind === 'tool' && x.id === e.id ? { ...x, status: e.status } : x,
          ),
        };
      }
```

- [ ] **Step 2: Unify the tool template** — `apps/ui/src/components/kit/KLogBlock.vue`

Replace the two templates (`tool_call` and `tool_result`, lines 3-31) with one:

```html
    <!-- tool — one row per invocation; glyph transitions ◆ pending → ✓ ok / ✗ error -->
    <template v-if="entry.kind === 'tool'">
      <div class="k-log__row" :class="entry.status === 'pending' ? 'k-log__row--tool' : 'k-log__row--result'">
        <span class="k-log__glyph" aria-hidden="true">{{ glyph }}</span>
        <span class="k-log__tool">{{ entry.tool }}</span>
        <span v-if="head" class="k-log__summary">{{ head }}</span>
      </div>
      <div
        v-for="(line, i) in body"
        :key="i"
        class="k-log__body"
        :class="{ 'k-log__diff': line.diff, [`k-log__diff--${line.sign}`]: line.diff }"
      >{{ line.text }}</div>
    </template>
```

Update the `head` and `body` computeds' guards from `kind === 'tool_call' || kind === 'tool_result'` to `kind === 'tool'`, and add:

```ts
const glyph = computed(() => {
  if (props.entry.kind !== 'tool') return '';
  return props.entry.status === 'pending' ? '◆' : props.entry.status === 'ok' ? '✓' : '✗';
});
```

- [ ] **Step 3: Migrate gallery samples** — `apps/ui/src/pages/KitGalleryPage.vue`

Replace the `tool_call`/`tool_result` entries in `panelLog`, `waitingLog`, `logSamples` with unified `tool` entries covering all three statuses, e.g.:

```ts
const panelLog: TranscriptEntry[] = [
  { kind: 'tool', id: '1', tool: 'Edit', status: 'ok', summary: 'src/auth/token.service.ts\n+ this.rotateShared(token);' },
  { kind: 'tool', id: '2', tool: 'Bash', status: 'ok', summary: 'npm run test:e2e -- auth\n12 passed, 0 failed (8.4s)' },
  { kind: 'assistant_text', text: 'Готово. Ротація токенів зведена в один запит.' },
];
const waitingLog: TranscriptEntry[] = [
  { kind: 'tool', id: '1', tool: 'Read', status: 'pending', summary: 'src/session.ts' },
  { kind: 'assistant_text', text: 'Знайшов два місця, де зберігається сесія.' },
];
const logSamples: TranscriptEntry[] = [
  { kind: 'tool', id: '1', tool: 'Read', status: 'ok', summary: 'src/routes/login.tsx' },
  { kind: 'tool', id: '2', tool: 'Edit', status: 'ok', summary: 'db/schema/users.ts\n+ lastSeenAt: timestamp("last_seen_at"),' },
  { kind: 'tool', id: '3', tool: 'Vitest', status: 'ok', summary: '12 passed, 0 failed (8.4s)' },
  { kind: 'tool', id: '4', tool: 'Bash', status: 'error', summary: 'exit 1 — 2 failing specs' },
  { kind: 'assistant_thinking', text: 'Сесія зберігається у двох місцях — треба звести.' },
  { kind: 'assistant_text', text: '## Знайшов два місця\n\nСесія зберігається у **двох** місцях.' },
  { kind: 'notice', text: 'Гілку перемкнено на feat/schema.' },
];
```

- [ ] **Step 4: Typecheck the UI**

Run: `pnpm --filter ui build` (or the repo's `vue-tsc` typecheck script)
Expected: no type errors; no remaining reference to `tool_call`/`tool_result`.

- [ ] **Step 5: Smoke test**

Run `pnpm dev:api` + `pnpm dev:ui`, open a live session:
- a burst of parallel reads shows one row each, `◆ read <path>` flipping to `✓ read <path>` in place — no bare `✓ read` rows;
- a failing tool shows `✗`;
- `grep`/`web_search` rows show their pattern/query;
- reload the session → identical rows, bash result text intact.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/stores/orchestrator.ts apps/ui/src/components/kit/KLogBlock.vue apps/ui/src/pages/KitGalleryPage.vue
git commit -m "feat(ui): merge tool call/result into one status-transitioning log row"
```

---

## Self-Review

- **Spec coverage:** §4.1 unified entry + event → Task 1; §4.2 helper → Task 1; §4.3 live producer → Task 2; §4.4 history mapper → Task 2; §4.5 store + KLogBlock + gallery → Task 3; §6 verification → Task 2 tests + Task 3 smoke. No gaps.
- **Placeholder scan:** none — every step has concrete code or an exact command.
- **Type consistency:** `ToolStatus`, `{ kind: "tool"; id; tool; status; summary? }`, `transcript_update` `{ sessionId; id; status }`, and `toolCallSummary(args, fallbackIntent?)` are used identically across Tasks 1-3.
