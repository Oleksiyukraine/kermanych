// routines-runner/github.ts — the cloud runner's only way to the code: GitHub's REST API with
// the workspace's read-only token. The local runner reads a checkout; here the commits of a
// period come from the commits API, and the model's read-only tools (list_files, read_file,
// search_code) are three GET endpoints.
import type { ReleaseCommit } from "../_shared/release-notes-types.ts";
import { routineLocalDate } from "../_shared/routine-schedule.ts";
import { RunFailure } from "./failure.ts";
import type { ToolSpec } from "./anthropic.ts";

const API = "https://api.github.com";
// A quarter of a busy repository is a few hundred commits; past this the prompt's own cap
// would drop them anyway.
const MAX_COMMIT_PAGES = 10;
const MAX_LISTED_FILES = 400;
const MAX_FILE_CHARS = 50_000;

export type GitHubRepo = { owner: string; repo: string };

// `https://github.com/o/r(.git)`, `git@github.com:o/r(.git)`, `ssh://git@github.com/o/r(.git)`.
// Anything else is not GitHub, and the cloud runner cannot read it.
export function parseGitHubRemote(url: string | undefined): GitHubRepo | undefined {
  if (!url) return undefined;
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
    url.trim(),
  );
  return m ? { owner: m[1]!, repo: m[2]! } : undefined;
}

export class GitHub {
  constructor(
    private token: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async get(path: string, accept = "application/vnd.github+json"): Promise<Response> {
    const r = await this.fetchFn(`${API}${path}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "kermanych-routines" },
    });
    return r;
  }

  private async json<T>(path: string): Promise<T> {
    const r = await this.get(path);
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${await errorText(r)}`);
    return (await r.json()) as T;
  }

  // Who the token belongs to — the `configure` check that it is a working token at all.
  async login(): Promise<string> {
    return (await this.json<{ login: string }>("/user")).login;
  }

  // Whether the token can read one repository; the reason when it cannot.
  async canRead(r: GitHubRepo): Promise<{ ok: true } | { ok: false; reason: string }> {
    const res = await this.get(`/repos/${r.owner}/${r.repo}`);
    if (res.ok) return { ok: true };
    return { ok: false, reason: res.status === 404 ? "the token cannot see this repository" : `GitHub ${res.status}` };
  }

  // The branch's commits in [since, until), newest first, merges left out — what the local
  // runner's `git log --no-merges` reads. Dates are the author's, on the routine's clock.
  async commits(r: GitHubRepo, branch: string, since: string, until: string, tz: string): Promise<ReleaseCommit[]> {
    const out: ReleaseCommit[] = [];
    for (let page = 1; page <= MAX_COMMIT_PAGES; page++) {
      const q = new URLSearchParams({ sha: branch, since, until, per_page: "100", page: String(page) });
      const res = await this.get(`/repos/${r.owner}/${r.repo}/commits?${q}`);
      if (res.status === 404 || res.status === 409)
        throw new RunFailure("routine_github_failed", `GitHub cannot read branch ${branch} of ${r.owner}/${r.repo}`, {
          project: `${r.owner}/${r.repo}`,
          reason: res.status === 409 ? "the repository is empty" : `branch ${branch} not found, or the token cannot see the repository`,
        });
      if (!res.ok)
        throw new RunFailure("routine_github_failed", `GitHub ${res.status}`, { project: `${r.owner}/${r.repo}`, reason: await errorText(res) });
      const batch = (await res.json()) as {
        parents?: unknown[];
        commit: { message: string; author?: { name?: string; date?: string } };
      }[];
      for (const c of batch) {
        if ((c.parents?.length ?? 0) > 1) continue;
        const [subject = "", ...rest] = c.commit.message.split("\n");
        const date = c.commit.author?.date ? routineLocalDate(Date.parse(c.commit.author.date), tz) : "";
        out.push({ date, author: c.commit.author?.name ?? "unknown", subject: subject.trim(), body: rest.join("\n").trim() });
      }
      if (batch.length < 100) break;
    }
    return out;
  }

  // ── the model's tools ──────────────────────────────────────────────────────

  private trees = new Map<string, string[]>();

  async listFiles(r: GitHubRepo, ref: string, prefix: string): Promise<string> {
    const key = `${r.owner}/${r.repo}@${ref}`;
    let paths = this.trees.get(key);
    if (!paths) {
      const tree = await this.json<{ tree: { path: string; type: string }[]; truncated: boolean }>(
        `/repos/${r.owner}/${r.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      );
      paths = tree.tree.filter((t) => t.type === "blob").map((t) => t.path);
      this.trees.set(key, paths);
    }
    const clean = prefix.replace(/^\/+/, "");
    const hits = paths.filter((p) => p.startsWith(clean));
    const shown = hits.slice(0, MAX_LISTED_FILES);
    return shown.join("\n") + (hits.length > shown.length ? `\n… ${hits.length - shown.length} more — narrow the path` : "") || "no files";
  }

  async readFile(r: GitHubRepo, ref: string, path: string): Promise<string> {
    const res = await this.get(
      `/repos/${r.owner}/${r.repo}/contents/${path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
      "application/vnd.github.raw+json",
    );
    if (!res.ok) return `cannot read ${path}: GitHub ${res.status}`;
    const text = await res.text();
    return text.length > MAX_FILE_CHARS ? `${text.slice(0, MAX_FILE_CHARS)}\n… truncated at ${MAX_FILE_CHARS} characters` : text;
  }

  // GitHub's code search reads the default branch only — said in the tool's description.
  async searchCode(r: GitHubRepo, query: string): Promise<string> {
    const q = new URLSearchParams({ q: `${query} repo:${r.owner}/${r.repo}`, per_page: "30" });
    const res = await this.get(`/search/code?${q}`);
    if (!res.ok) return `search failed: GitHub ${res.status}`;
    const found = (await res.json()) as { items: { path: string }[] };
    return found.items.map((i) => i.path).join("\n") || "no matches";
  }
}

async function errorText(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { message?: string };
    return j.message ?? r.statusText;
  } catch {
    return r.statusText;
  }
}

// The three read-only tools over the repositories a run may read, addressed by project name —
// the name the prompt lists them under.
export function githubTools(
  gh: GitHub,
  repos: Map<string, GitHubRepo & { ref: string }>,
): { tools: ToolSpec[]; call: (name: string, input: Record<string, unknown>) => Promise<string> } {
  const names = [...repos.keys()];
  const repository = { type: "string", enum: names, description: "The repository, by its project name." };
  const tools: ToolSpec[] = [
    {
      name: "list_files",
      description: "List file paths of a repository (on the branch the run reads), optionally under a path prefix.",
      input_schema: { type: "object", properties: { repository, path: { type: "string", description: "A path prefix, e.g. src/" } }, required: ["repository"] },
    },
    {
      name: "read_file",
      description: "Read one file of a repository (on the branch the run reads).",
      input_schema: { type: "object", properties: { repository, path: { type: "string" } }, required: ["repository", "path"] },
    },
    {
      name: "search_code",
      description: "Search a repository's code for words or identifiers. Searches the default branch only.",
      input_schema: { type: "object", properties: { repository, query: { type: "string" } }, required: ["repository", "query"] },
    },
  ];
  async function call(name: string, input: Record<string, unknown>): Promise<string> {
    const target = repos.get(String(input.repository ?? ""));
    if (!target) return `unknown repository — one of: ${names.join(", ")}`;
    if (name === "list_files") return gh.listFiles(target, target.ref, String(input.path ?? ""));
    if (name === "read_file") return gh.readFile(target, target.ref, String(input.path ?? ""));
    if (name === "search_code") return gh.searchCode(target, String(input.query ?? ""));
    return `unknown tool ${name}`;
  }
  return { tools, call };
}
