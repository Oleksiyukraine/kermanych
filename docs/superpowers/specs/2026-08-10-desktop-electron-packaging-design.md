# Kermanych — Desktop App (Electron) Packaging (Design)

- **Status:** Draft for review
- **Date:** 2026-08-10
- **Scope:** `apps/ui` (new `src-electron/`, `quasar.config.ts`, `lib/api.ts`,
  `lib/socket.ts`, `stores/orchestrator.ts`, `package.json`), `apps/api`
  (`main.ts` → importable `bootstrap`, `package.json` exports), `packages/core`
  (`status.ts` → `shouldNotify`), root `package.json` (scripts), `README.md`.

## 1. Purpose

Ship the existing web-app as a **macOS desktop application** via Quasar's
Electron mode, so it launches from a single icon — no browser, no manual start
of two dev servers. Add **native OS notifications** when a session's status
changes to one that needs the operator's attention.

Two explicit asks:

1. **"Package as-is"** — one window that boots the backend itself and shows the
   UI. Minimal refactor; the REST/WS contract is preserved verbatim.
2. **Native notifications** on transitions into `waiting_input` / `error` /
   `conflict` / `done`, and **only while the window is unfocused**.

Distribution target: an **unsigned `.dmg`** for sharing. Signing/notarization
are deferred (a developer account exists but is out of scope for this task).

## 2. Current state (as-is)

- **Two processes, started by hand.** `apps/api` (NestJS, HTTP+WS) and
  `apps/ui` (Quasar SPA in a browser), via `pnpm dev:api` (:4317) + `pnpm
  dev:ui` (:5317).
- `apps/api/src/main.ts` builds the app inside a `bootstrap()` that **self-runs**
  on import and `listen(4317)`. It sets 64 MB body limits, `enableCors({ origin:
  '*' })`, global prefix `api`, and `enableShutdownHooks()`.
- Renderer reaches the api over HTTP (`lib/api.ts`, base
  `http://localhost:4317/api`) and Socket.IO (`lib/socket.ts`). CORS is already
  open, so a localhost origin is fine.
- `quasar.config.ts` has **no** electron mode; `vueRouterMode: 'hash'` (correct
  for `file://`). No `src-electron/`, no electron deps.
- `RegistryService` uses `better-sqlite3` — a **native addon**, ABI-bound
  (README already documents rebuilding it when the Node ABI changes).
- `SupervisorService` spawns `omp --mode rpc` children; `PreviewService` spawns
  dev servers. **Both implement `onModuleDestroy`** cleanup, and `app.close()`
  triggers it. A `freePort()` helper already exists in `preview.service.ts`.
- `packages/core/status.ts` owns the status model (`reduceStatus`,
  `ACTIVE_STATUSES`); `SessionStatus` includes `waiting_input`/`error`/
  `conflict`/`done`. The `orchestrator` store applies `session_update` events
  from WS to its `sessions` list.
- `apps/ui` does **not** depend on `apps/api` (separate workspace packages).

## 3. Design

### 3.1 Backend as an importable, parameterized bootstrap

- `apps/api/src/main.ts`: change `bootstrap` to
  `export async function bootstrap(opts?: { port?: number }): Promise<{ app:
  INestApplication; url: string }>`. Same setup as today; `await
  app.listen(opts?.port ?? Number(process.env.PORT) || 0)` (port `0` =
  OS-assigned when none given); resolve the actual URL via
  `await app.getUrl()`; return `{ app, url }`.
- Keep standalone use working with a guard:
  `if (require.main === module) void bootstrap();`. So `pnpm dev:api` and `node
  dist/main.js` behave exactly as before.
- `apps/api/package.json`: add `"main": "dist/main.js"` and
  `"exports": { ".": "./dist/main.js" }` so `@kermanych/api` is importable.

### 3.2 Electron main (`apps/ui/src-electron/electron-main.ts`)

- On `app.whenReady()`:
  1. Choose a port: try `4317`, else a free one (a small local `freePort()` in
     `src-electron`; we do **not** import api internals for this).
  2. `const { app: nest, url } = await bootstrap({ port })` and keep `nest` +
     `url` in module scope.
  3. `createWindow(url)`.
- `createWindow`: `BrowserWindow` with `webPreferences.preload` and
  `additionalArguments: ['--api-base=' + url + '/api']` (main already knows the
  port, so it hands the base to preload with no IPC round-trip). Load the
  renderer from Quasar's `process.env.APP_URL` (dev = Quasar dev server; prod =
  bundled `index.html`).
- **Lifecycle:** `window-all-closed` → `app.quit()` (single-window utility; the
  usual macOS "stay resident" behavior is intentionally dropped). `before-quit`
  → `await nest.close()` (runs `onModuleDestroy`, killing `omp` and preview
  children) before the process exits.
- **Failure:** if `bootstrap` rejects → `dialog.showErrorBox(...)` then quit — a
  named error, never a blank window.

### 3.3 Port hand-off (`electron-preload.ts` + renderer)

- `electron-preload.ts`: read the base from `process.argv` (the
  `--api-base=...` passed in 3.2) and
  `contextBridge.exposeInMainWorld('kermanych', { apiBase })`.
- `lib/api.ts` and `lib/socket.ts`: resolve the base as
  `window.kermanych?.apiBase ?? (import.meta.env.VITE_API_BASE ??
  'http://localhost:4317/api')`. Two-line change each; the web/dev path is
  untouched, so `pnpm dev:ui` in a browser still works.

### 3.4 Native notifications (`packages/core` + renderer)

- `packages/core/status.ts`: add
  `export const NOTIFY_STATUSES: readonly SessionStatus[] = ['waiting_input',
  'error', 'conflict', 'done'];` and a pure
  `export function shouldNotify(prev: SessionStatus | undefined, next:
  SessionStatus): boolean` → `prev !== next && NOTIFY_STATUSES.includes(next)`
  (fire only on a *transition into* a notify-status, never on repeats).
- `stores/orchestrator.ts`: in the `session_update` handler, read the current
  stored status as `prev` **before** replacing the session; if `shouldNotify(prev,
  next)` **and** `!document.hasFocus()` → `new Notification(session.name, { body:
  statusLabel(next) })`. Electron maps the renderer's Web Notification API to a
  native macOS notification automatically — **no IPC**.
- Notification `onclick` → focus the window and select that session (window
  focus via a one-line preload bridge, e.g. `kermanych.focus()` calling
  `ipcRenderer.send`; main handles it with `win.show()/focus()`).

### 3.5 Quasar & build config

- `quasar.config.ts`: add
  ```
  electron: {
    bundler: 'builder',
    builder: {
      appId: 'com.kermanych.app',
      productName: 'Kermanych',
      mac: { target: 'dmg', identity: null }   // identity:null = unsigned
    }
  }
  ```
- `apps/ui/package.json`: add `electron`, `@electron/rebuild`, and
  `@kermanych/api: "workspace:*"` (so electron-builder bundles the api `dist` +
  its `node_modules` into the app).
- **Native module:** `better-sqlite3` must match the **Electron** ABI.
  electron-builder rebuilds native deps at package time; for `dev`, a one-time
  `electron-rebuild` (or `@electron/rebuild`) after install. This is the same
  ABI concern the README already calls out for Node upgrades.
- Root `package.json`: add `dev:app` = `pnpm --filter @kermanych/ui dev -m
  electron` and `build:app` = `pnpm --filter @kermanych/ui build -m electron`.
  Keep `dev:api`/`dev:ui` for the plain web/debug path.
- `README.md`: add a "Desktop app" section (`pnpm dev:app`, `pnpm build:app`)
  and a short note on opening an unsigned build (right-click → Open, or
  `xattr -cr`).

## 4. Isolation / boundaries

- **`packages/core`** — one pure, DOM-free addition: `NOTIFY_STATUSES` +
  `shouldNotify`. Testable in isolation.
- **`apps/api`** — `bootstrap` becomes importable + port-parameterized; **zero
  behavior change** when run standalone (guarded self-invoke).
- **`src-electron/*`** — the only Electron-aware code. Owns the window and the
  backend's lifecycle; depends on `@kermanych/api` `bootstrap` and the preload
  bridge. New, self-contained.
- **renderer** (`lib/api`, `lib/socket`, `orchestrator`) — minimal: read
  `apiBase` from preload; fire notifications from the existing `session_update`
  stream. Controllers, gateway, and the HTTP/WS contract are untouched.

## 5. Verification

**Unit (vitest, `packages/core`):** `shouldNotify`
- fires on `tool → waiting_input`, `thinking → error`, `tool → done`,
  `thinking → conflict`;
- does **not** fire on `thinking → tool`, `queued → thinking`, or a same-status
  repeat (`done → done`).

**Smoke (manual):**
- `pnpm dev:app` → a single window opens (no browser); creating a group +
  session works end to end (api is reachable in-process).
- Drive a session to `done` with the window **blurred** → a native macOS
  notification appears; clicking it focuses the app and selects that session.
  Repeat blurred for `waiting_input`. With the window **focused**, no
  notification fires.
- `pnpm build:app` → a `.dmg` is produced; open the built `.app` (right-click →
  Open, since unsigned) and repeat the create + notify flow.

**Native-module check:** the first `electron` launch loads `better-sqlite3`
without an ABI error (the rebuild step is verified).

## 6. Non-goals

- Code signing, notarization, auto-updates (deferred).
- Windows / Linux targets.
- System tray, global hotkeys, launch-at-login.
- Converting the transport to Electron IPC — the backend stays in-process but
  keeps its localhost HTTP/WS server (that is what makes this "as-is").
- Any change to RPC commands, session lifecycle, persistence, notification
  content beyond the four statuses, or token-by-token streaming.
