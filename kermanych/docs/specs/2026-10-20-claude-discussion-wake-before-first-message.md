# A claude discussion branch keeps the parent's conversation when woken before its first message

## Goal

A discussion branch («гілка: …») forked off a claude-code agent loses everything if its
child is reaped, the api restarts, or it is restarted before the operator sends anything: the
wake spawns a blank claude session and broadcasts an empty transcript. After the fix the
woken branch shows the parent's transcript, and its first message continues with the
parent's context.

While in `doResume`, two neighbouring defects with the same root cause (the child row does
not carry its launch shape) are fixed too, by operator decision: woken discussion/review
children get their tool restriction back, and they wake in the parent's directory.

## Context

- `branchSession` (`apps/api/src/supervisor/supervisor.service.ts:973-1033`) forks with
  `fork: <parent ompSessionId>` → SDK `resume + forkSession: true`, in the parent's
  directory (`parent.worktreePath || localRepoPath`), with `noTools: true`, and settles the
  child at `done`. The SDK mints the fork's own id only on its first turn, so the child row's
  `ompSessionId` stays empty (`claude-code-runtime.ts:86-88`); until then
  `getAllMessages()` reads the parent's history through `opts.fork` (`:251-255`).
- `reapIdleChildren` (`:330`) stops a `done` child after `CHILD_IDLE_TTL_MS` (15 min). The
  next send/wake/restart goes through `liveOrResume`/`resumeSession` → `doResume`.
- `doResume` (`:2528-2588`) reads `resumeHandle = s.ompSessionId` for claude. Empty → no
  `resume`, no `rehydrate`, and `transcript_reset` broadcasts an empty transcript: the bug.
- `doResume` restricts tools only for `chat` (`:2547`). A woken discussion (created with
  `noTools`, `:1010`) or review (created with `read/grep/glob`, `:1074`) gets the backend's
  full toolset in the parent's tree.
- Discussion/review rows have `worktreePath: ""`, so `doResume` (`:2534`) wakes them in the
  project root, not in the parent's worktree they were created in (`:995`, `:2046`). omp
  children then read the wrong tree (a review audits the wrong code); claude stores sessions
  per cwd (`~/.claude/projects/<cwd>`), so a claude fork needs the parent's cwd to find the
  parent session.
- `reviewSession` does not fork: it starts a fresh session and prompts it immediately, so a
  review always has its own id. The empty-transcript bug is discussion-only.

## Decisions

1. **Re-fork from the parent on wake (option A).** In `doResume`, a `claude-code`
   `discussion` row with no `ompSessionId` is relaunched with `fork: <parent ompSessionId>`
   instead of `resume`, then rehydrated from `getAllMessages()` (which reads the parent's
   history through `opts.fork`), exactly as `branchSession` does. Once the operator sends the
   first message, `refreshState` stores the fork's own id and later wakes take the existing
   plain-resume path.
   - Accepted tradeoff: if the parent took more turns between branching and the wake, the
     branch reopens from the parent's newer state, not the branching point.
   - Rejected: B — minting the fork id up front via `Options.sessionId` + `forkSession`;
     depends on the SDK persisting the session file before the first turn, unverified.
     Rejected: A + fork-point truncation (`resumeSessionAt`) — more SDK surface for a rare
     case on a read-only branch.
2. **Parent mid-turn → refuse.** If the parent's live state is `thinking`/`tool` when a
   re-fork is needed, `doResume` throws «wait for the agent to finish its turn» (the
   `branchSession` wording) **before** spawning anything, so the branch row is not flipped to
   `error`. Rejected: fork anyway (half a turn, possibly an unpaired `tool_use`); wait for the
   turn to end (hanging request, timeout handling).
3. **Tool restriction by kind on every wake.** `doResume` launches `discussion` with
   `noTools: true`, `review` with `read/grep/glob`, `chat` with `CHAT_TOOLS` (unchanged), on
   both backends and whether or not the row has its own id. One source of these per-kind
   restrictions, used by `branchSession`, `reviewSession` and `doResume`, so they cannot
   drift again.
4. **Wake directory from the parent.** `doResume` wakes `discussion`/`review` rows in
   `parent.worktreePath || project.localRepoPath` — the directory they were created in. A
   parent always exists (deleting a parent cascades to its branches, `:1974`). If the
   parent's worktree was retired after a merge (`worktreePath` cleared), the fallback is the
   project root, as today.
5. Unchanged: status after wake rests at `done`/`in_review`; no browser MCP for forks;
   effort re-assertion; omp discussion wake (already has `ompSessionFile` from `refreshState`).

## Changes

- `apps/api/src/supervisor/supervisor.service.ts`
  - per-kind launch tool restriction helper; used in `branchSession`, `reviewSession`,
    `doResume`.
  - `doResume`: parent lookup for `discussion`/`review` → wake `dir`; claude discussion with
    no own id → parent-mid-turn guard, `fork: parent.ompSessionId`, rehydrate.
- `apps/api/test/supervisor.resume.spec.ts`: regression tests (below).

## Verification

- Regression tests in `supervisor.resume.spec.ts` (fake runtimes, launch opts captured):
  - claude discussion with no own id, woken → launched with `fork = parent id`, `noTools`,
    cwd = parent's worktree, transcript rehydrated (not empty);
  - same while the parent is `thinking` → rejects, no runtime spawned, row not `error`;
  - claude discussion with its own id → plain `resume` of its own id (unchanged path), with
    `noTools` and the parent's cwd;
  - woken omp discussion → `noTools`; woken review → `read/grep/glob`, parent's cwd;
  - parent worktree retired → project root.
- `pnpm --filter @kermanych/api typecheck` and the api test suite.
- Smoke against the real claude SDK (no model call needed): fork a real claude session with
  `ClaudeCodeRuntime({ fork, noTools: true, cwd: <parent cwd> })`, stop it without a prompt,
  re-fork the same way, and check `getAllMessages()` returns the parent's history — the
  wake path end to end. Throwaway script, removed afterwards.

## Documentation impact

None in `README.md`: it does not describe how discussion/review branches wake, their tool
sets or their directory; the fix restores the launch-time behaviour after a wake. This spec
is the record.
