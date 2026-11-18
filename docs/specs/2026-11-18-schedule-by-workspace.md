# «Розклад» in ЦТ scoped to the selected workspace

## Goal

The operator's request: in ЦТ, «Розклад» should be filtered by the selected workspace the way the
notepad is. Today it shows every scheduled task whatever workspace the switcher holds.

## Context

- The notepad (`apps/ui/src/components/assistant/CukNotepad.vue`) shows the «Список дій» of
  `orchestrator.selectedWorkspaceId`.
- «Розклад» (`apps/ui/src/components/assistant/CukNotifications.vue`) listed `schedules.tasks`
  unfiltered. A task carries an optional `projectId` (`packages/core/src/schedules.ts`); reminders
  and agent tasks without a project have none (`docs/specs/2026-11-06-scheduled-tasks.md`,
  decision 9).
- The workspace's projects are resolved by `sessionScopedProjectIds` (`apps/ui/src/lib/scope.ts`):
  the cloud list once read, the cached projectId → workspaceId map before that.

## Decisions

1. **Scope is the workspace, not the project.** This matches the notepad. Picking a project inside
   the workspace does not narrow the list further. Rejected: narrowing to the selected project,
   because then «Розклад» and the notepad beside it would answer to different selections.
2. **Tasks without a project show in every workspace.** They belong to no workspace, so hiding
   them would leave them on no list at all. Rejected: showing them only with no workspace picked,
   because the switcher almost always holds one, so reminders would effectively disappear.
3. **No workspace picked shows every task.** This happens with nothing selected, or with a
   local-only project, which has no workspace. It keeps the list's old behaviour.
4. **A separate empty state** when tasks exist but none belong here
   (`cuk.schedule.emptyWorkspace`), so an empty list is not read as «no schedule at all».

## Changes

- `apps/ui/src/lib/schedules.ts`: `tasksInWorkspace(tasks, projectIds | undefined)`.
- `apps/ui/src/components/assistant/CukNotifications.vue`: `scopedTasks` feeds the sorted list;
  the new empty state.
- `apps/ui/src/i18n/{uk,en}/index.ts`: `cuk.schedule.emptyWorkspace`.
- `apps/ui/test/schedules.spec.ts`: `tasksInWorkspace` cases.

## Verification

- `npx vitest run test/schedules.spec.ts` in `apps/ui`: 9 passed.
- `npx vue-tsc --noEmit` in `apps/ui`: exit 0.
- Live preview: two agent tasks (Acme Web, Kermanych) and a reminder, created through the api.
  The preview has no cloud, so the workspaces were simulated by setting
  `orchestrator.projectWorkspace` and `selectedWorkspaceId` from the page. Results: workspace A
  showed Acme + the reminder; workspace B showed Kermanych + the reminder; no workspace showed all
  three. With the reminder deleted, a workspace with no projects showed the
  `emptyWorkspace` text.
- **Not exercised:** real cloud workspaces with the cloud project list read (the preview has no
  cloud). That path goes through `scopedProjectIds`, which the board and Агенти already use.

## Documentation impact

- `kermanych/README.md` → «Розклад» → «Where to see them»: the workspace scoping.
- `docs/specs/2026-11-06-scheduled-tasks.md`, decision 6: a pointer to this document.
