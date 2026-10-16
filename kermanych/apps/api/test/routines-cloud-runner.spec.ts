// apps/api/test/routines-cloud-runner.spec.ts
// The cloud runner (supabase/functions/routines-runner/runner.ts): the same due rule and claim as
// the local runner, and what a cloud run reads from GitHub, asks Anthropic and posts to Slack.
// The Store is in memory; GitHub, Anthropic and Slack answer a stubbed fetch.
import { beforeEach, describe, expect, it } from "vitest";
import {
  configure,
  executeRun,
  runNow,
  tick,
  STALE_RUN_MS,
  type Caller,
  type CloudProject,
  type CloudRoutine,
  type CloudSecrets,
  type Deps,
  type RunClaim,
  type RunResult,
  type Store,
} from "../../../supabase/functions/routines-runner/runner.ts";
import { parseGitHubRemote } from "../../../supabase/functions/routines-runner/github.ts";

const MONDAY_10 = Date.parse("2026-10-19T07:00:00Z"); // Mondays 10:00 in Kyiv

function routine(over: Partial<CloudRoutine> = {}): CloudRoutine & { runner: string; enabled: boolean } {
  return {
    id: "r1",
    workspaceId: "w1",
    name: "Weekly notes",
    createdBy: "author",
    runner: "cloud",
    enabled: true,
    action: { kind: "release_notes", sources: [{ projectId: "p1", branch: "main" }, { projectId: "p2", branch: "dev" }], periodDays: 7, groupBy: "topic" },
    schedule: { kind: "weekly", days: [1], time: "10:00" },
    timezone: "Europe/Kyiv",
    armedAt: "2026-10-01T00:00:00Z",
    ...over,
  };
}

class MemoryStore implements Store {
  routines: ReturnType<typeof routine>[] = [];
  claims: RunClaim[] = [];
  taken = new Set<string>();
  running = new Set<string>();
  runs = new Map<string, { id: string; routineId: string; status: string; scheduledFor?: string; startedAt: string }>();
  finished: { id: string; result: RunResult }[] = [];
  disabled: string[] = [];
  staleBefore: string[] = [];
  secrets: CloudSecrets | undefined = { anthropicApiKey: "sk-ant", anthropicModel: "claude-sonnet-x", githubToken: "ghp", slackBotToken: "xoxb-1", slackTeamId: "T1", slackTeamName: "Acme" };
  saved: CloudSecrets[] = [];
  projects: CloudProject[] = [
    { id: "p1", name: "Backend", gitRemoteUrl: "git@github.com:acme/back.git", defaultBranch: "main" },
    { id: "p2", name: "Frontend", gitRemoteUrl: "https://github.com/acme/front", defaultBranch: "main" },
  ];
  notes: unknown[] = [];
  tasks: unknown[] = [];

  async listCloudRoutines() { return this.routines.filter((r) => r.enabled && r.runner === "cloud"); }
  async getRoutine(id: string) { return this.routines.find((r) => r.id === id); }
  async hasRunningRun(id: string) { return this.running.has(id); }
  async isClaimed(id: string, at: string) { return this.taken.has(`${id}@${at}`); }
  async claimRun(c: RunClaim) {
    this.claims.push(c);
    const key = `${c.routineId}@${c.scheduledFor ?? Math.random()}`;
    if (this.taken.has(key)) return undefined;
    this.taken.add(key);
    const id = `run${this.claims.length}`;
    this.runs.set(id, { id, routineId: c.routineId, status: c.status ?? "running", ...(c.scheduledFor ? { scheduledFor: c.scheduledFor } : {}), startedAt: new Date(MONDAY_10).toISOString() });
    return id;
  }
  async getRun(id: string) { return this.runs.get(id); }
  async runRow(id: string) { return { id, status: this.runs.get(id)?.status }; }
  async finishRun(id: string, result: RunResult) { this.finished.push({ id, result }); }
  async failStaleRuns(before: string) { this.staleBefore.push(before); return 0; }
  async disableRoutine(id: string) { this.disabled.push(id); }
  async getSecrets() { return this.secrets; }
  async saveSecrets(_w: string, patch: CloudSecrets) { this.saved.push(patch); }
  async listProjects() { return this.projects; }
  async workspaceName() { return "Acme"; }
  async insertReleaseNote(n: unknown) { this.notes.push(n); return "note1"; }
  async insertTask(t: unknown) { this.tasks.push(t); return "task1"; }
}

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

// Answers by URL: GitHub commits per repo, Anthropic messages in order, Slack posts.
function stubFetch(opts: { commits?: Record<string, unknown[]>; replies?: unknown[]; models?: string[] }) {
  const calls: Call[] = [];
  const replies = [...(opts.replies ?? [])];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    const commits = /api\.github\.com\/repos\/([^/]+\/[^/]+)\/commits/.exec(url);
    if (commits) return json(opts.commits?.[commits[1]!] ?? []);
    if (url.includes("/contents/")) return new Response("export const x = 1;");
    if (url.endsWith("api.github.com/user")) return json({ login: "acme-bot" });
    if (url.includes("anthropic.com/v1/models")) return json({ data: (opts.models ?? []).map((id) => ({ id })) });
    if (url.includes("anthropic.com/v1/messages")) return json(replies.shift());
    if (url.includes("slack.com/api/auth.test")) return json({ ok: true, team_id: "T1", team: "Acme" });
    if (url.includes("slack.com/api/chat.postMessage")) return json({ ok: true, ts: "1.1" });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return { fn, calls };
}

const commit = (subject: string, date = "2026-10-15T09:00:00Z") => ({ parents: [{}], commit: { message: `${subject}\n\nwhy it matters`, author: { name: "Olia", date } } });
const text = (t: string) => ({ stop_reason: "end_turn", content: [{ type: "text", text: t }] });

let store: MemoryStore;
let dispatched: string[];
const deps = (fetchFn: typeof fetch, now = MONDAY_10 + 30_000): Deps => ({
  store,
  fetch: fetchFn,
  now: () => now,
  dispatch: async (id) => void dispatched.push(id),
  runBudgetMs: 130_000,
});
const caller = (userId: string, owner = false): Caller => ({ userId, isMember: async () => true, isOwner: async () => owner });

beforeEach(() => {
  store = new MemoryStore();
  dispatched = [];
});

describe("cloud tick", () => {
  it("claims the occurrence that is due and dispatches it, once", async () => {
    store.routines = [routine(), routine({ id: "local", runner: "local" })];
    const { fn } = stubFetch({});
    await tick(deps(fn));
    await tick(deps(fn, MONDAY_10 + 90_000));
    expect(store.claims.filter((c) => !c.status)).toEqual([{ routineId: "r1", trigger: "schedule", scheduledFor: "2026-10-19T07:00:00.000Z" }]);
    expect(dispatched).toEqual(["run1"]);
    expect(store.staleBefore[0]).toBe(new Date(MONDAY_10 + 30_000 - STALE_RUN_MS).toISOString());
  });

  it("records a due occurrence as skipped while the previous run still works", async () => {
    store.routines = [routine()];
    store.running.add("r1");
    await tick(deps(stubFetch({}).fn));
    expect(store.claims).toEqual([expect.objectContaining({ status: "skipped", errorCode: "routine_previous_running" })]);
    expect(dispatched).toEqual([]);
  });

  it("switches a one-off routine off when it fires", async () => {
    store.routines = [routine({ schedule: { kind: "once", date: "2026-10-19", time: "10:00" } })];
    await tick(deps(stubFetch({}).fn));
    expect(store.disabled).toEqual(["r1"]);
  });
});

describe("cloud run — release notes", () => {
  it("reads the period from GitHub, leaves a quiet project out, writes the note and posts it as the bot", async () => {
    store.routines = [routine({ slack: { teamId: "T1", channelId: "C9", channelName: "releases" } })];
    const { fn, calls } = stubFetch({
      commits: { "acme/back": [commit("Export to PDF"), { parents: [{}, {}], commit: { message: "Merge", author: { name: "x", date: "2026-10-15T00:00:00Z" } } }] },
      replies: [
        { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "read_file", input: { repository: "Backend", path: "src/a.ts" } }] },
        text("# Acme · 13–19 Oct\n\n## New\n- PDF export"),
      ],
    });
    const runId = (await store.claimRun({ routineId: "r1", trigger: "schedule", scheduledFor: new Date(MONDAY_10).toISOString() }))!;
    const result = await executeRun(deps(fn), runId);

    const back = new URL(calls.find((c) => c.url.includes("acme/back/commits"))!.url);
    expect(back.searchParams.get("sha")).toBe("main");
    // 13–19 Oct on Kyiv's clock (+3).
    expect(back.searchParams.get("since")).toBe("2026-10-12T21:00:00.000Z");
    expect(back.searchParams.get("until")).toBe("2026-10-19T20:59:59.999Z");

    const first = calls.find((c) => c.url.includes("/v1/messages"))!;
    expect(first.headers["x-api-key"]).toBe("sk-ant");
    expect((first.body as { model: string }).model).toBe("claude-sonnet-x");
    const prompt = ((first.body as { messages: { content: string }[] }).messages[0]!.content);
    expect(prompt).toContain("Export to PDF");
    expect(prompt).not.toContain("Merge");
    expect(prompt).toContain("list_files/read_file/search_code");
    const second = calls.filter((c) => c.url.includes("/v1/messages"))[1]!;
    expect(JSON.stringify(second.body)).toContain("export const x = 1;");

    expect(store.notes).toEqual([
      {
        workspaceId: "w1",
        sources: [{ projectId: "p1", projectName: "Backend", branch: "main" }],
        rangeFrom: "2026-10-13",
        rangeTo: "2026-10-19",
        title: "Acme · 13–19 Oct",
        bodyMd: "# Acme · 13–19 Oct\n\n## New\n- PDF export",
        createdBy: "author",
      },
    ]);
    const post = calls.find((c) => c.url.includes("chat.postMessage"))!;
    expect(post.headers.Authorization).toBe("Bearer xoxb-1");
    expect((post.body as { channel: string }).channel).toBe("C9");
    expect(result).toEqual({ status: "succeeded", noteId: "note1", commitCount: 1, slackChannelName: "releases" });
  });

  it("skips a period with no commits in any project", async () => {
    store.routines = [routine()];
    const { fn, calls } = stubFetch({});
    const runId = (await store.claimRun({ routineId: "r1", trigger: "manual" }))!;
    const result = await executeRun(deps(fn), runId);
    expect(result).toMatchObject({ status: "skipped", errorCode: "no_commits_in_range", errorParams: { project: "Backend", branch: "main" } });
    expect(calls.some((c) => c.url.includes("anthropic"))).toBe(false);
  });

  it("fails with what is missing when the workspace has not set the cloud runner up", async () => {
    store.routines = [routine()];
    store.secrets = undefined;
    const runId = (await store.claimRun({ routineId: "r1", trigger: "manual" }))!;
    expect(await executeRun(deps(stubFetch({}).fn), runId)).toMatchObject({
      status: "failed",
      errorCode: "routine_cloud_unconfigured",
      errorParams: { missing: "Anthropic API key, GitHub token" },
    });
  });
});

describe("cloud run — prompts", () => {
  it("a project prompt files its card for the author and touches nothing else", async () => {
    store.routines = [routine({ projectId: "p1", action: { kind: "prompt", prompt: "Bump deps", hideFromBoard: true } })];
    store.secrets = undefined;
    const { fn, calls } = stubFetch({});
    const runId = (await store.claimRun({ routineId: "r1", trigger: "manual" }))!;
    expect(await executeRun(deps(fn), runId)).toEqual({ status: "succeeded", taskId: "task1" });
    expect(store.tasks).toEqual([{ projectId: "p1", title: "Weekly notes · 2026-10-19", description: "Bump deps", assigneeId: "author", createdBy: "author", hidden: true }]);
    expect(calls).toEqual([]);
  });

  it("a workspace report reads GitHub through its tools and is kept as the run's output", async () => {
    store.routines = [routine({ action: { kind: "prompt", prompt: "Summarise open TODOs" } })];
    const { fn, calls } = stubFetch({ replies: [text("# TODOs\n\nnone")] });
    const runId = (await store.claimRun({ routineId: "r1", trigger: "manual" }))!;
    expect(await executeRun(deps(fn), runId)).toEqual({ status: "succeeded", outputMd: "# TODOs\n\nnone" });
    const body = calls[0]!.body as { tools: { name: string; input_schema: { properties: { repository: { enum: string[] } } } }[]; messages: { content: string }[] };
    expect(body.tools.map((t) => t.name)).toEqual(["list_files", "read_file", "search_code"]);
    expect(body.tools[0]!.input_schema.properties.repository.enum).toEqual(["Backend", "Frontend"]);
    expect(body.messages[0]!.content).toContain("Backend · GitHub acme/back");
  });

  it("forces the answer when the budget is nearly spent", async () => {
    store.routines = [routine({ action: { kind: "prompt", prompt: "Report" } })];
    const { fn, calls } = stubFetch({ replies: [text("# Report")] });
    const runId = (await store.claimRun({ routineId: "r1", trigger: "manual" }))!;
    const d = { ...deps(fn), runBudgetMs: 10_000 };
    await executeRun(d, runId);
    expect((calls[0]!.body as { tool_choice?: unknown }).tool_choice).toEqual({ type: "none" });
  });
});

describe("cloud run-now and configure", () => {
  it("runs for the author only", async () => {
    store.routines = [routine()];
    await expect(runNow(deps(stubFetch({}).fn), caller("someone"), "r1")).rejects.toThrow("only the author");
    await runNow(deps(stubFetch({}).fn), caller("author"), "r1");
    expect(store.claims).toEqual([{ routineId: "r1", trigger: "manual" }]);
    expect(dispatched).toEqual(["run1"]);
  });

  it("refuses a local routine", async () => {
    store.routines = [routine({ runner: "local" } as Partial<CloudRoutine>)];
    await expect(runNow(deps(stubFetch({}).fn), caller("author"), "r1")).rejects.toThrow("author's computer");
  });

  it("lets only the owner store keys, checks each one, and picks a Sonnet model by default", async () => {
    store.secrets = undefined;
    const { fn } = stubFetch({ models: ["claude-opus-z", "claude-sonnet-y"] });
    await expect(configure(deps(fn), caller("member"), "w1", { githubToken: "ghp" })).rejects.toThrow("only the workspace owner");
    await configure(deps(fn), caller("owner", true), "w1", { anthropicApiKey: " sk-new ", githubToken: "ghp", slackBotToken: "xoxb-2" });
    expect(store.saved).toEqual([
      { anthropicApiKey: "sk-new", anthropicModel: "claude-sonnet-y", githubToken: "ghp", slackBotToken: "xoxb-2", slackTeamId: "T1", slackTeamName: "Acme" },
    ]);
    await expect(configure(deps(fn), caller("owner", true), "w1", { slackBotToken: "xoxp-user" })).rejects.toThrow("xoxb-");
  });
});

describe("parseGitHubRemote", () => {
  it("reads the remotes git prints, and nothing else", () => {
    expect(parseGitHubRemote("git@github.com:acme/back.git")).toEqual({ owner: "acme", repo: "back" });
    expect(parseGitHubRemote("https://github.com/acme/front")).toEqual({ owner: "acme", repo: "front" });
    expect(parseGitHubRemote("ssh://git@github.com/acme/x.git")).toEqual({ owner: "acme", repo: "x" });
    expect(parseGitHubRemote("https://gitlab.com/acme/back.git")).toBeUndefined();
  });
});
