# Chat Section Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every chat row carry a result fact, with per-tool detail available on click and finished request blocks collapsed to a single line.

**Architecture:** `packages/core` gains pure reducers that turn omp's `tool_execution_end.result.details` into a short `stat` string plus classified `ToolLine[]`, and pure grouping that folds a flat transcript into request blocks with coalesced read runs. The API reads fields it already receives but discards, clamps previews at the source (the WebSocket gateway broadcasts to every socket with no rooms), keeps full output in a capped in-memory cache behind a new REST endpoint, and runs the same reducers on the history-rehydration path. The UI renders dumb rows and per-tool cards.

**Tech Stack:** TypeScript, pnpm workspaces, vitest (`packages/core`, `apps/api`, `apps/ui` all have `test: vitest run`), NestJS + socket.io (API), Quasar/Vue 3 + Pinia (UI).

**Spec:** `docs/superpowers/specs/2026-08-22-chat-section-design.md`

## Global Constraints

- Node >= 22.12; pnpm 10.33.2 (`packageManager` in root `package.json`).
- Tests: `pnpm --filter @kermanych/core test`, `pnpm --filter @kermanych/api test`, `pnpm --filter @kermanych/ui test`. Config includes `test/**/*.spec.ts` only.
- Typecheck: `pnpm --filter @kermanych/api typecheck`, `pnpm --filter @kermanych/ui typecheck`.
- UI has no component-test harness (only `apps/ui/test/socket.spec.ts`, a pure-logic test). Do not introduce one: component work is gated by `typecheck` plus browser smoke, pure logic goes in `packages/core` where it is unit-tested.
- Design tokens are exactly the 12 vars in `packages/tokens/src/tokens.css`. No new colors. Global `border-radius: 0`. `--k-accent` only for the user strip, the live indicator and errors. `--k-diff` only for diff additions.
- Interface copy is Ukrainian, matching existing strings (`«Журнал порожній.»`, `«виконує»`).
- Clamp constants and the reasoning threshold live in one module and are imported, never re-typed.
- Clean cutover: `packages/core/src/tool-summary.ts` and its spec are deleted in Task 7 once both callers are migrated. No compatibility re-export.

---

## File Structure

**Create**
- `packages/core/src/tool-display.ts` — per-tool reducers, clamp constants, path/byte helpers.
- `packages/core/src/chat-blocks.ts` — flat transcript to request blocks, read-run coalescing, block summary math.
- `packages/core/test/tool-display.spec.ts`, `packages/core/test/chat-blocks.spec.ts`.
- `apps/api/src/supervisor/tool-detail-cache.ts` — per-session capped store of full `ToolLine[]`.
- `apps/api/test/tool-detail-cache.spec.ts`, `apps/api/test/supervisor.transcript.spec.ts`, `apps/api/test/transcript-parity.spec.ts`.
- `apps/ui/src/components/kit/KToolRow.vue` — one row plus its expandable card.
- `apps/ui/src/components/kit/KToolCard.vue` — renders `ToolLine[]` for any tool.
- `apps/ui/src/components/kit/KRequestBlock.vue` — collapsible request block.
- `apps/ui/src/components/kit/KTodoLane.vue`, `apps/ui/src/components/kit/KStatusRow.vue`.

**Modify**
- `packages/core/src/types.ts:40-47` (entry union), `:68` (`tool_execution_end`), `:66` (`message_end`), `:81` (`transcript_update`).
- `packages/core/src/index.ts:2` (export swap).
- `apps/api/src/supervisor/supervisor.service.ts:33-41` (`Live`), `:581-605`, `:607-658`.
- `apps/api/src/supervisor/messages-to-transcript.ts`.
- `apps/api/src/http/sessions.controller.ts:141-144` (new sibling endpoint).
- `apps/ui/src/lib/api.ts`, `apps/ui/src/stores/orchestrator.ts:100-110`.
- `apps/ui/src/components/kit/KLogBlock.vue`, `apps/ui/src/components/kit/KPanel.vue`.
- `apps/ui/src/pages/WorkspacePage.vue:173-176`.

**Delete**
- `packages/core/src/tool-summary.ts`, `packages/core/test/tool-summary.spec.ts` (Task 7).

---

### Task 1: Core types and the read/write/glob reducers

**Files:**
- Modify: `packages/core/src/types.ts:40-47`
- Create: `packages/core/src/tool-display.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/tool-display.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ToolLine`, `ToolDetail`, `TurnUsage`, the v2 `TranscriptEntry`, `PREVIEW_LINES`, `PREVIEW_DEFAULT`, `clampLines(tool, lines)`, `shortPath(p, keep?)`, `humanBytes(n)`, `toolDisplay(tool, args, details, content): ToolDisplay` where `ToolDisplay = { target?: string; stat?: string; count?: number; lines: ToolLine[]; totalLines: number; truncatedUpstream?: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/tool-display.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kermanych/core test`
Expected: FAIL — `Failed to resolve import "../src/tool-display"`.

- [ ] **Step 3: Replace the entry union in `types.ts`**

Replace `packages/core/src/types.ts` lines 40-47 with:

```ts
export type ToolStatus = "pending" | "ok" | "error";

// One classified line of tool detail. `n` is the source line number when the tool
// reports one. `gap` marks an elided diff hunk boundary; `head` a file/section title.
export type ToolLine =
  | { t: "ctx"; n?: string; text: string }
  | { t: "add"; n?: string; text: string }
  | { t: "del"; n?: string; text: string }
  | { t: "hit"; n?: string; text: string }
  | { t: "head"; text: string }
  | { t: "gap" };

// A clamped, display-ready slice of a tool result. The full line list stays on the
// API behind GET /sessions/:id/tools/:callId — it never rides the WebSocket.
export type ToolDetail = {
  lines: ToolLine[];
  totalLines: number;
  truncatedUpstream?: boolean;
};

export type TurnUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

export type TranscriptEntry =
  | { kind: "user_text"; id: string; at: number; text: string; images?: string[] }
  | { kind: "assistant_text"; id: string; at: number; text: string }
  | { kind: "assistant_thinking"; id: string; at: number; text: string; ms?: number; tokens?: number }
  | {
      kind: "tool"; id: string; at: number; tool: string; status: ToolStatus;
      intent?: string; target?: string; stat?: string; count?: number; ms?: number; detail?: ToolDetail;
    }
  | { kind: "notice"; id: string; at: number; level: "info" | "warn" | "error"; text: string }
  | { kind: "turn"; id: string; at: number; model?: string; ms?: number; usage?: TurnUsage };
```

- [ ] **Step 4: Write `tool-display.ts` with the read/write/glob reducers**

Create `packages/core/src/tool-display.ts`:

```ts
import type { ToolLine } from "./types";

export type ToolDisplay = {
  target?: string;
  stat?: string;
  // The primary number behind `stat` (lines, matches, files, ms) so coalesced rows
  // can sum without re-parsing the formatted string.
  count?: number;
  lines: ToolLine[];
  totalLines: number;
  truncatedUpstream?: boolean;
};

// Collapsed preview budget per tool. `todo` is unclamped: the phase tree is short and
// truncating it hides the one in-progress task the lane exists to show.
export const PREVIEW_LINES: Record<string, number> = {
  edit: 14, grep: 12, read: 10, write: 10, bash: 10, todo: Number.POSITIVE_INFINITY,
};
export const PREVIEW_DEFAULT = 8;

export function clampLines(tool: string, lines: ToolLine[]): ToolLine[] {
  const budget = PREVIEW_LINES[tool] ?? PREVIEW_DEFAULT;
  return lines.length <= budget ? lines : lines.slice(0, budget);
}

// A 558px panel cannot hold a repo-root-relative path. Keep the last `keep`
// segments and any `:from-to` range, which is the part that identifies the read.
export function shortPath(p: string | undefined, keep = 2): string {
  if (!p) return "";
  const [head = "", ...restRange] = p.split(":");
  const range = restRange.length ? `:${restRange.join(":")}` : "";
  const parts = head.split("/").filter(Boolean);
  return parts.slice(-keep).join("/") + range;
}

export function humanBytes(n: number | undefined): string | undefined {
  if (typeof n !== "number") return undefined;
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const textLines = (s: string): ToolLine[] => (s ? s.split("\n").map((text) => ({ t: "ctx" as const, text })) : []);

type Args = Record<string, unknown>;
type Details = Record<string, unknown>;
type Reducer = (args: Args, d: Details, content: string) => ToolDisplay;

const readDisplay: Reducer = (args, d, content) => {
  const target = shortPath(str(args["path"]));
  if (d["isDirectory"]) return { target, stat: "каталог", lines: textLines(content), totalLines: content ? content.split("\n").length : 0 };
  const dc = d["displayContent"] as { text?: string; lineNumbers?: number[] } | undefined;
  const total = num(d["totalLines"]);
  const nums = dc?.lineNumbers ?? [];
  const body = str(dc?.text);
  const lines: ToolLine[] = body
    ? body.split("\n").map((text, i) => (nums[i] === undefined ? { t: "ctx" as const, text } : { t: "ctx" as const, n: String(nums[i]), text }))
    : textLines(content);
  const shown = nums.length || lines.length;
  const stat = total && shown && shown < total ? `${shown}/${total} ln` : total ? `${total} ln` : humanBytes(num(d["fileSize"]));
  return { target, stat, count: shown, lines, totalLines: lines.length, truncatedUpstream: d["truncation"] ? true : undefined };
};

const writeDisplay: Reducer = (args, d) => {
  const body = str(args["content"]);
  const rows = body ? body.split("\n") : [];
  return {
    target: shortPath(str(d["resolvedPath"]) || str(args["path"])),
    stat: `+${rows.length} ln`,
    count: rows.length,
    lines: rows.map((text, i) => ({ t: "add" as const, n: String(i + 1), text })),
    totalLines: rows.length,
  };
};

const globDisplay: Reducer = (args, d, content) => {
  const files = (d["files"] as string[] | undefined) ?? [];
  const count = num(d["fileCount"]);
  return {
    target: shortPath(str(args["path"]), 1),
    stat: `${count ?? files.length} файлів${d["truncated"] ? " ·обрізано" : ""}`,
    count: count ?? files.length,
    lines: files.length ? files.map((text) => ({ t: "ctx" as const, text })) : textLines(content),
    totalLines: files.length || (content ? content.split("\n").length : 0),
    truncatedUpstream: d["truncated"] ? true : undefined,
  };
};

const genericDisplay: Reducer = (args, _d, content) => ({
  target: shortPath(str(args["path"]) || str(args["i"]), 2),
  lines: textLines(content),
  totalLines: content ? content.split("\n").length : 0,
});

const REDUCERS: Record<string, Reducer> = { read: readDisplay, write: writeDisplay, glob: globDisplay };

export function toolDisplay(tool: string, args: Args | undefined, details: Details | undefined, content: string): ToolDisplay {
  return (REDUCERS[tool] ?? genericDisplay)(args ?? {}, details ?? {}, content ?? "");
}
```

Then swap the export in `packages/core/src/index.ts` line 2 from `export * from "./tool-summary";` to `export * from "./tool-display";` and add `export * from "./tool-summary";` back on the following line — `tool-summary.ts` still has two live callers until Task 7.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @kermanych/core test`
Expected: PASS, 8 tests in `tool-display.spec.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/tool-display.ts packages/core/src/index.ts packages/core/test/tool-display.spec.ts
git commit -m "feat(core): transcript v2 types and read/write/glob display reducers"
```

---

### Task 2: The edit diff reducer

**Files:**
- Modify: `packages/core/src/tool-display.ts`
- Test: `packages/core/test/tool-display.spec.ts`

**Interfaces:**
- Consumes: `ToolDisplay`, `shortPath` from Task 1.
- Produces: `toolDisplay("edit", …)` returning `stat` `+A −B` (U+2212 minus) and `lines` of `add`/`del`/`ctx`/`gap`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/tool-display.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kermanych/core test`
Expected: FAIL — `expected undefined to be '+2 −2'` (the generic reducer runs).

- [ ] **Step 3: Add the reducer**

Insert into `packages/core/src/tool-display.ts` above `const REDUCERS`:

```ts
// omp ships the diff already numbered: " 26|context", "-28|removed", "+28|added",
// with an empty line marking a hunk boundary. Split on the first bar, never parse text.
const editDisplay: Reducer = (args, d) => {
  const raw = str(d["diff"]);
  const lines: ToolLine[] = [];
  let add = 0;
  let del = 0;
  for (const row of raw ? raw.split("\n") : []) {
    if (row === "") {
      lines.push({ t: "gap" });
      continue;
    }
    const signed = row[0] === "+" || row[0] === "-";
    const sign = signed ? row[0] : "";
    const rest = signed ? row.slice(1) : row;
    const bar = rest.indexOf("|");
    const n = bar >= 0 ? rest.slice(0, bar) : undefined;
    const text = bar >= 0 ? rest.slice(bar + 1) : rest;
    if (sign === "+") {
      add++;
      lines.push({ t: "add", ...(n === undefined ? {} : { n }), text });
    } else if (sign === "-") {
      del++;
      lines.push({ t: "del", ...(n === undefined ? {} : { n }), text });
    } else {
      lines.push({ t: "ctx", ...(n === undefined ? {} : { n }), text });
    }
  }
  return {
    target: shortPath(str(d["path"]) || str(args["path"])),
    stat: `+${add} \u2212${del}`,
    count: add + del,
    lines,
    totalLines: lines.length,
  };
};
```

Register it: `const REDUCERS: Record<string, Reducer> = { read: readDisplay, write: writeDisplay, glob: globDisplay, edit: editDisplay };`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @kermanych/core test`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tool-display.ts packages/core/test/tool-display.spec.ts
git commit -m "feat(core): edit diff display reducer"
```

---

### Task 3: The grep reducer

**Files:**
- Modify: `packages/core/src/tool-display.ts`
- Test: `packages/core/test/tool-display.spec.ts`

**Interfaces:**
- Consumes: Task 1 helpers.
- Produces: `toolDisplay("grep", …)` with `stat` `N збігів / M ф`, `head` lines for per-file counts, `hit` lines for matches.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/tool-display.spec.ts`:

```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kermanych/core test`
Expected: FAIL — `expected undefined to be '3 збігів / 2 ф'`.

- [ ] **Step 3: Add the reducer**

Insert into `packages/core/src/tool-display.ts` above `const REDUCERS`:

```ts
// omp pre-groups grep output: "#" root, "##" directory, "###" file#tag, then
// " N│line" for context and "*N│line" for a match. Keep the whole pattern in the
// target (it is the informative half) and shorten only the scope.
const grepDisplay: Reducer = (args, d) => {
  const pattern = str(args["pattern"]);
  const scope = shortPath(str(args["path"]), 1);
  const target = `/${pattern}/${scope ? ` ${scope}` : ""}`;
  const matches = num(d["matchCount"]);
  if (matches === undefined) return { target, stat: "0 збігів", count: 0, lines: [], totalLines: 0 };
  const lines: ToolLine[] = [];
  for (const fm of (d["fileMatches"] as { path: string; count: number }[] | undefined) ?? [])
    lines.push({ t: "head", text: `${shortPath(fm.path)}  ${fm.count}` });
  const body = str(d["displayContent"]);
  const rows = body ? body.split("\n").filter((r) => r.trim()) : [];
  if (lines.length && rows.length) lines.push({ t: "gap" });
  for (const row of rows) {
    if (row.startsWith("###")) {
      lines.push({ t: "head", text: row.replace(/^#+\s*/, "") });
      continue;
    }
    if (row.startsWith("#")) continue;
    const hit = row.startsWith("*");
    const rest = hit ? row.slice(1) : row;
    const bar = rest.indexOf("\u2502");
    const n = bar >= 0 ? rest.slice(0, bar) : undefined;
    const text = bar >= 0 ? rest.slice(bar + 1) : rest;
    lines.push({ t: hit ? "hit" : "ctx", ...(n === undefined ? {} : { n }), text });
  }
  return {
    target,
    stat: `${matches} збігів / ${num(d["fileCount"]) ?? 0} ф${d["truncated"] ? " ·обрізано" : ""}`,
    count: matches,
    lines,
    totalLines: lines.length,
    truncatedUpstream: d["truncated"] ? true : undefined,
  };
};
```

Register `grep: grepDisplay` in `REDUCERS`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @kermanych/core test`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tool-display.ts packages/core/test/tool-display.spec.ts
git commit -m "feat(core): grep display reducer with per-file counts"
```

---

### Task 4: bash, todo, hub and eval reducers

**Files:**
- Modify: `packages/core/src/tool-display.ts`
- Test: `packages/core/test/tool-display.spec.ts`

**Interfaces:**
- Consumes: Task 1 helpers.
- Produces: `toolDisplay` coverage for `bash`, `todo`, `hub`, `eval`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/tool-display.spec.ts`:

```ts
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

test("hub and eval expose their operation as the stat", () => {
  expect(toolDisplay("hub", { op: "start" }, { op: "start" }, "").stat).toBe("start");
  expect(toolDisplay("hub", { op: "wait" }, { op: "wait", timedOut: true }, "").stat).toBe("wait · таймаут");
  expect(toolDisplay("eval", { language: "py" }, { language: "py", cells: 1 }, "").stat).toBe("py");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kermanych/core test`
Expected: FAIL — `expected undefined to be '92 ms'`.

- [ ] **Step 3: Add the reducers**

Insert into `packages/core/src/tool-display.ts` above `const REDUCERS`:

```ts
const TODO_GLYPH: Record<string, string> = {
  pending: "[ ]", in_progress: "[/]", completed: "[x]", abandoned: "[-]", blocked: "[!]",
};

const ms = (v: number): string => (v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} с`);

const bashDisplay: Reducer = (args, d, content) => {
  const command = str(args["command"]).split(/\s+/).join(" ");
  const wall = num(d["wallTimeMs"]) ?? 0;
  const exit = num(d["exitCode"]);
  const lines: ToolLine[] = [{ t: "head", text: `$ ${command}` }, ...textLines(content)];
  const meta = [`wall ${ms(wall)}`];
  const timeout = num(d["timeoutSeconds"]);
  if (timeout !== undefined) meta.push(`timeout ${timeout}s`);
  if (exit) meta.push(`exit ${exit}`);
  lines.push({ t: "head", text: meta.join(" · ") });
  return {
    target: command,
    stat: exit ? `exit ${exit} · ${ms(wall)}` : ms(wall),
    count: Math.round(wall),
    lines,
    totalLines: lines.length,
  };
};

const todoDisplay: Reducer = (_args, d) => {
  const phases = (d["phases"] as { name?: string; tasks?: { content?: string; status?: string }[] }[] | undefined) ?? [];
  const lines: ToolLine[] = [];
  let done = 0;
  let total = 0;
  for (const phase of phases) {
    const tasks = phase.tasks ?? [];
    const phaseDone = tasks.filter((t) => t.status === "completed").length;
    done += phaseDone;
    total += tasks.length;
    lines.push({ t: "head", text: `${phase.name ?? ""}  ${phaseDone}/${tasks.length}` });
    for (const t of tasks)
      lines.push({ t: t.status === "in_progress" ? "hit" : "ctx", text: `${TODO_GLYPH[t.status ?? "pending"] ?? "[ ]"} ${t.content ?? ""}` });
  }
  return { stat: `${done}/${total}`, count: done, lines, totalLines: lines.length };
};

const hubDisplay: Reducer = (args, d, content) => {
  const op = str(d["op"]) || str(args["op"]);
  return { target: op, stat: `${op}${d["timedOut"] ? " · таймаут" : ""}`, lines: textLines(content), totalLines: content ? content.split("\n").length : 0 };
};

const evalDisplay: Reducer = (args, d, content) => ({
  target: str(d["language"]) || str(args["language"]),
  stat: str(d["language"]) || str(args["language"]),
  lines: textLines(content),
  totalLines: content ? content.split("\n").length : 0,
});
```

Register: `bash: bashDisplay, todo: todoDisplay, hub: hubDisplay, eval: evalDisplay`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @kermanych/core test`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tool-display.ts packages/core/test/tool-display.spec.ts
git commit -m "feat(core): bash, todo, hub and eval display reducers"
```

---

### Task 5: Request blocks and read-run coalescing

**Files:**
- Create: `packages/core/src/chat-blocks.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/chat-blocks.spec.ts`

**Interfaces:**
- Consumes: `TranscriptEntry` from Task 1.
- Produces: `THINK_MIN_MS`, `COALESCE_TOOLS`, `buildChatBlocks(entries, opts?): ChatBlock[]` where
  `ChatBlock = { id: string; request?: TranscriptEntry & {kind:"user_text"}; items: ChatItem[]; summary: BlockSummary }`,
  `ChatItem = { kind: "entry"; entry: TranscriptEntry; muted?: boolean } | { kind: "group"; tool: string; members: ToolEntry[]; stat: string }`,
  `BlockSummary = { ms: number; calls: number; files: number; thinkMs: number; cost: number }`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/chat-blocks.spec.ts`:

```ts
import { expect, test } from "vitest";
import { buildChatBlocks, THINK_MIN_MS } from "../src/chat-blocks";
import type { TranscriptEntry } from "../src/types";

const user = (id: string, at: number, text: string): TranscriptEntry => ({ kind: "user_text", id, at, text });
const tool = (id: string, at: number, t: string, extra: Partial<Extract<TranscriptEntry, { kind: "tool" }>> = {}): TranscriptEntry =>
  ({ kind: "tool", id, at, tool: t, status: "ok", ...extra });

test("splits the transcript on user messages and keeps pre-request entries in their own block", () => {
  const blocks = buildChatBlocks([
    { kind: "notice", id: "n1", at: 1, level: "info", text: "стартую" },
    user("u1", 10, "Го"),
    tool("t1", 20, "bash"),
    user("u2", 30, "далі"),
    tool("t2", 40, "bash"),
  ]);
  expect(blocks.map((b) => b.id)).toEqual(["pre", "u1", "u2"]);
  expect(blocks[1]!.request?.text).toBe("Го");
  expect(blocks[1]!.items).toHaveLength(1);
});

test("coalesces a run of same-tool reads and sums their counts", () => {
  const blocks = buildChatBlocks([
    user("u1", 0, "x"),
    tool("t1", 1, "read", { target: "a.ts", count: 20, stat: "20 ln" }),
    tool("t2", 2, "read", { target: "b.ts", count: 13, stat: "13 ln" }),
    tool("t3", 3, "edit", { target: "a.ts", count: 2, stat: "+1 −1" }),
    tool("t4", 4, "read", { target: "c.ts", count: 5, stat: "5 ln" }),
  ]);
  const items = blocks[0]!.items;
  expect(items[0]).toMatchObject({ kind: "group", tool: "read", stat: "38 ln" });
  expect((items[0] as { members: unknown[] }).members).toHaveLength(2);
  expect(items[1]).toMatchObject({ kind: "entry" });
  expect(items[2]).toMatchObject({ kind: "entry" });
});

test("a lone read is not grouped", () => {
  const blocks = buildChatBlocks([user("u1", 0, "x"), tool("t1", 1, "read", { count: 3 })]);
  expect(blocks[0]!.items[0]).toMatchObject({ kind: "entry" });
});

test("mutes short reasoning but keeps it in the block and in the think total", () => {
  const blocks = buildChatBlocks([
    user("u1", 0, "x"),
    { kind: "assistant_thinking", id: "k1", at: 1, text: "short", ms: 5_000 },
    { kind: "assistant_thinking", id: "k2", at: 2, text: "long", ms: 39_000 },
  ]);
  const items = blocks[0]!.items;
  expect(items[0]).toMatchObject({ kind: "entry", muted: true });
  expect(items[1]).toMatchObject({ kind: "entry", muted: false });
  expect(blocks[0]!.summary.thinkMs).toBe(44_000);
  expect(THINK_MIN_MS).toBe(8_000);
});

test("summary counts calls, distinct touched files and cost, and never lists turn entries as items", () => {
  const blocks = buildChatBlocks([
    user("u1", 1_000, "x"),
    tool("t1", 2_000, "edit", { target: "a.ts", count: 3 }),
    tool("t2", 3_000, "edit", { target: "a.ts", count: 1 }),
    tool("t3", 4_000, "write", { target: "b.ts", count: 9 }),
    tool("t4", 5_000, "read", { target: "c.ts", count: 2 }),
    { kind: "turn", id: "r1", at: 6_000, model: "opus-4.8", ms: 1_200, usage: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0, cost: 0.2 } },
    { kind: "turn", id: "r2", at: 7_000, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.05 } },
  ]);
  const b = blocks[0]!;
  expect(b.items.every((i) => i.kind !== "entry" || i.entry.kind !== "turn")).toBe(true);
  expect(b.summary).toEqual({ ms: 6_000, calls: 4, files: 2, thinkMs: 0, cost: 0.25 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kermanych/core test`
Expected: FAIL — `Failed to resolve import "../src/chat-blocks"`.

- [ ] **Step 3: Write the module**

Create `packages/core/src/chat-blocks.ts`:

```ts
import type { TranscriptEntry } from "./types";

export type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;
export type UserEntry = Extract<TranscriptEntry, { kind: "user_text" }>;

export type ChatItem =
  | { kind: "entry"; entry: TranscriptEntry; muted: boolean }
  | { kind: "group"; tool: string; members: ToolEntry[]; stat: string };

export type BlockSummary = { ms: number; calls: number; files: number; thinkMs: number; cost: number };
export type ChatBlock = { id: string; request?: UserEntry; items: ChatItem[]; summary: BlockSummary };

// Reasoning shorter than this is technical latency, not a pause worth a row. It stays
// in the block (muted) so "розгорнути все" can reveal it, and its time is still summed.
export const THINK_MIN_MS = 8_000;

// Read-like tools whose consecutive runs collapse into one row, mirroring omp's
// #lastReadGroup behaviour. Anything that mutates the repo is never grouped.
export const COALESCE_TOOLS = ["read", "grep", "glob"] as const;

const TOUCHING = ["edit", "write"];
const UNIT: Record<string, string> = { read: "ln", grep: "збігів", glob: "файлів" };

function groupStat(tool: string, members: ToolEntry[]): string {
  const total = members.reduce((sum, m) => sum + (m.count ?? 0), 0);
  return `${total} ${UNIT[tool] ?? ""}`.trim();
}

export function buildChatBlocks(entries: TranscriptEntry[], opts?: { thinkMinMs?: number }): ChatBlock[] {
  const thinkMinMs = opts?.thinkMinMs ?? THINK_MIN_MS;
  const blocks: ChatBlock[] = [];
  let current: ChatBlock | undefined;

  const open = (id: string, request?: UserEntry) => {
    current = { id, ...(request ? { request } : {}), items: [], summary: { ms: 0, calls: 0, files: 0, thinkMs: 0, cost: 0 } };
    blocks.push(current);
  };

  const files = new Map<ChatBlock, Set<string>>();
  const bounds = new Map<ChatBlock, { first: number; last: number }>();

  for (const entry of entries) {
    if (entry.kind === "user_text") open(entry.id, entry);
    if (!current) open("pre");
    const block = current!;
    if (!files.has(block)) files.set(block, new Set());
    const span = bounds.get(block) ?? { first: entry.at, last: entry.at };
    span.last = entry.at;
    bounds.set(block, span);

    if (entry.kind === "turn") {
      block.summary.cost += entry.usage?.cost ?? 0;
      continue;
    }
    if (entry.kind === "user_text") continue;
    if (entry.kind === "assistant_thinking") {
      block.summary.thinkMs += entry.ms ?? 0;
      block.items.push({ kind: "entry", entry, muted: (entry.ms ?? 0) < thinkMinMs });
      continue;
    }
    if (entry.kind === "tool") {
      block.summary.calls += 1;
      if (TOUCHING.includes(entry.tool) && entry.target) files.get(block)!.add(entry.target);
      const last = block.items.at(-1);
      const groupable = (COALESCE_TOOLS as readonly string[]).includes(entry.tool);
      if (groupable && last?.kind === "group" && last.tool === entry.tool) {
        last.members.push(entry);
        last.stat = groupStat(entry.tool, last.members);
        continue;
      }
      if (groupable && last?.kind === "entry" && last.entry.kind === "tool" && last.entry.tool === entry.tool) {
        const members = [last.entry, entry];
        block.items[block.items.length - 1] = { kind: "group", tool: entry.tool, members, stat: groupStat(entry.tool, members) };
        continue;
      }
      block.items.push({ kind: "entry", entry, muted: false });
      continue;
    }
    block.items.push({ kind: "entry", entry, muted: false });
  }

  for (const block of blocks) {
    const span = bounds.get(block);
    block.summary.ms = span ? span.last - (block.request?.at ?? span.first) : 0;
    block.summary.files = files.get(block)?.size ?? 0;
  }
  return blocks;
}
```

Add `export * from "./chat-blocks";` to `packages/core/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @kermanych/core test`
Expected: PASS, 22 tests across both core spec files.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/chat-blocks.ts packages/core/src/index.ts packages/core/test/chat-blocks.spec.ts
git commit -m "feat(core): request blocks with read-run coalescing and block summaries"
```

---

### Task 6: The tool detail cache

**Files:**
- Create: `apps/api/src/supervisor/tool-detail-cache.ts`
- Test: `apps/api/test/tool-detail-cache.spec.ts`

**Interfaces:**
- Consumes: `ToolLine` from core.
- Produces: `class ToolDetailCache` with `put(sessionId, callId, lines)`, `get(sessionId, callId): ToolLine[] | undefined`, `dropSession(sessionId)`; caps `MAX_CALL_BYTES = 256 * 1024`, `MAX_SESSION_BYTES = 8 * 1024 * 1024`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/tool-detail-cache.spec.ts`:

```ts
import { expect, test } from "vitest";
import { ToolDetailCache, MAX_CALL_BYTES } from "../src/supervisor/tool-detail-cache";

const lines = (n: number, size = 1) => Array.from({ length: n }, (_, i) => ({ t: "ctx" as const, text: "x".repeat(size) + i }));

test("stores and returns lines per session and call", () => {
  const c = new ToolDetailCache();
  c.put("s1", "call-1", lines(3));
  expect(c.get("s1", "call-1")).toHaveLength(3);
  expect(c.get("s1", "missing")).toBeUndefined();
  expect(c.get("s2", "call-1")).toBeUndefined();
});

test("refuses a single payload above the per-call cap", () => {
  const c = new ToolDetailCache();
  c.put("s1", "huge", lines(1, MAX_CALL_BYTES + 1));
  expect(c.get("s1", "huge")).toBeUndefined();
});

test("evicts oldest calls once the session budget is exceeded", () => {
  const c = new ToolDetailCache({ maxSessionBytes: 500 });
  c.put("s1", "a", lines(1, 200));
  c.put("s1", "b", lines(1, 200));
  c.put("s1", "c", lines(1, 200));
  expect(c.get("s1", "a")).toBeUndefined();
  expect(c.get("s1", "c")).toHaveLength(1);
});

test("dropSession frees everything for that session only", () => {
  const c = new ToolDetailCache();
  c.put("s1", "a", lines(1));
  c.put("s2", "a", lines(1));
  c.dropSession("s1");
  expect(c.get("s1", "a")).toBeUndefined();
  expect(c.get("s2", "a")).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kermanych/api test`
Expected: FAIL — cannot resolve `../src/supervisor/tool-detail-cache`.

- [ ] **Step 3: Write the cache**

Create `apps/api/src/supervisor/tool-detail-cache.ts`:

```ts
import type { ToolLine } from "@kermanych/core";

export const MAX_CALL_BYTES = 256 * 1024;
export const MAX_SESSION_BYTES = 8 * 1024 * 1024;

type Slot = { lines: ToolLine[]; bytes: number };

// Full tool output never rides the WebSocket (the gateway broadcasts to every socket
// with no rooms), so it lives here until the operator expands the row. Insertion order
// is FIFO: a long session drops its oldest outputs rather than growing without bound.
export class ToolDetailCache {
  private readonly perCall: number;
  private readonly perSession: number;
  private sessions = new Map<string, Map<string, Slot>>();
  private used = new Map<string, number>();

  constructor(opts?: { maxCallBytes?: number; maxSessionBytes?: number }) {
    this.perCall = opts?.maxCallBytes ?? MAX_CALL_BYTES;
    this.perSession = opts?.maxSessionBytes ?? MAX_SESSION_BYTES;
  }

  put(sessionId: string, callId: string, lines: ToolLine[]): void {
    const bytes = lines.reduce((sum, l) => sum + ("text" in l ? l.text.length : 0) + 8, 0);
    if (bytes > this.perCall) return;
    const calls = this.sessions.get(sessionId) ?? new Map<string, Slot>();
    this.sessions.set(sessionId, calls);
    const previous = calls.get(callId);
    let used = (this.used.get(sessionId) ?? 0) - (previous?.bytes ?? 0);
    calls.delete(callId);
    calls.set(callId, { lines, bytes });
    used += bytes;
    for (const [oldest, slot] of calls) {
      if (used <= this.perSession) break;
      if (oldest === callId) break;
      calls.delete(oldest);
      used -= slot.bytes;
    }
    this.used.set(sessionId, used);
  }

  get(sessionId: string, callId: string): ToolLine[] | undefined {
    return this.sessions.get(sessionId)?.get(callId)?.lines;
  }

  dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.used.delete(sessionId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @kermanych/api test`
Expected: PASS, 4 new tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/supervisor/tool-detail-cache.ts apps/api/test/tool-detail-cache.spec.ts
git commit -m "feat(api): capped per-session cache for full tool output"
```

---

### Task 7: Rewire the live reducer and the history mapper onto shared reducers

**Files:**
- Modify: `packages/core/src/types.ts:59-84` (widen `RpcEvent`, extend `transcript_update`)
- Modify: `apps/api/src/supervisor/supervisor.service.ts:33-41,581-658`
- Modify: `apps/api/src/supervisor/messages-to-transcript.ts`
- Modify: `apps/api/test/messages-to-transcript.spec.ts`
- Delete: `packages/core/src/tool-summary.ts`, `packages/core/test/tool-summary.spec.ts`
- Modify: `packages/core/src/index.ts`
- Test: `apps/api/test/supervisor.transcript.spec.ts`, `apps/api/test/transcript-parity.spec.ts`

**Interfaces:**
- Consumes: `toolDisplay`, `clampLines` (Tasks 1-4), `ToolDetailCache` (Task 6).
- Produces: `reduceRpcEvents(events, opts): { entries: TranscriptEntry[]; full: Map<string, ToolLine[]> }` exported from `apps/api/src/supervisor/transcript-reducer.ts` — a pure function the service calls per event batch and the tests drive directly.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/supervisor.transcript.spec.ts`:

```ts
import { expect, test } from "vitest";
import { reduceRpcEvents } from "../src/supervisor/transcript-reducer";
import type { RpcEvent } from "@kermanych/core";

const at = (n: number) => 1_700_000_000_000 + n;

test("a tool call plus its result become one entry carrying stat and clamped detail", () => {
  const events: RpcEvent[] = [
    { type: "tool_execution_start", toolName: "read", toolCallId: "c1", args: { path: "a/b/probe.txt" }, intent: "Reading probe file" },
    {
      type: "tool_execution_end", toolName: "read", toolCallId: "c1", isError: false,
      result: { content: [{ type: "text", text: "ignored" }], details: { totalLines: 3, fileSize: 17, displayContent: { text: "alpha\nbeta\ngamma", lineNumbers: [1, 2, 3] } } },
    },
  ];
  const { entries, full } = reduceRpcEvents(events, { now: at });
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    kind: "tool", id: "c1", tool: "read", status: "ok",
    intent: "Reading probe file", target: "b/probe.txt", stat: "3 ln", count: 3,
  });
  expect(full.get("c1")).toHaveLength(3);
});

test("a preview longer than the tool budget is clamped while the cache keeps everything", () => {
  const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const { entries, full } = reduceRpcEvents(
    [
      { type: "tool_execution_start", toolName: "bash", toolCallId: "c1", args: { command: "seq 40" } },
      { type: "tool_execution_end", toolName: "bash", toolCallId: "c1", isError: false, result: { content: [{ type: "text", text }], details: { wallTimeMs: 21 } } },
    ],
    { now: at },
  );
  const entry = entries[0] as Extract<(typeof entries)[number], { kind: "tool" }>;
  expect(entry.detail!.lines).toHaveLength(10);
  expect(entry.detail!.totalLines).toBe(42);
  expect(full.get("c1")).toHaveLength(42);
});

test("an errored tool keeps its detail and flips status", () => {
  const { entries } = reduceRpcEvents(
    [
      { type: "tool_execution_start", toolName: "bash", toolCallId: "c1", args: { command: "false" } },
      { type: "tool_execution_end", toolName: "bash", toolCallId: "c1", isError: true, result: { content: [{ type: "text", text: "boom" }], details: { wallTimeMs: 4, exitCode: 1 } } },
    ],
    { now: at },
  );
  expect(entries[0]).toMatchObject({ status: "error", stat: "exit 1 · 4 ms" });
});

test("assistant message_end yields thinking, text and a non-rendering turn entry", () => {
  const { entries } = reduceRpcEvents(
    [
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "weigh" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } },
      {
        type: "message_end",
        message: {
          role: "assistant", model: "claude-opus-4-8", duration: 5_877,
          usage: { input: 2, output: 228, cacheRead: 0, cacheWrite: 31_472, cost: { total: 0.2024 } },
        },
      },
    ],
    { now: at },
  );
  expect(entries.map((e) => e.kind)).toEqual(["assistant_thinking", "assistant_text", "turn"]);
  expect(entries[0]).toMatchObject({ ms: 5_877 });
  expect(entries[2]).toMatchObject({ kind: "turn", model: "claude-opus-4-8", usage: { cost: 0.2024, cacheWrite: 31_472 } });
});

test("a toolResult message_end does not duplicate the tool entry", () => {
  const { entries } = reduceRpcEvents(
    [
      { type: "tool_execution_start", toolName: "read", toolCallId: "c1", args: { path: "a.ts" } },
      { type: "tool_execution_end", toolName: "read", toolCallId: "c1", isError: false, result: { content: [{ type: "text", text: "x" }], details: { totalLines: 1 } } },
      { type: "message_end", message: { role: "toolResult", toolCallId: "c1", toolName: "read", details: { totalLines: 1 } } },
    ],
    { now: at },
  );
  expect(entries.filter((e) => e.kind === "tool")).toHaveLength(1);
});

test("notice frames become notice entries instead of vanishing", () => {
  const { entries } = reduceRpcEvents([{ type: "notice", message: "context is getting full" }], { now: at });
  expect(entries[0]).toMatchObject({ kind: "notice", level: "info", text: "context is getting full" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kermanych/api test`
Expected: FAIL — cannot resolve `../src/supervisor/transcript-reducer`.

- [ ] **Step 3: Widen `RpcEvent` and `transcript_update` in core**

In `packages/core/src/types.ts` replace lines 66-68 with:

```ts
  | { type: "message_end"; message?: { role?: string; model?: string; provider?: string; duration?: number; ttft?: number; stopReason?: string; toolCallId?: string; toolName?: string; content?: unknown[]; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } } }
  | { type: "tool_execution_start"; toolName?: string; toolCallId?: string; args?: Record<string, unknown>; intent?: string }
  | {
      type: "tool_execution_end"; toolName?: string; toolCallId?: string; isError?: boolean;
      result?: { content?: { type?: string; text?: string }[]; details?: Record<string, unknown> };
    }
```

and replace line 81 with:

```ts
  | { type: "transcript_update"; sessionId: string; id: string; status: "ok" | "error"; stat?: string; count?: number; ms?: number; detail?: ToolDetail }
```

- [ ] **Step 4: Write the pure reducer**

Create `apps/api/src/supervisor/transcript-reducer.ts`:

```ts
import { clampLines, toolDisplay, type RpcEvent, type ToolLine, type TranscriptEntry } from "@kermanych/core";

export type ReduceOpts = { now?: (seq: number) => number };

// The single reduction from omp's event stream to transcript entries. Kept pure and
// exported so both the live supervisor and the tests drive the identical code path.
export function reduceRpcEvents(events: RpcEvent[], opts?: ReduceOpts): { entries: TranscriptEntry[]; full: Map<string, ToolLine[]> } {
  const entries: TranscriptEntry[] = [];
  const full = new Map<string, ToolLine[]>();
  const startedAt = new Map<string, number>();
  let seq = 0;
  let textBuf = "";
  let thinkBuf = "";
  const stamp = () => (opts?.now ? opts.now(++seq) : Date.now());

  for (const e of events) {
    if (e.type === "message_update") {
      const ame = (e as Extract<RpcEvent, { type: "message_update" }>).assistantMessageEvent;
      if (ame?.type === "text_delta") textBuf += ame.delta ?? "";
      else if (ame?.type === "thinking_delta") thinkBuf += ame.delta ?? "";
      continue;
    }
    if (e.type === "message_end") {
      const m = (e as Extract<RpcEvent, { type: "message_end" }>).message;
      // toolResult messages repeat what tool_execution_end already delivered.
      if (m?.role === "toolResult") continue;
      const at = stamp();
      if (thinkBuf.trim()) entries.push({ kind: "assistant_thinking", id: `k${seq}`, at, text: thinkBuf, ...(m?.duration === undefined ? {} : { ms: m.duration }), ...(m?.usage?.output === undefined ? {} : { tokens: m.usage.output }) });
      if (textBuf.trim()) entries.push({ kind: "assistant_text", id: `a${seq}`, at, text: textBuf });
      if (m?.role === "assistant")
        entries.push({
          kind: "turn", id: `r${seq}`, at,
          ...(m.model === undefined ? {} : { model: m.model }),
          ...(m.duration === undefined ? {} : { ms: m.duration }),
          usage: {
            input: m.usage?.input ?? 0, output: m.usage?.output ?? 0,
            cacheRead: m.usage?.cacheRead ?? 0, cacheWrite: m.usage?.cacheWrite ?? 0,
            cost: m.usage?.cost?.total ?? 0,
          },
        });
      textBuf = "";
      thinkBuf = "";
      continue;
    }
    if (e.type === "tool_execution_start") {
      const ev = e as Extract<RpcEvent, { type: "tool_execution_start" }>;
      const at = stamp();
      const id = ev.toolCallId ?? `t${seq}`;
      startedAt.set(id, at);
      const tool = ev.toolName ?? "?";
      const d = toolDisplay(tool, ev.args, undefined, "");
      entries.push({
        kind: "tool", id, at, tool, status: "pending",
        ...(ev.intent === undefined ? {} : { intent: ev.intent }),
        ...(d.target ? { target: d.target } : {}),
      });
      continue;
    }
    if (e.type === "tool_execution_end") {
      const ev = e as Extract<RpcEvent, { type: "tool_execution_end" }>;
      const tool = ev.toolName ?? "?";
      const id = ev.toolCallId;
      const entry = (id ? entries.find((x) => x.kind === "tool" && x.id === id) : undefined)
        ?? entries.find((x) => x.kind === "tool" && x.status === "pending" && x.tool === tool);
      const content = (ev.result?.content ?? []).map((c) => c.text ?? "").join("");
      const args = entry && entry.kind === "tool" ? {} : {};
      const d = toolDisplay(tool, { ...args, path: entry?.kind === "tool" ? entry.target : undefined }, ev.result?.details, content);
      const at = stamp();
      if (!entry || entry.kind !== "tool") continue;
      entry.status = ev.isError ? "error" : "ok";
      if (d.stat !== undefined) entry.stat = d.stat;
      if (d.count !== undefined) entry.count = d.count;
      if (d.target) entry.target = d.target;
      const started = startedAt.get(entry.id);
      if (started !== undefined) entry.ms = at - started;
      entry.detail = {
        lines: clampLines(tool, d.lines),
        totalLines: d.totalLines,
        ...(d.truncatedUpstream ? { truncatedUpstream: true } : {}),
      };
      full.set(entry.id, d.lines);
      continue;
    }
    if (e.type === "notice") {
      const text = (e as Extract<RpcEvent, { type: "notice" }>).message ?? "";
      if (text.trim()) entries.push({ kind: "notice", id: `n${++seq}`, at: stamp(), level: "info", text });
      continue;
    }
  }
  return { entries, full };
}
```

Note on `tool_execution_end`: the reducer re-derives `target` from `details` when the
tool reports a path (`edit`, `write`, `read`), and otherwise keeps the `target`
computed at start from `args`.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @kermanych/api test -t transcript`
Expected: PASS, 6 tests in `supervisor.transcript.spec.ts`.

- [ ] **Step 6: Call the reducer from the service**

In `apps/api/src/supervisor/supervisor.service.ts`:

1. Extend `Live` (lines 33-41) with `details: ToolDetailCache` — or hold one shared
   `ToolDetailCache` on the service and key by session id; use the shared instance:
   add `private toolDetails = new ToolDetailCache();` next to `private map`.
2. Replace the `tool_execution_start` / `tool_execution_end` branches (lines 636-644)
   and the `message_end` branch (lines 630-635) with a single call that feeds one
   event through `reduceRpcEvents` and applies the result:

```ts
    const reduced = reduceRpcEvents([e], { now: () => Date.now() });
    for (const [callId, lines] of reduced.full) this.toolDetails.put(id, callId, lines);
    for (const entry of reduced.entries) {
      if (entry.kind === "tool" && entry.status !== "pending") {
        // A completion carries no new entry — it patches the pending one in place.
        this.finishTool(id, entry);
        continue;
      }
      this.appendEntry(id, entry);
    }
```

3. Replace `finishTool` (lines 587-599) with a version that copies the reduced fields:

```ts
  private finishTool(id: string, patch: Extract<TranscriptEntry, { kind: "tool" }>) {
    const l = this.map.get(id);
    if (!l) return;
    const entry =
      l.transcript.find((x) => x.kind === "tool" && x.id === patch.id) ??
      l.transcript.find((x) => x.kind === "tool" && x.status === "pending" && x.tool === patch.tool);
    if (!entry || entry.kind !== "tool") return;
    entry.status = patch.status;
    entry.stat = patch.stat;
    entry.count = patch.count;
    entry.ms = patch.ms;
    entry.detail = patch.detail;
    if (patch.target) entry.target = patch.target;
    this.events.next({
      type: "transcript_update", sessionId: id, id: entry.id, status: patch.status as "ok" | "error",
      stat: entry.stat, count: entry.count, ms: entry.ms, detail: entry.detail,
    });
  }
```

Because `reduceRpcEvents` is stateless across calls, keep `textBuf`/`thinkBuf` and the
per-call start times on `Live` and pass them in — simplest correct form: keep the
existing `l.textBuf`/`l.thinkBuf` accumulation in the service and hand
`reduceRpcEvents` the whole `message_end` event together with the buffered text via
a second argument `{ textBuf, thinkBuf }`; update the reducer signature to
`reduceRpcEvents(events, opts?: ReduceOpts & { textBuf?: string; thinkBuf?: string; startedAt?: Map<string, number> })`
and seed its locals from it. Update `supervisor.transcript.spec.ts` only if a test
needs the seeded form; the existing tests pass whole event runs and stay valid.

4. Update `userEntry` (lines 601-605) to stamp `id` and `at`:

```ts
  private userEntry(text: string, images?: ImageInput[]): TranscriptEntry {
    return { kind: "user_text", id: `u${Date.now()}`, at: Date.now(), text, images: images?.map((i) => `data:${i.mimeType};base64,${i.data}`) };
  }
```

5. In the session-teardown paths that already call `this.map.delete(childId)` (e.g. line 574) add `this.toolDetails.dropSession(childId);`.

- [ ] **Step 7: Migrate the history mapper and delete `tool-summary`**

Rewrite `apps/api/src/supervisor/messages-to-transcript.ts` to emit v2 entries via the
same reducers: for each `toolCall` part push a pending `tool` entry with
`target` from `toolDisplay(name, arguments, undefined, "")`; for each `toolResult`
message call `toolDisplay(toolName, {}, m.details, text)` and patch the paired entry
with `stat`, `count`, `detail: { lines: clampLines(...), totalLines }`. Stamp `id`
(`h<seq>`) and `at` (message `timestamp` when present, else a monotonic counter).
Then delete `packages/core/src/tool-summary.ts` and
`packages/core/test/tool-summary.spec.ts`, and remove the
`export * from "./tool-summary";` line from `packages/core/src/index.ts`.

Update `apps/api/test/messages-to-transcript.spec.ts` expectations to the v2 shape:
each entry gains `id`/`at`, tool entries gain `target`/`stat`/`detail`, and the old
`summary` field disappears.

- [ ] **Step 8: Write the parity test**

Create `apps/api/test/transcript-parity.spec.ts`:

```ts
import { expect, test } from "vitest";
import { reduceRpcEvents } from "../src/supervisor/transcript-reducer";
import { messagesToTranscript } from "../src/supervisor/messages-to-transcript";
import type { RpcEvent } from "@kermanych/core";

// The same grep call, once as a live frame pair and once as omp history messages.
const details = { matchCount: 1, fileCount: 1, fileMatches: [{ path: "a/hello.py", count: 1 }], truncated: false, displayContent: "*1\u2502def hi():" };

test("live and rehydrated paths agree on the visible fields of a tool entry", () => {
  const live = reduceRpcEvents(
    [
      { type: "tool_execution_start", toolName: "grep", toolCallId: "c1", args: { pattern: "def", path: "hello.py" } },
      { type: "tool_execution_end", toolName: "grep", toolCallId: "c1", isError: false, result: { content: [{ type: "text", text: "" }], details } },
    ] as RpcEvent[],
    { now: (n) => n },
  ).entries[0] as Extract<ReturnType<typeof messagesToTranscript>[number], { kind: "tool" }>;

  const history = messagesToTranscript([
    { role: "assistant", content: [{ type: "toolCall", name: "grep", arguments: { pattern: "def", path: "hello.py" } }] },
    { role: "toolResult", toolName: "grep", isError: false, details, content: [{ type: "text", text: "" }] },
  ])[0] as Extract<ReturnType<typeof messagesToTranscript>[number], { kind: "tool" }>;

  const visible = (e: typeof live) => ({ kind: e.kind, tool: e.tool, status: e.status, target: e.target, stat: e.stat, count: e.count, detail: e.detail });
  expect(visible(history)).toEqual(visible(live));
});
```

- [ ] **Step 9: Run the full API suite**

Run: `pnpm --filter @kermanych/api test && pnpm --filter @kermanych/core test && pnpm --filter @kermanych/api typecheck`
Expected: PASS on all three.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/index.ts apps/api/src/supervisor apps/api/test
git rm packages/core/src/tool-summary.ts packages/core/test/tool-summary.spec.ts
git commit -m "feat(api): reduce omp tool results into stat plus clamped detail, with history parity"
```

---

### Task 8: The full-output endpoint

**Files:**
- Modify: `apps/api/src/supervisor/supervisor.service.ts` (add `getToolDetail`)
- Modify: `apps/api/src/http/sessions.controller.ts:141-144`
- Test: `apps/api/test/tool-detail-endpoint.spec.ts`

**Interfaces:**
- Consumes: `ToolDetailCache` (Task 6), service wiring (Task 7).
- Produces: `SupervisorService.getToolDetail(id, callId): { lines: ToolLine[]; totalLines: number }` throwing `GoneException` on a miss; `GET /sessions/:id/tools/:callId`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/tool-detail-endpoint.spec.ts`:

```ts
import { expect, test, vi } from "vitest";
import { GoneException } from "@nestjs/common";
import { SessionsController } from "../src/http/sessions.controller";

test("returns cached lines for a call id", () => {
  const sup = { getToolDetail: vi.fn().mockReturnValue({ lines: [{ t: "ctx", text: "x" }], totalLines: 1 }) };
  const c = new SessionsController(sup as never, {} as never, {} as never);
  expect(c.toolDetail("s1", "c1")).toEqual({ lines: [{ t: "ctx", text: "x" }], totalLines: 1 });
  expect(sup.getToolDetail).toHaveBeenCalledWith("s1", "c1");
});

test("propagates a cache miss as 410 Gone", () => {
  const sup = { getToolDetail: vi.fn(() => { throw new GoneException("вивід більше недоступний"); }) };
  const c = new SessionsController(sup as never, {} as never, {} as never);
  expect(() => c.toolDetail("s1", "gone")).toThrow(GoneException);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kermanych/api test -t "tool detail"`
Expected: FAIL — `c.toolDetail is not a function`.

- [ ] **Step 3: Add the service method**

In `apps/api/src/supervisor/supervisor.service.ts`, next to `getTranscript`:

```ts
  // Full tool output on demand. A miss means the FIFO cache dropped it (or the API
  // restarted) — the UI says so rather than pretending the output was empty.
  getToolDetail(id: string, callId: string): { lines: ToolLine[]; totalLines: number } {
    const lines = this.toolDetails.get(id, callId);
    if (!lines) throw new GoneException("вивід більше недоступний");
    return { lines, totalLines: lines.length };
  }
```

Import `GoneException` from `@nestjs/common` and `type ToolLine` from `@kermanych/core`.

- [ ] **Step 4: Add the endpoint**

In `apps/api/src/http/sessions.controller.ts`, after the `transcript` handler (line 144):

```ts
  @Get(":id/tools/:callId")
  toolDetail(@Param("id") id: string, @Param("callId") callId: string) {
    return this.sup.getToolDetail(id, callId);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @kermanych/api test && pnpm --filter @kermanych/api typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/supervisor/supervisor.service.ts apps/api/src/http/sessions.controller.ts apps/api/test/tool-detail-endpoint.spec.ts
git commit -m "feat(api): GET /sessions/:id/tools/:callId for full tool output"
```

---

### Task 9: UI transport for the new fields

**Files:**
- Modify: `apps/ui/src/lib/api.ts`
- Modify: `apps/ui/src/stores/orchestrator.ts:100-110`
- Test: `apps/ui/test/orchestrator-transcript.spec.ts`

**Interfaces:**
- Consumes: `ServerEvent` v2 (Task 7), endpoint (Task 8).
- Produces: `api.getToolDetail(sessionId, callId): Promise<{ lines: ToolLine[]; totalLines: number }>`; `reduce` applying `stat`/`count`/`ms`/`detail` on `transcript_update`.

- [ ] **Step 1: Write the failing test**

Create `apps/ui/test/orchestrator-transcript.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyTranscriptUpdate } from '../src/stores/transcript-update';
import type { TranscriptEntry } from '@kermanych/core';

describe('applyTranscriptUpdate', () => {
  const pending: TranscriptEntry[] = [
    { kind: 'tool', id: 'c1', at: 1, tool: 'edit', status: 'pending', target: 'lib/tip.ts' },
  ];

  it('copies stat, count, ms and detail onto the matching tool entry', () => {
    const next = applyTranscriptUpdate(pending, {
      type: 'transcript_update', sessionId: 's1', id: 'c1', status: 'ok',
      stat: '+7 \u22125', count: 12, ms: 40,
      detail: { lines: [{ t: 'add', n: '28', text: 'x' }], totalLines: 31 },
    });
    expect(next[0]).toMatchObject({ status: 'ok', stat: '+7 \u22125', count: 12, ms: 40 });
    expect((next[0] as { detail: { totalLines: number } }).detail.totalLines).toBe(31);
  });

  it('leaves the list untouched when no entry matches', () => {
    const next = applyTranscriptUpdate(pending, { type: 'transcript_update', sessionId: 's1', id: 'nope', status: 'ok' });
    expect(next).toBe(pending);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kermanych/ui test`
Expected: FAIL — cannot resolve `../src/stores/transcript-update`.

- [ ] **Step 3: Extract the update as a pure function**

Create `apps/ui/src/stores/transcript-update.ts`:

```ts
import type { ServerEvent, TranscriptEntry } from '@kermanych/core';

type Update = Extract<ServerEvent, { type: 'transcript_update' }>;

// Patch the finished tool entry in place. Returns the SAME array when nothing
// matched, so the store can skip a pointless reactive write.
export function applyTranscriptUpdate(list: TranscriptEntry[], e: Update): TranscriptEntry[] {
  let hit = false;
  const next = list.map((x) => {
    if (x.kind !== 'tool' || x.id !== e.id) return x;
    hit = true;
    return {
      ...x,
      status: e.status,
      ...(e.stat === undefined ? {} : { stat: e.stat }),
      ...(e.count === undefined ? {} : { count: e.count }),
      ...(e.ms === undefined ? {} : { ms: e.ms }),
      ...(e.detail === undefined ? {} : { detail: e.detail }),
    };
  });
  return hit ? next : list;
}
```

Replace `apps/ui/src/stores/orchestrator.ts` lines 100-110 with:

```ts
    } else if (e.type === 'transcript_update') {
      const list = transcripts.value[e.sessionId];
      if (list) {
        const next = applyTranscriptUpdate(list, e);
        if (next !== list) transcripts.value = { ...transcripts.value, [e.sessionId]: next };
      }
    }
```

Add to `apps/ui/src/lib/api.ts`:

```ts
  getToolDetail(sessionId: string, callId: string): Promise<{ lines: ToolLine[]; totalLines: number }> {
    return get(`/sessions/${sessionId}/tools/${encodeURIComponent(callId)}`);
  },
```

matching the file's existing helper style, and import `type ToolLine` from `@kermanych/core`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @kermanych/ui test && pnpm --filter @kermanych/ui typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/stores/transcript-update.ts apps/ui/src/stores/orchestrator.ts apps/ui/src/lib/api.ts apps/ui/test/orchestrator-transcript.spec.ts
git commit -m "feat(ui): carry tool stat and detail through the store"
```

---

### Task 10: `KToolRow` and `KToolCard`

**Files:**
- Create: `apps/ui/src/components/kit/KToolCard.vue`
- Create: `apps/ui/src/components/kit/KToolRow.vue`

**Interfaces:**
- Consumes: `TranscriptEntry` tool variant, `api.getToolDetail` (Task 9).
- Produces: `<KToolRow :entry :session-id />` and `<KToolCard :entry :lines :total-lines @more />`.

- [ ] **Step 1: Write `KToolCard.vue`**

```vue
<template>
  <div class="k-tc">
    <div v-if="entry.intent" class="k-tc__intent">{{ entry.intent }}</div>
    <div v-if="entry.truncatedNote" class="k-tc__warn">{{ entry.truncatedNote }}</div>
    <div class="k-tc__body" :class="{ 'k-tc__body--wrap': wrap }">
      <template v-for="(line, i) in lines" :key="i">
        <div v-if="line.t === 'gap'" class="k-tc__gap">⋯</div>
        <div v-else-if="line.t === 'head'" class="k-tc__head">{{ line.text }}</div>
        <div v-else class="k-tc__line" :class="`k-tc__line--${line.t}`">
          <span class="k-tc__n">{{ line.n ?? '' }}</span>
          <span class="k-tc__s">{{ line.t === 'add' ? '+' : line.t === 'del' ? '−' : line.t === 'hit' ? '›' : '' }}</span>
          <span class="k-tc__tx">{{ line.text }}</span>
        </div>
      </template>
    </div>
    <button v-if="rest > 0" type="button" class="k-tc__more" @click="emit('more')">
      показати всі {{ totalLines }} рядків
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ToolLine, TranscriptEntry } from '@kermanych/core';

// One card body for every tool: the per-tool knowledge already lives in the API's
// reducers, so this component only paints classified lines.
const props = defineProps<{
  entry: Extract<TranscriptEntry, { kind: 'tool' }> & { truncatedNote?: string };
  lines: ToolLine[];
  totalLines: number;
}>();
const emit = defineEmits<{ more: [] }>();

// A clipped diff hides the change itself, so edit/write wrap with a hanging indent.
const wrap = computed(() => props.entry.tool === 'edit' || props.entry.tool === 'write');
const rest = computed(() => props.totalLines - props.lines.length);
</script>

<style scoped lang="scss">
.k-tc { margin: 2px 0 8px 17px; padding: 5px 0 5px 10px; border-left: 1px solid var(--k-line-strong); }
.k-tc__intent { font-family: var(--k-font-ui); font-size: 12px; font-style: italic; color: var(--k-muted); }
.k-tc__warn { font-family: var(--k-font-mono); font-size: 10.5px; color: var(--k-accent); margin-top: 3px; }
.k-tc__body { margin-top: 5px; padding: 4px 0; background: var(--k-surface); }
.k-tc__line { display: flex; font-family: var(--k-font-mono); font-size: 11.5px; line-height: 1.5; white-space: pre; overflow: hidden; }
.k-tc__n { flex: none; width: 34px; padding-right: 6px; text-align: right; color: var(--k-line-strong); }
.k-tc__s { flex: none; width: 11px; text-align: center; }
.k-tc__tx { flex: 1; overflow: hidden; text-overflow: ellipsis; color: var(--k-muted); }
.k-tc__line--add { background: color-mix(in srgb, var(--k-diff) 9%, transparent); }
.k-tc__line--add .k-tc__s, .k-tc__line--add .k-tc__tx { color: var(--k-diff); }
.k-tc__line--del { background: color-mix(in srgb, var(--k-accent) 8%, transparent); }
.k-tc__line--del .k-tc__s, .k-tc__line--del .k-tc__tx { color: var(--k-accent); }
.k-tc__line--hit .k-tc__tx { color: var(--k-text); }
.k-tc__line--hit .k-tc__s { color: var(--k-accent); }
.k-tc__body--wrap .k-tc__line { display: block; padding-left: 51px; text-indent: -51px; white-space: pre-wrap; word-break: break-word; }
.k-tc__body--wrap .k-tc__n { display: inline-block; width: 34px; }
.k-tc__body--wrap .k-tc__s { display: inline-block; width: 11px; }
.k-tc__body--wrap .k-tc__tx { display: inline; overflow: visible; text-overflow: clip; }
.k-tc__gap { padding-left: 34px; font-family: var(--k-font-mono); font-size: 11px; line-height: 1.4; color: var(--k-line-strong); }
.k-tc__head { padding: 4px 0 1px 6px; font-family: var(--k-font-mono); font-size: 11px; color: var(--k-text); }
.k-tc__more { margin-top: 5px; padding: 0; background: transparent; border: none; font-family: var(--k-font-mono); font-size: 11px; color: var(--k-accent); cursor: pointer; }
</style>
```

- [ ] **Step 2: Write `KToolRow.vue`**

```vue
<template>
  <div>
    <button type="button" class="k-tr" :aria-expanded="open" @click="toggle">
      <span class="k-tr__g" :class="`k-tr__g--${entry.status}`" aria-hidden="true">{{ glyph }}</span>
      <span class="k-tr__t">{{ entry.tool }}</span>
      <span class="k-tr__tg">{{ entry.target ?? '' }}</span>
      <span class="k-tr__st">{{ entry.stat ?? '' }}</span>
      <span class="k-tr__ch" aria-hidden="true">{{ open ? '⌄' : '›' }}</span>
    </button>
    <KToolCard
      v-if="open && shown.length"
      :entry="{ ...entry, truncatedNote: note }"
      :lines="shown"
      :total-lines="total"
      @more="loadFull"
    />
    <div v-else-if="open" class="k-tr__empty mono">{{ note || 'Деталей немає.' }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ToolLine, TranscriptEntry } from '@kermanych/core';
import { api } from '../../lib/api';
import KToolCard from './KToolCard.vue';

const props = defineProps<{ entry: Extract<TranscriptEntry, { kind: 'tool' }>; sessionId: string }>();

const open = ref(false);
const fullLines = ref<ToolLine[] | undefined>(undefined);
const error = ref('');

const glyph = computed(() => (props.entry.status === 'pending' ? '◆' : props.entry.status === 'ok' ? '✓' : '✗'));
const shown = computed(() => fullLines.value ?? props.entry.detail?.lines ?? []);
const total = computed(() => (fullLines.value ? fullLines.value.length : props.entry.detail?.totalLines ?? 0));
const note = computed(() => error.value || (props.entry.detail?.truncatedUpstream ? 'віддано обрізаним' : ''));

function toggle(): void {
  open.value = !open.value;
}

async function loadFull(): Promise<void> {
  try {
    const res = await api.getToolDetail(props.sessionId, props.entry.id);
    fullLines.value = res.lines;
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>

<style scoped lang="scss">
.k-tr {
  display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 0;
  background: transparent; border: none; cursor: pointer; text-align: left;
  font-family: var(--k-font-mono); font-size: 12.5px; line-height: 1.7;
  white-space: nowrap; overflow: hidden; color: var(--k-muted);
}
.k-tr:hover { background: var(--k-surface); }
.k-tr:focus-visible { outline: 1px solid var(--k-accent); outline-offset: -1px; }
.k-tr__g { flex: none; width: 9px; font-size: 10.5px; }
.k-tr__g--pending { color: var(--k-accent); animation: k-tr-pulse 1.4s ease-in-out infinite; }
.k-tr__g--error { color: var(--k-accent); }
@keyframes k-tr-pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
/* Fixed column: this is what stops `bash` from wrapping as `bas`/`h`. */
.k-tr__t { flex: none; width: 44px; color: var(--k-text); }
.k-tr__tg { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.k-tr__st { flex: none; font-size: 11.5px; color: var(--k-text); }
.k-tr__ch { flex: none; width: 10px; text-align: right; font-size: 11px; color: var(--k-line-strong); }
.k-tr__empty { margin: 2px 0 8px 17px; font-size: 11.5px; color: var(--k-muted); }
</style>
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @kermanych/ui typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/components/kit/KToolRow.vue apps/ui/src/components/kit/KToolCard.vue
git commit -m "feat(ui): informative tool row with an expandable per-tool card"
```

---

### Task 11: Rewire `KLogBlock`

**Files:**
- Modify: `apps/ui/src/components/kit/KLogBlock.vue`

**Interfaces:**
- Consumes: `KToolRow` (Task 10).
- Produces: `<KLogBlock :entry :session-id :muted />` — tool entries delegate to `KToolRow`; reasoning renders as a chip showing `думав N с · M ток`; notices render by level; `turn` renders nothing.

- [ ] **Step 1: Replace the template**

Replace the whole `<template>` of `apps/ui/src/components/kit/KLogBlock.vue` with:

```vue
<template>
  <div class="k-log" :class="`k-log--${entry.kind}`">
    <KToolRow v-if="entry.kind === 'tool'" :entry="entry" :session-id="sessionId" />

    <div v-else-if="entry.kind === 'assistant_text'" class="k-log__markdown" v-html="renderedText" />

    <template v-else-if="entry.kind === 'user_text'">
      <div v-if="entry.text" class="k-log__user">{{ entry.text }}</div>
      <div v-if="entry.images?.length" class="k-log__user-images">
        <img v-for="(src, i) in entry.images" :key="i" :src="src" class="k-log__user-img" alt="вкладення" />
      </div>
    </template>

    <div v-else-if="entry.kind === 'assistant_thinking'" class="k-log__reason">
      <button type="button" class="k-log__reason-toggle" :aria-expanded="open" @click="open = !open">
        <span class="k-log__reason-caret" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
        {{ chip }}
      </button>
      <div v-if="open" class="k-log__reason-body k-log__markdown" v-html="renderedThinking" />
    </div>

    <div v-else-if="entry.kind === 'notice'" class="k-log__notice" :class="`k-log__notice--${entry.level}`">
      {{ entry.text }}
    </div>
  </div>
</template>
```

- [ ] **Step 2: Replace the script**

```ts
import { computed, ref, watch } from 'vue';
import type { TranscriptEntry } from '@kermanych/core';
import { renderMarkdown } from '../../lib/markdown';
import KToolRow from './KToolRow.vue';

// One transcript block. Tool rows delegate to KToolRow; `turn` entries are ledger
// data for block summaries and deliberately render nothing.
const props = defineProps<{ entry: TranscriptEntry; sessionId: string }>();

const renderedText = computed(() =>
  props.entry.kind === 'assistant_text' ? renderMarkdown(props.entry.text) : '',
);

const open = ref(false);
watch(() => props.entry, () => { open.value = false; });

const renderedThinking = computed(() =>
  props.entry.kind === 'assistant_thinking' ? renderMarkdown(props.entry.text) : '',
);

// The chip carries the two facts that answer "is it alive and what did it cost".
const chip = computed(() => {
  if (props.entry.kind !== 'assistant_thinking') return '';
  const secs = props.entry.ms ? Math.round(props.entry.ms / 1000) : undefined;
  const tok = props.entry.tokens;
  const tokLabel = tok === undefined ? '' : tok >= 1000 ? `${(tok / 1000).toFixed(1)}k ток` : `${tok} ток`;
  return ['думав', secs === undefined ? '' : `${secs} с`, tokLabel].filter(Boolean).join(' · ');
});
```

- [ ] **Step 3: Add the notice level styles and drop the dead ones**

Remove `.k-log__row`, `.k-log__glyph`, `.k-log__tool`, `.k-log__summary`, `.k-log__body`,
`.k-log__diff*` and the `k-log-tool-pulse` keyframes (all superseded by `KToolRow`),
and add:

```scss
.k-log__notice--warn { color: var(--k-accent); }
.k-log__notice--error { color: var(--k-accent); font-weight: 500; }
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @kermanych/ui typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/components/kit/KLogBlock.vue
git commit -m "refactor(ui): delegate tool rendering to KToolRow, chip-only reasoning"
```

---

### Task 12: `KRequestBlock` and grouping in `WorkspacePage`

**Files:**
- Create: `apps/ui/src/components/kit/KRequestBlock.vue`
- Modify: `apps/ui/src/pages/WorkspacePage.vue:173-176`

**Interfaces:**
- Consumes: `buildChatBlocks` (Task 5), `KLogBlock` (Task 11), `KToolRow` (Task 10).
- Produces: `<KRequestBlock :block :session-id :open :expand-all />`.

- [ ] **Step 1: Write `KRequestBlock.vue`**

```vue
<template>
  <section class="k-rb">
    <button v-if="block.request" type="button" class="k-rb__head" :aria-expanded="shown" @click="shown = !shown">
      <span class="k-rb__bar" aria-hidden="true"></span>
      <span class="k-rb__tx">{{ block.request.text }}</span>
      <span v-if="!shown" class="k-rb__sum mono">{{ summary }}</span>
      <span v-else class="k-rb__time mono">{{ clock }}</span>
    </button>

    <template v-if="shown">
      <template v-for="(item, i) in block.items" :key="i">
        <div v-if="item.kind === 'group'" class="k-rb__group">
          <button type="button" class="k-rb__grow" :aria-expanded="opened.has(i)" @click="toggle(i)">
            <span class="k-rb__g" aria-hidden="true">✓</span>
            <span class="k-rb__gt">{{ item.tool }}</span>
            <span class="k-rb__gx">×{{ item.members.length }}</span>
            <span class="k-rb__gtg">{{ item.members.map((m) => m.target).filter(Boolean).join(', ') }}</span>
            <span class="k-rb__gst">{{ item.stat }}</span>
            <span class="k-rb__gch" aria-hidden="true">{{ opened.has(i) ? '⌄' : '›' }}</span>
          </button>
          <div v-if="opened.has(i)" class="k-rb__members">
            <KToolRow v-for="m in item.members" :key="m.id" :entry="m" :session-id="sessionId" />
          </div>
        </div>
        <KLogBlock
          v-else-if="!item.muted || expandAll"
          :entry="item.entry"
          :session-id="sessionId"
        />
      </template>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ChatBlock } from '@kermanych/core';
import KLogBlock from './KLogBlock.vue';
import KToolRow from './KToolRow.vue';

const props = defineProps<{ block: ChatBlock; sessionId: string; open: boolean; expandAll: boolean }>();

const shown = ref(props.open);
const opened = ref(new Set<number>());
function toggle(i: number): void {
  const next = new Set(opened.value);
  next.has(i) ? next.delete(i) : next.add(i);
  opened.value = next;
}

function dur(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} с` : `${Math.round(s / 60)} хв`;
}

const clock = computed(() =>
  props.block.request ? new Date(props.block.request.at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) : '',
);

// Five facts, all derived from the block's own entries — see the spec's requirement 8.
const summary = computed(() => {
  const s = props.block.summary;
  return [
    dur(s.ms),
    `${s.calls} викликів`,
    `${s.files} файлів`,
    s.thinkMs ? `роздуми ${dur(s.thinkMs)}` : '',
    s.cost ? `$${s.cost.toFixed(2)}` : '',
  ].filter(Boolean).join(' · ');
});
</script>

<style scoped lang="scss">
.k-rb + .k-rb { margin-top: 10px; }
.k-rb__head {
  display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 6px 0;
  background: transparent; border: none; cursor: pointer; text-align: left;
}
.k-rb__head:focus-visible { outline: 1px solid var(--k-accent); outline-offset: 2px; }
.k-rb__bar { flex: none; width: 2px; align-self: stretch; background: var(--k-accent); }
.k-rb__tx {
  flex: 1; font-family: var(--k-font-ui); font-size: 14px; line-height: 1.5; color: var(--k-text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.k-rb__sum, .k-rb__time { flex: none; font-size: 10.5px; color: var(--k-muted); }
.k-rb__grow {
  display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 0;
  background: transparent; border: none; cursor: pointer; text-align: left;
  font-family: var(--k-font-mono); font-size: 12.5px; line-height: 1.7;
  white-space: nowrap; overflow: hidden; color: var(--k-muted);
}
.k-rb__grow:hover { background: var(--k-surface); }
.k-rb__g { flex: none; width: 9px; font-size: 10.5px; }
.k-rb__gt { flex: none; width: 44px; color: var(--k-text); }
.k-rb__gx { flex: none; font-size: 11px; }
.k-rb__gtg { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.k-rb__gst { flex: none; font-size: 11.5px; color: var(--k-text); }
.k-rb__gch { flex: none; width: 10px; text-align: right; font-size: 11px; color: var(--k-line-strong); }
.k-rb__members { padding-left: 17px; }
</style>
```

- [ ] **Step 2: Group entries in `WorkspacePage.vue`**

Replace lines 173-176 with:

```vue
          <template v-if="blocks.length">
            <KRequestBlock
              v-for="(block, i) in blocks"
              :key="block.id"
              :block="block"
              :session-id="selectedSession.id"
              :open="i === blocks.length - 1"
              :expand-all="expandAll"
            />
          </template>
          <div v-else class="ws__log-empty mono">Журнал порожній.</div>
```

and in the script, beside the existing `entries` computed (lines 543-550):

```ts
const expandAll = ref(false);
const blocks = computed(() => buildChatBlocks(entries.value));
```

importing `buildChatBlocks` from `@kermanych/core` and `KRequestBlock` from
`../components/kit/KRequestBlock.vue`, and dropping the now-unused `KLogBlock` import.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @kermanych/ui typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/components/kit/KRequestBlock.vue apps/ui/src/pages/WorkspacePage.vue
git commit -m "feat(ui): collapse finished request blocks to one summary row"
```

---

### Task 13: Todos lane, status row, and the `-/N` fix

**Files:**
- Create: `apps/ui/src/components/kit/KTodoLane.vue`, `apps/ui/src/components/kit/KStatusRow.vue`
- Modify: `apps/ui/src/components/kit/KPanel.vue`

**Interfaces:**
- Consumes: `Session.todoPhases`, `Session.contextPercent`, `Session.currentTool`, `Session.lastEventAt`; block summaries for accumulated cost.
- Produces: `<KTodoLane :phases />`, `<KStatusRow :session :cost />`; the detail toolbar with `розгорнути все` / `згорнути все`.

- [ ] **Step 1: Write `KTodoLane.vue`**

```vue
<template>
  <div v-if="total" class="k-tl mono">
    <span class="k-tl__label">Todos</span>
    <span class="k-tl__count">{{ done }}/{{ total }}</span>
    <span v-if="phase" class="k-tl__sep">·</span>
    <span v-if="phase" class="k-tl__phase">{{ phase }}</span>
    <span v-if="active" class="k-tl__sep">·</span>
    <span v-if="active" class="k-tl__active">{{ active }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { TodoPhase } from '@kermanych/core';

const props = defineProps<{ phases?: TodoPhase[] }>();

const all = computed(() => (props.phases ?? []).flatMap((p) => p.tasks));
const total = computed(() => all.value.length);
const done = computed(() => all.value.filter((t) => t.status === 'completed').length);
const current = computed(() =>
  (props.phases ?? []).find((p) => p.tasks.some((t) => t.status === 'in_progress')),
);
const phase = computed(() => current.value?.name ?? '');
const active = computed(() => current.value?.tasks.find((t) => t.status === 'in_progress')?.content ?? '');
</script>

<style scoped lang="scss">
.k-tl {
  flex: none; display: flex; align-items: baseline; gap: 8px;
  padding: 6px 12px; border-top: 1px solid var(--k-line);
  font-size: 11.5px; color: var(--k-muted); white-space: nowrap; overflow: hidden;
}
.k-tl__count { color: var(--k-text); }
.k-tl__active { color: var(--k-text); overflow: hidden; text-overflow: ellipsis; }
</style>
```

- [ ] **Step 2: Write `KStatusRow.vue`**

```vue
<template>
  <div class="k-sr mono">
    <span v-if="session.model">{{ session.model }}</span>
    <span v-if="session.contextPercent != null" class="k-sr__sep">·</span>
    <span v-if="session.contextPercent != null">{{ session.contextPercent.toFixed(0) }}%</span>
    <span v-if="cost" class="k-sr__sep">·</span>
    <span v-if="cost">${{ cost.toFixed(2) }}</span>
    <span class="k-sr__spacer"></span>
    <span v-if="live" class="k-sr__live">◆ {{ live }}<template v-if="elapsed"> · {{ elapsed }}</template></span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Session } from '@kermanych/core';
import { useNow } from '../../composables/useNow';

const props = defineProps<{ session: Session; cost: number }>();

const now = useNow(1000);
const live = computed(() =>
  props.session.status === 'tool' ? (props.session.currentTool ?? 'виконує')
  : props.session.status === 'thinking' ? 'думає'
  : props.session.status === 'queued' ? 'стартує'
  : '',
);
// Never fabricate a metric: with no heartbeat there is no elapsed time to show.
const elapsed = computed(() => {
  if (!live.value || !props.session.lastEventAt) return '';
  const s = Math.max(0, Math.round((now.value - props.session.lastEventAt) / 1000));
  return s < 60 ? `${s} с` : `${Math.round(s / 60)} хв`;
});
</script>

<style scoped lang="scss">
.k-sr {
  flex: none; display: flex; align-items: center; gap: 8px;
  padding: 5px 12px; border-top: 1px solid var(--k-line-strong);
  font-size: 11px; color: var(--k-muted); white-space: nowrap; overflow: hidden;
}
.k-sr__spacer { margin-left: auto; }
.k-sr__live { color: var(--k-accent); }
</style>
```

- [ ] **Step 3: Mount both in `KPanel.vue` and fix the stepper label**

- Add a detail toolbar directly under the header, emitting `expandAll`:
  `<div class="k-panel__tools mono"><span>деталі:</span><button type="button" @click="emit('expandAll', true)">розгорнути все</button><button type="button" @click="emit('expandAll', false)">згорнути все</button></div>`
- Insert `<KTodoLane :phases="session.todoPhases" />` and
  `<KStatusRow :session="session" :cost="cost" />` between the closing `</div>` of
  `.k-panel__log` and the composer block, so lane order is log → todos → status → composer.
- Add `const props = defineProps<{ …existing…, cost?: number }>()` passthrough and
  `const cost = computed(() => props.cost ?? 0)`.
- Fix `userNavLabel` so an unvisited stepper reads `1/N` rather than `-/N`: replace the
  label expression with `` `${userIdx.value < 0 ? 1 : userIdx.value + 1}/${userMsgCount.value}` ``.

`WorkspacePage.vue` passes the total: `:cost="blocks.reduce((s, b) => s + b.summary.cost, 0)"`
and handles `@expand-all="expandAll = $event"`.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @kermanych/ui typecheck && pnpm --filter @kermanych/ui test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/components/kit/KTodoLane.vue apps/ui/src/components/kit/KStatusRow.vue apps/ui/src/components/kit/KPanel.vue apps/ui/src/pages/WorkspacePage.vue
git commit -m "feat(ui): todos lane, persistent status row, correct my-message counter"
```

---

### Task 14: Full-suite gate and browser smoke

**Files:**
- No production changes; fixes discovered here belong to the task that introduced them.

**Interfaces:**
- Consumes: everything above.
- Produces: recorded evidence that the spec's Verification section passes.

- [ ] **Step 1: Run every suite and typecheck**

Run:
```bash
pnpm -r test
pnpm --filter @kermanych/api typecheck
pnpm --filter @kermanych/ui typecheck
```
Expected: PASS everywhere.

- [ ] **Step 2: Run the app**

Run: `pnpm dev:api` and `pnpm dev:ui` in separate terminals (or `pnpm dev:app`), then open <http://localhost:5317>.

- [ ] **Step 3: Walk the smoke list from the spec**

Confirm, on a session with real history:
- every tool row shows a `stat`; no row is a bare tool name;
- `bash` and `grep` render as whole words in the tool column;
- clicking an `edit` row shows a diff with `+`/`−` gutters and wrapped long lines;
- clicking a `grep` row shows per-file counts then match lines;
- an errored row stays collapsed but shows `exit N`;
- `показати всі N рядків` fetches and renders the full output;
- a finished request block is one row with `тривалість · викликів · файлів · роздуми · вартість`;
- the Todos lane appears only when the session has todos;
- the status row keeps model, context %, cost and a live elapsed time;
- the my-message stepper reads `1/N`;
- reload the app: the rehydrated transcript looks identical to the live one.

- [ ] **Step 4: Commit any fixes, then stop**

```bash
git add -A
git commit -m "fix(chat): smoke findings from the detail rollout"
```

---

## Self-Review

**Spec coverage.** Requirement 1 → Tasks 1-4, 7. 2 → Task 10 (`.k-tr__t` fixed width). 3 → Tasks 10, 13. 4 → Tasks 1-4 (line classification) + 10 (painting). 5 → Task 10 (`--wrap`). 6 → Tasks 5, 12. 7 → Tasks 5, 11. 8 → Tasks 5, 12. 9 → Task 13. 10 → Task 13. 11 → Task 11 (`assistant_text` untouched). 12 → Task 7 parity test. 13 → Tasks 6, 8, 10. 14 → Tasks 10-13 (tokens only). API sections: detail cache → Task 6; endpoint → Task 8; `notice` handling → Task 7; frame-failure counter → **gap, folded into Task 7 Step 6** as part of the service rewiring; `messagesToTranscript` → Task 7.

**Frame-failure gap, resolved:** add to Task 7 Step 6 — in `apps/api/src/rpc/rpc-session.ts:89-99`, replace the two bare `return`s with a counter increment plus one `notice`-shaped callback (`{ type: "notice", message: "втрачено кадр від omp" }`) so the drop becomes a visible transcript entry instead of silence.

**Placeholder scan.** No `TBD`/`TODO`; every code step carries real code; no step says "similar to Task N".

**Type consistency.** `ToolLine`, `ToolDetail`, `TurnUsage`, `TranscriptEntry` defined in Task 1 and used unchanged in 5-13. `toolDisplay`/`clampLines`/`shortPath`/`humanBytes` defined in Task 1, extended in 2-4, consumed in 7. `ToolDisplay.count` introduced in Task 1 and consumed by `groupStat` in Task 5. `buildChatBlocks`/`ChatBlock`/`ChatItem`/`BlockSummary` defined in Task 5, consumed in 12-13. `ToolDetailCache` defined in Task 6, consumed in 7-8. `applyTranscriptUpdate` defined in Task 9, consumed by the store. `KToolRow` props (`entry`, `sessionId`) match every call site in Tasks 11-12.
