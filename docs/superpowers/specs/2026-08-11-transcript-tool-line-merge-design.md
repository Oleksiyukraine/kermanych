# Kermanych — Transcript Tool-Line Merge (Design)

- **Status:** Draft for review
- **Date:** 2026-08-11
- **Scope:** `packages/core` (types, helper), `apps/api` (supervisor, history
  mapper, test), `apps/ui` (KLogBlock, orchestrator store, KitGallery)
- **Branch:** `kermanych/remove-noice-from-chat`

## 1. Purpose

Kill the redundant, information-free tool line in the session log. Today every
tool invocation renders as **two** rows:

```
◆ read skill://using-superpowers   ← tool_call  (useful: tool + path)
✓ read                             ← tool_result (bare: tool name + ✓, no info)
```

Five parallel reads become ten rows, half of them a bare `✓ read`. The result
row duplicates the tool name and adds only the pass/fail glyph.

Two changes:

1. **Merge** the call and result of one invocation into a **single** row whose
   status glyph transitions in place: `◆ read <path>` (pending) →
   `✓ read <path>` (done) / `✗ read <path>` (failed). The path stays visible,
   the completion/failure signal is kept, the duplicate name is gone.
2. **Broaden the call summary fallback** so tools without a `command`/`path`
   (e.g. `grep`, `web_search`, `task`) still carry context instead of rendering
   as a bare `◆ grep`.

This is orchestration-shell polish. No change to the omp RPC command surface,
session lifecycle, worktree handling, or persistence.

## 2. Current state (as-is)

- `packages/core` `TranscriptEntry` has two separate tool members:
  `{ kind: "tool_call"; tool; summary? }` and
  `{ kind: "tool_result"; tool; ok; summary? }`.
- **Live path** (`supervisor.service.ts` `onRpcEvent`):
  - `tool_execution_start` → appends `tool_call` with
    `summary: ev.args?.command ?? ev.args?.path`.
  - `tool_execution_end` → appends `tool_result` with `ok: !ev.isError` and
    **no `summary`** — the omp end event carries only `toolName` + `isError`,
    no result content. This bare entry is the noise.
- **History path** (`messages-to-transcript.ts`): a `toolCall` part becomes a
  `tool_call` (`summary: arguments.command ?? arguments.path ?? intent`); a
  following `toolResult` message becomes a `tool_result` whose `summary` is the
  joined result text (so `bash → "12 passed, 0 failed"` survives). Live and
  history therefore already diverge: history results have text, live never do.
- **Transport:** `events.gateway.ts` forwards **every** `ServerEvent`
  generically (`events$.subscribe(e => server.emit("event", e))`), so a new
  event variant needs no gateway change.
- **Render:** `KLogBlock.vue` has one template per kind; the log is a
  `v-for="(entry, i) in entries" :key="i"` (index key) in `WorkspacePage.vue`
  and `KitGalleryPage.vue`. Index keying means replacing `entries[k]` with a new
  object patches the **same** component instance in place — no remount.
- `KitGalleryPage.vue` seeds sample logs with literal `tool_call` / `tool_result`
  entries.

## 3. Constraints / key findings

- **Live results carry no content.** `tool_execution_end` = `{ toolName?,
  isError? }`. Enriching the live result row with real output (line counts, bash
  output) is impossible without changing omp's RPC contract — out of scope. The
  only live signal is success/failure, which the merged glyph preserves.
- **Correlation id exists on start, not end.** `tool_execution_start` has
  `toolCallId`; `tool_execution_end` (as typed) does not. We match end → start by
  `toolCallId` when present, else FIFO by tool name among pending entries. FIFO
  is correct for display even with parallel identical calls (interchangeable).
- **History has no ids either** — `OmpPart`/`OmpMessage` expose no call id, so the
  history mapper uses the same FIFO-by-name pairing.

## 4. Design

### 4.1 Unified transcript entry (`packages/core/src/types.ts`)

Replace the two tool members with one:

```ts
export type ToolStatus = "pending" | "ok" | "error";

// removed: { kind: "tool_call"; ... } | { kind: "tool_result"; ok; ... }
| { kind: "tool"; id: string; tool: string; status: ToolStatus; summary?: string }
```

- `id` — correlation handle for in-place update (the `toolCallId`, or a
  synthesized id when absent).
- `status` — drives the glyph: `pending → ◆`, `ok → ✓`, `error → ✗`.
- `summary` — the call summary (head), plus any result text appended by the
  history mapper (§4.4). Live never appends result text.

New server → client event:

```ts
| { type: "transcript_update"; sessionId: string; id: string; status: "ok" | "error" }
```

`ServerEvent` gains this member; the gateway already forwards it. `RpcEvent`'s
`tool_execution_end` gains an optional `toolCallId?: string` (harmless — used
for exact matching when omp provides it, FIFO fallback otherwise).

### 4.2 Shared summary helper (`packages/core`)

Single source of truth for both live and history summary derivation:

```ts
export function toolCallSummary(
  args: Record<string, unknown> | undefined,
  fallbackIntent?: string,
): string | undefined {
  const a = args ?? {};
  const pick = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
  return pick("command") ?? pick("path") ?? pick("pattern") ?? pick("query")
    ?? pick("i") ?? fallbackIntent;
}
```

Fallback order `command → path → pattern → query → i → intent` covers `bash`,
`read`/`edit`/`write`, `grep`, `web_search`, and the near-universal `i` intent
field, so almost every call row carries context.

### 4.3 Live path (`supervisor.service.ts`)

- `tool_execution_start` → append
  `{ kind: "tool", id: ev.toolCallId ?? synth(), tool: ev.toolName ?? "?",
     status: "pending", summary: toolCallSummary(ev.args) }`.
  `synth()` is a monotonic per-supervisor counter (`t${n}`), only used when
  omp omits `toolCallId`.
- `tool_execution_end` → locate the target entry: exact `id === ev.toolCallId`
  if present, else the **oldest** `kind === "tool" && status === "pending"` entry
  with the same `tool` name in `l.transcript`. Mutate its `status` to
  `ok`/`error`, then emit `{ type: "transcript_update", sessionId, id: entry.id,
  status }`. If no match is found, do nothing (defensive).
- `reduceStatus` (start → `tool`, end → `thinking`) is unchanged; the
  `pushUpdate` on `tool_execution_start` is unchanged.
- `transcript_reset` (resume) already ships `l.transcript`, now carrying unified
  entries with their live-final status — consistent.

### 4.4 History path (`messages-to-transcript.ts`)

- `OmpPart.arguments` loosens to `Record<string, unknown>` so `toolCallSummary`
  can read `pattern`/`query`/`i`.
- A `toolCall` part → push
  `{ kind: "tool", id: synth, tool, status: "pending",
     summary: toolCallSummary(p.arguments, p.intent) }`.
- A `toolResult` message → find the oldest pending unified entry with matching
  `tool` name; set `status = isError ? "error" : "ok"`; append the joined result
  text to its `summary` (newline-joined, skipped when empty) so bash-style
  output is preserved. No match → skip (defensive).

Live and history now produce the same entry shape and render identically.

### 4.5 UI

- **`orchestrator.ts`** — add a `transcript_update` branch to `reduce`:
  immutably `map` the session's entries, replacing the one whose
  `kind === "tool" && id === e.id` with `{ ...x, status: e.status }`. Index
  keying patches it in place.
- **`KLogBlock.vue`** — replace the `tool_call` and `tool_result` templates with
  one `tool` template. Glyph from a `glyph` computed
  (`pending → ◆`, `ok → ✓`, `error → ✗`). Row class: `--tool` (all muted) while
  pending, `--result` (summary at text weight) once done — reusing existing
  styles, so a pending row looks like today's call row and flips to the result
  look on completion. The `head`/`body` computeds switch their kind guard from
  `tool_call || tool_result` to `tool`.
- **`KitGalleryPage.vue`** — migrate sample `tool_call`/`tool_result` entries to
  the unified `tool` kind (mix of `pending`/`ok`/`error`) so the gallery
  type-checks and demonstrates all three states.

## 5. Isolation / boundaries

- **`packages/core`** — owns the entry shape, the event, and `toolCallSummary`
  (the one place summary derivation lives).
- **`supervisor.service`** — the only live producer; append-pending +
  update-on-end, both additive to existing event handling.
- **`messages-to-transcript`** — the only history producer; mirrors the live
  pairing via the shared helper.
- **`orchestrator` store** — pure reducer; one new immutable branch.
- **`KLogBlock`** — pure presenter of one entry; net-simpler (one tool template).

## 6. Verification

- **Backend unit (vitest, `apps/api`):** extend the `messagesToTranscript`
  test — assert a `toolCall` + following `toolResult` collapse into one
  `{ kind: "tool", status: "ok", summary: "<cmd>\n<result>" }`; assert an error
  result yields `status: "error"`; assert two parallel same-name calls pair FIFO;
  assert the `pattern`/`query`/`i` fallbacks resolve.
- **Smoke (manual):** `pnpm dev:api` + `pnpm dev:ui`, open a live session:
  - a burst of parallel reads shows one row each, `◆ read <path>` flipping to
    `✓ read <path>` in place — no bare `✓ read` rows;
  - a failing tool shows `✗`;
  - `grep`/`web_search` rows show their pattern/query, not a bare name;
  - reload the session (history path) → identical rows, bash result text intact.
- **KitGallery:** the three tool states render without a live backend.

## 7. Non-goals

- Enriching **live** result rows with tool output (blocked by the omp RPC
  contract; only success/failure is available live).
- Truncating or changing how large history result bodies (e.g. file contents)
  render — same information as today, just inside the merged block.
- Any change to RPC commands, session persistence, or worktree handling.
- Token-by-token streaming (Kermanych still batches at `message_end`).
