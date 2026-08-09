// apps/api/src/preview/preview.service.ts
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { spawn, type ChildProcess } from "node:child_process";
import { connect, createServer } from "node:net";
import { RegistryService } from "../registry/registry.service";

type Preview = { procs: ChildProcess[]; url: string };

// Per-session live preview: run the branch's app from its worktree on free ports so
// you can see the work-in-progress without touching the main dev servers. Full-stack
// aware — an optional api command runs first, then the web command is wired to it via
// VITE_API_BASE, and the web port is opened.
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
    if (!s?.worktreePath) throw new Error("session has no worktree");
    const group = this.registry.listGroups().find((g) => g.id === s.groupId);
    if (!group?.previewCommand) return { needsCommand: true };

    const procs: ChildProcess[] = [];
    try {
      let apiPort: number | undefined;
      if (group.apiCommand) {
        apiPort = await freePort();
        const api = this.spawnCmd(group.apiCommand, s.worktreePath, { PORT: String(apiPort) });
        procs.push(api);
        await waitPort(apiPort, 180_000, api); // includes a possible first-run `pnpm install`
      }
      const webPort = await freePort();
      const webEnv: Record<string, string> = { PORT: String(webPort) };
      if (apiPort !== undefined) {
        webEnv.API_PORT = String(apiPort);
        webEnv.VITE_API_BASE = `http://localhost:${apiPort}/api`;
      }
      const web = this.spawnCmd(group.previewCommand, s.worktreePath, webEnv);
      procs.push(web);
      await waitPort(webPort, 120_000, web);
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

// Resolve once the port accepts a connection; reject if the child exits first or the
// deadline passes, carrying the child's stderr tail so failures are diagnosable.
function waitPort(port: number, timeoutMs: number, child: ChildProcess): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (b: Buffer) => {
    stderr = (stderr + b.toString()).slice(-4000);
  });
  const deadline = Date.now() + timeoutMs;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let done = false;
  const finish = (err?: Error) => {
    if (done) return;
    done = true;
    if (err) reject(err);
    else resolve();
  };
  child.once("exit", (code) =>
    finish(new Error(`preview process exited (code ${code}) before ready${stderr.trim() ? `: ${stderr.trim().slice(-400)}` : ""}`)),
  );
  const tryConnect = () => {
    if (done) return;
    if (Date.now() > deadline) {
      finish(new Error(`preview not listening on ${port} within ${Math.round(timeoutMs / 1000)}s${stderr.trim() ? `: ${stderr.trim().slice(-400)}` : ""}`));
      return;
    }
    const sock = connect(port, "127.0.0.1");
    sock.once("connect", () => {
      sock.destroy();
      finish();
    });
    sock.once("error", () => {
      sock.destroy();
      setTimeout(tryConnect, 500);
    });
  };
  tryConnect();
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
