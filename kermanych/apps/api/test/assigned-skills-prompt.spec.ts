import { describe, it, expect } from "vitest";
import { agentById, ASSIGNED_BLOCK_HEADER, assignedBlock, renderInstruction } from "@kermanych/core";

describe("assigned skills reach a launch through the opening prompt", () => {
  // The supervisor builds every launch prompt as `renderInstruction(agent, vars) +
  // assignedBlockFor(...)` (supervisor.service.ts). This is a focused unit test of that
  // assembly, not a full supervisor launch.
  const defs = [
    { name: "kermanych-session", description: "d", body: "How isolation works." },
    { name: "kermanych-pull-request", description: "d", body: "How to open a PR." },
  ];

  it("appends the assigned-skills block, header and bodies, to the instruction", () => {
    const prompt =
      renderInstruction(agentById("promote")!, { branch: "feature/x" }) + assignedBlock(defs);
    expect(prompt).toContain(ASSIGNED_BLOCK_HEADER);
    expect(prompt).toContain("### kermanych-session\nHow isolation works.");
    expect(prompt).toContain("### kermanych-pull-request\nHow to open a PR.");
    // The block trails the instruction rather than replacing it.
    expect(prompt.indexOf(ASSIGNED_BLOCK_HEADER)).toBeGreaterThan(
      prompt.indexOf("feature/x"),
    );
  });

  it("adds nothing when a role has no assigned skills", () => {
    const prompt = renderInstruction(agentById("promote")!, { branch: "feature/x" }) + assignedBlock([]);
    expect(prompt).not.toContain(ASSIGNED_BLOCK_HEADER);
  });
});
