# Skill self-improvement: a reflection step and a level setting

- **Date:** 2026-11-06
- **Branch:** `feature/investigate-self-learning-no`
- **Builds on:** `docs/specs/2026-11-04-skill-self-improvement.md` (PR #250). This document
  amends decision 2 and the «A switch» default of that spec.
- **Scope:** `kermanych/supabase/migrations` (one migration), `packages/core` (the level type,
  the lesson rules, the reflection block), `packages/cloud` (`account.ts`), `apps/api` (the
  SQLite cache, `/account/skill-improvement`, the tool description and gates, the three
  Kermanych turns), `apps/ui` (the Settings select, i18n `uk` / `en`), `kermanych/README.md`.
- **Status:** decisions agreed with the operator in the deep-analysis interview (2026-11-06),
  approved the same day; implemented on this branch (see «Verification — results»).

## Problem

The operator worked for two days after PR #250 was merged (2026-11-05 08:26) and saw no skill
improvement.

What the machine shows:

- **The agents never called the tool.** 72 omp transcripts in `~/.omp/agent/sessions` changed after
  the merge. `improve_skill` was among the declared tools in 31 sessions, and it was called **0**
  times. In the same transcripts `report_finding` was called 30 times and `report_outcome` 18 times,
  so the session's `kermanych` MCP server works.
- **The cloud is ready.** On the hosted project, `GET /rest/v1/skill_improvements` answers
  `200 []`, while a missing table answers `404 PGRST205`. The migration of PR #250 is applied.
- **The switch is on.** With it off, the tool is not listed.

Why the agents do not call it:

1. **No moment.** Decision 2 left the call to the agent's own judgement in the middle of its work.
   No trigger, no review. An agent busy with its task does not stop to look back.
2. **The description discourages it.** «Most sessions improve nothing, and that is the normal
   outcome» (`apps/api/src/skills/improve-skill-tool.ts:32`). Hermes says the opposite: «Be ACTIVE».
3. **The end of the work forbids it.** Most sessions of these two days went «task → «Створити ПР»».
   `PULL_REQUEST`, `COMMIT` and `DESIGN_SAVE` (`packages/core/src/agents.ts`) end with «Do only
   this.», which forbids side actions at exactly the point where the session's work is done.

## Decisions

1. **A reflection step in Kermanych's own turns.** A block is appended after the rendered
   instruction. It asks the agent to review the session for lessons about the library skills it
   used, and to call `improve_skill` for each one it has not recorded yet.
   - It is appended the way `baseSyncBlock` is. It comes after the default text or the operator's
     override, and it says «This step is Kermanych's own and applies whatever the instruction
     above says». An overridden template therefore keeps it, and «Do only this» does not cancel it.
   - It adds no turn to the session. The operator already sends these turns.
   - It runs before the agent's reply, so the PR URL is still the reply's last word.
   - Rejected: only rewriting the tool description. The agent would still have to remember the
     tool in the middle of a task, which is the cause.
   - Rejected: a background reviewer after the session, like Hermes. It costs one model run per
     session, and Hermes floods with it (#99661).
   - Rejected: a «Чого навчився?» button. It works only when the operator thinks of it.
   - Decision 2 of the 2026-11-04 spec rejected «an automatic turn after «Створити ПР»». This step
     is not a new turn but a paragraph in a turn the operator already runs.

2. **The step goes into three turns.**
   - «Створити ПР» (`PULL_REQUEST`, `SupervisorService.createPullRequest`). A «Посіпака» run's PR
     goes through the same turn after `report_outcome`, so minion runs are covered.
   - «Закоміти» (`COMMIT`, `commitChanges`). This is the follow-up after review, where the
     operator's corrections land.
   - «Зберегти дизайн» (`DESIGN_SAVE`, `saveDesign`). The Дизайнер works with the operator turn by
     turn, and `design-spec` gets its lessons from there.
   - A session can reach these turns several times. The block asks only for lessons «not yet
     recorded in this session». The cap of 5 improvements per session stays.
   - Rejected: «Створити ПР» only. The lessons from review follow-ups and from design would be
     lost.

3. **The bar is a setting with four levels.** It replaces the switch «Вдосконалювати навички».
   The operator wants to try every level.

   | Level | Value | When the agent records a lesson |
   |---|---|---|
   | Вимкнено | `off` | Never: no tool, no reflection step, and a running session's call is refused. |
   | Обережно | `conservative` | The operator corrected how the agent did a kind of task that a skill describes, or a skill proved wrong, outdated or missing a step. A non-obvious method found after failed attempts counts too. |
   | Помірно (default) | `moderate` | All of «Обережно», plus repeated friction: the agent went wrong more than once on a step the skill should have foreseen, or the operator had to clarify something the skill could have said up front. |
   | Активно | `active` | The agent looks for at least one lesson in every skill it used: a missing step, an unclear rule, a correction, a method that worked after failed attempts. |

   - Every level keeps the same exclusions. A one-off is not a lesson, nor is an environment or
     setup failure, an attempt that never worked, or a claim that some tool does not work. A fact
     about one repository goes to `report_finding` as an `AGENTS.md` / docs proposal. Secrets,
     tokens and personal data are never recorded. Each edit is still a general rule with a short
     why, not a story of the session.
   - The level's rule appears in two places: the tool description and the reflection block. Both
     come from one core function, so they cannot drift apart.
   - The sentence «Most sessions improve nothing, and that is the normal outcome» is removed.
   - **When a change takes effect.** The reflection block is built when the turn is sent, so a new
     level applies at once, even in running sessions. The tool description reaches the agent at
     launch, so there a new level applies to sessions launched afterwards. A call is gated by the
     level at the moment of the call (`off` refuses).
   - The default is «Помірно». The current behaviour is roughly «Обережно», and it produced nothing.
   - Rejected: a separate level select under the kept switch. That makes two fields, and with the
     switch off the select means nothing.

4. **The reflection's outcome is not written into the reply.** The operator sees improvements
   through the toast and «Центр сповіщень» only.
   - Accepted consequence: a session where the agent skipped the step looks the same as one where
     it found no lesson.
   - Rejected: a «Навички: …» line at the end of the reply, which adds noise to every PR reply.
   - Rejected: a silent counter. It is new bookkeeping, and it cannot tell skipped from
     found-nothing either.

5. **Ratings are not part of this task.** A grade, explicit or hidden (tester failures, the number
   of corrections), does not say which skill to change or how. The lesson's content comes from the
   transcript, which the reflection step already reads. With one operator and 15–30 sessions a day,
   a change in grades cannot be tied to a change in a skill.
   - Deferred, with the condition to return: after one or two weeks of the reflection step, if
     «Центр сповіщень» shows too few or wrong improvements, a 👎 with a comment as a trigger, or
     the tester's failure rate as a measure of whether improvements help, is a separate task.

## Defaults not raised in the interview

- **Who gets the block.** The same sessions that get the tool: managed omp sessions of kind
  `agent` (deep analysis, designer and minion runs included) and project chats, but not native
  sessions or tester runs, and only while the level is not `off`. A project chat has none of the
  three turns, so it keeps only the tool. A session whose running agent was launched while the
  level was `off` has no tool in its list. If the level is switched on later, that session gets
  no block until its agent is relaunched and lists the tool again. The api remembers which
  sessions were listed without the tool, not which were listed with it: a dormant session's turn is
  built before the respawn that lists its tools, and it must still get the block.
- **The migration** (`supabase/migrations/20261106120000_skill_improvement_level.sql`):
  - adds `profiles.skill_improvement_level text not null default 'moderate'` with a check over
    `off | conservative | moderate | active`;
  - carries the old switch over: `false` → `off`, `true` → `moderate`;
  - drops `profiles.skill_improvement` in the same migration, as earlier migrations did
    (`20261103100000_project_platform.sql`, `20260915120000_drop_task_doc_report.sql`).
  - Teammates on an older build: their api reads the old column, gets an error and keeps
    «unknown = on», which is already its fallback. Their Settings switch shows a save error until
    they update. It is pushed to the hosted project before the client ships (README, «Applying a
    migration to the team's project»).
- **core.** `SkillImprovementLevel`, `SKILL_IMPROVEMENT_LEVELS` and `DEFAULT_SKILL_IMPROVEMENT_LEVEL`
  (`moderate`), `isSkillImprovementLevel`. `skillLessonRule(level)` holds the level's criteria and
  the common exclusions. `skillReflectionBlock(level)` wraps that rule in the block's frame.
- **cloud.** `getMySkillImprovementLevel` / `setMySkillImprovementLevel` replace the boolean pair in
  `account.ts`.
- **api:**
  - SQLite `auth_session.skill_improvement_level TEXT` replaces `skill_improvement`; an unknown
    value counts as `moderate`. `AuthService.setToken` hydrates it.
  - `GET /account/skill-improvement` → `{ level }`; `POST` takes `{ level }` and refuses anything
    else with 400.
  - `improveSkillTool(language, level)` builds the description from `skillLessonRule`.
    `BrowserMcpService` lists the tool while the level is not `off`.
    `SkillImprovementService` refuses with the existing «turned off» text when it is `off`.
  - `createPullRequest`, `commitChanges` and `saveDesign` append `skillReflectionBlock(level)`
    after their other Kermanych blocks when the session qualifies (see «Who gets the block»).
- **ui.** In Settings → «ШІ-провайдер», a select «Вдосконалювати навички» replaces the switch:
  «Вимкнено / Обережно / Помірно / Активно», each with a one-line hint. It writes the cloud first,
  then POSTs the api, as the switch does now. «ШІ-команда»'s preview of the PR / commit / design-save
  instruction shows the block next to the base-sync preview (`AiAgentEditor.vue`,
  `AiAgentReadonly.vue`).
- **Docs.** The README section on self-improvement (`kermanych/README.md`, around line 1808)
  describes the levels, the reflection step and the new route body. The 2026-11-04 spec gets one
  line in its status that decision 2 and the switch are amended here.

## Verification

- **Migration** on a throwaway Postgres (PGlite): the default is `moderate`, `false` becomes `off`,
  the check refuses other values, and the old column is gone.
- **core unit tests:**
  - every level's rule contains its criteria and the shared exclusions;
  - `active` alone asks for at least one lesson;
  - the block names `improve_skill` and «not yet made in this session».
- **api unit tests:**
  - the three turns carry the block for a qualifying session at a non-`off` level, also with an
    overridden template;
  - they do not carry it at `off`, for a native session or for a tester run;
  - `tools/list` and the call follow the level;
  - the route accepts the four values and refuses others.
- **Suites** `@kermanych/core`, `@kermanych/cloud`, `@kermanych/api` (typecheck + tests), one at a
  time, at most 4 workers.
- **Live**, in the preview with a signed-in operator:
  - a managed omp session that used a library skill;
  - the operator corrects how the agent followed that skill, then presses «Створити ПР»;
  - the transcript shows the block and an `improve_skill` call;
  - the toast and the «Центр сповіщень» entry appear;
  - the same at `off` shows no block and no tool.
  If the preview cannot sign in to the cloud, the live check is reported as not exercised, as in
  the 2026-11-04 spec.

## Verification — results

- **Migration** on PGlite, over a `profiles` table with the old switch: `true` → `moderate`,
  `false` → `off`, a new row gets `moderate`, `'eager'` is refused by
  `profiles_skill_improvement_level_check`, and `skill_improvement` is gone. The hosted project
  has not been migrated yet.
- **SQLite cache:** a database left by the previous version with a cached «off» reopens at `off`,
  and its `skill_improvement` column is dropped (`registry.auth.spec.ts`). A refreshed token of the
  same user keeps the cached level until the cloud read replaces it (`AuthService.setToken`).
- **Unit tests:**
  - `@kermanych/core`: the level's rules and the block (`skill-improvements.spec.ts`);
  - `@kermanych/cloud`: the level read and write (`account.spec.ts`);
  - `@kermanych/api`: the gates, the description per level, and the step for dormant, launched-off,
    native and chat sessions (`skill-improvement.spec.ts`); the three turns ending with the step,
    an overridden PR instruction, and `off` (`supervisor.pr.spec.ts`); the route
    (`account.controller.spec.ts`).
- **Suites**, one at a time, at most 4 workers:
  - `@kermanych/core`: 30 files, 365 tests;
  - `@kermanych/cloud`: 13 files passed, 2 skipped, 204 tests;
  - `@kermanych/api`: typecheck clean, 127 files passed, 1 skipped, 1333 tests;
  - `@kermanych/ui`: `vue-tsc` clean, 87 files, 947 tests.
- **Preview:**
  - `GET /api/account/skill-improvement` answers `{"level":"moderate"}`, and `POST` with `eager`
    answers 400.
  - Settings → «ШІ-провайдер» shows the select with its four levels and the hint of the chosen one.
  - «ШІ-команда → Провізор» lists the step under «Що Керманич додає сам».
  - The step's preview under the instruction needs the cloud's agent rows, which the preview cannot
    read, so it was not seen.
- **Live agent**, a managed omp chat in the preview api, on a throwaway repository:
  - The agent read `task-spec` and wrote a task document without rejected alternatives.
  - The operator then corrected it («I ask for this every time»). With the new `moderate`
    description, the agent called `improve_skill` on `task-spec` at once. The edit turned the
    «Decisions» line into a general rule: every document names its rejected options.
  - A later turn ended with `skillReflectionBlock("moderate")`, and the agent called the tool again
    before it answered.
  - Both calls got «Not applied: Kermanych is not signed in to the cloud», because the preview api
    is not signed in.
  - A chat has no «Створити ПР», so the block was sent as the tail of a message.
- **Not exercised:**
  - a successful write against the real cloud (record, toast, «Центр сповіщень»);
  - the select's save, which needs the cloud;
  - a real «Створити ПР» turn of a managed agent session. A preview agent session needs a cloud
    card, so `supervisor.pr.spec.ts` covers this path with a fake RPC.
