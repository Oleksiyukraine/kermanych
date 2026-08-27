import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RpcEvent, TranscriptEntry } from "@kermanych/core";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { Materialized } from "../src/skills/skills.service";
import type { SkillsService } from "../src/skills/skills.service";

// The subset of RpcSession options this file asserts on, plus the supervisor's own event
// callback: the two halves of the skill wiring — what the child is launched with, and how the
// rows it reports are labelled. The other supervisor specs pass `stubSkills()`, whose empty
// view exercises neither half.
type SpawnOpts = { cwd: string; tools?: string[]; configPath?: string };
const started: SpawnOpts[] = [];
let emit: (e: RpcEvent) => void = () => {};
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    constructor(opts: SpawnOpts) {
      started.push(opts);
    }
    onEvent(cb: (e: RpcEvent) => void) {
      emit = cb;
    }
    onExit() {}
    async start() {}
    isAlive() {
      return true;
    }
    async getState() {
      return {};
    }
    async getAllMessages() {
      return [];
    }
    async switchSession() {}
    async stop() {}
    prompt() {}
    followUp() {}
    steer() {}
  }
  return { RpcSession: FakeRpc };
});

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { offlineAuth } from "./offline-auth";

// Only `materialize` is on the path under test; the DI seam is cast once, as the other
// supervisor specs do for WorktreeService.
function skillsStub(materialize: (projectId: string, cwd: string) => Promise<Materialized>): SkillsService {
  return { materialize } as unknown as SkillsService;
}

function make(skills: SkillsService) {
  const registry = new RegistryService(":memory:");
  const worktree = {
    isGitRepo: vi.fn().mockResolvedValue(true),
    currentBranch: vi.fn().mockResolvedValue("main"),
    hasUncommitted: vi.fn().mockResolvedValue(false),
  } as unknown as WorktreeService;
  const sup = new SupervisorService(registry, worktree, offlineAuth(), skills);
  const project = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
  return { sup, registry, project };
}

beforeEach(() => {
  started.length = 0;
  emit = () => {};
  // Fixes skillsRoot() so the materialised path a badge points at is an exact string.
  process.env.KERMANYCH_SKILLS_HOME = "/tmp/kmq-skills-home";
});
afterEach(() => {
  delete process.env.KERMANYCH_SKILLS_HOME;
});

describe("the overlay reaches the omp child", () => {
  it("is passed as configPath, scanned in the session's own directory", async () => {
    const seen: { projectId: string; cwd: string }[] = [];
    const { sup, project } = make(
      skillsStub(async (projectId, cwd) => {
        seen.push({ projectId, cwd });
        return { configPath: "/tmp/p1.config.yml", view: [] };
      }),
    );

    await sup.createChat(project.id);

    expect(started.at(-1)).toMatchObject({ cwd: "/tmp/proj", configPath: "/tmp/p1.config.yml" });
    // A chat runs in the bound repository, so that is the directory scanned for the
    // repository skills that would shadow the library.
    expect(seen).toEqual([{ projectId: "p1", cwd: "/tmp/proj" }]);
  });

  it("is omitted entirely when the overlay was not written", async () => {
    // `materialize` leaves configPath absent when the write failed — passing omp a --config
    // that does not exist would break the session outright.
    const { sup, project } = make(skillsStub(async () => ({ view: [], stale: true })));

    await sup.createChat(project.id);

    expect(started.at(-1)).not.toHaveProperty("configPath");
  });

  it("does not block the launch when the library fails outright", async () => {
    const { sup, project } = make(
      skillsStub(async () => {
        throw new Error("cloud unreachable");
      }),
    );

    const chat = await sup.createChat(project.id);

    expect(chat.status).toBe("done");
    expect(started.at(-1)).not.toHaveProperty("configPath");
  });
});

describe("the materialised view labels the session's skill rows", () => {
  it("badges a library skill and a repo-shadowed one differently", async () => {
    const { sup, project } = make(
      skillsStub(async () => ({
        configPath: "/tmp/p1.config.yml",
        view: [
          { name: "kermanych-session", description: "d", source: "default" },
          { name: "house-style", description: "d", source: "project" },
          {
            name: "probe-beta",
            description: "d",
            source: "default",
            shadowedByRepo: "/tmp/proj/.claude/skills/probe-beta/SKILL.md",
          },
        ],
      })),
    );
    const chat = await sup.createChat(project.id);

    for (const [id, name] of [["c1", "kermanych-session"], ["c2", "house-style"], ["c3", "probe-beta"]]) {
      emit({ type: "tool_execution_start", toolName: "read", toolCallId: id, args: { path: `skill://${name}` } });
      emit({
        type: "tool_execution_end", toolName: "read", toolCallId: id, isError: false,
        result: { content: [{ type: "text", text: "body" }] },
      });
    }

    const rows = sup
      .getTranscript(chat.id)
      .filter((e): e is Extract<TranscriptEntry, { kind: "tool" }> => e.kind === "tool");
    expect(rows.map((r) => [r.id, r.tool, r.status, r.stat, r.intent])).toEqual([
      ["c1", "skill", "ok", "бібліотека", "/tmp/kmq-skills-home/skills/p1/kermanych-session/SKILL.md"],
      ["c2", "skill", "ok", "проєкт", "/tmp/kmq-skills-home/skills/p1/house-style/SKILL.md"],
      // The agent read the REPOSITORY's file, so the badge says so and the expanded row
      // points at that file — never at a Kermanych path.
      ["c3", "skill", "ok", "репо", "/tmp/proj/.claude/skills/probe-beta/SKILL.md"],
    ]);
  });

  it("leaves a skill the view does not carry unlabelled rather than guessing", async () => {
    const { sup, project } = make(skillsStub(async () => ({ configPath: "/tmp/p1.config.yml", view: [] })));
    const chat = await sup.createChat(project.id);

    emit({ type: "tool_execution_start", toolName: "read", toolCallId: "c1", args: { path: "skill://unknown-skill" } });
    emit({
      type: "tool_execution_end", toolName: "read", toolCallId: "c1", isError: false,
      result: { content: [{ type: "text", text: "body" }] },
    });

    const row = sup.getTranscript(chat.id).find((e): e is Extract<TranscriptEntry, { kind: "tool" }> => e.kind === "tool");
    expect(row).toMatchObject({ tool: "skill", status: "ok", target: "unknown-skill" });
    expect(row!.stat).toBeUndefined();
    expect(row!.intent).toBeUndefined();
  });

  it("omits the materialised path on a stale launch, keeping the repository's real one", async () => {
    const { sup, project } = make(
      skillsStub(async () => ({
        configPath: "/tmp/p1.config.yml",
        stale: true,
        view: [
          { name: "kermanych-session", description: "d", source: "default" },
          {
            name: "probe-beta",
            description: "d",
            source: "default",
            shadowedByRepo: "/tmp/proj/.claude/skills/probe-beta/SKILL.md",
          },
        ],
      })),
    );
    const chat = await sup.createChat(project.id);

    for (const [id, name] of [["c1", "kermanych-session"], ["c2", "probe-beta"]]) {
      emit({ type: "tool_execution_start", toolName: "read", toolCallId: id, args: { path: `skill://${name}` } });
      emit({
        type: "tool_execution_end", toolName: "read", toolCallId: id, isError: false,
        result: { content: [{ type: "text", text: "body" }] },
      });
    }

    const rows = sup
      .getTranscript(chat.id)
      .filter((e): e is Extract<TranscriptEntry, { kind: "tool" }> => e.kind === "tool");
    // A degraded materialise may not have written the file, and a link to a path that is not
    // there is worse than no link. A shadowed row's repository path came from a scan that
    // found the file, so it survives.
    expect(rows.map((r) => [r.id, r.stat, r.intent])).toEqual([
      ["c1", "бібліотека", undefined],
      ["c2", "репо", "/tmp/proj/.claude/skills/probe-beta/SKILL.md"],
    ]);
  });
});
