# Session archiving — design

Date: 2026-08-10
Status: approved

## Problem

The Workspace board shows every session for a group forever. Finished sessions
(done / merged / stopped / error) pile up with no way to declutter the board
while keeping their history. We need to archive a session (hide it from the main
board) and a way to review archived sessions.

## Requirements

1. An "archive" action on each agent card.
2. Archived sessions disappear from the main board (and the fleet counts).
3. A filter to view archived sessions.
4. Archiving an ACTIVE agent is refused with an error toast:
   "Архівація активного агента неможлива".
5. Archiving is reversible (unarchive) from the archived view.

## Data model

`archived: boolean` on `Session`, orthogonal to `status`. Status is a live state
machine (`reduceStatus` overwrites it); archiving must survive any status without
clobbering it, so it is a separate flag — NOT a new `SessionStatus`.

SQLite: `sessions.archived INTEGER NOT NULL DEFAULT 0`, added via the existing
additive-migration pattern (guarded `ALTER TABLE … ADD COLUMN`). `listSessions`
coerces the integer to boolean; `updateSession` persists it. New sessions rely on
the column default (not archived).

## "Active" definition (shared)

`core/status.ts`:
- `ACTIVE_STATUSES = ["queued", "thinking", "tool", "waiting_input"]`
- `isActiveStatus(status): boolean`

Active = the omp process is mid-work or blocked on the user; these cannot be
archived. Terminal/idle (`done`, `error`, `stopped`, `merged`) can. Both the API
(authoritative) and the UI (pre-check + toast) import this single helper.
(Distinct from MainLayout's `RUNNING`, which excludes `waiting_input` for count
bucketing — a different concept.)

## API

- `POST /sessions/:id/archive`   → `supervisor.setArchived(id, true)`
- `POST /sessions/:id/unarchive` → `supervisor.setArchived(id, false)`

`setArchived` refuses to archive when the merged status is active (throws → 400).
It only flips the flag + `pushUpdate` (emits `session_update`); it does NOT touch
the worktree or the omp process. Unarchive has no status guard.

## UI

- `lib/api.ts`: `archiveSession(id)`, `unarchiveSession(id)`.
- `stores/orchestrator.ts`:
  - actions `archiveSession` / `unarchiveSession` (delegate to api).
  - toast state: `toasts: Toast[]`, `notify(message, kind?)`, `dismissToast(id)`
    (auto-dismiss ~4s). `type Toast = { id; message; kind: 'error' | 'info' }`.
  - `reduce` already handles `session_update`.
- `components/kit/KToast.vue`: presentational stack (props `toasts`, emit
  `dismiss`), fixed bottom-right, error variant uses `--k-accent` bar, click to
  dismiss. Wired once in `MainLayout`.
- `MainLayout.vue`: mount `<KToast>`; `sessionsOf` excludes archived so fleet
  counts + rail running badge ignore archived sessions.
- `WorkspacePage.vue`:
  - `KToggle` filter in the board header: `Активні | Заархівовані` (default
    active). `groupSessions` filters by group AND `archived == current view`.
  - card actions: active view → existing preview/finish + "заархівувати" icon
    (⤓); archived view → "розархівувати" icon (⤒) only.
  - `onArchive(s)`: if `isActiveStatus(s.status)` → error toast and stop; else
    call api, deselect if it was open; toast on failure.
  - `onUnarchive(s)`: call api; toast on failure.
  - empty-state text adapts to the view.

## Verification

- `registry.spec.ts`: archived round-trip — defaults false, persists true/false
  through `updateSession` + `listSessions`.
- Smoke: run api + ui; archive a done session → leaves board, appears under
  "Заархівовані", fleet count drops; unarchive → returns; try archiving a running
  session → error toast, no state change.

## Non-goals

No auto-stop on archive (refused instead). No bulk archive. No worktree changes
on archive. No persistence of the filter selection across reloads.
