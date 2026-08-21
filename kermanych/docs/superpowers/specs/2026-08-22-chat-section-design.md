# Chat section — informative rows with on-demand detail — design

Date: 2026-08-22
Status: approved (design; implementation plan pending)

## Problem

The chat panel is simultaneously too loud and uninformative. Both halves were
measured, not estimated, on the real session `improve-chat-icons-section`
(516 session entries, 178 tool results).

**Uninformative.** A tool row shows a glyph, the tool name and one string:
`toolCallSummary` (`packages/core/src/tool-summary.ts:6-16`) keeps the first hit
among `command|path|pattern|query|i` and discards the rest of the arguments. In
the live path the tool's *result* is discarded entirely — `onRpcEvent`'s
`tool_execution_end` branch (`apps/api/src/supervisor/supervisor.service.ts:641-644`)
reads only `isError`. Measured on a live session: 34 tool entries,
`maxSummaryLen` 185 chars, zero multi-line summaries. The panel cannot say what
`edit` changed, what `grep` found, or whom `task` dispatched.

**Loud.** After a reload the same session is rehydrated through
`apps/api/src/supervisor/messages-to-transcript.ts:48-53`, which *does* append
result text — into the same untyped `summary` string. Measured:
`maxSummaryLen` 49 051 chars; 199 491 chars of raw tool text across the session;
`.k-panel__log` `scrollHeight` 50 978 px for 271 blocks with no virtualization.
So the transcript is richer after a reload than while it streams, and the extra
richness arrives as an unstructured wall.

**Noise without facts.** 78 of those 271 blocks are separate `Думаю`
disclosures against 5 user messages. On a 20-row screenshot, 8 rows are empty
`▸ Думаю` toggles and 12 are tool rows without payload.

Two visible defects share the same root: the tool name lives in a flex child
with `word-break: break-word` (`apps/ui/src/components/kit/KLogBlock.vue:134-140,172-178`),
so `bash` wraps as `bas`/`h` and `grep` as `g`/`r`/`e`/`p`; and the
my-message stepper renders `-/N` instead of `1/N`.

**The data already arrives.** Captured from a live `omp --mode rpc` child
(omp 17.3.8): `tool_execution_start` carries `{toolName, toolCallId, args, intent}`
and `tool_execution_end` carries `{toolName, toolCallId, isError, result:{content, details}}`.
`RpcEvent` in `packages/core/src/types.ts:68` declares three of those five fields.
`message_end` carries `{model, provider, stopReason, duration, ttft, usage:{…, cost:{total}}}`;
`types.ts:66` types it `any` and nobody reads it. `notice` (`types.ts:70`) has no
handler at all. So the missing detail is plumbing, not a new capability.

Per-tool `details` observed in the real session:

| tool | fields | derived row fact |
|---|---|---|
| `edit` | `diff`, `op`, `path`, `firstChangedLine`, `oldText`, `newText` | `+7 −5` |
| `grep` | `matchCount`, `fileCount`, `fileMatches`, `truncated`, `displayContent` | `5 збігів / 3 ф` |
| `read` | `totalLines`, `fileSize`, `truncation`, `displayContent{text,lineNumbers}` | `13/145 ln` |
| `glob` | `fileCount`, `files`, `truncated` | `196 файлів` |
| `bash` | `wallTimeMs`, `exitCode`, `timeoutSeconds` | `1.0 с`, `exit 1` |
| `write` | `resolvedPath`, `xdev` | `+145 ln` |
| `todo` | `phases`, `op`, `completedTasks` | `3/7` |
| `hub` | `op`, `daemon`, `timedOut`, `state` | `start` |

`edit.details.diff` arrives pre-numbered (`-28|old`, `+28|new`, blank line =
hunk break) and `grep.details.displayContent` arrives pre-grouped by file with
`*` marking match lines, so both render without a parser.

## Approach

Server computes facts, client owns presentation.

`packages/core` gains pure per-tool reducers turning `details` into a short
`stat` string plus a classified, **already clamped** preview. The API reads what
already lands on stdin and clamps at the source; the full payload stays on the
API behind a REST call made only when the operator expands a row.

The clamp must happen in the API because `apps/api/src/ws/events.gateway.ts:22-24`
broadcasts every transcript event to every connected socket with no rooms and no
per-session subscription. Forwarding raw `details` would multiply 199 KB per
session by the number of open windows.

Measured effect on the same 43-event slice, same 558 px width: content height
drops from 21 347 px to 1 080 px (19.8×) while every fact becomes visible.
Mockup used to validate this: `/tmp/kmq-chat-mock/index.html` — throwaway, not
preserved; the measured numbers above are the durable part.

Rejected alternative: embedding omp's own renderer. `omp --export` ships a
284 326-char auto-generated bundle from `packages/collab-web/scripts/build-tool-views.ts`
that registers `omp-tool-view`, bundles React and needs `highlight.js` from a
CDN. omp on disk is a 113 MB compiled binary with no npm package, so the bundle
is obtainable only by scraping exported HTML; the file says `DO NOT EDIT` and the
payload contract is assigned by runtime glue (`data-key="tv1"`). It would also
import the density this design exists to remove.

## Requirements

1. Every tool row carries a result fact in a right-aligned `stat` column; no row
   spends a line without one.
2. The tool name occupies a fixed-width column and never wraps.
3. All detail is collapsed by default, including errors; a row click toggles a
   card. `розгорнути все` / `згорнути все` act on the whole block.
4. Cards are per-tool: `edit` renders a real diff with gutters; `grep` renders
   per-file counts then match lines; `read`/`write` render numbered content;
   `bash` renders command, output and `wall/timeout/exit`; `todo` renders the
   phase tree with `[ ] [/] [x] [-] [!]`.
5. Long lines inside `edit`/`write` cards wrap with a hanging indent. Clipping a
   diff in a 558 px panel hides the change itself.
6. Consecutive calls to the same read-like tool (`read`, `grep`, `glob`) coalesce
   into one row expanding to its members.
7. A reasoning chip appears only when the pause is >= 8 s; the chip expands to
   the full text. Sub-threshold reasoning stays in the transcript as data but
   renders no row until `розгорнути все`; its duration is still summed into the
   block summary.
8. A finished request block collapses to one row: the request text plus
   `<duration> · <tool calls> · <files touched> · <thinking> · <cost>`. The
   active block stays open. All five are derived in the UI from the block's own
   entries — duration from first/last `at`, tool calls by counting `tool`
   entries, files touched as distinct `target` values of `edit`/`write` rows,
   thinking as the sum of `assistant_thinking.ms`, cost as the sum of
   `turn.usage.cost`.
9. A Todos lane exists only while `todoPhases` is non-empty, showing
   `<done>/<total> · <phase> · <in-progress task>`.
10. A one-line status row never disappears: model, context %, accumulated cost,
    and the live action with its elapsed time.
11. Assistant prose is never truncated.
12. A live-streamed session and the same session after rehydration produce
    identical entries.
13. Full tool output travels only on explicit request, never over the socket.
14. Palette unchanged: the existing 12 tokens, radius 0, accent limited to the
    user strip, the live indicator and errors; `--k-diff` stays diff-only.

## Data model

`packages/core/src/types.ts` — replace `TranscriptEntry` (lines 40-47):

```ts
export type ToolStatus = "pending" | "ok" | "error";

export type ToolLine =
  | { t: "ctx";  n?: string; text: string }
  | { t: "add";  n?: string; text: string }
  | { t: "del";  n?: string; text: string }
  | { t: "hit";  n?: string; text: string }
  | { t: "head"; text: string }
  | { t: "gap" };

export interface ToolDetail {
  lines: ToolLine[];
  totalLines: number;
  truncatedUpstream?: boolean;
}

export interface TurnUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number; cost: number;
}

export type TranscriptEntry =
  | { kind: "user_text";          id: string; at: number; text: string; images?: string[] }
  | { kind: "assistant_text";     id: string; at: number; text: string }
  | { kind: "assistant_thinking"; id: string; at: number; text: string; ms?: number; tokens?: number }
  | { kind: "tool";               id: string; at: number; tool: string; status: ToolStatus;
                                  intent?: string; target?: string; stat?: string; detail?: ToolDetail }
  | { kind: "notice";             id: string; at: number; level: "info" | "warn" | "error"; text: string }
  | { kind: "turn";               id: string; at: number; model?: string; ms?: number; usage?: TurnUsage };
```

`id` and `at` on every variant: today text and thinking entries have neither, so
`WorkspacePage.vue:174` keys the list by array index and any non-append mutation
would mis-render.

`kind: "turn"` never renders. It is a ledger entry emitted per assistant
`message_end`, from which the UI derives block summaries and the status-line
cost. ~144 entries ≈ 14 KB per session against the 199 KB of raw text removed.
It is preferred over a side channel on `session_update` because it is rebuilt
identically from the omp session file, where `usage` sits on every message.

Read-coalescing is not a wire field — it is derived in the UI from consecutive
`tool` entries with the same name.

`ServerEvent` — `transcript_update` (`types.ts:81`) must carry the result:

```ts
| { type: "transcript_update"; sessionId: string; id: string;
    status: "ok" | "error"; stat?: string; detail?: ToolDetail; ms?: number }
```

`ms` is the wall time the API measured between `tool_execution_start` and
`tool_execution_end`. It is recorded for every tool, unlike `bash`'s
`details.wallTimeMs`, which only `bash` reports. `assistant_thinking.ms` and
`turn.ms` both come from `message_end.duration`.

## Per-tool display reducers

New `packages/core/src/tool-display.ts`, absorbing `tool-summary.ts`. Signature
`(args, details, content) => { target, stat, lines }`, pure, no I/O.

Preview clamp per tool: `edit` 14, `grep` 12, `read` 10, `write` 10, `bash` 10,
`todo` unclamped (the tree is short), default 8.

`target` is shortened for a narrow panel: paths to their last two segments with
the range preserved (`kit/KPanel.vue:576-625`); `grep` keeps the whole pattern
and only shortens the scope, because the pattern is the informative part;
`bash` keeps the command head to 34 chars.

Degenerate shapes are explicit, not incidental: `grep` with `details: {}` →
`0 збігів`; `read` of a directory (`isDirectory: true`) → `каталог`; unknown
tool → first 8 lines of `content` and no `stat`; non-text content blocks →
a single `head` line naming the block kind.

## API

`SupervisorService.onRpcEvent` (`supervisor.service.ts:607-658`):

- `tool_execution_start` — take `intent` from the frame (currently dropped) and
  `target` from the reducer; `status: 'pending'`.
- `tool_execution_end` — run the reducer over `result.details` + `result.content`;
  put the clamped preview in the entry, the full `ToolLine[]` in a per-session
  detail cache keyed by `toolCallId`; emit `transcript_update` with
  `status`, `stat`, `detail`.
- `message_end` role `assistant` — append a `turn` entry from `usage`, `model`,
  `duration`; accumulate `cost` and tokens on `Live.live` for the status line.
- `message_end` role `toolResult` — ignored; it duplicates `tool_execution_end`.
- `notice` — append a `notice` entry with a level. The frame is declared at
  `types.ts:70` and has no handler today.

Detail cache: 256 KB per call, 8 MB per session, FIFO eviction. Today the
in-memory transcript is unbounded, so this is a tightening.

New endpoint: `GET /sessions/:id/tools/:callId` → `{ lines: ToolLine[], totalLines }`;
cache miss → 410, surfaced in the UI as «вивід більше недоступний».

`messages-to-transcript.ts` runs the same reducers, which is what closes the
live-vs-rehydrated asymmetry.

Frame-level failures: `JSON.parse` and `ChunkReassembler` errors are currently
swallowed by a bare `return` (`apps/api/src/rpc/rpc-session.ts:90-93`). Add a
counter and a `warn` notice so silent loss becomes visible.

## UI

`KPanel.vue` grows two lanes between the log and the composer:

1. Header — unchanged.
2. Scrollback — request blocks; finished ones collapsed to one row.
3. Todos lane — only while `todoPhases` is non-empty. `todoPhases` and
   `contextPercent` already arrive via `refreshState`
   (`supervisor.service.ts:670-672`) and are already consumed by `activityOf`
   (`WorkspacePage.vue:606-613`), so this lane needs no API work.
4. Status row — `model · context% · cost` left, live action plus elapsed right.
5. Composer — unchanged.

`KLogBlock.vue` splits into a row renderer plus one card component per tool
family, so no file carries every tool's markup. Row geometry:

```
glyph(9px) · tool(44px, fixed) · target(flex, ellipsis) · stat(right) · chevron(10px)
```

The fixed `tool` column is the fix for `bas`/`h`. `stat` never wraps. Rows are
`white-space: nowrap` with ellipsis on `target` only.

The reasoning threshold (8 s) and the clamp constants live in one module so
density is tuned in one place.

Also fixed here: the my-message stepper label showing `-/N`.

## Verification

- `packages/core/test/tool-display.spec.ts` — fixtures are already captured:
  real `details` payloads from `improve-chat-icons-section` plus frames recorded
  from a live `omp --mode rpc` probe. Assert `stat` and line classification for
  the eight tools plus every degenerate shape listed above.
- `apps/api/test/supervisor.transcript.spec.ts` — replay a recorded frame
  sequence; assert entry order, `toolResult` de-duplication, clamping, detail
  cache limits and the `transcript_update` payload.
- Parity test — one session file through the live reducer path and through
  `messagesToTranscript` must yield identical entries.
- `apps/api/test/messages-to-transcript.spec.ts` — extend for the new shape.
- Smoke: open a running session; confirm each row carries a fact; click `edit`
  and read the diff; click `grep` and read per-file counts; confirm errors stay
  collapsed while showing `exit N`; confirm a finished block collapses to one
  row; confirm the status row keeps a live elapsed time; reload the app and
  confirm the rehydrated transcript is identical.

## Non-goals

- Streaming deltas into the log (`text_delta`/`thinking_delta` are buffered until
  `message_end` today). Stage 2.
- Subagent lane. omp defaults subagent forwarding to `off` and Kermanych never
  sends `set_subagent_subscription` — `grep` over `apps/api/src` and
  `packages/core/src` returns zero hits for it, for `subagent`, `usage` and
  `cost`. Enabling it is a new outbound command, so it is the natural cut line
  for stage 1. Stage 2.
- Embedding `omp-tool-view`; see Approach.
- Virtualizing the log. Collapsing finished blocks removes the pressure that
  made it urgent; revisit with measurements afterwards.
- Per-session socket rooms. Recorded as the reason the clamp lives in the API,
  not fixed here.
- Replacing the UI font. Recorded finding: `packages/tokens/src/fonts.css`
  imports `@fontsource/archivo/400.css`, whose only subsets are `latin`,
  `latin-ext` and `vietnamese` — Archivo ships no Cyrillic, so every Ukrainian
  glyph falls back to the system font while Latin renders in Archivo. JetBrains
  Mono does ship `cyrillic`. This affects chat prose most, but it is a
  typography decision for the whole app, not part of this change.
