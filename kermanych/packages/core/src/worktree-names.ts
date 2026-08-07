import { homedir } from "os";
import { join } from "path";

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "session";
}
export function branchName(slug: string): string { return `kermanych/${slug}`; }
export function uniqueSlug(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  let n = 2; while (existing.has(`${base}-${n}`)) n++; return `${base}-${n}`;
}
export function worktreeDir(sessionId: string): string {
  return join(homedir(), ".kermanych", "worktrees", sessionId);
}
