import { expect, test } from "vitest";
import {
  changelogBetween,
  changelogSection,
  compareAppVersions,
  isBelowMinimumVersion,
} from "../src/app-release";

const CHANGELOG = [
  "# Changelog",
  "",
  "Intro text that belongs to no version.",
  "",
  "## 0.3.0 — 2026-11-02",
  "",
  "- Third",
  "",
  "```sh",
  "## 9.9.9 — not a heading inside code",
  "```",
  "",
  "## 0.2.1 - 2026-10-20",
  "",
  "## 0.2.0",
  "- Second",
  "",
  "## 0.1.0 — 2026-10-12",
  "- First",
  "",
].join("\n");

test("compareAppVersions orders numerically per part, not as text", () => {
  expect(compareAppVersions("0.10.0", "0.9.9")).toBe(1);
  expect(compareAppVersions("1.0.0", "1.0.0")).toBe(0);
  expect(compareAppVersions("1.2.3", "1.2.10")).toBe(-1);
});

test("compareAppVersions refuses anything that is not MAJOR.MINOR.PATCH", () => {
  expect(compareAppVersions("v1.0.0", "1.0.0")).toBeUndefined();
  expect(compareAppVersions("1.0.0-beta.1", "1.0.0")).toBeUndefined();
  expect(compareAppVersions("1.0", "1.0.0")).toBeUndefined();
});

test("isBelowMinimumVersion locks out only a strictly older app", () => {
  expect(isBelowMinimumVersion("0.1.0", "0.2.0")).toBe(true);
  expect(isBelowMinimumVersion("0.2.0", "0.2.0")).toBe(false);
  expect(isBelowMinimumVersion("0.3.0", "0.2.0")).toBe(false);
});

test("isBelowMinimumVersion never locks out on an unreadable policy", () => {
  expect(isBelowMinimumVersion("0.1.0", null)).toBe(false);
  expect(isBelowMinimumVersion("0.1.0", undefined)).toBe(false);
  expect(isBelowMinimumVersion("0.1.0", "latest")).toBe(false);
  expect(isBelowMinimumVersion("0.0.0-dev", "0.2.0")).toBe(false);
});

test("changelogSection returns one version's body and its date", () => {
  expect(changelogSection(CHANGELOG, "0.1.0")).toEqual({ version: "0.1.0", date: "2026-10-12", body: "- First" });
  expect(changelogSection(CHANGELOG, "0.2.0")).toEqual({ version: "0.2.0", date: "", body: "- Second" });
});

test("changelogSection keeps a heading-like line inside a code block in the body", () => {
  expect(changelogSection(CHANGELOG, "0.3.0")?.body).toBe(
    "- Third\n\n```sh\n## 9.9.9 — not a heading inside code\n```",
  );
  expect(changelogSection(CHANGELOG, "9.9.9")).toBeUndefined();
});

test("changelogSection reports an empty section as an empty body and a missing one as undefined", () => {
  expect(changelogSection(CHANGELOG, "0.2.1")).toEqual({ version: "0.2.1", date: "2026-10-20", body: "" });
  expect(changelogSection(CHANGELOG, "0.4.0")).toBeUndefined();
});

test("changelogBetween returns the unseen versions, newest first, bounded on both sides", () => {
  expect(changelogBetween(CHANGELOG, "0.1.0", "0.2.1").map((e) => e.version)).toEqual(["0.2.1", "0.2.0"]);
  expect(changelogBetween(CHANGELOG, "0.2.1", "0.2.1")).toEqual([]);
});

test("changelogBetween falls back to the target's own section when the running version is unknown", () => {
  expect(changelogBetween(CHANGELOG, "0.0.0-dev", "0.2.0").map((e) => e.version)).toEqual(["0.2.0"]);
});
