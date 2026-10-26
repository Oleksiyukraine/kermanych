import { describe, expect, it } from "vitest";
import { parseGithubPrUrl, parseGithubRemote } from "../src/github/github-client";

// The merged-PR check (docs/specs/2026-10-26-pr-merged-close-prompt.md) reads owner/repo from the
// project's `origin` and owner/repo/number from a stored PR URL; anything not GitHub is skipped.
describe("parseGithubRemote", () => {
  it.each([
    ["https://github.com/o/r.git", { owner: "o", repo: "r" }],
    ["https://github.com/o/r", { owner: "o", repo: "r" }],
    ["https://github.com/o/r/", { owner: "o", repo: "r" }],
    ["https://x-access-token@github.com/o/r.git", { owner: "o", repo: "r" }],
    ["git@github.com:o/r.git", { owner: "o", repo: "r" }],
    ["git@github.com:o/r", { owner: "o", repo: "r" }],
    ["ssh://git@github.com/o/r.git", { owner: "o", repo: "r" }],
    ["ssh://git@github.com/o/r", { owner: "o", repo: "r" }],
    ["ssh://git@github.com/o/my.repo.git", { owner: "o", repo: "my.repo" }],
    ["git@github.com-kermanych:Oleksiyukraine/kermanych.git", { owner: "Oleksiyukraine", repo: "kermanych" }],
    ["ssh://git@github.com-work/o/r.git", { owner: "o", repo: "r" }],
  ])("reads %s", (url, want) => {
    expect(parseGithubRemote(url)).toEqual(want);
  });

  it.each([
    "https://gitlab.com/o/r.git",
    "git@bitbucket.org:o/r.git",
    "ssh://git@gitlab.example.com/o/r.git",
    "https://github.com.evil.example/o/r.git",
    "git@github.com.evil.example:o/r.git",
    "https://github.com/o",
    "",
  ])("refuses %s", (url) => {
    expect(parseGithubRemote(url)).toBeNull();
  });
});

describe("parseGithubPrUrl", () => {
  it("reads a GitHub pull-request URL", () => {
    expect(parseGithubPrUrl("https://github.com/o/r/pull/42")).toEqual({ owner: "o", repo: "r", number: 42 });
    expect(parseGithubPrUrl("https://github.com/o/r/pull/42/files")).toEqual({ owner: "o", repo: "r", number: 42 });
  });

  it("refuses GitLab, Bitbucket and other GitHub pages", () => {
    expect(parseGithubPrUrl("https://gitlab.com/o/r/-/merge_requests/3")).toBeNull();
    expect(parseGithubPrUrl("https://bitbucket.org/o/r/pull-requests/3")).toBeNull();
    expect(parseGithubPrUrl("https://github.com/o/r/issues/3")).toBeNull();
    expect(parseGithubPrUrl("https://ghe.example.com/o/r/pull/3")).toBeNull();
  });
});
