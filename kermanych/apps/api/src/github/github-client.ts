// apps/api/src/github/github-client.ts
// The one place that speaks HTTP to GitHub: the merged-PR check
// (docs/specs/2026-10-26-pr-merged-close-prompt.md) reads a pull request, or the closed pull
// requests of a branch, from the REST API. Built per check with the bound project's
// `GIT_TOKEN` — the token the agent opened the PR with — or none: a public repository answers
// anonymously (60 requests per hour per IP), a private one answers 404. The token rides only in
// the Authorization header; it is never logged and never part of an error message.
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

// The fields of a pull request the check reads. `merged_at` is null until merged; `head.sha`
// is the commit the PR carried when it was merged.
export type GithubPull = {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged_at: string | null;
  created_at: string;
  head: { sha: string; ref: string };
  base: { ref: string };
};

export class GithubClient {
  constructor(private readonly token = "") {}

  pull(owner: string, repo: string, number: number): Promise<GithubPull> {
    return this.get(`/repos/${enc(owner)}/${enc(repo)}/pulls/${number}`);
  }

  // The closed pull requests whose head is `owner:branch` — merged or not; the caller picks.
  closedPullsByHead(owner: string, repo: string, ownerColonBranch: string): Promise<GithubPull[]> {
    const q = new URLSearchParams({ state: "closed", head: ownerColonBranch, per_page: "100" });
    return this.get(`/repos/${enc(owner)}/${enc(repo)}/pulls?${q}`);
  }

  private async get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetch(`${API_URL}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      const rateLimited = res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
      throw new GithubHttpError(res.status, `GitHub ${res.status} ${res.statusText}`.trim(), rateLimited);
    }
    return (await res.json()) as T;
  }
}

const enc = encodeURIComponent;

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
