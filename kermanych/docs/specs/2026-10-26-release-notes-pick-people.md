# Release notes per person: pick who the report covers

## Goal

The Release Notes form has a «Звіт по людях» toggle that writes one section per commit
author of the period — always the whole team. The operator asked to choose the people:
one person, several, or the whole team.

## Context

- Form: `apps/ui/src/pages/ManagementReleasesPage.vue` (`gen.byPerson` → `groupBy: "person"`).
- Job store: `apps/ui/src/stores/release-notes.ts` (`ReleaseNotesJob`, dedupe in `generate`).
- Wire types: `packages/core/src/release-notes.ts` (`ReleaseNotesAsk`).
- Endpoint: `POST /management/release-notes` in `apps/api/src/http/management.controller.ts`.
- Service: `apps/api/src/management/release-notes.service.ts` reads each project's
  `git log` (`WorktreeService.logRange`, authors as `%aN`), builds the prompt
  (`release-notes-prompt.ts`, `commitsByAuthor`) and runs one omp child.

Commit authors exist only in the local clones, so the browser cannot know who to offer
without asking the api.

## Decisions

- **The people offered are the commit authors of the period**, read by a new
  `POST /management/release-notes/authors` from the same projects, branches and range the
  note will be generated from. Rejected: workspace members or Jira users — their names do
  not match git's `%aN`, so a pick could silently match no commit.
- **Default is the whole team** (`authors` absent). The picker reuses the capacity
  screen's roster pattern (`toggleActive` with a «Whole team» master row): clearing it and
  ticking one person writes a one-person report. Form state is `null` (whole team,
  newcomers included) or an explicit list; picks absent from the current period are kept so
  they return with their range.
- **Filtering happens in the api before the prompt**, so the roster, the sections, the
  commit count and the subject ceiling all see only the picked people. The prompt gains a
  line saying the report covers only those people, so the heading does not present it as
  the whole release.
- **A picked project none of the picked people touched is dropped** from the note instead
  of refusing it; `no_commits_in_range` is still checked on the unfiltered log (an empty
  branch is still the likely mistake). None of them committed anywhere →
  `no_commits_by_authors`.
- **`authors` requires `groupBy: "person"`** (`authors_need_person`); an empty list or
  blank name is `authors_invalid`. Silently ignoring the list would hand back a document
  about everyone.
- **Chat action unchanged.** The model cannot see commit authors, so it would guess names;
  picking stays in the form.

## Changes

- core: `ReleaseNotesAsk.authors?`, `ReleaseNotesAuthorsAsk`, `ReleaseNotesAuthorsReply`,
  `ReleaseAuthor`; error codes `authors_invalid`, `authors_need_person`,
  `no_commits_by_authors`.
- api: controller shares `releaseRange` (sources + period validation) and `relay` (error
  relay) between endpoints; new `releaseNotesAuthors`; `generate` filters by `authors`;
  service `authors()`; prompt `authors` input.
- ui: `api.releaseNotesAuthors`; «People» multi-select under the toggle with loading,
  empty, error and «pick at least one» states; job carries `authors` (dedupe compares the
  set); failed/running job row tag shows «per person: names»; uk/en strings.

## Verification

- `vitest run` — api `management-controller`, `management-runtime`, `release-notes`
  specs (64 passed); core suite (226 passed); ui `release-notes-jobs`,
  `runtime-messages` (14 passed).
- `tsc --noEmit` (api) clean. `vue-tsc --noEmit` (ui) reports one error in
  `test/runtime-messages.spec.ts:13`, in a file this change does not touch.
- Manual, against a preview api bound to this repository: `/management/release-notes/authors`
  returned the period's authors with counts; bad period / unknown branch / `authors`
  without person / nobody matching returned the coded 400s. In the UI the picker listed
  the authors, clearing «Whole team» disabled Generate with the hint, ticking one person
  sent `"authors": ["Andrew Chesnokov"]`, re-picking «Whole team» sent no `authors`.

## Documentation impact

- `README.md` — the release-notes paragraph of the management assistant section describes
  the «People» picker, the new endpoint, the `authors` field and its refusal codes.
