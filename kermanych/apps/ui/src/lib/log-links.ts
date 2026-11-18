// What a click on a link in an agent's rendered markdown (KLogBlock) should do. Agents cite the
// files they read or wrote as markdown links — `[spec](docs/specs/x.md)`, `[x](src/a.ts:280)`,
// an absolute path in their cwd, a `file://` URL. Followed by the browser, such a link resolves
// against the app's own origin and would replace the app (the Electron main refuses that
// navigation), so the log opens it as a file of the session's tree instead.
//
// - `{ kind: 'file', path }` — a path inside the tree, relative to its root, POSIX: open it.
// - `{ kind: 'none' }`       — a link with nothing to open here (a bare `#anchor`, a folder, a
//                              path outside the tree): swallow the click.
// - `null`                   — a web/mail link: leave it to the browser (the default browser).
export type LogLinkTarget = { kind: 'file'; path: string } | { kind: 'none' };

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
// `file.ts:280`, `file.ts:280-288`, `file.ts:12:5` — an editor-style line suffix.
const LINE_SUFFIX_RE = /:\d+(?:[-:]\d+)?$/;

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Folds `.`/`..` segments; null when the path climbs above its root.
function normalize(path: string): string | null {
  const parts: string[] = [];
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/') || null;
}

/**
 * @param href  the anchor's `href` as rendered (markdown-it percent-encodes non-ASCII)
 * @param root  absolute path of the session's tree (worktree or checkout), to place an
 *              absolute path inside it; undefined when the tree is gone
 */
export function logLinkTarget(href: string, root: string | undefined): LogLinkTarget | null {
  const raw = href.trim();
  if (!raw || raw.startsWith('#')) return { kind: 'none' };
  if (raw.startsWith('//')) return null;
  let path: string;
  if (/^file:/i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { kind: 'none' };
    }
    path = decode(url.pathname).replace(LINE_SUFFIX_RE, '');
  } else {
    const bare = raw.split(/[?#]/, 1)[0]!;
    // The line suffix goes first: `a.ts:280` would otherwise read as a scheme `a.ts:`.
    const noLine = bare.replace(LINE_SUFFIX_RE, '');
    if (SCHEME_RE.test(noLine)) return null;
    path = decode(noLine);
  }
  if (!path || path.endsWith('/')) return { kind: 'none' };
  if (path.startsWith('/')) {
    const base = root?.replace(/\/+$/, '');
    if (!base || !path.startsWith(`${base}/`)) return { kind: 'none' };
    path = path.slice(base.length + 1);
  }
  const rel = normalize(path);
  return rel ? { kind: 'file', path: rel } : { kind: 'none' };
}
