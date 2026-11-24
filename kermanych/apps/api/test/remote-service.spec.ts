// «Пульт»'s lifecycle, push rule and keep-awake holder (docs/specs/2026-11-24-mobile-remote-control.md,
// decisions 4, 6, 9): RemoteService over an in-memory registry, a fake supervisor and a fake
// Tailscale CLI. The remote server really listens (on 127.0.0.1, port 0); nothing reaches a
// tailnet or a push service.
import { Subject } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemotePushSubscription, RemoteState, ServerEvent, Session } from "@kermanych/core";
import type { RunResult } from "../src/device/device-proc";
import { ToolError } from "../src/device/device-proc";
import { setKeepAwake } from "../src/minion/keep-awake";
import { RegistryService } from "../src/registry/registry.service";
import { operatorAway, presence, setPresence } from "../src/remote/presence";
import { RemoteService } from "../src/remote/remote.service";
import { Tailscale, type TailscaleHost } from "../src/remote/tailscale";

const CLI = "/usr/local/bin/tailscale";
const STATUS = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "mac.tail1234.ts.net.", UserID: 1 },
  CertDomains: ["mac.tail1234.ts.net"],
  User: { "1": { LoginName: "operator@example.com" } },
});

function session(over: Partial<Session> & { id: string }): Session {
  return {
    projectId: "p1",
    name: over.id,
    task: "",
    worktreePath: "/secret",
    branch: "b",
    worktree: true,
    kind: "agent",
    status: "thinking",
    createdAt: "2026-11-24T09:00:00.000Z",
    lastActivityAt: "2026-11-24T10:00:00.000Z",
    ...over,
  } as Session;
}

type Answer = string | Error | undefined;

function make(opts: { answer?: (line: string) => Answer; cli?: boolean; platform?: NodeJS.Platform } = {}) {
  const registry = new RegistryService(":memory:");
  registry.upsertProject({ id: "p1", name: "Shop", localRepoPath: "/tmp/kmq-remote-p1" });
  const events$ = new Subject<ServerEvent>();
  const published: RemoteState[] = [];
  const rows = { current: [] as Session[] };
  const supervisor = {
    events$,
    mergedSessions: () => rows.current,
    publish: (e: ServerEvent) => void (e.type === "remote_update" && published.push(e.state)),
    sessionTranscript: async () => [],
    sendMessage: async () => {},
    answerUi: () => {},
    stopSession: async () => {},
  };
  const auth = { current: () => ({ userId: "u-1", accessToken: "t" }), onClear: () => {} };
  const calls: string[] = [];
  const answer =
    opts.answer ??
    ((line: string): Answer => {
      if (line === `${CLI} status --json`) return STATUS;
      if (line === `${CLI} serve status --json`) return "{}";
      if (line.startsWith(`${CLI} serve `)) return "";
      return undefined;
    });
  const runner = async (cmd: string, args: string[]): Promise<RunResult> => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    const a = answer(line);
    if (a instanceof Error) throw a;
    return { code: a === undefined ? 1 : 0, stdout: Buffer.from(a ?? ""), stderr: "" };
  };
  const host: TailscaleHost = {
    platform: opts.platform ?? "darwin",
    path: "/usr/local/bin",
    executable: (f) => opts.cli !== false && f === CLI,
    user: () => ({ username: "alice", uid: 1000 }),
  };
  const pushes: { endpoint: string; payload: unknown; ttl?: number; urgency?: string }[] = [];
  const sendPush = async (sub: RemotePushSubscription, payload: string, o: { TTL?: number; urgency?: string }) => {
    pushes.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), ttl: o.TTL, urgency: o.urgency });
    if (sub.endpoint.includes("gone")) throw Object.assign(new Error("gone"), { statusCode: 410 });
  };
  const service = new RemoteService(registry, supervisor as never, auth as never, { tailscale: new Tailscale(runner, host), sendPush, clientDir: null });
  services.push(service);
  return { registry, events$, published, rows, calls, pushes, service };
}

const services: RemoteService[] = [];

afterEach(async () => {
  for (const s of services.splice(0)) await s.onModuleDestroy();
  setPresence(undefined);
  setKeepAwake(undefined);
  delete process.env.KERMANYCH_PREVIEW;
});

const tick = () => new Promise((r) => setTimeout(r, 0));

async function turnOn(t: ReturnType<typeof make>): Promise<RemoteState> {
  t.registry.setRemoteSettings({ ...t.registry.getRemoteSettings(), enabled: true });
  t.service.onModuleInit();
  await t.service.settled();
  return t.service.state();
}

describe("the lifecycle (decision 6)", () => {
  it("is off by default and still shows the checks", async () => {
    const t = make();
    t.service.onModuleInit();
    await t.service.settled();
    const s = t.service.state();
    expect(s).toMatchObject({ enabled: false, phase: "off", tailscale: { installed: true, running: true, https: true, operator: true, dnsName: "mac.tail1234.ts.net" } });
    expect(t.calls.some((c) => c.includes(" serve --"))).toBe(false);
    // VAPID keys are made once.
    const keys = t.registry.getRemoteSettings().vapidPublic;
    expect(keys).toBeTruthy();
    t.service.onModuleInit();
    expect(t.registry.getRemoteSettings().vapidPublic).toBe(keys);
  });

  it("turns on: serve on our own port to the remote server, then off: the rule removed, the phones kept", async () => {
    const t = make();
    t.registry.addRemoteDevice("phone", "hash");
    const on = await turnOn(t);
    expect(on.phase).toBe("on");
    expect(on.url).toBe("https://mac.tail1234.ts.net:8443");
    const serveOn = t.calls.find((c) => c.startsWith(`${CLI} serve --bg`))!;
    expect(serveOn).toMatch(/^\/usr\/local\/bin\/tailscale serve --bg --https=8443 http:\/\/127\.0\.0\.1:(\d+)$/);
    const localPort = Number(/:(\d+)$/.exec(serveOn)![1]);
    expect(t.registry.getRemoteSettings().httpsPort).toBe(8443);
    // The remote server answers (no client built here: the 503 that says how to build it).
    expect((await fetch(`http://127.0.0.1:${localPort}/`)).status).toBe(503);
    expect(t.published.some((s) => s.phase === "on")).toBe(true);

    const off = await t.service.setEnabled(false);
    expect(off).toMatchObject({ enabled: false, phase: "off" });
    expect(off.url).toBeUndefined();
    expect(t.calls.at(-1)).toBe(`${CLI} serve --https=8443 off`);
    expect(off.devices).toHaveLength(1);
    await expect(fetch(`http://127.0.0.1:${localPort}/`)).rejects.toThrow();
  });

  it("answers `starting` at once when turned on", async () => {
    const t = make();
    const s = await t.service.setEnabled(true);
    expect(s).toMatchObject({ enabled: true, phase: "starting" });
    await t.service.settled();
    expect(t.service.state().phase).toBe("on");
  });

  it("keeps the stored port, and skips the operator's own rules", async () => {
    const t = make({
      answer: (line) => {
        if (line === `${CLI} status --json`) return STATUS;
        if (line === `${CLI} serve status --json`)
          return JSON.stringify({ TCP: { "8443": { HTTPS: true } }, Web: { "mac.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: "http://localhost:3000" } } } } });
        return line.startsWith(`${CLI} serve `) ? "" : undefined;
      },
    });
    expect((await turnOn(t)).url).toBe("https://mac.tail1234.ts.net:8444");
  });

  it("is blocked, serving nothing, while a prerequisite is missing", async () => {
    const missing = make({ cli: false });
    expect(await turnOn(missing)).toMatchObject({ phase: "blocked", tailscale: { installed: false } });
    const noHttps = make({ answer: (line) => (line.endsWith("status --json") ? JSON.stringify({ ...JSON.parse(STATUS), CertDomains: null }) : undefined) });
    expect(await turnOn(noHttps)).toMatchObject({ phase: "blocked", tailscale: { installed: true, running: true, https: false } });
    for (const t of [missing, noHttps]) expect(t.calls.some((c) => c.includes(" serve --"))).toBe(false);
  });

  it("is blocked on Linux until the user is the Tailscale operator", async () => {
    const t = make({ platform: "linux", answer: (line) => (line.endsWith("status --json") ? STATUS : line.endsWith("debug prefs") ? JSON.stringify({ OperatorUser: "bob" }) : undefined) });
    expect(await turnOn(t)).toMatchObject({ phase: "blocked", platform: "linux", tailscale: { operator: false } });
  });

  it("reports serve's failure as the error, with nothing left running", async () => {
    const consent = new ToolError("tailscale serve did not finish in 20 s", null, "", "To enable, visit:\n https://login.tailscale.com/f/serve?node=x\n");
    const t = make({
      answer: (line) => (line.endsWith("status --json") ? STATUS : line.endsWith("serve status --json") ? "{}" : line.includes("serve --bg") ? consent : undefined),
    });
    const s = await turnOn(t);
    expect(s.phase).toBe("error");
    expect(s.error).toContain("https://login.tailscale.com/f/serve?node=x");
    await expect(t.service.createPairing()).rejects.toThrow();
  });

  it("removes a leftover rule of ours at start while off, never the operator's", async () => {
    const leftover = (target: string) =>
      make({
        answer: (line) => {
          if (line.endsWith("status --json") && !line.includes("serve")) return STATUS;
          if (line.endsWith("serve status --json")) return JSON.stringify({ TCP: { "8444": { HTTPS: true } }, Web: { "mac:8444": { Handlers: { "/": { Proxy: target } } } } });
          return line.includes(" serve ") ? "" : undefined;
        },
      });
    const ours = leftover("http://127.0.0.1:61000");
    ours.registry.setRemoteSettings({ enabled: false, httpsPort: 8444 });
    ours.service.onModuleInit();
    await ours.service.settled();
    expect(ours.calls).toContain(`${CLI} serve --https=8444 off`);

    const theirs = leftover("http://localhost:3000");
    theirs.registry.setRemoteSettings({ enabled: false, httpsPort: 8444 });
    theirs.service.onModuleInit();
    await theirs.service.settled();
    expect(theirs.calls.some((c) => c.endsWith(" off"))).toBe(false);
  });

  it("never touches the Tailscale config in a preview api", async () => {
    process.env.KERMANYCH_PREVIEW = "1";
    const t = make();
    const s = await turnOn(t);
    expect(s.phase).toBe("blocked");
    expect(s.error).toContain("попередній перегляд");
    expect(t.calls.some((c) => c.includes(" serve --") || c.includes(" set "))).toBe(false);
    await expect(t.service.setOperator()).rejects.toThrow();
  });
});

describe("pairing and devices", () => {
  it("makes a pairing only while on: the link, its QR and the six digits", async () => {
    const t = make();
    await expect(t.service.createPairing()).rejects.toThrow();
    await turnOn(t);
    const p = await t.service.createPairing();
    expect(p.link).toMatch(/^https:\/\/mac\.tail1234\.ts\.net:8443\/#pair=[A-Za-z0-9_-]{43}$/);
    expect(p.short).toMatch(/^\d{6}$/);
    expect(p.qrSvg).toContain("<svg");
    expect(Date.parse(p.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("disconnects a phone", async () => {
    const t = make();
    const d = t.registry.addRemoteDevice("phone", "hash");
    expect(() => t.service.removeDevice("nope")).toThrow("device not found");
    expect(t.service.removeDevice(d.id).devices).toEqual([]);
    expect(t.published.at(-1)?.devices).toEqual([]);
  });
});

describe("presence", () => {
  it("counts unknown, a missing probe and a failing probe as away", () => {
    expect(presence()).toBe("unknown");
    expect(operatorAway()).toBe(true);
    setPresence(() => "unknown");
    expect(operatorAway()).toBe(true);
    setPresence(() => {
      throw new Error("no powerMonitor");
    });
    expect(presence()).toBe("unknown");
    setPresence(() => "present");
    expect(operatorAway()).toBe(false);
  });
});

describe("push (decision 4)", () => {
  const sub = (endpoint: string) => ({ endpoint, expirationTime: null, keys: { p256dh: "p", auth: "a" } });

  it("pushes a question or a failure of a listed session only while the operator is away", async () => {
    const t = make();
    const d = t.registry.addRemoteDevice("phone", "hash");
    t.registry.setRemoteDevicePush(d.id, sub("https://push.example/1"));
    t.rows.current = [session({ id: "a" }), session({ id: "chat", kind: "chat" })];
    await turnOn(t);

    setPresence(() => "away");
    const asks = session({ id: "a", status: "waiting_input" });
    t.rows.current = [asks, t.rows.current[1]!];
    t.events$.next({ type: "session_update", session: asks });
    expect(t.pushes).toEqual([{ endpoint: "https://push.example/1", payload: { sessionId: "a", project: "Shop", title: "a", kind: "input" }, ttl: 3600, urgency: "high" }]);
    // The same status again is no transition.
    t.events$.next({ type: "session_update", session: asks });
    expect(t.pushes).toHaveLength(1);

    // At the computer: silence.
    setPresence(() => "present");
    const fails = session({ id: "a", status: "error" });
    t.rows.current = [fails, t.rows.current[1]!];
    t.events$.next({ type: "session_update", session: fails });
    expect(t.pushes).toHaveLength(1);

    // Unknown presence counts as away.
    setPresence(() => "unknown");
    const again = session({ id: "a", status: "conflict" });
    t.events$.next({ type: "session_update", session: session({ id: "a", status: "thinking" }) });
    t.events$.next({ type: "session_update", session: again });
    expect(t.pushes.at(-1)?.payload).toMatchObject({ kind: "error" });

    // A chat is not listed: no push for it.
    const n = t.pushes.length;
    t.events$.next({ type: "session_update", session: session({ id: "chat", kind: "chat", status: "waiting_input" }) });
    expect(t.pushes).toHaveLength(n);
    // Finished work earns none either.
    t.events$.next({ type: "session_update", session: session({ id: "a", status: "done" }) });
    expect(t.pushes).toHaveLength(n);
  });

  it("sends nothing while «Пульт» is off", async () => {
    const t = make();
    const d = t.registry.addRemoteDevice("phone", "hash");
    t.registry.setRemoteDevicePush(d.id, sub("https://push.example/1"));
    t.service.onModuleInit();
    await t.service.settled();
    t.events$.next({ type: "session_update", session: session({ id: "a", status: "waiting_input" }) });
    expect(t.pushes).toEqual([]);
  });

  it("clears a subscription the push service no longer knows", async () => {
    const t = make();
    const d = t.registry.addRemoteDevice("phone", "hash");
    t.registry.setRemoteDevicePush(d.id, sub("https://push.example/gone"));
    t.rows.current = [session({ id: "a" })];
    await turnOn(t);
    t.events$.next({ type: "session_update", session: session({ id: "a", status: "waiting_input" }) });
    await tick();
    expect(t.registry.listRemoteDevices()[0]?.push).toBeUndefined();
    expect(t.service.state().devices[0]?.push).toBe(false);
  });
});

describe("keep-awake (decision 9)", () => {
  it("holds `remote` while on and a listed agent works or waits, and lets go when it settles or «Пульт» goes off", async () => {
    const hold = vi.fn();
    setKeepAwake(hold);
    const t = make();
    t.rows.current = [session({ id: "a", status: "thinking" }), session({ id: "chat", kind: "chat", status: "thinking" })];
    await turnOn(t);
    expect(hold).toHaveBeenLastCalledWith(true);

    const done = session({ id: "a", status: "done" });
    t.rows.current = [done, t.rows.current[1]!];
    t.events$.next({ type: "session_update", session: done });
    // The chat works, but a chat is not listed: nothing holds.
    expect(hold).toHaveBeenLastCalledWith(false);

    const asks = session({ id: "a", status: "waiting_input" });
    t.rows.current = [asks, t.rows.current[1]!];
    t.events$.next({ type: "session_update", session: asks });
    expect(hold).toHaveBeenLastCalledWith(true);

    await t.service.setEnabled(false);
    expect(hold).toHaveBeenLastCalledWith(false);
  });

  it("does not hold while off, however busy the agents", async () => {
    const hold = vi.fn();
    setKeepAwake(hold);
    const t = make();
    t.rows.current = [session({ id: "a", status: "tool" })];
    t.service.onModuleInit();
    await t.service.settled();
    expect(hold).not.toHaveBeenCalled();
  });
});
