# Kermanych — Agents Table "Last Activity" Column (Design)

- **Status:** Draft for review
- **Date:** 2026-08-10
- **Scope:** `packages/core` (types), `apps/api` (registry, supervisor), `apps/ui` (WorkspacePage, new `useNow` composable, new `time` lib)

## 1. Purpose

Add a column to the agents table (`WorkspacePage.vue`) that shows how long ago
each session was last active — a live, relative "time since last activity"
(`щойно` → `N хв тому` → `N год тому` → `N дн тому`).

This is most useful for idle/terminal sessions (`чекає`, `готово`, `зупинено`):
it answers "how stale is this agent?" at a glance. For a running agent
(`думає`/`інструмент`) the value is refreshed constantly, so it reads `щойно`.

## 2. Current state (as-is)

- **`Session` type** (`packages/core/src/types.ts`) carries `createdAt: string`
  but **no** last-activity / updated timestamp.
- **Registry / DB** (`apps/api/src/registry/registry.service.ts`): the
  `sessions` table has `created_at`, no `updated_at`. Additive migrations use the
  `try { ALTER TABLE … ADD COLUMN } catch {}` pattern (see `archived`,
  `preview_command`, `api_command`). `createSession` sets `created_at`;
  `updateSession` rewrites a fixed set of columns; `listSessions` maps snake_case
  columns to camelCase.
- **Supervisor** (`apps/api/src/supervisor/supervisor.service.ts`):
  `onRpcEvent(id, e)` runs on **every** RPC event from the `omp` child (message
  deltas, tool start/end, status transitions, agent_end, extension_ui_request).
  `pushUpdate(id)` re-reads the persisted session via `listSessions`, `merge()`s
  the in-memory `live` partial over it, and emits `session_update`. `sendMessage`
  handles the operator's own messages.
- **Existing `activity` column** shows the **current** work (live tool, else the
  in-progress todo, else empty) — a *what*, not a *when*. It stays unchanged.
- **UI store** (`apps/ui/src/stores/orchestrator.ts`) reduces `session_update`
  into `sessions`. There is **no** live clock/ticker anywhere in the UI.
- **`KTable`** columns support `align`, `width`, `mono`, and `#cell-<key>` slots.
- **`KitGalleryPage.vue`** hosts a second, static demo table (mock sessions) that
  showcases the `KTable` component — a component gallery, not the real board.

## 3. Design

### 3.1 Data model — `packages/core/src/types.ts`

- `Session` gains `lastActivityAt: string` (ISO 8601), **required**. Like
  `createdAt`, it is assigned by the registry, so the `createSession` input type
  excludes it:
  `Omit<Session, "id" | "createdAt" | "status" | "lastActivityAt">`.

### 3.2 Persistence — `apps/api/src/registry/registry.service.ts`

- **Migration (constructor):** additive, mirroring `archived`:
  ```
  try { ALTER TABLE sessions ADD COLUMN last_activity_at TEXT } catch {}
  UPDATE sessions SET last_activity_at = created_at WHERE last_activity_at IS NULL
  ```
  The backfill guarantees every existing row has a value, so the UI never renders
  an empty cell.
- **`createSession`:** initialise `last_activity_at = created_at` (in the INSERT
  column list and in the returned `Session` object).
- **`listSessions`:** add `last_activity_at as lastActivityAt` to the SELECT.
- **`touchSession(id: string): void`:** new, targeted
  `UPDATE sessions SET last_activity_at = ? WHERE id = ?` with `new Date().toISOString()`.
  A dedicated method (not `updateSession`) keeps the high-frequency activity path
  cheap — no read-modify-write, no full `listSessions` scan per event.
- **`updateSession`:** unchanged. It does not name `last_activity_at` in its
  `UPDATE`, so SQLite preserves the existing value; the `next` object it returns
  still carries `lastActivityAt` because it is spread from the current row.

### 3.3 Activity bump — `apps/api/src/supervisor/supervisor.service.ts`

- In `onRpcEvent(id, e)`, bump the timestamp for the session on every event
  **except** `message_update` (the per-token streaming delta), so a long streamed
  message does not cause one DB write per token:
  ```
  if (e.type !== "message_update") { try { this.registry.touchSession(id); } catch {} }
  ```
  The `try/catch` ensures a touch failure (e.g. DB closing during shutdown) never
  breaks the event/stream loop.
- In `sendMessage(...)`, `touchSession(id)` when the operator sends a message
  (prompt / follow-up / steer) so operator activity counts too.
- **Propagation:** no new event channel. The fresh `lastActivityAt` reaches the
  UI through the existing `pushUpdate` → `merge` path (which reads the persisted
  row). While a session is active, `refreshState` already calls `pushUpdate`
  every 2 s; on each status transition `pushUpdate` fires too. Minute-granularity
  relative time tolerates the small window between a bump and the next push.

### 3.4 UI

- **`apps/ui/src/composables/useNow.ts`** — exports `useNow(intervalMs = 15000)`
  returning a `Ref<number>` of `Date.now()`, updated on an interval started in
  `onMounted` and cleared in `onUnmounted`. One shared ticker drives all relative
  timestamps on the page.
- **`apps/ui/src/lib/time.ts`** — pure `relativeTime(iso: string, nowMs: number): string`:
  - `< 60 s` → `щойно`
  - `< 60 min` → `N хв тому`
  - `< 24 h` → `N год тому`
  - else → `N дн тому`
  Pure and dependency-free, so it is unit-testable in isolation.
- **`apps/ui/src/pages/WorkspacePage.vue`:**
  - `const now = useNow();`
  - New column after `activity`, before `actions`:
    `{ key: 'lastActivity', label: 'Остання активність', width: '120px', mono: true }`.
  - Scoped slot renders `relativeTime(row.lastActivityAt, now)`:
    ```html
    <template #cell-lastActivity="{ row }">
      <span class="ws__cell-activity mono">{{ relativeTime(row.lastActivityAt, now) }}</span>
    </template>
    ```

## 4. Isolation / boundaries

- **`packages/core`** — one additive, required field (`Session.lastActivityAt`).
- **`registry.service`** — owns the column, its migration/backfill, and the
  `touchSession` write. Sole writer of `last_activity_at`.
- **`supervisor.service`** — decides *when* activity happens (agent events minus
  streaming deltas, plus operator messages); delegates the write to the registry.
- **`useNow`** — the only source of "current time" ticking; no domain coupling.
- **`time.ts`** — pure formatter; no Vue, no store, no I/O.
- **`WorkspacePage`** — composes the column from `row.lastActivityAt` + `now`;
  no new store or socket surface.

## 5. Verification

- **Backend unit (vitest, `apps/api/test/registry.spec.ts`):** mirrors the
  existing `archived` round-trip test in style (`:memory:`).
  - `createSession` sets `lastActivityAt === createdAt`.
  - `touchSession(id)` advances `lastActivityAt` beyond the created value and
    leaves other fields intact.
  - The `ALTER TABLE`/backfill migration is a one-line, self-evidently-correct
    statement — covered by the smoke check below (existing rows never blank),
    matching how the `archived` migration is verified today (behaviour, not the
    ALTER in isolation).
- **UI unit (formatter):** `relativeTime` boundaries — `< 60 s` → `щойно`,
  minutes, hours, days. (Confirm the UI test runner during planning; if absent,
  the formatter is a pure function and a minimal vitest setup covers it.)
- **Smoke (manual):** `pnpm dev:api` + `pnpm dev:ui`, open a project:
  - a running agent's "Остання активність" reads `щойно` and stays fresh;
  - after a session goes `готово`/`чекає`, the cell counts up (`1 хв тому`,
    `2 хв тому`, …) as the 15 s ticker advances, with no new events;
  - a freshly created session shows `щойно` (initialised to `createdAt`);
  - existing sessions (post-migration) show a value, never blank.

## 6. Non-goals

- Absolute timestamps or "duration of current action" (the chosen semantics is
  relative time since last activity).
- Per-token DB writes / streaming-delta precision (bump excludes `message_update`).
- Renaming or changing the existing `activity` (current-work) column.
- Touching the `KitGalleryPage` demo table.
- Any new RPC command, HTTP/WS endpoint, or worktree behaviour.
