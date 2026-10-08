// apps/api/src/terminal/terminal.service.ts
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawn, type IPty } from "node-pty";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Subject } from "rxjs";
import { TERMINAL_SCROLLBACK, type TerminalErrorCode, type TerminalInfo } from "@kermanych/core";
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

// Output the screen copy has been handed but not yet parsed. Past HIGH the pty is paused
// until the parser is back under LOW: xterm throws away a write once 50 MB are pending, and
// a `cat` of a huge file outruns the parser.
const PENDING_HIGH = 1024 * 1024;
const PENDING_LOW = 128 * 1024;

// `screen` is a headless xterm fed every byte the pty prints — the terminal as a view would
// show it, scrollback included. A re-attaching view is repainted from it: a raw tail of
// the output would not do, because a TUI (omp, claude) redraws in place several MB a
// minute, and any bounded tail of that holds the last few seconds and none of the history.
type Running = {
  info: TerminalInfo;
  pty: IPty;
  screen: Terminal;
  serializer: SerializeAddon;
  pending: number;
  paused: boolean;
  exited: boolean;
};

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
    const screen = new Terminal({ cols: proc.cols, rows: proc.rows, scrollback: TERMINAL_SCROLLBACK, allowProposedApi: true });
    const serializer = new SerializeAddon();
    screen.loadAddon(serializer);
    const term: Running = { info, pty: proc, screen, serializer, pending: 0, paused: false, exited: false };
    this.terms.set(info.id, term);
    proc.onData((data) => {
      this.events$.next({ type: "data", id: info.id, data });
      // Output after the exit would land behind the screen's disposal below.
      if (term.exited) return;
      term.pending += data.length;
      if (!term.paused && term.pending > PENDING_HIGH) {
        term.paused = true;
        proc.pause();
      }
      screen.write(data, () => {
        term.pending -= data.length;
        if (term.paused && term.pending < PENDING_LOW) {
          term.paused = false;
          proc.resume();
        }
      });
    });
    proc.onExit(({ exitCode, signal }) => {
      this.terms.delete(info.id);
      term.exited = true;
      // Behind any attach still waiting for its snapshot.
      screen.write("", () => screen.dispose());
      this.events$.next({ type: "exit", id: info.id, exitCode, signal: signal || undefined });
    });
    this.events$.next({ type: "opened", terminal: info });
    return info;
  }

  // The replay is the screen serialized — scrollback, the alternate screen, cursor and
  // modes (mouse tracking, bracketed paste) — once it has parsed everything the pty printed
  // before this call, and nothing printed after. The caller joins the stream in the same
  // tick, so the stream picks up exactly where the replay ends. Throws for an unknown id.
  attach(id: string): Promise<{ terminal: TerminalInfo; replay: string }> {
    const t = this.terms.get(id);
    if (!t) throw new TerminalRefusal("terminal_not_found", "terminal not found");
    const { promise, resolve } = Promise.withResolvers<{ terminal: TerminalInfo; replay: string }>();
    t.screen.write("", () => resolve({ terminal: t.info, replay: t.serializer.serialize({ scrollback: TERMINAL_SCROLLBACK }) }));
    return promise;
  }

  // Input and resize for a terminal that has just exited are dropped, not refused: the
  // keystroke raced the exit, and the `exit` event already tells the client.
  write(id: string, data: string): void {
    this.terms.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terms.get(id);
    if (!t) return;
    const c = dimension(cols, t.pty.cols);
    const r = dimension(rows, t.pty.rows);
    try {
      t.pty.resize(c, r);
    } catch {
      // The pty closed between the lookup and the ioctl; its exit event follows.
      return;
    }
    // Behind the output already read: that was printed for the old size.
    t.screen.write("", () => t.screen.resize(c, r));
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
