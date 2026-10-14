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
     branch is gone. A reopen gets no notice: its session is dormant, with no live transcript
     to write to. In-place sessions keep forking from the operator's checkout, because moving
     that checkout is what was just rejected.
   - The fetch names an explicit refspec, `+refs/heads/<base>:refs/remotes/origin/<base>`, with
     no tags. It also works in a clone whose configured refspec does not cover the branch, and an
     argument that starts with `+refs/heads/` can never be read as a git option.
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
     files, or when the finish sheet or «Зміни» reads the branch and finds none. Unmerged files
     are read from git's stdout only, and a failed read (the worktree folder is gone) counts as
     none: git's error text is not a list of paths.
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
   prompt names (the session's base, else the project's default branch), and only when git takes
   it as a branch name (`isGitBranchName`, the rules of `git check-ref-format --branch`). A
   project's default branch is typed by a person and shared through the cloud, and the name
   lands in shell commands the agent runs and in the api's own fetch. For any other name there
   is no block and no check. In a project whose PR conventions retarget the PR, decision 6's
   check still compares against the session's base.
9. **Native sessions.** The pasted «Створити ПР» / «Закоміти» prompt carries the block. Decisions
   4 and 5, the finish-sheet line and the `conflict` status apply, and a harness resting at
   `conflict` still takes helper pastes such as «Вирішити автоматично». The launch notice and the
   post-PR warning do not apply: a native transcript is its harness's own file, and Kermanych
   writes nothing into it.
10. **Kermanych's own texts follow.** `kermanych-session` said the operator triggers conflict
    resolution explicitly. It now says that the merge the PR and commit actions start is the
    agent's to resolve, and that a conflicted merge it did not start waits for the operator.
    `kermanych-pull-request`'s order of operations gains the merge step. The default skill bodies
    stay under `ASSIGNED_BYTES_WARN`. The finish sheet's conflict hint names the three ways out:
    answer the agent in the chat, «Вирішити автоматично», or resolve in an editor and commit.

### The block

What the agent receives (`baseSyncBlock` in `packages/core/src/agents.ts`; `<base>` filled in,
the trailer is `KERMANYCH_COAUTHOR`):

> Before you push, bring the base branch `<base>` in. This step is Kermanych's own and applies
> whatever the instruction above says:
> 1. `git fetch origin <base>`, applying `GIT_TOKEN` to it exactly as you apply it to the push.
>    If `origin` has no `<base>`, skip this step and say so.
> 2. `git merge --no-commit origin/<base>` — merge, never rebase, never force-push. A
>    fast-forward or "Already up to date" needs nothing more; otherwise finish the merge with
>    `git commit --no-edit --trailer "Co-Authored-By: …"`.
> 3. Resolve conflicts yourself: keep what both sides added, then commit as in step 2. Stop and
>    ask the operator only when both sides changed the same behaviour in ways that cannot both
>    hold and choosing between them is a product decision — then leave the merge unfinished,
>    list the files and ask.
> 4. If the merge brought anything in, run the project's checks (typecheck, tests) for what it
>    touched. Fix a failure caused by the two sides meeting in a separate commit. Report a
>    failure that is already on `origin/<base>` — in the PR's `## Testing` when you write one —
>    without fixing it.

## Changes

- **Core** `worktree-names.ts`: `isGitBranchName`. `agents.ts`: `baseSyncBlock`.
  `i18n-codes.ts`: notice codes `base_fetch_failed` (`{ base, ref }`) and `pr_behind_base`
  (`{ base, count }`). `skills.ts`: the `kermanych-session` conflict line and the
  `kermanych-pull-request` merge step; the default skill bodies total 8189 of the 8192 bytes.
- **API**
  - `worktree/worktree.service.ts`: `fetchBranch`, `forkStart`, `forkPoint`, `isAncestor` and
    `behindCount`. `aheadCount` also excludes `origin/<base>`. `addWorktree` passes
    `--no-track`. `unmergedFiles` reads stdout only and reports nothing on a failed call. Every
    api fetch of one repository, the footer's included, runs in one queue (`serialRemote`):
    concurrent fetches fail on each other's ref locks.
  - `supervisor/supervisor.service.ts`: `resolveLaunchParams` records the checkout's branch when
    no base is given. `launch` (with the notice) and `reopenSession` fork from `forkStart`.
    `branchBase` gives `finishInfo` (now with `behind`), `docsGate`, `fileDiff` and
    `reviewSession` the session's base and fork point. `syncBase` validates the base, and
    `createPullRequest` / `commitChanges` append the block and arm `baseCheck`. `checkTurnEnd`
    runs after every settled turn: it sets `conflict` on a mid-merge tree, or runs the post-PR
    check. `clearConflict` runs from `finishInfo`.
  - `native/native-session.service.ts`: a `settled` event the supervisor answers with
    `markConflict`, `resettle` for `clearConflict`, and `conflict` in `PASTE_OK`.
- **UI** `pages/AgentsPage.vue`: the finish sheet's behind line (`agents.finish.behindInfo`);
  new conflict copy. `lib/api.ts`: `finishInfo.behind`. `components/settings/AiAgentsPanel.vue`:
  the read-only block under «Провізор» and «Комітер». i18n `uk` / `en`, notices included. The
  Ukrainian strings carry no plural forms («нових комітів: N»), like the existing `aheadInfo`.
  They were written while the app configured no Ukrainian plural rule for vue-i18n; the rule
  has landed since (`docs/specs/2026-10-14-uk-plural-rule.md`), and this phrasing needs none.
- **Tests**
  - New `apps/api/test/base-sync.spec.ts`, 10 tests against real repositories: the fork when
    local is behind, ahead, diverged, unreachable or absent from origin; the counts and the
    reviewer's diff once the branch merged origin's base; `conflict` and its clearing; the
    post-PR warning when the agent skipped the sync and when the merge stayed unpushed, and
    silence when the PR has the base.
  - Additions to `supervisor.pr.spec.ts` (sync before the push, under an override, in the commit
    prompt, none for a base git would not take) and `sessions.from-task.spec.ts` (the stale-base
    notice, and none when origin answered).
  - Additions to `supervisor.base-branch.spec.ts` (the checkout's branch recorded; detached
    HEAD) and `supervisor.native.spec.ts` (native `conflict`, the resolve helper accepted there,
    and the clearing).
  - Additions to core `worktree-names.spec.ts` (`isGitBranchName`).
  - The worktree mocks of the launch and review specs gained `forkStart` / `forkPoint` /
    `unmergedFiles`.
- No migration: `conflict` is already in the cloud's status enum
  (`20260821090000_team_cloud_schema.sql`) and in core's `SessionStatus`.

## Verification

- `@kermanych/core`: 19 files, 193 passed. `@kermanych/ui`: 52 files, 576 passed, including the
  i18n completeness test and `assignments.spec.ts` (default skills under the byte warning).
- `@kermanych/api`: 896 passed and 2 failed, both in `test/rpc-session.compact.spec.ts`. That
  failure is already recorded in `2026-10-05-slack-integration.md`, and this change does not
  touch `rpc-session.ts`.
- Typechecks: `tsc --noEmit` in `apps/api` reports only `jira.controller.ts` TS2504.
  `vue-tsc --noEmit` in `apps/ui` reports only `src-electron/*` (`@kermanych/api` not built) and
  `runtime-messages.spec.ts` TS2352. Both are errors this change does not touch.
- Smoke: the api built from this worktree in preview mode (`KERMANYCH_PREVIEW=1`, temp DB) and
  the UI dev server, in the pane. The seeded «Acme Web» project pointed at a real repository
  with a bare origin and a teammate's clone. The «Логотип у хедері» session was moved onto a real
  worktree forked from a stale local `dev`, with a commit to `header.txt`; the teammate pushed a
  different change to the same line, and the checkout fetched.
  - `GET /sessions/:id/finish` answered `ahead: 1, behind: 1, files: [header.txt]`. The finish
    sheet showed «Гілка відстає від origin/dev, нових комітів: 1 — «Створити ПР» спершу
    підтягне їх.»
  - «Створити ПР» ran a real omp agent (haiku). It ran `git fetch origin dev` and
    `git merge --no-commit origin/dev`, hit the conflict, and kept both sides («шапка з
    логотипом і меню»). It committed with
    `--trailer "Co-Authored-By: Kermanych <…>"`, said the repository has no checks and pushed.
    It stopped at `gh pr create` — origin was a local bare repository, not GitHub — and said so.
    The pushed `feature/header-logo` contained `dev`.
  - A second change by the teammate, merged into the worktree by hand and left conflicted; then
    the message «Відповідай одним словом: ок. Нічого не змінюй.» The agent answered «ок» and left
    the merge alone, as the new `kermanych-session` line says. The card settled at «конфлікт»,
    moved to «Помилки» (2 → 3), and the finish sheet showed `header.txt` with the new hint.
  - After resolving the merge in the folder and reopening the finish sheet, the card went back to
    «готово». The sheet said «комітів: 3»: the session's commit and its two merges, none of the
    teammate's.
- Not verified live:
  - the post-PR warning against a real GitHub pull request (`base-sync.spec.ts` covers it
    against a local origin);
  - the launch-time fork and its notice through a real cloud card (the preview has no Supabase
    project; `base-sync.spec.ts` and `sessions.from-task.spec.ts` cover them);
  - the read-only block in «ШІ-команда → Агенти», which the preview does not render because it
    has no workspace owner.

## Documentation impact

`kermanych/README.md`:
- «Cloud tasks and local sessions», step 4: the fork from the fresher base and the notice;
- step 5: the sync inside «Створити ПР» / «Закоміти», conflicts, the `conflict` status and the
  post-PR warning;
- «Native sessions»: the helper paste carries the sync, and there are no Kermanych notices.
