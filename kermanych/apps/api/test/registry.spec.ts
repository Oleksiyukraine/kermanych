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
