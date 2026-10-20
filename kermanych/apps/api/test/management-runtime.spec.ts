// apps/api/test/management-runtime.spec.ts
// Increment 3, Task 4: the two ephemeral management children (chat + release notes) are
// spawned through the runtime factory, so the operator's chosen backend answers a
// management question exactly as it runs an agent. The seam is `createRuntime`: mock it,
// record the kind, and prove the service resolves omp by default and the cached preference
// when one is stored.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ManagementChatAsk, ReleaseCommit, ReleaseNotesAsk, RpcEvent } from "@kermanych/core";

const calls: { kind: string; opts: { cwd: string; tools?: string[]; appendSystemPrompt?: string } }[] = [];
// The events the mocked child "emits" the moment it is written to — one terminal turn.
let script: RpcEvent[] = [];

class FakeRuntime {
  droppedFrames = 0;
  private cbs: ((e: RpcEvent) => void)[] = [];
  onEvent(cb: (e: RpcEvent) => void) {
    this.cbs.push(cb);
  }
  onExit() {}
  async start() {}
  isAlive() {
    return true;
  }
  async stop() {}
  answerUi() {}
  prompt() {
    this.play();
  }
  followUp() {
    this.play();
  }
  steer() {}
  private play() {
    for (const e of script) for (const cb of this.cbs) cb(e);
  }
}

vi.mock("../src/runtime/agent-runtime", () => ({
  createRuntime: vi.fn((kind: string, opts: { cwd: string; tools?: string[] }) => {
    calls.push({ kind, opts });
    return new FakeRuntime();
  }),
}));

import { ManagementChatService } from "../src/management/management-chat.service";
import { ReleaseNotesService } from "../src/management/release-notes.service";
import { RegistryService } from "../src/registry/registry.service";
import type { WorktreeService } from "../src/worktree/worktree.service";

// One assistant answer closed the way omp closes it: streamed text, a message_end carrying
// the turn accounting, then the terminal agent_end the services wait for.
function reply(text: string): RpcEvent[] {
  return [
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } },
    {
      type: "message_end",
      message: { role: "assistant", model: "opus-5", usage: { input: 10, output: 5, cost: { total: 0.01 } } },
    },
    { type: "agent_end", isTerminal: true },
  ] as RpcEvent[];
}

function chatAsk(): ManagementChatAsk {
  return {
    conversationId: "management:w1",
    workspaceId: "w1",
    workspaceProjects: [{ id: "p1" }],
    text: "що в реєстрі ризиків?",
    context: { workspaceName: "Acme", section: "management-risks", risks: [], members: [] },
  };
}

function notesAsk(): ReleaseNotesAsk {
  return {
    sources: [{ projectId: "p1", branch: "main" }],
    workspaceName: "Acme",
    rangeFrom: "2026-08-01",
    rangeTo: "2026-08-31",
  };
}

const commit: ReleaseCommit = { date: "2026-08-20", author: "Оля", subject: "додано експорт у PDF", body: "" };

// A worktree stub whose branch/log answers let generate() reach the one-shot child — the
// only part this spec cares about is which runtime that child is spawned on.
const fakeWorktree = {
  listBranches: async () => ["main"],
  logRange: async () => [commit],
} as unknown as WorktreeService;

function registry(runtime?: "omp" | "claude-code"): RegistryService {
  const r = new RegistryService(":memory:");
  r.upsertProject({ id: "p1", name: "Альфа", localRepoPath: "/repos/alpha" });
  if (runtime) r.setAuthSession({ userId: "u1", accessToken: "t", agentRuntime: runtime });
  return r;
}

beforeEach(() => {
  calls.length = 0;
  script = reply("готово");
  delete process.env.KERMANYCH_RUNTIME;
});

describe("ManagementChatService runtime", () => {
  it("defaults to omp when no preference is cached", async () => {
    const svc = new ManagementChatService(registry());
    await svc.ask(chatAsk(), "u1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("omp");
    expect(calls[0]?.opts.tools).toEqual(["read", "grep", "glob"]);
    expect(calls[0]?.opts.cwd).toBe("/repos/alpha");
  });

  it("spawns the cached claude-code runtime when the user chose it", async () => {
    const svc = new ManagementChatService(registry("claude-code"));
    await svc.ask(chatAsk(), "u1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("claude-code");
  });
});

describe("ReleaseNotesService runtime", () => {
  it("defaults to omp when no preference is cached", async () => {
    const svc = new ReleaseNotesService(registry(), fakeWorktree);
    await svc.generate(notesAsk());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("omp");
    expect(calls[0]?.opts.tools).toEqual(["read", "grep", "glob"]);
    expect(calls[0]?.opts.cwd).toBe("/repos/alpha");
  });

  it("spawns the cached claude-code runtime when the user chose it", async () => {
    const svc = new ReleaseNotesService(registry("claude-code"), fakeWorktree);
    await svc.generate(notesAsk());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("claude-code");
  });

  // The child's one reply IS the note, and the note is always English: the operator's
  // agent-language directive («write every reply in Ukrainian») must not reach it.
  it("does not hand the child the operator's agent-language directive", async () => {
    const r = registry();
    r.setAuthSession({ userId: "u1", accessToken: "t", agentLanguage: "uk" });
    await new ReleaseNotesService(r, fakeWorktree).generate(notesAsk());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts.appendSystemPrompt).toBeUndefined();
  });
});

describe("ReleaseNotesService — several projects", () => {
  // The back-end from `dev`, the front-end from `main`: each repository is read on its own
  // branch, and one child writes the one document.
  function twoRepos(logs: Record<string, ReleaseCommit[]>) {
    const r = registry();
    r.upsertProject({ id: "p2", name: "Бета", localRepoPath: "/repos/beta" });
    const read: [string, string][] = [];
    const worktree = {
      listBranches: async () => ["main", "dev"],
      logRange: async (path: string, branch: string) => {
        read.push([path, branch]);
        return logs[path] ?? [];
      },
    } as unknown as WorktreeService;
    return { svc: new ReleaseNotesService(r, worktree), read };
  }
  const ask: ReleaseNotesAsk = {
    sources: [
      { projectId: "p1", branch: "dev" },
      { projectId: "p2", branch: "main" },
    ],
    workspaceName: "Acme",
    rangeFrom: "2026-08-01",
    rangeTo: "2026-08-31",
  };

  it("reads every project on its own branch and writes one note from the first repository", async () => {
    const { svc, read } = twoRepos({ "/repos/alpha": [commit, commit], "/repos/beta": [commit] });
    const out = await svc.generate(ask);
    expect(read).toEqual([
      ["/repos/alpha", "dev"],
      ["/repos/beta", "main"],
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts.cwd).toBe("/repos/alpha");
    expect(out.commitCount).toBe(3);
  });

  // An empty project is usually the wrong branch: the operator learns which one before a
  // model turn is spent on a note that silently leaves it out.
  it("refuses the whole note, naming the project, when one project has no commits", async () => {
    const { svc } = twoRepos({ "/repos/alpha": [commit] });
    await expect(svc.generate(ask)).rejects.toMatchObject({
      code: "no_commits_in_range",
      params: { project: "Бета", branch: "main", from: "2026-08-01", to: "2026-08-31" },
    });
    expect(calls).toHaveLength(0);
  });

  // Every subject goes into the prompt, so a period too long to list in one note is refused
  // with its count before any spawn — never written up with changes left out.
  it("refuses a period whose commit subjects overflow the prompt ceiling, before any spawn", async () => {
    const many = Array.from({ length: 1500 }, (_, i) => ({ ...commit, subject: `зміна ${i} `.padEnd(80, "·") }));
    const { svc } = twoRepos({ "/repos/alpha": many, "/repos/beta": many });
    await expect(svc.generate(ask)).rejects.toMatchObject({
      code: "too_many_commits",
      params: { count: 3000, from: "2026-08-01", to: "2026-08-31" },
    });
    expect(calls).toHaveLength(0);
  });
});
