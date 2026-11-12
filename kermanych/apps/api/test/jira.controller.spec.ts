// apps/api/test/jira.controller.spec.ts
import { describe, it, expect, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { JiraController } from "../src/http/jira.controller";
import type { JiraService } from "../src/jira/jira.service";

// A tracker launch may open the task as a native session, validated exactly like
// POST /sessions/from-task.
describe("JiraController launch", () => {
  const req = { user: { id: "u1" } };

  it("refuses an unknown native harness before launching", async () => {
    const launch = vi.fn();
    const controller = new JiraController({ launch } as unknown as JiraService);
    await expect(controller.launch("i1", "KEY-1", { projectId: "p1", native: "vim" }, req)).rejects.toBeInstanceOf(BadRequestException);
    expect(launch).not.toHaveBeenCalled();
  });

  it("passes a valid native harness on to the launch", async () => {
    const launch = vi.fn(async () => ({ session: { id: "s1" } }));
    const controller = new JiraController({ launch } as unknown as JiraService);
    await controller.launch("i1", "KEY-1", { projectId: "p1", native: "claude-code" }, req);
    expect(launch).toHaveBeenCalledWith("i1", "KEY-1", "p1", "u1", undefined, undefined, "claude-code");
  });
});
