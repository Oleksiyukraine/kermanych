import { describe, it, expect, vi } from "vitest";
import { DEFAULT_HELPERS, type TranscriptEntry } from "@kermanych/core";
import type { ProjectTrigger } from "@kermanych/cloud";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { SkillsService } from "../src/skills/skills.service";

// What the child was actually told. The operator's own text stays in the transcript, so this
// array is the only place the expanded message can be observed — which is the point of the
// feature: what the model reads and what the human reads differ by design.
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

const body = (name: string): string => {
  const hit = DEFAULT_HELPERS.find((h) => h.name === name);
  if (!hit) throw new Error(`no such helper: ${name}`);
  return hit.body.trim();
};

const trigger = (pattern: string): ProjectTrigger => ({
  projectId: "p1",
  id: "t1",
  label: "мій тригер",
  enabled: true,
  source: "operator",
  pattern,
  pathGlobs: [],
  action: "skill",
  target: "house-style",
  mode: "remind",
  repeat: "once",
});

async function chat(triggers: ProjectTrigger[] = []) {
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
    operatorTriggers: async () => triggers,
    assignedForNames: async () => ({ block: "БЛОК ТРИГЕРА", view: [], missing: [] }),
  } as unknown as SkillsService;
  const sup = new SupervisorService(registry, worktree, offlineAuth(), skills);
  const project = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
  const session = await sup.createChat(project.id);
  return { sup, id: session.id };
}

const notices = (entries: readonly TranscriptEntry[]): string[] =>
  entries.filter((e) => e.kind === "notice").map((e) => e.text);

describe("a helper token expands on its way to the child", () => {
  it("gives the child the instruction and the operator the text they typed", async () => {
    const { sup, id } = await chat();

    await sup.sendMessage(id, "/el10 що робить цей файл?", "prompt");

    expect(sent).toEqual([`${body("el10")}\n\nщо робить цей файл?`]);
    const entries = sup.getTranscript(id);
    // The visible row is the operator's own message, slash and all.
    expect(entries.find((e) => e.kind === "user_text")).toMatchObject({ text: "/el10 що робить цей файл?" });
    // Never invisible: a notice says which helper was added, the way a fired trigger does.
    expect(notices(entries)).toEqual(["хелпер «/el10» додав настанову"]);
  });

  it("names every helper of a leading run in one notice", async () => {
    const { sup, id } = await chat();

    await sup.sendMessage(id, "/deep /prove полагодь баг", "steer");

    expect(sent).toEqual([`${body("prove")}\n\nultrathink полагодь баг`]);
    expect(notices(sup.getTranscript(id))).toEqual(["хелпери «/deep», «/prove» додали настанову"]);
  });

  it("leaves an ordinary message byte-identical and says nothing about it", async () => {
    const { sup, id } = await chat();

    await sup.sendMessage(id, "полагодь баг у /usr/bin/env", "prompt");

    expect(sent).toEqual(["полагодь баг у /usr/bin/env"]);
    expect(notices(sup.getTranscript(id))).toEqual([]);
  });
});

describe("helpers and operator triggers compose", () => {
  it("puts the trigger's skill above the helper's instruction", async () => {
    const { sup, id } = await chat([trigger("баг")]);

    await sup.sendMessage(id, "/el10 полагодь баг", "prompt");

    expect(sent).toEqual([`БЛОК ТРИГЕРА\n\n${body("el10")}\n\nполагодь баг`]);
  });

  it("matches a trigger against the operator's text, never against a helper's body", async () => {
    // The pattern hits a word that only the el10 instruction contains. Matching after
    // expansion would fire a trigger the operator never wrote for.
    const { sup, id } = await chat([trigger("десятирічного")]);

    await sup.sendMessage(id, "/el10 полагодь баг", "prompt");

    expect(sent).toEqual([`${body("el10")}\n\nполагодь баг`]);
    expect(notices(sup.getTranscript(id))).toEqual(["хелпер «/el10» додав настанову"]);
  });
});
