import { expect, test } from "vitest";
import { docsRead, isDocPath } from "../src/docs";
import type { TranscriptEntry } from "../src/types";

test("isDocPath accepts markup files, conventional doc names and docs/ dirs", () => {
  for (const ok of [
    "README.md",
    "docs/guide.md",
    "doc/architecture.md",
    "CHANGELOG",
    "LICENSE",
    "LICENCE",
    "CONTRIBUTING.md",
    ".claude/module-patterns.agent.mdc",
    "guide.rst",
    "notes.mdx",
    "spec.asciidoc",
    "a/b/docs/deep/thing.md", // extension still wins once the path is shortened
    "CLAUDE.md:1-50", // a ranged read target
  ])
    expect(isDocPath(ok)).toBe(true);

  for (const no of [
    "",
    "src/app.ts",
    "package.json",
    "requirements.txt", // .txt is not treated as documentation
    "image.png",
    "mydocs/logo.svg", // docs/ must be a real path segment, not a suffix
    "src/a.ts:10-20",
  ])
    expect(isDocPath(no)).toBe(false);
});

test("docsRead lists unique docs read, in order, ignoring non-reads and ranges", () => {
  const entries = [
    { kind: "user_text", id: "0", at: 0, text: "docs/guide.md" }, // prose, not a tool row
    { kind: "tool", id: "1", at: 1, tool: "read", status: "ok", target: "docs/guide.md:1-40" },
    { kind: "tool", id: "2", at: 2, tool: "read", status: "ok", target: "src/app.ts" }, // read, not a doc
    { kind: "tool", id: "3", at: 3, tool: "read", status: "ok", target: "README.md" },
    { kind: "tool", id: "4", at: 4, tool: "read", status: "ok", target: "docs/guide.md:80-90" }, // same doc, later range
    { kind: "tool", id: "5", at: 5, tool: "edit", status: "ok", target: "docs/guide.md" }, // a change, not a read
    { kind: "tool", id: "6", at: 6, tool: "skill", status: "ok", target: "kermanych-session" }, // a skill, not a doc read
    { kind: "tool", id: "7", at: 7, tool: "read", status: "pending" }, // no target yet
  ] as TranscriptEntry[];
  expect(docsRead(entries)).toEqual(["docs/guide.md", "README.md"]);
});
