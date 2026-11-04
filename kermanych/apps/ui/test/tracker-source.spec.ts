import { describe, expect, it } from "vitest";
import { pickTrackerSource } from "../src/lib/tracker-source";

describe("pickTrackerSource", () => {
  it("reads the only connected tracker, whatever was remembered", () => {
    expect(pickTrackerSource(["plane"], "jira")).toBe("plane");
    expect(pickTrackerSource(["jira"], "plane")).toBe("jira");
  });
  it("keeps the remembered pick when both are connected, else Jira", () => {
    expect(pickTrackerSource(["jira", "plane"], "plane")).toBe("plane");
    expect(pickTrackerSource(["jira", "plane"], null)).toBe("jira");
    expect(pickTrackerSource(["jira", "plane"], "linear")).toBe("jira");
  });
  it("has no source when nothing is connected", () => expect(pickTrackerSource([], "jira")).toBeNull());
});
