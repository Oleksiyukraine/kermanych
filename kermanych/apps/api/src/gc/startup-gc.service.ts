// apps/api/src/gc/startup-gc.service.ts
import { Injectable, type OnModuleInit } from "@nestjs/common";
import { lstat, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { worktreeDir } from "@kermanych/core";
import { RegistryService } from "../registry/registry.service";
import { WorktreeService } from "../worktree/worktree.service";

export type StartupGcOptions = {
  // Where Kermanych once kept every worktree, one `<uuid>/` folder each, before they moved into
  // the project's own `.gitworktree/`.
  legacyRoot: string;
  // Where native sessions write their per-session claude MCP config (native-hooks.ts).
  nativeRoot: string;
};

// The real path, so a tree git registered under `/private/var/...` and a row that stored it as
// `/var/...` (macOS links the temp folders) compare equal. A path that is gone keeps its
// resolved form: nothing on disk can be confused with it any more.
async function canon(p: string): Promise<string> {
  return realpath(p).catch(() => resolve(p));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// What a long-running Kermanych leaves on disk and nothing else ever deletes: the trees finished
// sessions left behind, rows that never learned their tree's path, the leftovers of the older
// `~/.kermanych/worktrees/` layout, and native sessions' MCP configs, each holding a live bearer. Swept
// once per start, awaited in onModuleInit, so it ends before the api listens — no launch can add
// a worktree its row does not name yet while the sweep is deciding which trees are orphans.
// Every step is best effort: a failure is logged and the next step still runs, and the api
// starts either way. Uncommitted work is never deleted; such a tree stays and is named in the log.
@Injectable()
export class StartupGcService implements OnModuleInit {
  readonly opts: StartupGcOptions = {
    legacyRoot: join(process.env.KERMANYCH_SKILLS_HOME ?? join(homedir(), ".kermanych"), "worktrees"),
    nativeRoot: join(tmpdir(), "kermanych-native"),
  };

  constructor(
    private registry: RegistryService,
    private worktrees: WorktreeService,
  ) {}

  // PreviewService.sweep's rule: only the api on the machine's own registry sweeps. One on a
  // custom KERMANYCH_DB (preview mode, a test) knows none of the real sessions and would take
  // their worktrees and configs for orphans.
  async onModuleInit(): Promise<void> {
    if (process.env.KERMANYCH_DB) return;
    await this.run();
  }

  // Adoption goes first: a row it repairs names its tree before the sweep that follows would
  // take that tree for an orphan.
  async run(): Promise<void> {
    await this.step("adopting worktrees of interrupted launches", () => this.adopt());
    await this.step("sweeping project worktrees", () => this.sweepProjects());
    await this.step(`sweeping ${this.opts.legacyRoot}`, () => this.sweepLegacy());
    await this.step(`sweeping ${this.opts.nativeRoot}`, () => this.sweepNativeConfigs());
  }

  private async step(what: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      console.warn(`[gc] ${what} failed: ${errText(err)}`);
    }
  }

  // The launch's crash window (SupervisorService.launch): `addWorktree` ran, the process died
  // before `updateSession` stored the path. The row then owns a tree it cannot see — delete
  // skips it, and `branch -D` fails on a branch checked out there. The tree is exactly where
  // the launch put it, on the row's own branch, so the row is given its path back rather than
  // the work being thrown away.
  private async adopt(): Promise<void> {
    const repos = new Map(this.registry.listProjects().filter((p) => p.localRepoPath).map((p) => [p.id, p.localRepoPath] as const));
    const sessions = this.registry.listSessions();
    const owned = new Set(await Promise.all(sessions.filter((s) => s.worktreePath).map((s) => canon(s.worktreePath))));
    for (const s of sessions) {
      if (!s.worktree || s.worktreePath || s.status === "merged" || !s.branch) continue;
      const repo = repos.get(s.projectId);
      if (!repo) continue;
      try {
        const dir = worktreeDir(repo, s.branch);
        const want = await canon(dir);
        if (owned.has(want)) continue;
        const trees = await this.worktrees.listWorktrees(repo);
        const match = await Promise.all(trees.map(async (t) => t.branch === s.branch && (await canon(t.path)) === want));
        if (!match.includes(true) || !(await stat(dir).catch(() => undefined))?.isDirectory()) continue;
        this.registry.updateSession(s.id, { worktreePath: dir });
        owned.add(want);
        console.warn(`[gc] session ${s.id} adopted its worktree ${dir}, left unrecorded by an interrupted launch`);
      } catch (err) {
        console.warn(`[gc] adopting the worktree of session ${s.id} failed: ${errText(err)}`);
      }
    }
  }

  // Paths no sweep may delete: every row's worktree, and every bound checkout — a project can be
  // bound to a linked worktree of another project's repository, and then lives inside that
  // repository's `.gitworktree/`. A candidate that is one of them, or contains one, stays.
  private async protectedPaths(): Promise<string[]> {
    const paths = [
      ...this.registry.listSessions().map((s) => s.worktreePath),
      ...this.registry.listProjects().map((p) => p.localRepoPath),
    ].filter(Boolean);
    return Promise.all(paths.map(canon));
  }

  private static holds(candidate: string, kept: string[]): boolean {
    return kept.some((p) => p === candidate || p.startsWith(candidate + sep));
  }

  // `<repo>/.gitworktree/` is not Kermanych's alone: the operator, omp and other tools put their
  // own worktrees there too, under any folder name and on any branch. So a tree no row names is
  // NOT an orphan by itself — only one Kermanych provably made: it sits at `worktreeDir(repo,
  // branch)` of a session row of this repository that does not own it any more (a finished
  // session whose retirement left the tree behind). Never the main checkout, a locked tree, or a
  // tree with uncommitted work. A deleted session's tree is not provable once its row is gone;
  // deleteSession removes it before the row, so only a crash in between could leave one.
  private async sweepProjects(): Promise<void> {
    const kept = await this.protectedPaths();
    const sessions = this.registry.listSessions();
    const seen = new Set<string>();
    for (const project of this.registry.listProjects()) {
      const repo = project.localRepoPath;
      if (!repo) continue;
      try {
        const key = await canon(repo);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!(await this.worktrees.isGitRepo(repo))) continue;
        await this.worktrees.pruneWorktrees(repo);
        // Every project bound to this checkout, and the trees their agents would have been given.
        const projects = new Set<string>();
        for (const p of this.registry.listProjects()) if (p.localRepoPath && (await canon(p.localRepoPath)) === key) projects.add(p.id);
        const made = new Set<string>();
        for (const s of sessions) {
          if (!projects.has(s.projectId) || !s.worktree || !s.branch) continue;
          try {
            made.add(await canon(worktreeDir(repo, s.branch)));
          } catch {
            /* not a branch name worktreeDir accepts: Kermanych never made a tree for it */
          }
        }
        const [, ...linked] = await this.worktrees.listWorktrees(repo);
        for (const tree of linked) {
          const path = await canon(tree.path);
          if (!made.has(path) || tree.locked || StartupGcService.holds(path, kept)) continue;
          await this.removeIfClean(repo, path);
        }
      } catch (err) {
        console.warn(`[gc] sweeping the worktrees of ${repo} failed: ${errText(err)}`);
      }
    }
  }

  // The older layout: one `<uuid>/` folder per worktree. What no row names is a leftover — a
  // folder without `.git` that a surviving process wrote back into, a tree whose repository's
  // registration is gone (its `.git` file points at a git directory that no longer exists), or
  // a still-registered tree, removed through its own repository so git forgets it too. A folder
  // whose `.git` is a directory is a standalone clone Kermanych never made, and stays.
  private async sweepLegacy(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.opts.legacyRoot);
    } catch {
      return;
    }
    const kept = await this.protectedPaths();
    for (const name of names) {
      const dir = join(this.opts.legacyRoot, name);
      try {
        if (!(await lstat(dir)).isDirectory()) continue;
        const path = await canon(dir);
        if (StartupGcService.holds(path, kept)) continue;
        const dotGit = await lstat(join(path, ".git")).catch(() => undefined);
        if (dotGit?.isDirectory()) continue;
        if (!dotGit || !(await this.gitdirExists(path))) {
          await rm(path, { recursive: true, force: true, maxRetries: 3 });
          continue;
        }
        const main = await this.worktrees.mainCheckout(path);
        if (!main) {
          console.warn(`[gc] kept ${path}: its repository could not be resolved`);
          continue;
        }
        await this.removeIfClean(main, path);
      } catch (err) {
        console.warn(`[gc] sweeping ${dir} failed: ${errText(err)}`);
      }
    }
  }

  // A linked worktree's `.git` is a file, `gitdir: <path>`, relative to the tree when not absolute.
  private async gitdirExists(dir: string): Promise<boolean> {
    const text = await readFile(join(dir, ".git"), "utf8").catch(() => "");
    const m = /^gitdir:\s*(.+)$/m.exec(text);
    if (!m) return false;
    return (await stat(resolve(dir, m[1]!.trim())).catch(() => undefined)) !== undefined;
  }

  // Uncommitted work outranks disk: such a tree stays, named in the log for the operator. A
  // failing `git status` reads as dirty here (its error text is output), which keeps the tree too.
  private async removeIfClean(repo: string, dir: string): Promise<void> {
    if (await this.worktrees.hasUncommitted(dir)) {
      console.warn(`[gc] kept orphaned worktree ${dir}: it has uncommitted changes`);
      return;
    }
    await this.worktrees.removeWorktree(repo, dir);
  }

  // `mcp-<session id>.json` holds that session's browser bearer and is rewritten on every native
  // launch; once its row is gone, nothing reads it again. Other files there are shared hook
  // scripts and settings, and stay.
  private async sweepNativeConfigs(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.opts.nativeRoot);
    } catch {
      return;
    }
    const ids = new Set(this.registry.listSessions().map((s) => s.id));
    for (const name of names) {
      const m = /^mcp-(.+)\.json$/.exec(name);
      if (!m || ids.has(m[1]!)) continue;
      await rm(join(this.opts.nativeRoot, name), { force: true }).catch((err: unknown) =>
        console.warn(`[gc] removing ${name} failed: ${errText(err)}`),
      );
    }
  }
}
