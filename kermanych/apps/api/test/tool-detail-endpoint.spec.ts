import { expect, test, vi } from "vitest";
import { GoneException } from "@nestjs/common";
import { SessionsController } from "../src/http/sessions.controller";
import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { ToolDetailCache } from "../src/supervisor/tool-detail-cache";

test("returns cached lines for a call id", () => {
  const sup = { getToolDetail: vi.fn().mockReturnValue({ lines: [{ t: "ctx", text: "x" }], totalLines: 1 }) };
  const c = new SessionsController(sup as never, {} as never, {} as never);
  expect(c.toolDetail("s1", "c1")).toEqual({ lines: [{ t: "ctx", text: "x" }], totalLines: 1 });
  expect(sup.getToolDetail).toHaveBeenCalledWith("s1", "c1");
});

test("propagates a cache miss as 410 Gone", () => {
  const sup = { getToolDetail: vi.fn(() => { throw new GoneException("вивід більше недоступний"); }) };
  const c = new SessionsController(sup as never, {} as never, {} as never);
  expect(() => c.toolDetail("s1", "gone")).toThrow(GoneException);
});

// The controller tests above only prove the delegation; this one runs the real lookup so a
// swapped key order, a renamed field, or a missing throw cannot stay green.
test("the service serves cached lines and 410s on an unknown call id or session id", () => {
  const sup = new SupervisorService(new RegistryService(":memory:"), {} as unknown as WorktreeService);
  // Same private-field reach `supervisor.live-transcript.spec.ts` uses: the cache is only
  // ever filled by the omp event path, which this test deliberately does not run.
  const cache = (sup as unknown as { toolDetails: ToolDetailCache }).toolDetails;
  cache.put("s1", "c1", [{ t: "ctx", text: "x" }]);
  expect(sup.getToolDetail("s1", "c1")).toEqual({ lines: [{ t: "ctx", text: "x" }], totalLines: 1 });
  expect(() => sup.getToolDetail("s1", "nope")).toThrow(GoneException);
  expect(() => sup.getToolDetail("nope", "c1")).toThrow(GoneException);
});

// The effort route is the one place an operator-supplied string becomes an omp RPC field, so
// the level is validated at the door: omp's own refusal is asynchronous and would never reach
// the caller of this POST.
test("the effort route refuses a level omp has no rung for and never reaches the supervisor", async () => {
  const sup = { setEffort: vi.fn() };
  const c = new SessionsController(sup as never, {} as never, {} as never);
  await expect(c.effort("s1", { level: "ludicrous" })).rejects.toThrow(/ludicrous/);
  expect(sup.setEffort).not.toHaveBeenCalled();
  await c.effort("s1", { level: "xhigh" });
  expect(sup.setEffort).toHaveBeenCalledWith("s1", "xhigh");
});
