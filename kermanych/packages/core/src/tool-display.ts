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
  if (lines.length <= budget) return lines;
  // bash appends its wall/timeout/exit footer last; a head-only slice would drop it.
  const last = lines[lines.length - 1];
  return last.t === "head" ? [...lines.slice(0, budget - 1), last] : lines.slice(0, budget);
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
// A trailing newline is the normal shape of captured stdout; keeping it would add a
// phantom empty line that eats a preview slot and inflates `totalLines`.
const textLines = (s: string): ToolLine[] => (s ? s.replace(/\n$/, "").split("\n").map((text) => ({ t: "ctx" as const, text })) : []);

type Args = Record<string, unknown>;
type Details = Record<string, unknown>;
type Reducer = (args: Args, d: Details, content: string) => ToolDisplay;

const readDisplay: Reducer = (args, d, content) => {
  const target = shortPath(str(args["path"]));
  if (d["isDirectory"]) {
    const dirLines = textLines(content);
    return { target, stat: "каталог", lines: dirLines, totalLines: dirLines.length };
  }
  const dc = d["displayContent"] as { text?: string; lineNumbers?: number[] } | undefined;
  const total = num(d["totalLines"]);
  const nums = dc?.lineNumbers ?? [];
  const body = str(dc?.text);
  const lines: ToolLine[] = body
    ? body.split("\n").map((text, i) => (nums[i] === undefined ? { t: "ctx" as const, text } : { t: "ctx" as const, n: String(nums[i]), text }))
    : textLines(content);
  const shown = nums.length || lines.length;
  // Only a partial read earns the shown/total form; a whole-file read reports the file's size in
  // lines. `count` must always be the number `stat` prints, so coalesced rows can sum it.
  const partial = d["truncation"] ? true : undefined;
  const ranged = Boolean(partial && total && shown && shown < total);
  const stat = ranged ? `${shown}/${total} ln` : total ? `${total} ln` : humanBytes(num(d["fileSize"]));
  return { target, stat, count: ranged ? shown : total ?? shown, lines, totalLines: lines.length, truncatedUpstream: partial };
};

const writeDisplay: Reducer = (args, d) => {
  const body = str(args["content"]);
  const rows = body ? body.split("\n") : [];
  return {
    // The call's own path is the readable, repo-relative one; resolvedPath is absolute.
    target: shortPath(str(args["path"]) || str(d["resolvedPath"])),
    stat: `+${rows.length} ln`,
    count: rows.length,
    lines: rows.map((text, i) => ({ t: "add" as const, n: String(i + 1), text })),
    totalLines: rows.length,
  };
};

const globDisplay: Reducer = (args, d, content) => {
  const files = (d["files"] as string[] | undefined) ?? [];
  const count = num(d["fileCount"]);
  const lines: ToolLine[] = files.length ? files.map((text) => ({ t: "ctx" as const, text })) : textLines(content);
  return {
    target: shortPath(str(args["path"]), 1),
    stat: `${count ?? files.length} файлів${d["truncated"] ? " ·обрізано" : ""}`,
    count: count ?? files.length,
    lines,
    totalLines: lines.length,
    truncatedUpstream: d["truncated"] ? true : undefined,
  };
};

// omp ships the diff already numbered: " 26|context", "-28|removed", "+28|added",
// with an empty line marking a hunk boundary. Split on the first bar, never parse text.
const editDisplay: Reducer = (args, d) => {
  const raw = str(d["diff"]);
  const lines: ToolLine[] = [];
  let add = 0;
  let del = 0;
  for (const row of raw ? raw.replace(/\n$/, "").split("\n") : []) {
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

const TODO_GLYPH: Record<string, string> = {
  pending: "[ ]", in_progress: "[/]", completed: "[x]", abandoned: "[-]", blocked: "[!]",
};

// The stat column's wall-time form: sub-second in whole milliseconds, then tenths of a
// second. Exported because it is also the stand-in for a reducer that named a stat source
// its payload did not carry — see `applyToolResult`.
export const msLabel = (v: number): string => (v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} с`);

const bashDisplay: Reducer = (args, d, content) => {
  const command = str(args["command"]).split(/\s+/).join(" ");
  const wall = num(d["wallTimeMs"]) ?? 0;
  const exit = num(d["exitCode"]);
  const lines: ToolLine[] = [{ t: "head", text: `$ ${command}` }, ...textLines(content)];
  const meta = [`wall ${msLabel(wall)}`];
  const timeout = num(d["timeoutSeconds"]);
  if (timeout !== undefined) meta.push(`timeout ${timeout}s`);
  if (exit) meta.push(`exit ${exit}`);
  lines.push({ t: "head", text: meta.join(" · ") });
  return {
    target: command,
    stat: exit ? `exit ${exit} · ${msLabel(wall)}` : msLabel(wall),
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
  // The peer or process is the identity of the row; the op belongs in the stat column.
  const who = str(args["to"]) || str(args["name"]);
  const lines = textLines(content);
  return { target: who, stat: `${op}${d["timedOut"] ? " · таймаут" : ""}`, lines, totalLines: lines.length };
};

const evalDisplay: Reducer = (args, d, content) => {
  const lines = textLines(content);
  return { target: str(args["i"]), stat: str(d["language"]) || str(args["language"]), lines, totalLines: lines.length };
};

const genericDisplay: Reducer = (args, _d, content) => {
  const lines = textLines(content);
  // `i` is prose, not a path: shortening it on "/" would butcher the intent.
  return { target: str(args["path"]) ? shortPath(str(args["path"]), 2) : str(args["i"]), lines, totalLines: lines.length };
};

const REDUCERS: Record<string, Reducer> = {
  read: readDisplay, write: writeDisplay, glob: globDisplay, edit: editDisplay, grep: grepDisplay,
  bash: bashDisplay, todo: todoDisplay, hub: hubDisplay, eval: evalDisplay,
};

export function toolDisplay(tool: string, args: Args | undefined, details: Details | undefined, content: string): ToolDisplay {
  return (REDUCERS[tool] ?? genericDisplay)(args ?? {}, details ?? {}, content ?? "");
}
