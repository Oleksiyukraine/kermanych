// apps/api/test/preview.spec.ts
// The live preview (docs/specs/2026-11-03-session-browser-preview.md): `.kermanych/preview.json`
// read from the session directory, ports and variables per service, ordered readiness, the
// banner fallback, the in-flight dedupe, crashes, the SIGKILL escalation and the log ring. Real
// child processes: one small node server script, steered by the env each service sets.
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Platform, PreviewState, Session } from "@kermanych/core";
import { PreviewService } from "../src/preview/preview.service";
import type { RegistryService } from "../src/registry/registry.service";
import { setBrowserHost, type BrowserHost } from "../src/browser/browser-host";

// Serves its own env as JSON on LISTEN (else PORT), after DELAY ms. SAY / LINES / RED print
// first; BANNER announces the URL on stderr like a dev server; EXIT_AFTER exits with EXIT_CODE
// once listening; IGNORE_TERM survives SIGTERM.
const SERVER = `
const e = process.env;
if (e.SAY) console.log(e.SAY);
if (e.RED) console.log("\\x1b[31mred\\x1b[0m");
for (let i = 0; i < Number(e.LINES || 0); i++) console.log("line " + i);
if (e.IGNORE_TERM) process.on("SIGTERM", () => {});
const port = Number(e.LISTEN || e.PORT);
setTimeout(() => {
  const srv = require("http").createServer((_, r) => r.end(JSON.stringify(e)));
  srv.listen(port, "127.0.0.1", () => {
    if (e.BANNER) console.error("  \\x1b[32m➜\\x1b[0m  Local:   \\x1b[36mhttp://localhost:" + srv.address().port + "/\\x1b[0m");
    if (e.EXIT_AFTER) setTimeout(() => process.exit(Number(e.EXIT_CODE || 1)), Number(e.EXIT_AFTER));
  });
}, Number(e.DELAY || 0));
`;

let base: string;
let script: string;
let svc: PreviewService | undefined;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "kermanych-preview-spec-"));
  script = join(base, "server.js");
  writeFileSync(script, SERVER);
});
afterEach(async () => {
  await svc?.onModuleDestroy();
  svc = undefined;
  setBrowserHost(undefined);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const node = () => `node ${JSON.stringify(script)}`;

type Fixture = { config?: unknown; raw?: string; kind?: Session["kind"]; platform?: Platform; finished?: boolean };

// One session in a fresh directory holding the given `.kermanych/preview.json`, behind a
// registry seam (the service reads only these two lists).
function make(f: Fixture = {}): { svc: PreviewService; dir: string } {
  const dir = mkdtempSync(join(base, "repo-"));
  if (f.config !== undefined || f.raw !== undefined) {
    mkdirSync(join(dir, ".kermanych"));
    writeFileSync(join(dir, ".kermanych", "preview.json"), f.raw ?? JSON.stringify(f.config));
  }
  const stub = {
    listSessions: () => [{ id: "s1", projectId: "p1", kind: f.kind ?? "agent", worktree: true, worktreePath: f.finished ? "" : dir }],
    listProjects: () => [{ id: "p1", localRepoPath: "/nowhere", ...(f.platform ? { platform: f.platform } : {}) }],
  };
  svc = new PreviewService(stub as unknown as RegistryService);
  Object.assign(svc.opts, { root: join(base, "previews"), readyMs: 15_000, killGraceMs: 400, shutdownGraceMs: 400, pollMs: 50 });
  return { svc, dir };
}

async function until<T>(read: () => T, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(v)}`);
    await sleep(50);
  }
}

function canConnect(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const sock = connect(port, "127.0.0.1");
  sock.once("connect", () => {
    sock.destroy();
    resolve(true);
  });
  sock.once("error", () => {
    sock.destroy();
    resolve(false);
  });
  return promise;
}

async function running(s: PreviewService): Promise<Extract<PreviewState, { phase: "running" }>> {
  const state = await s.settled("s1", 15_000);
  if (state?.phase !== "running") throw new Error(`expected running, got ${JSON.stringify(state)}`);
  return state;
}

const envOf = async (url: string) => (await (await fetch(url)).json()) as Record<string, string>;

test("a missing or invalid file, a fork, a back-end project and a finished session are refused", () => {
  const missing = make().svc;
  expect(missing.info("s1").config).toEqual({ kind: "missing" });
  expect(() => missing.start("s1")).toThrow(/preview\.json is missing/);

  const invalid = make({ config: { services: [{ name: "web", command: "x" }] } }).svc;
  expect(invalid.info("s1").config).toEqual({ kind: "invalid", error: expect.stringMatching(/exactly one service needs "open"/) });
  expect(() => invalid.start("s1")).toThrow(/preview\.json is invalid: services: exactly one/);
  expect(() => make({ raw: "{ nope" }).svc.start("s1")).toThrow(/not valid JSON/);

  const ok = { services: [{ name: "web", command: "true", open: true }] };
  expect(make({ config: ok }).svc.info("s1")).toEqual({ state: null, config: { kind: "ok", services: ["web"] } });
  expect(() => make({ config: ok, kind: "discussion" }).svc.start("s1")).toThrow(/only agent sessions/);
  expect(() => make({ config: ok, platform: "backend" }).svc.start("s1")).toThrow(/backend project has no live preview/);
  expect(() => make({ config: ok, platform: "mobile" }).svc.info("s1")).toThrow(/mobile/);
  expect(() => make({ config: ok, finished: true }).svc.start("s1")).toThrow(/finished/);
});

test("every step gets PREVIEW_DIR and every service's port; a service gets its own PORT and its env expanded; services start in order", async () => {
  const openPreview = vi.fn(async () => {});
  setBrowserHost({ openPreview } as unknown as BrowserHost);
  const { svc: s } = make({
    config: {
      setup: 'echo "setup $PORT_API $PORT_WEB_APP" && echo once >> "$PREVIEW_DIR/setup-runs"',
      services: [
        { name: "api", command: node(), env: { DB: "${PREVIEW_DIR}/db.sqlite", SAY: "api up", DELAY: "300" } },
        { name: "web-app", open: true, command: node(), env: { API: "http://localhost:${PORT_API}/api", SAY: "web spawned" } },
      ],
    },
  });
  const first = s.start("s1");
  expect(first).toEqual({ phase: "starting", step: "setup", services: [] });
  const state = await running(s);
  const [api, web] = state.services;
  expect(state.services.map((p) => p.name)).toEqual(["api", "web-app"]);
  expect(api!.port).not.toBe(web!.port);
  expect(state.url).toBe(`http://localhost:${web!.port}`);

  const previewDir = join(s.opts.root, "s1");
  const webEnv = await envOf(state.url);
  expect(webEnv).toMatchObject({ PORT: String(web!.port), PORT_API: String(api!.port), PORT_WEB_APP: String(web!.port), PREVIEW_DIR: previewDir, API: `http://localhost:${api!.port}/api` });
  const apiEnv = await envOf(`http://localhost:${api!.port}`);
  expect(apiEnv).toMatchObject({ PORT: String(api!.port), PORT_WEB_APP: String(web!.port), DB: `${previewDir}/db.sqlite` });

  expect(s.logs("s1", "setup", 0).lines.map((l) => l.text)).toEqual([`setup ${api!.port} ${web!.port}`]);
  expect(readFileSync(join(previewDir, "setup-runs"), "utf8")).toBe("once\n");
  // The api had to be ready (300 ms after it spoke) before the web was spawned at all.
  const apiLine = s.logs("s1", "api", 0).lines[0]!;
  const webLine = s.logs("s1", "web-app", 0).lines[0]!;
  expect([apiLine.text, webLine.text]).toEqual(["api up", "web spawned"]);
  expect(apiLine.seq).toBeLessThan(webLine.seq);
  expect(s.logs("s1", "api", 0).steps).toEqual(["setup", "api", "web-app"]);
  await vi.waitFor(() => expect(openPreview).toHaveBeenCalledWith({ sessionId: "s1", projectId: "p1" }, state.url));
}, 30_000);

test("the open service is also ready when stderr announces a URL whose port accepts", async () => {
  const { svc: s } = make({ config: { services: [{ name: "web", open: true, command: node(), env: { LISTEN: "0", BANNER: "1" } }] } });
  // LISTEN 0 binds a random port other than PORT; only the banner tells which.
  s.start("s1");
  const state = await running(s);
  const port = Number(new URL(state.url).port);
  expect(port).not.toBe(state.services[0]!.port);
  expect(await canConnect(port)).toBe(true);
  expect(s.logs("s1", "web", 0).lines.map((l) => l.text)).toEqual([`  ➜  Local:   http://localhost:${port}/`]);
}, 30_000);

test("a second start while one is in flight returns the current state and runs nothing twice", async () => {
  const { svc: s } = make({ config: { setup: 'echo x >> "$PREVIEW_DIR/runs"', services: [{ name: "web", open: true, command: node(), env: { DELAY: "200" } }] } });
  const a = s.start("s1");
  const b = s.start("s1");
  expect(b).toBe(a);
  const state = await running(s);
  expect(s.start("s1")).toBe(state);
  expect(readFileSync(join(s.opts.root, "s1", "runs"), "utf8")).toBe("x\n");
  expect(s.logs("s1", "web", 0).run).toBe(1);
}, 30_000);

test("a service exiting before ready fails the start with its code and log tail", async () => {
  const { svc: s } = make({ config: { services: [{ name: "web", open: true, command: 'echo "cannot bind"; exit 7' }] } });
  s.start("s1");
  const state = await s.settled("s1", 15_000);
  expect(state).toEqual({ phase: "failed", step: "web", error: "exited with code 7 before the preview was running\ncannot bind" });
  const setup = make({ config: { setup: "exit 2", services: [{ name: "web", open: true, command: node() }] } }).svc;
  setup.start("s1");
  expect(await setup.settled("s1", 15_000)).toEqual({ phase: "failed", step: "setup", error: "exited with code 2" });
  expect(setup.logs("s1", "web", 0).steps).toEqual(["setup"]);
}, 30_000);

test("a service exiting after ready crashes the preview and stops the others", async () => {
  const { svc: s } = make({
    config: {
      services: [
        { name: "api", command: node(), env: { EXIT_AFTER: "1500", EXIT_CODE: "3" } },
        { name: "web", open: true, command: node() },
      ],
    },
  });
  s.start("s1");
  const state = await running(s);
  const web = state.services[1]!.port;
  expect(await canConnect(web)).toBe(true);
  expect(await until(() => s.state("s1"), (v) => v?.phase === "crashed")).toEqual({ phase: "crashed", step: "api", code: 3, signal: null });
  await vi.waitFor(async () => expect(await canConnect(web)).toBe(false), { timeout: 5000 });
}, 30_000);

test("stop sends SIGTERM to the group and SIGKILL after the grace to a child that ignores it", async () => {
  const { svc: s } = make({ config: { services: [{ name: "web", open: true, command: node(), env: { IGNORE_TERM: "1" } }] } });
  s.start("s1");
  const port = (await running(s)).services[0]!.port;
  const t0 = Date.now();
  await s.stop("s1");
  expect(Date.now() - t0).toBeGreaterThanOrEqual(s.opts.killGraceMs);
  expect(await canConnect(port)).toBe(false);
  expect(s.state("s1")).toEqual({ phase: "stopped" });
}, 30_000);

test("the log ring keeps the last 2000 lines without ANSI, with a cursor and a run counter", async () => {
  const { svc: s } = make({ config: { services: [{ name: "web", open: true, command: node(), env: { RED: "1", LINES: "2100" } }] } });
  s.start("s1");
  await running(s);
  const all = await until(() => s.logs("s1", "web", 0), (l) => l.lines.at(-1)?.text === "line 2099");
  expect(all.lines).toHaveLength(2000);
  expect(all.lines[0]!.text).toBe("line 100");
  expect(all.run).toBe(1);
  expect(s.logs("s1", "web", all.next)).toEqual({ run: 1, steps: ["web"], lines: [], next: all.next });
  expect(s.logs("s1", "web", all.lines[1998]!.seq).lines.map((l) => l.text)).toEqual(["line 2099"]);

  // Starting again (restart) clears the logs: a new run, later seqs.
  s.start("s1", { restart: true });
  await running(s);
  const again = await until(() => s.logs("s1", "web", 0), (l) => l.lines.at(-1)?.text === "line 2099");
  expect(again.run).toBe(2);
  expect(again.lines[0]!.seq).toBeGreaterThan(all.next);
}, 30_000);

test("ANSI colours are stripped", async () => {
  const { svc: s } = make({ config: { services: [{ name: "web", open: true, command: node(), env: { RED: "1" } }] } });
  s.start("s1");
  await running(s);
  expect(s.logs("s1", "web", 0).lines.map((l) => l.text)).toEqual(["red"]);
}, 30_000);

test("forget stops it, deletes PREVIEW_DIR and drops the state; the sweep removes orphans only", async () => {
  const { svc: s } = make({ config: { services: [{ name: "web", open: true, command: node() }] } });
  const changes: (PreviewState | null)[] = [];
  s.changes$.subscribe((c) => changes.push(c.state));
  s.start("s1");
  const port = (await running(s)).services[0]!.port;
  expect(existsSync(join(s.opts.root, "s1"))).toBe(true);
  await s.forget("s1");
  expect(await canConnect(port)).toBe(false);
  expect(existsSync(join(s.opts.root, "s1"))).toBe(false);
  expect(s.state("s1")).toBeNull();
  expect(changes.map((c) => c?.phase ?? null)).toEqual(["starting", "starting", "running", "stopped", null]);

  mkdirSync(join(s.opts.root, "s1"), { recursive: true });
  mkdirSync(join(s.opts.root, "gone"), { recursive: true });
  writeFileSync(join(s.opts.root, "gone.sqlite"), "");
  writeFileSync(join(s.opts.root, "s1.sqlite"), "");
  await s.sweep();
  expect(existsSync(join(s.opts.root, "s1"))).toBe(true);
  expect(existsSync(join(s.opts.root, "s1.sqlite"))).toBe(true);
  expect(existsSync(join(s.opts.root, "gone"))).toBe(false);
  expect(existsSync(join(s.opts.root, "gone.sqlite"))).toBe(false);
}, 30_000);
