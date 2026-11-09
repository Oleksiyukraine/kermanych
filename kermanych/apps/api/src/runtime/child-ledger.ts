// apps/api/src/runtime/child-ledger.ts
// The process groups this api started that must not outlive it, written down so the NEXT api
// can stop them when this one never got the chance.
//
// A clean quit stops every child itself (SupervisorService/RpcChatPool/PreviewService
// onModuleDestroy). A crash, a force-quit or a `kill -9` of the app does not: an `omp --mode rpc`
// wedged mid-command ignores the EOF on its stdin, and a preview step (sh → pnpm → vite) leads
// its own process group and keeps its port. Nothing else remembers their pids, so they ran until
// the machine rebooted. Both kinds are group leaders (spawned `detached`), so one negative-pid
// signal stops the whole tree: its MCP servers, workers, the dev server.
//
// One file per running api, `<home>/children/<pid>.json`, written only by that api: no two
// processes ever write the same file, so there is no lock. A file whose owner is gone is swept
// at the next start. Every pid is stored with its start time (`ps -o lstart`), and a process is
// signalled only when both still match: after a reboot or a long gap the pid may belong to
// somebody else's program, and a reused pid never shares the start time of the one recorded.
// The owner is identified the same way, so another Kermanych that is still running (a preview
// api, the packaged app beside `pnpm dev`) keeps its children.
//
// The api imports nothing global by default: bootstrap() installs the ledger (setChildLedger),
// so specs and a test module record nothing and never touch the operator's home.
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { signalGroup } from "./process-group";

type Entry = { pid: number; started: string; label: string };
type LedgerFile = { owner: { pid: number; started: string }; children: Entry[] };

// How long a swept group gets to honour SIGTERM before SIGKILL. A preview's dev server flushes
// in well under this; an omp wedged in a provider call never will, and waits no longer.
const SWEEP_GRACE_MS = 2_000;

export function childLedgerRoot(): string {
  return join(process.env.KERMANYCH_SKILLS_HOME ?? join(homedir(), ".kermanych"), "children");
}

// The process's start time as `ps` prints it, or "" when there is no such process.
export function processStarted(pid: number): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  execFile("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5_000 }, (err, out) => resolve(err ? "" : out.trim()));
  return promise;
}

export class ChildLedger {
  private readonly children = new Map<number, Entry>();
  private owner?: { pid: number; started: string };

  constructor(
    private readonly dir: string = childLedgerRoot(),
    private readonly started: (pid: number) => Promise<string> = processStarted,
    private readonly graceMs = SWEEP_GRACE_MS,
  ) {}

  private get file(): string {
    return join(this.dir, `${process.pid}.json`);
  }

  // Sweep what dead apis left, then claim this api's own file. Awaited before Nest starts, so a
  // preview port an orphan held is free again before anything tries to bind it.
  async open(): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    await this.sweep();
    this.owner = { pid: process.pid, started: await this.started(process.pid) };
    this.persist();
  }

  // A child just spawned. Its start time is read right away: a pid is recorded only with it, and
  // a child that exits before `ps` answers is simply never written down.
  add(pid: number, label: string): void {
    const entry: Entry = { pid, started: "", label };
    this.children.set(pid, entry);
    void this.started(pid).then((started) => {
      if (this.children.get(pid) !== entry) return;
      if (!started) this.children.delete(pid);
      else entry.started = started;
      this.persist();
    });
  }

  remove(pid: number): void {
    if (this.children.delete(pid)) this.persist();
  }

  // Stop the recorded groups of every api that is no longer running, and forget its file.
  async sweep(): Promise<void> {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return;
    }
    const stops: Promise<void>[] = [];
    for (const name of names) {
      const path = join(this.dir, name);
      let ledger: LedgerFile;
      try {
        ledger = JSON.parse(readFileSync(path, "utf8")) as LedgerFile;
      } catch {
        rmSync(path, { force: true });
        continue;
      }
      if (ledger.owner?.pid === process.pid) continue;
      if (ledger.owner?.started && (await this.started(ledger.owner.pid)) === ledger.owner.started) continue;
      for (const c of ledger.children ?? []) stops.push(this.stop(c));
      rmSync(path, { force: true });
    }
    await Promise.all(stops);
  }

  private async stop(c: Entry): Promise<void> {
    if (!c.started || (await this.started(c.pid)) !== c.started) return;
    console.warn(`[children] stopping ${c.label} (pid ${c.pid}) left running by a Kermanych that did not quit cleanly`);
    signalGroup(c.pid, "SIGTERM");
    const deadline = Date.now() + this.graceMs;
    while (Date.now() < deadline && (await this.started(c.pid)) === c.started) await sleep(100);
    // Whatever of the group is still there — the leader that ignored SIGTERM, or a straggler it
    // left — is killed through the group id alone. No new process can take a pid while a group of
    // that id exists, so this never reaches a stranger even though the leader may be gone.
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch {
      /* the whole group is gone */
    }
  }

  // Synchronous on purpose: it runs from exit handlers and on shutdown, where an awaited write
  // could be cut off. Written aside and renamed, so a crash mid-write never leaves half a file.
  private persist(): void {
    if (!this.owner) return;
    const children = [...this.children.values()].filter((c) => c.started);
    const body: LedgerFile = { owner: this.owner, children };
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(body));
      renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`[children] could not write ${this.file}: ${(err as Error).message}`);
    }
  }
}

let current: ChildLedger | undefined;

export function setChildLedger(ledger: ChildLedger | undefined): void {
  current = ledger;
}

export function childLedger(): ChildLedger | undefined {
  return current;
}
