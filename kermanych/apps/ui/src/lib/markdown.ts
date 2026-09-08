import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';

// One shared renderer for assistant prose and expanded reasoning.
// html:false escapes any raw HTML in the source, so the rendered output is a
// controlled tag set and is safe to inject via v-html. linkify autolinks bare
// URLs; breaks:true keeps single newlines as line breaks (chat reads better).
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

export function renderMarkdown(src: string): string {
  return md.render(src ?? '');
}

// Resolve a relative link/image target against `dir` (the current file's folder, relative to
// the doc-folder root). Returns a folder-relative POSIX path, or null when the target is
// absolute, external, a bare anchor, or escapes above the folder root — those are left for
// the browser to handle (or dropped) rather than turned into a docs reference.
export function resolveRel(dir: string, rel: string): string | null {
  const t = rel.trim();
  if (!t || t.startsWith('#') || t.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//')) return null;
  const clean = t.split(/[?#]/, 1)[0]!;
  const parts = (dir ? dir.split('/') : []).filter((s) => s && s !== '.');
  for (const seg of clean.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null; // escaped above the folder root
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/') || null;
}

const DOC_LINK_RE = /\.(?:md|mdx|mdc|markdown|rst|adoc|asciidoc)$/i;

// GitHub-faithful renderer for repository documentation. Distinct instance from the chat
// renderMarkdown: breaks:false (a single newline is not a <br>), fenced code highlighted, and
// relative image/link targets rewritten to data-* attributes the docs screen resolves against
// the authed raw endpoint (images) or in-app tree navigation (doc links). html:false is kept,
// so embedded raw HTML stays escaped and v-html output is a controlled tag set.
const docMd: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
  highlight(str: string, lang: string): string {
    try {
      const out = lang && hljs.getLanguage(lang)
        ? hljs.highlight(str, { language: lang }).value
        : hljs.highlightAuto(str).value;
      return `<pre class="hljs"><code>${out}</code></pre>`;
    } catch {
      return '';
    }
  },
});

export function renderDoc(src: string, base: { folder: string; dir: string }): string {
  const attr = (path: string) =>
    ` data-doc-folder="${docMd.utils.escapeHtml(base.folder)}" data-doc-path="${docMd.utils.escapeHtml(path)}"`;

  docMd.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx]!;
    const src0 = token.attrGet('src') ?? '';
    const alt = docMd.utils.escapeHtml(token.content);
    const rel = resolveRel(base.dir, src0);
    if (rel) return `<img${attr(rel)} alt="${alt}">`;
    // External/absolute image: keep its src (still html:false-escaped by markdown-it).
    return `<img src="${docMd.utils.escapeHtml(src0)}" alt="${alt}">`;
  };

  docMd.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const token = tokens[idx]!;
    const href = token.attrGet('href') ?? '';
    const rel = resolveRel(base.dir, href);
    if (rel && DOC_LINK_RE.test(rel.split(/[?#]/, 1)[0]!)) {
      return `<a href="#"${attr(rel)}>`;
    }
    // External links open in a new tab; anchors/other relative links pass through.
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) { token.attrSet('target', '_blank'); token.attrSet('rel', 'noopener noreferrer'); }
    return self.renderToken(tokens, idx, options);
  };

  return docMd.render(src ?? '');
}
