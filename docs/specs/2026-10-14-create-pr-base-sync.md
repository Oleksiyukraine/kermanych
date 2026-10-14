# «Створити ПР» brings the base in first; sessions fork from the fresh base

## Goal

The operator (session `create-pr-impruvements`, 2026-10-14) often opens a pull request with
«Створити ПР» and then finds a merge conflict on GitHub. The pull-request flow must leave a branch
that merges cleanly into its base. When it cannot, Kermanych must say so before GitHub does.

## Context

- «Завершити» → «Створити ПР» (`SupervisorService.createPullRequest`) hands the session's own
  agent the `pull-request` instruction (`packages/core/src/agents.ts`): commit, push,
  `gh pr create`. «Закоміти» (`commitChanges`, instruction `commit`) commits and pushes onto an
  open PR. Neither brings the base in, and nothing checks that the PR can merge.
- A worktree session forks from the LOCAL `<base>` without a fetch (`resolveLaunchParams` →
  `launch` → `git worktree add -b <branch> <wt> <base>`). This session forked from local `dev`
  at `d0405df` while `origin/dev` was 4 commits ahead (PR #153).
- Until 2026-09-04 «Завершити» merged `origin/<base>` into the worktree first (`1472d7d`), set
  the session to `conflict` on a conflict and offered «Вирішити автоматично». `2de23cc` made the
  PR the only delivery path and removed that merge, with nothing in its place in the PR flow.
  Nothing sets `conflict` since, though the sidebar's red dot, the «Помилки» bucket,
  notifications and the finish sheet's conflict view still handle it.
- History 2026-08-10 → 2026-10-13: 19 of ~152 merged PRs needed `dev` merged into the branch.
  Re-running each of those merges (`git merge-tree`, git 2.54) conflicts in all 19. By commit
  time, in 13 every `dev` commit the merge brought in predates the branch's last commit, so a
  sync right before the push would have caught them; 5 are mixed; 1 conflicted only on commits
  that landed after the PR was opened. Median 2 conflict hunks; 11 of 19 have 1–2; the largest
  have 7, 13 and 16 hunks over 4–9 files.
- Counts and diffs against the base use the local `<base>` (`finishInfo`, `docsGate`, `fileDiff`,
  `WorktreeService.changedFiles` / `aheadCount`). `reviewSession` uses whatever branch the project
  checkout is on (`supervisor.service.ts:987`). Once the branch contains an `origin/<base>` newer
  than the local one, teammates' files appear as the session's changes (reproduced on a
  throwaway repository).
- The api's network git calls (the footer's fetch and pull, `worktree.service.ts:386-411`) use the
  machine's credentials with `GIT_TERMINAL_PROMPT=0`. `GIT_TOKEN` lives in the bound folder's
  `.env`, is copied into every worktree, and only the agent reads it.
- The first `git` on this machine's `PATH` is 2.33.0, so `git merge-tree --write-tree` (2.38+) is
  not available for predicting conflicts in the api.
- The default skill bodies total 8164 bytes against the 8192-byte `ASSIGNED_BYTES_WARN` that
  `apps/ui/test/assignments.spec.ts` pins.

## Decisions

Settled with the operator one question at a time.

1. **Scope: the PR flow, the commit flow and the fork.** «Створити ПР» and «Закоміти» bring the
   latest `origin/<base>` into the branch before they push, and a new worktree session forks from
   the fresh base. «Закоміти» on an open PR becomes the one-click update for a PR whose base
   moved. Rejected: watching open PRs for conflicts that appear later. It needs polling, network,
   a token, a new card state, and either a GitHub-only API (Kermanych also recognises GitLab and
   Bitbucket PR links) or local prediction that needs git 2.38+, for 1 case in 19. A separate
   task if it is ever needed.
2. **The agent brings the base in, by merge, in the same turn.** Rejected: the api merging before
   the prompt. It cannot use `GIT_TOKEN` (decision 7). It cannot commit loose work without
   breaking the commit conventions, and git refuses to merge over overlapping uncommitted
   changes, so the agent path would be needed anyway. It cannot run checks after the merge either.
   Rejected: rebase. `kermanych-session` forbids rewriting the session branch, an open PR would
   need a force-push over reviewed history, and the team already merges
   (`Merge branch 'dev' into …`).
3. **The agent resolves conflicts and finishes.** It combines both sides, commits the merge with
   the Kermanych co-author trailer, runs the project's checks for what the merge touched, and
   fixes a failure caused by the two sides meeting in a separate commit (a failure already on the
   base is reported, not fixed). Then it pushes and opens or updates the PR. It stops only when
   both sides changed the same behaviour incompatibly and choosing is a product decision: the
   merge stays unfinished, and the agent names the files and asks. The PR request stays armed,
   so the card still lands on «На ревʼю» once the operator answers and the agent finishes.
   «Вирішити автоматично» is unchanged: it only completes the merge, and «Створити ПР» /
   «Закоміти» is pressed again after it. Rejected: stopping on any conflict, or resolving but
   waiting for approval before the push. Both add a second click to nearly every PR that fell
   behind, since all 19 historical merges conflicted. Rejected: a hunk-count threshold, because
   size does not tell whether the resolution is unambiguous.
4. **A new worktree session forks from the fresher base.** Before `git worktree add` the api runs
   `git fetch origin <base>` (decision 7's credentials, 15 s timeout, serialised with the
   footer's fetch of the same repository). If `origin/<base>` contains the local `<base>` (the
   local one is behind or equal), the branch forks from `origin/<base>` with `--no-track`.
   Without it, git sets the session branch's upstream to `origin/<base>`, and `git status` /
   `pull` in the session look there. If the local `<base>` is ahead or the two diverged, the
   branch forks from the local one, as today; the sync before the PR closes the gap. Rejected:
   always `origin/<base>`, which hides local base commits the operator meant the agent to see.
   Rejected: fast-forwarding the local `<base>` first. It is usually checked out in the
   operator's folder, so that is a pull in their working tree.
   - The fetch failed (offline, credentials): the same rule over the last-known `origin/<base>`,
     plus a transcript notice that the base may not be the latest. «origin has no such branch» is
     not a failure.
   - No `origin` remote, or `<base>` not on origin: as today, no notice.
   - No base picked and no project default branch: the base is the branch the project checkout is
     on at launch, recorded on the session, so the PR prompt and «Зміни» always know it. A
     detached HEAD keeps today's behaviour.
   - Every worktree birth follows the rule: a card launch, a promoted chat, and a reopen whose
     branch is gone. In-place sessions keep forking from the operator's checkout, because moving
     that checkout is what was just rejected.
5. **Counts and diffs start at the newer fork point.** That is the newer of
   `merge-base(HEAD, <base>)` and `merge-base(HEAD, origin/<base>)`; when the two diverge, the
   origin one, because that is what the PR shows. «Зміни», the finish sheet, the documentation
   gate, the file diff and the reviewer's diff start there. The commit count is the commits in
   neither `<base>` nor `origin/<base>`. The reviewer uses the session's base, not the project
   checkout's branch. Without `origin/<base>`, everything is as today.
6. **Three signals that the sync did not happen.**
   - *Before the turn.* The finish sheet says the branch is N commits behind `origin/<base>` and
     that «Створити ПР» (or «Закоміти») brings them in first. N is counted against the
     last-known `origin/<base>`, with no network.
   - *A turn ended mid-merge.* An agent session whose turn ends with unmerged files settles at
     `conflict`, not `done` / `in_review`. The check runs right after the turn settles; a turn
     that has already started wins. `conflict` clears when a later turn ends with no unmerged
     files, or when the finish sheet or «Зміни» reads the branch and finds none.
   - *After the PR or commit turn.* When the turn that settles on «На ревʼю» after «Створити ПР»
     or «Закоміти» ends with no unmerged files, the api fetches `origin/<base>` and the session
     branch. It then checks that the PR head (`origin/<branch>`, else the local HEAD) contains
     `origin/<base>`. If not, the transcript warns that the PR lacks N commits of
     `origin/<base>` and points at «Закоміти». If the api's fetch fails, it compares against
     what the agent's own fetch left.
   - Rejected: only the `conflict` status, which does not catch a skipped step. Rejected: no
     signal, where the operator learns it from GitHub — the problem this task fixes.
7. **The api's own fetches use the machine's credentials**, like the footer's. Rejected:
   `GIT_TOKEN` from the bound folder's `.env` through a one-off credential helper. The api would
   handle the token for the first time, and the username a token pairs with differs per host
   (`x-access-token` on GitHub, the real login on Bitbucket). Where machine credentials fail, the
   footer's Pull fails too; fixing both is one separate task. Cost: a token-only HTTPS project
   forks from the last-known `origin/<base>` with a notice. Every PR turn refreshes that ref,
   since the agent's fetch writes to the shared repository.
8. **The sync step is Kermanych's block, appended to any instruction.** `createPullRequest` and
   `commitChanges` append it right after the rendered instruction — the default or an override
   at any scope — with the base filled in, as the QA directive is appended. «ШІ-команда →
   Агенти» shows it read-only under «Провізор» and «Комітер», and it cannot be switched off.
   Rejected: a step in the default text. Every project with an override would lose the sync and
   get decision 6's warning after every PR. Rejected: a required `{{base}}` hole. Saved overrides
   without it would become invalid and silently fall back to the default. Cost: no project can
   choose rebase, which `kermanych-session` forbids anyway. The block names the base the PR
   prompt names (the session's base, else the project's default branch). In a project whose PR
   conventions retarget the PR, decision 6's check still compares against the session's base.
9. **Native sessions.** The pasted «Створити ПР» / «Закоміти» prompt carries the block. Decisions
   4 and 5, the finish-sheet line and the `conflict` status apply. The launch notice and the
   post-PR warning do not: a native transcript is its harness's own file, and Kermanych writes
   nothing into it.
10. **Kermanych's own texts follow.** `kermanych-session` says the operator triggers conflict
    resolution explicitly. It will say that a merge the agent starts to bring the base in is the
    agent's to resolve, and that one it did not start is resolved only when the operator asks.
    `kermanych-pull-request`'s order of operations gains the merge step. The default skill bodies
    stay under `ASSIGNED_BYTES_WARN`. The finish sheet's conflict hint names the three ways out:
    answer the agent in the chat, «Вирішити автоматично», or resolve in an editor and commit.

### The block

A draft of what the agent receives (`<base>` filled in; the trailer is `KERMANYCH_COAUTHOR`):

> Before you push, bring the base branch in. This step is Kermanych's own and applies whatever
> the instruction above says.
> 1. `git fetch origin <base>`, applying `GIT_TOKEN` exactly as you apply it to the push. If
>    `origin` has no `<base>`, skip this step and say so.
> 2. `git merge --no-commit origin/<base>` — merge, never rebase, never force-push. If it stops
>    before committing, finish it with `git commit --no-edit --trailer "Co-Authored-By: …"`.
> 3. Resolve conflicts yourself: keep what both sides added, then commit as in step 2. Stop and
>    ask the operator only when both sides changed the same behaviour in ways that cannot both
>    hold and choosing between them is a product decision. Then leave the merge unfinished,
>    list the files and ask.
> 4. If the merge brought anything in, run the project's checks for what it touched. Fix a
>    failure caused by the two sides meeting in a separate commit. Report a failure already on
>    `origin/<base>` (in the PR's `## Testing` when you write one) without fixing it.

## Changes (planned)

- **Core** `packages/core/src/agents.ts`: the block and its renderer. `skills.ts`: the
  `kermanych-session` and `kermanych-pull-request` bodies.
- **API**
  - `worktree/worktree.service.ts`: fetching one branch with a timeout, serialised per repository
    with `incoming`; remote and ancestry checks; fork-point resolution; ahead and behind counts;
    `addWorktree` with `--no-track` for a remote start point; `changedFiles`, `fileDiff` and
    `diff` from the resolved fork point.
  - `supervisor/supervisor.service.ts`: `resolveLaunchParams` records the checkout's branch when
    no base is given. `launch` and `reopenSession` fork from the fresher base and post the
    notice. `finishInfo` returns `behind`, uses the fork point and clears a stale `conflict`.
    `docsGate`, `fileDiff` and `reviewSession` use the fork point (the reviewer: the session's
    base). `createPullRequest` and `commitChanges` append the block. `onRpcEvent` sets
    `conflict` after a turn that ends mid-merge and runs the post-PR check.
  - `native/native-session.service.ts`: `conflict` after a native turn that ends mid-merge.
- **UI** `pages/AgentsPage.vue`: the finish sheet's behind line and conflict hint.
  `lib/api.ts`: `finishInfo` gains `behind`. `components/settings/AiAgentsPanel.vue`: the
  read-only block. i18n `uk` / `en`.
- No migration: `conflict` is already in the cloud's status enum
  (`20260821090000_team_cloud_schema.sql`) and in core's `SessionStatus`.

## Verification (plan)

- api tests against real git repositories in a temp folder (a bare origin, the project clone, a
  teammate clone):
  - fork: local behind → `origin/<base>`, with no upstream on the session branch; local ahead or
    diverged → local; failed fetch → last-known `origin/<base>` plus the notice; no origin →
    today's behaviour without a notice; no base picked → the checkout's branch is recorded;
  - after the branch merges a newer `origin/<base>`, `finishInfo` lists only the session's
    files, counts only its commits and reports `behind: 0`; a stale branch reports `behind: N`;
  - a turn that ends with unmerged files settles at `conflict` (managed and native); the next
    clean turn end settles at `done` / `in_review`;
  - the post-PR check warns when the PR head lacks `origin/<base>` and stays silent when it
    contains it;
  - the PR and commit prompts carry the block with the base, also under a project override.
- `assignments.spec.ts` (default skills under the byte warning) and `agents.spec.ts` stay green.
- Full suites of `@kermanych/core`, `@kermanych/api` and `@kermanych/ui`, plus typechecks of the
  api and the ui.
- Smoke: the api from this worktree with a temp project whose origin is a local bare repository.
  Check the fork point of a launch, the finish sheet's behind line, «конфлікт» on the card after
  a turn that ends mid-merge, and the prompt the agent receives.

## Documentation impact

`kermanych/README.md`:
- «Cloud tasks and local sessions», step 4: the fork from the fresher base and the notice;
- step 5: the sync inside «Створити ПР» / «Закоміти», conflicts, the `conflict` status and the
  post-PR warning;
- «Native sessions»: the helper paste carries the sync, and there are no Kermanych notices.
