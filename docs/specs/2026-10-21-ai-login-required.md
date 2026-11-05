# Showing «AI login required» when the provider CLI is signed out

## Goal

The operator launches a session while the machine's AI provider CLI (`claude` or `omp`) is
signed out. Kermanych shows the session as «Launching…» and never says that the provider
account is not logged in. The operator must see, without guessing, that a login is required,
both on the session that hit it and across the app.

## Context

Facts measured on this machine (claude 2.1.234, SDK 0.3.259, omp 18.2.11). A signed-out state
was simulated with an empty `CLAUDE_CONFIG_DIR` and an empty `omp --profile`.

- **Managed claude.** A signed-out SDK child does NOT die at spawn. It answers the first input
  turn with a synthetic assistant message
  `{ error: "authentication_failed", message.content: [{ text: "Not logged in · Please run /login" }] }`
  and a `result` with `is_error: true`. The stream throws (`Claude Code returned an error result:
  Not logged in · Please run /login`) only once the input stream closes, which a Kermanych
  session never does. `claude-event-map.ts` ignores the assistant `error` and text blocks, so
  the turn ended empty and nothing was classified. `authFailureCode` only ran in the stream's
  `catch` (`claude-code-runtime.ts`).
- **Managed omp.** A signed-out `omp --mode rpc` exits 1 before `ready`, with stderr
  `No models available. Use /login or set an API key environment variable…`. `RpcSession`
  rejected `start()` with that text but no `.code`, and `OMP_AUTH` did not match it. So the
  launch failed with a raw sentence instead of `runtime_omp_not_authenticated`.
- **Preflight** (`RuntimeCheckService`). The claude probe asked `supportedModels()`, which a
  signed-out child answers in full, so the check said `ok` while signed out. The SDK's
  `accountInfo()` does tell: signed in → no `tokenSource`; signed out → `tokenSource: "none"`,
  no `apiKeySource`; API key in env → `apiKeySource` set. omp's empty catalog returned an
  uncoded `omp listed no models`.
- **Session status.** `wireLive`'s `onExit` set `status: error` and the raw `error` text, but
  skipped sessions that were `done` (every chat, every follow-up). No code reached the UI,
  so the panel could only print «error» and the raw reason.
- **Global state.** The preflight ran only when the backend was picked (onboarding, Settings).
  Nothing told the operator later that the account had been signed out.

## Decisions

- **Claude: the structured `authentication_failed` is the signal, not prose.** The runtime
  ends the child when an assistant message carries `error: "authentication_failed"`, through
  the same death path a crashed child takes (notice + exit), with the code
  `claude_not_authenticated`. Killing the child is deliberate: the next send respawns it with
  `resume`, so the turn is retried with fresh credentials once the operator logs in. The
  signed-out child writes its session file (checked), so the resume finds it.
  Rejected: leaving the child alive and only adding a notice. It is unknown whether a running
  child picks up a later login, and the session would sit «done» with an empty turn.
- **The exit callback carries the cause.** `AgentRuntime.onExit(cb)` gets an optional third
  argument, the auth-failure code, so the supervisor does not re-parse prose it already
  classified.
- **An auth-coded exit is an error even from `done`/`in_review`.** A sign-out is never a
  clean end. Other exits keep the old rule (the reaper stops settled children on purpose).
- **`Session.errorCode`.** This is a live-only field next to `error`, like `error` itself.
  The UI keys «Login required» on it. Rejected: a new `SessionStatus` value. That status would
  touch every status switch in the app and the cloud status sync for one cause of `error`.
- **omp: classify what omp actually prints.** `OMP_AUTH` gains `no models available`, which
  is omp's own wording for having no provider credentials. `RpcSession.start()` attaches the
  code to its pre-ready rejection the way `ClaudeCodeRuntime` does. An empty omp catalog in the
  preflight is `omp_not_authenticated`. omp lists models only for providers it holds
  credentials for.
- **Preflight for claude asks `accountInfo()`.** The check treats as signed out only
  `apiProvider` first-party (or absent), `tokenSource: "none"` and no `apiKeySource`.
  Bedrock/Vertex/gateway setups authenticate outside Claude and are never flagged.
- **Global indicator in the top bar.** A warning pill «AI login required» sits beside the
  settings gear. Its tooltip names the command (`claude /login` / `omp login`). It re-runs the
  preflight for the operator's runtime on mount, every 5 minutes while visible, when the
  window regains focus (at most every 30 s), and whenever a session reports a sign-out.
  Clicking it checks again. Only a coded `*_not_authenticated` verdict shows it. A timeout or
  an unknown failure does not, because a wrong «log in» is worse than silence.
- **Out of scope.**
  - Native sessions (the harness TUI in a pty) show their own login screen in their terminal.
    They get no per-session label, only the global pill.
  - codex has no preflight (none existed; not installed here to verify).

## Changes

- `packages/core/src/types.ts`: `Session.errorCode?: NoticeCode`. `i18n-codes.ts`: the
  comments name the real sources of the sign-out codes.
- `apps/api/src/runtime/auth-failure.ts`:
  - `AuthFailure` (an Error carrying an `AuthFailureCode`) for causes that are known from a
    structured signal.
  - `OMP_AUTH` matches `no models available`.
- `apps/api/src/runtime/agent-runtime.ts`: the `onExit` callback gains
  `cause?: AuthFailureCode`.
- `apps/api/src/runtime/claude-code-runtime.ts`:
  - An in-turn `authentication_failed` closes the input and the child and dies with
    `claude_not_authenticated`.
  - New `probe()`: `accountInfo()` plus `supportedModels()` on one throwaway child.
    `supportedModels()` shares the same helper.
- `apps/api/src/rpc/rpc-session.ts`: a pre-ready failure rejects with an `AuthFailure` when
  the cause is classified. The exit passes the cause.
- `apps/api/src/runtime/runtime-check.service.ts`: the claude probe throws `AuthFailure` for a
  signed-out account. An empty omp catalog returns `omp_not_authenticated`.
- `apps/api/src/supervisor/supervisor.service.ts` `wireLive`: sets `errorCode`. An auth-coded
  exit marks `error` even from `done`/`in_review`.
- UI:
  - `lib/session-auth.ts` (`needsSignIn`).
  - `KPanel.vue`: status label and the «LOGIN REQUIRED» banner.
  - `AgentsPage.vue`, `ChatPage.vue`: status word.
  - `composables/useProviderSignIn.ts` and the pill in `MainLayout.vue`.
  - i18n `en`/`uk`: `common.nav.aiLoginRequired`/`aiLoginRecheck`,
    `kit.panel.signInHead`, `kit.panel.status.signIn`, `agents.statusWord.signIn`.

## Verification

- **Real SDK, signed out** (`CLAUDE_CONFIG_DIR` empty, a throwaway tsx script driving
  `ClaudeCodeRuntime`). `start()` resolves. After `prompt()`: `ready`, then within ~0.5 s a
  notice `{ level: "warn", code: "claude_not_authenticated" }` and exit
  `(null, "Claude Code is not signed in: Not logged in · Please run /login",
  "claude_not_authenticated")`, `isAlive() === false`. No hang in the iterator's `return()`.
- **Real preflight.** Signed out: `{ ok: false, code: "claude_not_authenticated" }` in
  194 ms. Signed in: `{ ok: true }` in 815 ms. omp (real, signed in): `{ ok: true }`.
  A stand-in `omp` that prints omp's signed-out stderr and exits 1:
  `{ ok: false, code: "omp_not_authenticated" }`.
- **UI** (preview api on 4517 with claude signed out and `KERMANYCH_RUNTIME=claude-code`;
  quasar dev on 5517; headless Chromium):
  - The pill shows «Потрібен вхід в AI» / «AI login required», with the `omp login` tooltip.
  - A chat's first message → header `claude-code · login required`, a «LOGIN REQUIRED»
    banner, and the notice row with `claude /login`. The pill's tooltip switches to Claude.
  - With the stand-in omp removed, a click on the pill re-ran the check (200, `ok: true`)
    and the pill disappeared.
- **Tests.**
  - `apps/api` vitest: 109 files, 955 passed. This includes the new
    `supervisor.sign-in.spec.ts`, the in-turn sign-out and `probe` cases in
    `claude-code-runtime.spec.ts`, and the omp cases in `rpc-session.spec.ts`,
    `auth-failure.spec.ts` and `runtime-check.spec.ts`.
  - `apps/ui`: 58 files, 628 passed.
  - `packages/core`: 21 files, 211 passed.
- **Types.** `tsc --noEmit` on api is clean. ui `vue-tsc` shows only errors that were
  already there and are outside the touched files: `@kermanych/api` has no build output for
  `src-electron`, and `test/runtime-messages.spec.ts` has a cast.
- **Not exercised.** A login followed by a resend that respawns the claude child. The child
  could not be signed in inside the same api process, and the resume path itself is
  unchanged.

## Documentation impact

README «Prerequisites» and «Runtime preference» (new «Signed out» subsection): the preflight
now checks the account itself, plus the top-bar pill and a session's «login required» state.
