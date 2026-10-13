// apps/api/test/cloud-sync.spec.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Subject } from "rxjs";
import type { DocsReport, ServerEvent, Session, SessionReport, TaskReportsWrite } from "@kermanych/core";
import type { AuthService } from "../src/auth/auth.service";
import type { SupervisorService } from "../src/supervisor/supervisor.service";

// Fake cloud transport. Mocked wholesale (no importOriginal) so the unit test needs no
// built packages/cloud and can be switched to failing mode mid-test.
// `taskStatusFromSession` is the identity map, mirroring packages/cloud/src/status.ts.
const pushed: { taskId: string; status: string; updatedAt: string }[] = [];
let failing = false;
// When armed, the NEXT push parks inside the transport until the test releases it. Every
// other test here serialises enqueues with `flush()`, so nothing can arrive mid-flight —
// which is exactly why the "drop the row we did not push" race stayed invisible.
let gate: { arrived: () => void; released: Promise<void> } | null = null;
type Card = { docsReport?: DocsReport; sessionReport?: SessionReport };
const cards = new Map<string, Card>();
const patches: ({ taskId: string } & Card)[] = [];
vi.mock("@kermanych/cloud", () => ({
  taskStatusFromSession: (s: { status: string }) => s.status,
  pushTaskStatus: async (_client: unknown, taskId: string, status: string, updatedAt: string) => {
    if (gate) {
      const g = gate;
      gate = null;
      g.arrived();
      await g.released;
    }
    if (failing) throw new Error("fetch failed");
    pushed.push({ taskId, status, updatedAt });
  },
  // The card-report half: the cards as the cloud holds them, and every patch sent. `failing`
  // fails the PATCH only, so a test sees a delivery that read the card and could not write it.
  getTask: async (_client: unknown, id: string) => cards.get(id),
  patchTask: async (_client: unknown, id: string, patch: { docsReport?: DocsReport; sessionReport?: SessionReport }) => {
    if (failing) throw new Error("fetch failed");
    patches.push({ taskId: id, ...patch });
    const card = { ...cards.get(id), ...patch };
    cards.set(id, card);
    return card;
  },
}));

// Arm the gate; `entered` resolves once a push is in flight, `release` lets it finish.
function holdNextPush(): { entered: Promise<void>; release: () => void } {
  let arrived!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => (arrived = () => r()));
  const released = new Promise<void>((r) => (release = () => r()));
  gate = { arrived, released };
  return { entered, release };
}

import { CloudSyncService } from "../src/cloud/cloud-sync.service";
import { RegistryService } from "../src/registry/registry.service";

const NOW = "2026-08-21T10:00:00.000Z";

// `registry` is shared across two services only by the reboot test, which has to drain the
// very rows the previous process left behind.
function make(opts: { signedIn?: boolean; registry?: RegistryService } = {}) {
  const registry = opts.registry ?? new RegistryService(":memory:");
  const events = new Subject<ServerEvent>();
  // Partial mock: CloudSyncService only ever reads `events$`. Cast once at the DI seam.
  const supervisor = { events$: events.asObservable() } as unknown as SupervisorService;
  const tokenListeners: (() => void)[] = [];
  let signedIn = opts.signedIn ?? true;
  const auth = {
    onToken: (cb: () => void) => tokenListeners.push(cb),
    cloudClient: () => {
      if (!signedIn) throw new Error("not signed in");
      return {};
    },
  } as unknown as AuthService;
  const sync = new CloudSyncService(supervisor, registry, auth);
  sync.onModuleInit();
  return {
    sync,
    registry,
    events,
    signIn: () => {
      signedIn = true;
      for (const cb of tokenListeners) cb();
    },
  };
}

function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    projectId: "p1",
    taskId: "t1",
    name: "Add login",
    task: "wire GitHub OAuth",
    worktreePath: "/tmp/wt",
    branch: "feature/add-login",
    worktree: true,
    kind: "agent",
    status: "thinking",
    archived: false,
    createdAt: NOW,
    lastActivityAt: NOW,
    ...over,
  };
}

// Let the `void this.drain()` microtask chain settle.
const flush = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => {
  pushed.length = 0;
  failing = false;
  gate = null;
  cards.clear();
  patches.length = 0;
});

describe("CloudSyncService", () => {
  it("pushes a status change once and dedupes repeats", async () => {
    const { registry, events } = make();

    events.next({ type: "session_update", session: session({ status: "thinking" }) });
    await flush();
    events.next({ type: "session_update", session: session({ status: "thinking" }) });
    await flush();

    expect(pushed.map((p) => p.status)).toEqual(["thinking"]);
    expect(registry.listOutbox()).toEqual([]);
  });

  it("ignores updates that do not change the status", async () => {
    const { events } = make();

    events.next({ type: "session_update", session: session({ status: "thinking" }) });
    await flush();
    events.next({ type: "session_update", session: session({ status: "thinking", contextPercent: 42 }) });
    events.next({ type: "session_update", session: session({ status: "thinking", currentTool: "read" }) });
    await flush();

    expect(pushed).toHaveLength(1);
  });

  it("ignores sessions that carry no task", async () => {
    const { registry, events } = make();

    events.next({ type: "session_update", session: session({ taskId: undefined }) });
    await flush();

    expect(pushed).toHaveLength(0);
    expect(registry.listOutbox()).toEqual([]);
  });

  it("keeps the row with attempts = 1 when the push fails, then drains on reconnect", async () => {
    const { sync, registry, events } = make();
    failing = true;

    events.next({ type: "session_update", session: session({ status: "thinking" }) });
    await flush();

    const queued = registry.listOutbox();
    expect(queued).toHaveLength(1);
    expect(queued[0].taskId).toBe("t1");
    expect(queued[0].status).toBe("thinking");
    expect(queued[0].attempts).toBe(1);
    expect(queued[0].lastError).toBe("fetch failed");
    expect(pushed).toHaveLength(0);

    failing = false;
    await sync.drain();

    expect(pushed.map((p) => p.status)).toEqual(["thinking"]);
    expect(registry.listOutbox()).toEqual([]);
  });

  it("collapses an offline burst into the newest status", async () => {
    const { sync, registry, events } = make();
    failing = true;

    events.next({ type: "session_update", session: session({ status: "thinking" }) });
    await flush();
    events.next({ type: "session_update", session: session({ status: "tool" }) });
    await flush();
    events.next({ type: "session_update", session: session({ status: "done" }) });
    await flush();

    expect(registry.listOutbox()).toHaveLength(1);
    failing = false;
    await sync.drain();

    expect(pushed.map((p) => p.status)).toEqual(["done"]);
  });

  it("holds the queue while signed out and drains on the token handoff", async () => {
    const { registry, events, signIn } = make({ signedIn: false });

    events.next({ type: "session_update", session: session({ status: "queued" }) });
    await flush();

    expect(pushed).toHaveLength(0);
    // Not a delivery failure: nothing was attempted, so the retry counter stays clean.
    expect(registry.listOutbox()[0].attempts).toBe(0);

    signIn();
    await flush();

    expect(pushed.map((p) => p.status)).toEqual(["queued"]);
    expect(registry.listOutbox()).toEqual([]);
  });

  it("pushes `stopped` when an active task's session is deleted", async () => {
    const { events } = make();

    events.next({ type: "session_update", session: session({ status: "thinking" }) });
    await flush();
    events.next({ type: "session_removed", sessionId: "s1" });
    await flush();

    expect(pushed.map((p) => p.status)).toEqual(["thinking", "stopped"]);
  });

  it("does not resurrect a finished task when its session is deleted", async () => {
    const { events } = make();

    events.next({ type: "session_update", session: session({ status: "done" }) });
    await flush();
    events.next({ type: "session_removed", sessionId: "s1" });
    await flush();

    expect(pushed.map((p) => p.status)).toEqual(["done"]);
  });

  it("enqueues `stopped` for every live task-bound session on shutdown", async () => {
    const { sync, registry, events } = make();

    events.next({ type: "session_update", session: session({ id: "s1", taskId: "t1", status: "thinking" }) });
    events.next({ type: "session_update", session: session({ id: "s2", taskId: "t2", status: "tool" }) });
    events.next({ type: "session_update", session: session({ id: "s3", taskId: "t3", status: "done" }) });
    await flush();
    pushed.length = 0;

    sync.onModuleDestroy();

    // Written synchronously to SQLite, so a hard exit right after cannot lose them; they
    // are pushed by the next boot's drain.
    expect(registry.listOutbox().map((r) => [r.taskId, r.status])).toEqual([
      ["t1", "stopped"],
      ["t2", "stopped"],
    ]);
  });

  it("does not drop a status that was enqueued while the previous push was in flight", async () => {
    const { registry, events } = make();
    const hold = holdNextPush();

    events.next({ type: "session_update", session: session({ status: "thinking" }) });
    await hold.entered;

    // The session finishes mid-push: the UPSERT replaces the in-flight row's status under
    // the same `task_id`. Retiring the row by id alone would delete this one unread.
    events.next({ type: "session_update", session: session({ status: "done" }) });
    await flush();
    expect(registry.listOutbox().map((r) => r.status)).toEqual(["done"]);

    hold.release();
    await flush();
    await flush();

    expect(pushed.map((p) => p.status)).toEqual(["thinking", "done"]);
    expect(registry.listOutbox()).toEqual([]);
  });

  it("keeps the shutdown `stopped` enqueued during an in-flight push", async () => {
    const registry = new RegistryService(":memory:");
    const { sync, events } = make({ registry });
    const hold = holdNextPush();

    events.next({ type: "session_update", session: session({ status: "thinking" }) });
    await hold.entered;

    // Quitting while the `thinking` push is still in the air. `onModuleDestroy` only
    // writes — the resuming pass must not retire what it never pushed.
    sync.onModuleDestroy();
    hold.release();
    await flush();
    await flush();

    expect(pushed.map((p) => p.status)).toEqual(["thinking"]);
    expect(registry.listOutbox().map((r) => [r.taskId, r.status])).toEqual([["t1", "stopped"]]);

    // The next boot drains what the shutdown owed.
    make({ registry });
    await flush();

    expect(pushed.map((p) => p.status)).toEqual(["thinking", "stopped"]);
    expect(registry.listOutbox()).toEqual([]);
  });
});

// The card reports (docs/specs/2026-10-12-docs-tab-survives-restart.md): queued by the
// supervisor in the registry, merged here onto whatever the card holds at delivery time.
describe("CloudSyncService card reports", () => {
  const facts = { runtime: "omp", native: false, branch: "feature/a", worktree: true } as const;
  const docs = (over: Partial<DocsReport> = {}): DocsReport => ({ sessionId: "s1", generatedAt: "2026-10-12T10:00:00.000Z", read: [], changed: [], ...over });
  const sessionReport = (over: Partial<SessionReport> = {}): SessionReport => ({ sessionId: "s1", generatedAt: "2026-10-12T10:00:00.000Z", skills: [], ...facts, ...over });
  const write = (over: Partial<TaskReportsWrite> = {}): TaskReportsWrite => ({ sessionId: "s1", generatedAt: "2026-10-12T10:05:00.000Z", session: facts, ...over });

  it("merges the write onto the card's current reports and patches both columns", async () => {
    const { registry } = make();
    // An earlier turn already reached the card; the transcript of this one was compacted and
    // no longer shows that read.
    cards.set("t1", {
      docsReport: docs({ read: ["docs/a.md"], changed: [{ path: "docs/a.md", added: 1, removed: 0 }] }),
      sessionReport: sessionReport({ skills: ["librarian"] }),
    });

    registry.enqueueTaskReport("t1", write({ read: ["docs/b.md"], skills: ["qa-tester"], changed: [{ path: "docs/b.md", added: 4, removed: 2 }] }));
    await flush();

    expect(patches).toHaveLength(1);
    expect(patches[0].docsReport).toEqual({
      sessionId: "s1",
      generatedAt: "2026-10-12T10:05:00.000Z",
      read: ["docs/a.md", "docs/b.md"],
      changed: [{ path: "docs/b.md", added: 4, removed: 2 }],
    });
    expect(patches[0].sessionReport).toMatchObject({ sessionId: "s1", skills: ["librarian", "qa-tester"], branch: "feature/a" });
    expect(registry.listReportOutbox()).toEqual([]);
  });

  it("drops the row of a card that is gone without retrying it", async () => {
    const { registry } = make();

    registry.enqueueTaskReport("t-deleted", write({ read: ["docs/a.md"] }));
    await flush();

    expect(patches).toEqual([]);
    expect(registry.listReportOutbox()).toEqual([]);
  });

  it("never overwrites a newer report of the card's relaunch", async () => {
    const { registry } = make();
    const relaunch = { docsReport: docs({ sessionId: "s2", generatedAt: "2026-10-12T11:00:00.000Z", read: ["docs/new.md"] }), sessionReport: sessionReport({ sessionId: "s2", generatedAt: "2026-10-12T11:00:00.000Z" }) };
    cards.set("t1", relaunch);

    // An old machine's write, queued offline before the relaunch.
    registry.enqueueTaskReport("t1", write({ read: ["docs/old.md"] }));
    await flush();

    expect(patches).toEqual([]);
    expect(cards.get("t1")).toEqual(relaunch);
    expect(registry.listReportOutbox()).toEqual([]);
  });

  it("keeps the row with its attempt counted when the patch fails, then delivers it", async () => {
    const { sync, registry } = make();
    cards.set("t1", {});
    failing = true;

    registry.enqueueTaskReport("t1", write({ read: ["docs/a.md"] }));
    await flush();

    expect(registry.listReportOutbox()).toMatchObject([{ taskId: "t1", attempts: 1, lastError: "fetch failed" }]);

    failing = false;
    await sync.drain();

    expect(patches.map((p) => p.docsReport?.read)).toEqual([["docs/a.md"]]);
    expect(registry.listReportOutbox()).toEqual([]);
  });

  it("holds a report while signed out and delivers it on the token handoff", async () => {
    const { registry, signIn } = make({ signedIn: false });
    cards.set("t1", {});

    registry.enqueueTaskReport("t1", write({ read: ["docs/a.md"] }));
    await flush();
    expect(registry.listReportOutbox()).toMatchObject([{ attempts: 0 }]);

    signIn();
    await flush();

    expect(patches).toHaveLength(1);
    expect(registry.listReportOutbox()).toEqual([]);
  });
});
