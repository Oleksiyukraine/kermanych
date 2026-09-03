# claude-code runtime — Increment 1 smoke findings (2026-09-03)

Plan: `2026-09-03-claude-code-runtime-increment-1.md` · Branch: `feature/claude-code-runtime`

## Result: core live integration VALIDATED

A minimal live smoke drove `ClaudeCodeRuntime` against the installed `claude` CLI
(v2.1.206, stored OAuth):

- `start()` resolves in ~5 ms; one prompt produced RpcEvents:
  `ready → message_start → message_update → message_end → agent_end`.
- Assistant text extracted correctly (`"ok"`); `getState()` reported model
  `anthropic/claude-opus-5` + a `sessionId`; `stop()` was clean (no error exit).

The transcript shape is identical to omp's — the decision to reuse the `RpcEvent`
contract works end-to-end against the real SDK.

## Defects found and fixed during the slice

1. **InputQueue.close() spurious `undefined`** — the pushable input generator
   yielded a bogus `undefined` into the SDK prompt stream on `stop()`, which could
   mis-report a normal stop as an error. Fixed: the iterator honors
   `IteratorResult.done` (commit `486d746`).
2. **start() deadlock** — `start()` awaited the mapped `ready`, but the SDK emits
   `system/init` only AFTER the first input message, which the caller sends only
   after `start()` resolves. Fixed: `start()` resolves once the query and drain
   loop are attached; every event (incl. `ready`) still flows via `onEvent`
   (commit `01f205d`). Confirmed by the passing live smoke.

## Risk areas (plan §9)

1. **Live effort change** — NOT exercised (needs a multi-turn in-app session).
   `thinkingLevel` reads back correctly; mid-session change is coarse
   (`setMaxThinkingTokens`) as designed.
2. **todoPhases / context%** — `query.getContextUsage()` did not populate a percent
   in the single-turn smoke (best-effort; no percent shown). `todoPhases` are not
   derived this increment (Increment 3). Neither breaks the flow.
3. **resume-rehydrate** — `getAllMessages()` returns `[]` by design this increment;
   a resumed claude session continues but its prior transcript is not rehydrated.
   Increment-4 decision: read claude's session JSONL vs. persist our own transcript.

## SDK notes confirmed against the install

- `@anthropic-ai/claude-agent-sdk` `^0.3.259`; the `claude` CLI is a SEPARATE
  install (present at `/opt/homebrew/bin/claude`, v2.1.206), NOT bundled.
- Streaming `query()` emits `system/init` only after the first input message —
  this drove the `start()` fix.
- Non-interactive auth works via stored OAuth (`~/.claude`); no env token needed
  on this machine.

## Remaining for the operator (full-app UI smoke — needs Supabase sign-in)

Run `KERMANYCH_RUNTIME=claude-code pnpm dev:app`, sign in, bind a project, then
create and run an agent task and confirm on the board/composer that the streamed
transcript and tool rows render as with omp, and that follow-up, steer, stop, and
resume behave. This needs your GitHub/Supabase sign-in, so it is yours to run; the
adapter itself is validated above.
