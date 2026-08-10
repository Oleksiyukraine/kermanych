# Kermanych — Chat Transcript Rendering & Navigation (Design)

- **Status:** Draft for review
- **Date:** 2026-08-10
- **Scope:** `apps/ui` (KLogBlock, KPanel), `apps/api` (supervisor), `packages/core` (types)

## 1. Purpose

Improve how the session transcript reads, bringing it closer to the original
`omp` terminal experience, while addressing three concrete asks:

1. **Rich assistant text** — render assistant prose as Markdown instead of raw
   pre-wrapped text.
2. **Collapsed "Думаю" reasoning** — surface the model's thinking as a
   collapsed, expandable block (never a long noisy dump), plus a live
   "Думаю…" placeholder while the agent is thinking.
3. **Navigate my own messages** — a floating prev/next stepper to jump between
   the operator's `user_text` messages in the log.

This is UI/rendering polish over the existing orchestration shell. No change to
session lifecycle, RPC command surface, or persistence.

## 2. Current state (as-is)

- `KLogBlock.vue` renders each `TranscriptEntry` kind flush-left. `assistant_text`
  is split into lines and rendered as plain `<div>`s with `white-space: pre-wrap`
  — **no Markdown**. Fonts/tokens: UI font `--k-font-ui` (Archivo), mono
  `--k-font-mono` (JetBrains Mono); green `--k-diff` is reserved **only** for
  diff striping; `--k-accent` is the single accent; radius 0 everywhere.
- `assistant_thinking` kind exists in `TranscriptEntry`, is rendered by
  `KLogBlock` (muted italic) and demoed in `KitGalleryPage`, but the backend
  **never emits it** — `supervisor.service.ts` deliberately drops thinking
  (comment: "Thinking parts are omitted, matching the live log"). Only
  `text_delta` is buffered; `thinking_delta` is ignored.
- `KPanel.vue` owns the scrollable log (`logEl`) and stick-to-bottom auto-scroll.
  There is **no** way to jump between the operator's messages.

## 3. Key finding: reasoning is available end to end

Verified against the installed `omp` v17.2.12 binary and `omp://rpc.md`:

- **Live stream:** `message_update.assistantMessageEvent` carries
  `{ type: "thinking_delta", delta: string, partial: string }` — the same shape
  as the already-handled `text_delta`. Reasoning is simply ignored today.
- **Resume / history:** `get_messages` returns canonical `AgentMessage` content
  parts; a reasoning part is `{ type: "thinking", thinking: string }` (alongside
  `text`, `toolCall`, `image`). Note the field is `thinking`, not `text`.

So option B (collapsed-but-expandable reasoning) is implementable for both the
live path and the resumed-session path with no new RPC surface.

## 4. Design

### 4.1 Markdown rendering (assistant text)

- Add `markdown-it` to `apps/ui` with `{ html: false, linkify: true }`. With
  `html: false`, raw HTML in the source is escaped, so the rendered output is a
  controlled tag set and is safe to inject via `v-html`.
- `KLogBlock` `assistant_text` branch renders `md.render(entry.text)` into a
  `.k-log__markdown` container. Styling maps to design tokens:
  - Headings / bold / italic / lists / blockquotes / tables: UI font, primary
    text.
  - Inline code and fenced code: JetBrains Mono on `--k-surface2`, horizontal
    scroll for long lines, radius 0.
  - Links: `--k-accent`, used sparingly (link text only).
- **No syntax highlighting.** A multi-color highlighter conflicts with the
  restrained palette (one accent; green reserved for diffs). Code blocks render
  as plain mono on a surface background.
- Unchanged: `user_text` stays plain (`white-space: pre-wrap`) so operator input
  reads distinct from model output; `notice` stays muted plain; `tool_call` /
  `tool_result` keep mono rendering and diff striping (the sole green usage).
- Markdown is also used to render **expanded** reasoning (§4.2), muted.

Rendering a shared `markdown-it` instance (module singleton) avoids per-entry
allocation.

### 4.2 Collapsed "Думаю" reasoning (option B)

**Backend — `apps/api/src/supervisor/supervisor.service.ts`:**

- Add a `thinkBuf` to the per-session `Live` state, mirroring `textBuf`.
- In `onRpcEvent`, when `assistantMessageEvent.type === "thinking_delta"`,
  append `delta` to `thinkBuf`.
- On `message_end`, flush `thinkBuf` as
  `{ kind: "assistant_thinking", text }` **before** the `assistant_text` flush
  (thinking precedes the answer within a message), then reset `thinkBuf`.
- In `messagesToTranscript` (resume path), map a
  `{ type: "thinking", thinking }` part to
  `{ kind: "assistant_thinking", text: p.thinking }`, preserving in-message
  order. Remove the "thinking parts are omitted" comment.
- `packages/core` `OmpPart` gains an optional `thinking?: string` field.
  `TranscriptEntry.assistant_thinking` already exists — no type change there.

**Frontend — `KLogBlock.vue`:**

- `assistant_thinking` renders as a disclosure: a muted header row
  `▸ Думаю` (rotates to `▾` when open). **Collapsed by default** (local
  component state). Expanding reveals the full reasoning rendered with the same
  Markdown pipeline, in muted color.

**Live placeholder — `KPanel.vue`:**

- While `session.status === 'thinking'`, show a subtle animated `Думаю…` row at
  the bottom of the log (driven by status, not a transcript entry). It
  disappears on `message_end`, leaving the collapsed block above the answer.
- Consistency note: Kermanych already does not stream `assistant_text` token by
  token — it appears whole at `message_end`. Reasoning behaves identically, so
  there is no noisy live "thinking dump"; only a tidy collapsed block plus the
  transient placeholder.

### 4.3 Navigate operator messages

- Floating vertical stepper pinned to the log's top-right corner: **▲**
  (previous) / **▼** (next) buttons plus a small position counter (e.g. `3/7`).
  Hidden when fewer than 2 `user_text` messages exist.
- Clicking scrolls the log smoothly to the target `user_text` block and briefly
  highlights it.
- Implemented locally in `KPanel.vue` (which already owns `logEl` and scroll
  logic). Targets are found via
  `logEl.querySelectorAll('.k-log--user_text')` — the class is already produced
  from `entry.kind`, so no prop drilling is needed.
- **Keyboard `Alt+↑ / Alt+↓`** bound while the panel is focused, mirroring the
  buttons.

## 5. Isolation / boundaries

- **`KLogBlock`** — pure presenter of one `TranscriptEntry`; gains Markdown
  rendering and the reasoning disclosure. No store or socket coupling.
- **`KPanel`** — owns log scroll + the new navigation stepper and live
  placeholder; reads only `session.status` and DOM inside `logEl`.
- **`supervisor.service`** — the only place that maps RPC events / history into
  `TranscriptEntry`; reasoning capture is additive and mirrors existing text
  handling.
- **`packages/core`** — one additive field (`OmpPart.thinking`).

## 6. Verification

- **Backend unit (vitest, `apps/api`):** `messagesToTranscript` maps a
  `{ role:"assistant", content:[{type:"thinking",thinking},{type:"text",text}] }`
  message to `assistant_thinking` then `assistant_text`, in order. This defends
  the new resume-path contract.
- **Smoke (manual):** run `pnpm dev:api` + `pnpm dev:ui`, open a session:
  - assistant messages with Markdown (headings, lists, code fences) render
    formatted;
  - a `Думаю…` placeholder shows while thinking, then a collapsed `▸ Думаю`
    block appears above the answer and expands on click;
  - the ▲/▼ stepper and `Alt+↑/↓` jump between operator messages with highlight.
- **KitGalleryPage:** already includes an `assistant_thinking` sample; verify the
  collapsed rendering there without a live backend.

## 7. Non-goals

- Token-by-token live streaming of assistant text or reasoning (Kermanych
  batches at `message_end`; unchanged).
- Syntax highlighting of code blocks.
- Markdown rendering of `user_text` / `notice`.
- Any change to RPC commands, session persistence, or worktree handling.
