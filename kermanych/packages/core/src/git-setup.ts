// packages/core/src/git-setup.ts
// The contract between the project wizard (apps/ui) and the api's git and GitHub routes
// (docs/specs/2026-11-18-first-run-and-project-wizard.md): what a folder on this machine is,
// a GitHub repository the token can see, and a clone job's state as `POST /api/git/clone` answers
// it and the `git_clone` event streams it. Plus the two pure helpers both sides need: the folder
// name a clone gets, and whether two remote URLs name the same repository.

/** `POST /api/git/inspect`: a folder on this machine. `origin` / `branch` are null on a non-repo. */
export type GitInspect = {
  path: string;
  isRepo: boolean;
  origin: string | null;
  branch: string | null;
  /** The folder's own name — the project name the wizard proposes. */
  name: string;
};

/** One entry of `POST /api/github/repos`: a repository the token can read. */
export type GithubRepo = {
  fullName: string;
  cloneUrl: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  pushedAt: string | null;
};

/** `cloning` until git exits; the three others are final. */
export type GitClonePhase = "cloning" | "done" | "failed" | "cancelled";

export type GitCloneState = {
  jobId: string;
  phase: GitClonePhase;
  /** The folder the clone writes: `<parentDir>/<dirName>`. */
  path: string;
  /** git's current progress stage («Receiving objects», «Resolving deltas»), null before the first. */
  stage: string | null;
  /** 0–100 within `stage`, null when git printed no percentage. */
  percent: number | null;
  /** git's own message on `failed`, null otherwise. Never contains the token. */
  error: string | null;
  /** `failed` because the remote refused the credentials: the wizard offers the token step again. */
  authFailed: boolean;
};

// The folder a clone of `url` lands in, the way `git clone` names it: the last path segment
// without `.git`. Works for https, ssh (`git@host:o/r.git`) and local paths; "" when the URL has
// no usable segment.
export function repoDirName(url: string): string {
  const trimmed = url.trim().replace(/[/\\]+$/, "");
  const last = trimmed.split(/[/\\:]/).pop() ?? "";
  return last.replace(/\.git$/i, "");
}

// A remote URL reduced to `host/owner/repo`, lowercased, so the https and ssh forms of one
// repository compare equal: scheme, user info, port, a trailing `.git` or `/` are dropped. An
// `~/.ssh/config` alias host (`github.com-work`) folds back to `github.com`. null when nothing
// that looks like `host/path` is left.
export function remoteIdentity(url: string): string | null {
  let s = url.trim();
  if (!s) return null;
  const scp = s.includes("://") ? null : /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(s);
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]+@/, "");
  s = s.replace(/^([^/:]+):\d+\//, "$1/").replace(/\/+$/, "").replace(/\.git$/i, "");
  const slash = s.indexOf("/");
  if (slash <= 0 || slash === s.length - 1) return null;
  const host = s.slice(0, slash).replace(/^(github\.com)-[\w-]+$/i, "$1");
  return `${host}/${s.slice(slash + 1)}`.toLowerCase();
}

/** True when both URLs name the same repository; false when either is unreadable. */
export function sameRemote(a: string, b: string): boolean {
  const x = remoteIdentity(a);
  return x !== null && x === remoteIdentity(b);
}
