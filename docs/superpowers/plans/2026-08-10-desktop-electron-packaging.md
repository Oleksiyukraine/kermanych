# Desktop App (Electron) Packaging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the existing Kermanych web-app as a macOS desktop application (Electron via Quasar) that boots the NestJS backend in-process and shows the UI in one window, with native notifications on attention-worthy session status changes.

**Architecture:** Approach 2 (in-process). Electron's main process imports the api's `bootstrap({port})`, runs NestJS (HTTP+WS) on `127.0.0.1`, then opens a `BrowserWindow` whose renderer (the unchanged Quasar SPA) talks to that localhost server exactly as it does today. Notifications are fired from the renderer off the existing `session_update` WS stream.

**Tech Stack:** pnpm workspace, NestJS 10, Quasar 2 (`@quasar/app-vite` v2) Electron mode, electron-builder, `better-sqlite3` (native), Vitest.

## Global Constraints

- **Node 22.x**; `better-sqlite3` is a native addon (ABI-bound) — it MUST be rebuilt for the **Electron** ABI (`@electron/rebuild`; electron-builder rebuilds at package time).
- **macOS only**; produce an **unsigned** `.dmg` (`mac: { target: 'dmg', identity: null }`). No signing/notarization, no Windows/Linux.
- pnpm workspace; internal packages referenced as `workspace:*`.
- Notifications fire **only** on transitions into `waiting_input` / `error` / `conflict` / `done`, and **only while the window is unfocused**.
- Preserve the REST/WS contract verbatim; keep `vueRouterMode: 'hash'`. No RPC/persistence changes.
- Conventional commit messages; one commit per task.
- Do NOT run project-wide lint/build/test inside tasks beyond the commands each step names.

---

### Task 1: Core `shouldNotify` predicate

Pure, DOM-free notification rule in `packages/core`, consumed by the renderer in Task 5. TDD first — this is the one new piece of business logic.

**Files:**
- Modify: `packages/core/src/status.ts`
- Test: `packages/core/test/status.spec.ts`

**Interfaces:**
- Consumes: `SessionStatus` (already exported from `packages/core/src/types.ts`).
- Produces:
  - `NOTIFY_STATUSES: readonly SessionStatus[]`
  - `shouldNotify(prev: SessionStatus | undefined, next: SessionStatus): boolean`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/status.spec.ts`:

```ts
import { shouldNotify, NOTIFY_STATUSES } from "../src/status";

test("NOTIFY_STATUSES is the attention set", () => {
  expect([...NOTIFY_STATUSES]).toEqual(["waiting_input", "error", "conflict", "done"]);
});

test("shouldNotify fires on a transition INTO a notify status", () => {
  expect(shouldNotify("tool", "waiting_input")).toBe(true);
  expect(shouldNotify("thinking", "error")).toBe(true);
  expect(shouldNotify("tool", "done")).toBe(true);
  expect(shouldNotify("thinking", "conflict")).toBe(true);
});

test("shouldNotify ignores non-notify targets and same-status repeats", () => {
  expect(shouldNotify("thinking", "tool")).toBe(false);
  expect(shouldNotify("queued", "thinking")).toBe(false);
  expect(shouldNotify("done", "done")).toBe(false);
  expect(shouldNotify("waiting_input", "waiting_input")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kermanych/core test`
Expected: FAIL — `shouldNotify`/`NOTIFY_STATUSES` are not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `packages/core/src/status.ts` (after the existing `ACTIVE_STATUSES`):

```ts
// Statuses worth a native notification: the agent needs the operator, or it finished.
export const NOTIFY_STATUSES: readonly SessionStatus[] = ["waiting_input", "error", "conflict", "done"];

// True only on a transition INTO a notify status (never on same-status repeats),
// so callers fire one notification per meaningful change.
export function shouldNotify(prev: SessionStatus | undefined, next: SessionStatus): boolean {
  return prev !== next && NOTIFY_STATUSES.includes(next);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @kermanych/core test`
Expected: PASS (all status specs green).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/status.ts packages/core/test/status.spec.ts
git commit -m "feat(core): add shouldNotify predicate for status notifications"
```

---

### Task 2: Backend as an importable, port-parameterized bootstrap

Turn `apps/api` into a package Electron can import and start, without breaking standalone `pnpm dev:api`.

**Files:**
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/package.json`

**Interfaces:**
- Produces: `bootstrap(opts?: { port?: number }): Promise<{ app: INestApplication; url: string }>` from `@kermanych/api` (built entry `dist/main.js`). `url` is always `http://127.0.0.1:<port>`.

**Note on verification (no vitest here):** `NestFactory.create(AppModule)` needs `emitDecoratorMetadata` for constructor DI. The api's vitest runs under esbuild, which does NOT emit that metadata, so booting the full app in vitest leaves injected deps `undefined` (e.g. `EventsGateway.supervisor`). `nest build` (tsc) DOES emit it, so the compiled binary is the correct place to prove the boot. This task is therefore verified by a compiled smoke; the existing vitest suite (which instantiates services directly) stays green.

- [ ] **Step 1: Rewrite `apps/api/src/main.ts`**

Replace the whole file:

```ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";

// Build + start the Kermanych API. Exported so the Electron main process can host
// it in-process; still self-runs for standalone `node dist/main.js` / `pnpm dev:api`.
export async function bootstrap(opts: { port?: number } = {}): Promise<{ app: INestApplication; url: string }> {
  // Images ride message/create payloads as base64 (omp caps each at 20 MiB),
  // so lift the body limit well past Express's 100 KB default.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.useBodyParser("json", { limit: "64mb" });
  app.useBodyParser("urlencoded", { extended: true, limit: "64mb" });
  app.enableCors({ origin: "*" });
  app.setGlobalPrefix("api", { exclude: [] });
  app.enableShutdownHooks();
  const port = opts.port ?? (Number(process.env.PORT) || 4317);
  await app.listen(port, "127.0.0.1");
  const url = `http://127.0.0.1:${port}`;
  console.log(`Kermanych API on ${url}`);
  return { app, url };
}

if (require.main === module) void bootstrap();
```

(`require.main === module` is valid — `apps/api/tsconfig.json` compiles `module: commonjs`.)

- [ ] **Step 2: Make the package importable**

Edit `apps/api/package.json` — add `"main"` and `"exports"` (keep everything else):

```json
  "private": true,
  "main": "dist/main.js",
  "exports": { ".": "./dist/main.js" },
```

- [ ] **Step 3: Build**

Run: `pnpm --filter @kermanych/api build`
Expected: `nest build` succeeds, emitting `apps/api/dist/main.js`.

- [ ] **Step 4: Compiled smoke — bootstrap listens and serves**

Run:
```bash
(KERMANYCH_DB=:memory: PORT=45997 node apps/api/dist/main.js >/tmp/boot.log 2>&1 & BOOTPID=$!; sleep 3; curl -sS -m 5 http://127.0.0.1:45997/api/groups; echo; kill $BOOTPID)
```
Expected: the boot log contains `Kermanych API on http://127.0.0.1:45997`, and curl prints `[]` (empty in-memory registry; global prefix `api`).

- [ ] **Step 5: Existing suite still green**

Run: `pnpm --filter @kermanych/api test`
Expected: 26/26 passing. The refactor is behavior-preserving for standalone use.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/main.ts apps/api/package.json
git commit -m "refactor(api): export port-parameterized bootstrap returning app+url"
```

---

### Task 3: Add Quasar Electron mode + build config

Scaffold Electron mode, wire dependencies and build config. No app logic yet — deliverable is "a window opens".

**Files:**
- Create (via CLI): `apps/ui/src-electron/electron-main.ts`, `apps/ui/src-electron/electron-preload.ts` (+ Quasar's electron scaffolding)
- Modify: `apps/ui/quasar.config.ts`
- Modify: `apps/ui/package.json`
- Modify: `package.json` (root)

**Interfaces:**
- Produces: an `electron` Quasar mode runnable via `pnpm dev:app`, and `@kermanych/api` available as a dependency of `apps/ui`.

- [ ] **Step 1: Scaffold Electron mode**

Run: `pnpm --filter @kermanych/ui exec quasar mode add electron`
Expected: creates `apps/ui/src-electron/` (`electron-main.ts`, `electron-preload.ts`) and adds `electron` + related devDeps to `apps/ui/package.json`.

- [ ] **Step 2: Add the api + rebuild dependencies**

Run:
```bash
pnpm --filter @kermanych/ui add @kermanych/api@workspace:*
pnpm --filter @kermanych/ui add -D @electron/rebuild
```

- [ ] **Step 3: Configure the electron builder target**

In `apps/ui/quasar.config.ts`, replace the returned config's trailing `animations: [],` line by keeping it and adding an `electron` block as a sibling key inside the returned object:

```ts
    animations: [],

    electron: {
      bundler: 'builder',
      builder: {
        appId: 'com.kermanych.app',
        productName: 'Kermanych',
        mac: { target: 'dmg', identity: null }, // identity:null → unsigned
      },
    },
```

- [ ] **Step 4: Add root run scripts**

In root `package.json`, add to `"scripts"`:

```json
    "dev:app": "pnpm --filter @kermanych/ui dev -m electron",
    "build:app": "pnpm --filter @kermanych/ui build -m electron"
```

- [ ] **Step 5: Smoke — a window opens**

Run: `pnpm dev:app`
Expected: an Electron window opens showing the Quasar UI (the board may fail to reach the backend — that is wired in Task 4). No crash on launch. Close the window.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src-electron apps/ui/quasar.config.ts apps/ui/package.json package.json pnpm-lock.yaml
git commit -m "build(ui): add Quasar electron mode + unsigned dmg target"
```

---

### Task 4: Host the backend in Electron main + hand off the port

Make the desktop app self-sufficient: main starts NestJS in-process, opens the window, and tells the renderer where the api is.

**Files:**
- Create: `apps/ui/src/types/kermanych-bridge.d.ts`
- Modify: `apps/ui/src-electron/electron-main.ts`
- Modify: `apps/ui/src-electron/electron-preload.ts`
- Modify: `apps/ui/src/lib/api.ts`
- Modify: `apps/ui/src/lib/socket.ts`

**Interfaces:**
- Consumes: `bootstrap({ port })` from `@kermanych/api` (Task 2).
- Produces: `window.kermanych.apiBase: string` in the renderer; a `kermanych.focus()` bridge (used in Task 5).

- [ ] **Step 1: Declare the renderer bridge type**

Create `apps/ui/src/types/kermanych-bridge.d.ts`:

```ts
// Exposed by src-electron/electron-preload.ts via contextBridge. Absent in the browser.
export {};
declare global {
  interface Window {
    kermanych?: { apiBase: string; focus: () => void };
  }
}
```

- [ ] **Step 2: Rewrite `apps/ui/src-electron/electron-main.ts`**

Replace the file body with (keep any Quasar-generated icon/path helpers if present; this is the full working version):

```ts
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap } from '@kermanych/api';
import type { INestApplication } from '@nestjs/common';

const currentDir = fileURLToPath(new URL('.', import.meta.url));

let mainWindow: BrowserWindow | undefined;
let nest: INestApplication | undefined;

// Prefer 4317; fall back to an OS-assigned free port if it is taken.
function freePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => {
      const any = createServer();
      any.listen(0, '127.0.0.1', () => {
        const p = (any.address() as { port: number }).port;
        any.close(() => resolve(p));
      });
    });
    srv.listen(preferred, '127.0.0.1', () => srv.close(() => resolve(preferred)));
  });
}

async function startBackend(): Promise<string> {
  const port = await freePort(4317);
  const res = await bootstrap({ port });
  nest = res.app;
  return `${res.url}/api`;
}

function createWindow(apiBase: string) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: false, // preload needs process.argv
      preload: path.resolve(
        currentDir,
        path.join(process.env.QUASAR_ELECTRON_PRELOAD_FOLDER!, 'electron-preload' + process.env.QUASAR_ELECTRON_PRELOAD_EXTENSION!),
      ),
      additionalArguments: [`--api-base=${apiBase}`],
    },
  });
  void mainWindow.loadURL(process.env.APP_URL!);
  mainWindow.on('closed', () => { mainWindow = undefined; });
}

ipcMain.on('kermanych:focus', () => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
});

app.whenReady().then(async () => {
  try {
    const apiBase = await startBackend();
    createWindow(apiBase);
  } catch (err) {
    dialog.showErrorBox('Kermanych failed to start', String((err as Error).stack ?? err));
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', async (e) => {
  if (nest) {
    e.preventDefault();
    const closing = nest;
    nest = undefined;
    await closing.close(); // runs onModuleDestroy: kills omp rpc + preview children
    app.quit();
  }
});
```

Note: `process.env.QUASAR_ELECTRON_PRELOAD_*` and `process.env.APP_URL` are provided by `@quasar/app-vite` in electron mode; keep the exact names from the generated template if they differ.

- [ ] **Step 3: Rewrite `apps/ui/src-electron/electron-preload.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron';

// main passes --api-base=<url> via webPreferences.additionalArguments.
const arg = process.argv.find((a) => a.startsWith('--api-base='));
const apiBase = arg ? arg.slice('--api-base='.length) : 'http://localhost:4317/api';

contextBridge.exposeInMainWorld('kermanych', {
  apiBase,
  focus: () => ipcRenderer.send('kermanych:focus'),
});
```

- [ ] **Step 4: Read the base in `lib/api.ts`**

In `apps/ui/src/lib/api.ts`, replace the `BASE` line (currently line 13):

```ts
const BASE =
  (typeof window !== 'undefined' && window.kermanych?.apiBase) ||
  import.meta.env.VITE_API_BASE ||
  'http://localhost:4317/api';
```

- [ ] **Step 5: Read the base in `lib/socket.ts`**

In `apps/ui/src/lib/socket.ts`, replace the `URL` line (currently line 7):

```ts
const URL =
  ((typeof window !== 'undefined' && window.kermanych?.apiBase) ||
    (import.meta.env.VITE_API_BASE ?? 'http://localhost:4317/api')).replace(/\/api\/?$/, '') ||
  'http://localhost:4317';
```

- [ ] **Step 6: Rebuild the native module for Electron, then smoke**

Run:
```bash
pnpm --filter @kermanych/ui exec electron-rebuild -f -w better-sqlite3
pnpm dev:app
```
Expected: window opens; create a group pointing at a real git repo and launch a session — a card appears and status advances. This proves the in-process backend + port hand-off. Close the window; confirm the process exits (no orphaned node).

- [ ] **Step 7: Commit**

```bash
git add apps/ui/src-electron apps/ui/src/lib/api.ts apps/ui/src/lib/socket.ts apps/ui/src/types/kermanych-bridge.d.ts
git commit -m "feat(app): host NestJS in electron main and hand off api port to renderer"
```

---

### Task 5: Native notifications on status change

Fire a native macOS notification when a session enters a notify-status while the window is unfocused.

**Files:**
- Modify: `apps/ui/src/stores/orchestrator.ts`

**Interfaces:**
- Consumes: `shouldNotify` (Task 1); `window.kermanych?.focus` (Task 4).

- [ ] **Step 1: Import the predicate**

In `apps/ui/src/stores/orchestrator.ts`, add `shouldNotify` to the existing `@kermanych/core` import block (top of file):

```ts
import { shouldNotify } from '@kermanych/core';
```

- [ ] **Step 2: Add a status label helper**

Add near the top of the store module (module scope, above `useOrchestrator`):

```ts
const STATUS_LABEL: Partial<Record<Session['status'], string>> = {
  waiting_input: 'потрібна відповідь',
  error: 'помилка',
  conflict: 'конфлікт злиття',
  done: 'завершено',
};
```

- [ ] **Step 3: Fire the notification inside `reduce()`**

In the `session_update` branch of `reduce()` (currently lines 43–47), replace it with:

```ts
    } else if (e.type === 'session_update') {
      const prev = sessions.value.find((x) => x.id === e.session.id)?.status;
      sessions.value = [
        ...sessions.value.filter((x) => x.id !== e.session.id),
        e.session,
      ];
      if (
        shouldNotify(prev, e.session.status) &&
        typeof document !== 'undefined' &&
        !document.hasFocus() &&
        typeof Notification !== 'undefined'
      ) {
        const n = new Notification(e.session.name, {
          body: STATUS_LABEL[e.session.status] ?? e.session.status,
        });
        n.onclick = () => {
          window.kermanych?.focus();
          selectSession(e.session.id);
        };
      }
```

(The closing `}` of the `else if` chain is unchanged.)

- [ ] **Step 4: Smoke — notification on blur**

Run: `pnpm dev:app`
Expected: launch a session, click away so the window loses focus, and let it reach `done` (or `waiting_input`) → a native macOS notification appears with the session name; clicking it focuses the app and selects that session. With the window focused, no notification appears.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/stores/orchestrator.ts
git commit -m "feat(app): native notifications on attention-worthy status changes"
```

---

### Task 6: Build the `.dmg` + document it

Produce the shareable artifact and document how to run desktop mode and open an unsigned build.

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Build the dmg**

Run: `pnpm build:app`
Expected: electron-builder rebuilds `better-sqlite3` for Electron and emits a `.dmg` under `apps/ui/dist/electron/Packaged/` (path per Quasar). No signing step runs (identity:null).

- [ ] **Step 2: Verify the built app**

Open the produced `.app`/`.dmg` (right-click → Open, since unsigned). Expected: the app launches standalone (no `pnpm`, no dev servers), a session can be created, and a blurred-window status change produces a notification.

- [ ] **Step 3: Document desktop mode**

In `README.md`, add a "Desktop app" section after "Setup & run":

```markdown
## Desktop app (macOS)

Kermanych also runs as a desktop app (Electron via Quasar): one window that
starts the API in-process — no browser, no separate dev servers.

```bash
pnpm dev:app      # run the desktop app in dev
pnpm build:app    # build a macOS .dmg (unsigned)
```

The build is **unsigned**, so on first open macOS Gatekeeper blocks it. Open it
with **right-click → Open** (once), or clear the quarantine flag:

```bash
xattr -cr /Applications/Kermanych.app
```

Native module note: `better-sqlite3` is rebuilt for the Electron ABI at build
time; for `pnpm dev:app`, run `pnpm --filter @kermanych/ui exec electron-rebuild
-f -w better-sqlite3` once after install.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document desktop app build + Gatekeeper note"
```

---

## Self-Review

**Spec coverage:**
- §3.1 importable bootstrap → Task 2. ✅
- §3.2 electron main (port pick, bootstrap, window, lifecycle, failure dialog) → Task 4. ✅
- §3.3 port hand-off (preload argv + renderer fallback) → Task 4 steps 3–5. ✅
- §3.4 notifications (`shouldNotify` in core + renderer wiring + click focus) → Task 1 + Task 5. ✅
- §3.5 quasar/build config, deps, native rebuild, scripts, README → Tasks 3 + 6. ✅
- Verification (unit `shouldNotify`, smokes, native-module check) → Task 1 tests + Task 4/5/6 smokes. ✅

**Placeholder scan:** no TBD/TODO; every code step has concrete content.

**Type consistency:** `bootstrap({port})→{app,url}` produced in Task 2, consumed in Task 4; `shouldNotify(prev,next)` produced Task 1, consumed Task 5; `window.kermanych.{apiBase,focus}` declared Task 4 step 1, set in preload Task 4 step 3, consumed in api/socket (Task 4) and orchestrator (Task 5). Names align.
