# «Знахідки»: report first, ask only about the overlap

- **Date:** 2026-10-16
- **Scope:** `apps/api` (`report_finding` description), `packages/core` (default `deep-analysis`
  skill), README «Agent findings».
- **Builds on:** `docs/specs/2026-10-13-agent-findings.md`, `docs/specs/2026-10-08-deep-analysis-task.md`.

## Goal

The operator asked (deep-analysis session, 2026-10-16): an agent offered to fix a bug unrelated
to its task. Why did it not hand the bug over as a «Знахідка»?

## What happened

Session `a646c2a1-c57f-4666-afd6-a28c51479850` (omp, `claude-opus-5-5`, «Глибокий аналіз», repo
`fs-back-end`, branch `feature/u-nas-ie-funktsional-vidpravky-povidomle`). Evidence: its omp
transcript `~/.omp/agent/sessions/-.kermanych-worktrees-a646c2a1-…/2026-10-09T13-04-44-191Z_….jsonl`.

1. **The problems predate the tool.** Problems №1–№5 were found on 2026-10-09, when the session
   declared 27 tools and none of them was a findings tool. On 2026-10-13 05:48 (still 27 tools) the
   agent asked interview question 8, «what do we do with №1/№2?», and proposed recording them in
   `TODO/backend/code-issues.md`, as `fs-back-end/CLAUDE.md:28-29` requires. The findings feature
   is dated 2026-10-13. The first `session_findings` row is from 2026-10-14.
2. **The tool arrived mid-conversation.** On the 2026-10-16 resume, message 155's
   `requestControls.tools` declared 29 tools. `report_finding` and `list_findings` were listed as
   `deferred`, which is omp's term for tools added after the conversation started. The model saw
   them: its answer says «Я оформлюю її як finding для дошки Kermanych».
3. **The model chose to ask.** Its reasoning in that turn: «Issues #1 and #2 are outside the
   current scope, so I could report them as findings, but given the step-by-step request, I
   should focus on asking about each problem individually.» It folded the finding into option A
   of question 8.1 instead of calling the tool. Three things pushed it that way:
   - Question 8 was still open in the interview, and the operator had answered «Йдемо крок за
     кроком».
   - The `deep-analysis` skill makes the agent settle every decision with the operator, scope
     included, and forbids code changes until the operator approves. Meanwhile the
     `report_finding` description (`apps/api/src/findings/findings-tools.ts:19-25`) says «record
     the finding and continue», but nowhere says «do not ask before reporting».
   - Problem №1 partly overlaps the task (the Telegram token becomes write-only there). Only the
     Poster, Portmone, Cashalot and 1C keys lie outside it. Problem №2 (a hard-coded token) is
     wholly outside the task and was not reported either.

Nothing is broken in the code: the tool reached the session. What needs changing is the agent's
instruction.

## Decisions

1. **Report first, ask only about the overlap.** When an agent notices a problem outside its
   task, it calls `report_finding` at once. That includes a deep-analysis session in the middle
   of its interview, because reporting changes no code. In its reply it mentions what it
   recorded. It asks the operator only about the part of a problem that overlaps its task. A
   finding is already a proposal that the operator files or dismisses, so asking permission to
   record it costs the operator a turn and gains nothing.
   - Rejected: keep today's behaviour (asking first is acceptable). That leaves «Знахідки» empty
     while the problem sits in the interview, which is the behaviour the operator questioned.
   - Rejected: always ask before reporting. That contradicts decision 6 of the findings spec:
     «Do not get side-tracked. Record it and continue.»

2. **The rule goes in two places: the tool description and the default `deep-analysis` skill.**
   - At the end of the `report_finding` description's rules (`findings-tools.ts`), add: «Report
     right away; do not ask the operator whether to report: the finding is itself the proposal,
     and they can dismiss it. This holds while planning or interviewing too, because reporting
     changes no code. If the problem partly overlaps your task, report the part outside it and
     raise only the overlap.» Every runtime and every session reads this.
   - In step 2 of the `deep-analysis` default skill (`packages/core/src/skills.ts`), add: «A
     problem outside the task is not an interview question: report it with `report_finding` if
     you have that tool, and ask only about the part that overlaps the task.» This is where the
     conflict arose: the model weighted the skill's interview step above the general tool
     description. The phrase «if you have that tool» is there because discussion and review forks
     get no `kermanych` server.
   - Known limit: a project, workspace or repository that overrides `deep-analysis` does not get
     the skill line. The tool description still applies.
   - Rejected: the tool description only. It keeps decision 6 of the findings spec in its
     narrowest form, but in deep analysis the skill would keep pulling problems into the
     interview. Rejected: the skill only. Ordinary sessions would still be free to ask
     permission first.
   - `deepAnalysisPrompt` (`packages/core/src/deep-analysis.ts`) stays unchanged: it names the
     steps, and the skill describes how to do each one.

3. **Nothing is said about a project's own bug tracking.** Repository rules such as
   `fs-back-end/CLAUDE.md`'s `TODO/backend/code-issues.md` still apply alongside findings, and
   the agent in this session planned both. No transcript shows an agent choosing one channel over
   the other.
   - Rejected: a «does not replace the project's rules» sentence. It would cost every session
     context to guard against a problem nobody has seen.
   - Rejected: findings replace the project's tracking. A Kermanych tool must not override the
     repository's own instructions.

### Out of scope

- Reporting problems found before a session got the tools. The operator can ask the agent to
  report them; in the session above that means №1 (outside the Telegram part) and №2.
- How omp announces tools added mid-conversation (`deferred`).

## Changes

- `apps/api/src/findings/findings-tools.ts`: the `report_finding` description gains the
  sentence from decision 2.
- `packages/core/src/skills.ts`: step 2 of the `deep-analysis` body gains the line from
  decision 2.
- `kermanych/README.md` «Agent findings («Знахідки»)»: the agent reports at once, without asking
  you first, including during a deep-analysis interview. It asks only about a part that overlaps
  its task.

No test pins either text: `browser-mcp.spec.ts` checks only the browser tools' wording, and
`deep-analysis.spec.ts` checks only that the skill exists. No new test, because a test would only
pin wording.

## Verification

- `pnpm --filter @kermanych/core test` and `pnpm --filter @kermanych/api test` stay green,
  apart from the failures already recorded on the base commit.
- Smoke (the findings spec's setup): a preview api (`KERMANYCH_PREVIEW=1`) with a seeded
  project rebound to a throwaway git repo. The repo holds a task-unrelated bug, and its task has
  a decision worth asking about.
  - A managed omp session started with the deep-analysis prompt and the default skill must call
    `report_finding` before or alongside its first interview question, without offering
    «record it as a finding?» as an option. The finding then appears under `GET …/findings`.
  - In an ordinary managed session with an unrelated question, the agent must report at once
    without asking first.

## Documentation impact

`kermanych/README.md`, section «Agent findings («Знахідки»)», as listed under Changes.
