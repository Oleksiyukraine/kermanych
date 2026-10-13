# Release notes from several projects, one branch per project

## Goal

The «Реліз-ноти» form lets the operator pick more than one project of the workspace — for
example the backend and the frontend — and pick, for each picked project, the branch its
commits are read from (the backend from `dev`, the frontend from `main`). The generated
note has one clearly separated section per project: the backend's changes under the
backend's heading, then the frontend's changes under the frontend's heading.

## Context

- One job, two callers: the form on `apps/ui/src/pages/ManagementReleasesPage.vue` and the
  management chat's `release.notes` action (`apps/ui/src/stores/management-chat.ts`) both
  hand `useReleaseNotes().generate` a job (`apps/ui/src/stores/release-notes.ts`).
- The job calls `POST /management/release-notes` (`ReleaseNotesAsk`, `packages/core/src/release-notes.ts`)
  → `ManagementController.releaseNotes` → `ReleaseNotesService.generate`, which resolves ONE
  project in the local registry, checks the branch, reads `git log` for the range and runs one
  one-shot child on `buildReleaseNotesPrompt`.
- The browser stores the reply in `workspace_release_notes`, a row with one `project_id`,
  `project_name` and `branch`. The trigger freezes these after insert.
- Before this change the form had one project picker and one branch picker.

## Decisions

- **The wire carries a list.** `ReleaseNotesAsk` replaces `projectId` + `branch` with
  `sources: { projectId, branch }[]` (one or more, each project at most once). Clean cutover:
  the chat action still names one project and sends a one-element list. Rejected: keeping the
  old fields beside the list — two ways to say the same thing.
- **One child, one document.** The api reads every project's commits and writes ONE prompt;
  one one-shot child writes the whole note. Rejected: one child per project stitched together —
  each child writes its own title and heading levels, so stitching means rewriting markdown,
  and it multiplies spawn time and spend.
- **Sections are the projects, in pick order.** With two or more projects, every project gets
  a second-level heading that is exactly its name, in the order the operator picked the
  projects (the branch pickers below the project picker show that order); the by-meaning
  groups («New», «Improvements», «Fixes») or the per-person sections move one level down,
  inside each project. A single project produces the same document as before.
- **The form is a multi-select plus one branch picker per picked project.** The project
  picker is the kit's `KSelect` in `multiple` mode (the Team Capacity roster uses it); each
  picked project gets a searchable branch picker preselected with its default branch.
  Rejected: a checkbox list with a branch picker on every row — it grows with every project of
  the workspace, picked or not.
- **The child can read every picked repository.** It is born in the first project's
  repository; the prompt names each project's folder so the read-only tools can open the code
  behind a vague commit in the right repository. The folder paths come from the api's registry,
  never from the client.
- **The commit budget is shared.** `MAX_COMMITS_CHARS` is split evenly over the projects, so
  one busy repository cannot push another one out of the prompt.
- **A project with no commits in the range refuses the generation** (`no_commits_in_range`,
  now naming the project). Rejected: writing «no changes» under that project — an empty range
  is usually a wrong branch pick, and the operator should see that before a model turn is spent.
  The operator can untick the project and generate again.
- **Refusals name the project.** `project_not_bound`, `branch_not_in_repo` and
  `no_commits_in_range` gain a `project` param; a duplicated project is `project_duplicate`.
- **Storage: a `sources` column, with the old columns as a summary.** Migration
  `20261012090000_release_notes_sources.sql` adds `sources jsonb` (array of
  `{ project_id, project_name, branch }`), frozen by the trigger like every provenance column.
  The client writes it on every insert. The old columns stay, holding a summary: `project_id`
  is the project when there is one and `null` for several, `project_name` and `branch` are
  the names and branches joined with « + ». Older builds and the home tile keep a readable
  label without knowing the new column. Rows written before the migration have `sources`
  `null`; `toWorkspaceReleaseNote` derives a one-element list from the old columns.
  Rejected: only joining text into the old columns — it loses which branch belongs to which
  project and the project ids.

## Changes

- **Core** `packages/core/src/release-notes.ts`: `ReleaseSource`, `ReleaseNotesAsk.sources`;
  `packages/core/src/i18n-codes.ts`: `project_duplicate`, params of the three refusals.
- **API** `http/management.controller.ts` validates `sources`;
  `management/release-notes.service.ts` resolves every source, then one prompt and one child;
  `management/release-notes-prompt.ts` takes `sources` and writes per-project sections.
- **Cloud** migration `supabase/migrations/20261012090000_release_notes_sources.sql`;
  `packages/cloud`: `ReleaseNoteSource`, `WorkspaceReleaseNote.sources`, insert takes `sources`
  and writes the summary columns.
- **UI** `stores/release-notes.ts`: a job carries `sources`; `stores/management-chat.ts`
  sends one source; `pages/ManagementReleasesPage.vue`: a multi-select project picker and one
  branch picker per picked project; job rows, note rows and the note modal show one tag per
  project with its branch («Backend · dev»); `i18n` en/uk.
- **Tests** `apps/api/test/release-notes.spec.ts` (prompt takes `sources`; new «several
  projects» block: sections by exact name in order, commits under their own project, groups and
  rosters one level down, even budget split), `management-controller.spec.ts` (empty list,
  missing branch on any source, duplicate project, order and trimming),
  `management-runtime.spec.ts` (each repo read on its own branch, one child in the first
  repo, summed commit count; a project with no commits refuses before any spawn),
  `slack-release-notes.spec.ts` (fixture gains `sources`),
  `apps/ui/test/release-notes-jobs.spec.ts` (jobs and asks carry `sources`; a second project is
  a different job).

## Verification

- `pnpm exec vitest run test/release-notes.spec.ts test/management-runtime.spec.ts
  test/management-controller.spec.ts test/management-prompt.spec.ts test/slack-release-notes.spec.ts`
  in `apps/api` — 94 passed.
- `pnpm exec vitest run test/release-notes-jobs.spec.ts test/management-risks.spec.ts
  test/management-tickets.spec.ts test/home-digest.spec.ts` in `apps/ui` — 26 passed.
- `tsc --noEmit` in `apps/api` and `vue-tsc --noEmit` in `apps/ui`: no errors in the touched
  files. The errors that remain are in files this change does not touch
  (`jira.controller.ts`, `src-electron/*`, `runtime-messages.spec.ts`).
- Full suites: `apps/ui` 576 passed; `packages/core` 191 passed; `apps/api` 880 passed and 2
  failed — both in `test/rpc-session.compact.spec.ts`, already recorded as failing in
  `2026-10-05-slack-integration.md`; this change does not touch `rpc-session.ts`.
- End to end against a preview api (`KERMANYCH_PREVIEW=1`) with two real git repositories
  bound as «Backend» (`main`, `dev`) and «Frontend» (`main`, `release/2.0`) and the UI dev
  server: the form showed «Branch · Backend» = `dev` and «Branch · Frontend» = `main` after
  picking both (each project's default branch); the Frontend branch was switched to
  `release/2.0`; the request body was
  `{"sources":[{"projectId":"…1111","branch":"dev"},{"projectId":"…2222","branch":"release/2.0"}],…}`;
  the failed job row showed the tags «Backend · dev» and «Frontend · release/2.0» and the
  localized refusal «"Backend" has no commits on branch "dev" in 2026-10-07 — 2026-10-12». The
  same api refused a duplicated project with `project_duplicate`. No model turn was spent: a
  successful generation was not run.
- `packages/cloud` mapping, run with node against the build: a row with `sources` null reads as
  one source from the old columns; a two-element list maps both; the insert writes
  `project_name` «Backend + Frontend», `branch` «dev + main», no `project_id` and the list.
- Not verified: the migration against a real Supabase project, and a stored multi-project note
  rendered from the cloud.

## Documentation impact

`kermanych/README.md`, the «It writes release notes from the chat» bullet: a paragraph on
notes over several projects — the multi-select, one branch per project, sections in pick
order, the refusal for a project without commits, the chat staying single-project, and the
`sources` column with its migration to push before shipping the UI.
