# claude-code runtime — Increment 2 (per-user preference) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the agent runtime a per-user choice — picked at onboarding and changeable in profile settings — stored in Supabase (`profiles.agent_runtime`, source of truth), mirrored to the local registry cache, and stamped onto each session at creation. `KERMANYCH_RUNTIME` becomes a dev-only override.

**Architecture:** Cloud is the source of truth (`profiles.agent_runtime`, RLS already covers `profiles_update_own`). The UI reads/writes it under the user's JWT and pings the API to refresh a local cache in the registry `auth_session` row. `SupervisorService.runtimeFor()` resolves `env override → cached preference → 'omp'`; the resolved kind is stamped onto `Session.runtime` at creation, and resume reads the stamped value (Increment 1's factory already routes launch/resume through `createRuntime`).

**Tech Stack:** TypeScript, NestJS (`apps/api`), Quasar/Vue 3 + Pinia + vue-i18n (`apps/ui`), `@kermanych/cloud` (Supabase), `@kermanych/core`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-02-claude-code-runtime-design.md` (§4 data model, §8 Increment 2).

## Global Constraints

- Node ≥ 22.12; pnpm@10.33.2. After editing `@kermanych/core` or `@kermanych/cloud`, `pnpm --filter <pkg> build` before typechecking/testing `apps/api`/`apps/ui` (they consume built `dist`).
- Code/identifiers/comments/commit messages: **English**. **Every UI-visible string is an i18n key** (`vue-i18n`): add the key to BOTH `apps/ui/src/i18n/uk/index.ts` (source of truth) and `apps/ui/src/i18n/en/index.ts`, identical key paths (`apps/ui/src/i18n/schema.ts` enforces this); use `const { t } = useI18n()` and `t('key.path')`. No inline literals.
- `@kermanych/core` barrel uses ENUMERATED re-exports (no `export *` for value modules).
- The Supabase migration file is the schema of record; **pushing it to the hosted project is the operator's step** (`supabase db push --linked`), NOT part of any test. The additive column is safe to push anytime.
- `AgentRuntimeKind = 'omp' | 'claude-code'` + `isAgentRuntime` already exist in `@kermanych/core` (Increment 1). The `AgentRuntime` seam, `ClaudeCodeRuntime`, `createRuntime`, and env-based `runtimeFor()` already exist and are merged.
- Do NOT run project-wide formatters/linters. Run only the commands named per task.
- **Subagent workspace guard (learned in Increment 1):** every implementer's FIRST bash MUST be `cd /Users/oleksiimotornyi/Documents/Projects/kmq-runtime-pref && test "$(git rev-parse --show-toplevel)" = "/Users/oleksiimotornyi/Documents/Projects/kmq-runtime-pref" && echo GUARD_OK || echo GUARD_FAIL`; abort BLOCKED unless GUARD_OK. ALL file writes use absolute paths under `…/kmq-runtime-pref/kermanych/`; ALL pnpm/git run from `…/kmq-runtime-pref/kermanych`. NEVER touch the sibling checkout `…/Multiagent-app`.
- Commit once per task; conventional-commit messages.

---

## File Structure

Modify:
- `packages/core/src/types.ts` — `Session.runtime?: AgentRuntimeKind`.
- `packages/cloud/src/types.ts` — `Profile.agentRuntime?: AgentRuntimeKind`.
- `packages/cloud/src/index.ts` — export the new account helpers.
- `apps/api/src/registry/registry.service.ts` — `auth_session.agent_runtime`, `sessions.runtime` (additive migrations) + `AuthSessionRow.agentRuntime` + read/write + createSession/updateSession/listSessions carry `runtime`.
- `apps/api/src/supervisor/supervisor.service.ts` — `runtimeFor()` reads cache; stamp `Session.runtime` at `createChat` + `createSessionFromTask`; launch/resume use `session.runtime`.
- `apps/api/src/auth/auth.service.ts` — on `setToken`, best-effort load `profiles.agent_runtime` into the cache.
- `apps/api/src/app.module.ts` — register the new `AccountController`.
- `apps/ui/src/stores/auth.ts` — load `runtime` from cloud profile; expose it; a setter (cloud write + API ping).
- `apps/ui/src/lib/api.ts` — `getAccountRuntime` / `setAccountRuntime` client methods.
- `apps/ui/src/lib/settings.ts` — add `{ key: 'app-runtime', scope: 'app' }`.
- `apps/ui/src/pages/SettingsPage.vue` — the runtime pane.
- `apps/ui/src/layouts/MainLayout.vue` — the onboarding gate modal.
- `apps/ui/src/components/kit/KPanel.vue` — dynamic harness label.
- `apps/ui/src/i18n/uk/index.ts`, `apps/ui/src/i18n/en/index.ts` — new keys.

Create:
- `supabase/migrations/<ts>_profile_agent_runtime.sql`.
- `packages/cloud/src/account.ts` — `getMyAgentRuntime` / `setMyAgentRuntime`.
- `apps/api/src/http/account.controller.ts` — `GET/POST /account/runtime`.

Tests: `packages/core` (Session type via typecheck), `packages/cloud/test/account.spec.ts`, `apps/api/test/registry.runtime.spec.ts`, `apps/api/test/supervisor.runtime-pref.spec.ts`, `apps/api/test/account.controller.spec.ts`, `apps/ui/test/*` (store/settings logic where a harness exists) + typecheck + smoke.

---

## Task 1: `Session.runtime` in `@kermanych/core`

**Files:** Modify `packages/core/src/types.ts`. Test: typecheck.

**Interfaces:** Produces `Session.runtime?: AgentRuntimeKind`.

- [ ] **Step 1: Add the field.** In `types.ts`, the `Session` type (around lines 32-58), add after `effort?: ThinkingLevel;`:

```ts
  // The agent runtime this session runs on, stamped at creation from the user's
  // preference (SupervisorService.runtimeFor). Absent on pre-Increment-2 rows → the
  // supervisor treats absent as its resolved default. Never changes after creation:
  // resume must respawn the same backend.
  runtime?: AgentRuntimeKind;
```

Ensure `AgentRuntimeKind` is imported at the top: `import type { AgentRuntimeKind } from "./runtime";` (add if not present — `types.ts` already imports sibling types like `ThinkingLevel`).

- [ ] **Step 2: Build + typecheck.** Run `pnpm --filter @kermanych/core build`. Expected EXIT 0.
- [ ] **Step 3: Commit.**

```bash
git add packages/core/src/types.ts
git commit -m "feat(core): add Session.runtime field"
```

---

## Task 2: cloud `Profile.agentRuntime` + account helpers

**Files:** Modify `packages/cloud/src/types.ts`, `packages/cloud/src/index.ts`; create `packages/cloud/src/account.ts`. Test: `packages/cloud/test/account.spec.ts`.

**Interfaces:**
- Consumes: `AgentRuntimeKind`, `isAgentRuntime` from `@kermanych/core`; `SupabaseClient`.
- Produces: `Profile.agentRuntime?: AgentRuntimeKind`; `getMyAgentRuntime(client): Promise<AgentRuntimeKind | null>`; `setMyAgentRuntime(client, kind): Promise<void>`.

- [ ] **Step 1: Extend the Profile type.** In `packages/cloud/src/types.ts` add `agentRuntime?: AgentRuntimeKind;` to `Profile` (and import `AgentRuntimeKind` from `@kermanych/core` in that file's existing core import).

- [ ] **Step 2: Write the failing test.**

```ts
// packages/cloud/test/account.spec.ts
import { describe, it, expect } from "vitest";
import { getMyAgentRuntime, setMyAgentRuntime } from "../src/account";

// A minimal fake matching the postgrest chain the helpers use. getMyAgentRuntime does
// client.from('profiles').select('agent_runtime').eq('id', uid).single(); setMyAgentRuntime
// does .from('profiles').update({ agent_runtime }).eq('id', uid).
function fakeClient(row: { agent_runtime: string | null }, sink?: (u: unknown) => void) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
    from() {
      return {
        select() { return this; },
        update(u: unknown) { sink?.(u); return this; },
        eq() { return this; },
        single: async () => ({ data: row, error: null }),
        then: undefined,
      } as never;
    },
  } as never;
}

describe("account runtime helpers", () => {
  it("reads a valid runtime, maps snake_case, and rejects garbage as null", async () => {
    expect(await getMyAgentRuntime(fakeClient({ agent_runtime: "claude-code" }))).toBe("claude-code");
    expect(await getMyAgentRuntime(fakeClient({ agent_runtime: null }))).toBeNull();
    expect(await getMyAgentRuntime(fakeClient({ agent_runtime: "bogus" }))).toBeNull();
  });
  it("writes the snake_case column for the current user", async () => {
    let sent: unknown;
    await setMyAgentRuntime(fakeClient({ agent_runtime: null }, (u) => (sent = u)), "claude-code");
    expect(sent).toEqual({ agent_runtime: "claude-code" });
  });
});
```

- [ ] **Step 2b: Run it, confirm it fails.** `pnpm --filter @kermanych/cloud test -- account.spec` → FAIL (module missing).

- [ ] **Step 3: Implement `packages/cloud/src/account.ts`.**

```ts
// packages/cloud/src/account.ts
// The signed-in user's per-account settings on the shared cloud. Same JWT-scoped,
// RLS-guarded pattern as workspaces.ts; the snake_case<->camelCase boundary lives here.
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAgentRuntime, type AgentRuntimeKind } from "@kermanych/core";

// The user's chosen agent runtime, or null when unset ("not chosen yet" → onboarding).
// An unknown/garbage value from a newer or hand-edited row degrades to null rather than
// crashing the picker. Reads the caller's own row (RLS: profiles_select is `using (true)`,
// but we scope to auth.uid() for a single row).
export async function getMyAgentRuntime(client: SupabaseClient): Promise<AgentRuntimeKind | null> {
  const { data: auth } = await client.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) return null;
  const { data, error } = await client.from("profiles").select("agent_runtime").eq("id", uid).single();
  if (error || !data) return null;
  const v = (data as { agent_runtime: unknown }).agent_runtime;
  return isAgentRuntime(v) ? v : null;
}

// Persist the caller's choice. RLS `profiles_update_own` permits updating only auth.uid()'s
// row, so the eq() is defence-in-depth plus a single-row target.
export async function setMyAgentRuntime(client: SupabaseClient, kind: AgentRuntimeKind): Promise<void> {
  const { data: auth } = await client.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) throw new Error("not signed in");
  const { error } = await client.from("profiles").update({ agent_runtime: kind }).eq("id", uid);
  if (error) throw new Error(error.message);
}
```

- [ ] **Step 4: Export** from `packages/cloud/src/index.ts`: `export { getMyAgentRuntime, setMyAgentRuntime } from "./account";`

- [ ] **Step 5: Run + build.** `pnpm --filter @kermanych/cloud test -- account.spec` PASS; `pnpm --filter @kermanych/cloud build` EXIT 0.

- [ ] **Step 6: Commit.**

```bash
git add packages/cloud/src/types.ts packages/cloud/src/account.ts packages/cloud/src/index.ts packages/cloud/test/account.spec.ts
git commit -m "feat(cloud): profiles.agent_runtime read/write helpers"
```

---

## Task 3: Supabase migration for `profiles.agent_runtime`

**Files:** Create `supabase/migrations/<ts>_profile_agent_runtime.sql`. No unit test (schema; RLS already covers it).

- [ ] **Step 1: Pick the timestamp.** Read the newest file name under `supabase/migrations/` and choose the next `YYYYMMDDHHMMSS` after it (today is 2026-09-03).

- [ ] **Step 2: Write the migration.**

```sql
-- Per-user agent runtime preference (Increment 2). Additive and nullable: null means
-- "not chosen yet" (the UI shows the onboarding gate). RLS is unchanged — profiles_select
-- (using true) already allows reads and profiles_update_own (id = auth.uid()) already allows
-- a user to set their own value, so no new policy is needed. Safe to push at any time.
alter table public.profiles add column agent_runtime text;
```

- [ ] **Step 3: Commit.**

```bash
git add supabase/migrations/*_profile_agent_runtime.sql
git commit -m "feat(db): profiles.agent_runtime column (per-user runtime preference)"
```

- [ ] **Step 4: Operator note (do NOT run in CI/tests):** the hosted project is updated out-of-band with `supabase db push --linked`. Record this in the task report so the operator knows to push before the feature works against the shared project.

---

## Task 4: registry — cache column + `sessions.runtime`

**Files:** Modify `apps/api/src/registry/registry.service.ts`. Test: `apps/api/test/registry.runtime.spec.ts`.

**Interfaces:**
- Consumes: `AgentRuntimeKind`, `isAgentRuntime` from `@kermanych/core`.
- Produces: `AuthSessionRow.agentRuntime?: AgentRuntimeKind`; `sessions.runtime` persisted through `createSession`/`updateSession`/`listSessions`; `getAuthSession`/`setAuthSession` carry `agentRuntime`.

- [ ] **Step 1: Write the failing test.**

```ts
// apps/api/test/registry.runtime.spec.ts
import { describe, it, expect } from "vitest";
import { RegistryService } from "../src/registry/registry.service";

function reg() { return new RegistryService(":memory:"); }

describe("registry runtime preference + session.runtime", () => {
  it("round-trips the cached agent_runtime on the auth session", () => {
    const r = reg();
    r.setAuthSession({ userId: "u1", accessToken: "t", agentRuntime: "claude-code" });
    expect(r.getAuthSession()?.agentRuntime).toBe("claude-code");
  });
  it("persists and reads back Session.runtime", () => {
    const r = reg();
    const s = r.createSession({ projectId: "p", name: "n", task: "", worktreePath: "", branch: "b", worktree: true, kind: "agent", runtime: "claude-code" });
    const read = r.listSessions().find((x) => x.id === s.id);
    expect(read?.runtime).toBe("claude-code");
  });
});
```

(Adjust the `createSession` argument object to match its real required fields — read the current signature; the point is that `runtime` is accepted and persisted.)

- [ ] **Step 2: Run, confirm it fails** (`agentRuntime`/`runtime` not persisted). `pnpm --filter @kermanych/api test -- registry.runtime`.

- [ ] **Step 3: Implement.** In `registry.service.ts`:
  1. `AuthSessionRow` (lines ~13-18): add `agentRuntime?: AgentRuntimeKind;` (import the type from `@kermanych/core`).
  2. Additive migrations block (near lines 66-176, following the `try { ALTER TABLE … } catch {}` idiom): add
     ```ts
     try { this.db.exec(`ALTER TABLE auth_session ADD COLUMN agent_runtime TEXT`); } catch { /* exists */ }
     try { this.db.exec(`ALTER TABLE sessions ADD COLUMN runtime TEXT`); } catch { /* exists */ }
     ```
  3. `getAuthSession` (lines ~492-500): add `agent_runtime as agentRuntime` to the SELECT and, in the returned object, `agentRuntime: isAgentRuntime(row.agentRuntime) ? row.agentRuntime : undefined`.
  4. `setAuthSession` (INSERT OR REPLACE, ~502): add the `agent_runtime` column + bind `row.agentRuntime ?? null`.
  5. `createSession`: add `runtime: input.runtime` to the built `row` (line ~345-355), add `runtime` to the INSERT column list + `row.runtime ?? null` to `.run(...)` (lines 357-381).
  6. `updateSession`: add `runtime=?` to the UPDATE + `next.runtime ?? null` (lines 392-414).
  7. `listSessions` SELECT: add `runtime` to the column list and map `runtime: isAgentRuntime(r.runtime) ? r.runtime : undefined` (mirrors how `effort` is guarded there).

- [ ] **Step 4: Run + typecheck.** `pnpm --filter @kermanych/api test -- registry.runtime` PASS; `pnpm --filter @kermanych/api typecheck` EXIT 0.

- [ ] **Step 5: Commit.** `git commit -m "feat(api): registry caches agent_runtime and persists Session.runtime"`

---

## Task 5: supervisor — resolve + stamp the runtime

**Files:** Modify `apps/api/src/supervisor/supervisor.service.ts`. Test: `apps/api/test/supervisor.runtime-pref.spec.ts`.

**Interfaces:**
- Consumes: `registry.getAuthSession().agentRuntime` (Task 4); `Session.runtime` (Task 1); `createRuntime`/`runtimeFor` (Inc 1).
- Produces: `runtimeFor()` precedence `env override → cached preference → 'omp'`; `Session.runtime` stamped at `createChat` + `createSessionFromTask`.

- [ ] **Step 1: Write the failing test.** Construct `SupervisorService` with a `RegistryService(":memory:")` (follow the existing supervisor spec setup — read one, e.g. `supervisor.project.spec.ts`, for the exact constructor deps/fakes). Assert: with no env and a cached `agentRuntime: 'claude-code'`, a created chat/session row has `runtime: 'claude-code'`; with the cache unset it is `'omp'`; and `KERMANYCH_RUNTIME=omp` overrides a `'claude-code'` cache. If constructing the full supervisor in a unit test is impractical, instead extract the resolution into a pure helper `resolveRuntime(env: string | undefined, cached: AgentRuntimeKind | undefined): AgentRuntimeKind` in `apps/api/src/runtime/` and unit-test THAT, and have `runtimeFor()` call it — prefer this (a pure, directly-testable function).

```ts
// apps/api/test/runtime-resolve.spec.ts  (if you extract the pure helper)
import { describe, it, expect } from "vitest";
import { resolveRuntime } from "../src/runtime/resolve-runtime";
describe("resolveRuntime", () => {
  it("env override wins", () => expect(resolveRuntime("claude-code", "omp")).toBe("claude-code"));
  it("cached preference when no env", () => expect(resolveRuntime(undefined, "claude-code")).toBe("claude-code"));
  it("defaults to omp", () => expect(resolveRuntime(undefined, undefined)).toBe("omp"));
  it("ignores invalid env", () => expect(resolveRuntime("bogus", "claude-code")).toBe("claude-code"));
});
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement.**
  1. Create `apps/api/src/runtime/resolve-runtime.ts`:
     ```ts
     import { isAgentRuntime, type AgentRuntimeKind } from "@kermanych/core";
     // env override (dev) beats the user's cached preference beats the omp default.
     export function resolveRuntime(env: string | undefined, cached: AgentRuntimeKind | undefined): AgentRuntimeKind {
       if (isAgentRuntime(env)) return env;
       return cached ?? "omp";
     }
     ```
  2. In `supervisor.service.ts`, replace the Increment-1 `runtimeFor` (lines 565-571) with:
     ```ts
     // Per-user preference (Increment 2): env override → cached cloud preference → omp.
     // The cache is filled at sign-in (auth.service) and refreshed by POST /account/runtime.
     private runtimeFor(_session?: Session): AgentRuntimeKind {
       return resolveRuntime(process.env.KERMANYCH_RUNTIME, this.registry.getAuthSession()?.agentRuntime);
     }
     ```
     Import `resolveRuntime` from `../runtime/resolve-runtime`.
  3. Stamp `runtime` to match the backend that ACTUALLY spawns the session (never the raw preference), so `doResume` always respawns the same backend after a preference change:
     - `createSessionFromTask` (the `registry.createSession({ … })` call ~line 370) → `runtime: this.runtimeFor()`. This is the agent path, routed through the factory by `launch`, so it honors the preference.
     - `createChat` (~line 437), `branchSession`, and `reviewSession` → `runtime: "omp"` LITERALLY. These sites still spawn omp directly via `new RpcSession(...)` (Increment 1 did not route them; chat/discussion/review move to the factory in Increment 3). Stamping the preference here would both lie and BREAK resume: with a claude preference, `doResume` (routed) would try to `switch_session` an omp session file through the claude adapter. Stamp the truth (`"omp"`) so resume stays correct.
  4. Launch/resume call `createRuntime(this.runtimeFor(session), …)` today (Inc 1). Change BOTH sites to `createRuntime(session.runtime ?? "omp", …)` — use the STAMPED value, and fall back to `"omp"` (NOT `runtimeFor()`) when it is absent. An absent stamp means a legacy pre-Increment-2 row, which is necessarily omp (omp was the only backend); re-resolving via the current preference would make a claude preference try to resume an omp session file through the claude adapter — the exact break stamping prevents. At `launch` the stamp is always set (createSession just stamped it), so the fallback only ever applies to old rows at resume.
  5. Test coverage: the T5 spec MUST assert that (a) with a cached `claude-code` preference, a `createSessionFromTask` row stamps `runtime: "claude-code"` while a `createChat` row stamps `runtime: "omp"`; and (b) resume of an `omp`-stamped row uses omp even when the cached preference is now `claude-code`.

- [ ] **Step 4: Run + typecheck.** Focused tests + `pnpm --filter @kermanych/api typecheck` EXIT 0.

- [ ] **Step 5: Commit.** `git commit -m "feat(api): resolve runtime from user preference and stamp Session.runtime"`

---

## Task 6: auth cache-load on sign-in + account endpoint

**Files:** Modify `apps/api/src/auth/auth.service.ts`, `apps/api/src/app.module.ts`; create `apps/api/src/http/account.controller.ts`. Test: `apps/api/test/account.controller.spec.ts`.

**Interfaces:**
- Consumes: `auth.service.cloudClient()`; `getMyAgentRuntime` (Task 2); `registry.setAuthSession`/`getAuthSession` (Task 4).
- Produces: `GET /account/runtime` → `{ runtime: AgentRuntimeKind | null }`; `POST /account/runtime` `{ runtime }` → caches it locally.

- [ ] **Step 1: Write the failing controller test.** Follow an existing controller spec (e.g. one under `apps/api/test/`) for how controllers are constructed with fake services. Assert: `POST /account/runtime` with `{ runtime: 'claude-code' }` calls `registry.setAuthSession` preserving the existing row and setting `agentRuntime`; an invalid runtime throws `BadRequestException`; `GET` returns the cached value.

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement the controller** `apps/api/src/http/account.controller.ts`:

```ts
import { BadRequestException, Body, Controller, Get, Post } from "@nestjs/common";
import { isAgentRuntime, type AgentRuntimeKind } from "@kermanych/core";
import { RegistryService } from "../registry/registry.service";

// The signed-in user's per-account runtime preference, cached locally. Source of truth is
// the cloud `profiles.agent_runtime`; the UI writes that under its own JWT, then POSTs here
// so the launch path (SupervisorService.runtimeFor) sees the change without a network read.
@Controller("account")
export class AccountController {
  constructor(private registry: RegistryService) {}

  @Get("runtime")
  getRuntime(): { runtime: AgentRuntimeKind | null } {
    return { runtime: this.registry.getAuthSession()?.agentRuntime ?? null };
  }

  @Post("runtime")
  setRuntime(@Body() b: { runtime?: string }): { runtime: AgentRuntimeKind } {
    if (!isAgentRuntime(b?.runtime)) throw new BadRequestException(`unknown runtime ${JSON.stringify(b?.runtime)}`);
    const cur = this.registry.getAuthSession();
    if (!cur) throw new BadRequestException("not signed in");
    this.registry.setAuthSession({ ...cur, agentRuntime: b.runtime });
    return { runtime: b.runtime };
  }
}
```

- [ ] **Step 4: Register** `AccountController` in `apps/api/src/app.module.ts` (add to the `controllers` array alongside the others).

- [ ] **Step 5: Best-effort cache-load on sign-in.** In `auth.service.ts` `setToken` (after it persists the auth session, ~line 47-92), add a best-effort load so a fresh machine inherits the cloud preference:

```ts
// Bring the user's cloud runtime preference into the local cache so the first launch
// on a new machine respects it without a network read on the hot path. Best-effort:
// a failure leaves the cache as-is (runtimeFor falls back to omp), never blocks sign-in.
try {
  const runtime = await getMyAgentRuntime(this.cloudClient());
  if (runtime) {
    const cur = this.registry.getAuthSession();
    if (cur) this.registry.setAuthSession({ ...cur, agentRuntime: runtime });
  }
} catch { /* offline or profile unreadable — cache stays, omp default applies */ }
```

Import `getMyAgentRuntime` from `@kermanych/cloud`. Place it after the `setAuthSession` that records the session, so `getAuthSession()` returns a row to spread.

- [ ] **Step 6: Run + typecheck.** Focused tests + `pnpm --filter @kermanych/api typecheck` EXIT 0.

- [ ] **Step 7: Commit.** `git commit -m "feat(api): account runtime endpoint + cache cloud preference on sign-in"`

---

## Task 7: UI auth store — load + set the runtime

**Files:** Modify `apps/ui/src/stores/auth.ts`, `apps/ui/src/lib/api.ts`. Verified by `apps/ui` typecheck + (if a store test harness exists) a unit test; else by the smoke.

**Interfaces:**
- Consumes: `getMyAgentRuntime`/`setMyAgentRuntime` (Task 2); the raw Supabase `client`; `api`.
- Produces: `auth.runtime: Ref<AgentRuntimeKind | null>`; `auth.chooseRuntime(kind)` (writes cloud + pings API + updates the ref).

- [ ] **Step 1: `lib/api.ts` methods.** Add, following the existing `api` method pattern:
  - `getAccountRuntime(): Promise<{ runtime: AgentRuntimeKind | null }>` → `GET /account/runtime`.
  - `setAccountRuntime(runtime: AgentRuntimeKind): Promise<void>` → `POST /account/runtime` with `{ runtime }`.

- [ ] **Step 2: auth store.** Add `const runtime = ref<AgentRuntimeKind | null>(null);`. In `apply(session)` after the profile is set and the token handed off (after line ~74), load the preference best-effort:

```ts
try { runtime.value = await getMyAgentRuntime(client); } catch { runtime.value = null; }
```

Add a setter and return it from the store:

```ts
async function chooseRuntime(kind: AgentRuntimeKind): Promise<void> {
  await setMyAgentRuntime(client, kind);   // cloud = source of truth (user's JWT)
  await api.setAccountRuntime(kind);        // refresh the local API cache for launches
  runtime.value = kind;
}
```

Return `runtime` and `chooseRuntime` in the store's returned object. Import `getMyAgentRuntime`, `setMyAgentRuntime`, and `type AgentRuntimeKind`.

- [ ] **Step 3: Typecheck.** `pnpm --filter @kermanych/ui typecheck` (`vue-tsc`) EXIT 0. If `apps/ui/test` has a store/logic harness that can cover `chooseRuntime`'s call order with a fake client+api, add a focused test; otherwise note that this is smoke-verified in Task 11.

- [ ] **Step 4: Commit.** `git commit -m "feat(ui): auth store loads and sets the agent runtime preference"`

---

## Task 8: onboarding gate modal

**Files:** Modify `apps/ui/src/layouts/MainLayout.vue`, `apps/ui/src/i18n/{uk,en}/index.ts`. Verified by typecheck + smoke.

- [ ] **Step 1: i18n keys.** Add to BOTH locales (uk source-of-truth first, en identical paths):

```
onboarding.runtime.title   uk: "Оберіть ШІ-провайдера"                       en: "Choose your AI provider"
onboarding.runtime.blurb   uk: "Цим бекендом працюватимуть усі твої агенти. Змінити можна згодом у налаштуваннях профілю."
                           en: "All your agents run on this backend. You can change it later in profile settings."
onboarding.runtime.omp     uk: "omp"                                          en: "omp"
onboarding.runtime.claude  uk: "claude-code"                                  en: "claude-code"
onboarding.runtime.confirm uk: "Продовжити"                                   en: "Continue"
```

(Provider ids `omp` / `claude-code` are raw tokens; the label keys exist only so the picker rows are addressable and future-proofed.)

- [ ] **Step 2: The gate.** In `MainLayout.vue`, mount a `KModal` (follow the existing CREATE-WORKSPACE/CREATE-PROJECT modal pattern, lines ~244-283) shown when the user is signed in AND `auth.runtime === null`. It offers the two providers and calls `auth.chooseRuntime(kind)` on confirm, then closes. It is not dismissible without a choice (no cancel path — the whole point is a one-time gate). Use `const { t } = useI18n()` and the keys above; read `const auth = useAuth()`. Gate open state: `const onboardingOpen = computed(() => !!auth.user && auth.runtime === null)`.

- [ ] **Step 3: Typecheck + smoke note.** `pnpm --filter @kermanych/ui typecheck` EXIT 0. Behavior verified in Task 11.

- [ ] **Step 4: Commit.** `git commit -m "feat(ui): onboarding gate to choose the AI provider"`

---

## Task 9: profile settings pane

**Files:** Modify `apps/ui/src/lib/settings.ts`, `apps/ui/src/pages/SettingsPage.vue`, `apps/ui/src/i18n/{uk,en}/index.ts`. Verified by typecheck + smoke (+ `settings.spec.ts` if it asserts the registry).

- [ ] **Step 1: Registry row.** In `settings.ts`, add to `SETTINGS_CATEGORIES` (array at lines 41-59), in the `app` scope group: `{ key: 'app-runtime', scope: 'app' }`. (Read the exact `SettingsCategory` shape at lines 27-33 and match it — e.g. include `danger` only if required.)

- [ ] **Step 2: i18n keys** (both locales):

```
settings.categories.app-runtime.label  uk: "ШІ-провайдер"      en: "AI provider"
settings.categories.app-runtime.sub    uk: "Бекенд агентів"    en: "Agent backend"
settings.categories.app-runtime.blurb  uk: "Який рушій виконує твоїх агентів. Застосується до нових сесій."
                                        en: "Which engine runs your agents. Applies to new sessions."
settings.runtime.current               uk: "Поточний: {name}"  en: "Current: {name}"
settings.runtime.omp                   uk: "omp"               en: "omp"
settings.runtime.claude                uk: "claude-code"       en: "claude-code"
settings.runtime.note                  uk: "Наявні сесії лишаються на своєму бекенді."
                                        en: "Existing sessions keep their current backend."
```

- [ ] **Step 3: The pane.** In `SettingsPage.vue`, add a `v-if="section.key === 'app-runtime'"` block (mirror an existing `app`-scope pane such as `app-helpers`), showing the current `auth.runtime` and a picker (two options) that calls `auth.chooseRuntime(kind)`. All strings via `t(...)`. Reuse the existing chip/select kit (`KChipSelect`/`KSelect`) that the composer already uses for model/effort.

- [ ] **Step 4: Typecheck + smoke note.** `pnpm --filter @kermanych/ui typecheck` EXIT 0.

- [ ] **Step 5: Commit.** `git commit -m "feat(ui): profile settings pane to change the AI provider"`

---

## Task 10: dynamic harness label

**Files:** Modify `apps/ui/src/components/kit/KPanel.vue`. Verified by typecheck + smoke.

- [ ] **Step 1: Make the label read the session.** Replace line 6 `<span class="k-panel__harness mono">omp</span>` with `<span class="k-panel__harness mono">{{ session.runtime || 'omp' }}</span>`. The runtime id is a raw token (a proper noun), NOT a translated string, so no i18n key. Confirm `session` is the panel's prop and `Session.runtime` is now typed (Task 1 built into core).

- [ ] **Step 2: Typecheck.** `pnpm --filter @kermanych/ui typecheck` EXIT 0.

- [ ] **Step 3: Commit.** `git commit -m "feat(ui): show the session's runtime as the harness label"`

---

## Task 11: verification (suite + smoke)

**Files:** none. Prerequisites for the live smoke: the migration pushed to the operator's Supabase project (`supabase db push --linked`) OR a local stack; the `claude` CLI authenticated (for a claude session).

- [ ] **Step 1: Full suite + typecheck.** `pnpm --filter @kermanych/core build && pnpm --filter @kermanych/cloud build && pnpm --filter @kermanych/api typecheck && pnpm --filter @kermanych/ui typecheck && pnpm -r test`. Expected: all green (note the known-flaky finish/origin-sync git-timeout tests under concurrent load — re-run in isolation if they trip). If `packages/cloud` has an RLS integration suite and the env fixtures are set, confirm a user can update only their own `profiles.agent_runtime`.
- [ ] **Step 2: Onboarding smoke.** `pnpm dev:app`, sign in with an account whose `profiles.agent_runtime` is null → the gate appears → choose `claude-code` → it persists (reload: no gate; the settings pane shows claude-code).
- [ ] **Step 3: Per-user launch smoke.** With the preference `claude-code` and NO `KERMANYCH_RUNTIME` env, create + run an agent task → it runs on claude (harness label shows `claude-code`), transcript renders (the Increment-1 integration test already guards the reducer contract). Change the setting back to `omp` → a NEW session uses omp; the existing claude session, on resume, stays claude.
- [ ] **Step 4: Record findings** in a sibling `…-increment-2-findings.md` and commit.

---

## Self-review (author checklist — completed)

- **Spec coverage (§4/§8):** cloud `profiles.agent_runtime` + RLS reuse (T2/T3) ✓; local cache in `auth_session` (T4/T6) ✓; `Session.runtime` stamped at creation + used on resume (T1/T4/T5) ✓; onboarding gate (T8) ✓; profile settings pane (T9) ✓; env becomes dev override (T5 `resolveRuntime`) ✓; dynamic harness label (T10) ✓; write path = UI writes cloud under JWT + pings API cache (T7/T6) ✓.
- **Placeholder scan:** full code for new modules (account.ts, resolve-runtime.ts, account.controller.ts, migration) and exact edits for existing files; UI-component tasks give precise integration points + patterns to follow (KModal / SETTINGS_CATEGORIES / existing pane) because those files are read at implementation time — no invented component internals.
- **i18n:** every UI string is a key added to both locales (T8/T9); provider ids and the harness label are raw tokens by design.
- **Type consistency:** `AgentRuntimeKind` used uniformly; `Session.runtime` (T1) is read by registry (T4), stamped by supervisor (T5), rendered by KPanel (T10); `agentRuntime` (camel) in cloud/registry domain vs `agent_runtime` (snake) at the SQL/Supabase boundary, mapped only inside cloud + registry.
- **Ordering:** core (T1) and cloud (T2) build before api (T4-6) and ui (T7-10) consume them; migration (T3) is independent (operator-pushed).
