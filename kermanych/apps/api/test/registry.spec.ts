// apps/api/test/registry.spec.ts
import { expect, test } from "vitest";
import { RegistryService } from "../src/registry/registry.service";

test("project + session round trip", () => {
  const r = new RegistryService(":memory:");
  const g = r.upsertProject({ id: "p-app", name: "app", localRepoPath: "/tmp/app" });
  expect(r.listProjects()).toHaveLength(1);
  const s = r.createSession({ projectId: g.id, name: "task", task: "do it", worktreePath: "/wt", branch: "kermanych/task" });
  expect(s.status).toBe("queued");
  const u = r.updateSession(s.id, { status: "done", contextPercent: 12 });
  expect(u.status).toBe("done");
  expect(r.listSessions(g.id)).toHaveLength(1);
  r.removeSession(s.id);
  expect(r.listSessions(g.id)).toHaveLength(0);
});

test("session archived flag defaults false and round-trips", () => {
  const r = new RegistryService(":memory:");
  const g = r.upsertProject({ id: "p-app", name: "app", localRepoPath: "/tmp/app" });
  const s = r.createSession({ projectId: g.id, name: "task", task: "do it", worktreePath: "/wt", branch: "kermanych/task" });
  expect(r.listSessions(g.id)[0].archived).toBe(false);
  const u = r.updateSession(s.id, { archived: true });
  expect(u.archived).toBe(true);
  expect(r.listSessions(g.id)[0].archived).toBe(true);
  r.updateSession(s.id, { archived: false });
  expect(r.listSessions(g.id)[0].archived).toBe(false);
});

test("createSession stamps lastActivityAt equal to createdAt", () => {
  const r = new RegistryService(":memory:");
  const g = r.upsertProject({ id: "p-app", name: "app", localRepoPath: "/tmp/app" });
  const s = r.createSession({ projectId: g.id, name: "task", task: "do it", worktreePath: "/wt", branch: "kermanych/task" });
  expect(s.lastActivityAt).toBe(s.createdAt);
  expect(r.listSessions(g.id)[0].lastActivityAt).toBe(s.createdAt);
});

test("touchSession advances lastActivityAt without touching other fields", async () => {
  const r = new RegistryService(":memory:");
  const g = r.upsertProject({ id: "p-app", name: "app", localRepoPath: "/tmp/app" });
  const s = r.createSession({ projectId: g.id, name: "task", task: "do it", worktreePath: "/wt", branch: "kermanych/task" });
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 10);
  await promise;
  r.touchSession(s.id);
  const after = r.listSessions(g.id)[0];
  expect(after.lastActivityAt > s.createdAt).toBe(true); // ISO strings sort chronologically
  expect(after.status).toBe(s.status);
  expect(after.branch).toBe(s.branch);
});

test("session worktree flag defaults true and round-trips with baseBranch", () => {
  const r = new RegistryService(":memory:");
  const g = r.upsertProject({ id: "p-app", name: "app", localRepoPath: "/tmp/app" });

  const wtSession = r.createSession({ projectId: g.id, name: "wt", task: "t", worktreePath: "/wt", branch: "feature/wt" });
  expect(wtSession.worktree).toBe(true);
  expect(r.listSessions(g.id).find((s) => s.id === wtSession.id)!.worktree).toBe(true);

  const inPlace = r.createSession({
    projectId: g.id, name: "ip", task: "t", worktreePath: "", branch: "fix/ip",
    worktree: false, baseBranch: "main",
  });
  const read = r.listSessions(g.id).find((s) => s.id === inPlace.id)!;
  expect(read.worktree).toBe(false);
  expect(read.baseBranch).toBe("main");
});

test("project carryFiles defaults to [.env] and round-trips", () => {
  const r = new RegistryService(":memory:");
  const g = r.upsertProject({ id: "p-app", name: "app", localRepoPath: "/tmp/app" });
  expect(g.carryFiles).toEqual([".env"]);
  expect(r.listProjects()[0].carryFiles).toEqual([".env"]);

  const withList = r.upsertProject({ id: "p-b", name: "b", localRepoPath: "/tmp/b", carryFiles: [".env", ".env.local"] });
  expect(r.listProjects().find((x) => x.id === withList.id)!.carryFiles).toEqual([".env", ".env.local"]);

  const u = r.patchProject(g.id, { carryFiles: [".env", "config/svc.json"] });
  expect(u.carryFiles).toEqual([".env", "config/svc.json"]);
  expect(r.listProjects().find((x) => x.id === g.id)!.carryFiles).toEqual([".env", "config/svc.json"]);
});

test("patchProject renames the project and round-trips", () => {
  const r = new RegistryService(":memory:");
  const g = r.upsertProject({ id: "p-app", name: "old", localRepoPath: "/tmp/app" });
  const u = r.patchProject(g.id, { name: "new" });
  expect(u.name).toBe("new");
  expect(r.listProjects().find((x) => x.id === g.id)!.name).toBe("new");
  // A name-only patch leaves the other columns intact.
  expect(r.listProjects().find((x) => x.id === g.id)!.carryFiles).toEqual([".env"]);
});

test("project color defaults unset, round-trips, and clears via patchProject", () => {
  const r = new RegistryService(":memory:");
  const g = r.upsertProject({ id: "p-app", name: "app", localRepoPath: "/tmp/app" });
  expect(g.color).toBeUndefined();
  expect(r.listProjects()[0].color).toBeUndefined();

  const u = r.patchProject(g.id, { color: "#ff563c" });
  expect(u.color).toBe("#ff563c");
  expect(r.listProjects().find((x) => x.id === g.id)!.color).toBe("#ff563c");

  // A name-only patch leaves the color intact.
  r.patchProject(g.id, { name: "renamed" });
  expect(r.listProjects().find((x) => x.id === g.id)!.color).toBe("#ff563c");

  // An empty color clears it back to unset (both the echo and the re-read).
  const cleared = r.patchProject(g.id, { color: "" });
  expect(cleared.color).toBeUndefined();
  expect(r.listProjects().find((x) => x.id === g.id)!.color).toBeUndefined();
});

test("project defaultBranch defaults unset, round-trips, and clears via patchProject", () => {
  const r = new RegistryService(":memory:");
  const g = r.upsertProject({ id: "p-app", name: "app", localRepoPath: "/tmp/app" });
  expect(g.defaultBranch).toBeUndefined();
  expect(r.listProjects()[0].defaultBranch).toBeUndefined();

  const created = r.upsertProject({ id: "p-app2", name: "app2", localRepoPath: "/tmp/app2", defaultBranch: "main" });
  expect(r.listProjects().find((x) => x.id === created.id)!.defaultBranch).toBe("main");

  const u = r.patchProject(g.id, { defaultBranch: "develop" });
  expect(u.defaultBranch).toBe("develop");
  expect(r.listProjects().find((x) => x.id === g.id)!.defaultBranch).toBe("develop");

  // A name-only patch leaves the default branch intact.
  r.patchProject(g.id, { name: "renamed" });
  expect(r.listProjects().find((x) => x.id === g.id)!.defaultBranch).toBe("develop");

  // An empty default branch clears it back to unset.
  const cleared = r.patchProject(g.id, { defaultBranch: "" });
  expect(cleared.defaultBranch).toBeUndefined();
  expect(r.listProjects().find((x) => x.id === g.id)!.defaultBranch).toBeUndefined();
});

test("project conventions defaults unset, round-trips, and clears via patchProject", () => {
  const r = new RegistryService(":memory:");
  const g = r.upsertProject({ id: "p-app", name: "app", localRepoPath: "/tmp/app" });
  expect(g.conventions).toBeUndefined();
  expect(r.listProjects()[0].conventions).toBeUndefined();

  const created = r.upsertProject({ id: "p-app2", name: "app2", localRepoPath: "/tmp/app2", conventions: "feat: rule" });
  expect(r.listProjects().find((x) => x.id === created.id)!.conventions).toBe("feat: rule");

  const u = r.patchProject(g.id, { conventions: "PR body: Summary + Testing" });
  expect(u.conventions).toBe("PR body: Summary + Testing");
  expect(r.listProjects().find((x) => x.id === g.id)!.conventions).toBe("PR body: Summary + Testing");

  // A name-only patch leaves the conventions intact.
  r.patchProject(g.id, { name: "renamed" });
  expect(r.listProjects().find((x) => x.id === g.id)!.conventions).toBe("PR body: Summary + Testing");

  // An empty conventions string clears it back to unset.
  const cleared = r.patchProject(g.id, { conventions: "" });
  expect(cleared.conventions).toBeUndefined();
  expect(r.listProjects().find((x) => x.id === g.id)!.conventions).toBeUndefined();
});

test("backlog task persists launch config (model, prefix, kind, status) round-trip", () => {
  const r = new RegistryService(":memory:");
  const g = r.upsertProject({ id: "p-app", name: "app", localRepoPath: "/tmp/app" });
  const t = r.createSession({
    projectId: g.id, name: "planned", task: "later", worktreePath: "", branch: "",
    status: "backlog", kind: "task", model: "opus-5", prefix: "fix",
  });
  const read = r.listSessions(g.id).find((s) => s.id === t.id)!;
  expect(read.status).toBe("backlog");
  expect(read.kind).toBe("task");
  expect(read.model).toBe("opus-5");
  expect(read.prefix).toBe("fix");
});

test("session platform persists and round-trips", () => {
  const r = new RegistryService(":memory:");
  const g = r.upsertProject({ id: "p-app", name: "app", localRepoPath: "/tmp/app" });
  const s = r.createSession({ projectId: g.id, name: "task", task: "do it", worktreePath: "/wt", branch: "kermanych/task", platform: "web" });
  expect(r.listSessions(g.id)[0].platform).toBe("web");
  const u = r.updateSession(s.id, { platform: "mobile" });
  expect(u.platform).toBe("mobile");
  expect(r.listSessions(g.id)[0].platform).toBe("mobile");
});

test("updateSession moves a session to another project and round-trips", () => {
  const r = new RegistryService(":memory:");
  const a = r.upsertProject({ id: "p-be", name: "backend", localRepoPath: "/tmp/be" });
  const b = r.upsertProject({ id: "p-fe", name: "frontend", localRepoPath: "/tmp/fe" });
  const s = r.createSession({ projectId: a.id, name: "task", task: "do it", worktreePath: "", branch: "", status: "backlog", kind: "task" });
  expect(r.listSessions(a.id)).toHaveLength(1);
  const u = r.updateSession(s.id, { projectId: b.id });
  expect(u.projectId).toBe(b.id);
  expect(r.listSessions(a.id)).toHaveLength(0);
  expect(r.listSessions(b.id).map((x) => x.id)).toEqual([s.id]);
});

test("upsertProject takes the cloud id and refreshing config keeps the local binding", () => {
  const r = new RegistryService(":memory:");
  const created = r.upsertProject({ id: "cloud-uuid-1", name: "Acme", localRepoPath: "/tmp/acme" });
  expect(created.id).toBe("cloud-uuid-1");
  expect(created.carryFiles).toEqual([".env"]);

  // A cloud refresh sends config but no path: the binding must survive.
  const refreshed = r.upsertProject({ id: "cloud-uuid-1", name: "Acme Renamed", conventions: "feat: rule", carryFiles: [".env", ".env.local"] });
  expect(refreshed.localRepoPath).toBe("/tmp/acme");
  expect(refreshed.name).toBe("Acme Renamed");
  expect(refreshed.conventions).toBe("feat: rule");
  expect(refreshed.carryFiles).toEqual([".env", ".env.local"]);
  expect(refreshed.createdAt).toBe(created.createdAt);
  expect(r.listProjects()).toHaveLength(1);

  // An explicit path wins.
  expect(r.upsertProject({ id: "cloud-uuid-1", name: "Acme Renamed", localRepoPath: "/tmp/other" }).localRepoPath).toBe("/tmp/other");
});

test("patchProject binds and rebinds a local repo path, and rejects an unknown project", () => {
  const r = new RegistryService(":memory:");
  const p = r.upsertProject({ id: "cloud-uuid-2", name: "Unbound" });
  expect(p.localRepoPath).toBe("");

  expect(r.patchProject(p.id, { localRepoPath: "/tmp/bound" }).localRepoPath).toBe("/tmp/bound");
  expect(r.listProjects()[0]!.localRepoPath).toBe("/tmp/bound");
  // A name-only patch leaves the binding intact.
  r.patchProject(p.id, { name: "Bound" });
  expect(r.listProjects()[0]!.localRepoPath).toBe("/tmp/bound");

  expect(() => r.patchProject("nope", { name: "x" })).toThrow(/project not found/);
});

test("session taskId defaults undefined, round-trips, and survives updateSession", () => {
  const r = new RegistryService(":memory:");
  const p = r.upsertProject({ id: "p-task", name: "app", localRepoPath: "/tmp/app" });
  const plain = r.createSession({ projectId: p.id, name: "a", task: "t", worktreePath: "", branch: "b" });
  expect(plain.taskId).toBeUndefined();
  expect(r.listSessions(p.id).find((s) => s.id === plain.id)!.taskId).toBeUndefined();

  const fromTask = r.createSession({ projectId: p.id, taskId: "cloud-task-9", name: "b", task: "t", worktreePath: "", branch: "c" });
  expect(r.listSessions(p.id).find((s) => s.id === fromTask.id)!.taskId).toBe("cloud-task-9");
  // A status-only update must not drop the task link.
  r.updateSession(fromTask.id, { status: "thinking" });
  expect(r.listSessions(p.id).find((s) => s.id === fromTask.id)!.taskId).toBe("cloud-task-9");
});

test("removeProject deletes the project and its sessions", () => {
  const r = new RegistryService(":memory:");
  const p = r.upsertProject({ id: "p-gone", name: "gone", localRepoPath: "/tmp/gone" });
  r.createSession({ projectId: p.id, name: "a", task: "t", worktreePath: "", branch: "b" });
  r.removeProject(p.id);
  expect(r.listProjects()).toHaveLength(0);
  expect(r.listSessions()).toHaveLength(0);
});
