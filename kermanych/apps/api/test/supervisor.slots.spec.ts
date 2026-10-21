// apps/api/test/supervisor.slots.spec.ts
// Agent slots (docs/specs/2026-10-21-machine-resource-profile.md, decisions 4-5): how many
// agents run at once, who waits, in which order, and what a waiting session shows. The omp child
// is a FakeRpc the test drives through a turn; the limit comes from a stub resource service.
import { setTimeout as sleep } from "node:timers/promises";
import { Subject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageInput, Project, RpcEvent, ServerEvent, Session, TranscriptEntry } from "@kermanych/core";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { MachineResourcesService } from "../src/machine/machine-resources.service";
import type { WatchdogService } from "../src/machine/watchdog.service";
import type { NativeEvent, NativeSessionService } from "../src/native/native-session.service";

type FakeChild = { prompts: string[]; alive: boolean; emit: (e: RpcEvent) => void };
const instances: FakeChild[] = [];
// Set to hold the next start() open, so a test can act while a child is mid-respawn.
let startGate: Promise<void> | undefined;
const CHILD_PID = 4242;

vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    prompts: string[] = [];
    alive = true;
    emit: (e: RpcEvent) => void = () => {};
    exit: (code: number | null, reason: string) => void = () => {};
    constructor(private opts: { onSpawn?: (pid: number) => void }) {
      instances.push(this as unknown as FakeChild);
    }
    onEvent(cb: (e: RpcEvent) => void) {
      this.emit = cb;
    }
    onExit(cb: (code: number | null, reason: string) => void) {
      this.exit = cb;
    }
    async start() {
      // A real runtime reports its pid synchronously with the spawn, before it is ready.
      this.opts.onSpawn?.(CHILD_PID);
      await startGate;
    }
    async getState() {
      return { isStreaming: false };
    }
    async getAllMessages() {
      return [];
    }
    async switchSession() {}
    async setThinkingLevel() {}
    async stop() {
      this.alive = false;
      this.exit(0, "stopped");
    }
    isAlive() {
      return this.alive;
    }
    prompt(text: string) {
      this.prompts.push(text);
    }
    followUp(text: string) {
      this.prompts.push(text);
    }
    steer(text: string) {
      this.prompts.push(text);
    }
  }
  return { RpcSession: FakeRpc };
});

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { offlineAuth } from "./offline-auth";
import { stubSkills } from "./skills-stub";

// What the supervisor reads off the resource service; `agents: null` is decision `declined`.
let agents: number | null = 1;
const resources = {
  active: () => (agents === null ? null : { agents, subagents: 2, background: false, testWorkers: 1, lowerPriority: false, watchdog: false, criticalAction: "kill" }),
  ompOverlay: async () => undefined,
  claudeEnv: () => undefined,
  promptParagraph: () => undefined,
  renice: () => {},
  onChange: () => {},
} as unknown as MachineResourcesService;

type Launchable = { launch(session: Session, project: Project, opts?: object): Promise<Session> };

function make(registry = new RegistryService(":memory:"), extra: { native?: NativeSessionService; watchdog?: WatchdogService } = {}) {
  const worktree = {
    isGitRepo: vi.fn().mockResolvedValue(true),
    currentBranch: vi.fn().mockResolvedValue("main"),
    createBranchHere: vi.fn().mockResolvedValue(undefined),
    unmergedFiles: vi.fn().mockResolvedValue([]),
  } as unknown as WorktreeService;
  const sup = new SupervisorService(registry, worktree, offlineAuth(), stubSkills(), undefined as never, extra.native, undefined, resources, extra.watchdog);
  const project = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
  // An in-place agent: its git is one mocked call, so the launch is the spawn under test.
  const launch = (name: string) =>
    (sup as unknown as Launchable).launch(
      registry.createSession({ projectId: project.id, name, task: `task ${name}`, worktreePath: "", branch: `feature/${name}`, worktree: false }),
      project,
    );
  // A finished agent whose child is gone (an api restart, or the reaper): a message resumes it.
  const doneAgent = (name: string) => {
    const s = registry.createSession({ projectId: project.id, name, task: "t", worktreePath: "/tmp/wt", branch: `feature/${name}` });
    return registry.updateSession(s.id, { ompSessionFile: `/tmp/${name}.jsonl`, status: "done" });
  };
  const row = (id: string) => sup.snapshot().sessions.find((s) => s.id === id)!;
  return { sup, registry, launch, doneAgent, row };
}

// One whole turn of a running child, ending at rest.
function settle(child: FakeChild) {
  child.emit({ type: "agent_start" } as RpcEvent);
  child.emit({ type: "agent_end" } as RpcEvent);
}

beforeEach(() => {
  instances.length = 0;
  agents = 1;
  startGate = undefined;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("agent slots", () => {
  it("a launch past the limit waits with no child until the running one settles", async () => {
    const { launch, row, sup } = make();
    const a = await launch("a");
    expect(instances).toHaveLength(1);
    expect(instances[0].prompts[0]).toContain("task a");

    const b = await launch("b");
    expect(b.status).toBe("queued");
    expect(b.slotWait).toEqual({ position: 1, running: 1, limit: 1 });
    expect(instances).toHaveLength(1);
    expect(sup.slotCounts()).toEqual({ running: 1, waiting: 1 });

    settle(instances[0]);
    await vi.waitFor(() => expect(instances).toHaveLength(2));
    expect(instances[1].prompts[0]).toContain("task b");
    expect(row(a.id).status).toBe("done");
    expect(row(b.id).slotWait).toBeUndefined();
    expect(row(b.id).pendingPrompt).toBeUndefined();
  });

  it("waiting launches start in the order they were queued", async () => {
    const { launch, row } = make();
    await launch("a");
    const b = await launch("b");
    const c = await launch("c");
    expect(row(b.id).slotWait?.position).toBe(1);
    expect(row(c.id).slotWait?.position).toBe(2);

    settle(instances[0]);
    await vi.waitFor(() => expect(instances).toHaveLength(2));
    expect(instances[1].prompts[0]).toContain("task b");
    expect(row(c.id).slotWait?.position).toBe(1);

    settle(instances[1]);
    await vi.waitFor(() => expect(instances).toHaveLength(3));
    expect(instances[2].prompts[0]).toContain("task c");
  });

  it("a message to a done agent waits, shows as pending in its log, and is delivered after", async () => {
    const { launch, doneAgent, sup, row, registry } = make();
    await launch("a");
    const d = doneAgent("d");

    await sup.sendMessage(d.id, "add the tests", "prompt");
    expect(instances).toHaveLength(1);
    expect(row(d.id)).toMatchObject({ status: "queued", slotWait: { position: 1, running: 1, limit: 1 }, pendingPrompt: "add the tests" });
    // The row keeps its real status: a waiting message is the queue's, not a new status.
    expect(registry.listSessions().find((s) => s.id === d.id)?.status).toBe("done");
    const log = sup.getTranscript(d.id);
    expect(log.map((e) => e.kind)).toEqual(["user_text", "notice"]);
    expect(log[0]).toMatchObject({ text: "add the tests" });
    expect(log[1]).toMatchObject({ code: "slot_wait", params: { running: 1, limit: 1 } });

    settle(instances[0]);
    await vi.waitFor(() => expect(instances[1]?.prompts).toEqual(["add the tests"]));
    expect(row(d.id).slotWait).toBeUndefined();
    expect(row(d.id).pendingPrompt).toBeUndefined();
    expect(sup.getTranscript(d.id).filter((e: TranscriptEntry) => e.kind === "notice" && e.code === "slot_wait")).toEqual([]);
  });

  it("a steer into the running turn never waits", async () => {
    const { launch, sup } = make();
    const a = await launch("a");
    await launch("b");
    instances[0].emit({ type: "agent_start" } as RpcEvent);
    await sup.sendMessage(a.id, "use the other api", "steer");
    expect(instances[0].prompts.at(-1)).toBe("use the other api");
  });

  it("chats are not counted and never wait", async () => {
    const { launch, sup } = make();
    await launch("a");
    const chat = await sup.createChat("p1");
    expect(chat.status).toBe("done");
    expect(instances).toHaveLength(2);
    // The chat mid-turn still takes no agent slot.
    instances[1].emit({ type: "agent_start" } as RpcEvent);
    expect(sup.slotCounts()).toEqual({ running: 1, waiting: 0 });
  });

  it("«Запустити зараз» starts a waiting session past the limit", async () => {
    const { launch, sup } = make();
    await launch("a");
    const b = await launch("b");
    const started = await sup.runNow(b.id);
    expect(instances).toHaveLength(2);
    expect(instances[1].prompts[0]).toContain("task b");
    expect(started.slotWait).toBeUndefined();
    expect(sup.slotCounts()).toEqual({ running: 2, waiting: 0 });
  });

  it("stopping a waiting session takes it off the queue and drops its pending prompt", async () => {
    const { launch, sup, row } = make();
    await launch("a");
    const b = await launch("b");
    await sup.stopSession(b.id);
    expect(sup.slotCounts().waiting).toBe(0);
    expect(row(b.id)).toMatchObject({ status: "stopped" });
    expect(row(b.id).pendingPrompt).toBeUndefined();

    settle(instances[0]);
    await sleep(10);
    expect(instances).toHaveLength(1);
  });

  it("a new process on the same registry re-enqueues the waiting sessions in their original order", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const registry = new RegistryService(":memory:");
    const first = make(registry);
    // `d` exists before `b`, but waits after it: the order is the queue's, not the rows'.
    const d = first.doneAgent("d");
    vi.setSystemTime(1_000);
    const a = await first.launch("a");
    // Its child recorded its session file, as a real one does within a poll of starting: a row
    // still `queued` with a handle is a run cut short, not a launch to repeat.
    registry.updateSession(a.id, { ompSessionFile: "/tmp/a.jsonl" });
    vi.setSystemTime(2_000);
    const b = await first.launch("b");
    vi.setSystemTime(3_000);
    await first.sup.sendMessage(d.id, "add the tests", "prompt");
    expect(first.sup.slotCounts().waiting).toBe(2);

    // The api restarts: nothing runs, the queue is rebuilt from the rows.
    instances.length = 0;
    const second = make(registry);
    second.sup.onModuleInit();
    await vi.waitFor(() => expect(instances).toHaveLength(1));
    expect(instances[0].prompts[0]).toContain("task b");
    expect(second.row(d.id).slotWait).toEqual({ position: 1, running: 1, limit: 1 });
    expect(second.sup.getTranscript(d.id)[0]).toMatchObject({ kind: "user_text", text: "add the tests" });

    settle(instances[0]);
    await vi.waitFor(() => expect(instances[1]?.prompts).toEqual(["add the tests"]));
    expect(second.row(b.id).status).toBe("done");
    second.sup.onModuleDestroy();
  });

  it("with no limit (decision `declined`) nothing waits", async () => {
    agents = null;
    const { launch, sup } = make();
    await launch("a");
    const b = await launch("b");
    expect(b.slotWait).toBeUndefined();
    expect(instances).toHaveLength(2);
    expect(sup.slotCounts()).toEqual({ running: 2, waiting: 0 });
  });

  // Selecting an old agent wakes its child (resume), which starts no turn: it must neither take
  // the slot a waiting launch needs nor leave that launch waiting once the wake is over.
  it("a plain wake does not hold a slot, and the queue moves when it ends", async () => {
    const { launch, doneAgent, sup, row } = make();
    await launch("a");
    const c = await launch("c");
    const d = doneAgent("d");
    const gate = Promise.withResolvers<void>();
    startGate = gate.promise;
    const waking = sup.resume(d.id);
    await vi.waitFor(() => expect(instances).toHaveLength(2));
    startGate = undefined;
    // The respawning child's first frame rebuilds its reducer at `queued`.
    instances[1].emit({ type: "response" } as RpcEvent);
    settle(instances[0]);
    gate.resolve();
    await waking;
    await vi.waitFor(() => expect(instances).toHaveLength(3));
    expect(instances[2].prompts[0]).toContain("task c");
    expect(row(c.id).slotWait).toBeUndefined();
    expect(row(d.id).status).toBe("done");
  });

  it("a parked launch that starts begins with an empty log, not the dormant notice", async () => {
    const { launch, sup } = make();
    const resets = new Map<string, TranscriptEntry[][]>();
    sup.events$.subscribe((e: ServerEvent) => {
      if (e.type === "transcript_reset") resets.set(e.sessionId, [...(resets.get(e.sessionId) ?? []), e.entries]);
    });
    await launch("a");
    const b = await launch("b");
    settle(instances[0]);
    await vi.waitFor(() => expect(instances).toHaveLength(2));
    expect(resets.get(b.id)?.[0]).toEqual([]);
  });

  // Images are not persisted, so an image-only message leaves nothing a restart could send.
  it("an image-only waiting message is not replayed as an empty prompt after a restart", async () => {
    const registry = new RegistryService(":memory:");
    const first = make(registry);
    const a = await first.launch("a");
    // A run with a session file is not a launch to repeat (see the re-enqueue test above).
    registry.updateSession(a.id, { ompSessionFile: "/tmp/a.jsonl" });
    const d = first.doneAgent("d");
    const image: ImageInput = { data: "aGk=", mimeType: "image/png" };
    await first.sup.sendMessage(d.id, "", "prompt", [image]);
    expect(first.sup.getTranscript(d.id)[0]).toMatchObject({ kind: "user_text", images: ["data:image/png;base64,aGk="] });
    expect(registry.listSessions().find((s) => s.id === d.id)?.pendingPrompt).toBe("");

    instances.length = 0;
    const second = make(registry);
    second.sup.onModuleInit();
    expect(second.sup.slotCounts().waiting).toBe(0);
    expect(second.row(d.id).pendingPrompt).toBeUndefined();
    await sleep(10);
    expect(instances).toHaveLength(0);
    second.sup.onModuleDestroy();
  });
});

// The native service as the supervisor sees it: a TUI runs while it has a pid.
function fakeNative() {
  const events$ = new Subject<NativeEvent>();
  const pids = new Map<string, number>();
  const native = {
    events$,
    isRunning: (id: string) => pids.has(id),
    live: () => undefined,
    pid: (id: string) => pids.get(id),
    send: vi.fn(async () => {}),
  } as unknown as NativeSessionService;
  return { native, events$, pids };
}

describe("native agents", () => {
  // Parked first and replayed later, they would fail with nobody left to tell.
  it("an image or a harness command is refused at once, not parked for a slot", async () => {
    const { native } = fakeNative();
    const { launch, registry, sup } = make(undefined, { native });
    await launch("a");
    const n = registry.createSession({ projectId: "p1", name: "n", task: "t", worktreePath: "/tmp/wt", branch: "feature/n", runtime: "claude-code", native: true, status: "stopped" });
    const image: ImageInput = { data: "aGk=", mimeType: "image/png" };
    await expect(sup.sendMessage(n.id, "look", "prompt", [image])).rejects.toMatchObject({ code: "native_unsupported" });
    await expect(sup.sendMessage(n.id, "/compact", "prompt")).rejects.toMatchObject({ code: "native_unsupported" });
    expect(sup.slotCounts().waiting).toBe(0);
  });
});

// decision 7: what an agent runs once it is up (MCP servers, workers) is its baseline, never a
// victim, so the watchdog takes it when the child is initialised, not at the bare spawn.
describe("watchdog baseline", () => {
  function fakeWatchdog() {
    const tracks: { id: string; pid: number }[] = [];
    const watchdog = {
      events$: new Subject(),
      track: (id: string, _name: string, pid: number) => tracks.push({ id, pid }),
      untrack: () => {},
    } as unknown as WatchdogService;
    return { watchdog, tracks };
  }

  it("a managed child is tracked when started and re-baselined once on its first `ready`", async () => {
    const { watchdog, tracks } = fakeWatchdog();
    const { launch } = make(undefined, { watchdog });
    const a = await launch("a");
    expect(tracks).toEqual([{ id: a.id, pid: CHILD_PID }]);
    instances[0].emit({ type: "ready" } as RpcEvent);
    instances[0].emit({ type: "ready" } as RpcEvent);
    expect(tracks).toEqual([{ id: a.id, pid: CHILD_PID }, { id: a.id, pid: CHILD_PID }]);
  });

  it("a native harness is tracked on its first report after the spawn, not on the spawn", () => {
    const { watchdog, tracks } = fakeWatchdog();
    const { native, events$, pids } = fakeNative();
    const { registry } = make(undefined, { native, watchdog });
    const n = registry.createSession({ projectId: "p1", name: "n", task: "t", worktreePath: "/tmp/wt", branch: "feature/n", runtime: "claude-code", native: true });
    pids.set(n.id, 77);
    events$.next({ type: "changed", sessionId: n.id });
    expect(tracks).toEqual([]);
    events$.next({ type: "changed", sessionId: n.id });
    expect(tracks).toEqual([{ id: n.id, pid: 77 }]);
  });
});
