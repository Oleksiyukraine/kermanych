// apps/api/src/env/env-file.service.ts
import { Injectable } from "@nestjs/common";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, relative, resolve, sep } from "node:path";
import type { EnvFileView } from "@kermanych/core";
import { WorktreeService } from "../worktree/worktree.service";
import { runGit } from "../git/run-git";
import { parseEnv, applyEnvEdits } from "./env-text";

@Injectable()
export class EnvFileService {
  constructor(private worktree: WorktreeService) {}

  // Resolve `<repoPath>/<file>` and refuse anything that escapes repoPath.
  private target(repoPath: string, file: string): string {
    const base = resolve(repoPath);
    const target = resolve(repoPath, file);
    if (!target.startsWith(base + sep)) throw new Error(`path escapes project directory: ${file}`);
    return target;
  }

  async read(repoPath: string, file = ".env"): Promise<EnvFileView> {
    const target = this.target(repoPath, file);
    const text = existsSync(target) ? await readFile(target, "utf8") : "";
    const ignored = await this.worktree.isIgnored(repoPath, file);
    return { entries: parseEnv(text), ignored };
  }

  async write(
    repoPath: string,
    file = ".env",
    edits: { set?: Record<string, string>; remove?: string[] },
  ): Promise<EnvFileView> {
    const target = this.target(repoPath, file);
    if (edits.set && Object.hasOwn(edits.set, "GIT_TOKEN")) await this.excludeUnlessIgnored(repoPath, file, target);
    const current = existsSync(target) ? await readFile(target, "utf8") : "";
    const next = applyEnvEdits(current, edits);
    const tmp = `${target}.kmq-${process.pid}-${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, next, { mode: 0o600 });
      await rename(tmp, target); // atomic on the same filesystem
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return this.read(repoPath, file);
  }

  // A file that is about to hold GIT_TOKEN must not reach the agent's first commit
  // (docs/specs/2026-11-18-first-run-and-project-wizard.md, decision 4). When git does not
  // already ignore it, its repo-relative path goes into the repository's own `info/exclude` — a
  // local rule: nothing is committed, the project's `.gitignore` is not touched. Done before the
  // write, so the token is never on disk unprotected. Outside a git repository there is nothing
  // to commit it into, and nothing is done.
  private async excludeUnlessIgnored(repoPath: string, file: string, target: string): Promise<void> {
    if (await this.worktree.isIgnored(repoPath, file)) return;
    const [prefix, excludePath] = await Promise.all([
      runGit(repoPath, ["rev-parse", "--show-prefix"]),
      runGit(repoPath, ["rev-parse", "--git-path", "info/exclude"]),
    ]);
    if (!prefix.ok || !excludePath.ok) return;
    const rel = prefix.stdout.trim() + relative(resolve(repoPath), target).split(sep).join("/");
    // Anchored to the repository root, with git's glob characters and a trailing space escaped,
    // so the rule names this one file and nothing else.
    const rule = "/" + rel.replace(/[\\*?[]/g, "\\$&").replace(/ $/, "\\ ");
    const exclude = resolve(repoPath, excludePath.stdout.trim());
    const current = existsSync(exclude) ? await readFile(exclude, "utf8") : "";
    if (current.split(/\r?\n/).some((line) => line.trim() === rule)) return;
    await mkdir(dirname(exclude), { recursive: true });
    await appendFile(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${rule}\n`);
  }
}
