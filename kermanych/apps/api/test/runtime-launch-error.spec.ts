import { describe, it, expect } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { sessionFailure } from "../src/http/session-failure";
import type { ApiErrorBody } from "@kermanych/core";

// Every sessions endpoint funnels a supervisor failure through one `catch`, which used to keep
// only `.message` — dropping the cause a runtime had already identified. `sessionFailure` is
// that catch: it preserves the raw prose as the fallback and promotes a runtime's launch code
// to the `ApiErrorBody` the UI localizes.
describe("sessionFailure", () => {
  it("promotes a runtime launch code to a localizable ApiErrorBody", () => {
    const err = new Error("Claude Code process exited with code 1. stderr: Invalid API key · Please run /login") as Error & { code?: string };
    err.code = "claude_not_authenticated";

    const thrown = sessionFailure(err);

    expect(thrown).toBeInstanceOf(BadRequestException);
    const body = thrown.getResponse() as ApiErrorBody;
    expect(body.code).toBe("runtime_claude_not_authenticated");
    // The child's own words stay as the fallback prose: a UI build that does not know the code
    // must still show something an operator can act on.
    expect(body.message).toContain("Please run /login");
  });

  it("maps every runtime cause to its own launch code", () => {
    const cases: Array<[string, string]> = [
      ["claude_not_authenticated", "runtime_claude_not_authenticated"],
      ["claude_binary_missing", "runtime_claude_binary_missing"],
      ["omp_not_authenticated", "runtime_omp_not_authenticated"],
      ["omp_binary_missing", "runtime_omp_binary_missing"],
    ];
    for (const [cause, expected] of cases) {
      const err = new Error("x") as Error & { code?: string };
      err.code = cause;
      expect((sessionFailure(err).getResponse() as ApiErrorBody).code).toBe(expected);
    }
  });

  // An ordinary domain refusal ("project not bound", "worktree must be clean") carries no code
  // and must keep behaving exactly as before: a 400 whose body is the plain sentence. Inventing
  // a code for it would make the UI localize a message it has no translation for.
  it("leaves an uncoded failure as a plain-message 400", () => {
    const thrown = sessionFailure(new Error("project not bound"));
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(thrown.getResponse()).toMatchObject({ message: "project not bound" });
  });

  // A `code` that is not one of ours (e.g. node's `ENOENT` on an unrelated fs call, which also
  // lands on Error.code) must not be mistaken for a runtime cause.
  it("ignores a code that is not a runtime cause", () => {
    const err = new Error("ENOENT: no such file") as Error & { code?: string };
    err.code = "ENOENT";
    expect(sessionFailure(err).getResponse()).toMatchObject({ message: "ENOENT: no such file" });
  });
});
