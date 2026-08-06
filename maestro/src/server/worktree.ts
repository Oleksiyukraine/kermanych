// src/server/worktree.ts
import { homedir } from "os";
import { join } from "path";

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "session";
}
export function branchName(slug: string): string { return `maestro/${slug}`; }
export function uniqueSlug(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  let n = 2; while (existing.has(`${base}-${n}`)) n++; return `${base}-${n}`;
}
export function worktreeDir(sessionId: string): string {
  return join(homedir(), ".maestro", "worktrees", sessionId);
}
async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  const code = await p.exited;
  return { ok: code === 0, out: out + err };
}
export async function isGitRepo(dir: string): Promise<boolean> {
  return (await git(dir, ["rev-parse", "--is-inside-work-tree"])).ok;
}
export async function addWorktree(repoDir: string, wtDir: string, branch: string): Promise<void> {
  const r = await git(repoDir, ["worktree", "add", wtDir, "-b", branch]);
  if (!r.ok) throw new Error(`git worktree add failed: ${r.out}`);
}
export async function removeWorktree(repoDir: string, wtDir: string): Promise<void> {
  await git(repoDir, ["worktree", "remove", "--force", wtDir]);
}
export async function removeBranch(repoDir: string, branch: string): Promise<void> {
  await git(repoDir, ["branch", "-D", branch]);
}
