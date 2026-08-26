// apps/api/src/worktree/split-diff.ts
// Unified diff → side-by-side rows. The Зміни tab opens one changed file as two columns
// (original | changed), and pairing a removed line with the added one that replaced it is
// the only part of that view git does not hand over: `git diff` speaks in one stream of
// `-`/`+` lines. Pairing here keeps the UI free of diff logic and makes the payload equal
// to what it draws.

export type DiffCell = { no: number; text: string };

// `mod` is a removed line paired with an added one — the same row, changed; it fills both
// columns. `add`/`del` fill one and leave the other blank, which is what keeps the two
// columns aligned line for line.
export type DiffRow = {
  kind: "ctx" | "add" | "del" | "mod";
  old: DiffCell | null;
  new: DiffCell | null;
};
export type DiffHunk = { header: string; rows: DiffRow[] };
export type SplitDiff = { hunks: DiffHunk[]; binary: boolean; truncated: boolean };

// A file view is a preview, not a checkout: past this many rows the pane scrolls through
// more than anyone reads and the JSON stops being cheap.
export const MAX_DIFF_ROWS = 4000;

// `@@ -oldStart,oldCount +newStart,newCount @@ optional section heading`. A one-line side
// omits its count, which is why both counts are optional.
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function splitDiff(patch: string, maxRows: number = MAX_DIFF_ROWS): SplitDiff {
  const hunks: DiffHunk[] = [];
  let binary = false;
  let truncated = false;
  // Rows of the hunk being read. This initial array is never attached to a hunk: a
  // positive line budget is only ever set together with a fresh hunk below.
  let rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  // Lines the current hunk header still promises on each side. They are the only reliable
  // "am I inside a hunk" signal: a body line can look exactly like a file header, because
  // a removed `-- flag` is written as `--- flag`.
  let oldLeft = 0;
  let newLeft = 0;
  const dels: DiffCell[] = [];
  const adds: DiffCell[] = [];
  let count = 0;

  // Pair a pending run: the i-th removal sits opposite the i-th addition, and the longer
  // side spills into one-sided rows.
  const flush = (): void => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const o = dels[i] ?? null;
      const m = adds[i] ?? null;
      rows.push({ kind: o && m ? "mod" : o ? "del" : "add", old: o, new: m });
      count++;
    }
    dels.length = 0;
    adds.length = 0;
  };

  for (const line of patch.split("\n")) {
    // Pending lines are rows-to-be, so they count against the cap: one unbroken run of
    // additions must not walk past it between flushes.
    if (count + dels.length + adds.length >= maxRows) {
      truncated = true;
      break;
    }

    if (oldLeft <= 0 && newLeft <= 0) {
      // Between hunks: `diff --git`, mode lines, index lines, and git's binary notice.
      const m = HUNK.exec(line);
      if (m) {
        flush(); // the run belongs to the hunk that just ended
        rows = [];
        hunks.push({ header: line.trim(), rows });
        oldNo = Number(m[1]);
        newNo = Number(m[3]);
        oldLeft = m[2] === undefined ? 1 : Number(m[2]);
        newLeft = m[4] === undefined ? 1 : Number(m[4]);
        continue;
      }
      if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) binary = true;
      continue;
    }

    const text = line.slice(1);
    switch (line[0]) {
      case "+":
        adds.push({ no: newNo++, text });
        newLeft--;
        break;
      case "-":
        dels.push({ no: oldNo++, text });
        oldLeft--;
        break;
      case "\\":
        // "\ No newline at end of file" annotates the line above; it is not a line.
        break;
      default: {
        // " " is context. A bare empty line is a context line whose leading space was
        // trimmed somewhere along the way — treated as the empty line it describes.
        flush();
        rows.push({ kind: "ctx", old: { no: oldNo++, text }, new: { no: newNo++, text } });
        count++;
        oldLeft--;
        newLeft--;
      }
    }
  }
  flush();

  return { hunks, binary, truncated };
}

// An untracked file has no blob on the other side, so every line is an addition. Asking
// git for this would mean `--no-index` and its exit-code-1 protocol; the answer is known.
export function addedFileDiff(text: string, maxRows: number = MAX_DIFF_ROWS): SplitDiff {
  const lines = text.split("\n");
  // A trailing newline ends the last line, it does not start an empty one.
  if (lines[lines.length - 1] === "") lines.pop();
  if (!lines.length) return { hunks: [], binary: false, truncated: false };

  const truncated = lines.length > maxRows;
  const shown = truncated ? lines.slice(0, maxRows) : lines;
  const rows: DiffRow[] = shown.map((t, i) => ({
    kind: "add",
    old: null,
    new: { no: i + 1, text: t },
  }));
  return {
    hunks: [{ header: `@@ -0,0 +1,${lines.length} @@`, rows }],
    binary: false,
    truncated,
  };
}
