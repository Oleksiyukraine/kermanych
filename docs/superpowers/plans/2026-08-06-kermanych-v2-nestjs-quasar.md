# Kermanych v2 — NestJS + Quasar Re-platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Re-platform the existing Kermanych MVP (project-grouped, parallel `omp` session orchestrator) onto a pnpm monorepo — NestJS backend (Node) + Quasar/Vue frontend — with a small custom UI-kit built from `kermanych/design/design-system.html`. Same feature set as the shipped MVP; new stack + new visual design.

**Architecture:** `packages/core` holds framework-agnostic logic (RPC framing, event→status reducer, worktree naming, shared types) ported verbatim from the proven MVP. `apps/api` is a NestJS app wrapping that logic as injectable services + REST controllers + a Socket.IO gateway. `apps/ui` is a Quasar (Vue 3 + Vite + Pinia) app whose look is a **custom Modernist UI-kit** (NOT Quasar Material widgets) driven by `packages/tokens`. One `omp --mode rpc` child + one git worktree per session, exactly as before.

**Tech Stack:** Node 22 + pnpm workspaces; NestJS 10 (`@nestjs/platform-express`, `@nestjs/platform-socket.io`), `better-sqlite3`, Node `child_process`; Quasar 2 / Vue 3 / Pinia / Vite, `socket.io-client`, `@fontsource/archivo` + `@fontsource/jetbrains-mono`; Vitest for pure-logic unit tests.

## Global Constraints

- Node 22 + pnpm; TypeScript strict everywhere. Package manager is **pnpm** (workspaces); do not use bun for the v2 tree.
- `omp` ≥ 17.2.9 on PATH; one session = `omp --mode rpc --cwd <worktree> [--model <m>]` (Node `child_process.spawn`).
- RPC protocol per `omp://rpc.md`: read `ready`, send `negotiate_protocol` v2, correlate by `id`, reassemble `rpc_chunk`. A turn is done only on `agent_end` with `isTerminal !== false`. `start()`/commands MUST reject on early child exit; stderr MUST be drained.
- Worktrees under `~/.kermanych/worktrees/<sessionId>`; branches `kermanych/<slug>`; registry DB `~/.kermanych/kermanych.sqlite`.
- Only interactive UI methods (`select`/`confirm`/`input`/`editor`) set `waiting_input`/`pendingUiRequest`; fire-and-forget (`setWidget`, …) do not.
- **Design system is the visual source of truth:** `kermanych/design/design-system.html` (render it) + `packages/tokens`. Rules: radius 0 (except macOS window buttons); 2px rules between zones, 1px within a block; single accent `#ff563c` (active panel / primary action / decision request only); no gradients/glass/glow; shadow only on modal layer; Archivo for UI text, JetBrains Mono for all machine text; green only for diff/tests; button labels + headings flush-left. Do NOT use Quasar Material components for the core look — use Quasar only for framework/layout/build/state; build custom `K*` components.
- Tokens (exact): canvas `#12110f`, bg `#1b1a19`, surface `#232120`, surface2 `#2b2927`, line `#3a3735`, line-strong `#4a4644`, text `#f3f2f2`, muted `#8f8b88`, accent `#ff563c`, diff-green `#3fb950`.
- Testing: TDD (vitest) for pure logic in `packages/core` only; api/ui/integration verified by smoke test + a headless e2e; do not unit-test plumbing.
- REST + WS API surface is unchanged from the MVP (see below). One commit per task; conventional messages.
- The legacy MVP lives at `kermanych/src`, `kermanych/web`, `kermanych/tests` (Bun). It is the PORT SOURCE; a final task deletes it. Do not import from it.

## API surface (unchanged)

REST (JSON, base `http://localhost:4317`):
- `GET /api/groups` · `POST /api/groups {name,projectDir}` · `DELETE /api/groups/:id`
- `GET /api/sessions?groupId=` · `POST /api/sessions {groupId,name,task,model?}`
- `POST /api/sessions/:id/message {text,mode}` · `POST /api/sessions/:id/answer {res}` · `POST /api/sessions/:id/stop` · `DELETE /api/sessions/:id`
- `GET /api/sessions/:id/transcript`

WebSocket (Socket.IO, default namespace): on connect the server emits `{type:"snapshot",groups,sessions}`, then `ServerEvent` objects (`session_update`, `transcript_append`, `group_update`, `session_removed`, `group_removed`).

---

## File Structure

```
kermanych/
  package.json                 # pnpm workspace root (private)
  pnpm-workspace.yaml
  tsconfig.base.json
  packages/
    tokens/                    # design tokens: TS consts + tokens.css (:root vars) + fonts.css
      package.json  src/index.ts  src/tokens.css  src/fonts.css
    core/                      # framework-agnostic logic (ported)
      package.json  tsconfig.json  vitest.config.ts
      src/{types,rpc-frames,status,worktree-names,index}.ts
      test/{rpc-frames,status,worktree-names}.spec.ts
  apps/
    api/                       # NestJS (Node)
      package.json  tsconfig.json  nest-cli.json
      src/main.ts  src/app.module.ts
      src/rpc/rpc-session.ts
      src/worktree/worktree.service.ts
      src/registry/registry.service.ts
      src/supervisor/supervisor.service.ts
      src/http/{groups.controller,sessions.controller}.ts
      src/ws/events.gateway.ts
    ui/                        # Quasar (Vue 3 + Vite + Pinia)
      package.json  quasar.config.ts  tsconfig.json  index.html
      src/css/app.scss
      src/boot/tokens.ts
      src/lib/{api,socket}.ts
      src/stores/orchestrator.ts
      src/components/kit/{KBtn,KTag,KStatusDot,KField,KToggle,KModal,KPanel,KLogBlock,KRailItem,KStatusBar}.vue
      src/layouts/MainLayout.vue
      src/pages/{WorkspacePage,KitGalleryPage}.vue
      src/router/routes.ts
  design/                      # unchanged (design-system.html, design-v01.html)
```

---

## Phase A — Monorepo scaffold

### Task A1: pnpm workspace root

**Files:** Create `kermanych/pnpm-workspace.yaml`, `kermanych/tsconfig.base.json`; replace `kermanych/package.json`.

**Interfaces:** Produces the workspace root. Consumes nothing.

- [ ] **Step 1: pnpm-workspace.yaml**

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

- [ ] **Step 2: package.json (replace the legacy one)**

```json
{
  "name": "kermanych",
  "private": true,
  "packageManager": "pnpm@10.33.2",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "dev:api": "pnpm --filter @kermanych/api start:dev",
    "dev:ui": "pnpm --filter @kermanych/ui dev"
  }
}
```

- [ ] **Step 3: tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "skipLibCheck": true, "esModuleInterop": true,
    "declaration": true, "sourceMap": true, "resolveJsonModule": true
  }
}
```

- [ ] **Step 4: Verify + commit**

Run: `cd kermanych && pnpm install`
Expected: completes (empty workspace, no packages yet is fine — or after later tasks). Commit `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`.

```bash
git add kermanych/pnpm-workspace.yaml kermanych/package.json kermanych/tsconfig.base.json
git commit -m "chore: pnpm monorepo root for v2"
```

### Task A2: packages/tokens

**Files:** Create `kermanych/packages/tokens/{package.json,src/index.ts,src/tokens.css,src/fonts.css}`.

**Interfaces:** Produces `@kermanych/tokens` exporting `tokens` (TS object) and CSS files `tokens.css` (`:root` custom properties) + `fonts.css` (@fontsource imports). Consumed by `apps/ui`.

- [ ] **Step 1: package.json**

```json
{
  "name": "@kermanych/tokens", "version": "0.0.0", "private": true,
  "type": "module", "main": "src/index.ts",
  "exports": { ".": "./src/index.ts", "./tokens.css": "./src/tokens.css", "./fonts.css": "./src/fonts.css" },
  "dependencies": { "@fontsource/archivo": "^5", "@fontsource/jetbrains-mono": "^5" }
}
```

- [ ] **Step 2: src/index.ts**

```ts
export const tokens = {
  color: {
    canvas: "#12110f", bg: "#1b1a19", surface: "#232120", surface2: "#2b2927",
    line: "#3a3735", lineStrong: "#4a4644", text: "#f3f2f2", muted: "#8f8b88",
    accent: "#ff563c", diff: "#3fb950",
  },
  font: { ui: "'Archivo', -apple-system, sans-serif", mono: "'JetBrains Mono', monospace" },
  rule: { thin: "1px", strong: "2px" },
} as const;
export type Tokens = typeof tokens;
```

- [ ] **Step 3: src/tokens.css**

```css
:root {
  --k-canvas:#12110f; --k-bg:#1b1a19; --k-surface:#232120; --k-surface2:#2b2927;
  --k-line:#3a3735; --k-line-strong:#4a4644; --k-text:#f3f2f2; --k-muted:#8f8b88;
  --k-accent:#ff563c; --k-diff:#3fb950;
  --k-font-ui:'Archivo',-apple-system,BlinkMacSystemFont,sans-serif;
  --k-font-mono:'JetBrains Mono',ui-monospace,monospace;
}
```

- [ ] **Step 4: src/fonts.css**

```css
@import "@fontsource/archivo/400.css";
@import "@fontsource/archivo/800.css";
@import "@fontsource/jetbrains-mono/400.css";
```

- [ ] **Step 5: Verify + commit** — `pnpm install` resolves @fontsource. Commit the package.

```bash
git add kermanych/packages/tokens
git commit -m "feat(tokens): design tokens + fonts"
```

---

## Phase B — Core logic (packages/core)

### Task B1: core scaffold + ported types & pure logic (TDD)

**Files:** Create `kermanych/packages/core/{package.json,tsconfig.json,vitest.config.ts}`, `src/{types,rpc-frames,status,worktree-names,index}.ts`, `test/{rpc-frames,status,worktree-names}.spec.ts`.

**Interfaces:** Produces `@kermanych/core` exporting: all shared types (`Group`, `Session`, `SessionStatus`, `TodoPhase`, `TodoTask`, `TranscriptEntry`, `RpcExtensionUIRequest`, `RpcExtensionUIResponse`, `RpcEvent`, `ServerEvent`); `LineSplitter`, `ChunkReassembler` (from rpc-frames); `INITIAL_STATUS`, `reduceStatus`, `StatusState`, `INTERACTIVE_UI_METHODS` (from status); `slugify`, `branchName`, `uniqueSlug`, `worktreeDir` (from worktree-names). Consumed by `apps/api` (and types by `apps/ui`).

**Port source (proven; copy verbatim — core builds to CommonJS, so relative imports need no file extension):**
- `types.ts` ← `kermanych/src/server/types.ts` (verbatim).
- `rpc-frames.ts` ← `kermanych/src/server/rpc-frames.ts` (verbatim; `Buffer` is a Node global).
- `status.ts` ← `kermanych/src/server/status.ts` (verbatim).
- `worktree-names.ts` ← the PURE helpers of `kermanych/src/server/worktree.ts` only: `slugify`, `branchName` (returns `` `kermanych/${slug}` ``), `uniqueSlug`, `worktreeDir` (returns `join(homedir(),".kermanych","worktrees",sessionId)`). Do NOT bring the git-exec functions (they move to the api WorktreeService).
- Tests ← port `tests/rpc-frames.test.ts`, `tests/status.test.ts`, and the pure-helper parts of `tests/worktree.test.ts` to Vitest (`import { test, expect } from "vitest"`; keep all assertions identical).

- [ ] **Step 1: package.json**

```json
{
  "name": "@kermanych/core", "version": "0.0.0", "private": true,
  "main": "dist/index.js", "types": "dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "test": "vitest run", "build": "tsc -p tsconfig.json" },
  "devDependencies": { "vitest": "^2", "typescript": "^5.6", "@types/node": "^22" }
}
```

- [ ] **Step 2: tsconfig.json + vitest.config.ts**

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "module": "CommonJS", "moduleResolution": "Node", "outDir": "dist", "rootDir": "src", "declaration": true }, "include": ["src"] }
```
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.spec.ts"] } });
```

- [ ] **Step 3: Port sources** — copy the four source files per "Port source" above; add `src/index.ts` re-exporting all four modules.

- [ ] **Step 4: Port tests to vitest** — copy the three test files, switch the import to `vitest`, keep assertions. (rpc-frames: 5 tests incl. byte-segment + multibyte reassembly; status: 5 tests incl. the setWidget non-transition; worktree-names: slugify/branchName/uniqueSlug.)

- [ ] **Step 5: Run + commit**

Run: `cd kermanych && pnpm --filter @kermanych/core test` then `pnpm --filter @kermanych/core build`
Expected: tests PASS (rpc-frames 5, status 5, worktree-names 3); `build` emits `dist/` (CommonJS) so `apps/api` can `require()` it. core must be built before api build/typecheck (`pnpm -r build` orders this topologically).

```bash
git add kermanych/packages/core
git commit -m "feat(core): port framework-agnostic logic + tests"
```

---

## Phase C — Backend (apps/api, NestJS)

### Task C1: NestJS app scaffold

**Files:** Create `kermanych/apps/api/{package.json,tsconfig.json,nest-cli.json}`, `src/main.ts`, `src/app.module.ts`.

**Interfaces:** Produces the bootable Nest app (`@kermanych/api`) listening on `:4317` with CORS `*`. Consumes `@kermanych/core`.

- [ ] **Step 1: package.json**

```json
{
  "name": "@kermanych/api", "version": "0.0.0", "private": true,
  "scripts": { "build": "nest build", "start": "node dist/main.js", "start:dev": "nest start --watch" },
  "dependencies": {
    "@nestjs/common": "^10", "@nestjs/core": "^10", "@nestjs/platform-express": "^10",
    "@nestjs/platform-socket.io": "^10", "@nestjs/websockets": "^10",
    "better-sqlite3": "^11", "reflect-metadata": "^0.2", "rxjs": "^7",
    "socket.io": "^4", "@kermanych/core": "workspace:*"
  },
  "devDependencies": { "@nestjs/cli": "^10", "@types/better-sqlite3": "^7", "@types/node": "^22", "typescript": "^5.6" }
}
```

- [ ] **Step 2: tsconfig.json + nest-cli.json**

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "./dist", "module": "commonjs", "moduleResolution": "node", "experimentalDecorators": true, "emitDecoratorMetadata": true, "target": "ES2021" }, "include": ["src"] }
```
```json
{ "collection": "@nestjs/schematics", "sourceRoot": "src" }
```
(Note: Nest uses CommonJS + decorators, overriding the NodeNext base.)

- [ ] **Step 3: main.ts + app.module.ts** (empty module first; providers wired in later tasks)

```ts
// src/main.ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: "*" });
  app.setGlobalPrefix("api", { exclude: [] });
  await app.listen(4317);
  console.log("Kermanych API on http://localhost:4317");
}
bootstrap();
```
```ts
// src/app.module.ts
import { Module } from "@nestjs/common";
@Module({})
export class AppModule {}
```

- [ ] **Step 4: Verify + commit** — `pnpm --filter @kermanych/api build` compiles; `node dist/main.js` logs the banner then Ctrl-C. Commit.

```bash
git add kermanych/apps/api
git commit -m "feat(api): NestJS app scaffold"
```

### Task C2: RpcSession (Node child_process)

**Files:** Create `kermanych/apps/api/src/rpc/rpc-session.ts`.

**Interfaces:** Produces `class RpcSession` with the SAME public API as the MVP: `constructor({cwd,model?,ompPath?})`, `onEvent(cb)`, `onExit(cb)`, `start(): Promise<void>`, `prompt/followUp/steer(msg)`, `answerUi(res)`, `getState(): Promise<RpcStateData>`, `stop(): Promise<void>`. Consumes `LineSplitter`, `ChunkReassembler`, `RpcEvent`, `RpcExtensionUIResponse`, `TodoPhase` from `@kermanych/core`.

**Port source:** `kermanych/src/server/rpc-session.ts` (includes the shipped fixes: reject start()/pending on early exit; drain stderr). Apply these Node swaps:
- `Bun.spawn(argv,{stdin:"pipe",stdout:"pipe",stderr:"pipe"})` → `spawn(argv[0], argv.slice(1), { stdio:["pipe","pipe","pipe"] })` from `node:child_process`.
- stdout read loop → `child.stdout.on("data",(b:Buffer)=>{ for (const line of this.splitter.push(b.toString("utf8"))) this.handleLine(line); })`.
- stderr drain → `child.stderr.on("data",(b:Buffer)=>{ this.stderr=(this.stderr+b.toString("utf8")).slice(-8192); })`.
- exit → `child.on("exit",(code)=>{ this.onExitInternal(code); })` (reject `ready` if not yet ready; reject all `pending`; fire exit cbs).
- write → `child.stdin!.write(JSON.stringify(o)+"\n")`.
- `stop()` → `child.stdin!.end(); await new Promise<void>(r=>child.on("close",()=>r()))`.
- `Promise.withResolvers()` is available in Node 22; keep it.

- [ ] **Step 1: Implement per port source + swaps above.**

- [ ] **Step 2: Smoke-verify against real omp** — scratch script: `new RpcSession({cwd:process.cwd()})`, `start()`, `prompt("say hi then stop")`, log events, after `agent_end` call `getState()`, `stop()`. Run with `pnpm --filter @kermanych/api exec tsx src/rpc/_smoke.ts` (add `tsx` devDep or compile). If omp lacks auth, report BLOCKED. Remove scratch before commit. Record observed sequence in report.

- [ ] **Step 3: Commit** `git commit -m "feat(api): RpcSession over omp --mode rpc (node)"`.

### Task C3: WorktreeService

**Files:** Create `kermanych/apps/api/src/worktree/worktree.service.ts`.

**Interfaces:** `@Injectable() class WorktreeService` with `isGitRepo(dir):Promise<boolean>`, `addWorktree(repoDir,wtDir,branch):Promise<void>`, `removeWorktree(repoDir,wtDir):Promise<void>`, `removeBranch(repoDir,branch):Promise<void>`. Uses `worktreeDir`/`branchName`/`slugify`/`uniqueSlug` from `@kermanych/core` where needed (naming stays in core; this service only runs git). Consumes `node:child_process`.

**Port source:** the git-exec functions of `kermanych/src/server/worktree.ts` (incl. the shipped `removeBranch`). Swap `Bun.spawn` → a Node `git()` helper:

```ts
import { spawn } from "node:child_process";
function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const p = spawn("git", ["-C", cwd, ...args]); let out = "";
    p.stdout.on("data", (b) => (out += b)); p.stderr.on("data", (b) => (out += b));
    p.on("close", (code) => resolve({ ok: code === 0, out }));
  });
}
```

- [ ] **Step 1: Implement** the service (methods throw on failure for add; best-effort for remove/removeBranch, matching the MVP).
- [ ] **Step 2: Commit** `git commit -m "feat(api): worktree service"`.

### Task C4: RegistryService (better-sqlite3, unit-tested)

**Files:** Create `kermanych/apps/api/src/registry/registry.service.ts` + `apps/api/test/registry.spec.ts` + wire vitest in api package.json (`"test":"vitest run"`, add `vitest` devDep).

**Interfaces:** `@Injectable() class RegistryService` with the MVP Registry methods: `listGroups()`, `createGroup(g)`, `removeGroup(id)`, `listSessions(groupId?)`, `createSession(s)`, `updateSession(id,patch)`, `removeSession(id)`. A constructor/factory accepts a db path (default `~/.kermanych/kermanych.sqlite`; `":memory:"` in tests). Consumes `Group`/`Session`/`SessionStatus` from core.

**Port source:** `kermanych/src/server/registry.ts`. Swap `bun:sqlite` → `better-sqlite3`:
- `import Database from "better-sqlite3"`.
- Schema: `this.db.exec("CREATE TABLE IF NOT EXISTS ...")`.
- `this.db.run(sql,[a,b])` → `this.db.prepare(sql).run(a,b)` (positional args spread, NOT an array).
- `this.db.query(sql).all(x)` → `this.db.prepare(sql).all(x)`; `.get(id)` → `.prepare(sql).get(id)`.
- Coerce `undefined` params to `null` before binding (better-sqlite3 rejects `undefined`).
- Fix the MVP's spread-after-default minor: build the row (`{ ...s, id, createdAt, status: s.status ?? "queued" }`) so an explicit `status:undefined` cannot clobber the default.

- [ ] **Step 1: Write failing test** (port the MVP round-trip test to vitest, `new RegistryService(":memory:")`).
- [ ] **Step 2: Run → FAIL.** `pnpm --filter @kermanych/api test`
- [ ] **Step 3: Implement** per port + swaps.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `git commit -m "feat(api): sqlite registry service"`.

### Task C5: SupervisorService

**Files:** Create `kermanych/apps/api/src/supervisor/supervisor.service.ts`.

**Interfaces:** `@Injectable() class SupervisorService` with the MVP Supervisor API: `snapshot()`, `addGroup(name,projectDir)`, `removeGroup(id)` (async cascade), `createSession(groupId,name,task,model?)`, `sendMessage(id,text,mode)`, `answerUi(id,res)`, `stopSession(id)`, `deleteSession(id)`, `getTranscript(id)`, plus `events$: Observable<ServerEvent>` (RxJS `Subject`) replacing the MVP `onServerEvent` callback. Injects `RegistryService`, `WorktreeService`; constructs `RpcSession` per session. Consumes core `reduceStatus`/`INITIAL_STATUS`/types.

**Port source:** `kermanych/src/server/supervisor.ts` — port ALL logic including every shipped fix: interactive-only `pendingUiRequest`; `onExit` always `stopPoll` + mark error unless stopped/done; `removeGroup` awaits `deleteSession` per session; `createSession` rolls back (stop rpc, remove worktree+branch, drop map+row, emit `session_removed`) on `addWorktree` OR `start()` failure; `deleteSession` sets status `stopped` before `rpc.stop()` and removes worktree+branch. Swaps: `this.emit(e)` → `this.events.next(e)` (a private `Subject<ServerEvent>`; expose `events$ = this.events.asObservable()`); `Timer`/`setInterval` are Node globals.

- [ ] **Step 1: Implement** the service (framework wiring aside, behavior identical to the reviewed MVP supervisor).
- [ ] **Step 2: Verify it compiles** — `pnpm --filter @kermanych/api build`. No unit tests (integration; smoke in C8/E4).
- [ ] **Step 3: Commit** `git commit -m "feat(api): supervisor service"`.

### Task C6: HTTP controllers

**Files:** Create `kermanych/apps/api/src/http/groups.controller.ts`, `sessions.controller.ts`.

**Interfaces:** `GroupsController` (`GET/POST /groups`, `DELETE /groups/:id`) and `SessionsController` (`GET/POST /sessions`, `POST /sessions/:id/message|answer|stop`, `GET /sessions/:id/transcript`, `DELETE /sessions/:id`) — the global prefix `api` (set in main) yields the `/api/...` paths. Delegate to `SupervisorService`/`RegistryService`. Errors → 400 via a simple exception filter or by throwing `BadRequestException`.

```ts
// groups.controller.ts (shape)
@Controller("groups")
export class GroupsController {
  constructor(private sup: SupervisorService, private reg: RegistryService) {}
  @Get() list() { return this.reg.listGroups(); }
  @Post() create(@Body() b: { name: string; projectDir: string }) { return this.sup.addGroup(b.name, b.projectDir); }
  @Delete(":id") async remove(@Param("id") id: string) { await this.sup.removeGroup(id); return { ok: true }; }
}
```
(SessionsController analogous; `message` reads `{text,mode}`, `answer` reads `{res}`.)

- [ ] **Step 1: Implement both controllers.**
- [ ] **Step 2: Commit** `git commit -m "feat(api): REST controllers"`.

### Task C7: Socket.IO events gateway

**Files:** Create `kermanych/apps/api/src/ws/events.gateway.ts`.

**Interfaces:** `@WebSocketGateway({ cors: { origin: "*" } }) class EventsGateway implements OnGatewayConnection, OnModuleInit`. On `handleConnection(client)`: emit `client.emit("event", { type:"snapshot", ...supervisor.snapshot() })`. On `onModuleInit`: subscribe `supervisor.events$` → `this.server.emit("event", e)`. (Single `"event"` channel carrying `ServerEvent` objects.) Injects `SupervisorService`.

- [ ] **Step 1: Implement the gateway.**
- [ ] **Step 2: Commit** `git commit -m "feat(api): socket.io events gateway"`.

### Task C8: Wire AppModule + backend smoke

**Files:** Modify `kermanych/apps/api/src/app.module.ts` (register providers + controllers + gateway).

```ts
@Module({
  controllers: [GroupsController, SessionsController],
  providers: [RegistryService, WorktreeService, SupervisorService, EventsGateway],
})
export class AppModule {}
```

- [ ] **Step 1: Wire the module.**
- [ ] **Step 2: Smoke test** — `pnpm --filter @kermanych/api build && node apps/api/dist/main.js &`; then: `curl -s localhost:4317/api/groups` → `[]`; make a temp git repo (with a commit); `POST /api/groups` valid → group JSON; non-git dir → 400 error; a `socket.io-client` one-liner connects and receives the `snapshot` `event`. Optionally a full session lifecycle (create group+session on the temp repo, watch `session_update` to `done`, delete). Clean up (kill server, rm temp, delete group). Record outputs.
- [ ] **Step 3: Commit** `git commit -m "feat(api): wire module + backend smoke"`.

---

## Phase D — UI-kit (apps/ui, Quasar)

### Task D1: Quasar app scaffold + theme

**Files:** Create `kermanych/apps/ui` via Quasar scaffold (SPA, Vue 3, Vite, TS, Pinia). Then: `src/boot/tokens.ts` (import `@kermanych/tokens/fonts.css` + `tokens.css`), `src/css/app.scss` (dark base: `body{background:var(--k-canvas);color:var(--k-text);font-family:var(--k-font-ui)}`, `*{border-radius:0}`, mono helper class), register `@kermanych/tokens` + `@kermanych/core` (types) + `socket.io-client` deps.

- [ ] **Step 1: Scaffold** — `cd kermanych/apps && pnpm create quasar` (or `pnpm dlx @quasar/cli create`) with: app name `ui` (package name `@kermanych/ui`), Quasar v2, Vue 3, TS, Vite, Pinia, SPA. Set dev server port 5317 in `quasar.config.ts`. Add deps `@kermanych/tokens`, `@kermanych/core`, `socket.io-client`.
- [ ] **Step 2: Theme boot + app.scss** per above; ensure fonts + tokens load; dark canvas background.
- [ ] **Step 3: Verify** — `pnpm --filter @kermanych/ui build` succeeds (SPA). Commit.
- [ ] **Step 4: Commit** `git commit -m "feat(ui): quasar scaffold + kermanych theme"`.

### Task D2: UI-kit base components + gallery

**Files:** Create `src/components/kit/{KBtn,KTag,KStatusDot,KField,KToggle,KModal}.vue`, `src/pages/KitGalleryPage.vue`, add a `/kit` route.

**Interfaces (contracts — implement to `design/design-system.html`, sections 03/04/08):**
- `KBtn` props `variant: 'primary'|'secondary'|'ghost'|'icon'`, `disabled?`. Radius 0, label flush-left, mono/UI per role. primary = accent bg; secondary = surface2 + line-strong border; ghost = transparent + text; icon = square.
- `KTag` (slot text) — surface2 bg, muted text, mono; used for `⑂ branch`, `opus-5`, status words.
- `KStatusDot` prop `status: SessionStatus` — 7×7 square: running = accent pulsing, waiting = transparent w/ accent border, done/cold = muted fill.
- `KField` props `label`, `modelValue` — flush-left label, 0 radius, accent focus ring.
- `KToggle` props `options: string[]`, `modelValue` — segmented (OMP/zsh style).
- `KModal` props `title`, controls slot — the only shadowed layer; 1px border, 2px rule under title.

- [ ] **Step 1: Implement the 6 components** to the design-system (use tokens CSS vars; no Quasar Material widgets for their look — plain elements styled with tokens; QDialog may host KModal).
- [ ] **Step 2: KitGalleryPage** renders every component in all variants/states; add route `/kit`.
- [ ] **Step 3: Verify** — `pnpm --filter @kermanych/ui build`; run dev, screenshot `/kit` (controller/reviewer confirms it matches design-system sections 03/04/08). Commit.
- [ ] **Step 4: Commit** `git commit -m "feat(ui): base UI-kit + gallery"`.

### Task D3: UI-kit composite components

**Files:** Create `src/components/kit/{KPanel,KLogBlock,KRailItem,KStatusBar}.vue`; extend the gallery.

**Interfaces (implement to design-system sections 05/06/07):**
- `KLogBlock` prop `entry: TranscriptEntry` — renders by kind: `tool_call` (◆ diamond, muted, mono), `tool_result` (✓/✗ + tool), `assistant_text` (primary text, UI font), `assistant_thinking` (muted italic), `notice` (muted); a `decision` variant (see below) is the ONE accent block. diff lines inside tool/assistant text get a 2px green strip + 7% accent tint. All machine text mono.
- `KPanel` props `session: Session`, slots for log + input — 3 floors: header (34px: `omp · group ⑂ branch  timer/status  ⊞ ✕`, active = surface2 + 2px accent top strip via KStatusDot logic), scrollable log, input row (red `❯` when focused). Emits `stop`, `delete`, `send(text)`, `answer(res)`.
- A decision block (inside KPanel/KLogBlock) renders `session.pendingUiRequest` as "ПОТРІБНЕ РІШЕННЯ" with the accent block-strip and the interactive controls (confirm/select/input/editor) → emits `answer` with the correct `RpcExtensionUIResponse` shape.
- `KRailItem` props `group`, `active`, `count` — compact tile, initials, count badge, active = surface2 + left 2px accent strip.
- `KStatusBar` props `counts:{running,waiting,done}`, `model?`, `tokens?`, `cost?` — left aggregates, right telemetry, mono numbers.

- [ ] **Step 1: Implement the 4 components + decision block** to the design-system.
- [ ] **Step 2: Extend gallery** with sample data for each. Verify build + screenshot. Commit.
- [ ] **Step 3: Commit** `git commit -m "feat(ui): composite UI-kit (panel/log/rail/statusbar)"`.

---

## Phase E — Screens + wiring + verification

### Task E1: Pinia store + API/socket client

**Files:** Create `src/lib/api.ts`, `src/lib/socket.ts`, `src/stores/orchestrator.ts`.

**Interfaces:** `api` = typed REST helpers (createGroup, deleteGroup, createSession, sendMessage, answerUi, stopSession, deleteSession, loadTranscript) against `http://localhost:4317/api`. `socket.ts` = a `socket.io-client` connection to `http://localhost:4317` listening on `"event"`. `useOrchestrator` Pinia store: state `{groups,sessions,transcripts,selectedGroupId,selectedSessionId}`, `connect()` (wire socket → reduce `ServerEvent` exactly like the MVP store: snapshot/group_update/group_removed/session_update/session_removed/transcript_append), `selectGroup/selectSession`, and actions delegating to `api`. Types from `@kermanych/core`.

- [ ] **Step 1: Implement** api + socket + store (port the MVP store's ServerEvent reduction; socket.io gives reconnection for free).
- [ ] **Step 2: Commit** `git commit -m "feat(ui): pinia store + api/socket client"`.

### Task E2: App shell (layout + rail + status bar)

**Files:** `src/layouts/MainLayout.vue`, `src/router/routes.ts`.

**Interfaces:** `MainLayout` = QLayout with a left rail (`KRailItem` per group + `+` add-group opening a `KModal` with name+projectDir → `api.createGroup`), a top header (`КЕРМАНИЧ v0.1`, selected-group context, `+ Новий агент`), the `WorkspacePage` in the page container, and a bottom `KStatusBar` fed by computed session counts. `connect()` the store on mount. Route `/` → WorkspacePage, `/kit` → KitGalleryPage.

- [ ] **Step 1: Implement layout + routes.**
- [ ] **Step 2: Commit** `git commit -m "feat(ui): app shell (rail + header + status bar)"`.

### Task E3: Workspace screen

**Files:** `src/pages/WorkspacePage.vue`.

**Interfaces:** For the selected group: a board of session cards (compact `KPanel`/`KStatusDot` summary: name, status square, branch, ctx%) + a "Новий агент" launcher (name + task + optional model → `api.createSession`). Selecting a card opens the full `KPanel` detail (header + log via `KLogBlock` over `transcripts[id]` + input sending `prompt`/`follow_up`/`steer` by status + the decision block when `pendingUiRequest`; Stop/Delete controls). Wire all emits to store actions. ctx% renders `session.contextPercent.toFixed(0)` (already 0–100, no ×100).

- [ ] **Step 1: Implement the workspace page.**
- [ ] **Step 2: Verify build** — `pnpm --filter @kermanych/ui build`. Commit.
- [ ] **Step 3: Commit** `git commit -m "feat(ui): workspace screen"`.

### Task E4: End-to-end verification

**Files:** none (verification only; fixes land in the owning package).

- [ ] **Step 1: Unit suites** — `pnpm -r test` → core (13) + api registry pass.
- [ ] **Step 2: Typecheck + build** — `pnpm -r build` → core, api, ui all build clean.
- [ ] **Step 3: Headless e2e** — start `node apps/api/dist/main.js &`; temp git repo with a commit; via REST+socket.io-client: create group, launch two sessions (trivial tasks), assert both reach `done` via `session_update`; assert two worktrees + two `kermanych/*` branches; delete one → worktree+branch gone; removeGroup cascade stops the other child + cleans up. Clean up fully.
- [ ] **Step 4: UI visual** — run `pnpm dev:api` + `pnpm dev:ui`; open `http://localhost:5317`; screenshot the workspace with a live group/session; confirm it matches the design language (dark canvas, accent active panel, mono logs, status squares). Report the screenshot.
- [ ] **Step 5: Commit** any fixes; `git commit -m "test: v2 end-to-end verification"`.

### Task E5: Remove legacy MVP + docs

**Files:** Delete `kermanych/src`, `kermanych/web`, `kermanych/tests`, `kermanych/bun.lock`, and the legacy per-app `tsconfig.json` if superseded. Add `kermanych/README.md` (what it is + `pnpm install`, `pnpm dev:api`, `pnpm dev:ui`).

- [ ] **Step 1: `git rm -r` the legacy Bun app files** (the ported logic now lives in packages/core + apps/api; the React UI is replaced by apps/ui). Confirm `pnpm -r build` + `pnpm -r test` still green after removal.
- [ ] **Step 2: README** with run instructions.
- [ ] **Step 3: Commit** `git commit -m "chore: remove legacy bun MVP; add README"`.

---

## Self-Review

**Spec coverage:** monorepo (A1) · tokens/UI-kit (A2,D2,D3) · core logic ported + tested (B1) · NestJS backend with RpcSession/Worktree/Registry/Supervisor/controllers/gateway (C1–C8) · Quasar UI shell + store + workspace screen with all MVP features incl. approval + status (D1,E1–E3) · isolation/lifecycle preserved via ported supervisor (C5) · e2e + visual (E4) · legacy removed (E5). All shipped MVP fixes are explicitly carried in the port notes (C2 exit-reject/stderr; C4 registry default; C5 supervisor cascade/rollback/interactive-UI; E3 ctx% no-×100).

**Placeholder scan:** ports reference exact proven source files + list precise swaps; new code (tokens, nest bootstrap/module/gateway/controllers, store) is concrete; UI components carry explicit contracts bound to the design-system reference. No TBD.

**Type consistency:** all shared types live once in `@kermanych/core` and are imported by api + ui. `ServerEvent` reduction in the store mirrors the emitting supervisor. RRpcSession/Registry/Supervisor public APIs match their MVP originals so the port is behavior-preserving.

**Open risk to confirm during execution:** `better-sqlite3` native install on Node 22 (has prebuilds — expect clean `pnpm install`); Quasar scaffold is interactive (the implementer must drive `create quasar` non-interactively or accept defaults matching the File Structure).
