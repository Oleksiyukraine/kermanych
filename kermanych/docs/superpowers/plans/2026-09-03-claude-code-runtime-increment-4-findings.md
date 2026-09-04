# claude-code runtime — Increment 4 (hardening) Findings

- **Date:** 2026-09-04
- **Branch:** `feature/agent-runtime-hardening` (off `origin/dev` `89bfa66`, incl. Inc 1-3).
- **Result:** hardening complete — resumed/branched claude sessions re-render their prior transcript; README documents the dual runtime; claude test gaps filled. **This closes the claude-code runtime feature (Increments 1-4).**
- **Tests:** 1105 passed (core 125, cloud 110, api 574, ui 296), 61 skipped; typecheck EXIT 0.

## Rehydrate decision (executed)

**SDK `getSessionMessages(sessionId, { dir })`** (sdk.d.ts:797) — chosen over reading the on-disk JSONL (undocumented/fragile) or persisting our own transcript (extra layer). A separate converter `claude-history.ts` maps `SessionMessage[]` → the stable `OmpMessage[]` seam, so `messages-to-transcript.ts` and the omp path are untouched.

## Delivered (5 commits)

| Task | Commit | Summary |
|------|--------|---------|
| T1 converter + getAllMessages | `3c9c655` | NEW `claude-history.ts` (`claudeHistoryToOmp`); `ClaudeCodeRuntime.getAllMessages()` via injectable `getSessionMessages`; `RuntimeLaunchOpts.resume` added. |
| T2 resume/fork/branch | `27ce304` | `doResume` resume gate generalized: handle = `ompSessionFile ?? ompSessionId`; claude resumes via `opts.resume = ompSessionId` (omp path byte-identical); removed the stale Inc-1 stub comment at branchSession. |
| T3 parity | `0fc7130` | Claude live/rehydrate transcript parity test; added `thinking_delta` mapping in `claude-event-map.ts` (mirrors `text_delta`) so live claude reasoning surfaces and matches rehydrate. |
| T4 README | `9d846cf` | Dual-runtime docs: `AgentRuntime` factory, per-user preference flow, `KERMANYCH_RUNTIME` override, honest omp-only differences (TTSR, skill overlay, subscription spend, plan chip). |
| T4-fix README | `<this branch>` | Corrected an agent error: management-chat runs on the user's chosen runtime (Inc 3), not "always omp". |

## Converter contract (T1)

`claudeHistoryToOmp`: casts `SessionMessage.message` by `type`; assistant → one `OmpMessage` with thinking/text/`toolCall` parts (+ usage from `BetaMessage.usage`, snake→camel, no cost in history); each user `tool_result` block → a separate `role:'toolResult'` `OmpMessage` paired on the `tool_use` id; tracks tool-use id→name for `toolName`; skips `type:'system'`; tolerates null `parent_agent_id`. Emits part type `toolCall` (the seam key `messages-to-transcript` expects).

## Verification

- **Step 1 (suite + typecheck):** ✅ 1105 passed; typecheck clean. New coverage: `claude-history.spec.ts`, `claude-code-runtime.spec.ts` (getAllMessages), `supervisor.resume.spec.ts` (claude resume/branch), `transcript-parity.spec.ts` (claude live/rehydrate).
- **Steps 2-3 (rehydrate smoke):** 🔲 operator — `pnpm dev:app`, claude preference, `claude` CLI authenticated: (a) run a claude task with a tool call, let the child idle-reap / reopen → transcript re-renders (not empty); (b) branch a claude session → parent transcript shows in the child; (c) resume after full app restart → transcript intact; (d) side-by-side omp session rehydrates on its own backend.

## Issues (all resolved)

1. **Edit-tool disk desync (recurring).** The Edit tool again reported successful snapshots without writing to disk (both agents + the controller hit it on README). All parties worked around via disk-level writes and verified with `git diff` before committing. Reported to `xd://report_issue`.
2. **Sibling-checkout leakage (recurring).** A stray README copy landed in `/Multiagent-app`; the controller reverted it — sibling confirmed clean.
3. **README factual error caught by controller verification.** The README agent wrote "management-chat always runs on omp" — false since Inc 3 routed it through the factory (`management-chat.service.ts:264` `createRuntime(this.runtimeFor())`). Corrected. This is exactly the class of claim the controller now verifies against source before PR.

## Feature status: claude-code runtime COMPLETE (Inc 1-4)

- **Inc 1** — runtime slice: `AgentRuntime` + factory + `OmpRuntime` + `ClaudeCodeRuntime`, one agent session e2e, dev switch.
- **Inc 2** — per-user preference: `profiles.agent_runtime` + cache + `Session.runtime` stamping + onboarding gate + settings pane + harness label.
- **Inc 3** — breadth: chat/discussion/review + management-chat/release-notes through the factory; runtime-aware model picker; skills + per-session usage for claude; plan-chip hiding.
- **Inc 4** — hardening: resume/fork/branch rehydrate via `getSessionMessages`; README dual-runtime docs; test fill-in.

No further increments planned. Remaining out-of-scope items (documented, not blocking): cross-machine transcript portability (would need a shared SessionStore), fork-point truncation, nested-subagent transcript panes.
