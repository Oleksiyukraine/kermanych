import { describe, it, expect, vi } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { AuthFailureCode } from "../src/runtime/auth-failure";

// A child's exit, as the runtime reports it, is what settles a session that died. A chat sits
// at `done` between turns, and the old rule treated every `done` exit as clean, so a chat whose
// first turn hit a signed-out CLI stayed `done` and the operator never learned a login was
// needed. The runtime names the cause; the session must carry it.
type Exit = (code: number | null, reason: string, cause?: AuthFailureCode) => void;
const exits: Exit[] = [];
vi.mock("../src/runtime/agent-runtime", () => ({
  createRuntime: () => ({
    start: async () => {},
    isAlive: () => true,
    droppedFrames: 0,
    prompt: () => {},
    followUp: () => {},
    steer: () => {},
    answerUi: () => {},
    getState: async () => ({ isStreaming: false }),
    switchSession: async () => {},
    setModel: async () => {},
    setThinkingLevel: async () => {},
    getAllMessages: async () => [],
    stop: async () => {},
    onEvent: () => {},
    onExit: (cb: Exit) => exits.push(cb),
  }),
}));

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { offlineAuth } from "./offline-auth";
import { stubSkills } from "./skills-stub";

async function chat() {
  exits.length = 0;
  const registry = new RegistryService(":memory:");
  const sup = new SupervisorService(registry, {} as WorktreeService, offlineAuth(), stubSkills());
  registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
  const created = await sup.createChat("p1");
  const session = () => sup.snapshot().sessions.find((s) => s.id === created.id)!;
  return { created, session };
}

describe("a runtime exit settles the session", () => {
  it("marks a signed-out exit as an error carrying the cause, even from done", async () => {
    const { created, session } = await chat();
    expect(created.status).toBe("done");

    exits.at(-1)!(null, "Claude Code is not signed in: Not logged in · Please run /login", "claude_not_authenticated");

    expect(session()).toMatchObject({ status: "error", errorCode: "claude_not_authenticated" });
  });

  it("leaves a done session done when its child exits for any other reason", async () => {
    const { session } = await chat();

    exits.at(-1)!(0, "claude query ended");

    expect(session().status).toBe("done");
    expect(session().errorCode).toBeUndefined();
  });
});
