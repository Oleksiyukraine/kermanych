// apps/api/src/github/github-client.ts
// The one place that speaks HTTP to GitHub. The merged-PR check
// (docs/specs/2026-10-26-pr-merged-close-prompt.md) reads a pull request, or the closed pull
// requests of a branch, from the REST API; it is built per check with the bound project's
// `GIT_TOKEN` — the token the agent opened the PR with — or none: a public repository answers
// anonymously (60 requests per hour per IP), a private one answers 404. The project wizard
// (docs/specs/2026-11-18-first-run-and-project-wizard.md) builds one with the token being typed
// in, to say whose it is and to list the repositories it can read. «Петля після ПР»
// (docs/specs/2026-11-23-pr-feedback-loop.md) reads the head's checks and the PR's reviews and
// comments every tick, through a GithubEtagCache: a conditional request answered 304 does not
// count against the rate limit. The token rides only in the Authorization header; it is never
// logged and never part of an error message.
import { createHash } from "node:crypto";
import type { GithubRepo } from "@kermanych/core";

const API_URL = "https://api.github.com";
const TIMEOUT_MS = 10_000;

// A non-2xx answer. `rateLimited` marks a 429, or a 403 whose `x-ratelimit-remaining` is 0 —
// GitHub's way of saying the hourly budget is spent, which must not read as "no access".
export class GithubHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly rateLimited = false,
  ) {
    super(message);
  }
}

// A failed request in the words the UI shows (docs/specs/2026-10-26-pr-merged-close-prompt.md,
// decision 6). A spent rate limit is a 403 too, so it is read first. `fetch` rejects with a
// TypeError when the network is down and with a TimeoutError/AbortError when the signal fires.
export function githubFailure(err: unknown): "no_access" | "rate_limited" | "offline" | "error" {
  if (err instanceof GithubHttpError) {
    if (err.rateLimited) return "rate_limited";
    return [401, 403, 404].includes(err.status) ? "no_access" : "error";
  }
  const name = (err as { name?: unknown } | null)?.name;
  if (err instanceof TypeError || name === "TimeoutError" || name === "AbortError") return "offline";
  return "error";
}

export type GithubUser = { login: string; type?: string };

// The fields of a pull request the checks read. `merged_at` is null until merged; `head.sha`
// is the commit the PR carried when it was merged. `mergeable_state` (`clean`, `dirty`,
// `unknown`, …) comes only from the single-PR endpoint, not from a listing.
export type GithubPull = {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged_at: string | null;
  created_at: string;
  head: { sha: string; ref: string };
  base: { ref: string };
  mergeable_state?: string | null;
  user?: GithubUser | null;
};

export type GithubCheckRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  details_url?: string | null;
  started_at: string | null;
  created_at?: string | null;
  output?: { summary?: string | null } | null;
};

export type GithubCommitStatus = {
  context: string;
  state: string;
  target_url: string | null;
  description: string | null;
  created_at: string;
};

// A GitHub Actions workflow run of a commit (`/actions/runs?head_sha=`) and one of its jobs
// (`/actions/runs/{id}/jobs`). A job is what the check-runs endpoint lists as a check run.
type GithubWorkflowRun = {
  id: number;
  name: string | null;
  status: string | null;
  conclusion: string | null;
  html_url: string;
  run_started_at?: string | null;
  created_at: string;
};

type GithubWorkflowJob = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  started_at: string | null;
  created_at?: string | null;
};

export type GithubReview = {
  id: number;
  user: GithubUser | null;
  body: string | null;
  state: string;
  html_url: string;
  submitted_at: string | null;
  author_association?: string;
};

// An inline review comment (`/pulls/{n}/comments`); `line` is null on an outdated diff.
export type GithubReviewComment = {
  id: number;
  user: GithubUser | null;
  body: string;
  html_url: string;
  created_at: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  author_association?: string;
};

// A conversation comment (`/issues/{n}/comments`).
export type GithubIssueComment = {
  id: number;
  user: GithubUser | null;
  body: string | null;
  html_url: string;
  created_at: string;
  author_association?: string;
};

// The fields of a repository the wizard's picker reads.
type GithubRepoBody = {
  full_name: string;
  clone_url: string;
  private: boolean;
  default_branch: string;
  description: string | null;
  pushed_at: string | null;
};

// The picker lists at most this many pages of 100, most recently pushed first: an account that
// sees more than 500 repositories finds the rest by URL.
const MAX_REPO_PAGES = 5;
// The loop's listings follow `Link: rel="next"` this far (500 comments or checks).
const MAX_LIST_PAGES = 5;

type CachedAnswer = { etag: string; body: unknown; next: string | null };

// The last ETag and body of each GET, keyed by a hash of the token and the path — never the
// token itself. A 304 to `If-None-Match` hands back the cached body. Bounded: the oldest entry
// goes first once full.
export class GithubEtagCache {
  private map = new Map<string, CachedAnswer>();
  constructor(private readonly max = 1000) {}

  key(token: string, path: string): string {
    return createHash("sha256").update(token).update("\n").update(path).digest("hex");
  }
  get(key: string): CachedAnswer | undefined {
    return this.map.get(key);
  }
  set(key: string, v: CachedAnswer): void {
    this.map.delete(key);
    this.map.set(key, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
}

export class GithubClient {
  constructor(
    private readonly token = "",
    private readonly etags?: GithubEtagCache,
  ) {}

  pull(owner: string, repo: string, number: number): Promise<GithubPull> {
    return this.get(`/repos/${enc(owner)}/${enc(repo)}/pulls/${number}`);
  }

  // The closed pull requests whose head is `owner:branch` — merged or not; the caller picks.
  closedPullsByHead(owner: string, repo: string, ownerColonBranch: string): Promise<GithubPull[]> {
    return this.pullsByHead(owner, repo, ownerColonBranch, "closed");
  }

  // The pull requests whose head is `owner:branch`, in the given state; the first page of 100.
  pullsByHead(owner: string, repo: string, ownerColonBranch: string, state: "open" | "closed" | "all"): Promise<GithubPull[]> {
    const q = new URLSearchParams({ state, head: ownerColonBranch, per_page: "100" });
    return this.get(`/repos/${enc(owner)}/${enc(repo)}/pulls?${q}`);
  }

  // The check runs of a commit (GitHub Actions and Apps).
  async checkRuns(owner: string, repo: string, sha: string): Promise<GithubCheckRun[]> {
    const pages = await this.list<{ check_runs: GithubCheckRun[] }>(`/repos/${enc(owner)}/${enc(repo)}/commits/${enc(sha)}/check-runs?per_page=100`);
    return pages.flatMap((p) => p.check_runs ?? []);
  }

  // The commit statuses of a commit, the latest per context (external CI).
  async combinedStatus(owner: string, repo: string, sha: string): Promise<GithubCommitStatus[]> {
    const body = await this.get<{ statuses?: GithubCommitStatus[] }>(`/repos/${enc(owner)}/${enc(repo)}/commits/${enc(sha)}/status`);
    return body.statuses ?? [];
  }

  // The GitHub Actions jobs of a commit, as check runs — what the check-runs endpoint returns for
  // Actions, read through the Actions API instead: GitHub offers a fine-grained token no «Checks»
  // permission, but «Actions: read» reads these. A run with no job yet (queued) stands for itself.
  async actionsJobs(owner: string, repo: string, sha: string): Promise<GithubCheckRun[]> {
    const base = `/repos/${enc(owner)}/${enc(repo)}/actions/runs`;
    const runs = (await this.list<{ workflow_runs?: GithubWorkflowRun[] }>(`${base}?head_sha=${enc(sha)}&per_page=100`)).flatMap((p) => p.workflow_runs ?? []);
    const perRun = await Promise.all(
      runs.map(async (run): Promise<GithubCheckRun[]> => {
        const jobs = (await this.list<{ jobs?: GithubWorkflowJob[] }>(`${base}/${run.id}/jobs?filter=latest&per_page=100`)).flatMap((p) => p.jobs ?? []);
        if (jobs.length) return jobs;
        return [{ id: run.id, name: run.name ?? `run ${run.id}`, status: run.status ?? "queued", conclusion: run.conclusion, html_url: run.html_url, started_at: run.run_started_at ?? run.created_at }];
      }),
    );
    return perRun.flat();
  }

  async reviews(owner: string, repo: string, number: number): Promise<GithubReview[]> {
    return (await this.list<GithubReview[]>(`/repos/${enc(owner)}/${enc(repo)}/pulls/${number}/reviews?per_page=100`)).flat();
  }

  async reviewComments(owner: string, repo: string, number: number): Promise<GithubReviewComment[]> {
    return (await this.list<GithubReviewComment[]>(`/repos/${enc(owner)}/${enc(repo)}/pulls/${number}/comments?per_page=100`)).flat();
  }

  async issueComments(owner: string, repo: string, number: number): Promise<GithubIssueComment[]> {
    return (await this.list<GithubIssueComment[]>(`/repos/${enc(owner)}/${enc(repo)}/issues/${number}/comments?per_page=100`)).flat();
  }

  // Whose token this is. A 401 is a token GitHub does not know (or an expired one).
  user(): Promise<{ login: string }> {
    return this.get("/user");
  }

  // The repositories the token can read — own, collaborator and organization ones — most
  // recently pushed first.
  async repos(): Promise<GithubRepo[]> {
    const byName = new Map<string, GithubRepo>();
    for (let page = 1; page <= MAX_REPO_PAGES; page++) {
      const q = new URLSearchParams({
        per_page: "100",
        sort: "pushed",
        affiliation: "owner,collaborator,organization_member",
        page: String(page),
      });
      const batch = await this.get<GithubRepoBody[]>(`/user/repos?${q}`);
      for (const r of batch)
        byName.set(r.full_name, {
          fullName: r.full_name,
          cloneUrl: r.clone_url,
          private: r.private,
          defaultBranch: r.default_branch,
          description: r.description,
          pushedAt: r.pushed_at,
        });
      if (batch.length < 100) break;
    }
    // Pages are fetched one after another and a push between two of them can move a repository
    // across the page boundary — seen twice, or out of order: keep one of each, order the whole
    // list again, never-pushed ones last.
    return [...byName.values()].sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
  }

  // Every page of a listing, following `Link: rel="next"` up to MAX_LIST_PAGES. Only a next link
  // on api.github.com is followed, so the token never leaves for another host.
  private async list<T>(path: string): Promise<T[]> {
    const pages: T[] = [];
    let next: string | null = path;
    for (let i = 0; next && i < MAX_LIST_PAGES; i++) {
      const page: { body: T; next: string | null } = await this.request<T>(next);
      pages.push(page.body);
      next = page.next;
    }
    return pages;
  }

  private async get<T>(path: string): Promise<T> {
    return (await this.request<T>(path)).body;
  }

  private async request<T>(path: string): Promise<{ body: T; next: string | null }> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const key = this.etags?.key(this.token, path);
    const cached = key ? this.etags!.get(key) : undefined;
    if (cached) headers["If-None-Match"] = cached.etag;
    const res = await fetch(`${API_URL}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 304 && cached) return { body: cached.body as T, next: cached.next };
    if (!res.ok) {
      const rateLimited = res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
      throw new GithubHttpError(res.status, `GitHub ${res.status} ${res.statusText}`.trim(), rateLimited);
    }
    const body = (await res.json()) as T;
    const next = nextLink(res.headers.get("link"));
    const etag = res.headers.get("etag");
    if (key && etag) this.etags!.set(key, { etag, body, next });
    return { body, next };
  }
}

const enc = encodeURIComponent;

// The path of a `Link` header's `rel="next"` target on api.github.com; null without one.
function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (!m) continue;
    try {
      const u = new URL(m[1]!);
      return u.origin === API_URL ? `${u.pathname}${u.search}` : null;
    } catch {
      return null;
    }
  }
  return null;
}

// owner/repo of a GitHub remote: `https://github.com/o/r(.git)`, `git@github.com:o/r(.git)`,
// `ssh://git@github.com/o/r(.git)`, a trailing slash tolerated. The ssh forms also accept the
// `github.com-<alias>` host of an `~/.ssh/config` entry per account (`git@github.com-work:o/r`);
// only owner/repo is read off the URL, the request always goes to api.github.com. null for any
// other host.
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/(?:[^@/]+@)?github\.com(?:-[\w-]+)?(?::\d+)?\/|[^@/\s]+@github\.com(?:-[\w-]+)?:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

// owner/repo/number of a GitHub pull-request URL (`https://github.com/o/r/pull/N`); null for
// GitLab, Bitbucket or anything else, which the check then looks up by branch instead.
export function parseGithubPrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]\S*)?$/i.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]) } : null;
}
