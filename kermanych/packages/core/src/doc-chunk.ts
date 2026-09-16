// Markdown chunking for the documentation RAG index. Pure and fs-free, so it is unit
// tested without a repo, a database or a network — the same discipline as skillsUsed and
// docsRead.
//
// The split is on HEADINGS, never on a fixed character count: a heading is where a document
// changes subject, so a heading-bounded chunk is a coherent passage to embed and a
// meaningful thing to cite. `headingPath` (e.g. "# Title > ## Setup > ### Prerequisites")
// is the ancestor chain that makes a citation legible, and `startLine`/`endLine` (1-based,
// inclusive) are what let a citation open the file at the right place through
// useProjectDocs.openFile().
//
// A single very large section is the one exception: a section far past a model's comfortable
// input is sub-split at paragraph (blank-line) boundaries so no chunk is pathologically
// large, while every sub-chunk keeps the section's heading path and a contiguous line span.
// This is a safety bound on top of the heading split, not a return to character chunking.

export type DocChunk = {
  // Sequential index within the file, from 0, in document order. Part of the chunk row's
  // natural key (project_id, folder, path, chunk_ix).
  chunkIx: number;
  // The ancestor heading chain, "# A > ## B > ### C". Empty for content before the first
  // heading.
  headingPath: string;
  // 1-based inclusive line span in the source file.
  startLine: number;
  endLine: number;
  content: string;
};

// Soft ceiling for one chunk's content, in characters. voyage-4-lite accepts far more than
// this per input; the bound exists only so a single enormous section cannot become one
// chunk that dominates a batch or a retrieval. Roughly 1000 tokens of English.
const DEFAULT_MAX_CHARS = 4000;

// ATX heading, up to three leading spaces (CommonMark), 1–6 hashes, at least one space, a
// non-empty title. Setext (=== / ---) headings are intentionally not recognised: they are
// rare in engineering docs and ambiguous with horizontal rules and table separators.
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
// A fenced code block opens/closes on ``` or ~~~ (three or more), possibly indented. A `#`
// inside a fence is a comment or shell prompt, never a heading.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

type RawSection = { headingPath: string; startLine: number; lines: string[] };

// Split the document into heading-bounded sections. Content before the first heading is its
// own section with an empty heading path.
function sections(text: string): RawSection[] {
  const lines = text.split("\n");
  const out: RawSection[] = [];
  // The heading stack: one entry per open ancestor level, each "### Title" as printed.
  const stack: { level: number; label: string }[] = [];
  let cur: RawSection = { headingPath: "", startLine: 1, lines: [] };
  let inFence = false;

  const flush = () => {
    // Keep a section only if it carries some non-whitespace content (a heading counts).
    if (cur.lines.some((l) => l.trim() !== "")) out.push(cur);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE_RE.test(line)) inFence = !inFence;
    const m = inFence ? null : HEADING_RE.exec(line);
    if (m) {
      // A heading starts a new section. Close the previous one first.
      flush();
      const level = m[1]!.length;
      const label = `${m[1]} ${m[2]!.trim()}`;
      // Pop deeper-or-equal levels, then push this one, to form the ancestor chain.
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, label });
      cur = {
        headingPath: stack.map((s) => s.label).join(" > "),
        startLine: i + 1,
        lines: [line],
      };
    } else {
      cur.lines.push(line);
    }
  }
  flush();
  return out;
}

// Sub-split one section's lines at blank-line (paragraph) boundaries so no piece exceeds
// maxChars. Never splits mid-paragraph; a single paragraph longer than maxChars is emitted
// whole rather than cut inside a sentence.
function packParagraphs(
  lines: string[],
  sectionStartLine: number,
  maxChars: number,
): { startLine: number; endLine: number; content: string }[] {
  const pieces: { startLine: number; endLine: number; content: string }[] = [];
  let buf: string[] = [];
  let bufStart = sectionStartLine;
  let len = 0;

  const emit = (endLine: number) => {
    const content = buf.join("\n").replace(/\s+$/, "");
    if (content.trim() !== "") pieces.push({ startLine: bufStart, endLine, content });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const absLine = sectionStartLine + i;
    const isBlank = line.trim() === "";
    // Break before appending when the buffer is full AND we are at a paragraph boundary,
    // so a chunk always ends on a blank line rather than inside a paragraph.
    if (len > 0 && isBlank && len + line.length > maxChars) {
      emit(absLine - 1);
      buf = [];
      bufStart = absLine + 1;
      len = 0;
      continue; // the blank line itself is a separator, dropped from the next piece's head
    }
    buf.push(line);
    len += line.length + 1;
  }
  if (buf.length) emit(sectionStartLine + lines.length - 1);
  return pieces;
}

// Chunk a markdown/plain-text document. Returns [] for empty or whitespace-only input.
export function chunkMarkdown(text: string, opts: { maxChars?: number } = {}): DocChunk[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const chunks: DocChunk[] = [];
  let ix = 0;
  for (const sec of sections(text)) {
    // Trailing blank lines belong to no chunk: they would push endLine past the last line
    // that actually holds content, and a citation would open below the passage.
    let n = sec.lines.length;
    while (n > 0 && sec.lines[n - 1]!.trim() === "") n--;
    const kept = sec.lines.slice(0, n);
    const content = kept.join("\n").replace(/\s+$/, "");
    if (content.length <= maxChars) {
      if (content.trim() !== "") {
        chunks.push({
          chunkIx: ix++,
          headingPath: sec.headingPath,
          startLine: sec.startLine,
          endLine: sec.startLine + n - 1,
          content,
        });
      }
      continue;
    }
    for (const p of packParagraphs(kept, sec.startLine, maxChars)) {
      chunks.push({
        chunkIx: ix++,
        headingPath: sec.headingPath,
        startLine: p.startLine,
        endLine: p.endLine,
        content: p.content,
      });
    }
  }
  return chunks;
}
