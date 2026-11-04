# Skill self-improvement: agents improve the operator's skills, ЦУК shows and rolls back

- **Date:** 2026-11-04
- **Branch:** `feature/explore-agent-skill-self-improvement`
- **Scope:** `kermanych/supabase/migrations` (one migration), `packages/core` (the tool contract,
  edits, rollback, diff), `packages/cloud` (the history table, the profile switch), `apps/api`
  (the `improve_skill` tool on the session's `kermanych` MCP server and its write path),
  `apps/ui` (ЦУК's «Центр сповіщень» column, the entry view, the toast, the Settings switch,
  i18n `uk` / `en`), `kermanych/README.md`.
- **Status:** decisions agreed with the operator in the deep-analysis interview (2026-11-04),
  approved the same day; implemented on this branch (see «Verification»). The column's look is
  waiting for the operator's pick from the screenshots (decision 6).

## Goal

The operator also uses Hermes Agent, which now and then reports that it improved a skill. They
asked how that works and whether Kermanych should do the same. The answer settled in the
interview is yes, in this form: the operator works as usual; now and then Kermanych shows a
notification in the bottom-right corner, «Я вдосконалив навичку X»; the operator opens ЦУК, sees
what changed and can roll it back.

## How Hermes does it

Researched in its docs ([skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills),
[memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory),
[curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator)) and its source
(`agent/background_review.py`).

- A skill is a `SKILL.md` folder in `~/.hermes/skills/`. The agent edits skills with its
  `skill_manage` tool (`create`, `patch`, `edit`, `delete`, `write_file`, `remove_file`).
- After a turn, once ten tool iterations have passed since the last skill write
  (`skills.creation_nudge_interval`), Hermes forks the agent in a background thread. The fork
  gets the same system prompt, a snapshot of the conversation (a warm prompt cache) and only the
  memory and skill tools. Its prompt, `_SKILL_REVIEW_PROMPT`, says «Be ACTIVE — most sessions
  produce at least one skill update». It patches a skill loaded in the session first, then an
  umbrella skill, then a support file, and only then creates a new skill.
- Writes apply at once by default (`skills.write_approval: false`), and the chat gets a line such
  as `💾 Skill 'foo' patched`. With the gate on, writes are staged for `/skills pending | diff |
  approve | reject`.
- A curator runs every seven days while the agent is idle. It moves agent-created skills from
  active to stale (14 days) to archived (30 days), can merge overlapping ones with a model, and
  keeps backups, an audit ledger and a rollback.
- Users complain about three things. Background edits change their own skills and leave no
  record of what changed
  ([#70128](https://github.com/NousResearch/hermes-agent/issues/70128)). One long session staged
  74 writes, 29 of them to one skill
  ([#99661](https://github.com/NousResearch/hermes-agent/issues/99661)). «Be ACTIVE» pushes an
  edit on every firing.

## Context

- **The library.** `ai_skills` rows are owned by exactly one workspace, project or user
  (`supabase/migrations/20260908090000_ai_scope.sql:54-74`). Kermanych adds 12 defaults that live
  in code (`packages/core/src/skills.ts`). A launch resolves a name by precedence: repository,
  then user, then project, then workspace, then the default (`apps/api/src/skills/skills.service.ts:60-104`).
  There is no history: a save overwrites `body`, and only `created_*` / `updated_*` remain.
- **Who writes.** Only people write the library, each under their own JWT. The api's cloud client
  is pinned to the signed-in operator's JWT, and there is no service-role key
  (`apps/api/src/auth/auth.service.ts:161-171`). RLS `ai_can_write` lets only the workspace owner
  write workspace and project rows, and only the user write their user rows (`ai_scope.sql:38-48`).
- **How skills reach an agent.**
  - Managed omp: the resolved library is written to
    `~/.kermanych/skills/<projectId>/<name>/SKILL.md` at every launch and handed over by a
    `--config` overlay (`skills.service.ts:514-600`).
  - Managed claude-code: a library skill arrives only when it is assigned, pasted into the
    prompt (`assignedForNames`, `skills.service.ts:430-475`).
  - Native sessions: no library.
- **The agent's channel to Kermanych** is the session's `kermanych` MCP server
  (`apps/api/src/browser/browser-mcp.service.ts`, `tools/list` at :814-835). It always lists the
  findings tools, and lists browser, preview and device tools by platform, `report_outcome` for
  minion runs and the QA tools for tester runs. Discussion and review forks get no server; tester
  runs are the one exception. The tool descriptions are the agent's whole instruction, and the
  findings fields are asked for in the operator's agent language
  (`apps/api/src/findings/findings-tools.ts`).
- **ЦУК** (`docs/specs/2026-11-04-cuk-control-console.md`) is the avatar's window,
  `min(1200px, 92vw)` × `min(780px, 84vh)`. It holds the console accordion (ЦУК, plus the
  Менеджмент assistant for owners and managers) and, on the right, «Записничок»: 300 px wide and
  behind 📝 below 900 px (`apps/ui/src/components/assistant/AssistantLauncher.vue`,
  `CukNotepad.vue`). `stores/assistant-overlay.ts` holds `open`, `unread` (the mascot's dot),
  `summons` and `panel`.
- **Toasts.** `KToast` sits in the bottom-right corner. `orchestrator.notify(message, kind, ms,
  action?)` takes one action button.
- **Cloud cost.** Supabase bills by plan, compute, database size, egress and Realtime. API
  requests are unlimited on every plan ([pricing](https://supabase.com/pricing)). The hosted
  project is on Free and is already over its egress quota, 11.4 of 5 GB
  (`docs/specs/2026-11-03-board-egress-and-lag.md`). Every launch reads the whole library, bodies
  included, at least twice (`materialize` and `assignedFor`). This is reported as finding
  `1d9d25ba` and is outside this task.
- **omp's own `autolearn`** (`manage_skill`, `~/.omp/agent/managed-skills/`) exists but is off,
  and Kermanych does not use it.

## Decisions

1. **The agent changes a skill itself, and Kermanych applies the change at once.** Kermanych
   keeps the previous version, tells the operator, and the operator can roll the change back. The
   interview first chose «the agent proposes, the operator approves». The operator then described
   the flow they want (a notification, then ЦУК, then a rollback), and that flow is this
   decision.
   - Rejected: a proposal queue with approval. The operator does not want the extra step, and
     Hermes's approval queue floods (#99661).
   - Rejected: omp's `autolearn`. It works in omp only. It writes to one folder for the whole
     machine, which mixes projects. Its skills do not show in «ШІ-команда» or to teammates, and
     nothing reviews them. It creates skills but cannot fix existing ones.
   - Rejected: not doing it.

2. **The session's agent decides, during its own work, through a tool on its `kermanych` MCP
   server.** The operator does not trigger a review, there is no button in the session, and
   there is no background reviewer.
   - Rejected: a «Переглянути навички» prompt sent into the session. It adds a turn to the
     session's log and context, and the operator wants nothing new in the session.
   - Rejected: a hidden fork that reviews the conversation, built like «Гілка».
   - Rejected: a one-shot reviewer that reads the transcript file.
   - Rejected: an automatic turn after «Створити ПР».
   - Each rejected trigger costs one more model turn per session. A reviewer driven by a counter,
     as in Hermes, is the design that floods.

3. **The improvement goes into the operator's personal layer.** It is a user-scope `ai_skills`
   row with the skill's name. By precedence, that row replaces the project, workspace or default
   text in the operator's next sessions, on every runtime that receives the library. Teammates'
   sessions do not change. RLS already lets every role write such a row. The workspace owner can
   share the improvement with the team from ЦУК (decision 6).
   - Rejected: writing the skill where it lives. Only the workspace owner may write there
     (RLS). Teammates would get the change without being told. An instruction slipped to an agent
     through a web page or a ticket would persist into the whole team's sessions.
   - Two consequences were stated to the operator. The personal layer applies in all of their
     projects and workspaces, because a user row has no project. While a personal copy exists,
     team edits to that skill do not reach the operator; the entry view says when the team text
     has changed.

4. **The agent may change only existing Kermanych library skills that it saw in the session,
   and only by exact text replacements.**
   - This covers personal, project and workspace rows and the Kermanych defaults.
   - Each replacement's `find` must occur exactly once in the skill's current text. A skill the
     agent did not read therefore cannot be rewritten.
   - The agent creates no new skills.
   - It records only general lessons. A fact about one repository (a command, a path, a
     convention) is not a skill improvement. The agent may pass it on with `report_finding`, as a
     proposal for that repository's `AGENTS.md` or docs.
   - Repository skills (the six `REPO_SKILL_DIRS`) are refused. They are files in the
     repository and outrank the library, so a personal copy would never be used. Skills that
     Kermanych does not own (home folders, harness plugins) are refused too.
   - Rejected: new personal skills. claude-code sessions see library skills only when they are
     assigned, native sessions get no library at all, and the library would only grow. Hermes
     needed a curator because of that growth.

5. **The history lives in the cloud, in a new table.** A session makes at most 5 improvements,
   and each user keeps the newest 100 records. ЦУК on every machine shows and rolls back every
   improvement, including those from a «Посіпака» run on another machine.
   - Rejected: local SQLite, as findings use. The skill changes on every machine, but its
     history would sit on one.
   - The operator asked about cost before choosing. Requests are free; egress and size are what
     cost. Skill text is kept out of every list and every Realtime payload, and it is read only
     when an entry is opened (see «Cost estimate»).

6. **ЦУК gets a left column, «Центр сповіщень», built like «Записничок».** The column lists
   activities of several kinds. For now it has one kind, skill improvements.
   - Each entry shows the skill, a one-line summary, the time, the session and project, and the
     state: applied, rolled back or shared with the team.
   - New entries are marked and counted in the column's header.
   - Opening an entry shows, over the console, the before / after diff, the reason, «Відкотити»
     and, for the workspace owner, «Поширити на команду».
   - A toast in the bottom-right corner reads «Я вдосконалив навичку X: <summary>» and carries
     «Переглянути», which opens ЦУК on that entry.
   - The look is drawn in 2–3 variants in the live preview. The operator picks one from
     screenshots before the PR, as with the notepad.
   - Rejected: a «Навички» tab beside the notepad. The operator chose a column of its own.
   - Rejected: entries inside the ЦУК conversation. The conversation lives in memory until a
     restart, and «Новий чат» clears it. Entries from another machine, or made while the app was
     closed, would have to be added to it, and the history would be hard to browse.
   - Rejected: a third accordion panel. The window would have three panels, and ЦУК's composer
     would be hidden while that panel is open.

7. **«Відкотити» restores the skill to how it was before that change.** Later changes of the
   same skill are rolled back with it, and the confirmation names them («Також буде скасовано 2
   пізніші зміни»). If that change created the personal copy, the copy is deleted, and the team
   or default text applies again.
   - Rejected: undoing only that change when no later change touched the same text. That
     rollback would sometimes be refused.
   - Rejected: allowing a rollback of the newest change only.

## Defaults not raised in the interview

- **A switch.** «Вдосконалювати навички» in Settings → «ШІ-провайдер», under «Мова спілкування
  агента». It is per user and stored on the cloud profile (`profiles.skill_improvement boolean
  not null default true`). The api caches it like the agent language. It is on by default. When
  it is off, sessions launched afterwards do not get the tool, and a running session's call is
  refused.
- **Who gets the tool.** Managed sessions (omp and claude-code) of kind `agent`, including deep
  analysis, designer and minion runs, and project chats. Native sessions do not get it, because no
  library reaches them. Discussion and review forks do not get it, because they have no server.
  Tester runs do not get it either.
- **The tool.**
  - `improve_skill` takes:
    - `skill`;
    - `edits`, 1–5 pairs of `{ find, replace }`;
    - `summary`, at most 120 characters;
    - `reason`, at most 1 000 characters.
  - `summary` and `reason` are written in the operator's agent language, as finding fields are.
    The replacement text stays in the skill's own language.
  - Its description tells the agent when to call it:
    - the operator corrected how the agent did a kind of task that the skill describes;
    - the skill proved wrong, outdated or missing a step;
    - the agent found a working method that is not obvious, after failed attempts.
  - It also tells the agent when not to call it:
    - a one-off;
    - an environment or setup failure;
    - an attempt that never worked;
    - a claim that some tool does not work;
    - anything specific to one repository, which goes to `report_finding`;
    - secrets, tokens or personal data.
  - It says that most sessions improve nothing and that this is the normal outcome, and that the
    agent continues its task after the call.
- **The text an edit applies to.** The skill as the operator's library resolves it at the moment
  of the call (user, then project, then workspace, then default), read fresh. It is not the file
  materialised at launch, whose frontmatter and scope comment are not part of the text.
- **Refusals.** Each is a tool error the agent can act on:
  - the skill is not in the Kermanych library;
  - the skill is a repository skill (the error names its path and points to `report_finding`);
  - a `find` is missing or not unique (the error carries the current text);
  - the result is over 64 000 bytes (omp's cap for managed skills);
  - it is the sixth improvement in the session;
  - the operator is signed out or the cloud is unreachable («Not recorded; continue your task»);
  - the switch is off.
- **Concurrency.** The api applies improvements of one skill one at a time. It re-reads the row
  right before writing, which catches a write from another machine in between. A `find` that no
  longer matches is refused, and the error carries the current text.
- **The record.**
  - The table `skill_improvements` has `id`, `user_id`, `skill_name`, `team_scope` (`default` |
    `workspace` | `project` | `none`), `team_owner_id`, `created_copy`, `before_body`, `edits`
    (jsonb), `summary`, `reason`, `session_id`, `session_name`, `project_id`, `workspace_id`,
    `state` (`applied` | `rolled_back` | `promoted`), `state_at`, `seen_at` and `created_at`.
  - `team_scope` / `team_owner_id` say what the skill resolves to WITHOUT the personal layer at the
    time of the change (`none`: a skill that exists only as the operator's own row). Sharing writes
    back there, and the entry view compares it with the text the copy started from. (The draft
    named this `base_scope`; once a copy exists, the base of every later change is the copy
    itself, which says nothing about where to share.)
  - `project_id` and `workspace_id` carry no foreign keys: a session may belong to a local-only
    project the cloud has never seen.
  - The text after a change is `before_body` with `edits` applied. It is computed, not stored.
  - RLS: the owner reads and writes their own rows only.
  - An insert trigger keeps the newest 100 records per user.
  - The table joins `supabase_realtime`.
- **The column's data.**
  - After sign-in, the column reads the light columns of the newest 100 records, without
    `before_body` or `edits`.
  - A Realtime binding then keeps the list current. It covers the user's own INSERTs and
    UPDATEs and selects the same light columns.
  - The full record is read when an entry is opened.
  - The binding is per user, not per workspace, because the personal layer is global, and so is
    the column.
- **Unread.** An entry stays new (`seen_at` empty) until it is opened. «Позначити все
  прочитаним» (a ✓ in the column's header, so the title keeps its room) marks the rest. The header
  shows the count, and the mascot wears its dot while anything is new.
- **The toast.** Every new record that arrives through Realtime raises one, on every machine where
  the operator's Kermanych is open. It reads «Я вдосконалив навичку {name}: {summary}», carries
  the action «Переглянути» and stays 10 seconds. The first read after sign-in raises none.
- **The entry view.**
  - It shows a line diff of before and after (computed in core, drawn with the kit's diff rows),
    the reason, the session name, the project, the time and the state.
  - A line says when the team text has changed since the personal copy was made, that is, when
    the team or default text of the skill differs from the text the copy started from.
- **Rollback.** It runs in the browser under the operator's JWT, like every library write from
  the UI. The confirmation also warns when the current text differs from what the latest change
  left, for example after an edit by hand in «Навички». Such edits are rolled back too.
- **«Поширити на команду».**
  - The button appears only for the workspace owner (`projects.isWorkspaceOwner`) and only for an
    applied chain of changes.
  - The target is the scope the skill came from, that project or that workspace. A default skill,
    or one that exists only in the personal layer, goes to the workspace of the record's
    project.
  - Sharing writes the current personal text to the target, deletes the personal copy and marks
    the chain `promoted`.
  - A promoted record cannot be rolled back from the column. The team text is edited in
    «ШІ-команда → Навички».
- **Layout.**
  - The window grows to `min(1440px, 94vw)`, with three columns: the notification column
    (300 px), the console, and the notepad (300 px).
  - Below 1280 px of viewport width, the notification column hides behind a 🔔 button in the
    window's head, which carries the count of new entries, and slides over the console from the
    left. The column's board is opaque for that.
  - Below 900 px, the notepad behaves as it does today.
- **«Посіпака».** Its runs improve skills like any session, because they run as the operator.
  Their entries reach every machine through Realtime.

## Cost estimate

Assumptions per user: a skill text of about 3 KB; 3 improvements a day, each opened once; 3 app
starts a day; up to 5 personal copies; about 15 launches a day, wakes included; and, as today,
two library reads per launch.

- An improvement: the user-row upsert returns the row (~3 KB) and the record insert returns
  nothing. Realtime delivers a light row (~0.4 KB) to each open app.
- Opening an entry: the record (~4 KB) and, for the line about a changed team text, the team rows
  of that name (~3 KB).
- The column after sign-in: at most 100 light rows (~40 KB at most).
- Launch reads: each personal copy adds its text to every library read, which comes to
  5 × 3 KB × 2 × 15 ≈ 450 KB a day.

That totals about 15 MB of egress per user a month, 13.5 MB of it from launch reads. For 10 users
it is about 150 MB a month (3% of Free's 5 GB); for 100 users, about 1.5 GB (30% of Free, 0.6% of
Pro's 250 GB). Fixing finding `1d9d25ba` halves the launch part. Size: at most 100 records of
about 4 KB, about 0.4 MB per user before Postgres compresses the text; for 100 users, about 40 MB
(8% of Free's 500 MB).

## Out of scope

- Other activity kinds in the column.
- ЦУК's chat answering questions about improvements.
- New skills and repository skills.
- A team-wide history or approvals.
- A Hermes-style curator.
- Native sessions.
- The repeated library read at launch (finding `1d9d25ba`).

## Implementation

The branch was fast-forwarded to `origin/dev` (`39ed733c`) before this document, because ЦУК
exists only there.

- **Migration** `kermanych/supabase/migrations/20261104120000_skill_improvements.sql` adds:
  - the table;
  - its RLS;
  - the pruning trigger;
  - the table's place in the Realtime publication;
  - `profiles.skill_improvement`.

  It must be pushed to the hosted project before the client ships (README, «Applying a migration
  to the team's project»).
- **core** — `packages/core/src/skill-improvements.ts`:
  - the record, entry and argument types;
  - `SKILL_IMPROVEMENTS_PER_SESSION` (5), `SKILL_IMPROVEMENTS_KEEP` (100), `SKILL_TEXT_MAX`
    (64 000), `SKILL_EDITS_MAX` (5) and the summary and reason limits;
  - `validateImproveSkillArgs`, `applySkillEdits` (exact-once matching) and `skillTextBytes`;
  - `rollbackPlan` (the records rolled back with a given one, whether the copy goes, the text to
    restore, and whether the copy was edited by hand), `appliedChain` and `copyOrigin`;
  - `shareTarget`;
  - `skillTextDiff`, a line diff shaped like the kit's paired diff rows.

  No new dependency.
- **cloud** — `packages/cloud/src/skill-improvements.ts`: insert that returns only the id, the
  per-session count, the light list, a full read of one record, the applied chain of one skill,
  state and `seen_at` updates, and the Realtime binding with `select`. `skills.ts` gains
  `getAiSkill`; `account.ts` gains a read and a write for the switch.
- **api:**
  - `apps/api/src/skills/skill-improvement.service.ts` resolves the text fresh, refuses, applies
    the edits (re-based once if the personal copy moved), writes the user row and the record, and
    undoes the row when the record cannot be written. Improvements of one skill run one at a time.
  - `apps/api/src/skills/improve-skill-tool.ts` holds the definition (fields asked in the
    operator's agent language) and the call.
  - `browser-mcp.service.ts` lists the tool (a managed `agent` or `chat` session, not a tester
    run, the switch on) and dispatches calls to it unqueued.
  - SQLite `auth_session.skill_improvement`, hydrated in `AuthService.setToken`;
    `GET/POST /account/skill-improvement`.
- **ui:**
  - `stores/notification-center.ts` holds the entries, the unread count, the Realtime binding,
    the toasts, opening an entry, seen, rollback and sharing.
  - `components/assistant/CukNotifications.vue` is the column; `SkillImprovementView.vue` is the
    entry view over the console.
  - `AssistantLauncher.vue` gets the third column, 🔔, the entry view, the dot for new entries
    (`stores/assistant-overlay.ts` needed no change), and Esc that closes an open entry first.
  - The auth store and «ШІ-провайдер» get the switch; i18n `uk` / `en`.
- **README:** the ЦУК section gains «Центр сповіщень»; the Skills section gains «Agents improve
  your skills» with the switch, the limits and the migration note.

## Verification

- **Migration** on a throwaway Postgres (PGlite 0.5, with stubs for `auth.uid()`, `profiles`,
  the `authenticated` role and the Realtime publication):
  - 105 inserts by one user leave the newest 100 (records 1–5 gone, 6–105 kept);
  - a bad skill name, an empty or six-item `edits`, an unknown `team_scope` and an unknown
    `state` are refused by their CHECKs;
  - another user reads 0 of the first user's rows, cannot insert a row in their name (RLS), and
    updates and deletes 0 of them;
  - `profiles.skill_improvement` defaults to `true`; the table is in `supabase_realtime`; the four
    `*_own` policies exist.
- **Suites** (at most 4 workers, one at a time):
  - `@kermanych/core` — 29 files, 348 tests, including `skill-improvements.spec.ts` (argument
    rules, exact-once edits, rollback plans with later changes, a created copy, hand edits and a
    gone copy, the share target, the line diff).
  - `@kermanych/cloud` — 13 files passed, 2 skipped (the RLS suites need a local stack); 203 tests,
    including `skill-improvements.spec.ts` (mapping, the light list, seen marks, the binding's
    filter and `select`) and the switch in `account.spec.ts`.
  - `@kermanych/api` — typecheck clean; 132 files passed, 1 skipped; 1401 tests, including
    `skill-improvement.spec.ts` (every refusal, a write with the right team scope and copy flag,
    re-basing, the undo when the record fails, the cap) and the tool's place in `tools/list`.
  - `@kermanych/ui` — 86 files, 939 tests, including `notification-center.spec.ts` (bind before the
    first read, no toast for old records, one toast per new record whose «Переглянути» opens and
    marks it, updates from elsewhere, a refused seen mark, sign-out, both rollback paths).
    `vue-tsc` reports only the unbuilt `@kermanych/api` in `src-electron`, as before.
- **Live preview** (web build, cloudless, entries injected into the store):
  - at 1440 × 900 the window shows the column, the console and the notepad; the mascot wears its
    dot while an entry is new;
  - a slip opens the entry view over the console: summary, session and project, the reason, the
    «team text changed» line, the diff with the replaced line paired, «Відкотити»; Esc closes the
    entry, keeps the window open and gives the keyboard back to ЦУК's composer;
  - at 1180 px the column hides behind 🔔 with the count and slides over the console, opaque;
  - dark and light themes; Settings → «ШІ-провайдер» shows «Вдосконалювати навички», on.
- **Live agent:** a managed omp chat in the preview api, on a throwaway repository, was asked to
  call the tool. It found `improve_skill` through the omp MCP bridge, called it, and got «Not
  applied: Kermanych is not signed in to the cloud, where the skill library lives. Continue your
  task.» — the preview api is not signed in.
- **Not exercised:** a successful write against a real cloud — the user row, the record, the
  Realtime toast on a second machine, a rollback and a share. The preview has no cloud, and Docker
  is not running here for a local Supabase stack. Check them with a signed-in user once the
  migration is applied.
- **The column's look** (decision 6), saved in `docs/design/2026-11-04-cuk-notifications/`:
  `notifications-a-clipboard@1440.png` (built; also `-light`), `notifications-b-tape@1440.png`
  and `notifications-c-cork@1440.png` (drawn by overriding the CSS in the page, not in the code).

## Documentation impact

`kermanych/README.md`:

- «ЦУК — the avatar's control console» gains «Центр сповіщень». It covers what the column shows,
  the toast, rollback and sharing with the team.
- «Skills («ШІ-команда → Навички»)» gains how agents improve skills. It covers what may change
  and where it lands, the switch, and the limits.
- The migration that must be applied before the client ships.
