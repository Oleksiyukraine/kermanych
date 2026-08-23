// apps/api/src/preview/preview.service.ts
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { spawn, type ChildProcess } from "node:child_process";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryService } from "../registry/registry.service";

type Preview = { procs: ChildProcess[]; url: string };

// Per-session live preview: run the branch's app from its worktree on free ports so
// you can see the work-in-progress without touching the main dev servers. Full-stack
// aware — an optional api command runs first on an injected PORT, then the web command
// is wired to it via VITE_API_BASE. The web port is read from the dev server's banner
// (it may honor the injected PORT or auto-bump), so it works whatever the worktree does.
@Injectable()
export class PreviewService implements OnModuleDestroy {
  private previews = new Map<string, Preview>();

  constructor(private registry: RegistryService) {}

  isRunning(id: string): boolean {
    return this.previews.has(id);
  }
  urlOf(id: string): string | undefined {
    return this.previews.get(id)?.url;
  }

  async start(sessionId: string): Promise<{ url: string } | { needsCommand: true }> {
    const existing = this.previews.get(sessionId);
    if (existing) return { url: existing.url };
    const s = this.registry.listSessions().find((x) => x.id === sessionId);
    if (!s) throw new Error("session not found");
    const project = this.registry.listProjects().find((p) => p.id === s.projectId);
    if (!project) throw new Error("project not found");
    const dir = s.worktreePath || project.localRepoPath;
    if (!dir) throw new Error("project not bound");
    if (!project.previewCommand) return { needsCommand: true };

    const procs: ChildProcess[] = [];
    try {
      let apiPort: number | undefined;
      if (project.apiCommand) {
        apiPort = await freePort();
        const api = this.spawnCmd(project.apiCommand, dir, {
          PORT: String(apiPort),
          // Isolated DB so a Kermanych-on-Kermanych preview never shares the main registry.
          KERMANYCH_DB: join(tmpdir(), "kermanych-preview", `${sessionId}.sqlite`),
          // ...and seed that DB with inert demo data so the previewed UI isn't empty (seed.ts).
          KERMANYCH_SEED: "1",
        });
        procs.push(api);
        await waitPort(apiPort, 180_000, api); // includes a possible first-run build/install
      }
      const webEnv: Record<string, string> = { PORT: String(await freePort()) };
      if (apiPort !== undefined) {
        webEnv.API_PORT = String(apiPort);
        webEnv.VITE_API_BASE = `http://localhost:${apiPort}/api`;
      }
      const web = this.spawnCmd(project.previewCommand, dir, webEnv);
      procs.push(web);
      const webPort = await discoverPort(web, 120_000);
      const url = `http://localhost:${webPort}`;
      this.previews.set(sessionId, { procs, url });
      return { url };
    } catch (err) {
      for (const p of procs) killTree(p);
      throw err;
    }
  }

  stop(sessionId: string): void {
    const p = this.previews.get(sessionId);
    if (!p) return;
    for (const proc of p.procs) killTree(proc);
    this.previews.delete(sessionId);
  }

  onModuleDestroy(): void {
    for (const id of [...this.previews.keys()]) this.stop(id);
  }

  private spawnCmd(cmd: string, cwd: string, env: Record<string, string>): ChildProcess {
    // `detached` gives each preview its own process group so killTree can take down
    // the whole tree (sh -> pnpm -> vite/nest), not just the shell.
    return spawn("sh", ["-c", cmd], {
      cwd,
      env: { ...process.env, ...env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}

function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const srv = createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const addr = srv.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    srv.close(() => resolve(port));
  });
  return promise;
}

function tail(stderr: string, out: string): string {
  const t = (stderr.trim() || out.trim()).slice(-400);
  return t ? `: ${t}` : "";
}

// Poll a known port until it accepts a connection (used for a PORT-respecting api).
function waitPort(port: number, timeoutMs: number, child: ChildProcess): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let stderr = "";
  child.stderr?.on("data", (b: Buffer) => {
    stderr = (stderr + b.toString()).slice(-4000);
  });
  const deadline = Date.now() + timeoutMs;
  let done = false;
  const fail = (msg: string) => {
    if (done) return;
    done = true;
    reject(new Error(msg));
  };
  child.once("exit", (code) => fail(`preview process exited (code ${code}) before ready${tail(stderr, "")}`));
  const tryConnect = () => {
    if (done) return;
    if (Date.now() > deadline) return fail(`preview not listening on ${port} within ${Math.round(timeoutMs / 1000)}s${tail(stderr, "")}`);
    const sock = connect(port, "127.0.0.1");
    sock.once("connect", () => {
      sock.destroy();
      if (done) return;
      done = true;
      resolve();
    });
    sock.once("error", () => {
      sock.destroy();
      setTimeout(tryConnect, 500);
    });
  };
  tryConnect();
  return promise;
}

// Read the port a dev server actually bound from its startup banner (it may honor the
// injected PORT or auto-bump to a free one), confirm it accepts, then resolve it.
function discoverPort(child: ChildProcess, timeoutMs: number): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  let out = "";
  let stderr = "";
  let done = false;
  let guard: NodeJS.Timeout;
  const deadline = Date.now() + timeoutMs;
  const fail = (msg: string) => {
    if (done) return;
    done = true;
    clearTimeout(guard);
    reject(new Error(msg));
  };
  const succeed = (port: number) => {
    if (done) return;
    done = true;
    clearTimeout(guard);
    resolve(port);
  };
  const confirm = (port: number) => {
    if (done) return;
    if (Date.now() > deadline) return fail(`preview not ready within ${Math.round(timeoutMs / 1000)}s${tail(stderr, out)}`);
    const sock = connect(port, "127.0.0.1");
    sock.once("connect", () => {
      sock.destroy();
      succeed(port);
    });
    sock.once("error", () => {
      sock.destroy();
      setTimeout(() => confirm(port), 400);
    });
  };
  child.stderr?.on("data", (b: Buffer) => {
    stderr = (stderr + b.toString()).slice(-4000);
  });
  child.stdout?.on("data", (b: Buffer) => {
    out = (out + b.toString()).slice(-8000);
    const m = out.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
    if (m) confirm(Number(m[1]));
  });
  child.once("exit", (code) => fail(`preview process exited (code ${code}) before ready${tail(stderr, out)}`));
  guard = setTimeout(() => fail(`preview printed no url within ${Math.round(timeoutMs / 1000)}s${tail(stderr, out)}`), timeoutMs);
  return promise;
}

function killTree(proc: ChildProcess): void {
  if (proc.pid === undefined) return;
  try {
    process.kill(-proc.pid, "SIGTERM"); // negative pid → whole process group
  } catch {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}
