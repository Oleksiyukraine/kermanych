// apps/api/test/registry.spec.ts
import { expect, test } from "vitest";
import { RegistryService } from "../src/registry/registry.service";

test("group + session round trip", () => {
  const r = new RegistryService(":memory:");
  const g = r.createGroup({ name: "app", projectDir: "/tmp/app" });
  expect(r.listGroups()).toHaveLength(1);
  const s = r.createSession({ groupId: g.id, name: "task", task: "do it", worktreePath: "/wt", branch: "kermanych/task" });
  expect(s.status).toBe("queued");
  const u = r.updateSession(s.id, { status: "done", contextPercent: 12 });
  expect(u.status).toBe("done");
  expect(r.listSessions(g.id)).toHaveLength(1);
  r.removeSession(s.id);
  expect(r.listSessions(g.id)).toHaveLength(0);
});

test("session archived flag defaults false and round-trips", () => {
  const r = new RegistryService(":memory:");
  const g = r.createGroup({ name: "app", projectDir: "/tmp/app" });
  const s = r.createSession({ groupId: g.id, name: "task", task: "do it", worktreePath: "/wt", branch: "kermanych/task" });
  expect(r.listSessions(g.id)[0].archived).toBe(false);
  const u = r.updateSession(s.id, { archived: true });
  expect(u.archived).toBe(true);
  expect(r.listSessions(g.id)[0].archived).toBe(true);
  r.updateSession(s.id, { archived: false });
  expect(r.listSessions(g.id)[0].archived).toBe(false);
});

test("createSession stamps lastActivityAt equal to createdAt", () => {
  const r = new RegistryService(":memory:");
  const g = r.createGroup({ name: "app", projectDir: "/tmp/app" });
  const s = r.createSession({ groupId: g.id, name: "task", task: "do it", worktreePath: "/wt", branch: "kermanych/task" });
  expect(s.lastActivityAt).toBe(s.createdAt);
  expect(r.listSessions(g.id)[0].lastActivityAt).toBe(s.createdAt);
});

test("touchSession advances lastActivityAt without touching other fields", async () => {
  const r = new RegistryService(":memory:");
  const g = r.createGroup({ name: "app", projectDir: "/tmp/app" });
  const s = r.createSession({ groupId: g.id, name: "task", task: "do it", worktreePath: "/wt", branch: "kermanych/task" });
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
  const g = r.createGroup({ name: "app", projectDir: "/tmp/app" });

  const wtSession = r.createSession({ groupId: g.id, name: "wt", task: "t", worktreePath: "/wt", branch: "feature/wt" });
  expect(wtSession.worktree).toBe(true);
  expect(r.listSessions(g.id).find((s) => s.id === wtSession.id)!.worktree).toBe(true);

  const inPlace = r.createSession({
    groupId: g.id, name: "ip", task: "t", worktreePath: "", branch: "fix/ip",
    worktree: false, baseBranch: "main",
  });
  const read = r.listSessions(g.id).find((s) => s.id === inPlace.id)!;
  expect(read.worktree).toBe(false);
  expect(read.baseBranch).toBe("main");
});

test("group carryFiles defaults to [.env] and round-trips", () => {
  const r = new RegistryService(":memory:");
  const g = r.createGroup({ name: "app", projectDir: "/tmp/app" });
  expect(g.carryFiles).toEqual([".env"]);
  expect(r.listGroups()[0].carryFiles).toEqual([".env"]);

  const withList = r.createGroup({ name: "b", projectDir: "/tmp/b", carryFiles: [".env", ".env.local"] });
  expect(r.listGroups().find((x) => x.id === withList.id)!.carryFiles).toEqual([".env", ".env.local"]);

  const u = r.updateGroup(g.id, { carryFiles: [".env", "config/svc.json"] });
  expect(u.carryFiles).toEqual([".env", "config/svc.json"]);
  expect(r.listGroups().find((x) => x.id === g.id)!.carryFiles).toEqual([".env", "config/svc.json"]);
});

test("updateGroup renames the group and round-trips", () => {
  const r = new RegistryService(":memory:");
  const g = r.createGroup({ name: "old", projectDir: "/tmp/app" });
  const u = r.updateGroup(g.id, { name: "new" });
  expect(u.name).toBe("new");
  expect(r.listGroups().find((x) => x.id === g.id)!.name).toBe("new");
  // A name-only patch leaves the other columns intact.
  expect(r.listGroups().find((x) => x.id === g.id)!.carryFiles).toEqual([".env"]);
});

test("group color defaults unset, round-trips, and clears via updateGroup", () => {
  const r = new RegistryService(":memory:");
  const g = r.createGroup({ name: "app", projectDir: "/tmp/app" });
  expect(g.color).toBeUndefined();
  expect(r.listGroups()[0].color).toBeUndefined();

  const u = r.updateGroup(g.id, { color: "#ff563c" });
  expect(u.color).toBe("#ff563c");
  expect(r.listGroups().find((x) => x.id === g.id)!.color).toBe("#ff563c");

  // A name-only patch leaves the color intact.
  r.updateGroup(g.id, { name: "renamed" });
  expect(r.listGroups().find((x) => x.id === g.id)!.color).toBe("#ff563c");

  // An empty color clears it back to unset (both the echo and the re-read).
  const cleared = r.updateGroup(g.id, { color: "" });
  expect(cleared.color).toBeUndefined();
  expect(r.listGroups().find((x) => x.id === g.id)!.color).toBeUndefined();
});

test("group defaultBranch defaults unset, round-trips, and clears via updateGroup", () => {
  const r = new RegistryService(":memory:");
  const g = r.createGroup({ name: "app", projectDir: "/tmp/app" });
  expect(g.defaultBranch).toBeUndefined();
  expect(r.listGroups()[0].defaultBranch).toBeUndefined();

  const created = r.createGroup({ name: "app2", projectDir: "/tmp/app2", defaultBranch: "main" });
  expect(r.listGroups().find((x) => x.id === created.id)!.defaultBranch).toBe("main");

  const u = r.updateGroup(g.id, { defaultBranch: "develop" });
  expect(u.defaultBranch).toBe("develop");
  expect(r.listGroups().find((x) => x.id === g.id)!.defaultBranch).toBe("develop");

  // A name-only patch leaves the default branch intact.
  r.updateGroup(g.id, { name: "renamed" });
  expect(r.listGroups().find((x) => x.id === g.id)!.defaultBranch).toBe("develop");

  // An empty default branch clears it back to unset.
  const cleared = r.updateGroup(g.id, { defaultBranch: "" });
  expect(cleared.defaultBranch).toBeUndefined();
  expect(r.listGroups().find((x) => x.id === g.id)!.defaultBranch).toBeUndefined();
});

test("group conventions defaults unset, round-trips, and clears via updateGroup", () => {
  const r = new RegistryService(":memory:");
  const g = r.createGroup({ name: "app", projectDir: "/tmp/app" });
  expect(g.conventions).toBeUndefined();
  expect(r.listGroups()[0].conventions).toBeUndefined();

  const created = r.createGroup({ name: "app2", projectDir: "/tmp/app2", conventions: "feat: rule" });
  expect(r.listGroups().find((x) => x.id === created.id)!.conventions).toBe("feat: rule");

  const u = r.updateGroup(g.id, { conventions: "PR body: Summary + Testing" });
  expect(u.conventions).toBe("PR body: Summary + Testing");
  expect(r.listGroups().find((x) => x.id === g.id)!.conventions).toBe("PR body: Summary + Testing");

  // A name-only patch leaves the conventions intact.
  r.updateGroup(g.id, { name: "renamed" });
  expect(r.listGroups().find((x) => x.id === g.id)!.conventions).toBe("PR body: Summary + Testing");

  // An empty conventions string clears it back to unset.
  const cleared = r.updateGroup(g.id, { conventions: "" });
  expect(cleared.conventions).toBeUndefined();
  expect(r.listGroups().find((x) => x.id === g.id)!.conventions).toBeUndefined();
});

test("backlog task persists launch config (model, prefix, kind, status) round-trip", () => {
  const r = new RegistryService(":memory:");
  const g = r.createGroup({ name: "app", projectDir: "/tmp/app" });
  const t = r.createSession({
    groupId: g.id, name: "planned", task: "later", worktreePath: "", branch: "",
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
  const g = r.createGroup({ name: "app", projectDir: "/tmp/app" });
  const s = r.createSession({ groupId: g.id, name: "task", task: "do it", worktreePath: "/wt", branch: "kermanych/task", platform: "web" });
  expect(r.listSessions(g.id)[0].platform).toBe("web");
  const u = r.updateSession(s.id, { platform: "mobile" });
  expect(u.platform).toBe("mobile");
  expect(r.listSessions(g.id)[0].platform).toBe("mobile");
});
