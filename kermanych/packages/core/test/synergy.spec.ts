// packages/core/test/synergy.spec.ts
import { expect, test } from "vitest";
import {
  synergyBrief,
  synergyCheckpointMessage,
  synergyChronology,
  synergyMessage,
  synergyRequestOf,
  synergyRestoreMessage,
  synergySteps,
  type SynergyCommit,
} from "../src";

const TRAILER = "\n\nCo-Authored-By: Kermanych <k@example.com>";

// The api reads back the operator's own words and the page from what the UI sent, whatever the
// picks block holds; a bare request round-trips untouched.
test("synergyMessage and synergyRequestOf round-trip the request and the page", () => {
  const msg = synergyMessage("  Прибери кнопку  ", { page: "http://localhost:5173/users/42", picks: "## Елемент 1\nСторінка: http://x/y" });
  expect(msg.startsWith("Прибери кнопку\n\n[synergy-context]\nCurrent page: http://localhost:5173/users/42")).toBe(true);
  expect(synergyRequestOf(msg)).toEqual({ request: "Прибери кнопку", page: "http://localhost:5173/users/42" });
  expect(synergyMessage("Додай фільтр", {})).toBe("Додай фільтр");
  expect(synergyRequestOf("Додай фільтр")).toEqual({ request: "Додай фільтр" });
  // Picks alone: no words, the context block still goes.
  expect(synergyRequestOf(synergyMessage("", { picks: "## Елемент 1" }))).toEqual({ request: "" });
});

// A long first line is clipped in the subject only; the body keeps every request of the turn
// and the last page, and the parser gets them back without the co-author trailer.
test("a checkpoint commit parses back into a change step", () => {
  const long = "Перенеси пункт меню «Звіти» з секції «Аналітика» в секцію «Керування», над «Налаштуваннями», і зроби його жирним";
  const message = synergyCheckpointMessage([
    { request: long, page: "/menu" },
    { request: "і без іконки", page: "/menu?tab=2" },
  ]);
  const subject = message.split("\n")[0]!;
  expect(subject.startsWith("synergy: Перенеси")).toBe(true);
  expect(subject.length).toBeLessThanOrEqual("synergy: ".length + 72);
  const [step] = synergySteps([{ sha: "a1", at: "2026-11-06T10:00:00Z", message: message + TRAILER }]);
  expect(step).toEqual({ sha: "a1", n: 1, at: "2026-11-06T10:00:00Z", kind: "change", request: `${long}\n\nі без іконки`, page: "/menu?tab=2" });
});

test("a turn with no words still makes a readable checkpoint", () => {
  const [step] = synergySteps([{ sha: "a1", at: "t", message: synergyCheckpointMessage([{ request: "  " }]) }]);
  expect(step!.request).toBe("зміни");
  expect(step!.page).toBeUndefined();
});

// Commits Kermanych did not write (the implementer's, a merge of the base) are not steps, and
// restores are numbered steps that remember their target.
test("synergySteps skips foreign commits and numbers restores", () => {
  const commits: SynergyCommit[] = [
    { sha: "s1", at: "t1", message: synergyCheckpointMessage([{ request: "A" }]) },
    { sha: "x", at: "t2", message: "fix: something else\n\nbody" },
    { sha: "s2", at: "t3", message: synergyRestoreMessage(0, "base") + TRAILER },
  ];
  expect(synergySteps(commits).map((s) => [s.sha, s.n, s.kind, s.restoreOf])).toEqual([
    ["s1", 1, "change", undefined],
    ["s2", 2, "restore", "base"],
  ]);
});

// The brief's chronology is what the tree at HEAD holds: going back drops what came after the
// target, going "forward" to a later step brings its requests back.
test("synergyChronology follows restores", () => {
  const commits: SynergyCommit[] = [
    { sha: "c1", at: "t", message: synergyCheckpointMessage([{ request: "A" }]) },
    { sha: "c2", at: "t", message: synergyCheckpointMessage([{ request: "B" }]) },
    { sha: "c3", at: "t", message: synergyCheckpointMessage([{ request: "C", page: "/c" }]) },
    { sha: "r1", at: "t", message: synergyRestoreMessage(1, "c1") },
    { sha: "c4", at: "t", message: synergyCheckpointMessage([{ request: "D" }]) },
  ];
  const steps = synergySteps(commits);
  expect(synergyChronology(steps, "base").map((r) => r.request)).toEqual(["A", "D"]);
  const forward = synergySteps([...commits, { sha: "r2", at: "t", message: synergyRestoreMessage(3, "c3") }]);
  expect(synergyChronology(forward, "base")).toEqual([{ request: "A" }, { request: "B" }, { request: "C", page: "/c" }]);
  const toStart = synergySteps([...commits, { sha: "r3", at: "t", message: synergyRestoreMessage(0, "base") }]);
  expect(synergyChronology(toStart, "base")).toEqual([]);
});

test("synergyBrief lists the start page and the requests with their pages", () => {
  expect(
    synergyBrief({ startPage: "/users/42", requests: [{ request: "Прибери кнопку\nі тінь", page: "/users/42" }, { request: "Додай фільтр" }] }),
  ).toBe(
    "Start page: /users/42\n\nOperator requests, in order (rolled-back steps excluded):\n" +
      "1. Прибери кнопку\n   і тінь\n   Page: /users/42\n2. Додай фільтр",
  );
  expect(synergyBrief({ requests: [] })).toBe("Operator requests, in order (rolled-back steps excluded):\n(none)");
});
