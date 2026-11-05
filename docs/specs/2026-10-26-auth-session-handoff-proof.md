# Proof of the app's UI on the session handoff

## Goal

Card: «Any web page can switch the local API to an attacker's account via public
POST /api/auth/session (CORS *)». Any page in the operator's browser could push a valid
Supabase JWT of the attacker's own account (sign-in is open to every GitHub account) to
`http://127.0.0.1:4317/api/auth/session`, and from then on the guard and the `/terminal`
socket accepted the attacker's bearer: project paths, `.env` files, sessions, a shell.

## Context

- `apps/api/src/auth/auth.controller.ts`: `@Public() @Post("session")` called
  `AuthService.setToken` for any token that verified against the project's JWKS; `setToken`
  replaced the cached user unconditionally.
- `apps/api/src/main.ts`: `enableCors({ origin: "*" })`, JSON body parser, 127.0.0.1.
- The UI (`apps/ui/src/stores/auth.ts` → `api.authSession`) hands the token over on every
  auth event; the request carries the current bearer once one was handed over (`send()` in
  `lib/api.ts`), none on the first sign-in.
- Desktop: Electron main hosts the api in-process (`bootstrap()`), the renderer is loaded
  from `file://` (packaged, `Origin: null`) or `http://localhost:5317` (dev).
  Web dev: `pnpm dev:api` + `pnpm dev:ui` on `http://localhost:5317`.

## Decisions

- **The gate is on the handoff, not on CORS.** POST /api/auth/session is accepted only with
  one of three proofs (`apps/api/src/auth/ui-proof.ts`):
  1. the current bearer (`AuthService.userForToken`) — every token refresh;
  2. the desktop app's per-launch key in `x-kermanych-ui-key`;
  3. an `Origin` from the trusted list — the dev UI of a standalone api.

  Anything else gets `403` before the token is even verified. 403, not 401: the UI reads a
  401 as «session ended» and would sign the operator out.
- **CORS stays `*`.** Restricting it cannot tell the packaged app (`Origin: null` from
  `file://`) from a sandboxed iframe on any site (also `null`), so it would not close the
  hole; every other route already needs the cached bearer, which a foreign page cannot get.
  `null` is never a trusted origin, even when listed in `KERMANYCH_UI_ORIGINS`.
- **Per-launch key**: Electron main generates 32 random bytes per launch, passes them to
  `bootstrap({ uiKey })` and to its own window only (`--ui-key` in `additionalArguments`,
  exposed by the preload as `window.kermanych.uiKey`). The session-browser views have no
  preload, so pages there never see it. Compared with `timingSafeEqual`.
- **Trusted origins**: a standalone api (no key) trusts `http://localhost:5317` and
  `http://127.0.0.1:5317` (the dev UI, `quasar.config.ts`). The desktop app (a key) trusts no
  origin, so a local page that happens to sit on :5317 cannot sign it in.
  `KERMANYCH_UI_ORIGINS` (comma-separated, empty = none) overrides the list either way.
- **A different user with the current bearer is allowed.** The card names the current bearer
  as proof; the UI signs out (guarded DELETE) before another account signs in, so this path
  is not used today, but the bearer holder is the UI.
- The UI sends the key only on POST /auth/session (`send()` got an `extraHeaders` argument),
  not on every request.

## Changes

- `apps/api/src/auth/ui-proof.ts` (new): `UI_KEY_HEADER`, `DEV_UI_ORIGINS`, `setUiProof`,
  `uiProofFor(key, envOrigins)`, `provesAppUi(headers, proof?)`.
- `apps/api/src/auth/auth.controller.ts`: the handoff requires the current bearer or
  `provesAppUi`, else `403`.
- `apps/api/src/auth/auth.guard.ts`: `bearerToken(headers)` extracted, shared with the
  controller.
- `apps/api/src/main.ts`: `bootstrap({ uiKey })`, configures the proof
  (`KERMANYCH_UI_ORIGINS`).
- `apps/ui/src-electron/electron-main.ts`, `electron-preload.ts`,
  `src/types/kermanych-bridge.d.ts`: the per-launch key.
- `apps/ui/src/lib/api.ts`: `authSession` sends `x-kermanych-ui-key` when the bridge has it.
- `apps/api/test/auth.session-handoff.spec.ts` (new): HTTP-level refusal of a foreign origin,
  a wrong key, a `null` origin, an unknown bearer; refresh with the bearer; a switch with
  the key; dev-origin trust only for a standalone api.

## Verification

- `vitest run test/auth.session-handoff.spec.ts` (`apps/api`): 8 pass; with the controller
  change reverted, 6 of them fail (every handoff was `201`).
- `vitest run` (`apps/api`): 118 files, 1138 tests pass. `tsc --noEmit` (`apps/api`): clean.
- `vitest run` (`apps/ui`): 64 files, 720 tests pass. `vue-tsc --noEmit` (`apps/ui`): only
  the pre-existing `test/runtime-messages.spec.ts` TS2352.
- Standalone api (`node dist/main.js`, throwaway `HOME`/`KERMANYCH_DB`, port 4399), curl:
  `Origin: https://evil.example` → `403`; `Origin: http://localhost:5317` → passes the gate
  (`400 Missing exp claim` for the fake token); the CORS preflight allows
  `x-kermanych-ui-key`.
- Electron dev app (`quasar dev -m electron`, throwaway `KERMANYCH_DB`), driven over CDP from
  the renderer at `http://localhost:5317`: `window.kermanych.uiKey` is 64 hex chars; a POST
  with it passes the gate (`400` for the fake token), without it or with a wrong key → `403`
  (the dev origin is not trusted by the desktop app); `api.authSession()` from
  `src/lib/api.ts` passes the gate. A real GitHub sign-in was not run (no unattended OAuth).

## Documentation impact

- `kermanych/README.md` → «Setup & run»: who may hand over a session, and
  `KERMANYCH_UI_ORIGINS`.
