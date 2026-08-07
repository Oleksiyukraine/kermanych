// apps/api/src/worktree/worktree.service.ts
import { Injectable } from "@nestjs/common";
import { spawn } from "node:child_process";

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const { promise, resolve } = Promise.withResolvers<{ ok: boolean; out: string }>();
  const p = spawn("git", ["-C", cwd, ...args]);
  const chunks: Buffer[] = [];
  p.stdout.on("data", (b: Buffer) => chunks.push(b));
  p.stderr.on("data", (b: Buffer) => chunks.push(b));
  p.on("error", (e) => resolve({ ok: false, out: String(e) }));
  p.on("close", (code) => resolve({ ok: code === 0, out: Buffer.concat(chunks).toString("utf8") }));
  return promise;
}

@Injectable()
export class WorktreeService {
  async isGitRepo(dir: string): Promise<boolean> {
    return (await git(dir, ["rev-parse", "--is-inside-work-tree"])).ok;
  }

  async addWorktree(repoDir: string, wtDir: string, branch: string): Promise<void> {
    const r = await git(repoDir, ["worktree", "add", wtDir, "-b", branch]);
    if (!r.ok) throw new Error(`git worktree add failed: ${r.out}`);
  }

  async removeWorktree(repoDir: string, wtDir: string): Promise<void> {
    await git(repoDir, ["worktree", "remove", "--force", wtDir]);
  }

  async removeBranch(repoDir: string, branch: string): Promise<void> {
    await git(repoDir, ["branch", "-D", branch]);
  }
}
