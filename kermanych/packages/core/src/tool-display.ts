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
  // Only a partial read earns the shown/total form; a whole-file read reports the file's size in lines.
  const partial = d["truncation"] ? true : undefined;
  const stat = partial && total && shown && shown < total ? `${shown}/${total} ln` : total ? `${total} ln` : humanBytes(num(d["fileSize"]));
  return { target, stat, count: shown, lines, totalLines: lines.length, truncatedUpstream: partial };
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
  return {
    target: shortPath(str(args["path"]), 1),
    stat: `${count ?? files.length} файлів${d["truncated"] ? " ·обрізано" : ""}`,
    count: count ?? files.length,
    lines: files.length ? files.map((text) => ({ t: "ctx" as const, text })) : textLines(content),
    totalLines: files.length || (content ? content.split("\n").length : 0),
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

const genericDisplay: Reducer = (args, _d, content) => ({
  target: shortPath(str(args["path"]) || str(args["i"]), 2),
  lines: textLines(content),
  totalLines: content ? content.split("\n").length : 0,
});

const REDUCERS: Record<string, Reducer> = { read: readDisplay, write: writeDisplay, glob: globDisplay, edit: editDisplay, grep: grepDisplay };

export function toolDisplay(tool: string, args: Args | undefined, details: Details | undefined, content: string): ToolDisplay {
  return (REDUCERS[tool] ?? genericDisplay)(args ?? {}, details ?? {}, content ?? "");
}
