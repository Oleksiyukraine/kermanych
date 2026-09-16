import { expect, test } from "vitest";
import { chunkMarkdown } from "../src/doc-chunk";

test("empty or whitespace-only input yields no chunks", () => {
  expect(chunkMarkdown("")).toEqual([]);
  expect(chunkMarkdown("   \n\n\t\n")).toEqual([]);
});

test("content before the first heading is its own chunk with an empty heading path", () => {
  const chunks = chunkMarkdown("intro line one\nintro line two\n\n# Title\nbody\n");
  expect(chunks[0]).toMatchObject({
    chunkIx: 0,
    headingPath: "",
    startLine: 1,
    content: "intro line one\nintro line two",
  });
  expect(chunks[1]).toMatchObject({ chunkIx: 1, headingPath: "# Title", content: "# Title\nbody" });
});

test("headings build the ancestor chain and siblings pop it back", () => {
  const md = ["# A", "a body", "## B", "b body", "### C", "c body", "## D", "d body"].join("\n");
  const chunks = chunkMarkdown(md);
  expect(chunks.map((c) => c.headingPath)).toEqual([
    "# A",
    "# A > ## B",
    "# A > ## B > ### C",
    // D is a sibling of B: C is popped, B is popped, D pushed under A.
    "# A > ## D",
  ]);
});

test("1-based inclusive line spans track the source", () => {
  const md = ["# A", "line2", "line3", "## B", "line5"].join("\n");
  const chunks = chunkMarkdown(md);
  expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 3, content: "# A\nline2\nline3" });
  expect(chunks[1]).toMatchObject({ startLine: 4, endLine: 5, content: "## B\nline5" });
});

test("a '#' inside a fenced code block is not treated as a heading", () => {
  const md = ["# Real", "before", "```sh", "# not a heading", "echo hi", "```", "after"].join("\n");
  const chunks = chunkMarkdown(md);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]!.headingPath).toBe("# Real");
  expect(chunks[0]!.content).toContain("# not a heading");
});

test("a section larger than maxChars is sub-split at paragraph boundaries, keeping the heading path", () => {
  const para = (n: number) => `paragraph ${n} ${"x".repeat(40)}`;
  const md = ["## Big", para(1), "", para(2), "", para(3)].join("\n");
  const chunks = chunkMarkdown(md, { maxChars: 60 });
  expect(chunks.length).toBeGreaterThan(1);
  // Every sub-chunk carries the same heading path...
  for (const c of chunks) expect(c.headingPath).toBe("## Big");
  // ...chunk_ix is sequential...
  expect(chunks.map((c) => c.chunkIx)).toEqual(chunks.map((_, i) => i));
  // ...each piece holds whole, non-empty paragraph text...
  for (const c of chunks) expect(c.content.trim()).not.toBe("");
  // ...and line spans stay contiguous and ordered, never overlapping.
  for (let i = 1; i < chunks.length; i++) {
    expect(chunks[i]!.startLine).toBeGreaterThan(chunks[i - 1]!.endLine);
  }
});

test("a heading with no body still produces a citable chunk", () => {
  const chunks = chunkMarkdown("## Lonely\n");
  expect(chunks).toEqual([
    { chunkIx: 0, headingPath: "## Lonely", startLine: 1, endLine: 1, content: "## Lonely" },
  ]);
});
