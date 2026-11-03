// Find-in-file: where a query matches a file's text, how to mark those spots in highlight.js
// output without breaking its markup (KCodeView), and where it matches a rendered document
// (KDocPreview's Markdown).

/** One match, by 0-based line and [start, end) column in that line's plain text. */
export type FindHit = { line: number; start: number; end: number };

/** A range of plain text to wrap in `<mark class="cls">`. */
export type MarkRange = { start: number; end: number; cls: string };

// Past this many matches (a one-letter query in a lockfile) the rest are not worth marking:
// the count reads `N+` and stepping wraps within the first N.
export const FIND_MAX_HITS = 10_000;

export type FindOptions = { matchCase?: boolean; wholeWord?: boolean };

// A whole word stands between non-word characters: letters of any script, digits and `_` are
// word characters, so `кіт` is not found inside `кітець` nor `id` inside `_id`.
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const isWordChar = (c: string | undefined): boolean => c !== undefined && WORD_CHAR.test(c);

export function findHits(lines: readonly string[], query: string, opts: FindOptions = {}): FindHit[] {
  if (!query) return [];
  const needle = opts.matchCase ? query : query.toLowerCase();
  const out: FindHit[] = [];
  for (let line = 0; line < lines.length; line++) {
    const text = lines[line]!;
    const hay = opts.matchCase ? text : text.toLowerCase();
    let at = hay.indexOf(needle);
    while (at !== -1) {
      const end = at + needle.length;
      // A match inside a longer word is skipped by one character only: the next candidate may
      // start within it (`aa` in `aaa-aa`).
      if (opts.wholeWord && (isWordChar(text[at - 1]) || isWordChar(text[end]))) {
        at = hay.indexOf(needle, at + 1);
        continue;
      }
      out.push({ line, start: at, end });
      if (out.length >= FIND_MAX_HITS) return out;
      at = hay.indexOf(needle, end);
    }
  }
  return out;
}

/**
 * Wraps plain-text ranges of highlight.js HTML in `<mark>`. Offsets count the text the HTML
 * shows — a tag counts for nothing, an entity (`&lt;`) for one character. A mark never spans
 * a tag: it closes before one and reopens after, so `<span>` nesting stays intact. Ranges
 * must be sorted and must not overlap.
 */
export function markHtml(html: string, ranges: readonly MarkRange[]): string {
  if (ranges.length === 0) return html;
  let out = '';
  let offset = 0;
  let r = 0;
  let open = false;
  const close = (): void => {
    if (open) { out += '</mark>'; open = false; }
  };
  for (let i = 0; i < html.length; ) {
    const c = html[i]!;
    if (c === '<') {
      close();
      const gt = html.indexOf('>', i);
      const stop = gt === -1 ? html.length : gt + 1;
      out += html.slice(i, stop);
      i = stop;
      continue;
    }
    let stop = i + 1;
    if (c === '&') {
      const semi = html.indexOf(';', i);
      if (semi !== -1 && semi - i <= 10) stop = semi + 1;
    }
    while (r < ranges.length && ranges[r]!.end <= offset) r++;
    const range = ranges[r];
    if (range && offset >= range.start && !open) {
      out += `<mark class="${range.cls}">`;
      open = true;
    }
    out += html.slice(i, stop);
    i = stop;
    offset++;
    if (range && offset >= range.end) close();
  }
  close();
  return out;
}

// Elements whose text never runs on into the next one's: their texts are joined with a line
// break, so `foo` closing one paragraph and `bar` opening the next do not match `foobar`.
const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th, dt, dd, figcaption, summary, div, table, ul, ol';

/**
 * Matches in a rendered document (KDocPreview's Markdown), as DOM Ranges for the CSS Custom
 * Highlight API — which marks text without touching the markup. Searched over the document's
 * text as it reads, so a match may run across inline elements (`run <code>next</code> dev`).
 */
export function findRanges(root: Node, query: string, opts: FindOptions = {}): Range[] {
  if (!query) return [];
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; start: number }[] = [];
  let text = '';
  let block: Element | null | undefined;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const b = n.parentElement?.closest(BLOCK) ?? null;
    if (block !== undefined && b !== block) text += '\n';
    block = b;
    nodes.push({ node: n as Text, start: text.length });
    text += (n as Text).data;
  }
  const endOf = (k: number): number => nodes[k]!.start + nodes[k]!.node.data.length;
  const out: Range[] = [];
  let i = 0;
  for (const hit of findHits([text], query, opts)) {
    while (endOf(i) <= hit.start) i++;
    let j = i;
    while (endOf(j) < hit.end) j++;
    const range = doc.createRange();
    range.setStart(nodes[i]!.node, hit.start - nodes[i]!.start);
    range.setEnd(nodes[j]!.node, hit.end - nodes[j]!.start);
    out.push(range);
  }
  return out;
}
