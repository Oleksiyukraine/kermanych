import { describe, expect, it } from "vitest";
import { pickFindingIssueType } from "../src/lib/findings";

const types = [
  { id: "10", name: "Sub-task", subtask: true },
  { id: "1", name: "Story", subtask: false },
  { id: "2", name: "bug", subtask: false },
  { id: "3", name: "Task", subtask: false },
];

describe("pickFindingIssueType", () => {
  it("files a bug and a vulnerability as Bug, matching the name case-insensitively", () => {
    expect(pickFindingIssueType(types, "bug")).toBe("2");
    expect(pickFindingIssueType(types, "security")).toBe("2");
  });
  it("files tech debt and docs as Task", () => {
    expect(pickFindingIssueType(types, "tech-debt")).toBe("3");
    expect(pickFindingIssueType(types, "docs")).toBe("3");
  });
  it("falls back to the first non-subtask type when the site has no such name", () =>
    expect(pickFindingIssueType([types[0]!, types[1]!], "bug")).toBe("1"));
  it("never picks a subtask type", () => expect(pickFindingIssueType([types[0]!], "docs")).toBeUndefined());
});
