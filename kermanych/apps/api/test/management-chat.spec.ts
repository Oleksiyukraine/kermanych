import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ManagementChatAsk, RpcEvent, RpcExtensionUIResponse } from "@kermanych/core";

// The same seam supervisor.chat.spec.ts uses: swap the transport, keep the service. Here it
// also plays a scripted turn back at the service, because what this service IS is the loop
// that turns an omp event burst into one reply.
type SpawnOpts = { cwd: string; tools?: string[] };
const spawned: SpawnOpts[] = [];
const sent: { kind: "prompt" | "followUp"; text: string }[] = [];
const answered: RpcExtensionUIResponse[] = [];
let stopped = 0;
// One entry per turn, consumed in order: the events the child "emits" once it is written to.
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
    answerUi(res: RpcExtensionUIResponse) {
      answered.push(res);
    }
    prompt(text: string) {
      sent.push({ kind: "prompt", text });
      this.play();
    }
    followUp(text: string) {
      sent.push({ kind: "followUp", text });
      this.play();
    }
    steer() {}
    private play() {
      for (const e of turns.shift() ?? [{ type: "agent_end" }]) for (const cb of this.cbs) cb(e);
    }
  }
  return { RpcSession: FakeRpc };
});

import { ManagementChatService } from "../src/management/management-chat.service";
import { RegistryService } from "../src/registry/registry.service";

function make() {
  const registry = new RegistryService(":memory:");
  registry.upsertProject({ id: "p1", name: "Альфа", localRepoPath: "/repos/alpha" });
  return new ManagementChatService(registry);
}

function ask(text: string): ManagementChatAsk {
  return {
    conversationId: "management:p1",
    projectId: "p1",
    workspaceProjects: [{ id: "p1" }],
    text,
    context: { workspaceName: "Acme", projectName: "Альфа", section: "management-risks", risks: [] },
  };
}

// One assistant answer, closed the way omp closes it: streamed text, a message_end carrying
// the turn accounting, then the terminal agent_end the service waits for.
function reply(text: string): RpcEvent[] {
  return [
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } },
    {
      type: "message_end",
      message: { role: "assistant", model: "opus-5", usage: { input: 10, output: 5, cost: { total: 0.01 } } },
    },
    { type: "agent_end", isTerminal: true },
  ];
}

beforeEach(() => {
  spawned.length = 0;
  sent.length = 0;
  answered.length = 0;
  stopped = 0;
  turns = [];
});

describe("ManagementChatService", () => {
  it("prompts once and follows up into the same child", async () => {
    const svc = make();
    turns = [reply("привіт"), reply("і ще")];
    await svc.ask(ask("перше"));
    await svc.ask(ask("друге"));
    expect(spawned).toHaveLength(1);
    // Read-only tools and the scoped workspace's first bound repo — no worktree, no branch.
    expect(spawned[0]?.tools).toEqual(["read", "grep", "glob"]);
    expect(spawned[0]?.cwd).toBe("/repos/alpha");
    expect(sent.map((s) => s.kind)).toEqual(["prompt", "followUp"]);
    // The contract is sent once: the child still remembers it on turn two.
    expect(sent[0]?.text).toContain("ПРОТОКОЛ ДІЙ");
    expect(sent[1]?.text).not.toContain("ПРОТОКОЛ ДІЙ");
    expect(sent[1]?.text).toContain("друге");
  });

  it("parses an action block out and hands back prose without it", async () => {
    const svc = make();
    turns = [
      reply(
        'Цей розділ ще не працює.\n\n```kermanych-action\n{"kind":"unsupported","section":"management-releases","request":"додати нотатку релізу"}\n```',
      ),
    ];
    const r = await svc.ask(ask("додай нотатку релізу 2.1"));
    expect(r.actions).toEqual([
      { kind: "unsupported", section: "management-releases", request: "додати нотатку релізу" },
    ]);
    expect(r.text).toBe("Цей розділ ще не працює.");
    expect(r.rejected).toEqual([]);
    // The turn is debited on the connected plan, and the reply says what it cost.
    expect(r.model).toBe("opus-5");
    expect(r.usage).toEqual({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it("cancels an interactive request instead of hanging on it", async () => {
    const svc = make();
    turns = [
      [
        { type: "extension_ui_request", id: "ui-1", method: "input", message: "Який саме розділ?" },
        ...reply("Який саме розділ ти маєш на увазі?"),
      ],
    ];
    const r = await svc.ask(ask("зміни щось у менеджменті"));
    expect(answered).toEqual([{ type: "extension_ui_response", id: "ui-1", cancelled: true }]);
    expect(r.notices.some((n) => n.includes("інтерактивне вікно"))).toBe(true);
    expect(r.text).toBe("Який саме розділ ти маєш на увазі?");
  });

  it("stops the child on reset, so the next ask starts a new conversation", async () => {
    const svc = make();
    turns = [reply("перша розмова")];
    await svc.ask(ask("перше"));
    await svc.reset("management:p1");
    expect(stopped).toBe(1);
    turns = [reply("друга розмова")];
    await svc.ask(ask("знову перше"));
    expect(spawned).toHaveLength(2);
    // A new child knows nothing, so it gets the contract again — not a follow_up.
    expect(sent.map((s) => s.kind)).toEqual(["prompt", "prompt"]);
  });

  // The api parses and validates; it never writes. A well-formed risk comes back as an
  // action for the BROWSER to execute under the user's own JWT, and a malformed one comes
  // back as a rejection — «нічого не сталося» while the prose says otherwise is the one
  // outcome the operator cannot detect.
  it("hands a validated write action to the browser and reports a malformed one", async () => {
    const svc = make();
    const risk = {
      kind: "threat",
      category: "external",
      cause: "клієнт мовчить",
      event: "рахунок не оплачено",
      consequence: "касовий розрив",
      probability: 4,
      impact: 5,
      response: "reduce",
      responseActions: "офіційна вимога, призупинення робіт",
    };
    turns = [
      reply("Заношу.\n\n```kermanych-action\n" + JSON.stringify({ kind: "risk.create", risk }) + "\n```"),
      reply('Ще одна.\n\n```kermanych-action\n{"kind":"risk.create","title":"Клієнт не платить"}\n```'),
    ];
    const ok = await svc.ask(ask("зафіксуй ризик"));
    expect(ok.actions).toEqual([{ kind: "risk.create", risk }]);
    expect(ok.rejected).toEqual([]);
    expect(ok.text).toBe("Заношу.");

    const bad = await svc.ask(ask("і ще один"));
    expect(bad.actions).toEqual([]);
    expect(bad.rejected).toEqual(["risk.create без об'єкта risk"]);
  });
});
