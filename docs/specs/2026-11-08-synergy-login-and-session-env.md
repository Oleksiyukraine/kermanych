# «Синергія»: the preview sees `.env`, and «Увійти як» signs in with a tester account

- **Branch:** `feature/improve-synergy-login-flow`
- **Scope:** `apps/api` (preview step environment), `apps/ui` (session browser: «Увійти як»,
  Electron main sign-in), i18n `uk` / `en`, `kermanych/README.md`.

## Goal

The operator's report on «Синергія» (project «FE», `fs-admin`, preview at `localhost:52571`):

1. `BASE_URL` was set to the right back end in the project's `.env`, yet sign-in went to
   `http://localhost:3000/api/auth/admin/sign-in` (`ERR_CONNECTION_REFUSED`); signing in was
   impossible.
2. Signing in by hand every time is the friction: the operator keeps the app's logins in their
   own browser's password store, and the session browser has none. Offer the accounts to sign in
   with; take them from the «Тестувальник» agent.

## Context

- **Why the request went to `localhost:3000`.** `fs-admin` is Quasar with `@quasar/app-vite` 1.10
  (`package.json`). Its `quasar.config.js` bakes `build.env.BASE_URL: process.env.BASE_URL`, and
  `src/boot/axios.ts` falls back to `'http://localhost:3000/api/'` when it is empty. app-vite 1
  never loads `.env` into `process.env` (no dotenv in `@quasar/app-vite/lib`); only Vite's
  `VITE_*` keys reach `import.meta.env`. Kermanych spawned preview steps with
  `{ ...process.env, PREVIEW_DIR, PORT_*, PORT, service env }` (`preview.service.ts` `spawnStep`),
  so the worktree's `.env` (copied as a carry file, editable in «Змінні») never reached the dev
  server. The session-env spec assumed «dev servers read `.env` at start»
  (`docs/specs/2026-11-04-session-env-and-tester-preview-gate.md`, decision 2), which holds for
  Next.js and Vite keys, not for this project.
- **Accounts.** «Тестувальник» keeps per-project accounts on this machine (SQLite
  `tester_accounts`: name, login, password, note; `tester_settings.login_path`), served to the
  local UI with passwords by `GET /api/tester/projects/:projectId` (`tester.controller.ts`). The
  project «FE» has two (`owner`, `admin`) and the login path `/login`.
- **The session browser** is an Electron `WebContentsView` per session
  (`src-electron/session-browser/browsers.ts`); the renderer reaches it only through the preload
  bridge. The agent's `browser_type` types with CDP `Input.insertText` after a focus script
  (`actions.ts` `type`, `scripts.ts` `focusFieldScript`); no operator action typed into the page.

## Decisions

1. **Every preview step gets the session directory's `.env` as environment variables.** Read
   on every start (so ↻ applies a «Змінні» save), below Kermanych's own names (`PORT`,
   `PORT_*`, `PREVIEW_DIR`, device names) and a service's `env`, above the api's inherited
   environment. Applied to `setup`, the services and a device's `install`. Not part of the names
   a service's `env` may expand (`parsePreviewConfig` still refuses others).
   A key is left out when Next.js / Vite / Quasar would resolve it differently from the file:
   - another env file they read with a higher priority sets it (`.env.local`,
     `.env.development`, `.env.development.local`, `.env.dev`, `.env.dev.local`): a variable
     already in the environment beats every file for them, so passing `.env`'s value would
     silence the override;
   - its value contains `$`: they expand references, a passed literal they would not;
   - `NODE_ENV`: each command sets it for itself (dev vs build).
   - Rejected: telling the operator to change `quasar.config.js` (every Kermanych project with a
     `process.env`-only dev server would hit the same wall, and «Змінні» promises that the
     preview uses the values); passing `.env` and `.env.local` merged (still overrides
     `.env.development` for Next.js and Vite).
2. **«Увійти як»: the project's «Тестувальник» accounts as one-click sign-ins in the session
   browser.**
   - A bar between the toolbar and the page (in the flow, like the page-dialog bar: a menu over
     the page parks the native view, and the operator wants to see the form being filled) with
     one button per account (tooltip: login · note). The toolbar's **Увійти як** toggles it on
     any page; it opens by itself when the page arrives at the tester's login path (same origin
     and route; a hash router's `#/login` counts), except in a tester run's own browser, where
     the agent signs in. ✕ hides it until the next arrival. No accounts → a link to the
     «Тестувальник» page. The list is read again on every opening.
   - A click: Electron main finds the sign-in form (the first shown, enabled password field;
     the login field is the last shown text field before it in its form, else
     `autocomplete="username"`), types the login and the password with CDP `Input.insertText`
     (real input events, so masks and `v-model` run; a prefilled `+380` is replaced) and presses
     Enter. A page with no password field first loads the login path on the page's origin and
     waits up to 10 s for the form (an SPA renders it after the load). No login path and no
     form → «На сторінці немає форми входу…». It is the operator's action: no agent
     bookkeeping (pause, `agentBusy`), and the page gets the keyboard.
   - Rejected: a password-manager-style popup on focus (needs a page-side overlay or focus
     tracking in every page; the bar is one click too); a separate account store for the
     operator (the tester's accounts are exactly the app's test logins, already on this
     machine).

## Changes

### API (`apps/api`)
- New `src/preview/preview-dotenv.ts`: `previewDotenv(dir)` — `.env` parsed with `parseEnv`,
  minus the keys of decision 1.
- `src/preview/preview.service.ts` `execute`: the step environments start from it.
- `test/preview.spec.ts`: a step sees `.env` keys under Kermanych's names and the service `env`;
  overlay-shadowed, `$`-referring and `NODE_ENV` keys stay out; `setup` gets it too.

### UI (`apps/ui`)
- `src-electron/session-browser/scripts.ts`: `loginFieldScript(focus)`.
- `src-electron/session-browser/actions.ts`: `signIn(v, login, password)`.
- `src-electron/session-browser/browsers.ts`: `signIn` (login-path fallback, form wait) and IPC
  `kermanych:browser:sign-in`; `electron-preload.ts` and `types/kermanych-bridge.d.ts`:
  `signIn(sessionId, account, loginUrl) → 'ok' | 'no-form' | 'no-page'`.
- New `lib/sign-in.ts`: `loginUrlFor`, `isLoginPage`; `test/sign-in.spec.ts`.
- New `components/kit/KSignInBar.vue`; `KBrowserPane.vue`: the toolbar toggle and the bar.
  Loading uses `useLoadPhase` + `KSkeleton`, each account button `useKeyedAction`.
- i18n `uk` / `en`: `agents.browser.signIn.*`.

### Docs
- `kermanych/README.md`: «Session browser» (toolbar, «Sign in as a test account»), «Live
  preview» (`.env` in every step; «Змінні»), «Тестувальник» settings.

## Verification

- `apps/api`: `npx vitest run test/preview.spec.ts` — 25 passed (the new `.env` test included).
- `apps/ui`: `npx vitest run test/sign-in.spec.ts` — 4 passed; `vue-tsc --noEmit` clean (after
  building `@kermanych/api` for its types).
- **Sign-in in Electron** (throwaway script, `actions.signIn` on a real `BrowserWindow` with the
  debugger attached): a page without a password field → `false`; a page that renders its form
  300 ms after load → `false` before, `true` after; the form 1500 px below the fold, a hidden
  unrelated input and a prefilled `+380` → the submit handler got the typed phone and password,
  `isTrusted: true`.
- **End to end on a copy of `fs-admin`** (`node_modules` linked, `.env` with
  `BASE_URL=http://127.0.0.1:59999/api/`, a fake back end on 59999): `npx quasar dev` spawned
  with `previewDotenv` → Electron opened `/`, the app redirected to `/login`, `signIn` filled
  the masked phone field and the password → the fake back end received
  `POST /api/auth/admin/sign-in` with `{"phone":"+380770000001","password":"pw-smoke",…}`.
  The same run without `previewDotenv` (the old environment): the back end received nothing
  (the app called its `localhost:3000` fallback).
- **Not verified:** the bar and the toolbar button in the desktop app itself (no desktop runtime
  in this session: the web build has no session browser, and starting a second desktop app
  would share the operator's `~/.kermanych` database); `browsers.ts` `signIn`'s login-path
  navigation and 10 s wait (the e2e smoke drove `actions.signIn` with its own retry loop, not the
  IPC handler).

## Documentation impact

`kermanych/README.md`: «Session browser», «Live preview», «Тестувальник» settings, as listed
under «Changes → Docs».
