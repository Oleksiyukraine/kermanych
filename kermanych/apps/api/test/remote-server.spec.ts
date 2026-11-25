// «Пульт»'s phone server (docs/specs/2026-11-24-mobile-remote-control.md → Whitelist, Pairing and
// devices): a real RemoteServer on 127.0.0.1 and port 0, over fakes of the supervisor and the
// sign-in. Every request goes through HTTP or socket.io exactly as the phone's would behind
// `tailscale serve`.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { io, type Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REMOTE_API_PREFIX, REMOTE_KEY_HEADER, REMOTE_SOCKET_PATH, type RemoteEvent, type Session, type TranscriptEntry } from "@kermanych/core";
import { CodedError } from "../src/management/coded-error";
import { RegistryService } from "../src/registry/registry.service";
import { hashKey, Pairings } from "../src/remote/pairing";
import { RemoteFeed } from "../src/remote/remote-feed";
import { RemotePhone } from "../src/remote/remote-phone";
import { RemoteServer } from "../src/remote/remote-server";

const LOGIN = "operator@example.com";

function session(over: Partial<Session> & { id: string }): Session {
  return {
    projectId: "p1",
    name: over.id,
    task: "",
    worktreePath: "/Users/operator/secret",
    branch: "feature/x",
    worktree: true,
    kind: "agent",
    status: "thinking",
    createdAt: "2026-11-24T09:00:00.000Z",
    lastActivityAt: "2026-11-24T10:00:00.000Z",
    ...over,
  } as Session;
}

describe("the remote server", () => {
  let registry: RegistryService;
  let server: RemoteServer;
  let base: string;
  let clientDir: string;
  let signedIn = true;
  let sessions: Session[] = [];
  let history: TranscriptEntry[] = [];
  const calls: string[] = [];
  const changed: string[][] = [];
  const pairings = new Pairings();
  const sockets: Socket[] = [];

  beforeAll(async () => {
    clientDir = mkdtempSync(join(tmpdir(), "kmq-remote-client-"));
    writeFileSync(join(clientDir, "index.html"), "<!doctype html><title>Пульт</title>");
    writeFileSync(join(clientDir, "sw.js"), "self.addEventListener('push', () => {});");
    writeFileSync(join(clientDir, "manifest.webmanifest"), "{}");
    mkdirSync(join(clientDir, "assets"));
    writeFileSync(join(clientDir, "assets", "app-1234.js"), "console.log(1)");
    writeFileSync(join(tmpdir(), "kmq-remote-outside.txt"), "outside");

    registry = new RegistryService(":memory:");
    registry.upsertProject({ id: "p1", name: "Shop", localRepoPath: "/tmp/kmq-remote-p1" });
    const supervisor = {
      mergedSessions: () => sessions,
      sessionTranscript: async () => history,
      sendMessage: async (id: string, text: string, mode: string, images?: unknown[]) => {
        calls.push(`message ${id} ${mode} ${text} ${images?.length ?? 0}`);
        if (id === "native-busy") throw new CodedError("native_busy", "Агент зараз працює");
      },
      answerUi: (id: string, res: unknown) => void calls.push(`answer ${id} ${JSON.stringify(res)}`),
      stopSession: async (id: string) => void calls.push(`stop ${id}`),
    };
    const feed = new RemoteFeed({ sessions: () => sessions, projects: () => registry.listProjects() });
    const phone = new RemotePhone({
      registry,
      supervisor: supervisor as never,
      auth: { current: () => (signedIn ? { userId: "u-1", accessToken: "t" } : undefined) } as never,
      feed,
      pairings,
      login: () => LOGIN,
      host: () => "mac.tail1234.ts.net",
      vapidPublicKey: () => "BPUBLIC",
      changed: (removed) => void changed.push(removed),
    });
    server = new RemoteServer(phone, { clientDir });
    base = `http://127.0.0.1:${await server.start()}`;
  });

  beforeEach(() => {
    signedIn = true;
    history = [];
    calls.length = 0;
    changed.length = 0;
    sessions = [
      session({ id: "s-1", status: "waiting_input", pendingUiRequest: { type: "extension_ui_request", id: "q-1", method: "confirm", title: "Go?" } }),
      session({ id: "native-1", native: true, status: "waiting_input", pendingUiRequest: { type: "extension_ui_request", id: "q-2", method: "confirm" } }),
      session({ id: "native-busy", native: true, status: "thinking" }),
      session({ id: "chat-1", kind: "chat" }),
      session({ id: "old", archived: true, status: "done" }),
      session({ id: "card", kind: "task", status: "backlog" }),
    ];
  });

  afterEach(() => {
    for (const s of sockets.splice(0)) s.disconnect();
  });

  afterAll(async () => {
    await server.stop();
    rmSync(clientDir, { recursive: true, force: true });
    rmSync(join(tmpdir(), "kmq-remote-outside.txt"), { force: true });
  });

  // A paired device, straight into the registry the way pairing leaves it.
  function device(key = `key-${Math.random()}`, lastSeenAt = new Date().toISOString()): { key: string; id: string } {
    const d = registry.addRemoteDevice("Test phone", hashKey(key), lastSeenAt);
    return { key, id: d.id };
  }

  function call(path: string, init: { method?: string; key?: string; login?: string; body?: unknown } = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (init.key) headers[REMOTE_KEY_HEADER] = init.key;
    if (init.login) headers["tailscale-user-login"] = init.login;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    return fetch(`${base}${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  }

  describe("static client", () => {
    it("serves the client with its MIME types, caching and security headers", async () => {
      const index = await call("/");
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(index.headers.get("cache-control")).toBe("no-cache");
      expect(index.headers.get("x-content-type-options")).toBe("nosniff");
      expect(index.headers.get("referrer-policy")).toBe("no-referrer");
      expect(index.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(index.headers.get("access-control-allow-origin")).toBeNull();
      expect(await index.text()).toContain("Пульт");

      const sw = await call("/sw.js");
      expect(sw.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(sw.headers.get("cache-control")).toBe("no-cache");
      expect((await call("/manifest.webmanifest")).headers.get("content-type")).toBe("application/manifest+json; charset=utf-8");
      expect((await call("/assets/app-1234.js")).headers.get("cache-control")).toContain("immutable");
    });

    it("falls back to index.html for app routes, but not for missing assets or paths outside the client", async () => {
      expect(await (await call("/sessions/s-1")).text()).toContain("Пульт");
      expect((await call("/assets/missing.js")).status).toBe(404);
      expect((await call("/../kmq-remote-outside.txt")).status).not.toBe(200);
      // An encoded slash survives the client's URL normalisation; the server still stays inside.
      expect((await call("/..%2fkmq-remote-outside.txt")).status).toBe(404);
    });

    it("answers 503 with how to build the client when it is missing", async () => {
      const bare = new RemoteServer({} as never, { clientDir: undefined });
      const port = await bare.start();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        expect(res.status).toBe(503);
        expect(await res.text()).toContain("pnpm --filter @kermanych/remote build");
      } finally {
        await bare.stop();
      }
    });
  });

  describe("the whitelist", () => {
    it("lists only the tracked sessions, projected for the phone", async () => {
      const { key } = device();
      const res = await call(`${REMOTE_API_PREFIX}/sessions`, { key });
      expect(res.status).toBe(200);
      const list = (await res.json()) as { projects: unknown[]; sessions: Record<string, unknown>[] };
      expect(list.sessions.map((s) => s.id).sort()).toEqual(["native-1", "native-busy", "s-1"]);
      expect(list.projects).toEqual([{ id: "p1", name: "Shop" }]);
      for (const s of list.sessions) {
        expect(s).not.toHaveProperty("worktreePath");
        expect(s).not.toHaveProperty("branch");
      }
      // A native agent's question is answered on the computer: the phone does not get it.
      expect(list.sessions.find((s) => s.id === "native-1")).not.toHaveProperty("pendingUiRequest");
    });

    it("refuses every other path, the main api's included, even with a valid key", async () => {
      const { key } = device();
      for (const [method, path] of [
        ["GET", `${REMOTE_API_PREFIX}/projects`],
        ["GET", `${REMOTE_API_PREFIX}/sessions/s-1/diff`],
        ["POST", `${REMOTE_API_PREFIX}/sessions/s-1/merge`],
        ["DELETE", `${REMOTE_API_PREFIX}/sessions/s-1`],
        ["GET", `${REMOTE_API_PREFIX}/fs/list`],
        ["GET", "/remote/anything"],
        ["POST", "/api/sessions"],
      ] as const) {
        const res = await call(path, { method, key });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
      // A GET outside /remote/ is the client page, never data of the main api.
      const page = await call("/api/sessions", { key });
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    });

    it("answers 404 for any action on a session that is not listed", async () => {
      const { key } = device();
      for (const id of ["chat-1", "old", "card", "nope"]) {
        expect((await call(`${REMOTE_API_PREFIX}/sessions/${id}/transcript`, { key })).status).toBe(404);
        expect((await call(`${REMOTE_API_PREFIX}/sessions/${id}/stop`, { method: "POST", key })).status).toBe(404);
        expect((await call(`${REMOTE_API_PREFIX}/sessions/${id}/message`, { method: "POST", key, body: { text: "hi" } })).status).toBe(404);
      }
      expect(calls).toEqual([]);
    });

    it("sends a message in the composer's mode and refuses commands", async () => {
      const { key } = device();
      const msg = (body: unknown) => call(`${REMOTE_API_PREFIX}/sessions/s-1/message`, { method: "POST", key, body });
      expect((await msg({ text: "first" })).status).toBe(200);
      history = [{ kind: "user_text", id: "u", at: 1, text: "first" }];
      expect((await msg({ text: "more", images: [{ data: "aGk=", mimeType: "image/jpeg" }] })).status).toBe(200);
      expect(calls).toEqual(["message s-1 prompt first 0", "message s-1 steer more 1"]);

      const command = await msg({ text: "  /minion go" });
      expect(command.status).toBe(400);
      expect(await command.json()).toMatchObject({ code: "bad_request" });
      expect((await msg({ text: "" })).status).toBe(400);
      expect((await msg({ text: "x", images: [{ data: "x", mimeType: "text/html" }] })).status).toBe(400);
      expect(calls).toHaveLength(2);
    });

    it("passes the computer's native_busy refusal through", async () => {
      const { key } = device();
      const res = await call(`${REMOTE_API_PREFIX}/sessions/native-busy/message`, { method: "POST", key, body: { text: "hi" } });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: "native_busy", message: "Агент зараз працює" });
    });

    it("answers the open question of a managed agent, refuses a native one's", async () => {
      const { key } = device();
      const res = { type: "extension_ui_response", id: "q-1", confirmed: true, extra: "dropped" };
      expect((await call(`${REMOTE_API_PREFIX}/sessions/s-1/answer`, { method: "POST", key, body: { res } })).status).toBe(200);
      expect(calls).toEqual([`answer s-1 ${JSON.stringify({ type: "extension_ui_response", id: "q-1", confirmed: true })}`]);

      const stale = await call(`${REMOTE_API_PREFIX}/sessions/s-1/answer`, { method: "POST", key, body: { res: { ...res, id: "q-old" } } });
      expect(stale.status).toBe(400);
      const native = await call(`${REMOTE_API_PREFIX}/sessions/native-1/answer`, { method: "POST", key, body: { res: { ...res, id: "q-2" } } });
      expect(native.status).toBe(400);
      expect(await native.json()).toMatchObject({ code: "native_unsupported" });
    });

    it("stops an agent and keeps the push subscription per device", async () => {
      const { key, id } = device();
      expect((await call(`${REMOTE_API_PREFIX}/sessions/s-1/stop`, { method: "POST", key })).status).toBe(200);
      expect(calls).toEqual(["stop s-1"]);
      const sub = { endpoint: "https://push.example/abc", expirationTime: null, keys: { p256dh: "p", auth: "a" } };
      expect((await call(`${REMOTE_API_PREFIX}/push`, { method: "PUT", key, body: sub })).status).toBe(200);
      expect(registry.listRemoteDevices().find((d) => d.id === id)?.push).toEqual(sub);
      expect((await call(`${REMOTE_API_PREFIX}/push`, { method: "PUT", key, body: { endpoint: "http://insecure" } })).status).toBe(400);
      expect((await call(`${REMOTE_API_PREFIX}/push`, { method: "DELETE", key })).status).toBe(200);
      expect(registry.listRemoteDevices().find((d) => d.id === id)?.push).toBeUndefined();
    });
  });

  describe("who may", () => {
    it("401 without a key, with an unknown key, or with a lapsed one (removed on the spot)", async () => {
      expect((await call(`${REMOTE_API_PREFIX}/me`)).status).toBe(401);
      const unknown = await call(`${REMOTE_API_PREFIX}/me`, { key: "nope" });
      expect(unknown.status).toBe(401);
      expect(await unknown.json()).toMatchObject({ code: "unauthorized" });

      const lapsed = device("lapsed-key", new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString());
      expect((await call(`${REMOTE_API_PREFIX}/me`, { key: lapsed.key })).status).toBe(401);
      expect(registry.listRemoteDevices().some((d) => d.id === lapsed.id)).toBe(false);
      expect(changed).toContainEqual([lapsed.id]);
    });

    it("403 for another tailnet login, whatever the key", async () => {
      const { key } = device();
      const res = await call(`${REMOTE_API_PREFIX}/me`, { key, login: "colleague@example.com" });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "foreign_login" });
      expect((await call(`${REMOTE_API_PREFIX}/me`, { key, login: LOGIN })).status).toBe(200);
      expect((await call(`${REMOTE_API_PREFIX}/pair`, { method: "POST", login: "colleague@example.com", body: { code: "x", name: "n" } })).status).toBe(403);
    });

    it("503 while nobody is signed in on the computer; the phone stays paired", async () => {
      const { key, id } = device();
      signedIn = false;
      const res = await call(`${REMOTE_API_PREFIX}/sessions`, { key });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "signed_out" });
      expect((await call(`${REMOTE_API_PREFIX}/pair`, { method: "POST", body: { code: "x", name: "n" } })).status).toBe(503);
      expect(registry.listRemoteDevices().some((d) => d.id === id)).toBe(true);
    });

    it("pairs with the long code or the six digits, once; the key then works", async () => {
      const p = pairings.create();
      const res = await call(`${REMOTE_API_PREFIX}/pair`, { method: "POST", body: { code: p.code, name: "iPhone · Safari" } });
      expect(res.status).toBe(200);
      const { key, deviceId } = (await res.json()) as { key: string; deviceId: string };
      expect(registry.findRemoteDeviceByHash(hashKey(key))?.id).toBe(deviceId);
      expect(registry.listRemoteDevices().find((d) => d.id === deviceId)?.keyHash).not.toBe(key);
      const again = await call(`${REMOTE_API_PREFIX}/pair`, { method: "POST", body: { code: p.code, name: "x" } });
      expect(again.status).toBe(400);
      expect(await again.json()).toMatchObject({ code: "pairing" });
      const me = await call(`${REMOTE_API_PREFIX}/me`, { key });
      expect(await me.json()).toEqual({ deviceId, name: "iPhone · Safari", host: "mac.tail1234.ts.net", vapidPublicKey: "BPUBLIC" });

      const short = pairings.create().short;
      expect((await call(`${REMOTE_API_PREFIX}/pair`, { method: "POST", body: { code: short, name: "Android · Chrome" } })).status).toBe(200);
    });
  });

  describe("the socket", () => {
    function connect(key: string | undefined, login?: string): Socket {
      const s = io(base, {
        path: REMOTE_SOCKET_PATH,
        auth: key === undefined ? {} : { key },
        transports: ["websocket"],
        forceNew: true,
        reconnection: false,
        ...(login ? { extraHeaders: { "tailscale-user-login": login } } : {}),
      });
      sockets.push(s);
      return s;
    }

    function first(s: Socket): Promise<RemoteEvent> {
      const { promise, resolve, reject } = Promise.withResolvers<RemoteEvent>();
      s.once("event", resolve);
      s.once("connect_error", reject);
      return promise;
    }

    it("refuses a handshake without a valid key, with the code as the message and in data", async () => {
      const err = await first(connect("nope")).catch((e: Error & { data?: unknown }) => e);
      expect((err as Error).message).toBe("unauthorized");
      expect((err as { data?: unknown }).data).toMatchObject({ code: "unauthorized" });
      const { key } = device();
      signedIn = false;
      await expect(first(connect(key))).rejects.toThrow("signed_out");
    });

    it("starts with the list, carries broadcasts, and is cut when the device is disconnected", async () => {
      const { key, id } = device();
      const s = connect(key);
      const list = await first(s);
      expect(list.type).toBe("list");
      const next = first(s);
      server.broadcast({ type: "session_removed", sessionId: "s-1" });
      expect(await next).toEqual({ type: "session_removed", sessionId: "s-1" });

      const { promise: gone, resolve } = Promise.withResolvers<string>();
      s.once("disconnect", resolve);
      server.disconnectDevice(id);
      expect(await gone).toBe("io server disconnect");
    });
  });
});
