# Custom branch name in the launcher

## Goal

Card «Зараз. При створенні задачі. Назва гілки генерується автоматично»: the operator cannot
choose an agent's branch name. Typing in «Назва задачі» changes nothing about the branch,
because since docs/specs/2026-10-26-branch-name-from-task.md a model names it from the task at
launch. The «Гілка» box should take a branch name; left blank, the system names it as before.

The card also proposed removing «Назва задачі». The operator decided against it: nothing is
removed, the title field stays the card's title.

## Context

- The launcher (`apps/ui/src/pages/AgentsPage.vue`) showed a read-only `<prefix>/…` box under
  «Гілка».
- `SupervisorService.resolveLaunchParams` (`apps/api/src/supervisor/supervisor.service.ts`) names
  the branch: `BranchNameService.suggest`, else `slugify(title)`, then `uniqueSlug`.
- Every card launch starts from the saved cloud row (`launchTask`): «Запустити», «В беклог» then
  ▶ on the board, a teammate's ▶, «Посіпака». `tasks.branch` is the BASE branch, so no column held
  the agent's own branch name.

## Decisions

1. **The name lives on the card: `tasks.branch_slug`** (migration
   `20261104110000_task_branch_slug.sql`, nullable text, NULL = generate). Rejected: passing it only
   in the `POST /sessions/from-task` body. «В беклог», board launches and «Посіпака» would ignore
   it without saying so. This reverses decision 8 of the 2026-10-26 spec: now the value is the
   operator's, not the model's, and every machine launching the card needs it.
2. **The field is the part after the prefix.** The box shows the «Тип» prefix as fixed text
   (`feature/`) and an input for the rest, so the prefix keeps one control.
3. **Slugified at launch, not refused.** A typed name goes through `slugify` (lowercase, Latin,
   `a-z0-9` joined with `-`, 40 characters), the same rules as a generated one. A backlog card is
   launched later, maybe by «Посіпака» with nobody watching, so a value git would refuse must not
   fail that launch. The launcher's hint names the resulting branch whenever slugify changes what
   was typed. `uniqueSlug` still appends `-2`, … when the name is taken in the project.
4. **A typed name skips the model call.** Nothing is asked of the model when the card already
   names its branch.
5. **`tasks_guard()` rule 6 counts `branch_slug` as content.** If anyone but the author renames
   the branch of an auto-run card, auto-run is switched off, as for a changed prefix.
6. **The board's own create/edit form does not show the field.** It sends no `branchSlug`, so
   editing a card there keeps it. The launcher is where a branch is chosen.
7. **The «назву гілки складе модель…» hint moves from the title field to «Гілка»**, where it
   now explains what a blank field means.

## Changes

- `supabase/migrations/20261104110000_task_branch_slug.sql`: the column; `tasks_guard()` rule 6.
- `packages/cloud/src/{types,tasks}.ts`: `branchSlug` on `Task`, `TaskInsert`, `TaskPatch`;
  selected, mapped, blank patched as NULL.
- `apps/api/src/supervisor/supervisor.service.ts`: `launchTask` passes `task.branchSlug`;
  `resolveLaunchParams` uses it slugified before asking the namer.
- `apps/ui/src/lib/tasks-view.ts`: `LauncherDraft.branchSlug`, sent on insert when set and on
  every patch.
- `apps/ui/src/pages/AgentsPage.vue`, `apps/ui/src/i18n/{uk,en}/index.ts`: the editable «Гілка»
  box and its hints.
- Tests: `packages/cloud/test/tasks.spec.ts`, `apps/api/test/sessions.from-task.spec.ts`,
  `apps/ui/test/tasks-view.spec.ts`.
- `kermanych/README.md`: «Run» (how the branch is named), auto-run content list, the migration
  note.

## Documentation impact

`kermanych/README.md`, as listed above.
