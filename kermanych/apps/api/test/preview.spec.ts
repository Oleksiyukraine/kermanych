// apps/api/test/preview.spec.ts
// The live preview (docs/specs/2026-11-03-session-browser-preview.md): `.kermanych/preview.json`
// read from the session directory, ports and variables per service, ordered readiness, the
// banner fallback, the in-flight dedupe, crashes, the SIGKILL escalation and the log ring. Real
// child processes: one small node server script, steered by the env each service sets. A Mobile
// project's preview (docs/specs/2026-11-03-mobile-device-preview.md) runs against a fake
// DeviceApi: the step order, the app's readiness and exit, the device's exit and lifecycle.
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
import { ANDROID_BASE, IOS_BASE, fakeDevice, type FakeDeviceOptions } from "./fake-device";

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
// Every service a test made: some tests make two.
const made: PreviewService[] = [];

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "kermanych-preview-spec-"));
  script = join(base, "server.js");
  writeFileSync(script, SERVER);
});
afterEach(async () => {
  await Promise.all(made.splice(0).map((s) => s.onModuleDestroy()));
  setBrowserHost(undefined);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const node = () => `node ${JSON.stringify(script)}`;

type Fixture = { config?: unknown; raw?: string; kind?: Session["kind"]; platform?: Platform; finished?: boolean; device?: FakeDeviceOptions };

// One session in a fresh directory holding the given `.kermanych/preview.json`, behind a
// registry seam (the service reads only these two lists), with a fake device.
function make(f: Fixture = {}): { svc: PreviewService; dir: string; fake: ReturnType<typeof fakeDevice> } {
  const dir = mkdtempSync(join(base, "repo-"));
  if (f.config !== undefined || f.raw !== undefined) {
    mkdirSync(join(dir, ".kermanych"));
    writeFileSync(join(dir, ".kermanych", "preview.json"), f.raw ?? JSON.stringify(f.config));
  }
  const stub = {
    listSessions: () => [{ id: "s1", projectId: "p1", kind: f.kind ?? "agent", worktree: true, worktreePath: f.finished ? "" : dir }],
    listProjects: () => [{ id: "p1", localRepoPath: "/nowhere", ...(f.platform ? { platform: f.platform } : {}) }],
  };
  const root = join(base, `previews-${dir.slice(-6)}`);
  const fake = fakeDevice({ appMarker: () => join(root, "s1", "app.up"), ...f.device });
  const svc = new PreviewService(stub as unknown as RegistryService, fake.device);
  made.push(svc);
  Object.assign(svc.opts, { root, readyMs: 15_000, killGraceMs: 400, shutdownGraceMs: 400, pollMs: 50, appPollMs: 50, launchMs: 3_000, appReadyMs: 10_000 });
  return { svc, dir, fake };
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
  expect(make({ config: ok }).svc.info("s1")).toEqual({ state: null, config: { kind: "ok", services: ["web"], platforms: [] } });
  expect(() => make({ config: ok, kind: "discussion" }).svc.start("s1")).toThrow(/only agent sessions/);
  expect(() => make({ config: ok, platform: "backend" }).svc.start("s1")).toThrow(/backend project has no live preview/);
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
  const webEnv = await envOf(state.url!);
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
  const port = Number(new URL(state.url!).port);
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

// ── A Mobile project's preview (docs/specs/2026-11-03-mobile-device-preview.md) ────────────────

const APP = "com.acme.app";
const both = { ios: { app: APP }, android: { app: APP } };

function steps(changes: (PreviewState | null)[]): string[] {
  const out: string[] = [];
  for (const c of changes) {
    const at = c?.phase === "starting" ? c.step : (c?.phase ?? "null");
    if (out.at(-1) !== at) out.push(at);
  }
  return out;
}

test("the file must fit the platform: a Mobile project needs a device block, any other may not have one", () => {
  const web = { services: [{ name: "web", command: "true", open: true }] };
  expect(make({ config: web, platform: "mobile" }).svc.info("s1").config).toEqual({
    kind: "invalid",
    error: 'device: a Mobile project needs a "device" block naming its app',
  });
  const mobile = { device: both };
  for (const platform of ["web", undefined] as const)
    expect(make({ config: mobile, ...(platform ? { platform } : {}) }).svc.info("s1").config).toEqual({
      kind: "invalid",
      error: "device: works only in a project whose platform is Mobile",
    });
  const ok = make({ config: mobile, platform: "mobile" }).svc;
  expect(ok.info("s1").config).toEqual({ kind: "ok", services: [], platforms: ["ios", "android"] });
  expect(ok.platformsOf("s1")).toEqual(["ios", "android"]);
  expect(make({ config: web, platform: "mobile" }).svc.platformsOf("s1")).toEqual([]);
  expect(make({ config: mobile, platform: "backend" }).svc.platformsOf("s1")).toEqual([]);
  expect(() => make({ config: web }).svc.start("s1", { platform: "ios" })).toThrow(/only for a preview with a device/);
  expect(() => make({ config: { device: { ios: { app: APP } } }, platform: "mobile" }).svc.start("s1", { platform: "android" })).toThrow(/has no android app/);
});

test("device → setup → services → install → launch → running; the device's variables reach every step", async () => {
  const { svc: s, fake } = make({
    platform: "mobile",
    config: {
      setup: 'echo setup >> "$PREVIEW_DIR/order"; echo "setup $DEVICE_ID $DEVICE_PLATFORM ${ANDROID_SERIAL:-none}"',
      services: [{ name: "metro", command: `echo metro >> "$PREVIEW_DIR/order"; exec ${node()}`, env: { DEV: "${DEVICE_ID}" } }],
      device: { ios: { app: APP, install: 'echo install >> "$PREVIEW_DIR/order"; echo "install $DEVICE_ID $PORT_METRO"' }, android: { app: APP } },
    },
  });
  const changes: (PreviewState | null)[] = [];
  s.changes$.subscribe((c) => changes.push(c.state));
  const order = join(s.opts.root, "s1", "order");
  let atLaunch = "";
  fake.device.launch.mockImplementation(async (id: string, app: string) => {
    atLaunch = readFileSync(order, "utf8");
    fake.setApp(id, app, true);
  });
  expect(s.start("s1")).toEqual({ phase: "starting", step: "device", services: [] });
  const state = await running(s);
  const runtime = { platform: "ios", serial: "SIM-UDID-1", name: "iPhone 16", screen: { width: 393, height: 852 } };
  const port = state.services[0]!.port;
  expect(state).toEqual({ phase: "running", url: null, services: [{ name: "metro", port }], device: runtime, app: "running" });
  expect(steps(changes)).toEqual(["device", "setup", "metro", "install", "device", "running"]);
  // The app was launched only after `install` had exited, and the screen showed from `setup` on.
  expect(atLaunch).toBe("setup\nmetro\ninstall\n");
  expect(fake.device.ensure).toHaveBeenCalledWith("s1", IOS_BASE, expect.any(Function), expect.any(AbortSignal));
  expect(fake.device.launch).toHaveBeenCalledWith("s1", APP);
  expect(changes.find((c) => c?.phase === "starting" && c.step === "setup")).toMatchObject({ device: runtime });
  expect(s.tail("s1", "setup", 10)).toEqual(["setup SIM-UDID-1 ios none"]);
  expect(s.tail("s1", "install", 10)).toEqual([`install SIM-UDID-1 ${port}`]);
  expect(await envOf(`http://localhost:${port}`)).toMatchObject({ DEVICE_ID: "SIM-UDID-1", DEVICE_PLATFORM: "ios", DEV: "SIM-UDID-1" });
  expect(s.steps("s1")).toEqual(["device", "setup", "metro", "install"]);
  // The app's own log follows into step `device`, after the device's boot lines.
  fake.appLog("s1", "\u001b[32mflutter: hello\u001b[0m");
  expect(s.tail("s1", "device", 10)).toEqual(["device: iPhone 16 (ios, iOS 18.3)", "booting iPhone 16", `launching ${APP}`, "flutter: hello"]);
  expect(fake.device.launch).toHaveBeenCalledTimes(1);
  expect(fake.device.shutdown).not.toHaveBeenCalled();
}, 30_000);

test("a device service is ready once the app runs, gets ANDROID_SERIAL, and Kermanych does not launch the app itself", async () => {
  const { svc: s, fake } = make({
    platform: "mobile",
    config: {
      services: [
        {
          name: "app",
          device: true,
          command: 'sleep 0.3; echo "$DEVICE_ID $DEVICE_PLATFORM $ANDROID_SERIAL" > "$PREVIEW_DIR/env"; touch "$PREVIEW_DIR/app.up"; exec sleep 30',
        },
      ],
      device: { android: { app: "grano.app.com" } },
    },
  });
  s.start("s1");
  const state = await running(s);
  expect(state).toMatchObject({ url: null, app: "running", device: { platform: "android", serial: "emulator-5584" } });
  expect(readFileSync(join(s.opts.root, "s1", "env"), "utf8")).toBe("emulator-5584 android emulator-5584\n");
  expect(fake.device.ensure).toHaveBeenCalledWith("s1", ANDROID_BASE, expect.any(Function), expect.any(AbortSignal));
  expect(fake.device.launch).not.toHaveBeenCalled();
}, 30_000);

test("a device service that exits before the app runs fails the start, and the device shuts down", async () => {
  const { svc: s, fake } = make({
    platform: "mobile",
    config: { services: [{ name: "app", device: true, command: 'echo "no devices found"; exit 4' }], device: { ios: { app: APP } } },
  });
  s.start("s1");
  expect(await s.settled("s1", 15_000)).toEqual({ phase: "failed", step: "app", error: "exited with code 4 before the preview was running\nno devices found" });
  await vi.waitFor(() => expect(fake.calls).toEqual(["ensure IOS-BASE-UDID", `terminate ${APP}`, "shutdown"]));
}, 30_000);

test("an install that fails stops the start at `install` and shuts the device down", async () => {
  const { svc: s, fake } = make({ platform: "mobile", config: { device: { ios: { app: APP, install: 'echo "build failed" >&2; exit 65' } } } });
  s.start("s1");
  expect(await s.settled("s1", 15_000)).toEqual({ phase: "failed", step: "install", error: "exited with code 65\nbuild failed" });
  await vi.waitFor(() => expect(fake.calls).toEqual(["ensure IOS-BASE-UDID", `terminate ${APP}`, "shutdown"]));
  expect(fake.device.launch).not.toHaveBeenCalled();
}, 30_000);

test("the app exiting is a state of its own, not a crash; it comes back when relaunched", async () => {
  const { svc: s, fake } = make({ platform: "mobile", config: { device: { ios: { app: APP } } } });
  s.start("s1");
  await running(s);
  fake.setApp("s1", APP, false);
  expect(await until(() => s.state("s1"), (v) => v?.phase === "running" && v.app === "exited")).toMatchObject({ phase: "running", device: { serial: "SIM-UDID-1" } });
  expect(s.tail("s1", "device", 1)).toEqual([`${APP} exited`]);
  expect(fake.calls).not.toContain("shutdown");
  // The operator relaunched it from the device's home screen.
  fake.setApp("s1", APP, true);
  await until(() => s.state("s1"), (v) => v?.phase === "running" && v.app === "running");
  expect(s.tail("s1", "device", 1)).toEqual([`${APP} is running again`]);

  // «Запустити застосунок» / device_app.
  expect(await s.app("s1", "terminate")).toMatchObject({ phase: "running", app: "exited" });
  expect(await s.app("s1", "launch")).toMatchObject({ phase: "running", app: "running" });
  expect(fake.calls.slice(-2)).toEqual([`terminate ${APP}`, `launch ${APP}`]);
  await s.stop("s1");
  await expect(s.app("s1", "launch")).rejects.toThrow(/not running/);
}, 30_000);

test("the device exiting crashes a running preview at `device` and stops the services; while starting it fails the start", async () => {
  const { svc: s, fake } = make({ platform: "mobile", config: { services: [{ name: "api", command: node() }], device: { ios: { app: APP } } } });
  s.start("s1");
  const port = (await running(s)).services[0]!.port;
  fake.device.exits$.next({ sessionId: "s1", reason: "the simulator quit" });
  expect(s.state("s1")).toEqual({ phase: "crashed", step: "device", code: null, signal: null });
  expect(s.tail("s1", "device", 1)).toEqual(["the device exited: the simulator quit"]);
  await vi.waitFor(async () => expect(await canConnect(port)).toBe(false), { timeout: 5000 });
  // Another session's device is none of this preview's business.
  fake.device.exits$.next({ sessionId: "other", reason: "x" });

  const starting = make({ platform: "mobile", config: { setup: "sleep 5", device: { ios: { app: APP } } } });
  starting.svc.start("s1");
  await until(() => starting.svc.state("s1"), (v) => v?.phase === "starting" && v.step === "setup");
  starting.fake.device.exits$.next({ sessionId: "s1", reason: "the emulator was killed" });
  expect(await starting.svc.settled("s1", 5_000)).toMatchObject({ phase: "failed", step: "device", error: expect.stringMatching(/^the device exited: the emulator was killed/) });
}, 30_000);

test("↻ keeps the device running, ◼ shuts it down, and finish and delete remove the clone even with no run", async () => {
  const { svc: s, fake } = make({ platform: "mobile", config: { setup: 'echo x >> "$PREVIEW_DIR/runs"', device: { ios: { app: APP } } } });
  s.start("s1");
  await running(s);
  s.start("s1", { restart: true });
  await until(() => s.state("s1"), (v) => v?.phase === "starting");
  await running(s);
  expect(readFileSync(join(s.opts.root, "s1", "runs"), "utf8")).toBe("x\nx\n");
  // Each run stops the app the previous one left on the device before building it again.
  const run = ["ensure IOS-BASE-UDID", `terminate ${APP}`, `launch ${APP}`];
  expect(fake.calls).toEqual([...run, ...run]);
  await s.stop("s1");
  expect(s.state("s1")).toEqual({ phase: "stopped" });
  expect(fake.calls.at(-1)).toBe("shutdown");
  await s.retire("s1");
  expect(fake.calls.slice(-2)).toEqual(["shutdown", "remove"]);
  expect(fake.device.remove).toHaveBeenCalledWith("s1");

  // A clone from an earlier api run: nothing runs here, and it still goes.
  const fresh = make({ platform: "mobile", config: { device: { ios: { app: APP } } } });
  await fresh.svc.forget("s1");
  expect(fresh.fake.calls).toEqual(["remove"]);
  const web = make({ config: { services: [{ name: "web", command: "true", open: true }] } });
  await web.svc.retire("s1");
  expect(web.fake.calls).toEqual(["remove"]);
}, 30_000);

// docs/specs/2026-11-04-tester-mobile-device.md, decision 1: a «Тестувальник» run's clean start.
test("a clean start clears the app's data after the boot and before setup; a failed clear fails the start at `device`", async () => {
  const { svc: s, fake } = make({ platform: "mobile", config: { setup: 'touch "$PREVIEW_DIR/setup-ran"', device: { ios: { app: APP } } } });
  let setupBeforeClear: boolean | undefined;
  fake.device.clearApp.mockImplementationOnce(async (_id: string, app: string) => {
    setupBeforeClear = existsSync(join(s.opts.root, "s1", "setup-ran"));
    fake.calls.push(`clear ${app}`);
  });
  s.start("s1", { clean: true });
  await running(s);
  expect(setupBeforeClear).toBe(false);
  expect(fake.calls).toEqual(["ensure IOS-BASE-UDID", `terminate ${APP}`, `clear ${APP}`, `launch ${APP}`]);
  expect(s.tail("s1", "device", 10).some((l) => l.startsWith(`cleared the data of ${APP} in `))).toBe(true);

  // ↻ without `clean` keeps the data.
  s.start("s1", { restart: true });
  await until(() => s.state("s1"), (v) => v?.phase === "starting");
  await running(s);
  expect(fake.calls.filter((c) => c.startsWith("clear"))).toHaveLength(1);

  fake.device.clearApp.mockRejectedValueOnce(new Error("simctl uninstall failed (exit 1)"));
  s.start("s1", { restart: true, clean: true });
  await until(() => s.state("s1"), (v) => v?.phase === "starting");
  expect(await s.settled("s1", 15_000)).toMatchObject({ phase: "failed", step: "device", error: expect.stringMatching(/^could not clear the data of .*: simctl uninstall failed/) });
}, 30_000);

test("an explicit platform or base picks the device, becomes the project's choice and switches a running preview", async () => {
  const { svc: s, fake } = make({ platform: "mobile", config: { device: both } });
  s.start("s1", { platform: "android" });
  expect((await running(s)).device).toMatchObject({ platform: "android", name: "Pixel 8" });
  expect(fake.device.setChoice).toHaveBeenLastCalledWith("p1", { platform: "android" });
  // The same platform again is the running state; another one restarts there, keeping no
  // shutdown in between (the re-clone is ensure's).
  expect(s.start("s1", { platform: "android" })).toBe(s.state("s1"));
  s.start("s1", { platform: "ios" });
  await until(() => s.state("s1"), (v) => v?.phase === "running" && v.device?.platform === "ios");
  expect(fake.calls).toEqual(["ensure Pixel_8", `terminate ${APP}`, `launch ${APP}`, "ensure IOS-BASE-UDID", `terminate ${APP}`, `launch ${APP}`]);
  expect(s.logs("s1", "device", 0).run).toBe(2);

  s.start("s1", { base: "Pixel_8" });
  await until(() => s.state("s1"), (v) => v?.phase === "running" && v.device?.platform === "android");
  expect(fake.device.setChoice).toHaveBeenLastCalledWith("p1", { platform: "android", android: "Pixel_8" });
  // Without an explicit pick the session keeps its clone.
  s.start("s1", { restart: true });
  await until(() => s.state("s1"), (v) => v?.phase === "starting");
  expect((await running(s)).device?.platform).toBe("android");

  s.start("s1", { base: "Galaxy_Fold" });
  expect(await s.settled("s1", 5_000)).toMatchObject({ phase: "failed", step: "device", error: expect.stringMatching(/^no base device Galaxy_Fold on this machine/) });
}, 30_000);

test("naming the session's own device keeps another session's choice, and works after its base was deleted", async () => {
  const { svc: s, fake } = make({ platform: "mobile", config: { device: both } });
  // An earlier run cloned an AVD that has since been deleted from this machine.
  fake.setClone("s1", { platform: "android", base: "Old_AVD", baseName: "Old phone", id: "kermanych-s1" });
  // Session B made iOS the project's default meanwhile.
  fake.device.setChoice("p1", { platform: "ios" });
  fake.device.setChoice.mockClear();

  // ▶ in the row names the clone's own platform and base.
  s.start("s1", { platform: "android", base: "Old_AVD" });
  expect((await running(s)).device).toMatchObject({ platform: "android", name: "Old phone" });
  expect(fake.device.ensure).toHaveBeenCalledWith("s1", { platform: "android", id: "Old_AVD", name: "Old phone", os: "" }, expect.any(Function), expect.any(AbortSignal));
  expect(fake.device.setChoice).not.toHaveBeenCalled();
  // The platform alone resolves to the clone too, and is no new choice either.
  s.start("s1", { platform: "android", restart: true });
  await until(() => s.state("s1"), (v) => v?.phase === "starting");
  expect((await running(s)).device?.name).toBe("Old phone");
  expect(fake.device.setChoice).not.toHaveBeenCalled();
  expect(fake.device.choice("p1")).toEqual({ platform: "ios" });

  // Another base is a new choice; a deleted base that is not the clone's is refused.
  s.start("s1", { base: "Pixel_8" });
  await until(() => s.state("s1"), (v) => v?.phase === "running" && v.device?.name === "Pixel 8");
  expect(fake.device.setChoice).toHaveBeenLastCalledWith("p1", { platform: "android", android: "Pixel_8" });
  s.start("s1", { base: "Old_AVD" });
  expect(await s.settled("s1", 5_000)).toMatchObject({ phase: "failed", step: "device", error: expect.stringMatching(/^no base device Old_AVD on this machine/) });
}, 30_000);

test("↻ stops the previous run's app first, so a device service is ready only once the new build runs", async () => {
  const { svc: s, fake } = make({
    platform: "mobile",
    config: { services: [{ name: "app", device: true, command: 'sleep 0.6; touch "$PREVIEW_DIR/app.up"; exec sleep 30' }], device: { ios: { app: APP } } },
  });
  s.start("s1");
  await running(s);
  const marker = join(s.opts.root, "s1", "app.up");
  expect(existsSync(marker)).toBe(true);
  const t0 = Date.now();
  s.start("s1", { restart: true });
  await until(() => s.state("s1"), (v) => v?.phase === "starting");
  await running(s);
  // The old app was still up when the restart began; readiness waited for the new one.
  expect(Date.now() - t0).toBeGreaterThanOrEqual(600);
  expect(fake.calls).toEqual(["ensure IOS-BASE-UDID", `terminate ${APP}`, "ensure IOS-BASE-UDID", `terminate ${APP}`]);
}, 30_000);

test("no device to run on fails at `device` with what is missing", async () => {
  const { svc: s, fake } = make({
    platform: "mobile",
    config: { device: { ios: { app: APP } } },
    device: { tools: { ios: { ok: false, reason: "Xcode не знайдено: встановіть Xcode з App Store" }, android: { ok: true } } },
  });
  s.start("s1");
  expect(await s.settled("s1", 5_000)).toEqual({
    phase: "failed",
    step: "device",
    error: "no device to run the app on (ios: Xcode не знайдено: встановіть Xcode з App Store)",
  });
  expect(fake.device.ensure).not.toHaveBeenCalled();
});

test("a platform switch stops only the previews whose kind no longer fits", async () => {
  const mobile = make({ platform: "mobile", config: { device: { ios: { app: APP } } } });
  mobile.svc.start("s1");
  await running(mobile.svc);
  await mobile.svc.stopUnfit("p1", "mobile");
  expect(mobile.svc.state("s1")?.phase).toBe("running");
  await mobile.svc.stopUnfit("p1", "web");
  expect(mobile.svc.state("s1")).toEqual({ phase: "stopped" });
  expect(mobile.fake.calls.at(-1)).toBe("shutdown");

  const web = make({ config: { services: [{ name: "web", open: true, command: node() }] } });
  web.svc.start("s1");
  await running(web.svc);
  await web.svc.stopUnfit("p1", undefined);
  await web.svc.stopUnfit("p2", "mobile");
  expect(web.svc.state("s1")?.phase).toBe("running");
  await web.svc.stopUnfit("p1", "mobile");
  expect(web.svc.state("s1")).toEqual({ phase: "stopped" });
  expect(web.fake.device.shutdown).not.toHaveBeenCalled();
}, 30_000);
