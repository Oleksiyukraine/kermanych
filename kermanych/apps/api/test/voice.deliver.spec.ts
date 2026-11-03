import { describe, it, expect, vi } from "vitest";
import { VOICE_NOTE, voiceMessagePrompt } from "@kermanych/core";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { SkillsService } from "../src/skills/skills.service";
import { messagesToTranscript } from "../src/supervisor/messages-to-transcript";

// What the child was told (docs/specs/2026-11-02-voice-conversation.md, decision 6): the voice
// note in front of the operator's words, while the transcript keeps the words alone.
const sent: string[] = [];
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
  }
  return { RpcSession: FakeRpc };
});

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { offlineAuth } from "./offline-auth";

async function chat() {
  sent.length = 0;
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
  } as unknown as SkillsService;
  const sup = new SupervisorService(registry, worktree, offlineAuth(), skills);
  const project = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
  const session = await sup.createChat(project.id);
  return { sup, id: session.id };
}

describe("a voice message", () => {
  it("reaches the child under the voice note and shows the operator's words with the mark", async () => {
    const { sup, id } = await chat();

    await sup.sendMessage(id, "що робить цей файл?", "prompt", undefined, { voice: true });

    expect(sent).toEqual([`${VOICE_NOTE}\n\nщо робить цей файл?`]);
    expect(sup.getTranscript(id).find((e) => e.kind === "user_text")).toMatchObject({ text: "що робить цей файл?", via: "voice" });
  });

  it("is never read as a harness command", async () => {
    const { sup, id } = await chat();

    await sup.sendMessage(id, "/compact це я сказав", "prompt", undefined, { voice: true });

    expect(sent).toEqual([voiceMessagePrompt("/compact це я сказав")]);
  });

  it("leaves a typed message without the note or the mark", async () => {
    const { sup, id } = await chat();

    await sup.sendMessage(id, "типово", "prompt");

    expect(sent).toEqual(["типово"]);
    expect(sup.getTranscript(id).find((e) => e.kind === "user_text")).not.toHaveProperty("via");
  });

  it("reads back from history as the operator's words with the mark", () => {
    const { entries } = messagesToTranscript([
      { role: "user", content: [{ type: "text", text: voiceMessagePrompt("додай тест") }] },
      { role: "user", content: [{ type: "text", text: "набрав руками" }] },
    ]);
    expect(entries).toEqual([
      { kind: "user_text", id: "h1", at: 1, text: "додай тест", via: "voice" },
      { kind: "user_text", id: "h2", at: 2, text: "набрав руками" },
    ]);
  });
});
