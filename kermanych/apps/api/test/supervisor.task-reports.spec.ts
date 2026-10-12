// apps/api/test/supervisor.task-reports.spec.ts
// What the supervisor queues for a session's cloud card
// (docs/specs/2026-10-12-docs-tab-survives-restart.md, decisions 7–8): a write after every
// turn and in «Завершити», built from the session's own transcript, worktree listing and row.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Subject } from "rxjs";
import type { RpcEvent, TranscriptEntry } from "@kermanych/core";
import type { NativeEvent, NativeSessionService } from "../src/native/native-session.service";
import type { ModelsService } from "../src/models/models.service";

// The supervisor's own event callback, so a test can play omp frames at it.
let emit: (e: RpcEvent) => void = () => {};
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    onEvent(cb: (e: RpcEvent) => void) {
      emit = cb;
    }
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
    prompt() {}
    followUp() {}
    steer() {}
  }
  return { RpcSession: FakeRpc };
});

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { WorktreeService } from "../src/worktree/worktree.service";
import { offlineAuth } from "./offline-auth";
import { stubSkills } from "./skills-stub";

// The worktree's «Зміни» listing: one document among code, as the tab would see it.
const LISTING = [
  { path: "docs/guide.md", added: 3, removed: 1 },
  { path: "src/app.ts", added: 10, removed: 0 },
];

function make(native?: NativeSessionService) {
  const registry = new RegistryService(":memory:");
  const worktree = {
    isGitRepo: vi.fn().mockResolvedValue(true),
    currentBranch: vi.fn().mockResolvedValue("main"),
    hasUncommitted: vi.fn().mockResolvedValue(false),
    changedFiles: vi.fn().mockResolvedValue(LISTING),
  };
  const sup = new SupervisorService(
    registry,
    worktree as unknown as WorktreeService,
    offlineAuth(),
    stubSkills(),
    undefined as unknown as ModelsService,
    native,
  );
  const project = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
  return { sup, registry, worktree, project };
}

// A turn that reads one document, one code file and one skill.
function playTurn() {
  const reads: [string, string][] = [["c1", "docs/guide.md"], ["c2", "src/app.ts"], ["c3", "skill://librarian"]];
  for (const [id, path] of reads) {
    emit({ type: "tool_execution_start", toolName: "read", toolCallId: id, args: { path } });
    emit({ type: "tool_execution_end", toolName: "read", toolCallId: id, isError: false, result: { content: [{ type: "text", text: "body" }] } });
  }
  emit({ type: "agent_end" });
}

// queueTaskReport is fired with `void` off the event path; let its awaits settle.
const flush = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => {
  emit = () => {};
});

describe("a managed turn", () => {
  it("queues the task-born agent's docs read, doc changes and skills on a terminal agent_end", async () => {
    const { sup, registry, worktree, project } = make();
    const s = registry.createSession({ projectId: project.id, taskId: "task-1", name: "A", task: "t", worktreePath: "/tmp/wt", branch: "feature/a", baseBranch: "dev" });
    registry.updateSession(s.id, { ompSessionFile: "/tmp/s.jsonl", status: "done" });
    await sup.sendMessage(s.id, "go", "follow_up");

    playTurn();
    await flush();

    // Listed in the session's own worktree against its fork base, exactly as «Зміни» lists it.
    expect(worktree.changedFiles).toHaveBeenCalledWith("/tmp/wt", "dev");
    const rows = registry.listReportOutbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].taskId).toBe("task-1");
    expect(rows[0].write).toMatchObject({
      sessionId: s.id,
      read: ["docs/guide.md"],
      changed: [{ path: "docs/guide.md", added: 3, removed: 1 }],
      skills: ["librarian"],
      session: { branch: "feature/a", baseBranch: "dev", worktree: true },
    });
  });

  it("queues nothing for a session without a card", async () => {
    const { sup, registry, project } = make();
    const s = registry.createSession({ projectId: project.id, name: "A", task: "t", worktreePath: "/tmp/wt", branch: "feature/a", baseBranch: "dev" });
    registry.updateSession(s.id, { ompSessionFile: "/tmp/s.jsonl", status: "done" });
    await sup.sendMessage(s.id, "go", "follow_up");

    playTurn();
    await flush();

    expect(registry.listReportOutbox()).toEqual([]);
  });

  it("still queues the reads and skills when the worktree cannot be listed", async () => {
    const { sup, registry, worktree, project } = make();
    worktree.changedFiles.mockRejectedValue(new Error("git: not a work tree"));
    const s = registry.createSession({ projectId: project.id, taskId: "task-1", name: "A", task: "t", worktreePath: "/tmp/wt", branch: "feature/a", baseBranch: "dev" });
    registry.updateSession(s.id, { ompSessionFile: "/tmp/s.jsonl", status: "done" });
    await sup.sendMessage(s.id, "go", "follow_up");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    playTurn();
    await flush();
    warn.mockRestore();

    const [row] = registry.listReportOutbox();
    expect(row.write).toMatchObject({ read: ["docs/guide.md"], skills: ["librarian"] });
    // No listing → no `changed`, so the card keeps the list an earlier turn sent.
    expect(row.write).not.toHaveProperty("changed");
  });
});

describe("a native turn", () => {
  it("queues the history the harness's turn just produced", async () => {
    const events$ = new Subject<NativeEvent>();
    const native = { events$, live: () => ({}) } as unknown as NativeSessionService;
    const { registry, project } = make(native);
    const s = registry.createSession({ projectId: project.id, taskId: "task-1", name: "A", task: "t", worktreePath: "/tmp/wt", branch: "feature/a", baseBranch: "dev", native: true, runtime: "claude-code" });
    const entries: TranscriptEntry[] = [
      { kind: "tool", id: "c1", at: 1, tool: "read", status: "ok", target: "docs/guide.md" },
      { kind: "tool", id: "c2", at: 2, tool: "skill", status: "ok", target: "librarian" },
    ];

    events$.next({ type: "transcript", sessionId: s.id, transcript: { entries, full: new Map() } });
    await flush();

    const [row] = registry.listReportOutbox();
    expect(row.write).toMatchObject({
      sessionId: s.id,
      read: ["docs/guide.md"],
      skills: ["librarian"],
      changed: [{ path: "docs/guide.md", added: 3, removed: 1 }],
      session: { native: true, runtime: "claude-code" },
    });
  });
});

// «Завершити» against a real repository: the listing must be taken before the worktree goes,
// and a real tree is the only way to show it was (a fake would list after removal just as well).
describe("finishSession", () => {
  const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });
  const wt = new WorktreeService();
  let trash: string[] = [];

  afterEach(() => {
    for (const d of trash) rmSync(d, { recursive: true, force: true });
    trash = [];
  });

  it("queues the listing of the worktree it is about to remove, and no reads for a session with no Live", async () => {
    const repo = mkdtempSync(join(tmpdir(), "kmq-reports-"));
    const parent = mkdtempSync(join(tmpdir(), "kmq-reports-wt-"));
    trash.push(repo, parent);
    execFileSync("git", ["-c", "init.defaultBranch=dev", "init", "-q"], { cwd: repo });
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    const wtDir = join(parent, "wt");
    await wt.addWorktree(repo, wtDir, "kermanych/s1", "dev");
    mkdirSync(join(wtDir, "docs"));
    writeFileSync(join(wtDir, "docs", "guide.md"), "# Guide\n");
    git(wtDir, "add", "-A");
    git(wtDir, "commit", "-q", "-m", "guide");
    // Loose work: finish commits it first, and the report must count it too.
    writeFileSync(join(wtDir, "README.md"), "hello\nworld\n");

    const registry = new RegistryService(":memory:");
    const sup = new SupervisorService(registry, wt, offlineAuth(), stubSkills());
    registry.upsertProject({ id: "p1", name: "g", localRepoPath: repo });
    // Dormant: a restart left no Live, so nothing in memory says what it read.
    const s = registry.createSession({ projectId: "p1", taskId: "task-1", name: "one", task: "t", worktreePath: wtDir, branch: "kermanych/s1", baseBranch: "dev", status: "done" });

    await sup.finishSession(s.id);

    const [row] = registry.listReportOutbox();
    expect(row.taskId).toBe("task-1");
    expect(row.write.changed).toEqual([
      { path: "README.md", added: 2, removed: 0 },
      { path: "docs/guide.md", added: 1, removed: 0 },
    ]);
    // Absent, not empty: the card keeps the reads and skills earlier turns sent.
    expect(row.write).not.toHaveProperty("read");
    expect(row.write).not.toHaveProperty("skills");
  });
});
