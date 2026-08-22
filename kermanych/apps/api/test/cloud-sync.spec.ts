// apps/api/test/cloud-sync.spec.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Subject } from "rxjs";
import type { ServerEvent, Session } from "@kermanych/core";
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
