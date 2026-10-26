# «Посіпака»: an agent that runs its author's auto-run cards to a pull request

- **Date:** 2026-10-23
- **Branch:** `feature/tech-ai-agent`
- **Scope:** `supabase/migrations` (two card columns, `tasks_guard`), `packages/cloud` (card fields,
  the launch claim), `packages/core` (the `minion` agent, session and report fields, the outcome
  contract), `apps/api` (the minion service, its routes and MCP tool, the session flag, the launch
  claim), `apps/ui` (the card switch, marks, the «ШІ-команда» card, the map strip, the auth
  keep-alive), `apps/ui/src-electron` (keep-awake), README.
- **Builds on:** `docs/specs/2026-10-13-agent-findings.md`, `docs/specs/2026-10-08-deep-analysis-task.md`,
  `docs/specs/2026-10-21-machine-resource-profile.md`, `docs/specs/2026-10-22-agent-map.md`,
  `docs/specs/2026-10-14-create-pr-base-sync.md`, `docs/superpowers/specs/2026-08-28-ai-team-agents-design.md`.

## Goal

The operator asked (deep-analysis session on `feature/tech-ai-agent`, 2026-10-22): «Знахідки»
produce many tasks. That improves the code, but somebody has to keep processing them. Could
Kermanych run a «технік» that takes tasks by itself and executes them with the technician's
skills: as an agent of «ШІ-команда» working in parallel with the operator, or on a separate
always-on machine at home?

In the interview the agent was renamed **«Посіпака»** (code id `minion`). The operator cut the
first version down to four points:

1. A card carries a switch: automatic execution is allowed. Metrics will be built on it later.
2. A card created from a finding is marked, for the same metrics.
3. «Посіпака» is an agent on «ШІ-команда», project section, switched on and off with a button.
   Its own skill set is settled later.
4. Once on, it takes only cards the user created, as a guard against prompt injection.

After the first delivery (PR #187) the operator added one more ask: most of what the minion will
run is findings, leftovers and old backlog cards («хлам»), so it should get special instructions
for that work. Decision 14 settles them; it is the skill set point 3 left for later.

## Context

**Starting a card.** One method starts every card-born agent:
`SupervisorService.createSessionFromTask` (`apps/api/src/supervisor/supervisor.service.ts:871-988`).
A person always triggers it: «Запустити» (`POST /api/sessions/from-task`), or a Jira or Linear
launch. It re-reads the card. It refuses a card assigned to someone else (`:878`) or already
running (`:886-888`). It claims an unassigned card with `claimTask` (`packages/cloud/src/tasks.ts:248-262`,
`update … where assignee_id is null`) and needs the project bound on this machine (`:899-900`).
Then it creates a worktree and spawns the managed runtime. The model gets the card text plus
`COAUTHOR_DIRECTIVE` and `DOC_MAINTAIN_DIRECTIVE` (`packages/core/src/agents.ts:46-58`).

**Nothing runs by itself.** The api never lists or subscribes to cloud tasks: only the UI calls
`subscribeTasks` (`apps/ui/src/stores/board.ts`). The api's timers are the reaper, the per-session
polls, the watchdog and the outbox backoff. Routines did schedule work and were removed
(`docs/specs/2026-10-19-remove-routines.md`). Their spec rejected a self-hosted runner machine
because it «needs a box online», and deep analysis for unattended runs because «nobody is there».

**One account per api.** The api caches one Supabase access token (`auth_session`,
`apps/api/src/registry/registry.service.ts:188-194`) and writes the cloud only under it
(`AuthService.cloudClient()`). There is no service role. The api never refreshes the token: the UI
does and re-posts every new token (`apps/ui/src/stores/auth.ts`). `@supabase/auth-js` 2.112.3
stops its refresh ticker while `document.visibilityState` is `hidden`
(`GoTrueClient._onVisibilityChanged`). Its public `startAutoRefresh()` keeps the ticker running and
drops that visibility handling. Closing the desktop window quits the app and the api inside it
(`apps/ui/src-electron/electron-main.ts:191`).

**Cards.**

- `tasks_guard()` (`supabase/migrations/20260830090000_tasks_assignment.sql:28-98`): only the
  assignee changes `status` (rule 1; the workspace owner may force `stopped`). An active card
  cannot be reassigned (rule 2). A taken card is not up for grabs (rule 2b).
- Nothing guards `created_by` after the insert. `tasks_update_member` lets any member update any
  column of any card (`20260821090200_team_cloud_rls.sql:97-102`).
- `profiles.id` references `auth.users` (`20260821090000_team_cloud_schema.sql:13-14`). Sign-in is
  GitHub only.
- Board lanes (`apps/ui/src/pages/BoardPage.vue:503-509`): «Беклог» `backlog`; running
  `thinking`/`tool`; waiting `waiting_input`; «На ревʼю» `in_review`; closed
  `done`/`merged`/`stopped`/`error`/`conflict`.
- Another machine sees a run only through the card: `status`, `docs_report`, `session_report`,
  `qa_checklist` (`packages/core/src/task-reports.ts:30-46`).

**Finding-born cards carry no mark.** «Створити задачу →» in
`apps/ui/src/components/agents/SessionFindings.vue` creates an ordinary card (`:353-362`). The only
trace is the last line of the description (`renderFindingDescription`,
`packages/core/src/findings.ts:116-123`), which the operator may edit before creating the card. Only
a Jira issue gets a label (`kermanych-finding`).

**What needs a person today.**

- A question (`waiting_input`) has no timeout, and nothing answers it. It holds an agent slot.
- On managed `claude-code`, `canUseTool` allows every tool and `answerUi` is a no-op
  (`apps/api/src/runtime/claude-code-runtime.ts:188`, `:312`). [INFERENCE] `AskUserQuestion`
  therefore never reaches the UI.
- omp has `ask.enabled` in its config (omp 18.12.1). The claude SDK 0.3.259 takes
  `disallowedTools`.
- «Створити ПР» (`createPullRequest`, `:2290-2338`) checks the docs gate (`assertDocsGate`,
  `:2633-2636`) and sends the PR instruction with the base sync. The agent pushes and runs
  `gh pr create` with `GIT_TOKEN` from the worktree's `.env`, which is copied from the bound repo
  on this machine. A PR URL in its output (`supervisor/pr-url.ts`) settles the turn at `in_review`
  (`:1782-1792`).
- «Доповнити документацію» (`completeDocs`, `:2643-2667`) can be called by code.
- The «Ревізор» review is prose that nothing parses (`reviewSession`, `:1462-1517`).

**Agent slots** (`docs/specs/2026-10-21-machine-resource-profile.md`). With the profile applied,
agent sessions in `queued`, `thinking`, `tool` and `waiting_input` hold slots. A launch past the
limit waits in a FIFO (`withSlot`, `park`, `drainSlots`, `:470-566`).

**«ШІ-команда».**

- Kermanych's agents are a code registry, `AGENTS` (`packages/core/src/agents.ts:191-199`):
  review, promote, pull-request, commit, resolve-conflict, and two automations. No agent does the
  main work.
- An instruction override and an ordered skill sequence per agent are rows of `ai_agents` and
  `ai_agent_skills`. They are edited only at workspace scope: `apps/ui/src/pages/AiTeamPage.vue:89-98`
  shows a stub at project and user scope.
- An assigned sequence reaches the prompt as the «Навички, призначені цій ролі» block, on both
  runtimes.
- A new `AGENTS` entry with an instruction would also appear in the trigger agent picker
  (`triggerAgentOptions`, `apps/ui/src/lib/settings.ts:309-311`). `runTriggerAgent` (`:2162-2186`)
  cannot run it.

**«Карта агентів»** shows every agent session of this machine with its marks
(`apps/ui/src/components/agents/AgentMap.vue:71-72`). It is machine-local by design
(`docs/specs/2026-10-22-agent-map.md`, decision 1).

## Decisions

### 1. One mechanism for both deployments

«Посіпака» is a Kermanych agent that any Kermanych can switch on. On the operator's machine it
works next to them; on an always-on machine it works alone. The code is the same: take a card, run
it without a person, open a PR, leave the result on the card.

- Rejected: a separate account on a separate machine only. The operator wants it running in
  parallel with their own work.
- Rejected: the operator's machine only. Apart from where Kermanych runs, nothing tells the two
  deployments apart.

### 2. The name

«Посіпака» in the UI (en «Minion»), `minion` in code. It was «Технік» until the interview, and the
operator found that name too plain.

### 3. The card switch: `tasks.auto_run`

`tasks.auto_run boolean not null default false`, labelled «Дозволити автовиконання» with the
caption «Посіпака на машині автора може взяти задачу сам».

- **Where:**
  - the «Нова задача» launcher. It takes effect for «В беклог». «Запустити» is a manual run and
    only stores the flag;
  - the board's create/edit form;
  - the findings filing dialog (board target).
- **Not with «Глибокий аналіз»:** that agent interviews the operator, and nobody is there. In the
  launcher, checking one clears and disables the other. The minion also skips `deep_analysis`
  cards.
- **The flag stays** on the card after the run: «allowed» is the fact the operator wants to count
  later.
- **A form sends the switch only when the operator changed it there.** The author may flip it
  while a colleague's form is open; a stale copy would either undo that or, sent as `true` by a
  non-author, get the colleague's whole save refused by `tasks_guard()`. The board form has no
  «Глибокий аналіз» control, so on a deep-analysis card it shows the switch disabled with the
  reason instead.
- **A manual ▶** on an auto-run card starts an ordinary session, not a minion run.
- Rejected earlier in the interview, then superseded by this switch: «Технік» as an entry in the
  «Виконавець» picker.
- Rejected: a real or virtual «технік» account as the assignee.
  - A virtual member needs a real `auth.users` row and a way to sign in around GitHub.
  - Rule 1 lets only the assignee push status, so the operator's own Kermanych could never run a
    card assigned to that account.

### 4. Finding-born cards: `tasks.finding_kind`

`tasks.finding_kind text` with `check (finding_kind in ('bug','security','tech-debt','docs'))`.
The findings filing dialog sets it to the finding's kind. Null means the card does not come from a
finding. It is frozen after insert (decision 5). Later it gives both counts the operator wants:
cards from findings, and cards by kind.

- Rejected: the origin line of the description. It is editable free text.
- Rejected: labels or tags. Native cards have none.
- Rejected: a general `origin` vocabulary (document, promotion, Jira…). Nothing asks for it yet.
- No visual mark in this change: the ask is data for metrics.

### 5. Only the author's cards, enforced by the database

The minion takes a card only when `created_by` is the signed-in user. Today that column protects
nothing: any member can rewrite `created_by` or the description of any card. So `tasks_guard()`
gains three rules. They follow the authorship rules that passwords, doc links and release notes
already have:

- `created_by` and `finding_kind` keep their inserted values on every update. A client that sends
  them is ignored.
- Only the author may switch `auto_run` from false to true (`only the author can allow auto-run`).
  Anyone may switch it off.
- If anyone but the author changes the card's content, `auto_run` becomes false. Content is
  `title`, `description`, `project_id`, `branch`, `model`, `effort`, `prefix`, `platform`,
  `worktree`, `image_paths`, `deep_analysis` and `kind`. Colleagues may still edit the card; the
  minion just stops trusting it. Status, assignee, `hidden`, `qa_checklist` and the reports are not
  content.

Consequences:

- A machine works only for the account signed in on it. The always-on machine must be signed in as
  the operator; a separate «технік» account would take nothing.
- Signing out on one machine also signs out the other today (finding `1c5d6274`, global sign-out).

Rejected: a check in the UI or the api only. The database would still let a colleague put their
text under the operator's name, and the minion would run it with the operator's `.env` and
`GIT_TOKEN`.

### 6. Activation: per project, on this machine only

- The button is on «ШІ-команда» → project scope → «Агенти», on a «Посіпака» card: «Активувати на
  цій машині» / «Деактивувати».
- It is stored in the local SQLite (`minion_projects`), like «Ресурси машини», and never goes to the
  cloud.
- A developer may activate any number of projects. The button is disabled, with the reason, while
  the project is not bound on this machine.
- Deactivating stops taking new cards. A run in progress continues; stop it from its chat or the
  map.

Rejected:

- Activation per user in the cloud. Every machine the user signs in on would start taking cards.
- Activation per project for the whole team (an owner switch). Whether a machine may work alone
  depends on that machine: its resources, its `.env` and `GIT_TOKEN`, its provider login.

### 7. Which card, and exactly once

**Polling.** The api polls the cloud every 60 s. It also polls at once on activation, on resume, on
a cap change and when a minion run ends. It does not poll at boot: the first poll is the first
tick, because a launch before the api listens gets no `kermanych` MCP server and so no
`report_outcome`. The listing runs even while nothing can start (paused, at the cap, no free
slot), so the waiting count stays current. It asks for the oldest card that is:

- in a project active on this machine and bound here;
- `status = backlog` with `auto_run` on, and `created_by` = the signed-in user;
- unassigned or assigned to the signed-in user;
- not `deep_analysis`, and not a Jira or Linear shadow card (`jira_key` and `linear_key` are null).

**The minion's claim** is one conditional UPDATE: `set status = 'queued', assignee_id = me where
id = ? and` the same predicate. Zero rows means another machine of the same user, or the operator's
own ▶, got there first. Rule 1 allows the status change because the caller becomes the assignee in
the same statement.

**The manual launch** takes the same kind of claim. `createSessionFromTask` sets `queued` and the
assignee in one UPDATE (status not active, assignee null or the caller). Today it calls a bare
`claimTask` and the status is pushed later. Without the change, a ▶ on the laptop and the minion
on another machine could both start the card in the seconds before the laptop's status push lands.

**A failed launch** puts the card back in two updates, because rule 2 refuses an assignee change
while the card is active:

1. the previous status;
2. no assignee, if this launch claimed the card.

For a minion launch the previous status is `backlog`, and the failure counts toward the pause
(decision 9). A child that dies while its launch is still starting (both runtimes fire their exit
callbacks before the start rejects) is that launch's failure: it counts once, and no `error` is
pushed to the card, which would race the release and lose to `tasks_guard()` once the card is
unassigned again.

### 8. Capacity

- One cap for the whole machine, across all its active projects. The default is 1. It is set on
  the «Посіпака» card («одночасно на цій машині»), from 1 to the agent limit (8 when limits are
  off).
- The oldest eligible card goes first, across projects, so one project cannot starve another.
- A minion run starts only when an agent slot is free and no session of the operator is waiting
  for one. It never enters the slot FIFO, so the operator's launches never wait behind a minion card
  that has not started. Once it runs, it holds a slot like any agent.
- With the machine profile declined there are no slots, and only the cap applies.

Rejected:

- A cap per project. The load would grow with the number of active projects.
- No cap of its own, waiting in the slot FIFO. The operator's launches would wait behind minion
  cards.

### 9. Working without a person

**The run.** It is a managed session of the card's project on this machine. `Session.minion`
(SQLite `sessions.minion`) is set when the session is created.

- It always runs in a worktree. The card's in-place choice is ignored: the operator works in that
  checkout.
- It is never native.
- The runtime is the signed-in user's preference. Model and effort come from the card or the
  project defaults, as for a manual launch.
- The project's rules apply as in any session: the repository's `CLAUDE.md`, `AGENTS.md` and
  skills, the project's library, its conventions and docs policy, and its carried `.env` with
  `GIT_TOKEN`.

**No questions.** The ask tool is off in minion sessions:

- omp gets a third `--config` overlay with `ask.enabled: false`;
- claude gets `disallowedTools: ["AskUserQuestion"]`.

The instruction tells the minion to decide within the card's scope and keep a list of those
decisions for the PR.

**Outcome.** A minion session gets one more tool on its `kermanych` MCP server:
`report_outcome { outcome: "ready" | "needs_decision" | "not_needed", summary }`. It is listed
only for minion sessions. The api validates the call and answers at once. When the turn ends,
Kermanych acts on the last outcome:

- `ready` → decision 10. Until the docs or PR turn starts, the session rests at `queued`, not
  `done`: the card never flashes to the closed lane, and it stays active for every machine, so no
  ▶ elsewhere can start it again in between.
- `needs_decision` → the card settles at `in_review`, the lane for cards that wait on a person,
  with «потрібне рішення» and the summary as its reason. The session stays in «Агенти». The
  operator answers it like any session. The minion then continues, and its next `ready` leads to
  the PR.
- No outcome → treated like `needs_decision` with the reason «завершив без підсумку», and it
  counts as a failure. A turn the operator started by writing to the run is theirs: when it ends
  without a verdict it settles like any turn and counts for nothing.
- A PR the operator opens on a minion session («Створити ПР» on the finish sheet) becomes the
  card's result `pr`. Counted as a success during the run's own work, neither way once the run
  already waited on a person.
- `not_needed` → decision 14: nothing to change, so the card closes at `done` with «не потрібно».

**Failures.** These count as failures:

- a launch that fails;
- a session that ends in `error`;
- a turn that ends without an outcome;
- a `ready` with no changes on the branch, or one that ends without a PR;
- a `not_needed` that left changes on the branch (decision 14);
- the time cap.

Two failures in a row pause the minion on this machine until the operator resumes it. A run that
ends in a PR, in the agent's own `needs_decision`, or in `not_needed`, resets the count. If the
operator stops, deletes or restarts a minion session, that changes nothing in the count, and the
minion does not take that card again: it is no longer in `backlog`.

**Signed out.** Before each claim the minion runs the existing runtime preflight, cached for 5
minutes. A signed-out provider pauses it at once with «потрібен вхід в AI», and no card is taken. So
does a minion session that dies with `*_not_authenticated`, or a launch that the provider refuses
signed out. The preflight runs only when there is a card to take, so an idle minion does not probe
the provider every minute.

**Time cap.** 2 hours from the spawn to the first outcome.

1. At the cap, Kermanych tells the session to stop and report `needs_decision` with where it
   stands.
2. 10 minutes later, Kermanych stops the turn. The runtimes have no «abort this turn», so the
   session is settled at `in_review` first and its child stopped, the way the idle reaper stops a
   settled child; the operator's next message respawns it on the same conversation.

The cap counts as a failure, even when a verdict or a PR follows it. Once the operator has
answered the session, it has no cap.

Rejected:

- Asking and waiting like a normal session. At cap 1, one question halts the whole queue.
- Asking with a timeout. The minion decides anyway, and it holds a slot for the whole timeout.

### 10. The result: a PR, through the existing flow

**Self-check.** Before `ready`, the instruction has the minion check its own work:

- against the card's acceptance criteria (a finding-born card always has them);
- with the project's checks (typecheck, tests, within the machine's worker limit).

**On `ready`:**

1. If the branch has no changes against the base (the project's carry files aside), the card goes
   to `needs_decision` («немає змін») without a docs or PR turn, and it counts as a failure
   (decision 14).
2. If the project requires documentation and the gate fails, Kermanych sends one «Доповнити
   документацію» turn (`completeDocs`). If the gate still fails, the card goes to `needs_decision`
   with the gate's failures.
3. Kermanych runs «Створити ПР» (`createPullRequest`): the PR instruction, the base sync,
   the QA checklist, and `GIT_TOKEN` from the project's `.env` on this machine. The PR is
   therefore opened in the name of that token's owner.
   - **The title.** After the base sync, a minion session's PR turn gets `MINION_PR_TITLE_RULE`
     (`packages/core/src/minion.ts`): the title starts with `[Minion] `, then the title the
     conventions give (`[Minion] fix(api): handle an empty list`), whatever the PR agent's
     override or the repository's conventions say. The author is the token's owner, so the title
     is what tells a minion PR apart in the PR list and in search. It holds for every PR turn of
     a `Session.minion` session, a «Створити ПР» the operator presses after «потрібне рішення»
     included. Rejected: a GitHub label — `gh pr create --label` fails on a label the repository
     lacks, creating it needs triage rights, and GitLab/Bitbucket have no `gh`; a separate bot
     account — a second token per project, against the design that the run uses the author's.
4. A detected PR URL settles the card at `in_review`, as today. A PR turn without a PR URL settles
   at `in_review` with «потрібне рішення» («PR не відкрито») and counts as a failure. A machine
   without `GIT_TOKEN` therefore pauses after two cards instead of failing the whole queue.

Rejected for now: an automatic «Ревізор» round, with or without one fix. It doubles the agents per
card and needs a parser for the review's prose. It can come later, once real minion PRs show that
it is needed.

Known limit: if branch protection requires an approval from someone other than the PR author, the
operator cannot approve a minion PR opened with their own token.

### 11. Instruction and skills: the existing «ШІ-команда» mechanism

- `AGENTS` gains `{ id: "minion", labelKey: "agents.role.minion", kind: "session", instruction,
  holes: ["task"] }`. «ШІ-команда» → workspace → «Агенти» shows it like the others: an editable
  instruction with validated holes, and a skill sequence. The instruction is model-facing English,
  like the other templates.
- The outcome contract (the `report_outcome` rules) is Kermanych's own. It is appended after the
  rendered instruction, the way `baseSyncBlock` is, so a rewritten instruction cannot break it.
- At project scope, the «Агенти» stub becomes the «Посіпака» card:
  - activation for this machine;
  - the machine block: cap, state, and the projects active on this machine;
  - the workspace's instruction and skills, read-only.

  The other agents keep the stub.
- The minion is excluded from the trigger agent picker and from `runTriggerAgent`.
- The minion's own rules for findings and old backlog cards: decision 14. On `claude-code`, a
  library skill reaches the minion only if it is assigned or Kermanych pastes it in, as for every
  session (README «Skills»).

Rejected:

- An instruction without a skill sequence. The sequence costs nothing: the mechanism exists.
- Skill sets per project. That needs a second editor, and project-scope agent rows already win at
  launch without being visible (finding `e93522c6`).

### 12. Seeing it and taking over

**Marks.** One `KMinionMark`:

- on «Дошка» and «Задачі» cards with `auto_run` («автовиконання дозволено»);
- on minion sessions in «Агенти» and on «Карта агентів» («виконує Посіпака»).

A «потрібне рішення» mark, with the reason as its tooltip, shows on an `in_review` card whose
session report says so, and on the session. A «не потрібно» mark, with the evidence as its
tooltip, shows on a `done` card whose session report says so, and on the session (decision 14).

**The card.** `session_report` gains `minion: { outcome: "pr" | "needs_decision" | "not_needed" |
"failed" | "stopped", code?, reason? }`. The report outbox writes it with the rest of the report,
so every machine sees the outcome and the counts can be built later. It is a field inside the
existing jsonb, so it needs no migration.

**«Карта агентів».** Minion sessions are ordinary agent sessions, so the map already shows them,
and they get the mark. A click opens the session's chat, as today: the operator can write to it
mid-run or stop it.

A strip above the map shows the minion's state on this machine:

- working: «1 з 1», the number of waiting cards, the active projects;
- or paused, with the reason;
- with ⏸ / ▶.

The strip is hidden when no project is active. The map stays machine-local: another machine's
minion shows only through its cards.

**Notifications.** The existing ones stay: a session reaching `in_review` or `error` while the
window is unfocused. A pause adds a toast and, when the window is unfocused, a native
notification. A pause the minion already had when the app started is shown by the strip and the
«Посіпака» card, not announced again.

### 13. An unattended machine keeps working

- The desktop app keeps its Supabase session refreshing while the window is hidden: it calls
  `startAutoRefresh()` at start. Without it, the api's token expires an hour after the window is
  minimised or covered, and the minion stops taking cards. This also keeps the status pushes of
  ordinary sessions going while the window is hidden. In a browser tab (`pnpm dev:ui`), the minion
  works only while the tab is visible.
- While a minion run is in progress, the desktop app holds Electron's `powerSaveBlocker`
  `prevent-app-suspension`. The Mac does not go to idle sleep and the app is not suspended; the
  screen may turn off. When no run is in progress, the machine sleeps as usual. The desktop host
  gives the api an optional keep-awake hook, the way it gives the browser host; the standalone api
  has none.
- Closing the window still quits Kermanych. Runs stop and their cards go to `stopped`, as today,
  and the minion does not take them again.

### 14. Rules for findings and old backlog cards

Asked after the first delivery: most of what the minion will run is findings, leftovers and old
backlog cards («хлам»). Such cards go stale: the problem was fixed meanwhile, the card repeats
another, or the code it names moved. A finding may be a misdiagnosis, or it may describe code on a
branch that never merged (findings spec, decision 1). A cleanup card also invites a bigger change
than an unattended PR should carry. Until now the minion did not know that a card came from a
finding: the kind lives only in `tasks.finding_kind`, and the description does not name it
(`renderFindingDescription`).

**14.1 Two layers.**

- General rules for every minion card, in the default «Посіпака» instruction:
  1. Check that the card still applies before changing code: find what the card and its evidence
     point to on this branch, which starts from the base. If the problem is already fixed, the
     card repeats another one, or the code it names is gone, report `not_needed` with the
     evidence. If the problem does not reproduce, or the code exists only on another branch,
     report `needs_decision`.
  2. Make the smallest change that meets the acceptance criteria: no drive-by refactors,
     reformatting, renames or dependency updates.
  3. Stop with `needs_decision` and a short plan instead of changing a public API or a database
     schema, adding a migration or a dependency, or spreading the fix over many files.
  4. A check that already fails on the base before the change is not the card's to fix: note it
     in the PR's `## Testing`, report it with `report_finding` when it is new, and judge the
     acceptance criteria on what the change touches.
  5. The PR description says what was wrong, how the agent confirmed it, what changed, and the
     decisions it took.
- Rules per finding kind, only for cards with a `finding_kind`:
  - **bug:** reproduce it first, with a test or the command from the evidence, and keep a test
    that fails without the fix and passes with it.
  - **security:** 14.3.
  - **tech-debt:** behaviour stays the same, and the project's checks pass before and after. A
    refactor that would grow large is `needs_decision` with a plan in stages.
  - **docs:** change documentation only, with the code as the source of truth. If the code is
    what is wrong, `needs_decision`, and the code stays untouched.

Rejected:

- Findings only. Old backlog cards go stale too, and rules 1-5 are what any unattended run needs.
- One set of rules without kinds. The agent would not know what a security or a docs finding
  demands.

**14.2 A third verdict: «не потрібно» (`not_needed`).**

- The agent changes nothing, removes anything it created to check the card, and reports
  `not_needed`. The summary carries the evidence: `path:line` on the base, a command's output, or
  the card it repeats.
- Kermanych checks the branch first. If it has changes against the base (the project's carry
  files aside), the run goes to `needs_decision` («позначено як непотрібне, але є зміни»), and it
  counts as a failure.
- Otherwise the card settles at `done`, in «Завершені», with a «не потрібно» mark whose tooltip is
  the evidence. The session carries the same mark. For the pause it counts as a success.
  `session_report.minion.outcome = "not_needed"` keeps it for the metrics: how many findings were
  stale.
- «Could not reproduce» and «the code exists only on an unmerged branch» stay `needs_decision`:
  they need a person.
- The session stays in «Агенти» like any other, with its worktree until «Завершити».
- A `ready` with no changes against the base is caught before the docs and PR turns: it goes to
  `needs_decision` («немає змін»), and it counts as a failure. Until now it went through a PR turn
  that had nothing to open and ended in `no_pr`.

Rejected:

- No new verdict: the agent says `needs_decision`, and the operator closes the card. Every stale
  card would wait for a click, which is the work the minion is meant to take off the operator.
- A new verdict that still lands on «На ревʼю» for the operator to close: the same click.

**14.3 Security findings run unattended, under stricter rules.** On top of 14.1, the `security`
section says:

- Reproduce only locally: a test or a local run of the code. Never against a deployed
  environment, a real account or an external service.
- No secrets in the output, the commits or the pull request.
- The pull request states the impact and the fix, not the steps to exploit it.
- Rotating keys, or changing infrastructure or access policies, is `needs_decision`.
- `not_needed` only when the vulnerable code is gone from the base. «Not exploitable in my view»
  is `needs_decision`.

Rejected:

- Opening a security PR as a draft. Every minion PR waits for the operator's review anyway.
- Never running security findings unattended. The most valuable findings would stay manual, and
  automatic execution is already chosen card by card, off by default in the findings dialog.

**14.4 The size limit is an instruction.** Rule 3 is the agent's to apply. Kermanych does not
measure the diff before the PR.

Rejected: a hard limit before the PR (for example 25 files or 800 changed lines, fixed or set on
the «Посіпака» card). The threshold is arbitrary, a docs card or a rename legitimately touches many
files, and a file count cannot see an API, schema or dependency change. It can be added once real
minion PRs show that it is needed.

**14.5 Where the rules live.**

- The general rules are part of the default «Посіпака» instruction (`agents.ts`). A workspace can
  rewrite it, as before.
- The per-kind rules are a new default skill, `minion-findings`, with one section per kind.
  - Kermanych appends it to the minion's assigned skills, once, for a finding card only. It is
    pasted into the prompt, so both runtimes get it.
  - Before it, a line of Kermanych's own names the card's kind.
  - A skill of that name in the repository, or a library row at user, project or workspace scope,
    replaces it. Switching the default off drops it. This is the `deep-analysis` precedent.
  - Every default is listed in every session's skill library, so its description says it is meant
    for minion runs of finding cards only.
- What the three verdicts mean stays Kermanych's own, in the outcome contract and the
  `report_outcome` description. No rewrite of the instruction or the skill can change how a run
  ends.
- The card's kind is stamped on the session when the minion run is created (`Session.findingKind`,
  SQLite `sessions.finding_kind`), so a relaunched run still gets the right rules.
- The «Посіпака» card on «ШІ-команда» → Проєкт adds a line: finding cards also get
  `minion-findings`, which «Бібліотека» can override or switch off.

Rejected:

- Everything in the instruction. Every card would carry all four kinds' rules, and only a
  workspace could change them: no project or repository could set its own security policy.
- Everything Kermanych-owned. No team could adapt the rules.

### Out of scope

- Metrics and their screens. The data is stored: `auto_run`, `finding_kind`,
  `session_report.minion`.
- A hard limit on a minion PR's size (decision 14.4).
- An automatic review round, watching the PR on GitHub, and finishing the session after the merge.
  Worktrees stay until «Завершити», as for any session.
- Retrying a card the minion failed. The operator relaunches it with ▶ (a manual run) or creates
  it again.
- Filing findings automatically: the findings spec's semi-automatic rule stands. The minion's own
  findings stay in its session's «Знахідки» tab on the machine that ran it.
- Jira and Linear tickets, deep-analysis cards, native sessions.
- A separate «технік» account.

## Changes

- **Supabase:** migration `supabase/migrations/20261023090000_task_auto_run.sql`.
  - It adds `tasks.auto_run`, and `tasks.finding_kind` with its check.
  - It redefines `tasks_guard()` with the three rules of decision 5. Rules 0-3 stay unchanged.
  - Every task read selects the two columns, so the migration must be pushed before a client that
    knows them ships.
- **Cloud** (`packages/cloud`):
  - `autoRun` and `findingKind` on `Task`, `TaskInsert` and `TaskPatch` (`types.ts`), mapped in
    `tasks.ts` and added to `TASK_COLUMNS`.
  - `claimTaskForLaunch(client, id, userId, from)` replaces `claimTask`: it claims with `queued`,
    guarded by the status the launch read (`from`), and `releaseLaunchClaim` undoes it. The api
    test fakes and `test/tasks.spec.ts` move with it.
  - `claimMinionTask(client, id, userId)` and `listMinionCandidates(client, projectIds, userId)`.
- **Core** (`packages/core`):
  - the `minion` agent, its default instruction, and the outcome contract text;
  - `Session.minion` and `Session.minionResult` (persisted as `sessions.minion_result`);
  - `SessionReport.minion` (`task-reports.ts`), read and merged like the other fields;
  - the `MINION_*` constants: poll interval, failure limit, time cap, grace;
  - the `report_outcome` argument validator;
  - the `ServerEvent` `minion_update`.
- **API:**
  - `minion/minion.service.ts`: the poll and eligibility, the preflight, the claim and launch, the
    cap and slot check, the failure count and the pause, the state and its `minion_update`, and
    keep-awake. Its state lives in SQLite: `minion_settings` (one row with the cap, the pause and
    the failure count) and `minion_projects`.
  - `minion/outcome-tool.ts` (`report_outcome`), `minion/ask-overlay.ts` (the omp overlay),
    `minion/keep-awake.ts` (the desktop hook).
  - `http/minion.controller.ts`: `GET /api/minion`, `PUT /api/minion` (`{ cap?, paused? }`) and
    `PUT /api/minion/projects/:id` (`{ active }`).
  - `SupervisorService`:
    - one shared `launchTask` behind `createSessionFromTask` and `launchMinion`, with the launch
      claim of decision 7;
    - a minion launch path: the `minion` flag, always a worktree, never native, started at once
      without the slot FIFO, the ask overlay or `disallowedTools` on every spawn and wake;
    - the run protocol at a minion turn's end (verdict, docs turn, PR, the `queued` hold, the
      `in_review` settles), the time cap, and the result on the row, the card report and
      `minionResult$`;
    - `queueTaskReport` reads the session's facts after its diff, so the last write queued carries
      the latest result;
    - `runTriggerAgent` refuses `minion`.
  - `BrowserMcpService`: lists and serves `report_outcome` only for minion sessions.
  - `ClaudeCodeRuntime` passes `disallowedTools` from the launch options. The omp spawn gets the
    ask overlay among its `--config` paths, which `RpcSession` already takes as a list.
  - Registry: `sessions.minion`, `sessions.minion_result` and the two tables.
  - `main.ts` `bootstrap`: an optional keep-awake hook.
- **UI:**
  - The switch in the launcher (`LauncherDraft.autoRun`, `taskInsertFromDraft` in
    `lib/tasks-view.ts`), the board form, and `SessionFindings.vue`, which also sets `findingKind`.
    Only the author can use it; others see it disabled, with the reason.
  - `KMinionMark` and `KDecisionMark` (the «потрібне рішення» mark) on `KKanbanCard`,
    `KSessionCard` and the map node, with kit samples; their predicates and wording in
    `lib/minion.ts`.
  - `stores/minion.ts`: the machine's minion state from `GET /api/minion` and `minion_update`, its
    writes, and the pause toast and notification.
  - The «Посіпака» card on `AiTeamPage.vue` at project scope: a new
    `components/settings/MinionPanel.vue`.
  - The strip in `AgentMap.vue`.
  - `stores/auth.ts` calls `startAutoRefresh()` in the desktop app.
  - `triggerAgentOptions` excludes `minion`.
  - i18n uk/en.
- **Electron:** `electron-main.ts` passes the keep-awake hook (`powerSaveBlocker`).
- **Docs:** README (see Documentation impact).
- **Decision 14 (rules for findings and old backlog cards):**
  - Core: the general rules in the default `MINION` instruction (its holes unchanged); the default
    skill `minion-findings` (`MINION_FINDINGS_SKILL`); the verdict and the outcome `not_needed`
    (`MINION_VERDICTS`, `MINION_OUTCOMES`) and the reason codes `no_changes` and `has_changes`;
    the outcome contract and a Kermanych line naming the finding kind (`minionFindingLine`);
    `Session.findingKind`.
  - API:
    - `sessions.finding_kind`, stamped from the card when the minion run is created (`launchTask`);
    - for a finding card, the opening prompt adds the kind line and `minion-findings` to the
      minion's assigned skills (`SkillsService.assignedFor` takes extra names, so the block and its
      de-duplication stay one; the extras resolve offline too, like any default);
    - the `report_outcome` description and schema;
    - at a minion turn's end, `not_needed` → rests `queued` → the branch check → `done` with
      `not_needed` (a success, a failure after the time cap) or `in_review` with `has_changes` (a
      failure);
    - on `ready`, the branch check runs before the docs gate → `in_review` with `no_changes` (a
      failure) when the branch is empty;
    - the branch check is `changedFiles` against the base `finishInfo` uses, without the project's
      carry files (normalised, so `./.env` is `.env`);
    - `settleMinionRest` settles a resting run at `in_review` or `done` and frees its agent slot;
    - the operator taking a run over (a message, a restart, a stop, delete or finish) clears
      `advancing`, and the branch check and the docs gate stop after their awaits instead of
      sending the next turn. The window left inside `completeDocs` / `createPullRequest` is filed
      as a finding.
  - UI: `KNotNeededMark` (a new `notNeeded` icon) on `KKanbanCard`, `KSessionCard`, the session
    header and the map node, with kit samples; `cardNotNeeded` / `sessionNotNeeded` and their
    wording in `lib/minion.ts`; the `minion-findings` line on `MinionPanel`; i18n uk/en. The
    kanban card's mark row wraps: two marks no longer push the card out of its column.
  - Docs: README «Посіпака» and «Карта агентів».

## Verification

- **Suites** (vitest, `--maxWorkers=4`):
  - `packages/core`: 23 files, 226 passed. New `test/minion.spec.ts`: the verdict validator (both
    verdicts, a refused verdict or blank summary named, an essay cut to the limit), the cap's
    range, reading a stored result, and the card report carrying the result for minion sessions
    only.
  - `packages/cloud`: 13 files, 235 passed, with the RLS suite run against a local Supabase stack
    (`supabase start`, the new migration applied with `supabase migration up --local`). New RLS
    cases: `created_by` and `finding_kind` stay as inserted; a colleague cannot switch `auto_run`
    on but can switch it off; a colleague's content edit clears it while the author's edit, a
    `hidden` change and a QA tick do not; the minion claim takes only the author's card, once,
    against a second claim and a `claimTaskForLaunch`; a one-statement release is refused with
    `task is active` and the two-step release works. Unit cases pin the claim and listing
    predicates and the release order.
  - `apps/api`: 114 files, 1051 passed, 4 skipped. New `test/minion.spec.ts` (28): the oldest
    eligible card across projects; nothing claimed while paused, at the cap, without a free slot
    or behind a waiting operator session; a lost claim; a failed launch back to `backlog`, two in a
    row pausing; a child dying during its launch counted once with no `error` pushed; the signed
    out preflight; `ready` → docs turn → PR → `pr`, resting at `queued` in between; the agent's
    `needs_decision` and an answer resuming the flow; a PR the operator opens after «потрібне
    рішення»; no verdict; no PR; the time cap and its grace; the operator's takeover and stop;
    `report_outcome` listed and served only for minion sessions; the routes. The two regression
    cases found in review and smoke (the launch-time death, the late report write) fail without
    their fixes. `sessions.from-task.spec.ts` covers the manual claim with `queued` and its
    release.
  - `apps/ui`: 63 files, 712 passed: the `autoRun` draft ↔ card mapping (never with deep
    analysis, sent on a patch only when changed, author-only), the needs-decision predicates and
    the reason, pause and strip wording against the real catalogues, `findingKind` from the
    filing dialog, the registry and trigger-picker counts.
- **Typecheck:** `apps/api` `tsc --noEmit` clean. `apps/ui` `vue-tsc --noEmit`: only the
  pre-existing `test/runtime-messages.spec.ts` TS2352.
- **Review:** a reviewer pass found eight issues; all are fixed in this change: the refresh
  keep-alive started before auth-js finished initialising (it re-registered its visibility
  handling), a launch-time death counted twice, a PR opened by hand after «потрібне рішення» left
  the mark, stale forms sending `autoRun`, a verdict surviving a dead child, `ready` resting at
  `done`, a capped run counting its PR as a success, and a write reply overwriting a newer
  `minion_update` in the UI store.
- **Smoke:** the built api (`node dist/main.js`, temp SQLite, `KERMANYCH_RUNTIME=omp`) against the
  local Supabase stack, a password user minted through the admin API, one workspace and project
  bound to a throwaway git repo with a local bare `origin`, a `gh` stand-in on `PATH` that answers
  `pr create` with a PR URL, and real omp (`claude-opus-5-5`):
  - activation polled at once; the card «Fix the off-by-one in average()» was claimed, run, the
    agent fixed and tested it, called `report_outcome` `ready`, Kermanych sent «Створити ПР», the
    branch reached `origin` and `gh pr create` was called; the card ended `in_review`, assigned to
    its author, `auto_run` still on, `session_report.minion = { outcome: "pr" }`;
  - an ambiguous card («the format finance agreed on») ended `in_review` with `needs_decision`
    and a precise question, without counting a failure; an answer through
    `POST /api/sessions/:id/message` resumed the run, which opened its PR (`pr`);
  - a colleague's own auto-run card in the same project stayed in `backlog`, unassigned;
  - two more cards ended `needs_decision` for real reasons (the base still had the unfixed bug the
    card's checks depend on); one of them also reported that bug through `report_finding`;
  - a trivial card's cloud status, sampled every 300 ms: `backlog → queued → thinking → tool →
    thinking → tool → thinking → in_review` with `pr`, never `done`;
  - the UI dev server pointed at that api and stack, signed in by injecting the user's session:
    the «посіпака» and «потрібне рішення» marks on «Дошка» cards and «Агенти» sessions, the
    «Карта агентів» nodes and strip («Посіпака · працює 0 з 1 · у черзі 0 · smoke-repo»), ⏸
    pausing with a toast and ▶ resuming, the «Посіпака» card on «ШІ-команда» → Проєкт (activation
    state, cap, active projects, the default instruction read-only), and the board form's switch
    locking for a non-author once switched off.
  - Before its fix, the smoke run showed one card keeping «потрібне рішення» after its PR: the turn's
    own report write finished last with the old result. Fixed in `queueTaskReport`, covered by a
    test.
- **Not exercised:** the desktop app itself (`startAutoRefresh` with a hidden window and
  `powerSaveBlocker`; the browser-tab build keeps the default refresh), the claude-code runtime
  with `disallowedTools` against the real CLI, a real GitHub PR, and pushing the migration to the
  team's project.
- **Decision 14:**
  - Suites: `packages/core` 23 files, 227 passed (the validator takes `not_needed`, a stored
    `not_needed` and a `has_changes` result read back, the default skill the supervisor asks for
    exists). `apps/api` 114 files, 1058 passed, 4 skipped; `minion.spec.ts` 34 (+6):
    - `not_needed` on an unchanged branch rests `queued`, then `done` with the evidence, the
      failures reset, no docs gate and no further prompt, and the card's report carries it;
    - `not_needed` with changes → `in_review` with `has_changes`, a failure;
    - `ready` on an unchanged branch → `in_review` with `no_changes`, a failure, before the docs
      gate and with no PR turn;
    - carry files `./.env` and `config/local.json` listed by git do not count;
    - a stop while the branch is checked sends nothing more (without the guard the run went on
      to its PR turn and the session ended `done`);
    - a finding card's prompt, resolved by the real `SkillsService` over an empty library,
      carries the kind line and the `minion-findings` body between the card and the outcome
      contract, and the session `findingKind`; an ordinary card's carries neither.
    `skills.assignments.spec.ts`: Kermanych's extra names follow the assigned sequence once and
    still arrive with the cloud unreachable. `apps/ui` 63 files, 717 passed: the «не потрібно»
    predicates (only at `done` for a card, never with «потрібне рішення»), the evidence tooltip
    and its fallback, the two new reasons worded in the real uk/en catalogues.
  - Typecheck and build: `apps/api` `tsc --noEmit` clean, `nest build` clean, `packages/cloud`
    `tsc --noEmit` clean; `apps/ui` `vue-tsc --noEmit` only the pre-existing TS2352.
  - Smoke: the built api and real omp (`claude-opus-5-5`) against the local stack, as above. The
    throwaway repo had `clamp()` already fixed and `average([])` still returning `NaN`. The project's
    carry files were `.env` (ignored) and `local.config.json` (untracked, not ignored, so git
    lists it in every worktree). Three auto-run cards were taken oldest first:
    - a `bug` finding about `clamp()` (stale): the model's opening prompt had the kind line and
      the `minion-findings` body between the card and the outcome contract. The agent ran the
      evidence command (it printed 10, not 15), cited `src/math.js:5` and `test/math.test.js:6`,
      changed nothing, and reported `not_needed`. The card went `done` with
      `session_report.minion = { outcome: "not_needed", reason: <the evidence> }`, failures 0.
      `local.config.json` did not count as a change;
    - a `bug` finding about `average([])` (live): reproduced first (`NaN`, and the new test
      failed), fixed with a guard and a test, `ready` → «Створити ПР» → `gh pr create` →
      `in_review` with `pr`. The PR body said what was wrong, how it was confirmed, what changed,
      the decisions and the testing;
    - an ordinary card («Add a sum() helper») ran to a PR. Its prompt had the general rules but
      neither the kind line nor the skill;
    - the UI against that api: «не потрібно» on the «Завершені» card (tooltip = the evidence), on
      the session in «Агенти» and its header, and on its «Карта агентів» node. The
      `minion-findings` line on the «Посіпака» card. `minion-findings` listed as «системний» in
      «Бібліотека». The smoke showed the board card's mark row overflowing its column with two
      marks (the same with «потрібне рішення»); the row now wraps, re-checked on the board and
      the kit samples.
  - Not exercised: `has_changes` and `no_changes` with a real agent (unit tests only), and a team
    override or a switched-off `minion-findings` (the same resolution as any default skill).

## Documentation impact

`kermanych/README.md`:

- A «Посіпака» section under «Cloud tasks and local sessions». It covers:
  - what the minion takes, and why only the author's cards;
  - activation and the cap;
  - how it runs without a person, its outcomes and marks, and the pause;
  - the rules it works by (decision 14): the general rules, `minion-findings` per finding kind and
    how a team overrides it, and the «не потрібно» outcome;
  - keep-awake;
  - the always-on machine (signed in as the author, window open);
  - the migration to push.
- «Agent findings («Знахідки»)»: the filing dialog's switch and the `finding_kind` mark.
- «Agent map («Карта агентів»)»: the strip and the mark.
- «Workspaces, projects and tasks» and «Applying a migration to the team's project»: the new
  columns and the author rules.
