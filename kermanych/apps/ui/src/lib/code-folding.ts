// Code folding for KCodeView: which lines open a block that can be collapsed, and where each
// block ends. Two strategies, picked by extension — brackets for the C-family and JSON, and
// indentation for YAML and Python, where nesting has no closing token. Neither parses the
// language: a bracket inside a string or a comment is skipped, which is all a fold needs.

export type FoldStyle = 'brackets' | 'indent';

// One collapsible block, by 0-based line. Bracket blocks also carry where the brackets sit,
// so a folded line can read `"packages": { 1 key },` — what comes before the opener, the
// summary, then what follows the closer.
export type FoldRegion = {
  start: number;
  end: number;
  open?: '{' | '[' | '(';
  openCol?: number;
  closeCol?: number;
  // Direct children: object keys / array items, counted by top-level commas.
  items?: number;
};

const INDENT_EXT = new Set(['yaml', 'yml', 'py']);
const BRACKET_EXT = new Set([
  'json', 'jsonc', 'json5', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue',
  'css', 'scss', 'less', 'java', 'kt', 'kts', 'go', 'rs', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs',
  'php', 'swift', 'dart', 'scala', 'groovy', 'gradle',
]);
const JSON_EXT = new Set(['json', 'jsonc', 'json5']);

/** Lower-cased extension of the file name, '' for none (and for dotfiles like `.npmrc`). */
export function extOf(path: string): string {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function foldStyle(path: string): FoldStyle | null {
  const ext = extOf(path);
  if (INDENT_EXT.has(ext)) return 'indent';
  if (BRACKET_EXT.has(ext)) return 'brackets';
  return null;
}

/** JSON reads its folds as `{ N keys }` / `[ N items ]`; code just as `{…}`. */
export function isJsonPath(path: string): boolean {
  return JSON_EXT.has(extOf(path));
}

const CLOSER: Record<string, '{' | '[' | '('> = { '}': '{', ']': '[', ')': '(' };

// Keyed by start line. Two blocks opening on one line (`foo({`) keep the one that ends later,
// and on a tie the inner one — it closes first, so it is the one already stored.
function keep(out: Map<number, FoldRegion>, r: FoldRegion): void {
  const prev = out.get(r.start);
  if (!prev || r.end > prev.end) out.set(r.start, r);
}

export function bracketRegions(lines: readonly string[]): Map<number, FoldRegion> {
  type Frame = { ch: '{' | '[' | '('; line: number; col: number; items: number; pending: boolean };
  const out = new Map<number, FoldRegion>();
  const stack: Frame[] = [];
  let inBlockComment = false;
  // A template literal may run across lines; '…' and "…" end with their line at the latest.
  let inTemplate = false;

  const content = (): void => {
    const top = stack[stack.length - 1];
    if (top) top.pending = true;
  };

  for (let ln = 0; ln < lines.length; ln++) {
    const s = lines[ln]!;
    let quote: string | null = inTemplate ? '`' : null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!;
      if (inBlockComment) {
        if (c === '*' && s[i + 1] === '/') { inBlockComment = false; i++; }
        continue;
      }
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '/' && s[i + 1] === '/') break;
      if (c === '/' && s[i + 1] === '*') { inBlockComment = true; i++; continue; }
      if (c === '"' || c === "'" || c === '`') { content(); quote = c; continue; }
      if (c === '{' || c === '[' || c === '(') {
        content();
        stack.push({ ch: c, line: ln, col: i, items: 0, pending: false });
        continue;
      }
      const opener = CLOSER[c];
      if (opener) {
        const top = stack[stack.length - 1];
        if (!top || top.ch !== opener) continue; // unbalanced source: leave the stack alone
        stack.pop();
        const items = top.items + (top.pending ? 1 : 0);
        if (ln > top.line) {
          keep(out, { start: top.line, end: ln, open: top.ch, openCol: top.col, closeCol: i, items });
        }
        continue;
      }
      if (c === ',') {
        const top = stack[stack.length - 1];
        if (top?.pending) { top.items++; top.pending = false; }
        continue;
      }
      if (c !== ' ' && c !== '\t' && c !== '\r') content();
    }
    inTemplate = quote === '`';
  }
  return out;
}

export function indentRegions(lines: readonly string[]): Map<number, FoldRegion> {
  const indent = lines.map((l) => (l.trim() === '' ? -1 : l.length - l.trimStart().length));
  const out = new Map<number, FoldRegion>();
  for (let i = 0; i < lines.length; i++) {
    const own = indent[i]!;
    if (own < 0) continue;
    // The block is every following line indented deeper; blank lines inside it belong to it,
    // trailing ones do not (the fold ends on the last line with text).
    let last = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const n = indent[j]!;
      if (n < 0) continue;
      if (n <= own) break;
      last = j;
    }
    if (last > i) out.set(i, { start: i, end: last });
  }
  return out;
}

export function foldRegions(path: string, lines: readonly string[]): Map<number, FoldRegion> {
  const style = foldStyle(path);
  if (style === 'brackets') return bracketRegions(lines);
  if (style === 'indent') return indentRegions(lines);
  return new Map();
}

/** Which lines are on screen, given the folded start lines. */
export function visibleLines(count: number, regions: ReadonlyMap<number, FoldRegion>, folded: ReadonlySet<number>): number[] {
  const rows: number[] = [];
  for (let i = 0; i < count; ) {
    rows.push(i);
    const r = folded.has(i) ? regions.get(i) : undefined;
    i = r ? r.end + 1 : i + 1;
  }
  return rows;
}

// highlight.js returns one HTML string whose spans may run across newlines (a block comment,
// a multi-line string). Cut it into per-line strings that each stand on their own: a line
// closes every span still open at its end, and the next line reopens them. hljs escapes `<`
// in the source text, so every `<` here starts one of its own tags.
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let cur = '';
  let last = 0;
  const re = /<\/?span[^>]*>|\n/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    cur += html.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[0] === '\n') {
      lines.push(cur + '</span>'.repeat(open.length));
      cur = open.join('');
    } else if (m[0].startsWith('</')) {
      open.pop();
      cur += m[0];
    } else {
      open.push(m[0]);
      cur += m[0];
    }
  }
  lines.push(cur + html.slice(last));
  return lines;
}
