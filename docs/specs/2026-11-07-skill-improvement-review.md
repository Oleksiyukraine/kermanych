# Skill improvements: a review of the first 12, a stricter bar, and a clean slate

- **Date:** 2026-11-07
- **Branch:** `feature/review-skill-improvement-suggestions`
- **Builds on:** `docs/specs/2026-11-04-skill-self-improvement.md`,
  `docs/specs/2026-11-06-skill-improvement-reflection.md`. This document amends decision 3 of the
  latter (what «Активно» asks for, and the exclusions shared by every level).
- **Scope:** `packages/core` (the lesson rules, five default skills, the PR and base-sync
  prompts), `apps/api` (a staleness check in `SkillImprovementService`), `apps/ui` (the level
  hint), `kermanych/README.md`, and a one-time clean-up of the operator's own cloud rows.
- **Status:** decisions agreed with the operator in the deep-analysis interview (2026-11-07);
  waiting for approval.

## Problem

The operator set «Вдосконалювати навички» to «Активно» and in one evening got many notifications.
The worry: most of them improve for the sake of improving.

What the cloud and the transcripts show (`skill_improvements`, `~/.omp/agent/sessions`):

- **12 records.** 9 were made between 2026-11-06 20:39 and 21:22, from 4 sessions. 3 more came
  on 2026-11-07. None was rolled back. All five changed skills are Kermanych defaults, so each
  first change created a personal copy that now outranks the default.
- **A quota, not a bar.** Every reflection step on 2026-11-06 (4 of 4) produced exactly one
  lesson per library skill the session had used. The `active` rule asks for that: «Look for at
  least one improvement in every library skill you used … Most sessions that used a skill show
  something it could say better» (`packages/core/src/skill-improvements.ts`, `LESSON_WHEN.active`).
- **Lessons without an event.** Only 1 of the 9 rests on an operator correction. Record 4 describes
  a push failure that did not happen: the push went through on the first try over SSH.
- **Parallel sessions duplicate a lesson.** Within 4 minutes, three sessions tried to record the
  same SSH-remote lesson in `kermanych-pull-request`. Two edited different fragments and both
  landed (records 4 and 5); the third was refused only because its `find` had gone stale. Each
  agent sees the skill as its launch materialised it.
- **A prompt bug fixed in the wrong place.** Records 4 and 5 patch Kermanych's own «Створити ПР»
  instruction, which tells the agent to run `GH_TOKEN="$TOKEN" git push` without
  `gh auth setup-git` (`packages/core/src/agents.ts:258`). The «Закоміти» instruction names that
  step (`agents.ts:296`). `baseSyncBlock` says only «apply `GIT_TOKEN` to [the fetch] exactly as
  you apply it to the push» (`agents.ts:324`), and the three sessions each invented a different
  way to do it. The lessons landed in the operator's personal copy, and the instruction stayed wrong
  for everyone. Filed as finding `fa490f82` and fixed here (decision 5).
- **Growth.** In one evening `kermanych-pull-request` grew from 1521 to 2849 bytes, `deep-analysis`
  from 928 to 1757, and `minion-findings` from 1184 to 1973.

### The 12 records

| # | Skill | Lesson | Basis | Verdict |
|---|---|---|---|---|
| 1 | deep-analysis | an ambiguous answer is restated as options; an unmeasured claim is an assumption with a measurement | the operator's «має бути два варіанти» read three ways | into the default |
| 2 | task-spec | Verification ends with what was not verified | the agent had to correct its own spec | into the default |
| 3 | deep-analysis | look for an earlier removed attempt; look at the current screen before offering UI placements | **operator correction** (a screenshot of «Центр сповіщень») | into the default |
| 4 | kermanych-pull-request | «`GH_TOKEN` is read by `gh` only, never by `git`» + an inline credential helper | no failure happened; the claim is wrong with `gh auth setup-git` | dropped; the PR prompt is fixed instead (decision 5) |
| 5 | kermanych-pull-request | check whether the remote is SSH or HTTPS | a duplicate of 4 from a parallel session | dropped; one sentence in the PR prompt (decision 5) |
| 6 | qa-tester | name the surface (desktop app, platform, role) inside the item | resolves a conflict between two existing rules | into the default |
| 7 | minion-findings | record test counts before and after a tech-debt change; a fresh worktree fails for setup reasons | real confusion in a minion run | the counts go into the default; the setup part is dropped (an environment failure, and fixed in this repository by PR #262) |
| 8 | kermanych-pull-request | after a merge, tell a base or flaky failure from your own; `pnpm -r` stops at the first failing package | real, but `baseSyncBlock` step 4 already says «report, do not fix» | dropped |
| 9 | minion-findings | two baselines when the card is itself about the setup | a one-off | dropped |
| 10 | task-spec | take the spec location from the repository; later fixes on the branch go into the document before the PR | real: the operator's follow-ups never reached the document | into the default (the «no placeholder» sentence is dropped) |
| 11 | minion-findings | a criterion that lives in another repository is named as open, not passed over | a real backend + fs-admin card | into the default |
| 12 | minion-findings | prove «fails without the fix» by stashing only the production files | a working method | into the default |

Kept: 8 of the 12 records, wholly or in part. Dropped as noise: 4, 5, 8, 9.

## Decisions

1. **Scope: the review plus the mechanism.** Cleaning the records alone would refill them the next
   evening, because the quota stays in the `active` text.
   - Rejected: only the review; only the mechanism.

2. **«Активно» loses its quota, and every level demands an event.**
   - `active` keeps its breadth: the agent reviews every library skill it used. But it is no
     longer asked for «at least one», and «Most sessions … show something» goes.
   - A sentence shared by every level, next to the exclusions: a lesson rests on something that
     happened in this session (an operator correction, a command that failed or had to be redone,
     a wrong step that had to be undone), and `reason` names it. A risk that could have happened
     («if the remote were HTTPS») is not a lesson.
   - Rejected: dropping only the quota (a hypothetical risk still passes); leaving the text and
     switching to `moderate` (the level the operator chose is not what is broken); removing
     `active`.

3. **A stale view is refused once.** When the skill's text has changed since the session was
   handed it (by another session, by hand in «Навички», by a rollback), the session's first
   `improve_skill` call for that skill is refused. The refusal carries the current text and the
   `summary` of every recorded change since, and asks the agent to call again only if its lesson is
   not covered yet, with `find` copied from the new text. The second call goes through as usual.
   - «Handed» means the text the session's latest launch resolved (the materialised library).
     Changes the session made itself do not count. An api restart forgets what was handed; then no
     call is refused for staleness.
   - Rejected: only an instruction to give up when a refusal shows the lesson (the 4/5 pair had no
     refusal); doing nothing.

4. **A flaw in Kermanych's own instruction goes to `report_finding`.** The shared exclusions gain:
   an error or gap in Kermanych's own turn text (the «Створити ПР», «Закоміти» and «Зберегти
   дизайн» instructions, the base-sync step, this reflection step) is reported with
   `report_finding`, never patched in a skill, even one that describes the same action.
   - Rejected: a skill patch until the prompt is fixed (two instructions that contradict each
     other, and a patch nobody removes); nothing (3 of 3 sessions chose the skill, none filed a
     finding).

5. **The PR prompt bug is fixed** (finding `fa490f82`), in place of records 4 and 5.
   - `PULL_REQUEST` gets the step that `COMMIT` already has: `GH_TOKEN="$TOKEN" gh auth setup-git`
     before the push, so git over HTTPS takes the token through `gh`.
   - `baseSyncBlock` step 1 spells the fetch out: the same `GH_TOKEN="$TOKEN"` prefix after that
     setup, instead of «exactly as you apply it to the push».
   - Both auth blocks gain one sentence: an SSH remote (`git@…` or a host alias) authenticates
     `git` with its key and needs no token, while every `gh` call still does.

6. **«Посіпака» stays like every session.** It follows the operator's level with the new rules.
   - Assumption (measured, not argued): the volume came from the quota, and minion runs do find
     real gaps (record 7). Measure: after one week, count the minion records and the share of
     them rolled back. Above half, revisit a cap at `conservative` for minion runs as a separate
     task.
   - Rejected: no tool and no step for minion runs; a fixed cap at `conservative`.

7. **What is worth keeping goes into Kermanych's defaults, and the operator's history starts
   empty.** The operator's request: «Все що критично важливе … додати через код. А всі сповіщення
   можна буде видалити».
   - The «into the default» rows of the table land in `DEFAULT_SKILLS` (`packages/core/src/skills.ts`),
     reworded tersely as general rules. `kermanych-pull-request` gets nothing from the records: decision
     5 covers its part.
   - Then, once the operator's Kermanych runs the build with the new defaults, a one-time clean-up
     under the operator's JWT deletes:
     - every row of `skill_improvements` with `user_id` = the operator (RLS `skill_improvements_delete_own`);
     - the operator's user-scope `ai_skills` rows of the five changed skills (`deep-analysis`,
       `task-spec`, `qa-tester`, `minion-findings`, `kermanych-pull-request`), so the defaults apply
       again.
     Other user-scope rows (`matrix-is-here`) are not touched.
   - Why not through the UI: «Відкотити» in «Центр сповіщень» rolls a skill back with its later
     changes and deletes the copy (5 clicks, one on each skill's earliest entry), but the entries stay
     in the list marked «відкочено». The UI has no delete, and this task adds none.
   - Order matters: deleting the copies before the new defaults run would drop the kept lessons in
     between. Deleting them without the new defaults would leave the noise in the defaults' place.
   - Rejected: deleting the records only (the copies keep outranking the defaults, so the next
     default update would not reach the operator); a «Очистити історію» button (a one-time need).

## Changes

- **core, `skill-improvements.ts`:**
  - `LESSON_WHEN.active`: the review of every used skill, without «at least one» and without «Most
    sessions …».
  - `LESSON_NEVER` (shared): the event requirement (decision 2) and the Kermanych-instruction
    exclusion (decision 4).
- **core, `skills.ts`:** `deep-analysis` (records 1, 3), `task-spec` (2, 10), `qa-tester` (6),
  `minion-findings` (7 counts, 11, 12). The harness-skills byte test stays green
  (`apps/ui/test/assignments.spec.ts`, under `ASSIGNED_BYTES_WARN`).
- **core, `agents.ts`:** `PULL_REQUEST`, `COMMIT`, `baseSyncBlock` (decision 5).
- **api, `skills/`:**
  - The handed texts: the latest launch's resolved body per session and skill, kept in memory,
    recorded where the supervisor materialises the library (`ompSkills`) and updated by the
    session's own successful improvement.
  - `SkillImprovementService.apply`: compares the fresh text with the handed one before the edits
    and refuses once per session and skill (decision 3), with the current text and the summaries
    of the records created since that launch.
- **ui:** the «Активно» hint in `i18n/uk` and `i18n/en` no longer promises «at least one lesson».
- **Docs:** `kermanych/README.md`, «Agents improve your skills»: the `active` line, the shared
  event requirement, the Kermanych-instruction exclusion, the staleness refusal.

## Verification

- **core unit tests (`skill-improvements.spec.ts`):**
  - no level's rule asks for «at least one»;
  - every level's rule carries the event requirement and the Kermanych-instruction exclusion.
  The existing test that pinned «`active` alone asks for at least one lesson» is replaced.
- **core, the prompts:** `PULL_REQUEST` and `COMMIT` both carry `gh auth setup-git`, and
  `baseSyncBlock` names the fetch command.
- **api unit tests (`skill-improvement.spec.ts`):**
  - the text changed by another session after launch: the first call is refused with the current
    text and the other change's summary, and the second call applies;
  - the session's own earlier change: no refusal;
  - nothing handed (an api restart): no refusal.
- **Suites** `@kermanych/core`, `@kermanych/api`, `@kermanych/ui` (typecheck + tests), one at a
  time, at most 4 workers.
- **Clean-up:** after it runs, `GET /rest/v1/skill_improvements` answers `[]`, and the five
  user-scope `ai_skills` rows are gone, while `matrix-is-here` stays.
- **Live** (if the preview can sign in to the cloud): a session at `active` that used a skill
  without any correction ends «Створити ПР» with no `improve_skill` call. Otherwise it is reported
  as not exercised.
