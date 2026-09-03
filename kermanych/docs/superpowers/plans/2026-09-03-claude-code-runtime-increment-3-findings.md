# claude-code runtime — Increment 3 (breadth) Findings

- **Date:** 2026-09-03
- **Branch:** `feature/agent-runtime-parity` (off `origin/dev` `e814825`, incl. Inc 1 + Inc 2).
- **Result:** breadth complete — chat/discussion/review + management-chat/release-notes run on the user's chosen runtime; model picker runtime-aware; skills + per-session usage locked for claude; plan-chip hidden for claude.
- **Tests:** 1098 passed (core 125, cloud 110, api 567, ui 296), 61 skipped; typecheck EXIT 0 (core+cloud+api build, api+ui typecheck).

## Delivered (7 commits)

| Task | Commit | Summary |
|------|--------|---------|
| T1 adapter noTools | `bf20964` | `noTools` → `allowedTools: []` (fixed the no-op `tools: []`). |
| T5 model catalog | `f90dd65` | Runtime-aware `models.service.list(runtime)`; claude via `ClaudeCodeRuntime.supportedModels()` (throwaway query, control channel) → `claude-models.ts` maps `ModelInfo[]`→`ModelOption[]`; per-runtime TTL cache; `GET /models` reads the caller runtime. |
| T2 chat+review | `60841f6` | `createChat` + `reviewSession` stamp `runtimeFor()` and spawn via `createRuntime(session.runtime ?? "omp", …)`. |
| T3 branch (fork) | `2705966` | `branchSession` stamps `parent.runtime` (fork can't cross backends); fork handle = claude→`ompSessionId` / omp→`ompSessionFile`, refuse if missing; `noTools: true`; kept `getAllMessages()` rehydrate (claude returns [] → Inc 4). |
| T4 management | `4183b7e` | `management-chat` + `release-notes` gain `runtimeFor()` (via registry) and spawn via `createRuntime`. |
| T6 usage+skills | `ab8156b` | Tests lock claude per-session usage (`modelUsage`→`message_end.usage`) + prompt-inline skills (`assignedBlock`). No gap — `sumUsage` already complete. |
| T7 plan-chip | `540a3e9` | `KPanel.vue` hides the todo lane for claude (`v-if="session.todoPhases?.length && session.runtime !== 'claude-code'"`). |

## Rulings applied

- R1 fork inherits parent runtime; R2 fork handle per backend; R3 management reads pref via registry; R4 noTools bug fixed; R5 claude branch rehydrate deferred to Inc 4; R6 subscription usage omp-only.

## Verification

- **Step 1 (suite + typecheck):** ✅ 1098 passed, typecheck clean.
- **Steps 2-3 (live smoke):** 🔲 operator — `pnpm dev:app` with claude preference: quick chat, discussion/branch, review, management-chat, release-notes all run on claude; no plan-chip; model picker lists claude models; per-session spend accrues. Cross-runtime: omp + claude sessions coexist, each resumes on its own backend. Prereq: Inc 2 migration pushed; `claude` CLI authenticated.

## Issues (all resolved)

1. **Edit-tool desync (2 agents).** SupervisorRouting + UsageSkillsUi reported the Edit tool returning a successful snapshot without writing to disk; both worked around via direct writes/scripted replacements and verified against `git diff` before committing. Reported to `xd://report_issue`. Final committed content verified correct.
2. **Sibling-checkout leakage.** Stray copies of the supervisor + KPanel edits (and a junk `package-lock.json`) landed in the main checkout `/Multiagent-app` (edit-tool cwd resolution). The real work committed correctly to the parity worktree; the controller reverted the sibling to clean afterward. The hard guard also caught + reverted one in-flight MgmtRouting leak.
3. **Process lesson (from Inc 2).** The hard guard (assert worktree toplevel + branch before/after every commit; controller verifies every expected commit is on-branch before PR) worked: all 7 commits confirmed on `feature/agent-runtime-parity`, sibling restored clean.

## Deferred to Increment 4 (hardening)

- resume-rehydrate edge cases incl. claude branch parent transcript (`getAllMessages()` → []); README dual-runtime docs; remaining test fill-in.
