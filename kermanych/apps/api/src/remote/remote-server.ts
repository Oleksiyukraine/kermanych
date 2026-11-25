// apps/api/src/remote/remote-server.ts
// The phone's server (docs/specs/2026-11-24-mobile-remote-control.md → Shape): a second HTTP
// server inside the api process, apart from the Nest app on :4317, that `tailscale serve` proxies
// the tailnet's `https://<host>.<tailnet>.ts.net:<port>` to. Only these exist on it:
//   /                        the built phone client (apps/remote), static, SPA fallback
//   /remote/api/*            RemotePhone's whitelist, JSON, the device key in REMOTE_KEY_HEADER
//   /remote/socket           socket.io, the filtered session events, `auth: { key }`
// No route of the main api is reachable through it, no CORS (the phone is same-origin; a page of
// another origin gets nothing it can read), and it listens on 127.0.0.1 only — the tailnet reaches
// it through tailscaled, nothing else does.
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { Server as IoServer } from "socket.io";
import { REMOTE_API_PREFIX, REMOTE_KEY_HEADER, REMOTE_SOCKET_PATH, type RemoteError, type RemoteEvent } from "@kermanych/core";
import { RemoteFailure, type RemotePhone } from "./remote-phone";
import type { RemoteDeviceRow } from "../registry/registry.service";

// Photos from the phone's camera ride the message as base64; a few of them fit.
const BODY_LIMIT = 25 * 1024 * 1024;
// The header tailscale serve adds to every proxied request from a tailnet user.
const LOGIN_HEADER = "tailscale-user-login";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

// The page may load only itself: its scripts, its styles (Vue's inline style bindings included),
// its images plus the camera's data:/blob: previews, and talk only to its own origin over https and
// wss (the socket). Nothing may frame it.
function csp(host: string | undefined): string {
  const self = host && /^[A-Za-z0-9.-]+(:\d+)?$/.test(host) ? ` https://${host} wss://${host}` : "";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${self}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  const one = Array.isArray(v) ? v[0] : v;
  return one?.trim() || undefined;
}

export type RemoteServerOptions = {
  /** The built phone client (`apps/remote/dist`); undefined or missing → 503 with how to build it. */
  clientDir: string | undefined;
};

export class RemoteServer {
  private http?: HttpServer;
  private io?: IoServer;
  private port?: number;

  constructor(
    private phone: RemotePhone,
    private opts: RemoteServerOptions,
  ) {}

  get listening(): number | undefined {
    return this.port;
  }

  /** Listens on 127.0.0.1 and a free port (or `port`), and answers with it. */
  async start(port = 0): Promise<number> {
    if (this.port !== undefined) return this.port;
    const http = createServer((req, res) => void this.handle(req, res));
    const io = new IoServer(http, { path: REMOTE_SOCKET_PATH, serveClient: false, maxHttpBufferSize: 1024 * 1024 });
    io.use((socket, next) => {
      try {
        const device = this.phone.authenticate(socket.handshake.auth?.key, firstHeader(socket.handshake.headers[LOGIN_HEADER]));
        socket.data.deviceId = device.id;
        next();
      } catch (err) {
        // The phone reads `err.data.code` (and the bare code as `err.message`) off `connect_error`.
        const f = err instanceof RemoteFailure ? err : new RemoteFailure("failed", (err as Error).message);
        next(Object.assign(new Error(f.code), { data: { code: f.code, message: f.message } satisfies RemoteError }));
      }
    });
    io.on("connection", (socket) => {
      void socket.join(`device:${socket.data.deviceId as string}`);
      socket.emit("event", { type: "list", ...this.phone.list() } satisfies RemoteEvent);
    });
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    http.once("error", reject);
    http.listen(port, "127.0.0.1", () => {
      const addr = http.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
    this.port = await promise;
    this.http = http;
    this.io = io;
    return this.port;
  }

  /** Every socket closed, the port released. */
  async stop(): Promise<void> {
    const { http, io } = this;
    this.http = undefined;
    this.io = undefined;
    this.port = undefined;
    if (!io || !http) return;
    io.disconnectSockets(true);
    // socket.io closes the http server after its sockets; the open keep-alive connections are
    // cut, so the close does not wait for a phone to hang up.
    const closed = io.close();
    http.closeAllConnections();
    await closed;
  }

  /** What the phones hear, on their `event` channel. */
  broadcast(e: RemoteEvent): void {
    this.io?.emit("event", e);
  }

  /** «Відключити» or a lapse: the device's open sockets go at once («io server disconnect»). */
  disconnectDevice(id: string): void {
    this.io?.in(`device:${id}`).disconnectSockets(true);
  }

  /** Signed out on the computer: every phone reconnects and hears `signed_out`. */
  disconnectAll(): void {
    this.io?.disconnectSockets(true);
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", csp(firstHeader(req.headers.host)));
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? "/", "http://remote").pathname);
    } catch {
      return this.json(res, 400, { code: "bad_request", message: "bad path" });
    }
    try {
      if (path === REMOTE_API_PREFIX || path.startsWith(`${REMOTE_API_PREFIX}/`)) return await this.api(req, res, path.slice(REMOTE_API_PREFIX.length));
      // Everything else under /remote/ is reserved for the api and the socket: never the page.
      if (path === "/remote" || path.startsWith("/remote/")) throw new RemoteFailure("not_found", "not found");
      return await this.static(req, res, path);
    } catch (err) {
      const f = err instanceof RemoteFailure ? err : new RemoteFailure("failed", (err as Error)?.message ?? String(err));
      if (!(err instanceof RemoteFailure)) console.warn(`[remote] ${req.method} ${path}: ${f.message}`);
      if (res.headersSent) return void res.destroy();
      return this.json(res, f.status, { code: f.code, message: f.message });
    }
  }

  private async api(req: IncomingMessage, res: ServerResponse, route: string): Promise<void> {
    const method = req.method ?? "GET";
    const login = firstHeader(req.headers[LOGIN_HEADER]);
    if (route === "/pair" && method === "POST") return this.json(res, 200, this.phone.pair(await readJson(req), login));
    const device: RemoteDeviceRow = this.phone.authenticate(firstHeader(req.headers[REMOTE_KEY_HEADER]), login);
    if (route === "/me" && method === "GET") return this.json(res, 200, this.phone.me(device));
    if (route === "/sessions" && method === "GET") return this.json(res, 200, this.phone.list());
    if (route === "/push" && method === "PUT") return this.json(res, 200, this.phone.setPush(device, await readJson(req)));
    if (route === "/push" && method === "DELETE") return this.json(res, 200, this.phone.clearPush(device));
    const m = /^\/sessions\/([^/]+)\/(transcript|message|answer|stop)$/.exec(route);
    if (m) {
      const [, id, action] = m as unknown as [string, string, string];
      if (action === "transcript" && method === "GET") return this.json(res, 200, await this.phone.transcript(id));
      if (action === "message" && method === "POST") return this.json(res, 200, await this.phone.message(id, await readJson(req)));
      if (action === "answer" && method === "POST") return this.json(res, 200, this.phone.answer(id, await readJson(req)));
      if (action === "stop" && method === "POST") return this.json(res, 200, await this.phone.stop(id));
    }
    throw new RemoteFailure("not_found", "not found");
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": data.length, "Cache-Control": "no-store" });
    res.end(data);
  }

  // ── Static client ─────────────────────────────────────────────────────────

  private async static(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") throw new RemoteFailure("not_found", "not found");
    const root = this.opts.clientDir;
    const index = root ? await fileAt(join(root, "index.html")) : undefined;
    if (!root || !index) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("«Пульт»: the phone client is not built. Run `pnpm --filter @kermanych/remote build` and reload.\n");
      return;
    }
    // Inside the client folder only: `..` and absolute tricks resolve outside and are refused.
    const file = normalize(join(root, path));
    const inside = file === root || file.startsWith(root.endsWith(sep) ? root : root + sep);
    let target = inside ? await fileAt(file) : undefined;
    if (!target) {
      // An asset that is not there is a 404; any other path is a route of the app (SPA fallback).
      if (!inside || extname(path)) throw new RemoteFailure("not_found", "not found");
      target = index;
    }
    const ext = extname(target);
    const name = target.slice(target.lastIndexOf(sep) + 1);
    // index.html and the service worker must never be stale (a new build would not reach the
    // phone); Vite's hashed assets never change under one name.
    const cache =
      name === "index.html" || name === "sw.js"
        ? "no-cache"
        : target.includes(`${sep}assets${sep}`)
          ? "public, max-age=31536000, immutable"
          : "no-cache";
    const data = await readFile(target);
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream", "Content-Length": data.length, "Cache-Control": cache });
    res.end(req.method === "HEAD" ? undefined : data);
  }
}

// A regular file at `path`, or undefined.
async function fileAt(path: string): Promise<string | undefined> {
  try {
    return (await stat(path)).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

// The JSON body, at most BODY_LIMIT. No body reads as `{}`.
async function readJson(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers["content-length"]);
  if (declared > BODY_LIMIT) throw new RemoteFailure("bad_request", "Повідомлення завелике.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new RemoteFailure("bad_request", "Повідомлення завелике.");
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RemoteFailure("bad_request", "Тіло запиту — не JSON.");
  }
}
