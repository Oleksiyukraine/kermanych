import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_HELPERS } from "@kermanych/core";
import type { ImageInput, ManagementChatAsk, RpcEvent, RpcExtensionUIResponse } from "@kermanych/core";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The same seam supervisor.chat.spec.ts uses: swap the transport, keep the service. Here it
// also plays a scripted turn back at the service, because what this service IS is the loop
// that turns an omp event burst into one reply.
type SpawnOpts = { cwd: string; tools?: string[] };
const spawned: SpawnOpts[] = [];
const sent: { kind: "prompt" | "followUp"; text: string; images?: ImageInput[] }[] = [];
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
    prompt(text: string, images?: ImageInput[]) {
      sent.push({ kind: "prompt", text, ...(images?.length ? { images } : {}) });
      this.play();
    }
    followUp(text: string, images?: ImageInput[]) {
      sent.push({ kind: "followUp", text, ...(images?.length ? { images } : {}) });
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
    conversationId: "management:w1",
    workspaceId: "w1",
    workspaceProjects: [{ id: "p1" }],
    text,
    context: { workspaceName: "Acme", section: "management-risks", risks: [], members: [] },
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
        'Цей розділ ще не працює.\n\n```kermanych-action\n{"kind":"unsupported","section":"management-capacity","request":"додати людину в команду"}\n```',
      ),
    ];
    const r = await svc.ask(ask("додай людину в Team Capacity"));
    expect(r.actions).toEqual([
      { kind: "unsupported", section: "management-capacity", request: "додати людину в команду" },
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
    // The notice carries a stable code + the method the model tried, and keeps the
    // Ukrainian text as the fallback the UI shows when it does not know the code.
    const cancelled = r.notices.find((n) => n.code === "interactive_request_cancelled");
    expect(cancelled?.params).toEqual({ method: "input" });
    expect(cancelled?.text).toContain("інтерактивне вікно");
    expect(r.text).toBe("Який саме розділ ти маєш на увазі?");
  });

  it("stops the child on reset, so the next ask starts a new conversation", async () => {
    const svc = make();
    turns = [reply("перша розмова")];
    await svc.ask(ask("перше"));
    await svc.reset("management:w1");
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
    // The rejection now carries a stable code + the Ukrainian text as its fallback, the same
    // codes-on-the-wire contract notices use, so the UI can localize it.
    expect(bad.rejected).toHaveLength(1);
    expect(bad.rejected[0]).toMatchObject({ code: "risk_create_no_risk", text: "risk.create без об'єкта risk" });
  });

  // The Менеджмент turn is templated — contract, context markers, then the operator's text —
  // so a leading `/el10` stops being leading by the time the child sees it. Expansion has to
  // happen on this side of buildManagementTurn or the helper silently does nothing here.
  it("expands a helper into the turn the child receives", async () => {
    const svc = make();
    turns = [reply("ок")];
    await svc.ask(ask("/el10 що в нас із ризиками?"));
    const el10 = DEFAULT_HELPERS.find((h) => h.name === "el10")!;
    expect(sent[0]?.text).toContain(el10.body.trim());
    expect(sent[0]?.text).toContain("що в нас із ризиками?");
    expect(sent[0]?.text).not.toContain("/el10");
  });

  it("reports the helper it expanded", async () => {
    const svc = make();
    turns = [reply("ок")];
    const r = await svc.ask(ask("/el10 що в нас із ризиками?"));
    const helper = r.notices.find((n) => n.code === "helper_added_instruction");
    expect(helper?.params).toEqual({ names: "«/el10»", count: 1 });
    expect(helper?.text).toBe("хелпер «/el10» додав настанову");
  });

  // The operator's UI locale rides the ask into the model's contract (rule ґ), so the model
  // is told which language to answer in — the prompt body itself stays Ukrainian.
  it("threads the operator's locale into the contract directive", async () => {
    const svc = make();
    turns = [reply("ok")];
    await svc.ask({ ...ask("що в нас із ризиками?"), locale: "en" });
    expect(sent[0]?.text).toContain("Відповідай англійською мовою (en).");
  });

  // The operator's files, split by how the model reaches them: images ride the message
  // through omp's own image slots, documents land on disk under the conversation's temp
  // directory so the read tool can open them — and BOTH are named in the turn, because the
  // names are the vocabulary of `jira.ticket.create.attachments`.
  it("passes images to the child and lands documents on disk for the read tool", async () => {
    const svc = make();
    turns = [reply("бачу файли")];
    // Its OWN conversation id: sibling tests reset `management:w1`, and that reset removes
    // the conversation's attachment directory — sharing the key would race their cleanup.
    const withFiles = (text: string): ManagementChatAsk => ({ ...ask(text), conversationId: "management:w-files" });
    await svc.ask({
      ...withFiles("подивись на файли"),
      attachments: [
        { name: "screen.png", mimeType: "image/png", data: Buffer.from("png-bytes").toString("base64") },
        { name: "план.pdf", mimeType: "application/pdf", data: Buffer.from("pdf-bytes").toString("base64") },
      ],
    });
    expect(sent[0]?.images).toEqual([{ data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" }]);
    const path = join(tmpdir(), "kermanych-management", "management-w-files", "план.pdf");
    expect((await readFile(path)).toString()).toBe("pdf-bytes");
    expect(sent[0]?.text).toContain("── ДОЛУЧЕНІ ФАЙЛИ ──");
    expect(sent[0]?.text).toContain("- «screen.png» — зображення, додане до цього повідомлення");
    expect(sent[0]?.text).toContain(`- «план.pdf» — ${path}`);
    // The turn AFTER the files still lists them, marked as earlier — and this is the whole
    // bug: «прикріпи зображення до тікета» normally reaches the model one or two turns after
    // the image did (an assistant that asks `ticket.questions` first is the documented
    // path), and a turn with no file names has nothing to put in `attachments`.
    turns = [reply("ок")];
    await svc.ask(withFiles("а тепер створи тікет і прикріпи те зображення"));
    expect(sent[1]?.text).toContain("── ДОЛУЧЕНІ ФАЙЛИ ──");
    expect(sent[1]?.text).toContain("- «screen.png» — зображення, з попереднього повідомлення цієї розмови");
    expect(sent[1]?.text).toContain(`- «план.pdf» — ${path}`);
    // The bytes, though, travelled exactly once: only the NAMES are repeated.
    expect(sent[1]?.images).toBeUndefined();
    // «Новий чат» takes the names with the bytes, so the next conversation has no block.
    await svc.reset("management:w-files");
    expect(existsSync(join(tmpdir(), "kermanych-management", "management-w-files"))).toBe(false);
    turns = [reply("новий"), reply("ок")];
    await svc.ask(withFiles("нова розмова"));
    // The HEADER, not the phrase: a reset conversation is a first turn, so it carries the
    // contract — and the contract's own attachment rule quotes the block by name.
    expect(sent[2]?.text).not.toContain("── ДОЛУЧЕНІ ФАЙЛИ ──");
  });

  // A conversation that keeps attaching must not grow the turn without bound: the list is a
  // reminder of what can be named, and the oldest names stop being what «прикріпи файл»
  // means long before the process is evicted.
  it("carries at most the twenty most recent file names", async () => {
    const svc = make();
    const withFiles = (text: string): ManagementChatAsk => ({ ...ask(text), conversationId: "management:w-many" });
    for (let batch = 0; batch < 3; batch++) {
      turns = [reply("ок")];
      await svc.ask({
        ...withFiles(`партія ${batch}`),
        attachments: Array.from({ length: 10 }, (_, i) => ({
          name: `shot-${batch}-${i}.png`,
          mimeType: "image/png",
          data: Buffer.from("x").toString("base64"),
        })),
      });
    }
    const last = sent[2]?.text ?? "";
    // The newest batch of ten and the ten before it; the first batch has fallen off.
    expect(last).toContain("«shot-2-0.png»");
    expect(last).toContain("«shot-1-9.png»");
    expect(last).not.toContain("«shot-0-9.png»");
    expect(last.match(/^- «shot-/gm)).toHaveLength(20);
    await svc.reset("management:w-many");
  });
});
