# Processes, memory and disk: what Kermanych leaves behind

- **Branch:** `feature/kermanych-process-memory-disk-cleanup`
- **Scope:** `apps/api` (rpc runtime, supervisor, chat pools, preview, runtime check, startup GC,
  child ledger), `apps/ui` (Electron main, orchestrator store and the pages that show a
  transcript), `kermanych/README.md`.
- **Plan:** `docs/plans/2026-11-09-process-memory-disk-cleanup.md`.

## Goal

An outside audit of a Kermanych that had run for 14.7 h (API heap 76 MB, 18 processes / ~3 GB RSS,
`~/.kermanych/worktrees` 4.5 GB, omp conversations 1.3 GB, Electron partitions 2.4 GB) found that
the normal path cleans up, but four things leak systematically: omp children are not waited for on
quit, nothing looks for orphans after a crash, transcripts stay in RAM (api and UI) until the
session is deleted, and nothing collects disk garbage at start. This change fixes the audit's
priority list (items 1–6 of «Що виправляти насамперед»).

## Context

- **Quit.** `before-quit` (`electron-main.ts`) awaited `nest.close()`, but
  `SupervisorService.onModuleDestroy` and `RpcChatPool.dropAll` fired `void rpc.stop()`.
  `RpcSession.stop()` ends stdin and arms SIGTERM at 1 s / SIGKILL at 4 s; `app.quit()` ran at once,
  so the timers died with the process and a child ignoring the EOF (mid-way through a long command)
  lived on. Each child's exit also ran `onExit` → `drainSlots()`, which could start a waiting
  session after the supervisor was destroyed, and marked a mid-turn row `error`.
- **Process groups.** omp was spawned without `detached`; the signals reached only omp, and its MCP
  servers, LSP and workers went to launchd. Previews and emulators already used groups
  (`kill(-pgid)`).
- **Crash.** No pid was written anywhere, so after a crash nobody stopped the omp children or the
  preview groups (`sh → pnpm → vite`, holding ports). Only device clones had a startup sweep.
- **`omp models`** in `runtime-check.service.ts` was raced against a timeout but never killed; the
  UI polls every 5 min.
- **`startChild`** (`supervisor.service.ts`) had no timeout: an omp that never sent `ready` held its
  agent slot and its `resuming` entry forever (`RpcChatPool` had a 30 s bound).
- **UI transcripts** (`stores/orchestrator.ts`): `transcript_append` created a transcript for every
  session the api broadcast about, never freed until `session_removed`. A session never opened
  thus got a partial log, `AgentsPage.vue` saw the key and skipped the history load — the operator
  saw a truncated log. A reconnect snapshot did not drop transcripts of deleted sessions.
- **API `Live`** keeps a session's whole rendered transcript for the life of the api; archiving did
  not release it.
- **Disk.** No startup GC: a crash between `addWorktree` and saving `worktreePath` left a row with
  `worktreePath: ""` (delete skips the tree, `branch -D` fails); leftovers in the legacy
  `~/.kermanych/worktrees/`; `$TMPDIR/kermanych-native/mcp-<id>.json` (bearer inside) never
  deleted; agent conversation files never deleted; partitions of deleted projects never deleted.

## Decisions

1. **Quit waits for the children, bounded.** `SupervisorService.onModuleDestroy` and the three pool
   owners (Менеджмент, ЦУК, schedules) became async and await `Promise.allSettled(stop())`.
   Electron races `nest.close()` against `QUIT_TIMEOUT_MS = 15 s`. A `destroyed` flag stops
   `drainSlots`, makes `startChild` refuse, and turns a child's exit (and a cut-short resume or
   deferred launch) into a no-op for the row: the row keeps its status and the next start wakes it
   as after a crash.
2. **omp leads its own process group** (`detached: true`); `stop()`'s SIGTERM/SIGKILL go to `-pid`.
   A clean EOF exit signals nothing; once the leader has exited only the group id is signalled, so a
   reused pid is never hit.
3. **Child ledger** (`runtime/child-ledger.ts`): every omp child and preview step is written to
   `<home>/children/<api pid>.json` with its `ps -o lstart` start time until it exits; the owner is
   recorded the same way. `bootstrap()` sweeps before Nest starts: for every file whose owner is no
   longer running (pid + start time), each recorded group whose pid and start time still match gets
   SIGTERM, then SIGKILL after 2 s. Installed only by `bootstrap()` (like the browser host), so specs
   record nothing. *Rejected:* a SQLite table — every spawn and exit would write the shared
   registry, and a crashed process's rows would need the same owner check anyway.
4. **`omp models` is killed on timeout**: the probe takes an `AbortSignal` and spawns with
   `{ signal, killSignal: "SIGKILL" }`.
5. **`startChild` is bounded at 60 s** with the chat pool's `omp_launch_timeout` code; every caller
   already stops the child in its catch.
6. **UI keeps only opened transcripts, at most 12 not on screen.** An append to an unloaded session
   is ignored (its bubble still settles); a snapshot drops transcripts and bubbles of sessions it no
   longer lists; past `TRANSCRIPT_CAP = 12` the least recently used transcript nothing holds is
   deleted. Pages that show a transcript hold it (`useHeldTranscript`). *Rejected:* stripping base64
   from the store — it needs an api endpoint for images; the cap bounds it instead.
7. **API: archiving releases the `Live`** (child stopped, transcript and tool details dropped);
   opening it again wakes it like any dormant session. *Rejected:* releasing it after the 15-minute
   reaper, as the audit suggested — every look at a finished session would then respawn omp (~300 MB)
   just to re-read its history, trading kilobytes of heap for a process.
8. **Startup GC** (`gc/startup-gc.service.ts`), awaited in `onModuleInit` so it ends before the api
   listens, skipped under `KERMANYCH_DB` (the `PreviewService.sweep` rule):
   - *adopt* — a row with `worktree`, no `worktreePath`, not `merged`, whose
     `worktreeDir(repo, branch)` is a registered tree on that branch, gets the path back;
   - *project trees* — `git worktree prune`, then remove a clean, unlocked tree only if it sits at
     `worktreeDir(repo, branch)` of a session row that no longer owns it (a finished session's
     leftover). `.gitworktree/` is shared with the operator and other tools, so an unreferenced
     tree Kermanych cannot prove it made is never touched. A dry run on the operator's real
     registry first flagged 17 such trees (folders like `client-populate` on
     `feature/client-price-resolution`); the rule was narrowed to this;
   - *legacy* `~/.kermanych/worktrees/<id>` not referenced by a row: no `.git` or a dangling gitdir →
     deleted; a clean linked tree → removed through its repo; dirty → kept;
   - `mcp-<id>.json` of sessions that are gone → deleted.
9. **Delete removes the conversation**: `deleteSession` deletes the row's `ompSessionFile` (any kind,
   not only forks), its subagents' folder beside it and the per-cwd folder once empty — only when the
   file itself existed. A native session's `mcp-<id>.json` goes too (`removeMcpConfig`).
10. **Partitions of deleted projects** are removed by Electron main after bootstrap
    (`knownProjectIds`, undefined under `KERMANYCH_DB`).

## Changes

- `apps/api/src/runtime/child-ledger.ts` (new), `runtime/process-group.ts` (new), `main.ts`
  (install + sweep, `knownProjectIds`).
- `rpc/rpc-session.ts`: `detached`, ledger add/remove, group signals in `stop()`.
- `assistant/rpc-chat-pool.ts`: `drop()` returns the stop, `dropAll()` async; `cuk`, `management`,
  `schedules` services await it.
- `supervisor/supervisor.service.ts`: `destroyed`, async `onModuleDestroy`, guarded `drainSlots` /
  `onExit` / resume / deferred launch, bounded `startChild`, archive releases the `Live`,
  `deleteSession` removes conversation files and the native MCP config.
- `runtime/runtime-check.service.ts`: abortable probe.
- `preview/preview.service.ts`: ledger add/remove per step.
- `native/native-hooks.ts`: `removeMcpConfig`.
- `gc/startup-gc.service.ts` (new, registered in `app.module.ts`); `worktree/worktree.service.ts`:
  `pruneWorktrees`, `listWorktrees`, `mainCheckout`.
- `apps/ui/src-electron/electron-main.ts`: quit cap, partition sweep.
- `apps/ui/src/stores/orchestrator.ts`, `composables/useHeldTranscript.ts` (new), `AgentsPage`,
  `ChatPage`, `DesignPage`, `SynergyPage`, `stores/voice.ts`.
- Tests: `test/child-ledger.spec.ts`, `test/startup-gc.spec.ts` (new), a group-kill case in
  `rpc-session.spec.ts`, a quitting case in `supervisor.slots.spec.ts`, UI
  `test/transcript-residency.spec.ts`.

## Verification

- `apps/api`: `pnpm exec tsc --noEmit -p tsconfig.json` clean; `pnpm exec vitest run --maxWorkers=4`
  → 133 files / 1396 tests passed.
- `apps/ui`: `pnpm run typecheck` (vue-tsc, includes `src-electron`) clean;
  `pnpm exec vitest run --maxWorkers=4` → 93 files / 1000 tests passed.
- Crash smoke: built api started on a temp home and DB, `kill -9`'d; a detached `/bin/sleep`
  written into its ledger file was stopped by the next start («stopping fake omp (pid …)»).
- Real omp: `RpcSession` against the installed `omp` → ready in 177 ms, pgid = pid, `stop()` in 85 ms,
  nothing left in the group.
- GC dry run against a copy of the operator's registry (removals stubbed): no project tree flagged
  after decision 8's narrowing; a read-only classification of `~/.kermanych/worktrees` shows the
  legacy step would delete the 5 unreferenced folders (3 dangling smoke-test trees, 2 without
  `.git`, < 40 KB) and keep the 5 referenced ones.

**Not verified:** a real quit of the desktop app mid-turn (the claim that omp no longer survives it
rests on the unit tests and the smoke above, not on a `ps` after ⌘Q); the partition sweep in a
running Electron; the UI cap's effect on the window's actual memory.

## Not in this change

From the audit, left for later: TTL for archived worktrees (1.8 GB here), branch cleanup after
merged PRs, idle stop for ЦУК/Менеджмент children, native TUIs, `waiting_input` sessions, previews
and emulators; SIGKILL escalation for native PTYs on quit; `adb logcat` race; Electron sessions of
tester runs; `finishSession` closing the session's `WebContentsView`; the `startFeed` race in
`jira.ts`/`plane.ts`; `HandedSkills` growth; scheduled-run session rows; `retireScheduledRun`
deleting uncommitted work; SQLite `wal_checkpoint`. Deleting the data already on disk by hand was
not done; the startup GC removes only what decision 8 allows.

## Documentation impact

`kermanych/README.md` — new «Processes and disk housekeeping» section (quit, crash sweep, startup
GC, delete/archive effects, UI transcript cap).
