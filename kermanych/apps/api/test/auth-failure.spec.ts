import { describe, it, expect } from "vitest";
import { authFailureCode } from "../src/runtime/auth-failure";

// The message strings below are VERBATIM from the real SDK / omp, captured by driving a
// deliberately broken child (a missing binary, and a stub that exits 1 the way a signed-out
// CLI does). They are the whole point of this mapper: the operator must be told "run
// claude /login", not shown an English stack-trace tail, so a paraphrase here would be
// testing our own invention instead of what actually arrives.
describe("authFailureCode", () => {
  it("reads a signed-out claude child as claude_not_authenticated", () => {
    expect(
      authFailureCode("Claude Code process exited with code 1. stderr: Invalid API key · Please run /login"),
    ).toBe("claude_not_authenticated");
  });

  it("reads the other phrasings a signed-out claude child uses", () => {
    expect(authFailureCode("Claude Code process exited with code 1. stderr: OAuth token has expired")).toBe(
      "claude_not_authenticated",
    );
    expect(authFailureCode("Claude Code process exited with code 1. stderr: Unauthorized")).toBe(
      "claude_not_authenticated",
    );
    expect(authFailureCode("Claude Code process exited with code 1. stderr: Not logged in")).toBe(
      "claude_not_authenticated",
    );
  });

  it("reads a missing platform binary as claude_binary_missing", () => {
    expect(
      authFailureCode(
        "Claude Code native binary not found at /x/claude. Please ensure Claude Code is installed via native installer or specify a valid path with options.pathToClaudeCodeExecutable.",
      ),
    ).toBe("claude_binary_missing");
  });

  it("reads a signed-out omp child as omp_not_authenticated", () => {
    expect(
      authFailureCode("omp child exited (code 1) before completing request: error: not authenticated, run `omp login`"),
    ).toBe("omp_not_authenticated");
  });

  it("reads a missing omp binary as omp_binary_missing", () => {
    expect(authFailureCode("spawn omp ENOENT")).toBe("omp_binary_missing");
  });

  // The default must stay undefined: an unrecognised failure keeps its own raw text, which is
  // strictly more informative than a wrong guess at a cause. Mislabelling a provider outage
  // as "you are signed out" would send the operator to re-login for nothing.
  it("returns undefined for a failure that is not about auth or a missing binary", () => {
    expect(authFailureCode("Claude Code process exited with code 1. stderr: 500 internal server error")).toBeUndefined();
    expect(authFailureCode("omp did not respond to \"get_state\" within 20000ms")).toBeUndefined();
    expect(authFailureCode("")).toBeUndefined();
  });

  // "login" appears in plenty of unrelated prose (a session about a login form, a failing
  // login test). Matching on it alone would relabel those as an auth failure, so the /login
  // pattern is anchored to the command form the CLIs actually print.
  it("does not mistake prose that merely mentions login for an auth failure", () => {
    expect(authFailureCode("Claude Code process exited with code 1. stderr: login form test failed")).toBeUndefined();
  });
});
