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
  expect(out.totalLines).toBe(3);
  expect(out.lines).toEqual([
    { t: "ctx", n: "24", text: "a" },
    { t: "ctx", n: "25", text: "b" },
    { t: "ctx", n: "26", text: "c" },
  ]);
});

test("read of a whole file omits the shown/total form", () => {
  const out = toolDisplay("read", { path: "a/b/app.scss" }, { totalLines: 90, fileSize: 2987, displayContent: { text: "x", lineNumbers: [1] } }, "");
  expect(out.stat).toBe("90 ln");
  expect(out.count).toBe(90);
  expect(out.totalLines).toBe(1);
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
  expect(out.truncatedUpstream).toBe(true);
  expect(out.totalLines).toBe(2);
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

test("edit classifies omp's pre-numbered diff and counts both sides", () => {
  const diff = [
    " 26|let bubble: HTMLElement | null = null;",
    "-28|let timer: ReturnType<typeof setTimeout> | undefined;",
    "+28|// window.setTimeout so the handle is a DOM number",
    "+30|let timer: number | undefined;",
    "",
    " 85|function hide(): void {",
    "-86|  clearTimeout(timer);",
  ].join("\n");
  const out = toolDisplay("edit", { path: "x" }, { diff, op: "update", path: "kermanych/apps/ui/src/lib/tip.ts", firstChangedLine: 28 }, "");
  expect(out.target).toBe("lib/tip.ts");
  expect(out.stat).toBe("+2 \u22122");
  expect(out.count).toBe(4);
  expect(out.lines).toEqual([
    { t: "ctx", n: " 26", text: "let bubble: HTMLElement | null = null;" },
    { t: "del", n: "28", text: "let timer: ReturnType<typeof setTimeout> | undefined;" },
    { t: "add", n: "28", text: "// window.setTimeout so the handle is a DOM number" },
    { t: "add", n: "30", text: "let timer: number | undefined;" },
    { t: "gap" },
    { t: "ctx", n: " 85", text: "function hide(): void {" },
    { t: "del", n: "86", text: "  clearTimeout(timer);" },
  ]);
});

test("edit without a diff still names the file", () => {
  const out = toolDisplay("edit", { path: "kermanych/apps/ui/src/css/app.scss" }, {}, "");
  expect(out.target).toBe("css/app.scss");
  expect(out.stat).toBe("+0 \u22120");
  expect(out.lines).toEqual([]);
});

test("grep lists per-file counts then the matches, marking hit lines", () => {
  const d = {
    scopePath: "kermanych/apps/ui/src",
    matchCount: 3,
    fileCount: 2,
    fileMatches: [
      { path: "kermanych/apps/ui/src/composables/useNow.ts", count: 2 },
      { path: "kermanych/apps/ui/src/lib/tip.ts", count: 1 },
    ],
    truncated: false,
    displayContent: ["# kermanych/apps/ui/src/", "## composables/", "### useNow.ts#3309", " 7│const now = ref();", "*8│let timer: number;"].join("\n"),
  };
  const out = toolDisplay("grep", { pattern: "setTimeout|setInterval", path: "kermanych/apps/ui/src" }, d, "");
  expect(out.target).toBe("/setTimeout|setInterval/ src");
  expect(out.stat).toBe("3 збігів / 2 ф");
  expect(out.count).toBe(3);
  expect(out.lines).toEqual([
    { t: "head", text: "composables/useNow.ts  2" },
    { t: "head", text: "lib/tip.ts  1" },
    { t: "gap" },
    { t: "head", text: "useNow.ts#3309" },
    { t: "ctx", n: " 7", text: "const now = ref();" },
    { t: "hit", n: "8", text: "let timer: number;" },
  ]);
});

test("grep with no matches degrades to an empty card, not a blank row", () => {
  const out = toolDisplay("grep", { pattern: "Транскрипт", path: "kermanych/apps/ui/src" }, {}, "No matches found");
  expect(out.stat).toBe("0 збігів");
  expect(out.count).toBe(0);
  expect(out.lines).toEqual([]);
});

test("grep flags upstream truncation in the stat", () => {
  const out = toolDisplay("grep", { pattern: "x" }, { matchCount: 900, fileCount: 40, truncated: true, fileMatches: [], displayContent: "" }, "");
  expect(out.stat).toBe("900 збігів / 40 ф ·обрізано");
  expect(out.count).toBe(900);
  expect(out.totalLines).toBe(0);
  expect(out.truncatedUpstream).toBe(true);
});

test("bash reports wall time, and exit code when non-zero", () => {
  const fast = toolDisplay("bash", { command: "cd x && pnpm typecheck" }, { wallTimeMs: 92, timeoutSeconds: 300 }, "ok");
  expect(fast.target).toBe("cd x && pnpm typecheck");
  expect(fast.stat).toBe("92 ms");
  expect(fast.lines[0]).toEqual({ t: "head", text: "$ cd x && pnpm typecheck" });
  expect(fast.lines.at(-1)).toEqual({ t: "head", text: "wall 92 ms · timeout 300s" });

  const failed = toolDisplay("bash", { command: "false" }, { wallTimeMs: 1043, timeoutSeconds: 300, exitCode: 1 }, "boom");
  expect(failed.stat).toBe("exit 1 · 1.0 с");
});

test("bash collapses whitespace in a multi-line command for the row target", () => {
  const out = toolDisplay("bash", { command: "cd a &&\n  pnpm test" }, { wallTimeMs: 5 }, "");
  expect(out.target).toBe("cd a && pnpm test");
});

test("todo renders the phase tree with checkbox glyphs and counts", () => {
  const d = {
    op: "done",
    phases: [
      { id: "p1", name: "Виконання", tasks: [
        { id: "t1", content: "директива", status: "completed" },
        { id: "t2", content: "хедер", status: "in_progress" },
        { id: "t3", content: "стилі", status: "pending" },
      ] },
    ],
  };
  const out = toolDisplay("todo", { op: "done" }, d, "");
  expect(out.stat).toBe("1/3");
  expect(out.count).toBe(1);
  expect(out.lines).toEqual([
    { t: "head", text: "Виконання  1/3" },
    { t: "ctx", text: "[x] директива" },
    { t: "hit", text: "[/] хедер" },
    { t: "ctx", text: "[ ] стилі" },
  ]);
});

test("hub and eval expose their operation as the stat, and name the row separately", () => {
  const start = toolDisplay("hub", { op: "start", name: "web" }, { op: "start" }, "");
  expect(start.stat).toBe("start");
  expect(start.target).toBe("web");
  const waited = toolDisplay("hub", { op: "wait", to: "Main" }, { op: "wait", timedOut: true }, "");
  expect(waited.stat).toBe("wait · таймаут");
  expect(waited.target).toBe("Main");
  const ev = toolDisplay("eval", { language: "py", i: "scan deps" }, { language: "py", cells: 1 }, "");
  expect(ev.stat).toBe("py");
  expect(ev.target).toBe("scan deps");
});

// An empty stat cell is a row that claims a fact and shows none, and the api reducer must not
// have to paper over it: the property is absent, so the live and rehydrated rows match.
test("hub and eval omit the stat entirely when neither the result nor the call names one", () => {
  const hub = toolDisplay("hub", { to: "Main" }, {}, "delivered");
  expect(hub.stat).toBeUndefined();
  expect(hub.target).toBe("Main");
  const ev = toolDisplay("eval", { i: "scan deps" }, {}, "");
  expect(ev.stat).toBeUndefined();
  // A timeout is a fact of its own: it survives the missing op without a dangling separator.
  const waited = toolDisplay("hub", { to: "Main" }, { timedOut: true }, "");
  expect(waited.stat).toBe("таймаут");
});

test("clampLines keeps the trailing footer head that bash appends", () => {
  const body = Array.from({ length: 29 }, (_, i) => ({ t: "ctx" as const, text: String(i) }));
  const lines = [...body, { t: "head" as const, text: "wall 5 ms" }];
  const out = clampLines("bash", lines);
  expect(out).toHaveLength(10);
  expect(out.at(-1)).toEqual({ t: "head", text: "wall 5 ms" });
  expect(out[0]).toEqual({ t: "ctx", text: "0" });
  expect(out[8]).toEqual({ t: "ctx", text: "8" });
});

// The kept-footer rule is bash's alone. A grep card can be all `head` lines, and there the
// last line would read as the twelfth file while it is the hundredth.
test("clampLines gives grep a contiguous slice instead of keeping its last head", () => {
  const lines = Array.from({ length: 40 }, (_, i) => ({ t: "head" as const, text: `file${i}` }));
  const out = clampLines("grep", lines);
  expect(out).toHaveLength(12);
  expect(out.at(-1)).toEqual({ t: "head", text: "file11" });
});

test("a trailing newline in content does not add a phantom line", () => {
  const out = toolDisplay("bash", { command: "ls" }, { wallTimeMs: 5 }, "a\nb\n");
  expect(out.lines).toEqual([
    { t: "head", text: "$ ls" },
    { t: "ctx", text: "a" },
    { t: "ctx", text: "b" },
    { t: "head", text: "wall 5 ms" },
  ]);
  const plain = toolDisplay("hub", { op: "logs", name: "web" }, { op: "logs" }, "a\nb\n");
  expect(plain.lines).toEqual([
    { t: "ctx", text: "a" },
    { t: "ctx", text: "b" },
  ]);
  expect(plain.totalLines).toBe(2);
});

test("a trailing newline in a diff does not close the card with a phantom gap", () => {
  const out = toolDisplay("edit", { path: "a/b.ts" }, { diff: "+1|one\n" }, "");
  expect(out.lines).toEqual([{ t: "add", n: "1", text: "one" }]);
  expect(out.totalLines).toBe(1);
});

test("a partial read omp did not flag reports the same number in stat and count", () => {
  const out = toolDisplay("read", { path: "a/b.ts" }, { totalLines: 145, displayContent: { text: "a\nb", lineNumbers: [1, 2] } }, "");
  expect(out.stat).toBe("145 ln");
  expect(out.count).toBe(145);
  expect(out.truncatedUpstream).toBeUndefined();
});

// `groupStat` sums `count` across a coalesced run and appends `ln`. A read whose stat is a
// byte size is not a line count, so it must not contribute a number to that sum.
test("a read that reports only a file size carries no count", () => {
  const out = toolDisplay("read", { path: "a/b.ts" }, { fileSize: 4730, displayContent: { text: "a\nb", lineNumbers: [1, 2] } }, "");
  expect(out.stat).toBe("4.6 KB");
  expect(out.count).toBeUndefined();
});

test("an unknown tool falls back to content lines and no stat", () => {
  const out = toolDisplay("mystery", { path: "a/b/c.ts" }, {}, "x\ny");
  expect(out.stat).toBeUndefined();
  expect(out.target).toBe("b/c.ts");
  expect(out.lines).toEqual([{ t: "ctx", text: "x" }, { t: "ctx", text: "y" }]);
  expect(out.totalLines).toBe(2);
});

test("an unknown tool keeps a prose intent whole instead of shortening it", () => {
  const out = toolDisplay("task", { i: "Wiring api/ui/core boundaries" }, {}, "");
  expect(out.target).toBe("Wiring api/ui/core boundaries");
});
