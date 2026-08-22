import { expect, test, vi } from "vitest";
import { GoneException } from "@nestjs/common";
import { SessionsController } from "../src/http/sessions.controller";

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
