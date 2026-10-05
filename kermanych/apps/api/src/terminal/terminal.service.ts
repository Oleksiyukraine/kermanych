// apps/api/src/terminal/terminal.service.ts
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawn, type IPty } from "node-pty";
import { Subject } from "rxjs";
import type { TerminalErrorCode, TerminalInfo } from "@kermanych/core";
import { RegistryService } from "../registry/registry.service";

export type TerminalEvent =
  | { type: "opened"; terminal: TerminalInfo }
  | { type: "data"; id: string; data: string }
  | { type: "exit"; id: string; exitCode: number; signal?: number };

// A refusal the gateway hands back to the client as `{ error: code, message }`.
export class TerminalRefusal extends Error {
  constructor(
    readonly code: TerminalErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// How much recent output a terminal keeps for whoever attaches next (a reloaded UI, a
// project switched back to). Enough for a few screens of a build log; bounded because a
// `tail -f` left running for a day must not grow the api without limit.
export const REPLAY_MAX = 256 * 1024;

type Running = { info: TerminalInfo; pty: IPty; replay: string };

// The integrated terminal's shells (docs/specs/2026-09-29-project-terminal.md). A shell
// belongs to the api, not to a socket: it outlives a UI reload and a project switch, and
// ends when it exits, when it is killed, or when the api stops. The working directory is
// resolved HERE from the project id — a client never sends a path.
@Injectable()
export class TerminalService implements OnModuleDestroy {
  readonly events$ = new Subject<TerminalEvent>();
  private terms = new Map<string, Running>();

  constructor(private registry: RegistryService) {}

  list(): TerminalInfo[] {
    return [...this.terms.values()].map((t) => t.info);
  }

  open(projectId: string, cols: number, rows: number): TerminalInfo {
    const project = this.registry.listProjects().find((p) => p.id === projectId);
    if (!project) throw new TerminalRefusal("project_not_found", "project not found");
    const cwd = project.localRepoPath;
    if (!cwd) throw new TerminalRefusal("project_not_bound", "project not bound");
    if (!isDirectory(cwd)) throw new TerminalRefusal("cwd_missing", `${cwd} does not exist`);

    const { file, args } = loginShell();
    const proc = this.spawnPty(file, args, cwd, cols, rows, shellEnv());
    return this.register(proc, { projectId, cwd, shell: basename(file) });
  }

  // A native session's harness (docs/specs/2026-10-05-native-sessions.md): `file args…` run
  // by the user's LOGIN shell — the Finder-launched app's PATH lacks brew/nvm otherwise —
  // through `exec "$@"`, so the harness replaces the shell (its exit is the pty's exit) and no
  // argument is ever re-quoted by a shell. The caller resolved `cwd` (the session's worktree).
  openSession(opts: {
    sessionId: string;
    projectId: string;
    cwd: string;
    file: string;
    args: string[];
    env?: Record<string, string>;
    cols?: number;
    rows?: number;
  }): TerminalInfo {
    if (process.platform === "win32") throw new TerminalRefusal("spawn_failed", "native sessions are not supported on Windows");
    if (!isDirectory(opts.cwd)) throw new TerminalRefusal("cwd_missing", `${opts.cwd} does not exist`);
    const shell = loginShell().file;
    const argv = ["-l", "-c", 'exec "$@"', "kermanych", opts.file, ...opts.args];
    const proc = this.spawnPty(shell, argv, opts.cwd, opts.cols ?? 0, opts.rows ?? 0, { ...shellEnv(), ...opts.env });
    return this.register(proc, { projectId: opts.projectId, cwd: opts.cwd, shell: basename(opts.file), sessionId: opts.sessionId });
  }

  private spawnPty(file: string, args: string[], cwd: string, cols: number, rows: number, env: Record<string, string>): IPty {
    ensureSpawnHelperExecutable();
    try {
      return spawn(file, args, {
        name: "xterm-256color",
        cols: dimension(cols, 80),
        rows: dimension(rows, 24),
        cwd,
        env,
      });
    } catch (err) {
      throw new TerminalRefusal("spawn_failed", err instanceof Error ? err.message : String(err));
    }
  }

  private register(proc: IPty, base: Pick<TerminalInfo, "projectId" | "cwd" | "shell" | "sessionId">): TerminalInfo {
    const info: TerminalInfo = {
      id: randomUUID(),
      projectId: base.projectId,
      cwd: base.cwd,
      shell: base.shell,
      pid: proc.pid,
      createdAt: new Date().toISOString(),
      ...(base.sessionId ? { sessionId: base.sessionId } : {}),
    };
    const term: Running = { info, pty: proc, replay: "" };
    this.terms.set(info.id, term);
    proc.onData((data) => {
      term.replay = appendReplay(term.replay, data, REPLAY_MAX);
      this.events$.next({ type: "data", id: info.id, data });
    });
    proc.onExit(({ exitCode, signal }) => {
      this.terms.delete(info.id);
      this.events$.next({ type: "exit", id: info.id, exitCode, signal: signal || undefined });
    });
    this.events$.next({ type: "opened", terminal: info });
    return info;
  }

  attach(id: string): { terminal: TerminalInfo; replay: string } {
    const t = this.terms.get(id);
    if (!t) throw new TerminalRefusal("terminal_not_found", "terminal not found");
    return { terminal: t.info, replay: t.replay };
  }

  // Input and resize for a terminal that has just exited are dropped, not refused: the
  // keystroke raced the exit, and the `exit` event already tells the client.
  write(id: string, data: string): void {
    this.terms.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terms.get(id);
    if (!t) return;
    try {
      t.pty.resize(dimension(cols, t.pty.cols), dimension(rows, t.pty.rows));
    } catch {
      // The pty closed between the lookup and the ioctl; its exit event follows.
    }
  }

  // SIGHUP, as a closed terminal window sends: the shell passes it on to its jobs. The
  // map entry goes when the exit event arrives, so the client learns of it the usual way.
  // `signal` escalates for a native harness that ignored the hangup.
  kill(id: string, signal?: string): void {
    this.terms.get(id)?.pty.kill(signal);
  }

  onModuleDestroy(): void {
    for (const t of this.terms.values()) t.pty.kill();
    this.terms.clear();
  }
}

// Append a chunk to a bounded replay. The cut lands on a line start when one is near, so
// the replay does not open on half an escape sequence that would paint garbage.
export function appendReplay(buf: string, chunk: string, max: number): string {
  const next = buf + chunk;
  if (next.length <= max) return next;
  const cut = next.length - max;
  const nl = next.indexOf("\n", cut);
  return nl !== -1 && nl - cut < 4096 ? next.slice(nl + 1) : next.slice(cut);
}

function dimension(n: number, fallback: number): number {
  return Number.isInteger(n) && n > 0 && n <= 1000 ? n : fallback;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// The user's shell as a LOGIN shell: the desktop app started from Finder inherits
// launchd's minimal PATH, and only the profile puts brew, nvm and friends back on it.
function loginShell(): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: process.env.COMSPEC || "cmd.exe", args: [] };
  const file = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  return { file, args: ["-l"] };
}

function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Inside the desktop app the api runs in Electron's main process; an inherited
    // ELECTRON_RUN_AS_NODE would turn any Electron CLI started from the shell into Node.
    // `pnpm dev:api` exports its npm_* lifecycle config (npm_config_*, npm_package_*),
    // which would steer every npm/pnpm the operator runs in the terminal.
    if (v !== undefined && !k.startsWith("ELECTRON_") && !/^npm_/i.test(k)) env[k] = v;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "kermanych";
  // A Finder-launched app has no LANG; without a UTF-8 locale the shell mangles
  // non-ASCII file names (a Cyrillic path is the common case here).
  if (process.platform !== "win32" && !env.LANG) env.LANG = "en_US.UTF-8";
  return env;
}

// node-pty 1.1.0 ships prebuilds/<platform>/spawn-helper without the exec bit, and every
// spawn then fails with «posix_spawnp failed». pnpm keeps the tarball's mode, so a fresh
// install is always affected; the packaged app is fixed at build time (quasar.config.ts)
// and this covers every other install. Checked once per process.
let helperChecked = false;
function ensureSpawnHelperExecutable(): void {
  if (helperChecked || process.platform === "win32") return;
  helperChecked = true;
  let root: string;
  try {
    root = dirname(require.resolve("node-pty/package.json"));
  } catch {
    return;
  }
  for (const dir of ["build/Release", `prebuilds/${process.platform}-${process.arch}`]) {
    // Inside the app bundle node-pty execs the copy outside the archive (unixTerminal.js).
    const helper = join(root, dir, "spawn-helper").replace(/app\.asar(?!\.unpacked)/, "app.asar.unpacked");
    try {
      accessSync(helper, constants.X_OK);
    } catch {
      try {
        chmodSync(helper, 0o755);
      } catch {
        // Absent (this layout has no such dir) or read-only; spawn reports the real error.
      }
    }
  }
}
