# Design: claude-code as a selectable agent runtime alongside omp

- **Date:** 2026-09-02
- **Status:** Approved design (brainstorming complete); implementation plan pending
- **Branch:** `feature/claude-code-runtime` (worktree off `origin/dev`)

## 1. Goal and scope

Add Anthropic's **Claude Code** (driven through `@anthropic-ai/claude-agent-sdk`)
as a second agent-runtime backend that a user can choose **instead of** `omp`,
without regressing the existing omp experience.

**Target = practical parity, phased.** claude-code becomes selectable per user
and is fully usable for the session kinds that carry real work — `agent`,
`chat`, `discussion`, `review` — across the whole live loop: create → prompt →
stream → tool calls → follow-up → steer → stop → resume → fork, with model and
reasoning-effort control.

**Deliberately degraded / deferred for claude sessions** (see §7): TTSR content
triggers, the subscription-plan spend chip, and the omp-specific skills-overlay
machinery. Per-session token cost still works. Management chat and release-notes
run on the user's chosen runtime (routed through the same factory).

**Out of scope:** replacing omp; multi-provider abstractions beyond `omp` and
`claude-code`; changing the git-worktree / cloud-board / status-mirror
architecture (all of it is already backend-agnostic and stays untouched).

## 2. Decisions locked during brainstorming

1. **Definition of done:** practical parity, phased; build a vertical slice
   first to de-risk the live SDK before investing in data-model/UI.
2. **Selection granularity:** per **user** ("AI provider" = runtime backend
   `omp | claude-code`, extensible). Chosen at first entry (onboarding), changed
   later in account settings. One choice per account, applied to every session
   that user starts.
3. **Storage:** cloud (Supabase) is the source of truth, mirrored to a local
   registry cache so launch never needs the network (the existing D1 pattern).
4. **Driver:** the official SDK `@anthropic-ai/claude-agent-sdk` (not raw CLI
   stdio), so `interrupt()`, `setModel()`, `supportedModels()`, `canUseTool`,
   and partial-message streaming come for free.
5. **Management chat + release-notes:** routed through the same runtime factory
   (option b), so a user who picks claude-code and has no omp installed does not
   lose those two surfaces.

## 3. Architecture — the `AgentRuntime` seam

### 3.1 Canonical event contract = `RpcEvent`

Reconnaissance established that the UI and the entire supervisor already consume
**normalized** types (`TranscriptEntry`, `Usage`, `SubscriptionUsage`,
`ModelOption`, `TodoPhase`, `SessionStatus`, `RpcStateData`), and that the real
abstraction boundary already sits at `RpcEvent` → `reduceRpcEvents` →
`TranscriptEntry` (`packages/core/src/types.ts`,
`apps/api/src/supervisor/transcript-reducer.ts`,
`apps/api/src/supervisor/messages-to-transcript.ts`).

**Decision:** keep `RpcEvent` (and `RpcStateData`) as the canonical
runtime-event/state contract. Every backend "speaks" this vocabulary. As a
result the reducer, transcript pipeline, status derivation
(`reduceStatus`), WebSocket gateway, cloud-sync, and all UI stay **unchanged**.
The names `RpcEvent`/`RpcStateData` are retained (no repo-wide rename in this
effort — YAGNI) but re-documented as the shared contract.

### 3.2 The interface

New `AgentRuntime` interface mirroring the current `RpcSession` surface
(`apps/api/src/rpc/rpc-session.ts`):

```ts
interface AgentRuntime {
  start(): Promise<void>;
  isAlive(): boolean;
  prompt(text: string, images?: ImageInput[]): void;
  followUp(text: string, images?: ImageInput[]): void;
  steer(text: string, images?: ImageInput[]): void;
  getState(): Promise<RpcStateData>;
  setModel(provider: string | undefined, modelId: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  resume(ref: string): Promise<void>;        // omp: switch_session(file); claude: resume(sessionId)
  getAllMessages(): Promise<unknown[]>;       // rehydrate on resume
  answerUi(res: RpcExtensionUIResponse): void;
  stop(): Promise<void>;
  onEvent(cb: (e: RpcEvent) => void): void;
  onExit(cb: (code: number | null, reason: string) => void): void;
}
```

### 3.3 Two implementations

- **`OmpRuntime`** — the current `RpcSession`, adapted to the interface. It
  already emits `RpcEvent` and speaks every command, so this is a
  wrap/rename with no behavioral change.
- **`ClaudeCodeRuntime`** — wraps `@anthropic-ai/claude-agent-sdk`'s `query()`
  in streaming-input mode and **translates SDK messages into `RpcEvent`** (and
  interface calls into SDK control requests). The SDK dependency is injectable
  (constructor seam) so the adapter is unit-testable against a fake SDK, exactly
  as `rpc-session.spec.ts` drives a fake omp binary.

### 3.4 Factory and routing

A `createRuntime(kind: AgentRuntimeKind, opts): AgentRuntime` factory replaces
the **seven** direct `new RpcSession({...})` construction sites:

| # | Site | File:line (pre-change) | Notes |
|---|------|------------------------|-------|
| 1 | `createChat` | `supervisor.service.ts:396` | read-only tools |
| 2 | `launch` (agent) | `supervisor.service.ts:557` | model/effort/fork |
| 3 | `branchSession` (discussion) | `supervisor.service.ts:626` | fork + no-tools |
| 4 | `reviewSession` | `supervisor.service.ts:685` | read-only, no fork |
| 5 | `doResume` | `supervisor.service.ts:1550` | resume path |
| 6 | management chat | `management-chat.service.ts:210` | read-only, long-lived |
| 7 | release-notes | `release-notes.service.ts:99` | read-only, one-shot |

`kind` comes from `Session.runtime` (sites 1-5) or the driving user's cached
preference (sites 6-7). omp-only launch inputs (`configPath`/`extensionPath`
skill+trigger overlays) are passed only to `OmpRuntime`; `ClaudeCodeRuntime`
ignores them (see §7).

**Files:** new `apps/api/src/runtime/agent-runtime.ts` (interface + factory +
type re-exports), `apps/api/src/runtime/omp-runtime.ts` (wrap of
`rpc-session.ts`), `apps/api/src/runtime/claude-code-runtime.ts`,
`apps/api/src/runtime/claude-event-map.ts` (SDK↔RpcEvent), and
`apps/api/src/runtime/effort-map.ts` (§6.4).

## 4. Data model and the per-user preference flow

### 4.1 Cloud (source of truth)

Additive migration `supabase/migrations/<ts>_profile_agent_runtime.sql`:

```sql
alter table public.profiles add column agent_runtime text;  -- 'omp' | 'claude-code' | null
```

No new RLS policy is needed: the existing `profiles_select using (true)` allows
reads and `profiles_update_own (id = auth.uid())` allows a user to set their own
value (`supabase/migrations/20260821090200_team_cloud_rls.sql`). The column is
purely additive, so it is safe to push at any time (README migration rule).
`null` means "not chosen yet" and triggers the onboarding gate.

### 4.2 Local cache (offline launch, D1)

The registry already holds a single-row cached Supabase session (`CHECK id = 1`,
`apps/api/src/registry/registry.service.ts`). Mirror `agent_runtime` there
(same row or a sibling single-row settings table). Refreshed from cloud at
sign-in and whenever the user changes the setting. Launch reads the cache;
offline fallback order is: cached value → `'omp'`.

### 4.3 Session stamping

New additive column `runtime` on the local `sessions` table (registry), written
at creation (`createChat`, `createSessionFromTask`) from the runner's cached
preference (fallback `'omp'`). **Resume reads `Session.runtime` from the
registry** to pick the adapter, so resume is offline-safe and a preference
change only affects **new** sessions — existing sessions keep their stamped
runtime (otherwise resume would target the wrong backend).

### 4.4 Domain types (`packages/core`)

- New `packages/core/src/runtime.ts`: `export type AgentRuntimeKind = 'omp' |
  'claude-code'` and a `isAgentRuntime(v): v is AgentRuntimeKind` guard (mirrors
  `isThinkingLevel` in `thinking.ts`).
- `Session` (`types.ts`) gains `runtime: AgentRuntimeKind`.
- `ompSessionId` / `ompSessionFile` are **reused** to hold the runtime session
  identity: for claude, `ompSessionId` carries the claude session UUID and
  `ompSessionFile` stays null; the adapter knows which to use on resume. A clean
  column rename to `runtimeSessionId`/`runtimeSessionRef` is optional future
  tidy-up, not required here.

### 4.5 Write path and surfaces

- **Onboarding gate:** after sign-in the UI reads the profile's `agent_runtime`;
  if `null`, a modal forces the choice `omp | claude-code`. Existing users see it
  once (their habitual choice is omp).
- **Account settings:** a pane in `apps/ui/src/pages/SettingsPage.vue` lets the
  user change the runtime later.
- **Write:** the UI writes `profiles.agent_runtime` directly under the user's JWT
  (consistent with other cloud writes), then pings the API (`POST
  /account/runtime`) to refresh the local cache. The API reads the cache when
  stamping new sessions.
- **Harness label:** `apps/ui/src/components/kit/KPanel.vue` currently prints a
  hardcoded `omp`; it becomes `session.runtime`.

## 5. claude-code adapter — event translation

The adapter's core job. SDK messages (from `query()` with
`includePartialMessages: true`) map to `RpcEvent`:

| SDK message | → `RpcEvent` |
|---|---|
| `system` / `init` | synthesize `ready`; seed `getState` (model, tools, sessionId, models catalog) |
| new turn begins | synthesize `agent_start` + `turn_start` + `message_start` |
| `stream_event` text delta | `message_update { assistantMessageEvent: { delta } }` |
| `assistant` `tool_use` block | `tool_execution_start { toolName, toolCallId, args }` |
| `user` `tool_result` block | `tool_execution_end { toolName, toolCallId, isError, result: { content } }` |
| `result` (turn end) | `message_end { message: { usage, model, duration } }` + `agent_end { isTerminal }` |
| api errors / retries | `notice { level }` |

Everything downstream (`reduceRpcEvents` → transcript → UI) is unchanged.

### 5.1 Command translation

| Interface call | SDK |
|---|---|
| `prompt` / `followUp` | push a `SDKUserMessage` into the `AsyncIterable` input |
| `steer` | `query.interrupt()` then enqueue the new message |
| `setModel(_, id)` | `query.setModel(id)` (provider ignored — always Anthropic) |
| `setThinkingLevel` | effort mapping (§6.4); start via `effort` option |
| `resume(ref)` | `query({ resume: sessionId })` |
| fork (chat→agent, discussion) | `forkSession(sessionId)` → new UUID |
| `stop` | end the input iterable / terminate the subprocess |

## 6. Feature mapping details

### 6.1 Tool autonomy

Kermanych agents run tools autonomously inside their isolated worktree (omp only
raises `extension_ui` when the model explicitly asks). The claude adapter sets
`permissionMode` to auto-accept edits within the worktree so behavior matches;
wiring `canUseTool` → the existing `extension_ui`/`answerUi` path is a later
refinement, not required for parity.

### 6.2 Tool restriction

`CHAT_TOOLS` / `MANAGEMENT_TOOLS` (`read`, `grep`, `glob`) and the discussion
`no-tools` mode map to the SDK `allowedTools`/`disallowedTools`/`tools`
options.

### 6.3 Model catalog

`apps/api/src/models/models.service.ts` becomes runtime-aware. For claude the
catalog comes from `query.supportedModels()` (requires a live query; run a short
headless query and cache under the same TTL as the omp catalog). Map
`ModelInfo → ModelOption { id: value/resolvedModel, name: displayName, provider:
'anthropic', efforts: supportedEffortLevels }`. `GET /models` returns the caller
runtime's catalog. Requires claude to be authenticated on the machine (same
class of assumption as "omp on PATH").

### 6.4 Effort mapping

claude effort levels are `low | medium | high | xhigh | max`; omp
`ThinkingLevel` is `off | minimal | low | medium | high | xhigh | max`
(`packages/core/src/thinking.ts`). Forward map for launch/`setThinkingLevel`:

| omp level | claude |
|---|---|
| off | thinking disabled |
| minimal | low |
| low | low |
| medium | medium |
| high | high |
| xhigh | xhigh |
| max | max |

Reverse (for `getState.thinkingLevel` read-back): `disabled → off`, otherwise
1:1; a session launched at `minimal` reads back as `low` (documented, harmless).
Mid-session effort change is coarser than omp's `set_thinking_level` (claude has
no dedicated live setter): use `setMaxThinkingTokens` or a respawn. Accepted.

### 6.5 Session identity, resume, fork

Persist the claude session UUID in `Session.ompSessionId` (§4.4). Resume =
`query({ resume: uuid })`. Fork = `forkSession(uuid)` producing a new UUID
(semantically a new independent session rather than omp's shared-file branch;
functionally sufficient for chat→agent promotion and discussion branches).

## 7. Soft-parity handling (honest degradation)

- **TTSR triggers → omp-only.** claude has only `hooks` (tool-event callbacks),
  no content-regex interrupts. The factory passes the `-e` trigger package only
  to `OmpRuntime`; `ClaudeCodeRuntime` ignores it. The triggers editor stays
  (project config); rules simply do not fire for claude sessions. Future: a
  subset via claude `PostToolUse` hooks.
- **Skills → prompt-inline for claude.** Kermanych already inlines assigned
  skills into the instruction (`assignedBlock`, `skills.service.ts` +
  `packages/core/src/skills.ts`). claude uses that path (backend-neutral) plus
  optional SDK `skills`. The omp-specific `--config` YAML overlay, three-level
  precedence, and `REPO_SKILL_DIRS` stay omp-only. Kermanych's default skills
  (session isolation, PR conventions) still reach the claude agent via the
  prompt, so behavior is correct.
- **Spend →** per-session token cost **works** for claude (from
  `result.modelUsage` → `message_end.usage` → `Session.usage`; the composer chip
  and lifetime accounting are populated). The subscription-plan window chip
  (`omp usage` → `SubscriptionUsage`) is omp-only: `usage.service` returns empty
  `providers` for claude, and the UI already hides the chip when empty. Future:
  the experimental `usage_EXPERIMENTAL_...` API.
- **Management chat + release-notes → routed through the factory** (decision b).
  Both are read-only prompt sessions the adapter already supports (prompt +
  restricted tools + stop), so they run on the user's chosen runtime and a
  claude-only machine keeps both features.

## 8. Sequencing (slice first)

- **Increment 1 — vertical slice (de-risk).** `AgentRuntime` + factory +
  `OmpRuntime` (wrap) + `ClaudeCodeRuntime`. Runtime chosen by a temporary
  dev switch (env/flag), no per-user plumbing yet. Prove one **agent** session
  end-to-end on claude: create → prompt → stream → tool rows → follow-up →
  steer → stop → resume → fork, transcript shape identical to omp. Validate the
  three risky mappings (live effort, `todoPhases`/context%, resume-rehydrate).
- **Increment 2 — per-user plumbing.** `profiles.agent_runtime` migration +
  local cache + `Session.runtime` stamping + onboarding gate + account-settings
  pane + dynamic harness label + runtime-aware model picker.
- **Increment 3 — breadth.** discussion/review/chat parity + management-chat and
  release-notes through the factory + prompt-inline skills + per-session usage
  for claude + plan-chip hiding.
- **Increment 4 — hardening.** resume-rehydrate edge cases, README dual-runtime
  docs, test fill-in.

The granular task breakdown belongs to the implementation plan (writing-plans);
this spec fixes the full target.

## 9. Testing and verification

Per repo conventions (vitest for `apps/api`, `packages/core`, `packages/cloud`;
`apps/ui` has no component-test harness — verified by running the app +
`vue-tsc`).

- **`packages/core`:** unit tests for `isAgentRuntime` and the effort-ladder
  mapping (pure functions).
- **`apps/api`:** unit tests for `ClaudeCodeRuntime` via an **injected fake SDK**
  that yields scripted SDK messages; assert the emitted `RpcEvent` sequence
  (mirrors `rpc-session.spec.ts`'s fake-omp approach). Plus factory routing,
  runtime-aware `models.service`, `Session.runtime` stamping, and the preference
  cache.
- **`packages/cloud`:** an RLS assertion that a user can update only their own
  `profiles.agent_runtime` (existing integration suite; auto-skips without env).
- **Smoke (the real proof):** drive a live claude-code agent session in the
  worktree via `pnpm dev:app` — run the full loop and the three risk areas,
  compare the board/composer against omp. Requires `claude` authenticated on the
  machine.

The three risk areas each get an explicit smoke check in Increment 1: live
effort change, `todoPhases`/context% derivation, and resume-rehydrate source
(read claude's session JSONL and map it; fall back to persisting Kermanych's own
transcript if fragile).

## 10. Dependencies and risks

- **New dependency:** `@anthropic-ai/claude-agent-sdk` in `apps/api`
  (`onlyBuiltDependencies` may need review; the SDK brings the `claude` CLI it
  spawns). Verify Node 24 compatibility during Increment 1.
- **Auth assumption:** a user who picks claude-code must have `claude`
  authenticated on their machine (mirrors the "omp on PATH, authenticated"
  assumption). Onboarding records the choice; availability/validation UX is a
  later refinement.
- **Experimental spend API:** intentionally not depended on (§7).
- **Fork semantics differ** (new UUID vs shared file): accepted (§6.5).

## 11. File-touch map (grounding for the plan)

New:
- `apps/api/src/runtime/agent-runtime.ts`, `omp-runtime.ts`,
  `claude-code-runtime.ts`, `claude-event-map.ts`, `effort-map.ts`
- `packages/core/src/runtime.ts`
- `supabase/migrations/<ts>_profile_agent_runtime.sql`
- UI: onboarding modal component; account-settings pane additions

Modified:
- `apps/api/src/supervisor/supervisor.service.ts` (5 sites → factory; read
  runtime; stamp `Session.runtime`)
- `apps/api/src/management/management-chat.service.ts`,
  `management/release-notes.service.ts` (site → factory)
- `apps/api/src/models/models.service.ts` (+ `omp-models.ts` sibling for claude
  mapping), `apps/api/src/usage/usage.service.ts` (claude → empty providers)
- `apps/api/src/registry/registry.service.ts` (`sessions.runtime` column;
  cached preference)
- `apps/api/src/skills/skills.service.ts` (trigger/overlay routing omp-only)
- `apps/api/src/http/*` (account-runtime endpoint; `GET /models` per runtime)
- `packages/core/src/types.ts` (`AgentRuntimeKind`, `Session.runtime`)
- `apps/ui`: `pages/SettingsPage.vue`, `components/kit/KPanel.vue` (harness
  label), model-picker + store/api wiring
- `apps/api/package.json` (add SDK dependency)
