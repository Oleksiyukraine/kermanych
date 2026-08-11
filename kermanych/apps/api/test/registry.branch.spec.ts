import { describe, it, expect } from "vitest";
import { RegistryService } from "../src/registry/registry.service";

function reg() {
  return new RegistryService(":memory:");
}

describe("registry discussion branches", () => {
  it("defaults kind to 'agent' and parentSessionId to undefined", () => {
    const r = reg();
    const g = r.createGroup({ name: "g", projectDir: "/tmp/x" });
    const s = r.createSession({ groupId: g.id, name: "a", task: "t", worktreePath: "", branch: "b" });
    expect(s.kind).toBe("agent");
    expect(s.parentSessionId).toBeUndefined();
    expect(r.listSessions(g.id)[0]!.kind).toBe("agent");
  });

  it("persists kind='discussion' and parentSessionId", () => {
    const r = reg();
    const g = r.createGroup({ name: "g", projectDir: "/tmp/x" });
    const parent = r.createSession({ groupId: g.id, name: "AAA", task: "t", worktreePath: "", branch: "b" });
    const child = r.createSession({
      groupId: g.id, name: "branch: AAA", task: "", worktreePath: "", branch: "",
      worktree: false, kind: "discussion", parentSessionId: parent.id,
    });
    const read = r.listSessions(g.id).find((x) => x.id === child.id)!;
    expect(read.kind).toBe("discussion");
    expect(read.parentSessionId).toBe(parent.id);
  });
});
