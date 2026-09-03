# claude-code runtime — Increment 4 (hardening) Implementation Plan

- **Status:** Plan (implementation pending)
- **Branch:** `feature/agent-runtime-hardening` (worktree /Users/oleksiimotornyi/Documents/Projects/kmq-hardening), off `origin/dev` `89bfa66` (incl. Inc 1-3).
- **Spec:** `docs/superpowers/specs/2026-09-02-claude-code-runtime-design.md` (§8 Increment 4, §9 testing).
- **Depends on:** Inc 1-3 (runtime + factory + per-user preference + breadth). All DONE and in dev.

## Goal

Close the last claude gaps: a resumed or branched claude session re-renders its prior transcript (today `ClaudeCodeRuntime.getAllMessages()` is an Inc-1 stub returning `[]`); document the dual-runtime setup in the README; fill the claude test gaps.

## Rehydrate decision (spec §9 "read claude's session JSONL … fall back to persisting our own")

**Chosen: the SDK's `getSessionMessages(sessionId, { dir })`** (top-level export, `@anthropic-ai/claude-agent-sdk` sdk.d.ts:797). Reasons: it is the SDK's supported/stable API for exactly this; offline; avoids the undocumented/fragile on-disk JSONL format (`~/.claude/projects/<enc-cwd>/<uuid>.jsonl`) and avoids a parallel persistence layer. Resume does NOT replay history through the query iterator (documented SDK limitation), so an explicit `getSessionMessages()` call is required. Reading JSONL directly (Option C) and persisting our own transcript (Option B) are rejected unless smoke proves `getSessionMessages()` fragile.

## Key facts (recon)

- `SessionMessage` (sdk.d.ts:5443) = `{ type: 'user'|'assistant'|'system'; message: unknown; parent_tool_use_id: string|null; parent_agent_id: string|null; uuid; session_id }`. `message` is an Anthropic Messages API message (user `MessageParam` / assistant `BetaMessage`) whose `content` is text/thinking/tool_use/tool_result/image blocks. Cast by `type`.
- Rehydrate pipeline (unchanged, omp is the gold standard): `getAllMessages()` → `OmpMessage[]` → `messagesToTranscript()` (`messages-to-transcript.ts`) → `TranscriptEntry[]` → `Live.transcript`. `OmpMessage`/`OmpPart` shapes are the stable seam (`messages-to-transcript.ts:1-43`).
- 3 rehydrate call sites, all `rehydrate(live, id, await rpc.getAllMessages())`: fork launch (`supervisor.service.ts:614`), branchSession (`:688`, carries the Inc-1 stub comment `:686-687`), resume (`:1659-1661`, gated `if (s.ompSessionFile)`).
- `rehydrate()` (`:811-816`) → `messagesToTranscript(messages, {skillSource})` → `l.transcript` + toolDetails cache + `transcript_reset` broadcast.
- claude stores the session UUID in `Session.ompSessionId` (Inc 2/3, spec §6.5). `ClaudeCodeRuntime.switchSession()` is a no-op; resume is expressed at `start()` via `opts.fork`/`resume`. `this.sessionId` is captured from the system/init message.
- Transcript is in-memory only (`Live.transcript`); no server-side DB persistence — correct, unchanged (rehydrate rebuilds on resume).

## Rulings

- **R1 — `getSessionMessages`, not JSONL, not a new persistence layer.** Injectable (like `queryFn`) so tests use a fake.
- **R2 — separate converter, stable omp seam.** New `claude-history.ts: claudeHistoryToOmp(SessionMessage[]) → OmpMessage[]`; `messages-to-transcript.ts` is NOT changed (its `OmpMessage` contract stays the omp/claude common shape). Mirrors the block handling `claude-event-map.ts` already does for the live stream.
- **R3 — resume must rehydrate for claude.** The resume gate keys on `ompSessionFile` (omp). Extend so a claude session (UUID in `ompSessionId`, no file) also resumes (`opts.resume = ompSessionId` at start) AND rehydrates via `getAllMessages()`. Read `doResume` exactly; keep the omp path unchanged.
- **R4 — fork/branch need no supervisor change beyond removing the stale stub comment.** Once `getAllMessages()` works, the fork-launch and branchSession sites rehydrate automatically (the forked session's UUID → `getSessionMessages` returns the copied history).

## File-touch map

- `apps/api/src/runtime/claude-history.ts` (NEW) — `claudeHistoryToOmp`.
- `apps/api/src/runtime/claude-code-runtime.ts` — implement `getAllMessages()` via injectable `getSessionMessages`.
- `apps/api/src/supervisor/supervisor.service.ts` — resume gate for claude (R3); remove stale Inc-1 stub comment at branchSession.
- `README.md` — dual-runtime docs.
- Tests: `apps/api/test/claude-history.spec.ts` (NEW), `apps/api/test/claude-code-runtime.spec.ts` (getAllMessages), `apps/api/test/supervisor.resume.spec.ts` (claude resume/branch), `apps/api/test/transcript-parity.spec.ts` (claude parity).

---

## Task 1: SessionMessage → OmpMessage converter + `getAllMessages()`

**Files:** NEW `apps/api/src/runtime/claude-history.ts`; `apps/api/src/runtime/claude-code-runtime.ts`. Tests: NEW `apps/api/test/claude-history.spec.ts`; extend `claude-code-runtime.spec.ts`.

- [ ] **Step 1: Read** `messages-to-transcript.ts:1-43` (exact `OmpMessage`/`OmpPart` shape) and `claude-event-map.ts` (how it maps assistant text/thinking/tool_use and tool_result blocks live — reuse the same block logic).
- [ ] **Step 2: Failing test** (`claude-history.spec.ts`): feed scripted `SessionMessage[]` (a user text; an assistant message with thinking + text + a `tool_use` block; a following user message carrying a `tool_result` block, both success and `is_error`) and assert `claudeHistoryToOmp` returns `OmpMessage[]` with: user → `{role:'user', content:[{type:'text',text}]}`; assistant → `{role:'assistant', content:[thinking,text,{type:'tool_use'/tool part with id,name,arguments}], usage?}`; tool_result → `{role:'toolResult', toolCallId, isError, details/content}`. Round-trip through `messagesToTranscript` and assert entries are non-empty and paired.
- [ ] **Step 3: Implement `claude-history.ts`.** `export function claudeHistoryToOmp(msgs: SessionMessage[]): OmpMessage[]`. Cast `m.message` per `m.type`; walk `content` blocks → `OmpPart[]`; split assistant `tool_use` and user `tool_result` blocks into the `OmpMessage` roles `messages-to-transcript` expects (`assistant` with tool_use parts; a separate `toolResult` message per tool_result carrying `toolCallId`=block.tool_use_id, `isError`=block.is_error, `details`/text). Map `usage` from the assistant `BetaMessage.usage` when present. Skip `type:'system'` (do not request them: default `includeSystemMessages:false`).
- [ ] **Step 4: Implement `getAllMessages()`.** Add an injectable `getSessionMessages` (constructor param defaulting to the SDK export, mirroring `queryFn`). Body: `if (!this.sessionId) return []; const msgs = await this.getSessionMessagesFn(this.sessionId, { dir: this.opts.cwd }); return claudeHistoryToOmp(msgs);`. Test in `claude-code-runtime.spec.ts` with a fake returning scripted `SessionMessage[]` → asserts `OmpMessage[]` out and that no fetch happens when `sessionId` is unset.
- [ ] **Step 5: Run + typecheck.** `pnpm --filter @kermanych/api test -- claude-history claude-code-runtime` PASS; `pnpm --filter @kermanych/api typecheck` EXIT 0.
- [ ] **Step 6: Commit.** `feat(runtime): claude getAllMessages via getSessionMessages (rehydrate)`.

---

## Task 2: resume / fork / branch rehydrate wiring

**Files:** `apps/api/src/supervisor/supervisor.service.ts`. Tests: `apps/api/test/supervisor.resume.spec.ts`.

- [ ] **Step 1: Read** `doResume` (~1640-1665) and `resumeSession`/`liveOrResume` (~1017-1032), the fork-launch (~610-616) and branchSession (~680-690) rehydrate sites, and how `opts.fork`/`resume` reach `createRuntime` on resume.
- [ ] **Step 2: Failing test** (`supervisor.resume.spec.ts`, claude variant): with a fake claude runtime whose `getAllMessages()` returns scripted `OmpMessage[]` and a session row stamped `runtime:'claude-code'` with `ompSessionId` set (no `ompSessionFile`), assert that resuming it (a) constructs the runtime with the resume handle = `ompSessionId`, and (b) calls `getAllMessages()` and populates `live.transcript` (non-empty). Add a branch-of-claude-parent assertion: the child's transcript is rehydrated from the parent.
- [ ] **Step 3: Implement (R3).** In `doResume`, make the rehydrate/resume path fire for claude: resume handle = `s.ompSessionFile ?? s.ompSessionId` — but keep the backend-correct wiring (omp switches the session file; claude resumes via `opts.resume = s.ompSessionId` at `start()` and does NOT call `switchSession`). Concretely: gate rehydrate on "has a resume handle for this runtime" rather than `ompSessionFile` alone, and ensure the claude runtime is created with its resume handle. Leave the omp path byte-identical.
- [ ] **Step 4: Remove the stale stub comment** at branchSession (`:686-687`) now that claude rehydrates. Confirm fork-launch + branch need no other change.
- [ ] **Step 5: Run + typecheck.** `pnpm --filter @kermanych/api test -- supervisor.resume` PASS; typecheck EXIT 0.
- [ ] **Step 6: Commit.** `feat(api): rehydrate claude sessions on resume, fork, and branch`.

---

## Task 3: transcript parity for claude

**Files:** `apps/api/test/transcript-parity.spec.ts` (extend). No source change expected.

- [ ] **Step 1: Read** the existing parity spec (how it drives the live path via `reduceRpcEvents` and the rehydrate path via `messagesToTranscript`, then compares visible fields).
- [ ] **Step 2: Add a claude case.** For one logical conversation (user prompt → assistant thinking+text+tool_use → tool_result → assistant text), build (a) the live `RpcEvent` stream via `mapSdkMessage` over scripted `SDKMessage`s and (b) the rehydrated path via `claudeHistoryToOmp` over the equivalent `SessionMessage[]`, and assert the two `TranscriptEntry[]` agree on the visible fields (roles, text, tool name/args, tool result status, thinking) — the same invariant the omp parity test guards.
- [ ] **Step 3: Run.** `pnpm --filter @kermanych/api test -- transcript-parity` PASS.
- [ ] **Step 4: Commit.** `test(runtime): claude live/rehydrate transcript parity`.

---

## Task 4: README dual-runtime docs

**Files:** `README.md`. No code.

- [ ] **Step 1: Read** README §intro (3-25), prerequisites (23-25), and the management-chat note (~605-608) — all say "omp" only.
- [ ] **Step 2: Update.**
  - Intro + architecture: Kermanych drives a pluggable **`AgentRuntime`** — either `omp` or **claude-code** — behind one factory; one session = one worktree + one runtime child.
  - Prerequisites: alongside "`omp` on your PATH, authenticated", add the claude path — the `claude` CLI installed + authenticated (`@anthropic-ai/claude-agent-sdk`), used when the user's runtime preference is claude-code.
  - Per-user preference: onboarding gate on first sign-in; change later in profile settings; `KERMANYCH_RUNTIME` dev override; each session keeps the runtime it was created with (resume never switches backend).
  - Honest differences (spec §7): TTSR triggers + skill-overlay config + subscription-plan spend + the plan/todo chip are omp-only; skills reach claude inline via the prompt; per-session spend works on both.
- [ ] **Step 3: Commit.** `docs(readme): document the dual omp / claude-code runtime`.

---

## Task 5: verification (suite + smoke)

**Files:** none. Prereqs for smoke: `claude` CLI authenticated; Inc 2 migration pushed (already, in dev).

- [ ] **Step 1: Full suite + typecheck.** `pnpm --filter @kermanych/core build && pnpm --filter @kermanych/cloud build && pnpm --filter @kermanych/api build && pnpm --filter @kermanych/api typecheck && pnpm --filter @kermanych/ui typecheck && pnpm -r test` — all green (re-run the known-flaky finish/origin-sync git-timeout tests in isolation if they trip).
- [ ] **Step 2: Rehydrate smoke** (`pnpm dev:app`, claude preference): (a) run a claude agent task with a few turns incl. a tool call; stop the API (or let the child idle-reap) and reopen the session → the prior transcript re-renders (not empty); (b) branch/discussion off a claude session → the parent transcript shows in the child; (c) resume after a full app restart → transcript intact. (d) side-by-side an omp session → both rehydrate correctly, each on its own backend.
- [ ] **Step 3: Record findings** in `…-increment-4-findings.md` and commit.

---

## Self-review (author checklist)

- **Spec coverage (§8 Inc 4):** resume-rehydrate (T1-T3) ✓; README dual-runtime docs (T4) ✓; test fill-in — claude getAllMessages, converter, resume/branch, parity (T1-T3) ✓.
- **Decision recorded (§9):** `getSessionMessages()` chosen over JSONL/self-persist, with smoke as the fragility check and Option B named as the fallback if it proves unreliable.
- **Stable seam:** `OmpMessage`/`messagesToTranscript` untouched; claude feeds the same converter via `claude-history.ts`, so the omp path and the parity invariant are unaffected.
- **Backend-correct resume:** omp resumes via session file + `switchSession`; claude via `opts.resume = ompSessionId` at start + `getSessionMessages` — the resume gate is generalized without changing omp behavior.
- **Degradation honesty:** `parent_agent_id` may be null on older claude (subagent linkage) — the converter tolerates null; nested-subagent transcript fidelity is best-effort and not required for parity.
- **Ordering:** T1 (converter + getAllMessages) → T2 (resume wiring) and T3 (parity) depend on T1; T4 (README) independent; T5 last.
- **Out of scope:** cross-machine transcript portability (would need Option B / a shared SessionStore); fork-point truncation (`resumeSessionAt`); nested-subagent transcript panes.
