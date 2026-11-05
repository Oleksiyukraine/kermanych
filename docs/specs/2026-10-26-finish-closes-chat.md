# Completing a task closes its chat

## Goal

When the operator completes a task, the agent's chat pane should close too: there is nothing
left to do in it. Request: «Коли ми завершуємо задачу. Треба що вікно чату з агентом також
закривалось».

## Context

- The chat is the right-hand detail pane of `apps/ui/src/pages/AgentsPage.vue`
  (`<aside class="agents__detail">`). It shows the session whose id is
  `useOrchestrator().selectedSessionId`; closing it is `selectSession(undefined)` (the ✕ in its
  header).
- «Завершити» (`submitFinish`) calls `store.finishSession` → `POST /sessions/:id/finish`; the api
  sets the session to `merged` and echoes a `session_update` over the socket. The pane stayed
  open on the merged session. Archive and delete already closed it; finish did not.
- A merged discussion/review (`submitMerge`) also lands on `merged`; with a parent it already
  selects the parent.

## Decisions

- **Close on the transition to `merged`, in the store.** `reduce`'s `session_update` branch
  clears `selectedSessionId` when the selected session goes from any other status to `merged`.
  One rule covers every way a session completes: this window's «Завершити», a merged
  discussion/review, and a finish from another window on the same api.
  Rejected: closing only in `submitFinish` — misses the other sources.
- **Only on the transition.** Opening an already merged card from «Завершені» (to read it or
  «↻ Відновити») must still show the chat, so a later `session_update` that stays `merged` does
  not close it.
- `submitMerge` with a parent keeps selecting the parent: if the echo arrives first the pane
  is cleared and then the parent selected; if it arrives after, the parent is selected and the
  rule does not apply.

## Changes

- `apps/ui/src/stores/orchestrator.ts` — `reduce`, `session_update`: clear the selection on the
  `→ merged` edge of the selected session.
- `apps/ui/test/finish-closes-chat.spec.ts` — the selected session closing, another selected
  session staying open, an already merged session staying open.
- `README.md` — the «Status flows back» step says the pane closes.

## Verification

- `pnpm --filter @kermanych/ui exec vitest run test/finish-closes-chat.spec.ts` — 3 passed; with
  the store change stashed, «clears the selection when the open session becomes merged» fails.
- `pnpm --filter @kermanych/ui exec vitest run` — 64 files, 720 tests passed.
- `vue-tsc --noEmit` — no errors in the changed files (the remaining errors are pre-existing:
  unbuilt `@kermanych/api`, `test/runtime-messages.spec.ts`).
- Not exercised in the running app: the live preview was not running, and a real «Завершити»
  needs the api, a cloud login and retires a worktree.

## Documentation impact

- `kermanych/README.md` — «Status flows back»: a session landing on `merged` closes its chat pane.
