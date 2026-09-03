// apps/api/test/account.controller.spec.ts
import { describe, it, expect } from "vitest";
import { BadRequestException } from "@nestjs/common";
import type { AgentRuntimeKind } from "@kermanych/core";
import { AccountController } from "../src/http/account.controller";
import type { RegistryService } from "../src/registry/registry.service";
import type { AuthSessionRow } from "../src/registry/registry.service";

function make(getSession?: AuthSessionRow | undefined, setCalled?: (row: AuthSessionRow) => void) {
  const registry = {
    getAuthSession: () => getSession,
    setAuthSession: (row: AuthSessionRow) => setCalled?.(row),
  } as unknown as RegistryService;
  return new AccountController(registry);
}

describe("AccountController", () => {
  it("GET /account/runtime returns null when no auth session", () => {
    const controller = make(undefined);
    expect(controller.getRuntime()).toEqual({ runtime: null });
  });

  it("GET /account/runtime returns null when session has no agentRuntime", () => {
    const controller = make({ userId: "u1", accessToken: "tok" });
    expect(controller.getRuntime()).toEqual({ runtime: null });
  });

  it("GET /account/runtime returns cached agentRuntime", () => {
    const controller = make({ userId: "u1", accessToken: "tok", agentRuntime: "claude-code" });
    expect(controller.getRuntime()).toEqual({ runtime: "claude-code" });
  });

  it("POST /account/runtime throws BadRequestException for invalid runtime", () => {
    const controller = make({ userId: "u1", accessToken: "tok" });
    expect(() => controller.setRuntime({ runtime: "invalid" })).toThrow(BadRequestException);
  });

  it("POST /account/runtime throws BadRequestException when not signed in", () => {
    const controller = make(undefined);
    expect(() => controller.setRuntime({ runtime: "claude-code" })).toThrow(BadRequestException);
  });

  it("POST /account/runtime sets agentRuntime and preserves existing session", () => {
    let captured: AuthSessionRow | undefined;
    const existing: AuthSessionRow = { userId: "u1", accessToken: "tok", githubUsername: "alice" };
    const controller = make(existing, (row) => (captured = row));

    const result = controller.setRuntime({ runtime: "claude-code" });

    expect(result).toEqual({ runtime: "claude-code" });
    expect(captured).toEqual({
      userId: "u1",
      accessToken: "tok",
      githubUsername: "alice",
      agentRuntime: "claude-code" as AgentRuntimeKind,
    });
  });

  it("POST /account/runtime updates existing agentRuntime", () => {
    let captured: AuthSessionRow | undefined;
    const existing: AuthSessionRow = {
      userId: "u1",
      accessToken: "tok",
      githubUsername: "alice",
      agentRuntime: "omp",
    };
    const controller = make(existing, (row) => (captured = row));

    controller.setRuntime({ runtime: "claude-code" });

    expect(captured?.agentRuntime).toBe("claude-code");
  });
});
