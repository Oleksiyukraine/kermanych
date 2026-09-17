import { describe, it, expect, vi } from "vitest";
import type { TranscriptEntry } from "@kermanych/core";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { SkillsService } from "../src/skills/skills.service";

// What the child was actually driven with. A `/compact` must reach the child as the `compact`
// RPC call, never as a prompt — so both are recorded and asserted apart.
const sent: string[] = [];
const compacted: (string | undefined)[] = [];
// When set, the fake child's compact rejects with this reason, standing in for a real omp
// refusal (e.g. an already-compacted session) so the error-notice path can be driven.
let compactError: string | null = null;
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    onEvent() {}
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
    prompt(text: string) {
      sent.push(text);
    }
    followUp(text: string) {
      sent.push(text);
    }
    steer(text: string) {
      sent.push(text);
    }
    async compact(customInstructions?: string) {
      if (compactError) throw new Error(compactError);
      compacted.push(customInstructions);
    }
  }
  return { RpcSession: FakeRpc };
});

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { offlineAuth } from "./offline-auth";

async function chat() {
  sent.length = 0;
  compacted.length = 0;
  compactError = null;
  const registry = new RegistryService(":memory:");
  const worktree = {
    isGitRepo: vi.fn().mockResolvedValue(true),
    currentBranch: vi.fn().mockResolvedValue("main"),
    hasUncommitted: vi.fn().mockResolvedValue(false),
  } as unknown as WorktreeService;
  const skills = {
    materialize: async () => ({ view: [] }),
    materializeTriggers: async () => ({}),
    operatorTriggers: async () => [],
    assignedForNames: async () => ({ block: "", view: [], missing: [] }),
  } as unknown as SkillsService;
  const sup = new SupervisorService(registry, worktree, offlineAuth(), skills);
  const project = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
  const session = await sup.createChat(project.id);
  return { sup, id: session.id, registry };
}

const notices = (entries: readonly TranscriptEntry[]) =>
  entries.filter((e): e is Extract<TranscriptEntry, { kind: "notice" }> => e.kind === "notice");

describe("the /compact command drives compaction instead of a prompt", () => {
  it("calls compact() with no instructions and reports success", async () => {
    const { sup, id } = await chat();

    await sup.sendMessage(id, "/compact", "prompt");

    // The child was compacted, never prompted.
    expect(compacted).toEqual([undefined]);
    expect(sent).toEqual([]);
    const entries = sup.getTranscript(id);
    // The typed command line stays visible, slash and all.
    expect(entries.find((e) => e.kind === "user_text")).toMatchObject({ text: "/compact" });
    // A notice says the context was compacted, carrying its localizable code.
    expect(notices(entries)).toMatchObject([{ code: "context_compacted", level: "info" }]);
  });

  it("forwards trailing text as custom instructions", async () => {
    const { sup, id } = await chat();

    await sup.sendMessage(id, "/compact focus on the auth module", "steer");

    expect(compacted).toEqual(["focus on the auth module"]);
    expect(sent).toEqual([]);
  });

  it("does not let /compact set the fresh chat's task", async () => {
    const { sup, id, registry } = await chat();

    await sup.sendMessage(id, "/compact", "prompt");

    // A command is not the ask, so it must not name the chat.
    const session = registry.listSessions().find((s) => s.id === id);
    expect(session?.task ?? "").toBe("");
  });

  it("surfaces a compaction failure as an error notice", async () => {
    const { sup, id } = await chat();
    compactError = "Nothing to compact";

    await sup.sendMessage(id, "/compact", "prompt");

    expect(sent).toEqual([]);
    expect(notices(sup.getTranscript(id))).toMatchObject([
      { code: "context_compact_failed", level: "error", params: { reason: "Nothing to compact" } },
    ]);
  });

  it("leaves an ordinary message that merely mentions compact untouched", async () => {
    const { sup, id } = await chat();

    await sup.sendMessage(id, "please /compacted the logs", "prompt");

    expect(compacted).toEqual([]);
    expect(sent).toEqual(["please /compacted the logs"]);
  });
});
