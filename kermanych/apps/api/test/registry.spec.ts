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
