import { describe, expect, test } from "vitest";
import {
  qaHandoffText,
  qaItemsInScope,
  qaScreenshotDir,
  testerAccountsBlock,
  testerRefusal,
} from "../src/tester";
import type { QaChecklistItem } from "../src/task-actions";

const verdict = (status: "passed" | "failed" | "blocked", sessionId = "t1") => ({
  status,
  note: `${status} note`,
  sessionId,
  at: "2026-11-04T10:00:00.000Z",
});

const items: QaChecklistItem[] = [
  { id: "q1", text: "Увійти", checked: true, checkedBy: "u1", checkedAt: "x", agent: verdict("passed") },
  { id: "q2", text: "Відкрити дошку", checked: false, agent: verdict("failed") },
  { id: "q3", text: "Видалити картку", checked: false, agent: verdict("blocked") },
  { id: "q4", text: "Порожній стан", checked: true },
];

describe("qaItemsInScope", () => {
  test("`open` skips only passed items — a human tick does not exclude an item", () => {
    expect(qaItemsInScope(items, "open").map((i) => i.id)).toEqual(["q2", "q3", "q4"]);
  });

  test("`all` keeps every item in checklist order", () => {
    expect(qaItemsInScope(items, "all").map((i) => i.id)).toEqual(["q1", "q2", "q3", "q4"]);
  });
});

describe("qaHandoffText", () => {
  test("lists only this run's failed and blocked items, with notes and screenshots", () => {
    const withShot = items.map((i) => (i.id === "q2" ? { ...i, agent: { ...i.agent!, screenshot: "docs/qa/x/q2.png" } } : i));
    const text = qaHandoffText("тестування: board", "t1", withShot);
    expect(text).toContain("2 з 4");
    expect(text).toContain("✗ не пройдено — Відкрити дошку");
    expect(text).toContain("⏸ заблоковано — Видалити картку");
    expect(text).toContain("`docs/qa/x/q2.png`");
    expect(text).not.toContain("Увійти");
    expect(text).not.toContain("Порожній стан");
  });

  test("ignores another run's verdicts and is empty when nothing failed", () => {
    expect(qaHandoffText("t", "t2", items)).toBe("");
    expect(qaHandoffText("t", "t1", [items[0]!, items[3]!])).toBe("");
  });
});

test("the accounts block never carries a password and says when there are no accounts", () => {
  const block = testerAccountsBlock([{ name: "Адмін", login: "admin@x.io", note: " все бачить " }]);
  expect(block).toBe("- «Адмін» — login `admin@x.io` — все бачить");
  expect(testerAccountsBlock([])).toMatch(/blocked/);
});

test("the screenshot dir is dated and branch-derived, safe for a path", () => {
  expect(qaScreenshotDir(new Date("2026-11-04T23:00:00Z"), "feature/add qa/тест")).toBe("docs/qa/2026-11-04-session");
  expect(qaScreenshotDir(new Date("2026-11-04T23:00:00Z"), "feature/add-qa-tester")).toBe("docs/qa/2026-11-04-add-qa-tester");
});

describe("testerRefusal", () => {
  const ok = {
    kind: "agent",
    status: "done",
    worktree: true,
    worktreePath: "/w",
    taskId: "t",
    runningTester: false,
    browserHost: true,
    platformHasBrowser: true,
  };

  test("an idle doer with a card, a worktree and a browser can be tested", () => {
    expect(testerRefusal(ok)).toBeNull();
    expect(testerRefusal({ ...ok, status: "in_review" })).toBeNull();
  });

  test("a running tester wins over every other reason", () => {
    expect(testerRefusal({ ...ok, runningTester: true, status: "thinking", taskId: undefined })).toBe("running");
  });

  test.each([
    [{ kind: "chat" }, "not-agent"],
    [{ status: "merged" }, "finished"],
    [{ worktreePath: "" }, "finished"],
    [{ taskId: undefined }, "no-card"],
    [{ platformHasBrowser: false }, "platform"],
    [{ browserHost: false }, "no-browser"],
    [{ status: "thinking" }, "busy"],
    [{ status: "tool" }, "busy"],
  ] as const)("%o → %s", (patch, reason) => {
    expect(testerRefusal({ ...ok, ...patch })).toBe(reason);
  });

  test("an in-place session (no worktree) is not finished for lacking a path", () => {
    expect(testerRefusal({ ...ok, worktree: false, worktreePath: "" })).toBeNull();
  });
});
