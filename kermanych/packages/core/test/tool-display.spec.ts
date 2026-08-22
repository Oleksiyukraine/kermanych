import { expect, test } from "vitest";
import { toolDisplay, clampLines, shortPath, humanBytes } from "../src/tool-display";

test("shortPath keeps the last segments and preserves a line range", () => {
  expect(shortPath("kermanych/apps/ui/src/components/kit/KPanel.vue")).toBe("kit/KPanel.vue");
  expect(shortPath("kermanych/apps/ui/src/lib/tip.ts:112-147")).toBe("lib/tip.ts:112-147");
  expect(shortPath("kermanych/apps/ui/src", 1)).toBe("src");
  expect(shortPath("")).toBe("");
});

test("humanBytes switches to KB above 1024", () => {
  expect(humanBytes(17)).toBe("17 B");
  expect(humanBytes(4730)).toBe("4.6 KB");
  expect(humanBytes(undefined)).toBeUndefined();
});

test("read reports shown/total lines and numbers each line", () => {
  const d = {
    totalLines: 145,
    fileSize: 4730,
    truncation: { reason: "range" },
    displayContent: { text: "a\nb\nc", startLine: 24, lineNumbers: [24, 25, 26] },
  };
  const out = toolDisplay("read", { path: "kermanych/apps/ui/src/lib/tip.ts:24-30" }, d, "");
  expect(out.target).toBe("lib/tip.ts:24-30");
  expect(out.stat).toBe("3/145 ln");
  expect(out.count).toBe(3);
  expect(out.truncatedUpstream).toBe(true);
  expect(out.lines).toEqual([
    { t: "ctx", n: "24", text: "a" },
    { t: "ctx", n: "25", text: "b" },
    { t: "ctx", n: "26", text: "c" },
  ]);
});

test("read of a whole file omits the shown/total form", () => {
  const out = toolDisplay("read", { path: "a/b/app.scss" }, { totalLines: 90, fileSize: 2987, displayContent: { text: "x", lineNumbers: [1] } }, "");
  expect(out.stat).toBe("90 ln");
  expect(out.truncatedUpstream).toBeUndefined();
});

test("read of a directory degrades to a caталог stat with content lines", () => {
  const out = toolDisplay("read", { path: "/tmp/wt" }, { isDirectory: true, resolvedPath: "/tmp/wt" }, "a\nb");
  expect(out.stat).toBe("каталог");
  expect(out.lines).toEqual([
    { t: "ctx", text: "a" },
    { t: "ctx", text: "b" },
  ]);
});

test("write counts written lines and marks them as additions", () => {
  const out = toolDisplay("write", { path: "kermanych/apps/ui/src/lib/tip.ts", content: "one\ntwo" }, { resolvedPath: "/abs/tip.ts" }, "");
  expect(out.target).toBe("lib/tip.ts");
  expect(out.stat).toBe("+2 ln");
  expect(out.count).toBe(2);
  expect(out.lines).toEqual([
    { t: "add", n: "1", text: "one" },
    { t: "add", n: "2", text: "two" },
  ]);
});

test("glob reports the file count and flags upstream truncation", () => {
  const out = toolDisplay("glob", { path: "*" }, { fileCount: 196, files: ["a", "b"], truncated: true }, "");
  expect(out.stat).toBe("196 файлів ·обрізано");
  expect(out.count).toBe(196);
  expect(out.lines).toEqual([
    { t: "ctx", text: "a" },
    { t: "ctx", text: "b" },
  ]);
});

test("clampLines cuts to the per-tool preview budget", () => {
  const lines = Array.from({ length: 30 }, (_, i) => ({ t: "ctx" as const, text: String(i) }));
  expect(clampLines("read", lines)).toHaveLength(10);
  expect(clampLines("edit", lines)).toHaveLength(14);
  expect(clampLines("todo", lines)).toHaveLength(30);
  expect(clampLines("mystery", lines)).toHaveLength(8);
});
