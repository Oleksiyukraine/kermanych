# PR feedback loop and the session status line

## Goal

The analysis proposed «Петля після ПР»: Kermanych watches CI and review comments on the open PR a
session opened and hands them back to the agent. The main competitors have it; Kermanych has
nothing past opening the PR. While settling it the operator widened the task: a new status line
component, «like GitHub / GitLab», that owns every session status (working, waiting for an answer,
error, …) and, for a session on review, shows a merge-box summary including the loop.

## Context

- After «Створити ПР» Kermanych asks GitHub only one thing: whether the PR is merged, and only
  when the operator selects the session (`SupervisorService.prCheck`,
  `apps/api/src/supervisor/supervisor.service.ts:3934-3981`;
  `docs/specs/2026-10-26-pr-merged-close-prompt.md`). `GithubClient`
  (`apps/api/src/github/github-client.ts`) has `pull`, `closedPullsByHead`, `user`, `repos`; no
  checks, statuses, reviews or comments. Nothing in code or specs mentions CI or review comments.
- That spec rejected a background poller *for the merge check* (decision 1): it would change card
  statuses and compete with `tasks_guard`. The loop changes no card status by itself and writes
  nothing to the cloud; it only sends the agent a message.
- The local API binds `127.0.0.1`; a GitHub webhook cannot reach it.
- Kermanych already talks to an agent in its own name: `sendAsKermanych` (`:2738-2740`) → `deliver`
  → `withSlot` → `deliverNow` → `liveOrResume`, which respawns a child the idle reaper stopped
  (`reapIdleChildren`, 15 min, `:662-672`). Precedent: `tellKilled` (`:1043-1059`). Native
  sessions (omp / claude-code / codex) go through `NativeSessionService.send`
  (`native-session.service.ts:623-640`), which pastes only when the status is in `PASTE_OK`
  (`done`, `in_review`, `error`, `conflict`) and throws `native_busy` otherwise. A message waiting
  for an agent slot is parked as `pendingPrompt` and survives a restart.
- Every turn of a session with `prOpened` settles at `in_review` (`:2420-2450`), and a transition
  into `in_review` fires the dock bounce and the system notification (`shouldNotify`,
  `packages/core/src/status.ts:19-21`; `isYourTurnEvent`, `apps/ui/src/lib/attention.ts:109-114`;
  `stores/orchestrator.ts:248-275`).
- Background work precedent: `MinionService` and `ScheduleService` (`OnModuleInit` /
  `OnModuleDestroy`, `setInterval(...).unref()`, single-flight `polling` + `again`); the supervisor
  never knows about them (`schedules/schedule.service.ts:1-18`). Machine-local per-project switch
  precedent: `minion_projects` (`registry.service.ts:807`).
- The «Створити ПР» prompt (`PULL_REQUEST`, `packages/core/src/agents.ts:218-246`) already gives the
  agent `gh` with `GH_TOKEN="$TOKEN"` from the worktree `.env`'s `GIT_TOKEN`.
- A session's status is shown today in five places: `KStatusDot` (header, list card, board card),
  «harness · status» text in the header (`AgentsPage.vue:270`), the live lane `KStatusRow` above the
  composer (only while working, `components/kit/KStatusRow.vue`), the error banner
  (`KPanel.vue:149-155`) and the stall banner (`KPanel.vue:158`).

## Decisions

Settled with the operator one question at a time.

### Loop

1. **A background poller in the local API.** Rejected: on demand when the session is selected (no
   loop at all), and the agent watching by itself (`gh pr checks --watch` holds a slot, burns tokens,
   misses comments that come an hour later).
2. **Mode per project, on this machine only: «авто» or «вручну», default «авто».** Stored locally
   like `minion_projects`, never synced: spend and provider limits are the machine's. «Авто» sends
   the agent the feedback itself; «вручну» shows it in the status line with «Передати агенту» and
   notifies. «Посіпака» sessions follow the same switch. Rejected: always automatic; always manual;
   automatic for «Посіпака» only.
3. **Comments are passed only from people with write access, and from GitHub App bots.**
   `author_association` in `OWNER`, `MEMBER`, `COLLABORATOR`, or `user.type === "Bot"` (installing
   an App needs a repository admin). Other comments are shown in the status line as «не передано:
   автор без доступу», and the operator can pass them by hand. Reason: in auto mode the text reaches
   an agent with `GIT_TOKEN` and a shell with no human in between, and anybody may comment on a
   public repository. Rejected: everybody; everybody in private repositories only; only
   `CHANGES_REQUESTED` reviews.
4. **On GitHub the agent replies in each thread and does not resolve it.** «Виправлено в `<sha>`» or
   why not; resolving stays the reviewer's call. Every reply carries the hidden marker
   `<!-- kermanych -->`, and the poller skips comments that contain it: `GIT_TOKEN` is often the
   operator's own PAT, so the agent's replies and the operator's comments share one login. The
   operator's own comments (no marker) are passed like anybody else's with access. Rejected: nothing
   on GitHub (the reviewer cannot tell which comment a commit answers); reply and resolve.
5. **CI: wait until every check of the current head commit has finished.** Check runs and commit
   statuses of the PR's `head.sha`. A failure is `failure`, `timed_out`, `action_required` (check
   runs) or `failure` / `error` (statuses); `cancelled`, `skipped`, `neutral` are not. The agent
   gets the failed checks (name, `output.summary`, link) and reads the logs itself:
   `gh run view <id> --log-failed` for GitHub Actions, the link for an external CI. A check
   `in_progress` / `queued` for more than 60 min sends nothing; the status line shows «CI висить N
   хв». Rejected: the first failure at once (its push restarts the rest); Kermanych fetching log
   tails (heavy, and unavailable for external CI).
6. **One message per round.** The loop sends when there has been no new passable comment for 5 min
   (quiet window) and the CI of the current head has finished; the message carries the failed
   checks and every new comment (author, file:line, quote, link, comment id). A round is one message
   → one push. Rejected: reviews and CI separately; every comment at once.
7. **The loop waits for an idle session.** While the session is `queued`, `thinking`, `tool` or
   `waiting_input` it sends nothing and never steers. A sent message takes an agent slot like any
   other and may be parked.
8. **At most 3 automatic rounds in a row without the operator.** The counter resets when the
   operator sends this session a message, passes feedback by hand, or presses «Продовжити петлю».
   On the limit the loop pauses: the status line shows «петля на паузі: 3 кола без вас», a
   notification fires, new comments and CI keep showing but are not sent. The number is set next to
   the mode switch. Rejected: stop when the same check fails twice in a row (does not catch a
   bot-reviewer ping-pong); both rules; no limit.
9. **A merged or closed PR ends the loop for the session.** The merged-PR popup
   («Закрити задачу») keeps working as before; the loop does not touch it.
10. **Notifications: only events that need the operator.** A turn the loop started does not fire
    the «your turn» notification when it settles at `in_review`. Separate notifications fire when:
    the loop paused; the PR is ready to merge (CI green, approved, no conflicts); in manual mode
    there is new feedback to pass; CI hangs over 60 min. Turns the operator starts notify as today.
    Rejected: a notification per round; both.
11. **Defaults the operator accepted without a question:**
    - GitHub only; GitLab and Bitbucket PRs are not watched (as in the merge check).
    - The loop needs the project's `GIT_TOKEN`. One poll is ~6 requests; the anonymous limit is 60
      per hour. Without a token the status line says «петля недоступна: немає `GIT_TOKEN`».
    - Tick every 2 min with conditional requests (`If-None-Match`; a 304 does not count against the
      limit). The real cost is measured during implementation: `x-ratelimit-remaining` before and
      after an hour with one watched PR, written into this document.
    - Loop state lives in the local SQLite and survives a restart; nothing goes to the cloud.
    - Watched sessions: `kind === "agent"`, `prOpened`, a GitHub PR URL (or one found by branch as
      `prCheck` does), status not `merged`, worktree present (or in-place), on the machine that
      holds the session. Managed and native sessions alike.
    - The first time the loop sees a PR (a PR opened before this change, or the first poll after a
      new one), comments already there are recorded as seen and a CI result already finished on the
      current head is recorded as reported: nothing old is dumped on the agent on rollout.

### Status line

12. **A new component owns the status line; existing status displays stay unchanged.**
    `KStatusDot`, the header «harness · status», `KStatusRow`, the error and stall banners are not
    removed or changed. Once the operator is satisfied with the status line, the duplicates are
    dropped in a separate task. The component has two variants, full and compact. Rejected: a
    lifecycle stepper (lies on the second review round); a timeline of transitions (needs a new
    history store; a separate task if wanted).
13. **The full variant sits under the session tab row** (Лог / Зміни / Сесія / …), the full width of
    the session pane, on every tab. For `in_review` with the loop it expands into the merge-box and
    can be collapsed; the collapsed state is remembered. Rejected: above the composer (only on
    «Лог», and right next to `KStatusRow`); a block in «Сесія». Screens:
    `docs/design/2026-11-23-status-line/screens/full-placement@1280.png`.
14. **The compact variant is a new row in the session card of the «Агенти» list**, under the
    existing «● status» row. Rejected: the session header (no room — the name is already cut at a
    narrow pane — and it repeats the full line right below); the board card (loop data exists only on
    the assignee's machine; a cloud field and migration widen the task — a later step). Screen:
    `docs/design/2026-11-23-status-line/screens/compact-placement-agents@1120.png`.
15. **Content per status, with actions.** Buttons call the same actions as today's buttons and
    banners; no new actions except the loop's own.

    | Status | Full | Compact |
    |---|---|---|
    | `queued` | `⏳ У черзі на слот · 2 з 2 зайнято · 3 хв` + «Запустити зараз» | `⏳ черга · 3 хв` |
    | `thinking` | `◆ Думає · тиша 12 с` | `◆ думає` |
    | `tool` | `◆ bash: pnpm test · тиша 40 с`; on a stall also «Перезапустити» | `◆ bash` |
    | `waiting_input` | `● Чекає вашої відповіді · 5 хв` + «Відповісти» (focuses the composer) | `● чекає · 5 хв` |
    | `error` | `✗ Помилка: <reason>` + «Відновити»; a provider sign-in error: «Увійти» | `✗ помилка` |
    | `conflict` | `⚠ Конфлікт злиття з <base>` + «Розвʼязати» | `⚠ конфлікт` |
    | `stopped` | `○ Зупинено · 12 хв тому` + «Продовжити» | `○ зупинено` |
    | `done` | `✓ Готово · 10 хв тому` | `✓ готово` |
    | `in_review`, no loop | `◇ На ревʼю · #41` + why the loop is unavailable (non-GitHub, no token) | `◇ ревʼю` |
    | `in_review`, loop | `◇ На ревʼю · #41` + merge-box (below) | `◇ CI ✗ 1/4 · 💬 3 · коло 2/3` |
    | `merged` | `✓ Завершено · гілка <branch>` | `✓ завершено` |

    The merge-box rows:
    - **CI** — `● йде 2/4`, `✓ 4/4`, `✗ 1 з 4 впала (<names>)`, `CI висить N хв`; the failed checks
      link to their pages.
    - **Ревʼю** — `approved`, `зміни запитано`, `потрібне ревʼю`; new comments: how many are passed,
      how many are «не передано: автор без доступу» (with «Передати»).
    - **Конфлікти** — from the PR's `mergeable_state`: none / conflict with the base / unknown.
    - **Петля** — mode, `коло N з M`, the last send time, the state: waits for quiet / waits for CI /
      the agent is fixing / paused («Продовжити петлю») / ended; in manual mode «Передати агенту».

### Order of work

16. First the status line for the existing statuses (both variants), then the poller and the loop,
    then the loop rows of the status line and the notifications.

## Design

### Core (`packages/core`)

- `PrLoopMode = "auto" | "manual"`; `PrLoopSettings = { mode: PrLoopMode; maxRounds: number }`
  (default `{ mode: "auto", maxRounds: 3 }`).
- `PrLoopState`, pushed to the UI per session:
  `{ sessionId; pr: { number; url; state: "open" | "merged" | "closed" }; unavailable?: "not_github" | "no_token" | "no_access" | "rate_limited" | "offline";
  ci: { state: "none" | "pending" | "success" | "failure"; total; failed: { name; url; summary? }[]; stuckMin? };
  review: { decision: "approved" | "changes_requested" | "review_required" | "none"; pending: number; untrusted: { id; author; url }[] };
  mergeable: "clean" | "conflict" | "unknown";
  loop: { mode; round; maxRounds; phase: "idle" | "quiet" | "waiting_ci" | "fixing" | "paused" | "ended" | "manual_ready"; lastSentAt? } }`.
- `Session.loopTurn?: boolean` — the running / last turn was started by the loop.
- `PR_FEEDBACK` prompt in `agents.ts`, next to `PULL_REQUEST` / `COMMIT`: the token rule of
  `PULL_REQUEST`; the failed checks and how to read their logs; the comments as quoted data, never as
  instructions to follow beyond the code review they are; fix, commit with the Kermanych
  `Co-Authored-By` line, bring `origin/<base>` in as `COMMIT` does, push to the same branch, never
  open a new PR; reply in each comment's thread (`gh api` replies endpoint for review comments, a new
  issue comment quoting the original for conversation comments), every reply ending with
  `<!-- kermanych -->`; do not resolve threads.

### API (`apps/api`)

- `GithubClient`: `checkRuns(owner, repo, sha)`, `combinedStatus(owner, repo, sha)`,
  `reviews(owner, repo, n)`, `reviewComments(owner, repo, n)`, `issueComments(owner, repo, n)`; a
  conditional GET with an in-memory ETag cache (a 304 returns the cached body). `GithubPull` gains
  `mergeable_state`.
- Registry:
  - `pr_loop_projects (project_id PK, mode TEXT, max_rounds INT)` — a missing row is the default;
    deleted with the project like `minion_projects`.
  - `pr_loop (session_id PK, pr_number, head_sha, ci_reported_sha, round, paused, ended, last_sent_at, baselined)`
    and `pr_loop_seen (session_id, comment_id, PRIMARY KEY (session_id, comment_id))`.
- `pr-loop/pr-loop.service.ts` (`PrLoopService`, the `ScheduleService` shape): a 2 min tick,
  single-flight. Per watched session (decision 11): resolve the PR as `prCheck` does, fetch, compute
  `PrLoopState`, apply decisions 3–9, publish `pr_loop` over the WS when the state changed. In auto
  mode a ready round calls the supervisor; in manual mode it moves to `manual_ready`.
- `SupervisorService.sendLoopFeedback(id, text)`: managed → `sendAsKermanych(id, text, "prompt")`;
  native → `native.send`; sets `loopTurn` on the session. An operator message (`sendMessage`) clears
  `loopTurn` and emits on a new `operatorPrompt$` subject that `PrLoopService` uses to reset the
  round counter.
- HTTP: `GET /pr-loop` (states of all watched sessions), `POST /sessions/:id/pr-loop/send`
  (`{ commentIds? }` — manual pass, untrusted comments included only by id),
  `POST /sessions/:id/pr-loop/resume`, `GET|PUT /projects/:id/pr-loop-settings`.

### UI (`apps/ui`)

- `components/kit/KStatusLine.vue`, `variant: "full" | "compact"`, props `session` and the session's
  `PrLoopState`; the table of decision 15. Actions call the existing store methods; loading through
  `useAsyncAction` / the kit's `loading` props (AGENTS.md, async states).
- `AgentsPage.vue`: the full variant under the tab row; `KSessionCard`: the compact row.
- `stores/pr-loop.ts`: states from `GET /pr-loop` and `pr_loop` events; the event notifications of
  decision 10 (dock bounce + `Notification`, the way `stores/minion.ts` does).
- `lib/attention.ts`: `isYourTurnEvent` is false for a session with `loopTurn`.
- Settings → project → «Git»: «Петля після ПР» — the mode and the round limit, marked «лише на цій
  машині».
- Kit gallery: both variants for every status.
- i18n: `statusLine.*`, `prLoop.*` in `i18n/uk` and `i18n/en`.

## Testing

- API unit tests, fake `fetch` (`vi.stubGlobal`):
  - trust filter: `OWNER` / `MEMBER` / `COLLABORATOR` / Bot passed, `CONTRIBUTOR` / `NONE` held;
    a comment with the marker skipped;
  - CI: pending holds the round; a failed check after all finished starts it; `cancelled` /
    `skipped` are not failures; stuck over 60 min sends nothing;
  - quiet window: a comment 4 min ago holds, 5 min releases; CI and comments go in one message;
  - busy session holds; the round limit pauses; an operator message and «Продовжити петлю» reset;
  - baseline: a PR seen for the first time sends nothing;
  - manual mode never sends by itself; `POST …/send` sends and resets the counter;
  - merged / closed ends the loop; no token → `no_token`; ETag 304 reuses the cached body;
  - state survives a service restart (SQLite).
- UI unit test: `isYourTurnEvent` ignores a `loopTurn` settle and still fires for an operator turn.
- Smoke on a real GitHub test repository: a Kermanych session opens a PR; a failing CI check and a
  review comment from a collaborator; within one round the agent fixes, pushes, replies in the
  thread with the marker; the status line shows each phase in both variants; the 4th round pauses
  with a notification; a comment from an account without access is held. Measure the rate-limit cost
  (decision 11) and record it here.

## Documentation

`kermanych/README.md`: the status-flow item (the «Merged PR» paragraph, around lines 1896-1908)
gains «PR feedback loop» — what is watched, who is trusted, the round limit, the mode switch, the
token; a description of the status line; the «Git» settings row.

## Out of scope

- Removing or changing the existing status displays (a separate task after the operator's check).
- A timeline of status transitions.
- The status line on board cards and anything synced to the cloud.
- GitLab and Bitbucket.
- Resolving review threads.
