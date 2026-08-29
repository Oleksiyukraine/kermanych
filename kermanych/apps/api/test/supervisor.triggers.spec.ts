// kermanych/apps/api/test/supervisor.triggers.spec.ts
// The half of triggers that TTSR cannot do: an `operator`-sourced trigger is matched by
// Kermanych, in sendMessage, before the text ever reaches the child — because Kermanych is
// the only party that sees the operator's message, and a child has no callback into it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProjectTrigger } from "@kermanych/cloud";
import type { TranscriptEntry } from "@kermanych/core";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { SkillsService } from "../src/skills/skills.service";

type SpawnOpts = { cwd: string; configPath?: string; extensionPath?: string };
const started: SpawnOpts[] = [];
const sent: { kind: "prompt" | "follow_up" | "steer"; text: string }[] = [];
// Flipped to false to force the next send down the resume path, which is the only await
// inside a delivery long enough to hold two sends open at once.
let alive = true;
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    constructor(opts: SpawnOpts) {
      started.push(opts);
    }
    onEvent() {}
    onExit() {}
    async start() {}
    isAlive() {
      return alive;
    }
    async getState() {
      return {};
    }
    async getAllMessages() {
      return [];
    }
    async switchSession() {}
    async stop() {}
    prompt(text: string) {
      sent.push({ kind: "prompt", text });
    }
    followUp(text: string) {
      sent.push({ kind: "follow_up", text });
    }
    steer(text: string) {
      sent.push({ kind: "steer", text });
    }
  }
  return { RpcSession: FakeRpc };
});

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { offlineAuth } from "./offline-auth";

const t = (over: Partial<ProjectTrigger>): ProjectTrigger => ({
  projectId: "p1", id: "wants-pr", label: "Хоче ПР", enabled: true,
  source: "operator", pattern: "хочу зробити ПР", pathGlobs: [],
  action: "agent", target: "resolve-conflict", mode: "remind", repeat: "once", ...over,
});

// Only the three members the message path touches. `materializeTriggers` answers for the
// launch, `operatorTriggers` for the match, `assignedForNames` for a `skill` action's body —
// and `assignedFor` because the agent a fired trigger runs renders its own instruction.
function make(triggers: ProjectTrigger[], blocks: Record<string, string> = {}) {
  const registry = new RegistryService(":memory:");
  const worktree = {
    isGitRepo: vi.fn().mockResolvedValue(true),
    currentBranch: vi.fn().mockResolvedValue("main"),
    hasUncommitted: vi.fn().mockResolvedValue(false),
    unmergedFiles: vi.fn().mockResolvedValue(["src/a.ts"]),
  } as unknown as WorktreeService;
  const skills = {
    materialize: async () => ({ view: [] }),
    assignedFor: async () => ({ block: "", view: [], missing: [] }),
    materializeTriggers: async () => ({ packagePath: "/tmp/kmq-triggers/s1" }),
    operatorTriggers: async () => triggers,
    assignedForNames: async (_p: string, names: readonly string[]) => {
      const block = names.map((n) => blocks[n] ?? "").filter(Boolean).join("\n");
      return { block, view: [], missing: names.filter((n) => !blocks[n]) };
    },
  } as unknown as SkillsService;
  const sup = new SupervisorService(registry, worktree, offlineAuth(), skills);
  const project = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
  return { sup, registry, project };
}

const notices = (rows: TranscriptEntry[]): string[] =>
  rows.filter((r) => r.kind === "notice").map((r) => (r as Extract<TranscriptEntry, { kind: "notice" }>).text);

beforeEach(() => {
  started.length = 0;
  sent.length = 0;
  alive = true;
});

describe("the trigger package reaches the omp child", () => {
  it("is passed as extensionPath, alongside the library's --config", async () => {
    const { sup, project } = make([]);
    await sup.createChat(project.id);
    expect(started.at(-1)).toMatchObject({ extensionPath: "/tmp/kmq-triggers/s1" });
  });

  it("is omitted when materialisation fails, and the launch goes ahead regardless", async () => {
    // A failing materialisation degrades to "no rules", exactly as a failing library degrades
    // to "no --config": a trigger is an addition to a session, never a precondition for one.
    const registry = new RegistryService(":memory:");
    const worktree = { isGitRepo: vi.fn().mockResolvedValue(true) } as unknown as WorktreeService;
    const skills = {
      materialize: async () => ({ view: [] }),
      assignedFor: async () => ({ block: "", view: [], missing: [] }),
      materializeTriggers: async () => {
        throw new Error("cloud unreachable");
      },
      operatorTriggers: async () => [],
    } as unknown as SkillsService;
    const sup = new SupervisorService(registry, worktree, offlineAuth(), skills);
    const project = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });

    const chat = await sup.createChat(project.id);

    expect(chat.status).toBe("done");
    expect(started.at(-1)).not.toHaveProperty("extensionPath");
  });
});

describe("an operator trigger fires before the message is forwarded", () => {
  it("prepends the resolved skill text and still forwards the operator's message", async () => {
    const { sup, project } = make(
      [t({ id: "env", action: "skill", target: "how-we-add-env", pattern: "env" })],
      { "how-we-add-env": "ADD ENV THE KERMANYCH WAY" },
    );
    const chat = await sup.createChat(project.id);
    await sup.sendMessage(chat.id, "додай env для API", "prompt");

    expect(sent.at(-1)!.text).toBe("ADD ENV THE KERMANYCH WAY\n\nдодай env для API");
    // The operator's own row stays what they typed; the notice is what makes the trigger
    // visible, so a session that behaved differently can be read back.
    const rows = sup.getTranscript(chat.id);
    expect(rows.find((r) => r.kind === "user_text")).toMatchObject({ text: "додай env для API" });
    expect(notices(rows)).toEqual(['тригер «Хоче ПР» додав скіл «how-we-add-env»']);
  });

  it("runs the named agent INSTEAD of forwarding the message", async () => {
    const { sup, project } = make([t({ pattern: "конфлікт" })]);
    const chat = await sup.createChat(project.id);
    await sup.sendMessage(chat.id, "розберись із цим, це конфлікт", "prompt");

    // Exactly one message reached the child, and it is the agent's instruction — not the
    // operator's text, which the agent's own instruction already says.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("A git merge is in progress");
    expect(sent[0]!.text).not.toContain("розберись із цим");
    expect(notices(sup.getTranscript(chat.id))).toEqual([
      "тригер «Хоче ПР» запускає «Вирішувач конфліктів»",
    ]);
  });

  it("never matches Kermanych's own prompt, so a fired agent cannot loop", async () => {
    // `conflict` matches the resolve-conflict instruction itself, which goes back through
    // sendMessage. `source: "operator"` means the OPERATOR wrote the text; without that
    // exemption this is an infinite recursion.
    const { sup, project } = make([t({ pattern: "conflict|конфлікт" })]);
    const chat = await sup.createChat(project.id);
    await sup.sendMessage(chat.id, "тут конфлікт", "prompt");
    expect(sent).toHaveLength(1);
  });

  it("never rewrites an agent Kermanych started on the operator's own click", async () => {
    // Pressing «Вирішити конфлікт» prompts the child with Kermanych's instruction, not the
    // operator's words. A trigger that replaced it would be rewriting Kermanych.
    const { sup, project } = make([t({ action: "skill", target: "s", pattern: "conflict" })], { s: "NOPE" });
    const chat = await sup.createChat(project.id);
    await sup.resolveConflict(chat.id);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.text.startsWith("A git merge is in progress")).toBe(true);
    expect(notices(sup.getTranscript(chat.id))).toEqual([]);
  });

  it("still matches an operator message that arrives while Kermanych's own send is in flight", async () => {
    // The exemption is scoped to ONE call, not to a window on the session. With a per-session
    // flag, a genuine operator message landing during a self-authored send would silently
    // lose its trigger — the exact "fires and does nothing" failure this feature removes.
    const gate = Promise.withResolvers<void>();
    let launched = false;
    const registry = new RegistryService(":memory:");
    const worktree = {
      isGitRepo: vi.fn().mockResolvedValue(true),
      currentBranch: vi.fn().mockResolvedValue("main"),
      unmergedFiles: vi.fn().mockResolvedValue(["src/a.ts"]),
    } as unknown as WorktreeService;
    const skills = {
      // doResume awaits this, so both sends park here and overlap for as long as the gate holds.
      materialize: async () => {
        if (launched) await gate.promise;
        return { view: [] };
      },
      assignedFor: async () => ({ block: "", view: [], missing: [] }),
      assignedForNames: async () => ({ block: "SKILL", view: [], missing: [] }),
      materializeTriggers: async () => ({}),
      operatorTriggers: async () => [t({ id: "aaa", action: "skill", target: "s", pattern: "конфлікт" })],
    } as unknown as SkillsService;
    const sup = new SupervisorService(registry, worktree, offlineAuth(), skills);
    const project = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await sup.createChat(project.id);
    launched = true;
    alive = false; // the next delivery resumes, and the resume is what parks on the gate

    const kermanych = sup.resolveConflict(chat.id);
    // A macrotask boundary flushes every already-resolved await, so the self-authored send is
    // provably inside its own delivery — and its resume is deduped, so the operator joins it.
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 0);
    await tick.promise;
    const operator = sup.sendMessage(chat.id, "тут конфлікт", "prompt");
    gate.resolve();
    await Promise.all([kermanych, operator]);

    expect(sent.map((x) => x.text)).toEqual([
      expect.stringContaining("A git merge is in progress"),
      "SKILL\n\nтут конфлікт",
    ]);
    expect(notices(sup.getTranscript(chat.id))).toEqual(["тригер «Хоче ПР» додав скіл «s»"]);
  });

  it("forwards the message untouched when the agent could not run", async () => {
    // The replacement is only earned while the agent actually ran: swallowing the operator's
    // message AND running nothing is the one outcome worse than either.
    const { sup, project } = make([t({ target: "no-such-agent", pattern: "запусти" })]);
    const chat = await sup.createChat(project.id);
    await sup.sendMessage(chat.id, "запусти щось", "prompt");

    expect(sent.at(-1)!.text).toBe("запусти щось");
    expect(notices(sup.getTranscript(chat.id)).at(-1)).toContain("не запустив агента");
  });

  it("reports a dangling skill target instead of dropping it", async () => {
    const { sup, project } = make([t({ action: "skill", target: "gone", pattern: "env" })]);
    const chat = await sup.createChat(project.id);
    await sup.sendMessage(chat.id, "додай env", "prompt");

    expect(sent.at(-1)!.text).toBe("додай env");
    expect(notices(sup.getTranscript(chat.id))).toEqual(['тригер «Хоче ПР»: скіл «gone» не знайдено']);
  });

  it("leaves a non-matching message and its transcript completely alone", async () => {
    const { sup, project } = make([t({ pattern: "^ніколи$" })], {});
    const chat = await sup.createChat(project.id);
    await sup.sendMessage(chat.id, "звичайне повідомлення", "follow_up");

    expect(sent).toEqual([{ kind: "follow_up", text: "звичайне повідомлення" }]);
    expect(notices(sup.getTranscript(chat.id))).toEqual([]);
  });

  it("costs an unparseable pattern its own trigger and nothing else", async () => {
    const { sup, project } = make(
      [t({ id: "aa-broken", pattern: "([unclosed" }), t({ id: "bb-good", action: "skill", target: "s", pattern: "env" })],
      { s: "BODY" },
    );
    const chat = await sup.createChat(project.id);
    await sup.sendMessage(chat.id, "додай env", "prompt");
    expect(sent.at(-1)!.text).toBe("BODY\n\nдодай env");
  });

  it("matches case-insensitively, as prose from a human requires", async () => {
    const { sup, project } = make([t({ action: "skill", target: "s", pattern: "хочу зробити пр" })], { s: "PR" });
    const chat = await sup.createChat(project.id);
    await sup.sendMessage(chat.id, "Хочу зробити ПР", "prompt");
    expect(sent.at(-1)!.text).toBe("PR\n\nХочу зробити ПР");
  });

  it("tries triggers in a stable order and fires exactly one", async () => {
    // operatorTriggers hands them over sorted by id, so a message two patterns both match
    // always picks the same winner.
    const { sup, project } = make(
      [t({ id: "aaa", action: "skill", target: "first", pattern: "env" }), t({ id: "bbb", action: "skill", target: "second", pattern: "env" })],
      { first: "FIRST", second: "SECOND" },
    );
    const chat = await sup.createChat(project.id);
    await sup.sendMessage(chat.id, "env", "prompt");
    expect(sent.at(-1)!.text).toBe("FIRST\n\nenv");
  });

  it("never runs an operator pattern against an oversized message", async () => {
    // An operator pattern comes from the cloud and runs on the api event loop, so a project
    // owner's backtracking regex would cost a MEMBER's process. The subject is bounded; past
    // the bound the trigger simply does not fire, with no exception and no blocked message.
    const { sup, project } = make([t({ action: "skill", target: "s", pattern: "env" })], { s: "BODY" });
    const chat = await sup.createChat(project.id);

    await sup.sendMessage(chat.id, "додай env", "prompt");
    expect(sent.at(-1)!.text).toBe("BODY\n\nдодай env");

    // Same pattern, same match, one character past the 16 KiB cap.
    const huge = `${"я".repeat(1 << 14)} env`;
    await sup.sendMessage(chat.id, huge, "prompt");
    expect(sent.at(-1)!.text).toBe(huge);
    // The operator's own row is still there and the message still went through; only the
    // trigger stayed out, and it added no second notice.
    expect(notices(sup.getTranscript(chat.id))).toEqual(["тригер «Хоче ПР» додав скіл «s»"]);
  });
});
