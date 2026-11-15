# Faster assistant answers: pinned thinking effort, streamed replies, «Зупинити»

- **Date:** 2026-11-15
- **Branch:** `feature/speed-up-tsuk-answer-search`
- **Scope:** `apps/api` (`assistant/models.ts`, `assistant/rpc-chat-pool.ts`, `rpc/rpc-session.ts`,
  `runtime/agent-runtime.ts`, `runtime/one-shot.ts`, `cuk/cuk-chat.service.ts`,
  `management/management-chat.service.ts`, `slack/slack.service.ts`, `http/cuk.controller.ts`,
  `http/management.controller.ts`), `packages/core` (the stream frame types, the visible-prose
  helper), `apps/ui` (`lib/api.ts`, `stores/cuk-chat.ts`, `stores/management-chat.ts`,
  `components/assistant/AssistantComposer.vue`, `CukAssistant.vue`, `AssistantLauncher.vue`,
  `components/management/ManagementAssistant.vue`, i18n `uk` / `en`), `kermanych/README.md`.
  No cloud migration.
- **Status:** asked by the operator on 2026-11-15: «ЦУК довго шукає відповіді, чи можна це
  прискорити?». Decisions agreed in the deep-analysis interview the same day; awaiting approval.

## Goal

ЦУК answers simple requests in 3–7 s but explanatory ones («як працює прев'ю для мобільного?»,
«як увімкнути посіпаку?», a schedule with conditions) in 21–86 s, and the operator sees nothing but
«Думаю… N с» the whole time. Cut the wait itself, and make what is left visible: the answer appears
as it is written, the current step shows while the Менеджмент assistant uses its tools, and a turn
going the wrong way can be stopped.

## Context

### Where the time goes (measured)

- **13 real ЦУК turns** from omp transcripts (`~/.omp/agent/sessions/-/`, 2026-11-04 … 11-12):
  simple turns 3–7 s, 100–350 output tokens; slow turns 21–86 s, 1 200–5 300 output tokens of
  which the visible prose is 700–1 000 characters. The rest is model thinking.
- **Cause.** `cuk-chat.service.ts` launches omp with `model: FAST_MODEL` and `noTools`, but no
  `thinking`. omp then takes the operator's own `defaultThinkingLevel`, here `max` (32k budget):
  every ЦУК transcript records `thinkingLevel: "max"`. Decision 11 of
  `docs/specs/2026-11-04-cuk-control-console.md` pinned the fast model, not the effort.
- **Replay** of the real first turn «Як увімкнути посіпаку…» (contract + digest, ~20k tokens)
  through `omp --mode rpc --no-tools --model claude-sonnet-5`, omp 18.20.2:

  | `--thinking` | first text | whole turn | output tokens |
  |---|---|---|---|
  | `max` (today) | 53–56 s | 57–60 s | 4 400–5 100 |
  | `low` | 1.5–10 s | 6–13 s | 170–670 |
  | `off` | 1.4–1.7 s | ~7 s | 250–300 |

  «Відкрий налаштування проєкту» on the same prefix: 2.5–6.7 s at any level. omp starts in
  0.5–0.6 s; the ~20k-token prefill is read from the prompt cache after the first turn.
- **The same gap elsewhere.** `FAST_MODEL` also serves the Менеджмент documentation turns
  (`management-chat.service.ts`, the `#docs` child) and the Slack documentation bot
  (`slack.service.ts`, `runOneShot`). Neither pins `thinking`, so both inherit `max` too, though
  both answer from passages retrieved before the turn.
- **No streaming.** `RpcChatPool.drive` collects every omp frame (`text_delta` included) and
  resolves on `agent_end`; `POST /cuk/chat` and `POST /management/chat` return one JSON reply;
  `lib/api.ts` `post()` reads the whole body.
- **Transport.** `ws/events.gateway.ts` is an unauthenticated socket that broadcasts every
  supervisor event to every client. REST goes through `SupabaseAuthGuard`, and its errors carry
  `{ code, message, params }` the UI localizes (`ApiError`).
- **Actions** travel in the prose as ` ```kermanych-action ` fenced JSON; `parseActionBlocks`
  (`core/management-actions.ts`) cuts them out at the end of the turn.
- **Stopping.** `RpcSession` has no `abort`. Probe: `{"type":"abort"}` sent to `omp --mode rpc`
  mid-answer ends the turn at once (`message_end` with the partial text, then `agent_end`), and the
  next prompt in the same child answers normally.
- **Esc** in the assistant window closes it (`AssistantLauncher.vue` `onEscape`), after a Quasar
  dialog and an open notification entry.

## Decisions

1. **Pin the thinking effort at `low` for ЦУК.** `--thinking low` (2k budget) on the ЦУК child:
   the explanatory turn drops from ~60 s to ~10 s, and the model keeps a little room for schedule
   dates («завтра о 9», «через годину») and for telling two similar sessions apart.
   Rejected: `off` (fastest, but the riskiest for date arithmetic and ambiguous requests);
   `minimal` (not measured); a setting with `low` as default (a new knob nobody is expected to
   turn).
2. **The same pin for every `FAST_MODEL` answer.** `assistant/models.ts` gains
   `FAST_THINKING = "low"` beside `FAST_MODEL`; ЦУК, the Менеджмент documentation turns and the
   Slack documentation bot launch with both. Ordinary Менеджмент turns (code, Jira, risks) and
   agent sessions keep the operator's level: they reason over tools.
   Rejected: ЦУК only (the docs answers keep the same 30–60 s wait for the same reason); a
   separate task for the docs answers.
3. **Stream the reply of ЦУК and the Менеджмент assistant.** Both answer as they write. The
   Slack bot does not stream (Slack gets one message).
   Rejected: ЦУК only (the Менеджмент assistant runs on the same pool and has the longer turns);
   pinning the effort alone.
4. **NDJSON on the same `POST`.** `POST /cuk/chat` and `POST /management/chat` answer
   `application/x-ndjson`, one JSON object per line:
   - `{ "type": "delta", "text": "…" }` — prose as omp writes it; a new assistant message within
     the turn (after a tool call) starts with `"\n\n"`, as `readTurn` joins them;
   - `{ "type": "step", "tool": "grep", "target": "pricing" }` — a tool started (decision 6);
   - `{ "type": "reply", … }` — the last line on success: exactly today's `CukChatReply` /
     `ManagementChatReply`;
   - `{ "type": "error", "code", "message", "params" }` — the last line on failure after the
     stream opened. A failure before it opens (auth, validation, omp missing) stays an HTTP error
     as today.

   The frame types live in `packages/core`. The UI reads the body with `fetch` →
   `ReadableStream`, the same in the browser and in Electron. Auth, the guard and the per-user
   turn queue do not change.
   Rejected: the events socket (unauthenticated and broadcast to all; per-user rooms and socket
   auth would be new, and a dropped socket loses deltas while the request still waits); SSE
   (`EventSource` is `GET`-only without an auth header: two requests and per-turn state on the
   server).
5. **An action block being written is hidden behind «готую дію…».** A core helper turns the
   accumulated raw text into visible prose: complete action blocks cut, an unclosed
   ` ```kermanych-action ` cut from its fence to the end and replaced by a muted «готую дію…» line.
   On `reply` the entry's text becomes the parsed `text`, and the cards and result lines follow as
   today. Nothing runs before `reply`.
   Rejected: hiding silently (the text stands still for the seconds a block takes); streaming only
   the prose before the first block.
6. **The current tool step replaces «Думаю…» in the Менеджмент assistant.** On
   `tool_execution_start` the api sends a `step` frame; the UI shows the latest one only, with the
   seconds counter: «Шукаю в коді: `pricing` · 12 с», «Читаю `README.md`», «Звертаюся до Jira».
   The line goes once text arrives and comes back if another tool starts before more text. ЦУК has
   no tools and never sends one.
   Rejected: no step line (the longest turns stay a bare counter); a collapsible list of every
   step (a new component and transcript entry).
7. **A turn that breaks mid-answer keeps its prose, marked.** On an `error` frame after some text,
   the assistant entry stays with the visible prose (action blocks cut) and a «відповідь обірвано»
   mark; the error line follows as today; no actions run. A request the UI itself drops (page
   reload) is unchanged: the turn finishes in the child and its reply is lost.
   Rejected: dropping the partial text (what the operator was reading vanishes); keeping it
   unmarked (reads as complete).
8. **«Зупинити» stops the turn in flight.** While a turn runs, the composer's send disc becomes
   «■» (tooltip «Зупинити (Esc)»). It calls `POST /cuk/chat/stop` or `POST /management/chat/stop`
   (the Менеджмент one with the conversation id), which sends omp `{"type":"abort"}` to that
   conversation's child — `AgentRuntime.abort()`, new in `RpcSession`. The turn ends with its
   partial text: the stream closes with `reply`, the entry carries a «зупинено» mark, and no
   action from it runs, even a complete block. The child and the conversation stay; the next
   question goes to the same child. Stop with no turn in flight is a no-op.
   Rejected: no stop in this task.
9. **Esc stops the expanded panel's turn first.** Order in the window: Quasar dialog → open
   notification entry → a turn in flight in the expanded panel stops → the window closes. A turn
   in the folded panel is not stopped by Esc. The Менеджмент dock on its tab stops its own turn on
   Esc while focus is inside the dock.
   Rejected: Esc only with focus in the field (the field is locked during a turn, focus is rarely
   there); a separate shortcut.

## Defaults not raised in the interview

- **«Думаю… N с»** stays until the first `delta` or `step`; the mascot «thinks» for the whole turn
  as today.
- **The streamed entry** is the same assistant bubble that `reply` completes; the meta line (model,
  spend, seconds) appears with `reply`. Auto-scroll follows the growing text while the log is
  scrolled to the bottom.
- **Step labels** map `read` / `grep` / `glob` and the tracker tools to phrases in i18n; an
  unknown tool shows its bare name. `target` is the path or pattern, cut to 80 characters.
- **The turn timeout** stays 120 s for ЦУК and as is for Менеджмент; it now ends a stream with an
  `error` frame instead of an HTTP error once text was sent.
- **The Менеджмент window panel and the dock** show the same conversation, so both render the
  stream; «■» shows in whichever composer is visible.

## Implementation order

1. Measure quality before switching: replay the ЦУК templates (all five groups) and the slow
   transcript turns at `max` and `low`, and two Менеджмент documentation questions the same way;
   compare actions and answers. A regression goes back to the operator before step 2.
2. `FAST_THINKING` and its use in ЦУК, the docs child and Slack (`runOneShot` gains `thinking`).
3. core: stream frame types, the visible-prose helper.
4. api: `RpcSession.abort()` / `AgentRuntime.abort`; `RpcChatPool.drive` takes an `onFrame`
   sink for `delta` / `step`; the services pass it through; the controllers write NDJSON and
   expose `chat/stop`.
5. ui: a streaming `post` in `lib/api.ts`; both stores grow the entry from deltas, keep the step,
   mark broken / stopped entries; the composer's «■»; Esc in `AssistantLauncher.vue` and the dock.
6. Docs.

## Verification

- core unit tests: the visible-prose helper (no block, a complete block, an unclosed block, a
  fence split across deltas, two blocks).
- api: the controllers stream `delta` … `reply` for a fake runtime; an `error` frame after text;
  `chat/stop` sends `abort` and the stream ends with `reply` and no actions; the ЦУК, docs and
  Slack launches carry `thinking: "low"`, ordinary Менеджмент launches do not.
- Live preview against a real omp: ЦУК's explanatory question shows text within a few seconds and
  finishes near the replay figures; an action request shows «готую дію…» then the card; Esc
  mid-answer stops it, a second Esc closes the window; a Менеджмент code question shows step lines,
  then text.
- Re-run the replay script at the end and record the figures here.

## Documentation

`kermanych/README.md`: the ЦУК section says answers stream, can be stopped with «■» / Esc, and run
on `claude-sonnet-5` with low thinking effort; the Менеджмент assistant section gets streaming, the
step line and «Зупинити». `docs/specs/2026-11-04-cuk-control-console.md` decision 11 gains a
pointer to this spec for the effort pin.
