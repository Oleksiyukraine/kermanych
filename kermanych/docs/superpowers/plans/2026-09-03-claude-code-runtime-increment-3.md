# claude-code runtime — Increment 3 (breadth) Implementation Plan

- **Status:** Plan (implementation pending)
- **Branch:** stack on `feature/agent-runtime-preference` (Inc 1 + Inc 2) OR fork a fresh branch off `dev` after Inc 2 merges. Decide at execution time; the tasks are merge-order-independent.
- **Spec:** `docs/superpowers/specs/2026-09-02-claude-code-runtime-design.md` (§7 soft-parity, §8 Increment 3).
- **Depends on:** Inc 1 (AgentRuntime + factory + ClaudeCodeRuntime + RpcEvent contract) and Inc 2 (`Session.runtime` stamping, `runtimeFor()`, `resolveRuntime`). Both DONE.

## Goal

Bring the remaining session kinds and cross-cutting features to runtime parity so a claude-preference user gets claude everywhere (not just agent tasks): route `createChat` / `branchSession` / `reviewSession` and the two management services through the factory; make the model picker runtime-aware; confirm prompt-inline skills + per-session usage for claude; hide the plan-chip where claude has no todoPhases.

## Scope (spec §8)

1. discussion / review / chat parity through the factory.
2. management-chat + release-notes through the factory (spec §7 decision b).
3. prompt-inline skills for claude (verify — Inc 1 already routes the prompt path).
4. per-session usage for claude (verify — Inc 1 already maps `modelUsage` → `message_end`).
5. plan-chip hiding when the session has no `todoPhases` (claude).
6. runtime-aware model picker (spec line 302; scheduled Inc 2, not built — folded here as it depends on the SDK `supportedModels()` catalog).

## Rulings (design decisions, baked in)

- **R1 — fork inherits the parent's runtime.** `branchSession` forks the parent session; a fork can only continue on the SAME backend (claude `forkSession(uuid)` resumes a claude session; omp forks an omp session file). Therefore `branchSession` stamps `runtime: parent.runtime`, NOT `runtimeFor()`. `createChat` and `reviewSession` are fresh sessions → they use `runtimeFor()` (the user preference).
- **R2 — fork identity is per-runtime.** The `fork` opt means different things per backend: omp = parent's `ompSessionFile` (path); claude = parent's `ompSessionId` (UUID, fed to the SDK as `resume` + `forkSession:true`, see `claude-code-runtime.ts:73`). The spawn site MUST pass the right handle for the parent's runtime.
- **R3 — management services read the preference via the registry.** `ManagementChatService` and `ReleaseNotesService` already depend on `RegistryService`; they gain a private `runtimeFor()` that calls `resolveRuntime(process.env.KERMANYCH_RUNTIME, this.registry.getAuthSession()?.agentRuntime)` (same body as the supervisor). No new injectable. These sessions are ephemeral (no `sessions` row) → nothing to stamp.
- **R4 — `noTools` uses `allowedTools: []`.** The adapter currently sets `tools: []` (`claude-code-runtime.ts:72`), which is not a canonical SDK Option and is a no-op. Fix to `allowedTools: []` (empty allowlist = no tools), consistent with the `allowedTools` path already wired at line 71.
- **R5 — claude branch rehydrate is a known degradation.** `getAllMessages()` returns `[]` for claude (`claude-code-runtime.ts:133`, Inc 1 stub), so a claude branch's parent transcript is not re-rendered in the UI even though the SDK fork carries the context server-side. Accept for Inc 3; full resume-rehydrate is Inc 4. Note it in the branch flow.
- **R6 — subscription-plan usage stays omp-only.** `usage.service.ts` (`omp usage --json`) has no claude equivalent; a claude account returns empty providers and the UI already hides the plan-spend chip (spec §7). Only PER-SESSION spend (`message_end.usage`) is runtime-neutral and already wired.

## File-touch map

- `apps/api/src/runtime/claude-code-runtime.ts` — R4 noTools fix (T1).
- `apps/api/src/supervisor/supervisor.service.ts` — route `createChat` (~440/443), `reviewSession` (~733/739), `branchSession` (~672/679) through `createRuntime` (T2, T3).
- `apps/api/src/management/management-chat.service.ts` (~239), `apps/api/src/management/release-notes.service.ts` (~99) — add `runtimeFor()`, route through the factory (T4).
- `apps/api/src/models/models.service.ts`, `apps/api/src/runtime/claude-code-runtime.ts` (+ maybe `apps/api/src/models/claude-models.ts` new) — runtime-aware catalog (T5).
- `apps/api/src/runtime/claude-event-map.ts` (verify), tests (T6).
- `apps/ui/src/components/kit/KPanel.vue` (~137) — plan-chip guard (T7).
- Tests: `apps/api/test/*` for each surface; `apps/ui` verified by `vue-tsc` + smoke.

---

## Task 1: adapter — `noTools` + restricted-tools enforcement

**Files:** `apps/api/src/runtime/claude-code-runtime.ts`. Test: `apps/api/test/claude-code-runtime.spec.ts` (extend existing).

**Why:** `branchSession` (noTools) and management/review (restricted tools) depend on the adapter honoring the tool options. `allowedTools` is wired (line 71) but `noTools` sets a non-canonical `tools: []` (line 72, no-op).

- [ ] **Step 1: Read current `start()` Options** (lines 62-74). Confirm line 71 `allowedTools` and line 72 `tools: []`.
- [ ] **Step 2: Failing test.** With the injected fake `queryFn`, capture the `Options` passed to `query()`. Assert: `noTools: true` → `options.allowedTools` is `[]` (and no stray `tools` key); `tools: ['read','grep','glob']` → `options.allowedTools` equals that array; neither set → no `allowedTools` key.
- [ ] **Step 3: Fix.** Replace line 72 `...(this.opts.noTools ? { tools: [] } : {})` with `...(this.opts.noTools ? { allowedTools: [] } : {})`. Keep line 71 as-is. (If both `tools` and `noTools` were ever set, `noTools` wins — put it after and let it overwrite, or guard so noTools takes precedence.)
- [ ] **Step 4: Run + typecheck.** `pnpm --filter @kermanych/api test -- claude-code-runtime` PASS; `pnpm --filter @kermanych/api typecheck` EXIT 0.
- [ ] **Step 5: Commit.** `feat(runtime): claude adapter honors noTools via empty allowedTools`.

---

## Task 2: route `createChat` + `reviewSession` through the factory

**Files:** `apps/api/src/supervisor/supervisor.service.ts`. Test: `apps/api/test/supervisor.chat-review-runtime.spec.ts`.

**Interfaces:** consumes `runtimeFor()` (Inc 2), `createRuntime` (Inc 1). Produces: both kinds stamped + spawned on the user's runtime.

- [ ] **Step 1: Read** the current `createChat` (~434-470) and `reviewSession` (~706-755) bodies for the exact session-creation call and the `new RpcSession({...})` spawn.
- [ ] **Step 2: Failing test.** Construct `SupervisorService` with `RegistryService(":memory:")` and an injected fake runtime factory (or spy on `createRuntime`); follow an existing supervisor spec for the deps/fakes. Assert: with a cached `agentRuntime: 'claude-code'`, a `createChat` row and a `reviewSession` row are stamped `runtime: 'claude-code'` and the factory is called with that kind; with no preference, `'omp'`.
- [ ] **Step 3: Implement.**
  - `createChat`: change the hardcoded `runtime: "omp"` at the `registry.createSession({...})` call (~line 440) to `runtime: this.runtimeFor()`; change the spawn (~line 443) from `new RpcSession({ cwd, tools: CHAT_TOOLS, configPath?, extensionPath? })` to `createRuntime(session.runtime ?? "omp", { cwd, tools: CHAT_TOOLS, configPath?, extensionPath? })`.
  - `reviewSession`: same pattern — stamp `runtime: this.runtimeFor()` (~line 733); spawn `createRuntime(session.runtime ?? "omp", { cwd, tools: ["read","grep","glob"], configPath?, extensionPath? })` (~line 739). The pre-filled diff prompt is unchanged.
  - Import `createRuntime` if not already imported in this file (launch/doResume already use it — likely present).
- [ ] **Step 4: Run + typecheck.** Focused test PASS; `pnpm --filter @kermanych/api typecheck` EXIT 0.
- [ ] **Step 5: Commit.** `feat(api): route chat + review sessions through the runtime factory`.

---

## Task 3: route `branchSession` through the factory (fork, inherit parent)

**Files:** `apps/api/src/supervisor/supervisor.service.ts`. Test: `apps/api/test/supervisor.branch-runtime.spec.ts`.

**Interfaces:** consumes `createRuntime`, parent `Session.runtime`, parent `ompSessionId`/`ompSessionFile`. Produces: a branch stamped with the PARENT's runtime and forked on the correct backend handle (R1, R2).

- [ ] **Step 1: Read** `branchSession` (~647-695): the parent lookup, the `runtime: "omp"` stamp (~672), the `new RpcSession({ cwd, fork: parentFile, noTools: true, ... })` spawn (~679), and the `getAllMessages()` rehydrate (~684).
- [ ] **Step 2: Failing test.** Assert: branching a `claude-code` parent stamps the child `runtime: 'claude-code'` and calls the factory with `kind: 'claude-code'` and `fork` = the parent's `ompSessionId` (UUID); branching an `omp` parent stamps `'omp'` and passes `fork` = the parent's `ompSessionFile` (path). (Use a fake factory/spy; construct parent rows via the registry.)
- [ ] **Step 3: Implement.**
  - Stamp `runtime: parent.runtime ?? "omp"` at the child `createSession` (~672) — R1 (fork inherits the parent's backend, never `runtimeFor()`).
  - Compute the fork handle per runtime (R2): `const forkHandle = parent.runtime === "claude-code" ? parent.ompSessionId : parent.ompSessionFile;` (read the exact field names on `Session`; Inc 1 stores the claude session UUID in `ompSessionId`). Guard: if the needed handle is missing, refuse the branch with a clear error (as the omp path already refuses a missing file).
  - Spawn `createRuntime(parent.runtime ?? "omp", { cwd, fork: forkHandle, noTools: true, configPath?, extensionPath? })` (~679).
  - Keep the `getAllMessages()` rehydrate call (~684). Add a comment: for claude it returns `[]` today (R5) — the fork carries context server-side but the parent transcript is not re-rendered until Inc 4.
- [ ] **Step 4: Run + typecheck.** Focused test PASS; typecheck EXIT 0.
- [ ] **Step 5: Commit.** `feat(api): route branch (discussion) sessions through the factory, inheriting the parent runtime`.

---

## Task 4: route `management-chat` + `release-notes` through the factory

**Files:** `apps/api/src/management/management-chat.service.ts`, `apps/api/src/management/release-notes.service.ts`. Tests: extend the existing specs for each (or add `*.runtime.spec.ts`).

**Interfaces:** consumes `RegistryService.getAuthSession()?.agentRuntime`, `resolveRuntime` (Inc 2), `createRuntime` (Inc 1). Produces: both services spawn on the user's chosen runtime (R3).

- [ ] **Step 1: Read** the spawn in each (`management-chat.service.ts:~239`, `release-notes.service.ts:~99`) and each service's constructor deps (confirm `RegistryService` is injected).
- [ ] **Step 2: Failing test.** With a fake registry whose `getAuthSession()` returns `agentRuntime: 'claude-code'`, assert the service calls the factory with `kind: 'claude-code'`; default `'omp'` when unset. (Follow the existing management-chat / release-notes spec harness.)
- [ ] **Step 3: Implement.**
  - Add to each service: `import { resolveRuntime } from "../runtime/resolve-runtime"; import { createRuntime } from "../runtime/agent-runtime";` and a private `runtimeFor(): AgentRuntimeKind { return resolveRuntime(process.env.KERMANYCH_RUNTIME, this.registry.getAuthSession()?.agentRuntime); }`.
  - Replace `new RpcSession({ cwd, tools: [...MANAGEMENT_TOOLS] })` with `createRuntime(this.runtimeFor(), { cwd, tools: [...MANAGEMENT_TOOLS] })` at both sites.
  - `MANAGEMENT_TOOLS` (read-only) map to the adapter's `allowedTools` (T1) for claude; no other change. No model/effort/fork.
- [ ] **Step 4: Run + typecheck.** Focused tests PASS; typecheck EXIT 0.
- [ ] **Step 5: Commit.** `feat(api): run management-chat and release-notes on the user's chosen runtime`.

---

## Task 5: runtime-aware model picker

**Files:** `apps/api/src/runtime/claude-code-runtime.ts` (+ `apps/api/src/models/claude-models.ts` new mapper), `apps/api/src/models/models.service.ts`. Test: `apps/api/test/models.runtime.spec.ts`.

**Interfaces:** consumes the SDK `supportedModels(): Promise<ModelInfo[]>` (sdk.d.ts:2738; `ModelInfo` = `{ value, resolvedModel?, displayName, description, supportsEffort?, supportedEffortLevels? }` sdk.d.ts:1266). Produces: `GET /models` returns the catalog for the caller's runtime; the `ModelOption[]` shape is unchanged so `KComposer.vue` needs no edits.

- [ ] **Step 1: Read** `models.service.ts` (the `omp models --json` spawn + TTL cache + `mapOmpModels`) and confirm `ModelOption = { id, name, provider, efforts: ThinkingLevel[] }`.
- [ ] **Step 2: claude catalog source.** Add a way to fetch the claude catalog. Prefer a static call on the SDK if `supportedModels()` is exposed without a live `query` (check the SDK surface); otherwise expose `ClaudeCodeRuntime.supportedModels()` that calls `this.q.supportedModels()` on a short-lived query, or import the SDK's top-level `supportedModels` if available. Write `apps/api/src/models/claude-models.ts` mapping `ModelInfo[]` → `ModelOption[]`: `{ id: m.value, name: m.displayName, provider: "anthropic", efforts: mapEfforts(m.supportedEffortLevels) }`, translating the SDK effort levels (`low|medium|high|xhigh|max`) into `ThinkingLevel` via the existing `effort-map.ts` inverse.
- [ ] **Step 3: Failing test.** Assert: `models.service.list('claude-code')` returns the claude catalog (via an injected fake SDK/catalog fn) mapped to `ModelOption[]`; `list('omp')` still returns the omp catalog; both cache under the same TTL keyed by runtime.
- [ ] **Step 4: Implement.** Make `models.service.list(runtime)` branch on runtime: omp → existing `omp models --json`; claude → the new catalog fn. Cache per runtime (two TTL buckets). Wire `GET /models` (models controller) to read the caller's runtime (session or preference) and pass it in. `setModel` already works on the adapter (`claude-code-runtime.ts:126`).
- [ ] **Step 5: Run + typecheck.** Focused test PASS; typecheck EXIT 0.
- [ ] **Step 6: Commit.** `feat(api): runtime-aware model catalog (claude via SDK supportedModels)`.

---

## Task 6: verify per-session usage + prompt-inline skills for claude

**Files:** none expected (Inc 1 wired both); tests only. `apps/api/test/claude-event-map.usage.spec.ts` (extend), and a supervisor-level assertion.

**Why:** spec §8 lists these under Inc 3; the recon shows Inc 1 already routes them (`claude-event-map.ts:15-27` maps `modelUsage` → `message_end`; `assignedBlock()` is in the prompt path both backends use). This task locks them with tests, not new plumbing.

- [ ] **Step 1: Usage test.** Feed a scripted SDK result with `modelUsage` through `mapSdkMessage` and assert the emitted `message_end.usage` equals the `Usage` shape (`{input, output, cacheRead, cacheWrite, cost:{total}}`) and that `total_cost_usd`/`costUSD` lands in `cost.total`. Confirm `registry.addUsage` persists it for a claude session (supervisor-level or registry-level assertion).
- [ ] **Step 2: Skills test.** Assert the opening prompt for a claude launch contains the `ASSIGNED_BLOCK_HEADER` / `assignedBlock()` content (skills reach claude via the prompt, `packages/core/src/skills.ts:134`), and that `configPath`/`extensionPath` passed to the claude adapter are ignored (no SDK Option carries them — see T1 Options).
- [ ] **Step 3: If a gap surfaces** (e.g. `sumUsage` misses a field), fix it in `claude-event-map.ts` with the test as the guard.
- [ ] **Step 4: Run + typecheck.** PASS; typecheck EXIT 0.
- [ ] **Step 5: Commit.** `test(runtime): lock claude per-session usage + prompt-inline skills`.

---

## Task 7: plan-chip hiding for claude

**Files:** `apps/ui/src/components/kit/KPanel.vue`. Verified by `vue-tsc` + smoke.

- [ ] **Step 1: Read** KPanel.vue ~line 137 (`<KTodoLane :phases="session.todoPhases" />`).
- [ ] **Step 2: Guard.** Render the todo lane only when phases exist AND the session is not claude: `v-if="session.todoPhases?.length && session.runtime !== 'claude-code'"`. (Belt-and-braces: claude never sets `todoPhases`, but the explicit guard documents the degradation and survives any future partial SDK support.)
- [ ] **Step 3: Typecheck.** `pnpm --filter @kermanych/ui typecheck` EXIT 0.
- [ ] **Step 4: Commit.** `feat(ui): hide the plan-chip for claude sessions (no todoPhases)`.

---

## Task 8: verification (suite + smoke)

**Files:** none. Prereqs for the live smoke: Inc 2 migration pushed (`supabase db push --linked`); `claude` CLI authenticated.

- [ ] **Step 1: Full suite + typecheck.** `pnpm --filter @kermanych/core build && pnpm --filter @kermanych/cloud build && pnpm --filter @kermanych/api typecheck && pnpm --filter @kermanych/ui typecheck && pnpm -r test` — all green (re-run the known-flaky finish/origin-sync git-timeout tests in isolation if they trip).
- [ ] **Step 2: Parity smoke** (`pnpm dev:app`, claude preference, no `KERMANYCH_RUNTIME`): (a) open a quick **chat** on a project → runs on claude, harness label `claude-code`; (b) start a **discussion/branch** off a claude agent session → forks on claude (new session), no tools; (c) run a **review** of a diff → runs on claude, read-only; (d) open **management-chat** and **generate release-notes** → both run on claude; (e) a claude session shows **no plan-chip**; (f) the **model picker** lists claude models for a claude session and omp models for an omp session; (g) per-session **spend** accrues on a claude session.
- [ ] **Step 3: Cross-runtime check.** With an omp session and a claude session side by side: each keeps its own harness label, model list, and (omp-only) plan-chip; resuming each stays on its own backend (Inc 2 guarantee).
- [ ] **Step 4: Record findings** in `…-increment-3-findings.md` and commit.

---

## Self-review (author checklist)

- **Spec coverage (§8 Inc 3):** chat/discussion/review parity (T2/T3) ✓; management-chat + release-notes through the factory (T4) ✓; prompt-inline skills (T6 verify) ✓; per-session usage for claude (T6 verify) ✓; plan-chip hiding (T7) ✓; runtime-aware model picker (T5, folded from Inc 2) ✓.
- **Fork correctness (R1/R2):** branch inherits the parent's runtime and forks on the right handle (claude UUID via `resume+forkSession`, omp session file) — a claude parent can only branch to claude, an omp parent to omp; never cross-backend.
- **Degradations named honestly (spec §7):** claude branch parent-transcript rehydrate deferred to Inc 4 (R5, `getAllMessages()` → []); subscription-plan spend stays omp-only, UI hides the chip (R6); TTSR triggers remain omp-only (adapter ignores `extensionPath`).
- **Adapter bug fixed (R4):** `noTools` now uses the canonical `allowedTools: []` instead of the no-op `tools: []`.
- **No new plumbing where Inc 1 already routes:** usage + skills are locked by tests, not re-implemented; the factory signature (`RuntimeLaunchOpts`) already fits all five spawn sites (recon: no gaps).
- **Ordering:** T1 (adapter) before T3/T4 (which rely on noTools/allowedTools); T2-T4 (routing) independent of T5 (models) and T7 (UI); T6 is verification; T8 last.
- **Deferred to Inc 4 (hardening):** resume-rehydrate edge cases (incl. claude branch transcript), README dual-runtime docs, remaining test fill-in.
