# Stale tests: `rpc-session.compact` (api) and the assigned-bytes warning (ui)

## Goal

On a clean checkout of the base, the full api and ui `vitest run` are red because of three
tests. Both spec files have to pass, and both suites have to be green.

## Context

Reproduced on `4c26688` (merge of PR #174) once the workspace packages are built
(`pnpm install`, `pnpm --filter "./packages/*" build`):

- api: 2 failed / 934 passed. Both failures are in `test/rpc-session.compact.spec.ts`.
- ui: 1 failed / 622 passed. The failure is in `test/assignments.spec.ts`.

In both cases the test is stale. Production code is correct.

### api: `rpc-session.compact.spec.ts`

- Once it sees `ready`, `RpcSession.start()` writes `negotiate_protocol` and then
  `set_subagent_subscription` (`apps/api/src/rpc/rpc-session.ts:96`, added in `0c3f520`). The
  second frame is sent unless `subagentSubscription` is `"off"`.
- The fake `omp` in the compact spec skips only `negotiate_protocol`. It records the
  subscription frame, so `sent` holds two frames and `subagent_sub` comes first.
- `/compact` (`dbb5ca2`) and the subagent subscription (`0c3f520`) landed on the same day
  from parallel branches. When they met, `rpc-session.thinking.spec.ts:37` was updated to skip
  both frames. The compact spec was not.

### ui: `assignments.spec.ts`

- The test «the byte warning clears both Kermanych defaults assigned at once» sums the body
  bytes of all of `DEFAULT_SKILLS` and asserts the total is below `ASSIGNED_BYTES_WARN`
  (8 KiB, `apps/ui/src/lib/settings.ts:206`).
- When the test was written (`e839d27`) the library held two defaults. It now holds nine
  (`kermanych-session` 1335, `kermanych-pull-request` 1521, `qa-tester` 993, `librarian` 595,
  `task-spec` 790, `task-plan` 584, `frontend-handoff` 810, `api-request` 803,
  `deep-analysis` 928), 8359 bytes in total.
- The test's comment and the `ASSIGNED_BYTES_WARN` doc comment both still say "both of
  Kermanych's own defaults". The test's intent is that an agent with the harness defaults
  assigned is not warned. The two harness defaults take 2856 bytes.

## Decisions

1. **api: change the test only.** The fake `omp` in `rpc-session.compact.spec.ts` skips
   `set_subagent_subscription` as well as `negotiate_protocol`, as the thinking spec does. The
   session keeps the production default subscription, so the test runs the real start-up
   path.
   - Rejected: passing `subagentSubscription: "off"`. It would move the test off the default
     launch path for no gain.
   - Rejected: filtering `sent` by `type === "compact"`. The bare-frame test would stop
     catching an extra command written by `compact()` itself.
2. **ui: restore the original intent (operator choice A).** The test picks
   `kermanych-session` and `kermanych-pull-request` from `DEFAULT_SKILLS` by name, asserts
   both exist, and asserts their combined body bytes are below `ASSIGNED_BYTES_WARN`. The test
   comment and the `ASSIGNED_BYTES_WARN` doc comment name these two harness skills instead of
   "both defaults". The threshold stays at 8 KiB.
   - Rejected (B): raising `ASSIGNED_BYTES_WARN`. It would have to rise again with every new
     default, and an ordinary block would stop being warned at all.
   - Rejected (C): shortening default skill bodies. That edits agent instructions to satisfy
     a test, and the next default would break it again.

## Changes

- `kermanych/apps/api/test/rpc-session.compact.spec.ts`: the fake `omp` skips
  `set_subagent_subscription`.
- `kermanych/apps/ui/test/assignments.spec.ts`: the byte-warning test, renamed «the byte
  warning clears both harness skills assigned at once», measures the two named harness
  defaults and fails if either of them leaves `DEFAULT_SKILLS`.
- `kermanych/apps/ui/src/lib/settings.ts`: the `ASSIGNED_BYTES_WARN` doc comment now names
  the two harness skills. Comment only, no behaviour change.

## Verification

- `pnpm --filter @kermanych/api exec vitest run test/rpc-session.compact.spec.ts`: 3 passed.
- `pnpm --filter @kermanych/ui exec vitest run test/assignments.spec.ts`: 13 passed.
- Full `vitest run` after the change: api 936 passed / 4 skipped, ui 623 passed, no failures.

## Documentation impact

None beyond this document. No command, endpoint, config key or user-facing flow changes.
