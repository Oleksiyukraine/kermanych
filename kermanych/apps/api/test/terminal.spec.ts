import "reflect-metadata";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { io, type Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TerminalAttachReply, TerminalInfo, TerminalOpenReply } from "@kermanych/core";
import { AuthService } from "../src/auth/auth.service";
import { RegistryService } from "../src/registry/registry.service";
import { appendReplay, TerminalService } from "../src/terminal/terminal.service";
import { TerminalGateway } from "../src/ws/terminal.gateway";

// esbuild (vitest's transformer) emits no design:paramtypes, so declare the gateway's
// constructor deps by hand for Nest to inject the instances below.
Reflect.defineMetadata("design:paramtypes", [TerminalService, AuthService], TerminalGateway);

const TOKEN = "local-session-token";

describe("the /terminal namespace", () => {
  let app: INestApplication;
  let base: string;
  let checkout: string;
  let service: TerminalService;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    // A plain POSIX login shell: the operator's own profile has no business in a test.
    vi.stubEnv("SHELL", "/bin/sh");
    // realpath: macOS tmpdir is a symlink (/var → /private/var) and the shell reports the
    // resolved directory.
    checkout = realpathSync(mkdtempSync(join(tmpdir(), "terminal-")));
    const registry = new RegistryService(":memory:");
    registry.upsertProject({ id: "bound", name: "Bound", localRepoPath: checkout });
    registry.upsertProject({ id: "unbound", name: "Unbound" });
    registry.upsertProject({ id: "gone", name: "Gone", localRepoPath: join(checkout, "missing") });
    registry.setAuthSession({ userId: "u-1", accessToken: TOKEN });
    service = new TerminalService(registry);

    @Module({
      providers: [
        TerminalGateway,
        { provide: TerminalService, useValue: service },
        { provide: AuthService, useValue: new AuthService(registry) },
      ],
    })
    class TerminalModule {}

    app = await NestFactory.create(TerminalModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const addr = app.getHttpServer().address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterEach(() => {
    for (const s of sockets.splice(0)) s.disconnect();
  });

  afterAll(async () => {
    await app?.close();
    rmSync(checkout, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function socket(token: string | undefined): Socket {
    const s = io(`${base}/terminal`, {
      auth: token === undefined ? {} : { token },
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    sockets.push(s);
    return s;
  }

  function connected(s: Socket): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    s.once("connect", () => resolve());
    s.once("connect_error", reject);
    return promise;
  }

  function ask<T>(s: Socket, event: string, body?: unknown): Promise<T> {
    return s.timeout(5000).emitWithAck(event, body) as Promise<T>;
  }

  // Resolves with everything a terminal printed once `marker` has appeared in it.
  function output(s: Socket, id: string, marker: string): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    let seen = "";
    const timer = setTimeout(() => reject(new Error(`no «${marker}» in: ${JSON.stringify(seen)}`)), 10_000);
    s.on("data", (m: { id: string; data: string }) => {
      if (m.id !== id) return;
      seen += m.data;
      if (seen.includes(marker)) {
        clearTimeout(timer);
        resolve(seen);
      }
    });
    return promise;
  }

  async function openTerminal(s: Socket, projectId = "bound"): Promise<TerminalInfo> {
    const reply = await ask<TerminalOpenReply>(s, "open", { projectId, cols: 100, rows: 30 });
    if ("error" in reply) throw new Error(reply.message);
    return reply.terminal;
  }

  it("refuses a handshake without the local session's bearer", async () => {
    await expect(connected(socket(undefined))).rejects.toThrow("unauthorized");
    await expect(connected(socket("someone-elses-token"))).rejects.toThrow("unauthorized");
  });

  it("starts the shell in the project's checkout and streams it to the attached socket", async () => {
    const s = socket(TOKEN);
    await connected(s);
    const t = await openTerminal(s);
    expect(t).toMatchObject({ projectId: "bound", cwd: checkout, shell: "sh" });

    const attached = await ask<TerminalAttachReply>(s, "attach", { id: t.id });
    expect("terminal" in attached && attached.terminal.id).toBe(t.id);
    const seen = output(s, t.id, `CWD=${checkout}`);
    s.emit("input", { id: t.id, data: 'printf "CWD=%s\\n" "$(pwd -P)"\r' });
    await seen;
    const exited = new Promise((resolve) => s.once("exit", resolve));
    s.emit("kill", { id: t.id });
    await exited;
  });

  it("keeps the shell across sockets: a new socket gets the replay, a bystander no stream", async () => {
    const first = socket(TOKEN);
    await connected(first);
    const t = await openTerminal(first);
    await ask(first, "attach", { id: t.id });
    const printed = output(first, t.id, "SURVIVED-42");
    first.emit("input", { id: t.id, data: "echo SURVIVED-$((40+2))\r" });
    await printed;
    first.disconnect();

    const second = socket(TOKEN);
    const bystander = socket(TOKEN);
    await Promise.all([connected(second), connected(bystander)]);
    expect((await ask<TerminalInfo[]>(second, "list")).map((x) => x.id)).toContain(t.id);

    const reply = await ask<TerminalAttachReply>(second, "attach", { id: t.id });
    expect("replay" in reply && reply.replay).toContain("SURVIVED-42");

    const leaked: string[] = [];
    bystander.on("data", (m: { data: string }) => leaked.push(m.data));
    const live = output(second, t.id, "LIVE-7");
    second.emit("input", { id: t.id, data: "echo LIVE-$((3+4))\r" });
    await live;
    expect(leaked).toEqual([]);

    // Kill reaches every socket as `exit`, attached or not, and the terminal leaves the list.
    const exited = new Promise<{ id: string }>((resolve) => bystander.once("exit", resolve));
    second.emit("kill", { id: t.id });
    expect((await exited).id).toBe(t.id);
    expect((await ask<TerminalInfo[]>(second, "list")).map((x) => x.id)).not.toContain(t.id);
  });

  it("the shell exiting on its own ends the terminal", async () => {
    const s = socket(TOKEN);
    await connected(s);
    const t = await openTerminal(s);
    await ask(s, "attach", { id: t.id });
    const exited = new Promise<{ id: string; exitCode: number }>((resolve) => s.once("exit", resolve));
    s.emit("input", { id: t.id, data: "exit 3\r" });
    expect(await exited).toEqual({ id: t.id, exitCode: 3 });
    expect(await ask(s, "attach", { id: t.id })).toMatchObject({ error: "terminal_not_found" });
  });

  it("refuses an unbound project, a checkout gone from disk and an unknown project", async () => {
    const s = socket(TOKEN);
    await connected(s);
    expect(await ask(s, "open", { projectId: "unbound", cols: 80, rows: 24 })).toMatchObject({ error: "project_not_bound" });
    expect(await ask(s, "open", { projectId: "gone", cols: 80, rows: 24 })).toMatchObject({ error: "cwd_missing" });
    expect(await ask(s, "open", { projectId: "nope", cols: 80, rows: 24 })).toMatchObject({ error: "project_not_found" });
    expect(service.list()).toEqual([]);
  });

  it("runs a native session's program through the login shell with its argv intact", async () => {
    const { promise, resolve } = Promise.withResolvers<{ out: string; exitCode: number }>();
    let out = "";
    let id = "";
    const sub = service.events$.subscribe((e) => {
      if (e.type === "data" && e.id === id) out += e.data;
      if (e.type === "exit" && e.id === id) resolve({ out, exitCode: e.exitCode });
    });
    const info = service.openSession({
      sessionId: "s-1",
      projectId: "bound",
      cwd: checkout,
      file: "/usr/bin/printf",
      args: ["<%s>|<%s>|<%s>\\n", "two words", `say "hi" it's $HOME`, "-- --flag"],
      env: { KERMANYCH_NATIVE_URL: "http://127.0.0.1:1/api/native/s-1" },
    });
    id = info.id;
    expect(info).toMatchObject({ sessionId: "s-1", projectId: "bound", cwd: checkout, shell: "printf" });
    const { out: printed, exitCode } = await promise;
    sub.unsubscribe();
    expect(exitCode).toBe(0);
    expect(printed).toContain(`<two words>|<say "hi" it's $HOME>|<-- --flag>`);
    expect(service.list().some((t) => t.id === info.id)).toBe(false);
  });
});

describe("appendReplay", () => {
  it("keeps everything under the bound", () => {
    expect(appendReplay("ab", "cd", 10)).toBe("abcd");
  });

  it("drops the oldest output past the bound, starting at a line when one is near", () => {
    const kept = appendReplay("old line\nnewer line\n", "tail", 16);
    expect(kept).toBe("newer line\ntail");
  });

  it("cuts mid-line when no line start is within reach", () => {
    const long = "x".repeat(10_000);
    expect(appendReplay(long, "y", 5_000)).toBe(`${"x".repeat(4_999)}y`);
  });
});
