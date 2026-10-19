# Release notes name every change, however long the period

## Goal

A note over a month or more — especially the per-person note — described some changes and
then said «45 additional changes were made» without saying which. Every change the period
contains must be named in the note: the reader always sees what each person did, never only
a count.

## Context

- `apps/api/src/management/release-notes-prompt.ts` printed the commits into the prompt up to
  `MAX_COMMITS_CHARS` (48k chars), cutting **whole commits** at the cap. A busy month passes it
  easily (this repository, 2026-09-01 — 2026-10-19: 351 commits with long bodies).
- The prompt then told the model, per person, «if a person's commits are not in the list,
  write in one sentence how many changes they made — do not invent which», and, for the
  count line, «summarise the rest carefully». Authors at the end of the roster (fewest
  commits) were the ones cut — and became a count.
- Independently, both layouts told the model to fold invisible work (refactoring,
  dependencies, CI) into one sentence «or skip it».

## Decisions

- **No commit is ever dropped from the prompt; bodies give way instead.** Every subject line
  is always printed. When subjects and bodies exceed the per-project budget, bodies are kept
  shortest first while they fit (whole bodies only — a sliced body reads as a finished
  sentence) and the longest go. The count line tells the model how many bodies were left out
  and that those commits still belong in the note. Rejected: keeping the budget by commits —
  that is the bug.
- **A hard ceiling on subjects, refused up front.** `MAX_SUBJECT_CHARS` (160k chars, roughly
  1,500+ commits) bounds the prompt now that subjects are never cut. Past it,
  `ReleaseNotesService.generate` refuses with `too_many_commits` (`{ count, from, to }`) before
  any spawn. Rejected: silently cutting past the ceiling — it reintroduces the incomplete note;
  rejected: no ceiling — the prompt could overflow the model's context and the reply could not
  list that many changes within one turn.
- **Compact, not short.** The prompt requires every commit to be reflected, alone or merged
  with related commits into one bullet that says what changed; forbids replacing changes by a
  count («and 45 other changes», «various improvements», «N commits») and any commit count in
  the document. Visible changes get a sentence about the benefit; small ones a bullet of a few
  words.
- **Per person:** visible work first, then a «**Smaller changes**» line with short bullets for
  the rest; a person whose work is all small gets only that list. Bots: one closing sentence
  naming what they updated (no longer «or skip»).
- **By topic:** a fourth group, «Maintenance», last, for work a user does not see — short
  plain-language bullets, never skipped.
- **Code reading only for notable changes.** With every commit to cover, the model writes small
  ones from the subject and opens code only for notable vague ones, so a long period stays
  inside the four-minute generation bound.

## Changes

- **API** `management/release-notes-prompt.ts`: `commitsBlock` returns `{ block, bodiesDropped }`
  and keeps every subject; new `subjectsSize`, `MAX_SUBJECT_CHARS`; completeness rules; the
  per-person «Smaller changes» list; the «Maintenance» group; the truncation-count rule removed.
  `management/release-notes.service.ts`: the `too_many_commits` refusal.
- **Core** `packages/core/src/i18n-codes.ts`: `too_many_commits`.
- **UI** `i18n/en`, `i18n/uk`: the `too_many_commits` message.
- **Tests** `apps/api/test/release-notes.spec.ts` (every commit kept over the budget, longest
  bodies dropped whole, every author's commits printed, completeness and Maintenance rules),
  `apps/api/test/management-runtime.spec.ts` (the refusal, before any spawn).

## Verification

- `pnpm exec vitest run test/release-notes.spec.ts test/management-runtime.spec.ts
  test/management-controller.spec.ts test/management-prompt.spec.ts` in `apps/api` — 88 passed.
- `packages/core`: `tsc --noEmit` clean, `test/i18n-codes.spec.ts` passed; `apps/api`
  `tsc --noEmit`: no errors in the touched files; `apps/ui` full suite 616 passed, 1 failed —
  `test/assignments.spec.ts` (default skills over the 8 KiB warning), unrelated, reported as a
  finding.
- Prompt from this repository's real history, 2026-09-01 — 2026-10-19, per person: 351
  commits, all 351 subject lines present (the old cap would have cut whole commits), 136
  bodies left out, prompt 51k chars, roster of five authors.
- One real generation over that prompt (`ReleaseNotesService.generate`, omp, claude-opus-5-5,
  83 s): five person sections in roster order, including the three with 1–4 commits; each
  with visible changes first and a «Smaller changes» list naming every small change; no
  count of changes or commits anywhere in the note.

## Documentation impact

`kermanych/README.md`, the «It writes release notes from the chat» bullet: the «Maintenance»
group, the per-person «Smaller changes» list, the every-change guarantee and the
`too_many_commits` refusal.
