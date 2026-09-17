import { describe, it, expect } from "vitest";
import { DEFAULT_COMMANDS, parseCommand, prependCommand } from "../src/commands";

describe("parseCommand resolves the leading command token", () => {
  it("returns the command and no args for a bare token", () => {
    expect(parseCommand("/compact")).toEqual({ name: "compact", args: "" });
  });

  it("carries the trailing text as trimmed args", () => {
    expect(parseCommand("/compact focus on the auth module")).toEqual({
      name: "compact",
      args: "focus on the auth module",
    });
  });

  it("tolerates leading whitespace before the token", () => {
    expect(parseCommand("  /compact  keep tests  ")).toEqual({ name: "compact", args: "keep tests" });
  });

  it("leaves an unknown token, a longer word, or a path alone", () => {
    // `/compacted` is a different whole word, not a prefix match; a path is not a command.
    expect(parseCommand("/compacted")).toBeNull();
    expect(parseCommand("/deploy now")).toBeNull();
    expect(parseCommand("check /usr/bin/env")).toBeNull();
    expect(parseCommand("compact without a slash")).toBeNull();
  });

  it("only fires on the LEADING token", () => {
    expect(parseCommand("please /compact this")).toBeNull();
  });
});

describe("prependCommand", () => {
  it("prepends the token at the front of the draft", () => {
    expect(prependCommand("keep tests", "compact")).toBe("/compact keep tests");
    expect(prependCommand("", "compact")).toBe("/compact ");
  });

  it("is a no-op when the draft already leads with the command", () => {
    expect(prependCommand("/compact keep tests", "compact")).toBe("/compact keep tests");
  });
});

describe("DEFAULT_COMMANDS", () => {
  it("ships compact with a label and a hint", () => {
    const compact = DEFAULT_COMMANDS.find((c) => c.name === "compact");
    expect(compact).toBeDefined();
    expect(compact!.label.length).toBeGreaterThan(0);
    expect(compact!.hint.length).toBeGreaterThan(0);
  });
});
