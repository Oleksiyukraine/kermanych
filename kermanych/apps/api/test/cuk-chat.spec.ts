// apps/api/test/cuk-chat.spec.ts
// ЦУК on the shared chat pool: one tool-less child per user on the fast model, the contract
// on the first turn only, `cuk.*` actions parsed out of the reply. The transport is swapped
// the way management-chat.spec.ts swaps it, and the child plays a scripted turn back.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CukChatAsk, CukContext, ImageInput, RpcEvent } from "@kermanych/core";

type SpawnOpts = { cwd: string; tools?: string[]; noTools?: boolean; model?: string; mcp?: unknown };
const spawned: SpawnOpts[] = [];
const sent: { kind: "prompt" | "followUp"; text: string; images?: ImageInput[] }[] = [];
let stopped = 0;
let turns: RpcEvent[][] = [];

vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    droppedFrames = 0;
    private cbs: ((e: RpcEvent) => void)[] = [];
    constructor(opts: SpawnOpts) {
      spawned.push(opts);
    }
    onEvent(cb: (e: RpcEvent) => void) {
      this.cbs.push(cb);
    }
    onExit() {}
    async start() {}
    isAlive() {
      return true;
    }
    async stop() {
      stopped++;
    }
    answerUi() {}
    prompt(text: string, images?: ImageInput[]) {
      sent.push({ kind: "prompt", text, ...(images?.length ? { images } : {}) });
      this.play();
    }
    followUp(text: string, images?: ImageInput[]) {
      sent.push({ kind: "followUp", text, ...(images?.length ? { images } : {}) });
      this.play();
    }
    steer() {}
    private async play() {
      for (const e of turns.shift() ?? [{ type: "agent_end" }]) for (const cb of this.cbs) cb(e);
    }
  }
  return { RpcSession: FakeRpc };
});

import { CukChatService } from "../src/cuk/cuk-chat.service";
import { RegistryService } from "../src/registry/registry.service";

const context: CukContext = {
  view: "agents",
  workspace: "Acme",
  project: "Альфа",
  workspaces: [{ name: "Acme", role: "owner", selected: true }],
  projects: [{ name: "Альфа", workspace: "Acme", bound: true, selected: true }],
  sessions: [{ ref: "a1b2c3", project: "Альфа", name: "Вхід через Google", kind: "agent", status: "waiting_input", waiting: true, archived: false }],
  sessionsOmitted: 0,
  board: [],
  boardOmitted: 0,
  places: [{ id: "settings-project", label: "Налаштування проєкту" }],
  notes: [{ text: "перевірити реліз", kind: "check", done: false }],
  now: "2026-11-06T18:42+02:00",
  timeZone: "Europe/Kyiv",
  schedules: [{ ref: "1a2b3c4d", name: "Вітаміни", type: "reminder", when: "щодня о 19:00", next: "2026-11-06T19:00", enabled: true }],
  skills: ["weekly-report"],
};

function ask(text: string, over: Partial<CukChatAsk> = {}): CukChatAsk {
  return { text, context, ...over };
}

function reply(text: string): RpcEvent[] {
  return [
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } },
    {
      type: "message_end",
      message: { role: "assistant", model: "claude-sonnet-5", usage: { input: 10, output: 5, cost: { total: 0.01 } } },
    },
    { type: "agent_end", isTerminal: true },
  ];
}

function make() {
  return new CukChatService(new RegistryService(":memory:"));
}

beforeEach(() => {
  spawned.length = 0;
  sent.length = 0;
  stopped = 0;
  turns = [];
});

describe("CukChatService", () => {
  it("spawns one tool-less child on the fast model, prompts once and follows up", async () => {
    const svc = make();
    turns = [reply("привіт"), reply("і ще")];
    await svc.ask(ask("хто чекає на мою відповідь?"), "u1");
    await svc.ask(ask("а що на дошці?"), "u1");
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.noTools).toBe(true);
    expect(spawned[0]?.tools).toBeUndefined();
    expect(spawned[0]?.mcp).toBeUndefined();
    expect(spawned[0]?.model).toBe("claude-sonnet-5");
    expect(sent.map((s) => s.kind)).toEqual(["prompt", "followUp"]);
    // The contract rides the first turn only; the digest rides both.
    expect(sent[0]?.text).toContain("Ти — ЦУК");
    expect(sent[1]?.text).not.toContain("Ти — ЦУК");
    for (const s of sent) {
      expect(s.text).toContain("a1b2c3");
      expect(s.text).toContain("#1 [ ] перевірити реліз");
    }
    expect(sent[1]?.text).toContain("а що на дошці?");
    // The schedule verbs ride the contract; the clock, the tasks and the skills ride every turn.
    expect(sent[0]?.text).toContain('"kind": "schedule.create"');
    expect(sent[0]?.text).toContain("ТІЛЬКИ аналізує");
    for (const s of sent) {
      expect(s.text).toContain("Зараз: 2026-11-06T18:42+02:00 · часовий пояс Europe/Kyiv");
      expect(s.text).toContain("- 1a2b3c4d · «Вітаміни» · reminder · без проєкту · щодня о 19:00 · 2026-11-06T19:00 · увімкнена");
      expect(s.text).toContain("- weekly-report");
    }
  });

  it("hands validated actions to the browser and reports a refused one", async () => {
    const svc = make();
    turns = [
      reply(
        'Підготував, підтвердіть на картці.\n\n```kermanych-action\n[{"kind":"agent.start","project":"Альфа","task":"Полагодити вхід"},{"kind":"navigate","place":"settings-project"},{"kind":"session.delete","session":"a1b2c3"}]\n```',
      ),
    ];
    const r = await svc.ask(ask("запусти агента полагодити вхід і відкрий налаштування"), "u1");
    expect(r.text).toBe("Підготував, підтвердіть на картці.");
    expect(r.actions).toEqual([
      { kind: "agent.start", project: "Альфа", task: "Полагодити вхід" },
      { kind: "navigate", place: "settings-project" },
    ]);
    // An irreversible verb is not in the vocabulary: refused, never executed.
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.code).toBe("action_kind_unknown");
    expect(r.model).toBe("claude-sonnet-5");
    expect(r.usage).toEqual({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
  });

  it("passes images through the image slots", async () => {
    const svc = make();
    turns = [reply("бачу")];
    const data = Buffer.from("png-bytes").toString("base64");
    await svc.ask(ask("що на скріні?", { attachments: [{ name: "s.png", mimeType: "image/png", data }] }), "u1");
    expect(sent[0]?.images).toEqual([{ data, mimeType: "image/png" }]);
  });

  it("keeps one conversation per user", async () => {
    const svc = make();
    turns = [reply("раз"), reply("два"), reply("три")];
    await svc.ask(ask("перше"), "u1");
    await svc.ask(ask("перше"), "u2");
    await svc.ask(ask("друге"), "u1");
    expect(spawned).toHaveLength(2);
    expect(sent.map((s) => s.kind)).toEqual(["prompt", "prompt", "followUp"]);
  });

  it("drops the child on reset, so the next ask starts a new conversation", async () => {
    const svc = make();
    turns = [reply("перша"), reply("друга")];
    await svc.ask(ask("перше"), "u1");
    expect(await svc.reset("u1")).toEqual({ ok: true });
    expect(stopped).toBe(1);
    await svc.ask(ask("знову"), "u1");
    expect(spawned).toHaveLength(2);
    expect(sent.map((s) => s.kind)).toEqual(["prompt", "prompt"]);
    expect(sent[1]?.text).toContain("Ти — ЦУК");
  });

  it("resetting one user leaves another's conversation alone", async () => {
    const svc = make();
    turns = [reply("раз"), reply("два"), reply("три")];
    await svc.ask(ask("перше"), "u1");
    await svc.ask(ask("перше"), "u2");
    await svc.reset("u1");
    await svc.ask(ask("друге"), "u2");
    expect(spawned).toHaveLength(2);
    expect(sent[2]?.kind).toBe("followUp");
  });

  it("threads the operator's locale into the contract", async () => {
    const svc = make();
    turns = [reply("ok")];
    await svc.ask(ask("who is waiting?", { locale: "en" }), "u1");
    expect(sent[0]?.text).toContain("Відповідай англійською мовою (en).");
  });
});
