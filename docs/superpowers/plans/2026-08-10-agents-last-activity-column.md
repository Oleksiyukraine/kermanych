# Agents Table "Last Activity" Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live "time since last activity" column to the agents table in `WorkspacePage.vue` (`щойно` → `N хв/год/дн тому`).

**Architecture:** Persist a `lastActivityAt` timestamp per session in SQLite (additive migration + backfill from `created_at`); the supervisor bumps it via a cheap `touchSession` write on every agent RPC event (except per-token streaming deltas) and on operator messages; the UI renders it relative to a shared 15 s clock (`useNow`) through a pure `relativeTime` formatter.

**Tech Stack:** TypeScript, NestJS + better-sqlite3 (`apps/api`), Vue 3 / Quasar + Pinia (`apps/ui`), `@kermanych/core` shared types, vitest (api tests only).

## Global Constraints

- **Node 22.x** — `better-sqlite3` is a native addon tied to the Node ABI.
- **Timestamps are ISO 8601 UTC** — always `new Date().toISOString()` (24-char, `…Z`), so string comparison is chronological.
- **Additive DB migrations only** — `try { ALTER TABLE … ADD COLUMN } catch {}`, mirroring the existing `archived` / `preview_command` migrations. Never rewrite the base `CREATE TABLE`.
- **Design tokens** — restrained palette; mono font for the timestamp cell; radius 0; single accent; green reserved for diffs. Reuse existing `.ws__cell-activity` styling (muted, 12px, ellipsis).
- **Locale** — UI copy is Ukrainian; code/identifiers/commits are English.
- **UI has no test runner** — verification for `apps/ui` is `vue-tsc` typecheck + manual smoke (do NOT introduce a UI test framework for this feature).

---

### Task 1: Persist `lastActivityAt` (core type + registry)

**Files:**
- Modify: `packages/core/src/types.ts` (the `Session` type, ~line 12-19)
- Modify: `apps/api/src/registry/registry.service.ts` (constructor migration ~line 36-40; `createSession` ~line 85-111; `listSessions` ~line 74-83; add `touchSession`)
- Test: `apps/api/test/registry.spec.ts` (add two tests)
- Modify: `apps/ui/src/pages/KitGalleryPage.vue` (`mkSession` base literal ~line 219-224) — **forced type-compile fix only**, not a demo-table feature (the required field must appear in the one UI Session factory or `vue-tsc` fails). Do NOT add the column to the gallery table.

**Interfaces:**
- Produces:
  - `Session.lastActivityAt: string` (required, ISO 8601).
  - `RegistryService.createSession(...)` — now initialises `lastActivityAt = createdAt`; its input type excludes `lastActivityAt`.
  - `RegistryService.listSessions(groupId?)` — rows now carry `lastActivityAt`.
  - `RegistryService.touchSession(id: string): void` — sets `last_activity_at` to now.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/registry.spec.ts`:

```ts
test("createSession stamps lastActivityAt equal to createdAt", () => {
  const r = new RegistryService(":memory:");
  const g = r.createGroup({ name: "app", projectDir: "/tmp/app" });
  const s = r.createSession({ groupId: g.id, name: "task", task: "do it", worktreePath: "/wt", branch: "kermanych/task" });
  expect(s.lastActivityAt).toBe(s.createdAt);
  expect(r.listSessions(g.id)[0].lastActivityAt).toBe(s.createdAt);
});

test("touchSession advances lastActivityAt without touching other fields", async () => {
  const r = new RegistryService(":memory:");
  const g = r.createGroup({ name: "app", projectDir: "/tmp/app" });
  const s = r.createSession({ groupId: g.id, name: "task", task: "do it", worktreePath: "/wt", branch: "kermanych/task" });
  await new Promise((res) => setTimeout(res, 10));
  r.touchSession(s.id);
  const after = r.listSessions(g.id)[0];
  expect(after.lastActivityAt > s.createdAt).toBe(true); // ISO strings sort chronologically
  expect(after.status).toBe(s.status);
  expect(after.branch).toBe(s.branch);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @kermanych/api test`
Expected: FAIL — `touchSession` is not a function; `lastActivityAt` is `undefined`.

- [ ] **Step 3: Add the field to the core `Session` type**

In `packages/core/src/types.ts`, replace the `Session` type (lines 12-19) with:

```ts
export type Session = {
  id: string; groupId: string; name: string; task: string;
  worktreePath: string; branch: string;
  ompSessionId?: string; ompSessionFile?: string;
  status: SessionStatus; currentTool?: string; error?: string;
  todoPhases?: TodoPhase[]; contextPercent?: number;
  pendingUiRequest?: RpcExtensionUIRequest; archived?: boolean; createdAt: string;
  lastActivityAt: string;
};
```

- [ ] **Step 4: Add the migration + backfill**

In `apps/api/src/registry/registry.service.ts`, immediately after the `archived` migration `try/catch` block (the one ending `/* column already exists */ }` around line 40), add:

```ts
    // Additive migration: last-activity tracking arrived after the initial schema.
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN last_activity_at TEXT`);
    } catch {
      /* column already exists */
    }
    // Backfill pre-existing rows so the column is never null for old sessions.
    this.db.exec(`UPDATE sessions SET last_activity_at = created_at WHERE last_activity_at IS NULL`);
```

- [ ] **Step 5: Initialise `lastActivityAt` in `createSession`**

In `createSession`, widen the input `Omit` and build the row with `lastActivityAt = createdAt`, then add the column to the INSERT. Replace the method body's header + row construction + insert (lines 85-110) with:

```ts
  createSession(
    s: Omit<Session, "id" | "createdAt" | "status" | "lastActivityAt"> & { status?: SessionStatus },
  ): Session {
    const createdAt = new Date().toISOString();
    const row: Session = {
      ...s,
      id: randomUUID(),
      createdAt,
      status: s.status ?? "queued",
      lastActivityAt: createdAt,
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, group_id, name, task, worktree_path, branch, omp_session_id, omp_session_file, status, created_at, last_activity_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id,
        row.groupId,
        row.name,
        row.task,
        row.worktreePath,
        row.branch,
        row.ompSessionId ?? null,
        row.ompSessionFile ?? null,
        row.status,
        row.createdAt,
        row.lastActivityAt,
      );
    return row;
  }
```

- [ ] **Step 6: Return `lastActivityAt` from `listSessions`**

In `listSessions`, add `last_activity_at as lastActivityAt` to the SELECT (line 75):

```ts
    const sql = `SELECT id, group_id as groupId, name, task, worktree_path as worktreePath, branch, omp_session_id as ompSessionId, omp_session_file as ompSessionFile, status, archived, created_at as createdAt, last_activity_at as lastActivityAt FROM sessions`;
```

`updateSession` is intentionally left unchanged: its `UPDATE` does not name `last_activity_at`, so SQLite preserves the existing value, and the `next` object it returns already carries `lastActivityAt` (spread from the current row).

- [ ] **Step 7: Add `touchSession`**

In `apps/api/src/registry/registry.service.ts`, add this method just before `removeSession`:

```ts
  // Bump the session's activity clock. A targeted write (no read-modify-write)
  // because it runs on the high-frequency agent-event path.
  touchSession(id: string): void {
    this.db.prepare(`UPDATE sessions SET last_activity_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  }
```

- [ ] **Step 8: Keep the UI Session factory compiling**

In `apps/ui/src/pages/KitGalleryPage.vue`, add `lastActivityAt: now` to the `mkSession` base literal (lines 220-223):

```ts
function mkSession(over: Partial<Session>): Session {
  return {
    id: 's', groupId: 'g1', name: 'api-gateway', task: '',
    worktreePath: '', branch: 'main', status: 'thinking', createdAt: now, lastActivityAt: now, ...over,
  };
}
```

- [ ] **Step 9: Run tests + typecheck to verify they pass**

Run: `pnpm --filter @kermanych/api test`
Expected: PASS (both new tests + existing).
Run: `pnpm --filter @kermanych/ui typecheck`
Expected: PASS (no missing-property error in `KitGalleryPage`).

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/types.ts apps/api/src/registry/registry.service.ts apps/api/test/registry.spec.ts apps/ui/src/pages/KitGalleryPage.vue
git commit -m "feat(core,api): persist session lastActivityAt + touchSession"
```

---

### Task 2: Bump activity on agent events + operator messages (supervisor)

**Files:**
- Modify: `apps/api/src/supervisor/supervisor.service.ts` (`onRpcEvent` ~line 131-134; `sendMessage` ~line 190-196)

**Interfaces:**
- Consumes: `RegistryService.touchSession(id)` (Task 1).
- Produces: the session activity clock advances on every RPC event except `message_update`, and on every operator `sendMessage`. Fresh values reach the UI via the existing `pushUpdate` → `merge` path (no new event channel).

**Verification note:** `SupervisorService.createSession` spawns the real `omp` (no `ompPath` injection hook), so a fake-omp integration test for the bump is not cheap and is out of proportion to a two-line delegation. The `touchSession` write contract is unit-tested in Task 1; here we verify no regression (api suite green + typecheck) and prove the end-to-end bump in the Task 3 manual smoke (a live agent's cell reads `щойно`). No new unit test.

- [ ] **Step 1: Bump on agent events in `onRpcEvent`**

In `apps/api/src/supervisor/supervisor.service.ts`, at the top of `onRpcEvent`, right after the guard `const l = this.map.get(id); if (!l) return;` (line 133) and before `const before = l.state.status;`, insert:

```ts
    // Any agent event counts as activity, except per-token streaming deltas
    // (message_update) — bumping per token would mean a DB write per token.
    if (e.type !== "message_update") {
      try {
        this.registry.touchSession(id);
      } catch {
        /* never let a bookkeeping write break the event stream */
      }
    }
```

- [ ] **Step 2: Bump on operator messages in `sendMessage`**

In `sendMessage`, after the session is resolved and before appending the user entry, add the touch (line 191-192):

```ts
  async sendMessage(id: string, text: string, mode: "prompt" | "follow_up" | "steer", images?: ImageInput[]) {
    const l = this.map.get(id) ?? (await this.resumeSession(id));
    this.registry.touchSession(id);
    if (text.trim() || images?.length) this.appendEntry(id, this.userEntry(text, images));
    if (mode === "steer") l.rpc.steer(text, images);
    else if (mode === "follow_up") l.rpc.followUp(text, images);
    else l.rpc.prompt(text, images);
  }
```

- [ ] **Step 3: Verify no regression**

Run: `pnpm --filter @kermanych/api test`
Expected: PASS (all existing tests, unchanged).
Run: `pnpm --filter @kermanych/api typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/supervisor/supervisor.service.ts
git commit -m "feat(api): bump session activity on agent events and operator messages"
```

---

### Task 3: UI — relative-time column + live clock

**Files:**
- Create: `apps/ui/src/lib/time.ts`
- Create: `apps/ui/src/composables/useNow.ts`
- Modify: `apps/ui/src/pages/WorkspacePage.vue` (imports ~line 253; `now` in setup ~line 258; `agentColumns` ~line 285-292; add a `#cell-lastActivity` slot ~line 49-51)

**Interfaces:**
- Consumes: `Session.lastActivityAt` (Task 1); `RegistryService`/supervisor bumps (Task 2).
- Produces:
  - `relativeTime(iso: string, nowMs: number): string`
  - `useNow(intervalMs?: number): Ref<number>`

- [ ] **Step 1: Create the pure formatter `apps/ui/src/lib/time.ts`**

```ts
// Relative "time ago" for the agents board, Ukrainian abbreviations. Pure:
// takes the target ISO timestamp and the current epoch millis (supplied by
// useNow), so the caller owns the ticking and the function stays testable.
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function relativeTime(iso: string, nowMs: number): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const delta = Math.max(0, nowMs - then);
  if (delta < MIN) return 'щойно';
  if (delta < HOUR) return `${Math.floor(delta / MIN)} хв тому`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)} год тому`;
  return `${Math.floor(delta / DAY)} дн тому`;
}
```

- [ ] **Step 2: Create the ticker composable `apps/ui/src/composables/useNow.ts`**

```ts
import { onMounted, onUnmounted, ref, type Ref } from 'vue';

// A shared "current time" ticker for relative timestamps. Returns a ref of
// Date.now() refreshed every `intervalMs` while mounted; the interval is
// cleared on unmount so it never leaks.
export function useNow(intervalMs = 15_000): Ref<number> {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  onMounted(() => {
    now.value = Date.now();
    timer = setInterval(() => (now.value = Date.now()), intervalMs);
  });
  onUnmounted(() => {
    if (timer) clearInterval(timer);
  });
  return now;
}
```

- [ ] **Step 3: Import both into `WorkspacePage.vue`**

After the `useImageAttach` import (line 253), add:

```ts
import { useNow } from '../composables/useNow';
import { relativeTime } from '../lib/time';
```

- [ ] **Step 4: Create the `now` ticker in setup**

Immediately after `const store = useOrchestrator();` (line 258), add:

```ts
const now = useNow();
```

- [ ] **Step 5: Add the column definition**

In `agentColumns` (lines 285-292), insert the new column between `activity` and `actions`:

```ts
const agentColumns: KTableColumn[] = [
  { key: 'status', label: 'Статус', width: '132px' },
  { key: 'name', label: 'Агент' },
  { key: 'branch', label: 'Гілка', width: '170px' },
  { key: 'ctx', label: 'Контекст', align: 'right', width: '96px', mono: true },
  { key: 'activity', label: 'Активність' },
  { key: 'lastActivity', label: 'Остання активність', width: '120px' },
  { key: 'actions', label: '', align: 'right', width: '84px' },
];
```

(The mono font comes from the cell's `ws__cell-activity mono` span in Step 6, exactly like the sibling `activity` cell — so `mono` is not set on the column.)

- [ ] **Step 6: Add the cell slot**

In the `<KTable>` block, right after the existing `#cell-activity` template (lines 49-51), add:

```html
          <template #cell-lastActivity="{ row }">
            <span class="ws__cell-activity mono">{{ relativeTime(row.lastActivityAt, now) }}</span>
          </template>
```

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @kermanych/ui typecheck`
Expected: PASS.

- [ ] **Step 8: Manual smoke**

Run `pnpm dev:api` and `pnpm dev:ui` in separate terminals; open <http://localhost:5317>, select a project with sessions:
- A running/new agent's **"Остання активність"** cell reads `щойно` and stays fresh while it works.
- After a session goes `готово`/`чекає`/`зупинено`, within ~15 s the cell starts counting up (`1 хв тому`, `2 хв тому`, …) with no new backend events.
- Existing sessions created before this change (post-migration/backfill) show a value, never blank.
- Send a follow-up message to an idle session → its cell resets to `щойно`.

- [ ] **Step 9: Commit**

```bash
git add apps/ui/src/lib/time.ts apps/ui/src/composables/useNow.ts apps/ui/src/pages/WorkspacePage.vue
git commit -m "feat(ui): add live 'last activity' column to agents table"
```

---

## Self-Review

**Spec coverage:**
- §3.1 core type (`Session.lastActivityAt`) → Task 1, Step 3. ✓
- §3.2 persistence (migration+backfill, `createSession` init, `listSessions` select, `touchSession`, `updateSession` unchanged) → Task 1, Steps 4-7. ✓
- §3.3 supervisor bump (`onRpcEvent` minus `message_update`, `sendMessage`, propagation via `pushUpdate`) → Task 2, Steps 1-2. ✓
- §3.4 UI (`useNow`, `relativeTime`, column + slot in `WorkspacePage`) → Task 3, Steps 1-6. ✓
- §5 verification (registry unit tests; formatter via typecheck + smoke since no UI runner; manual smoke) → Task 1 Step 1/9, Task 3 Step 7/8. ✓
- §6 non-goals: no absolute time / no per-token writes / existing `activity` column untouched / no new endpoints; `KitGalleryPage` touched only for a forced type-compile fix, not a demo feature. ✓

**Placeholder scan:** none — every code step has real content.

**Type consistency:** `touchSession(id: string): void` defined (T1) and used (T2) identically; `relativeTime(iso, nowMs)` and `useNow(): Ref<number>` defined (T3 S1-2) and consumed (T3 S4-6) identically; `lastActivityAt: string` consistent across core type, INSERT/SELECT, and UI usage.
