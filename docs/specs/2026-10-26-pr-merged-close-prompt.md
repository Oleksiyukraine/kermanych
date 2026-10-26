# A merged PR offers «Закрити задачу» when its session is opened

## Goal

The operator asked: «when we accept a PR on GitHub, can the Kermanych task change its status
automatically?». Settled shape: when the operator selects a session in «Агенти» that already ran
«Створити ПР», Kermanych checks on GitHub whether that PR is merged. If it is, a popup offers
«Закрити задачу», which retires the session exactly as «Завершити» does, so the card moves to
«Завершені». The «Сесія» tab shows the PR and the result of the check.

## Context

- Kermanych never looks at a PR after opening it. `PR_URL_RE`
  (`apps/api/src/supervisor/pr-url.ts:7`) is only `.test()`-ed against the agent's output after
  «Створити ПР» (`supervisor.service.ts:1878-1895`, native `native-session.service.ts:680-684`);
  the URL is thrown away, and the only durable fact is `sessions.pr_opened`
  (`registry.service.ts:385`). The API has no GitHub client and never spawns `gh`; the agent
  opens the PR with `gh pr create` using `GIT_TOKEN` from the project's `.env`
  (`packages/core/src/agents.ts:133-167`).
- The card's status is the local session's status, pushed by the assignee's API
  (`CloudSyncService` → `pushTaskStatus`). `tasks_guard`
  (`supabase/migrations/20261023090000_task_auto_run.sql:54-68`) lets only the assignee change a
  status; no machine and no server component holds the service role.
- `merged` means «Завершити» ran (`finishSession`, `supervisor.service.ts:2919-2966`): loose work is
  committed onto the branch, the agent stops, the worktree is removed (in-place: the project is
  checked out back on the base), the branch is kept. The board puts `merged` in «Завершені»; the
  Jira / Linear «where does the ticket go next» prompts fire on a card turning `merged` on the
  machine that holds its session (`JiraMergePrompt.vue`, `LinearMergePrompt.vue`).
- `finishSession` runs the documentation gate first (`assertDocsGate`, `:2811-2814`).
- The local API binds `127.0.0.1` (`apps/api/src/main.ts:43-45`); GitHub cannot reach it.
- Selecting a session is `store.selectSession(id)` (`apps/ui/src/stores/orchestrator.ts:291-293`);
  `AgentsPage.vue` reacts through watchers on `selectedSessionId` (e.g. `loadChanges` at
  `:2271-2284`). The «Сесія» tab is the `agents__meta` list at `AgentsPage.vue:542-613`. A board
  card click always opens the task editor (`BoardPage.vue:161`), never a session.
- `docs/specs/2026-10-23-minion-auto-run.md:578-579` left "watching the PR on GitHub, and
  finishing the session after the merge" out of scope; this is that follow-up, on demand rather
  than by watching.

## Decisions

Settled with the operator one question at a time.

1. **Check on demand, when a session is opened.** Rejected: a background poller in the
   assignee's API (the operator: too many problems). Rejected: a GitHub webhook into a Supabase
   Edge Function. It needs the service role and an exception in `tasks_guard` (a second writer of
   statuses besides the assignee), a webhook and secret per repository, and the local session
   would still have to notice the cloud change and catch up, or its next push would overwrite the
   card. Rejected: a GitHub Action per repository, for the same reasons.
2. **Trigger: selecting a session in «Агенти» only.** That is where the session, its branch,
   worktree and `prOpened` live, and closing acts on the session. Rejected: also on a board card
   click. The board would mix task editing with session control and stack two modals on one
   click, and a teammate's card has no local session to check.
3. **«Закрити задачу» = `finishSession` without the documentation gate, only for a confirmed
   merge.** A new endpoint re-checks on GitHub that the PR is merged and only then finishes the
   session with the gate skipped. The decision is the server's, so the UI cannot bypass the gate
   by itself. All other `finishSession` behaviour stays: a tree mid-merge refuses, loose work is
   committed onto the branch, the branch is kept, the status becomes `merged`, the card goes to
   «Завершені», the Jira / Linear prompt fires as today. Rejected: the gate as is. After the
   merge, «Доповнити документацію» would put commits on a branch that is already merged.
   Rejected: opening the existing finish sheet. Most of its actions («Закоміти», «Доповнити
   документацію», «Створити ПР») make no sense after the merge.
4. **Finding the PR: store its URL, fall back to the branch.** From now on the first `PR_URL_RE`
   match is persisted as `sessions.pr_url` at the same moment `prOpened` is set (managed and
   native). A GitHub URL is checked directly. A session without a URL (opened before this change)
   or with a non-GitHub URL is looked up by branch: owner/repo from the `origin` remote, the
   closed PRs with `head = <owner>:<branch>`, counting only one that has `merged_at`, targets the
   session's base, and was created no earlier than the session (so an old PR from a reused branch
   name does not count). A stored GitHub URL whose PR is not merged also falls back to the branch
   lookup, which covers a PR that was closed and replaced by a new one. Non-GitHub remotes are not
   checked (state `unsupported`). Rejected: branch only. Rejected: URL only, which would leave
   every session opened before this change without the popup.
5. **Credentials: the project's `GIT_TOKEN`, else an anonymous request.** The token is read from
   the bound repository's `.env` with `EnvFileService.read`; it is the token the agent opened the
   PR with. Without it a public repository still works (60 requests per hour per IP); a private
   one answers 404 and the check reports no access. The token never reaches the UI, logs or the
   transcript. Rejected: falling back to the ambient `gh` login. The API would start spawning a
   CLI that may be absent, and the PR prompt itself warns that the ambient account is often the
   wrong one.
6. **The «Сесія» tab shows the PR and the check result.** A «PR» row after «База», only for
   sessions with `prOpened`: a link `#<number>` to the PR when known, and the state: «перевіряю…»,
   «відкритий», «змерджено», «закритий без мерджу», or the failure in words: «немає доступу
   (перевірте GIT_TOKEN)» for 401/403/404, «ліміт GitHub API», «немає мережі», «не
   GitHub-ремоут», «PR не знайдено». The result lives in UI memory until the next selection;
   nothing is written to SQLite or the cloud. A failed check never shows a popup; manual
   «Завершити» works as before.
7. **The popup reappears on every new selection.** Buttons «Закрити задачу» and «Не зараз».
   Nothing remembers «Не зараз»; re-selecting the session checks and asks again. A session that
   stays selected is not asked again.
8. **Work missing from the merged PR is a warning, not a block.** The popup warns when the
   worktree has uncommitted changes, or when the local branch head is neither the merged PR's
   `head.sha` nor its ancestor (commits made after the last push): «вони лишаться тільки на
   гілці `<branch>`». «Закрити задачу» still works; to deliver that work the operator picks «Не
   зараз» and opens a new PR. Rejected: blocking the close, which sends the operator back to
   manual «Завершити». Rejected: no check, which loses track of that work silently.
9. **Which sessions are checked.** `kind === "agent"`, `prOpened`, status not `merged`, worktree
   present (or in-place), and not active: `queued`, `thinking`, `tool`, `waiting_input` are
   skipped (the agent is still working). Native sessions are included; `finishSession` already
   stops them.

## Design

### Core (`packages/core`)

- `Session.prUrl?: string`.
- `PrCheck`, the result type shared by API and UI:
  `{ state: "open" | "merged" | "closed" | "not_found" | "unsupported" | "no_access" | "rate_limited" | "offline" | "error"; url?: string; number?: number; leftover?: { dirty: boolean; unpushed: boolean } }`.
  `leftover` is set only for `merged`.

### API (`apps/api`)

- Registry: `sessions.pr_url TEXT` added with the guarded `ALTER TABLE … ADD COLUMN` the other
  session columns use; read in `listSessions`, written in `updateSession`.
- PR URL capture: `supervisor.service.ts:1878-1895` and `native-session.service.ts:680-684` take
  the first match with `PR_URL_RE.exec(...)` and persist `{ prOpened: true, prUrl }`. The regex is
  unchanged.
- `WorktreeService.originUrl(repoDir)`: `git remote get-url origin`, stdout only, empty on failure.
- `github/github-client.ts`: plain `fetch` to `https://api.github.com`, `Authorization: Bearer
  <token>` when a token exists, `AbortSignal.timeout`, an error class carrying `status`.
  `pull(owner, repo, number)` and `closedPullsByHead(owner, repo, owner:branch)`. Parsing of
  GitHub owner/repo from `https://github.com/o/r(.git)`, `git@github.com:o/r(.git)` and
  `ssh://git@github.com/o/r(.git)` lives next to it.
- `SupervisorService.prCheck(id): Promise<PrCheck>`: applies decision 9 (otherwise
  `unsupported`), resolves the PR by decision 4 with the token of decision 5, maps HTTP 401/403/404
  to `no_access` (`not_found` when the branch lookup returns nothing), a 403/429 with exhausted
  rate limit to `rate_limited`, a network error or timeout to `offline`. For `merged` it adds
  `leftover`: `hasUncommitted(dir)` and `!isAncestor(HEAD, head.sha)` (a `head.sha` unknown
  locally counts as unpushed).
- `SupervisorService.closeMerged(id)`: runs `prCheck`; anything but `merged` throws
  `pr is not merged`. Otherwise it calls `finishSession` with the documentation gate skipped
  (an internal option; the public `POST /sessions/:id/finish` keeps the gate).
- HTTP (`sessions.controller.ts`): `GET /sessions/:id/pr` → `PrCheck`;
  `POST /sessions/:id/close-merged` → the `finishSession` result, stopping the preview first like
  `POST :id/finish`; errors as a 400 with the message.

### UI (`apps/ui`)

- `lib/api.ts` / `stores/orchestrator.ts`: `prCheck(id)`, `closeMerged(id)`.
- `AgentsPage.vue`: a watcher on `selectedSessionId` runs `prCheck` for an eligible session, with a
  run counter like `changesRun` so a late answer for a previously selected session is dropped. A
  `merged` answer opens the popup (`KModal`): title «PR змерджено», the PR link, the leftover
  warning when present, «Не зараз» and «Закрити задачу» (`useAsyncAction`, an error shown in the
  popup). Success selects nothing new; the session row turns `merged` through the normal
  `session_update`.
- «Сесія» tab: the «PR» row of decision 6.
- i18n: `agents.pr.*` in `i18n/uk/index.ts` and `i18n/en/index.ts`.

## Testing

- API unit tests (fake `fetch` via `vi.stubGlobal`, the Jira/Linear client pattern):
  - remote URL parsing: https, scp-style ssh, `ssh://`, with and without `.git`, non-GitHub hosts;
  - `prCheck`: stored URL merged / open / closed; no URL → branch lookup picks only a merged PR
    on the session's base created after the session; stored URL not merged → branch lookup finds
    the replacement; 401/403/404, rate limit, network failure; active, `merged` and non-agent
    sessions are not checked; the token header present with `GIT_TOKEN` and absent without;
  - `leftover`: dirty worktree, a commit after the PR head, a clean branch equal to the PR head;
  - `closeMerged` finishes a merged session with the documentation gate failing, and refuses an
    open PR; `POST :id/finish` still enforces the gate;
  - URL capture persists `prUrl` for managed and native sessions.
- UI unit test for the stale-answer guard only if the existing AgentsPage test setup makes it
  practical.
- Smoke: a real project with a merged GitHub PR from a Kermanych session and one still open. Select
  each in «Агенти»: the merged one shows the popup and «змерджено» in «Сесія»; «Закрити задачу»
  removes the worktree and moves the card to «Завершені»; the open one shows «відкритий» and no
  popup. Then an empty `GIT_TOKEN` on a private repository shows «немає доступу».

## Documentation

`kermanych/README.md`, the status-flow item (around lines 1035-1049): a merged PR is noticed when
the session is opened in «Агенти» and offers «Закрити задачу»; the «PR» row in «Сесія»; the token
it uses.

## Out of scope

- Any automatic status change without the operator opening the session (polling, webhooks).
- GitLab and Bitbucket PRs (their URLs are still stored, but not checked).
- Checking teammates' cards or cards from the board.
- Showing the PR link on the cloud card.
