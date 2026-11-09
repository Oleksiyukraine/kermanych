# Plan: processes, memory and disk cleanup

Spec: `docs/specs/2026-11-09-process-memory-disk-cleanup.md`.

## Steps

- [x] **1. Quit waits for omp children.** `supervisor.service.ts` (`destroyed`, async
  `onModuleDestroy`, guards in `drainSlots`, `onExit`, `doResume`, `deferredLaunch`, `startChild`),
  `assistant/rpc-chat-pool.ts`, `cuk/cuk-chat.service.ts`, `management/management-chat.service.ts`,
  `schedules/schedule.service.ts`, `src-electron/electron-main.ts` (15 s cap).
  *Verify:* `test/supervisor.slots.spec.ts` «quitting».
- [x] **2. omp in its own process group.** `rpc/rpc-session.ts`, `runtime/process-group.ts`.
  *Verify:* `test/rpc-session.spec.ts` «a stop that has to signal reaches what the child started»;
  real-omp smoke.
- [x] **3. Child ledger + crash sweep.** `runtime/child-ledger.ts`, `main.ts`, `rpc-session.ts`,
  `preview/preview.service.ts`. *Verify:* `test/child-ledger.spec.ts`; built-api `kill -9` smoke.
- [x] **4. Transcripts in RAM.** UI `stores/orchestrator.ts`, `composables/useHeldTranscript.ts`,
  the four pages, `stores/voice.ts`; api `setArchived`. *Verify:* `test/transcript-residency.spec.ts`,
  `test/supervisor.discard.spec.ts`.
- [x] **5. Bounded probes.** `runtime/runtime-check.service.ts` (abort kills `omp models`),
  `startChild` 60 s. *Verify:* `test/runtime-check.spec.ts`, full api suite.
- [x] **6. Startup GC and delete cleanup.** `gc/startup-gc.service.ts`, `app.module.ts`,
  `worktree/worktree.service.ts`, `native/native-hooks.ts`, `deleteSession`, Electron partition
  sweep. *Verify:* `test/startup-gc.spec.ts`; dry run on a copy of the real registry.
- [x] **7. Docs.** `kermanych/README.md`, this plan, the spec.

## Risks and order

- The startup GC deletes files: it runs only on the machine's own registry (not under
  `KERMANYCH_DB`), never deletes uncommitted work, and touches a `.gitworktree/` tree only when a
  session row proves Kermanych made it.
- `detached` omp children no longer receive the terminal's SIGINT in `pnpm dev:api`; the api's
  shutdown hooks stop them instead, and the ledger covers a hard kill.
- No migration; the ledger folder `~/.kermanych/children/` is created on first start.
