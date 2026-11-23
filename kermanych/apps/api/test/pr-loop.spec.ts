// apps/api/test/pr-loop.spec.ts
// «Петля після ПР» (docs/specs/2026-11-23-pr-feedback-loop.md) over a real registry and a fake
// GitHub (`fetch` stubbed, as supervisor.pr-merged.spec.ts does). The supervisor is a fake with the
// few public members PrLoopService reads: the sessions, the PR source, the send, the event stream.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Subject } from "rxjs";
import { PR_LOOP_MARKER, type PrLoopState, type ServerEvent, type Session } from "@kermanych/core";
import { RegistryService } from "../src/registry/registry.service";
import { PrLoopService } from "../src/pr-loop/pr-loop.service";
import { GithubClient, GithubEtagCache, parseGithubPrUrl } from "../src/github/github-client";

const P = "66666666-6666-4666-8666-666666666666";
const T0 = Date.parse("2026-11-23T12:00:00Z");
const min = (n: number) => n * 60_000;
const at = (ms: number) => new Date(ms).toISOString();
const HEAD = "a".repeat(40);

// ── The fake GitHub ──────────────────────────────────────────────────────────────────────────
type Gh = {
  pull: { state: "open" | "closed"; merged_at: string | null; sha: string; mergeable_state: string };
  runs: unknown[];
  statuses: unknown[];
  reviews: unknown[];
  inline: unknown[];
  conversation: unknown[];
};
let gh: Gh;
let calls: { url: string; headers: Record<string, string> }[];
function stubGithub(): void {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, headers: { ...(init.headers as Record<string, string>) } });
    const u = new URL(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const p = u.pathname;
    if (p === "/repos/o/r/pulls/7")
      return json({
        number: 7,
        html_url: "https://github.com/o/r/pull/7",
        state: gh.pull.state,
        merged_at: gh.pull.merged_at,
        created_at: at(T0 - min(60)),
        head: { sha: gh.pull.sha, ref: "kermanych/s1" },
        base: { ref: "dev" },
        mergeable_state: gh.pull.mergeable_state,
        user: { login: "me", type: "User" },
      });
    if (p === `/repos/o/r/commits/${gh.pull.sha}/check-runs`) return json({ total_count: gh.runs.length, check_runs: gh.runs });
    if (p === `/repos/o/r/commits/${gh.pull.sha}/status`) return json({ state: "pending", statuses: gh.statuses });
    if (p === "/repos/o/r/pulls/7/reviews") return json(gh.reviews);
    if (p === "/repos/o/r/pulls/7/comments") return json(gh.inline);
    if (p === "/repos/o/r/issues/7/comments") return json(gh.conversation);
    return new Response("", { status: 500 });
  });
}

const run = (name: string, status: string, conclusion: string | null, startedMinAgo = 10) => ({
  id: name.length,
  name,
  status,
  conclusion,
  html_url: `https://github.com/o/r/actions/runs/1/job/${name}`,
  started_at: at(T0 - min(startedMinAgo)),
  output: { summary: `${name} summary` },
});
let nextId = 100;
const conv = (association: string, body: string, minAgo: number, type = "User") => ({
  id: nextId++,
  user: { login: `${association.toLowerCase()}-${type.toLowerCase()}`, type },
  body,
  html_url: `https://github.com/o/r/pull/7#issuecomment-${nextId}`,
  created_at: at(T0 - min(minAgo)),
  author_association: association,
});

// ── The fake supervisor ──────────────────────────────────────────────────────────────────────
let reg: RegistryService;
let dir: string;
let events: Subject<ServerEvent>;
let prompts: Subject<string>;
let sent: { id: string; text: string; loopTurn: boolean }[];
let published: ServerEvent[];
let live: Record<string, Partial<Session>>;
let token: string;
let now: number;

function service(r = reg): PrLoopService {
  const sup = {
    events$: events,
    operatorPrompt$: prompts,
    mergedSessions: () => r.listSessions().map((s) => ({ ...s, ...live[s.id] })),
    githubPrSource: async (s: Session) => {
      const stored = s.prUrl ? parseGithubPrUrl(s.prUrl) : null;
      return { token, stored, remote: async () => ({ owner: "o", repo: "r" }) };
    },
    sessionPulls: (_s: Session, _g: unknown, pulls: unknown[]) => pulls,
    syncBase: () => "dev",
    sendLoopFeedback: async (id: string, text: string, opts: { loopTurn: boolean }) => {
      sent.push({ id, text, loopTurn: opts.loopTurn });
      if (opts.loopTurn) live[id] = { ...live[id], loopTurn: true };
    },
    publish: (e: ServerEvent) => published.push(e),
  };
  const svc = new PrLoopService(r, sup as never);
  svc.now = () => now;
  return svc;
}

function seed(patch: Partial<Session> = {}): string {
  reg.upsertProject({ id: P, name: "g", localRepoPath: "/repo" });
  const s = reg.createSession({ projectId: P, name: "task", task: "t", worktreePath: "/wt", branch: "kermanych/s1", baseBranch: "dev" });
  reg.updateSession(s.id, { status: "in_review", prOpened: true, prUrl: "https://github.com/o/r/pull/7", ...patch });
  return s.id;
}

const lastState = (id: string): PrLoopState | null | undefined => {
  const e = published.filter((x): x is Extract<ServerEvent, { type: "pr_loop_update" }> => x.type === "pr_loop_update" && x.sessionId === id).at(-1);
  return e?.state;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kmq-pr-loop-"));
  reg = new RegistryService(join(dir, "k.sqlite"));
  events = new Subject();
  prompts = new Subject();
  sent = [];
  published = [];
  live = {};
  token = "ghp_secret";
  now = T0;
  calls = [];
  gh = {
    pull: { state: "open", merged_at: null, sha: HEAD, mergeable_state: "clean" },
    runs: [],
    statuses: [],
    reviews: [],
    inline: [],
    conversation: [],
  };
  stubGithub();
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("baseline", () => {
  it("a PR seen for the first time sends nothing, old comments and a finished CI included", async () => {
    const id = seed();
    gh.conversation = [conv("OWNER", "please fix", 30)];
    gh.runs = [run("test", "completed", "failure")];
    const svc = service();
    await svc.tick();
    await svc.tick();
    expect(sent).toEqual([]);
    expect(lastState(id)).toMatchObject({ pr: { number: 7, state: "open" }, ci: { state: "failure" }, review: { pending: 0 }, loop: { phase: "idle", round: 0 } });
  });
});

describe("trust filter", () => {
  it("passes OWNER / MEMBER / COLLABORATOR / Bot, holds CONTRIBUTOR / NONE, skips the marker", async () => {
    const id = seed();
    const svc = service();
    await svc.tick();
    const trusted = [conv("OWNER", "owner says", 10), conv("MEMBER", "member says", 10), conv("COLLABORATOR", "collab says", 10), conv("NONE", "bot says", 10, "Bot")];
    const held = [conv("CONTRIBUTOR", "contributor says", 10), conv("NONE", "stranger says", 10)];
    const mine = conv("OWNER", `Fixed in abc\n${PR_LOOP_MARKER}`, 10);
    gh.conversation = [...trusted, ...held, mine];
    await svc.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.loopTurn).toBe(true);
    for (const c of trusted) expect(sent[0]!.text).toContain(c.body);
    for (const c of [...held, mine]) expect(sent[0]!.text).not.toContain(c.body);
    expect(sent[0]!.text).toContain("origin/dev"); // the base-sync block
    const st = lastState(id)!;
    expect(st.review.untrusted.map((u) => u.key).sort()).toEqual(held.map((c) => `conversation:${c.id}`).sort());
    expect(st.loop).toMatchObject({ round: 1, phase: "fixing" });
  });
});

describe("CI", () => {
  it("pending holds; a failure after all finished is sent once; cancelled / skipped are not failures", async () => {
    const id = seed();
    gh.runs = [run("test", "in_progress", null)];
    const svc = service();
    await svc.tick();
    gh.runs = [run("test", "completed", "failure"), run("lint", "completed", "cancelled"), run("e2e", "completed", "skipped")];
    await svc.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("**test**");
    expect(sent[0]!.text).not.toContain("**lint**");
    live[id] = { loopTurn: true }; // the turn settled back at in_review
    await svc.tick();
    expect(sent).toHaveLength(1);
    expect(lastState(id)!.ci).toMatchObject({ state: "failure", total: 3, failed: [{ name: "test" }] });
  });

  it("a comment waits for a running CI, and a stuck one sends nothing", async () => {
    const id = seed();
    const svc = service();
    await svc.tick();
    gh.runs = [run("test", "in_progress", null)];
    gh.conversation = [conv("OWNER", "fix", 10)];
    await svc.tick();
    expect(sent).toEqual([]);
    expect(lastState(id)!.loop.phase).toBe("waiting_ci");
    gh.runs = [run("test", "in_progress", null, 61)];
    gh.conversation = [];
    await svc.tick();
    expect(sent).toEqual([]);
    expect(lastState(id)!.ci.stuckMin).toBe(61);
  });
});

describe("quiet window", () => {
  it("a comment 4 min old holds, at 5 min the round goes with CI and comments together", async () => {
    const id = seed();
    gh.runs = [run("test", "in_progress", null)];
    const svc = service();
    await svc.tick();
    gh.runs = [run("test", "completed", "failure")];
    gh.conversation = [conv("OWNER", "rename it", 4)];
    await svc.tick();
    expect(sent).toEqual([]);
    expect(lastState(id)!.loop.phase).toBe("quiet");
    now = T0 + min(1);
    await svc.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("rename it");
    expect(sent[0]!.text).toContain("Failed CI checks");
  });
});

describe("busy, round limit, resets", () => {
  it("a busy session holds", async () => {
    const id = seed();
    const svc = service();
    await svc.tick();
    gh.conversation = [conv("OWNER", "fix", 10)];
    live[id] = { status: "thinking" };
    await svc.tick();
    expect(sent).toEqual([]);
    expect(lastState(id)!.loop.phase).toBe("busy");
  });

  it("the limit pauses; an operator message and «Продовжити петлю» reset the counter", async () => {
    const id = seed();
    const svc = service();
    svc.setSettings(P, { mode: "auto", maxRounds: 1 });
    await svc.tick();
    gh.conversation = [conv("OWNER", "one", 10)];
    await svc.tick();
    expect(sent).toHaveLength(1);
    gh.conversation.push(conv("OWNER", "two", 10));
    await svc.tick();
    expect(sent).toHaveLength(1);
    expect(lastState(id)!.loop).toMatchObject({ phase: "paused", round: 1, maxRounds: 1 });

    prompts.next(id);
    await svc.tick();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toContain("two");

    gh.conversation.push(conv("OWNER", "three", 10));
    await svc.tick();
    expect(lastState(id)!.loop.phase).toBe("paused");
    const st = await svc.resume(id);
    expect(sent).toHaveLength(3);
    expect(st.loop.round).toBe(1);
  });
});

describe("manual mode", () => {
  it("never sends by itself; a manual pass sends the picked untrusted comment and resets the counter", async () => {
    const id = seed();
    const svc = service();
    svc.setSettings(P, { mode: "manual", maxRounds: 3 });
    await svc.tick();
    const stranger = conv("NONE", "stranger idea", 10);
    gh.conversation = [conv("OWNER", "owner ask", 10), stranger, conv("NONE", "spam", 10)];
    reg.setPrLoop({ ...reg.getPrLoop(id)!, round: 2 });
    await svc.tick();
    expect(sent).toEqual([]);
    expect(lastState(id)!.loop.phase).toBe("manual_ready");

    await svc.send(id, [`conversation:${stranger.id}`]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ loopTurn: false });
    expect(sent[0]!.text).toContain("owner ask");
    expect(sent[0]!.text).toContain("stranger idea");
    expect(sent[0]!.text).not.toContain("spam");
    expect(reg.getPrLoop(id)!.round).toBe(0);
    expect(lastState(id)!.review.untrusted).toHaveLength(1);

    await expect(svc.send(id)).rejects.toThrow("nothing to send");
    live[id] = { status: "tool" };
    await expect(svc.send(id, [lastState(id)!.review.untrusted[0]!.key])).rejects.toThrow(/busy/);
  });
});

describe("the end of the loop", () => {
  it("a merged PR ends the loop, is not polled again, and leaves with a null once retired", async () => {
    const id = seed();
    const svc = service();
    await svc.tick();
    gh.pull = { ...gh.pull, state: "closed", merged_at: at(T0) };
    gh.conversation = [conv("OWNER", "late", 10)];
    await svc.tick();
    expect(sent).toEqual([]);
    expect(lastState(id)).toMatchObject({ pr: { state: "merged" }, loop: { phase: "ended" } });
    calls = [];
    await svc.tick();
    expect(calls).toEqual([]);
    reg.updateSession(id, { status: "merged" });
    await svc.tick();
    expect(lastState(id)).toBeNull();
    expect(svc.list()).toEqual([]);
  });

  it("without GIT_TOKEN says no_token and asks GitHub nothing", async () => {
    const id = seed();
    token = "";
    await service().tick();
    expect(calls).toEqual([]);
    expect(lastState(id)).toMatchObject({ unavailable: "no_token" });
  });

  it("maps GitHub failures like the merged-PR check", async () => {
    const id = seed();
    vi.stubGlobal("fetch", async () => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }));
    await service().tick();
    expect(lastState(id)).toMatchObject({ unavailable: "rate_limited" });
  });
});

describe("persistence", () => {
  it("the round and the seen comments survive a service re-create over the same SQLite", async () => {
    const id = seed();
    const first = service();
    await first.tick();
    gh.conversation = [conv("OWNER", "fix", 10)];
    await first.tick();
    expect(sent).toHaveLength(1);

    const again = service(new RegistryService(join(dir, "k.sqlite")));
    await again.tick();
    expect(sent).toHaveLength(1);
    expect(again.list()[0]).toMatchObject({ sessionId: id, loop: { round: 1 }, review: { pending: 0 } });
  });
});

describe("GithubClient", () => {
  it("a 304 to If-None-Match reuses the cached body; the token is hashed, not kept", async () => {
    const seen: Record<string, string>[] = [];
    let n = 0;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit = {}) => {
      seen.push({ ...(init.headers as Record<string, string>) });
      return n++ === 0
        ? new Response(JSON.stringify([{ id: 1, body: "hi" }]), { status: 200, headers: { etag: '"v1"' } })
        : new Response(null, { status: 304 });
    });
    const cache = new GithubEtagCache();
    const c = new GithubClient("ghp_secret", cache);
    expect(await c.issueComments("o", "r", 7)).toEqual([{ id: 1, body: "hi" }]);
    expect(await c.issueComments("o", "r", 7)).toEqual([{ id: 1, body: "hi" }]);
    expect(seen[0]!["If-None-Match"]).toBeUndefined();
    expect(seen[1]!["If-None-Match"]).toBe('"v1"');
    expect(cache.key("ghp_secret", "/x")).not.toContain("ghp_secret");
  });

  it("follows Link rel=next on api.github.com only", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      const link = page === 1 ? '<https://api.github.com/repos/o/r/pulls/7/comments?per_page=100&page=2>; rel="next"' : page === 2 ? '<https://evil.example/x?page=3>; rel="next"' : "";
      return new Response(JSON.stringify([{ id: page }]), { status: 200, headers: link ? { link } : {} });
    });
    expect((await new GithubClient("t").reviewComments("o", "r", 7)).map((c) => c.id)).toEqual([1, 2]);
    expect(urls).toHaveLength(2);
  });
});
