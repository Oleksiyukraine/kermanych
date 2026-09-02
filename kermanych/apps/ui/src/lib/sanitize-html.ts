// apps/ui/src/lib/sanitize-html.ts
// Allowlist sanitizer for the HTML Jira renders (descriptions, comment bodies) before it
// meets v-html. The mirror stores what Jira said; TRUST is decided here, on display, so a
// malicious or merely exotic fragment degrades to its text rather than executing.
//
// A DOM walk over a detached template — not a regex: browsers parse HTML, so the
// sanitizer must parse it the same way or be lied to (`<img src=x onerror=…>` hides from
// patterns, not from a parser). No dependency: the allowlist is a dozen lines, and a
// hand-rolled walk over DocumentFragment is smaller than any library's option surface.

const ALLOWED_TAGS: Record<string, true> = {
  P: true, BR: true, DIV: true, SPAN: true,
  B: true, STRONG: true, I: true, EM: true, U: true, S: true, DEL: true, CODE: true, PRE: true,
  UL: true, OL: true, LI: true,
  H1: true, H2: true, H3: true, H4: true, H5: true, H6: true,
  BLOCKQUOTE: true, HR: true,
  TABLE: true, THEAD: true, TBODY: true, TR: true, TH: true, TD: true,
  A: true, IMG: true,
};

// Per-tag attribute allowlist; anything else — style, class, on*, data-* — is dropped.
const ALLOWED_ATTRS: Record<string, Record<string, true>> = {
  A: { href: true, title: true },
  IMG: { src: true, alt: true, title: true, width: true, height: true },
  TH: { colspan: true, rowspan: true },
  TD: { colspan: true, rowspan: true },
};

// http(s) and site-relative only: `javascript:`, `data:` and friends are how an href
// executes. Jira's own hrefs are absolute https or /-relative.
function safeUrl(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v.startsWith("https://") || v.startsWith("http://") || (v.startsWith("/") && !v.startsWith("//"));
}

function sanitizeNode(node: ParentNode): void {
  for (const child of [...node.children]) {
    const tag = child.tagName;
    if (!ALLOWED_TAGS[tag]) {
      // Unwrap rather than drop: `<font>text</font>` keeps its text, while SCRIPT/STYLE
      // whose text IS the payload are removed whole.
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "IFRAME" || tag === "OBJECT" || tag === "EMBED") {
        child.remove();
      } else {
        sanitizeNode(child);
        child.replaceWith(...child.childNodes);
      }
      continue;
    }
    const allowed = ALLOWED_ATTRS[tag] ?? {};
    for (const attr of [...child.attributes]) {
      const name = attr.name.toLowerCase();
      if (!allowed[name]) {
        child.removeAttribute(attr.name);
        continue;
      }
      if ((name === "href" || name === "src") && !safeUrl(attr.value)) child.removeAttribute(attr.name);
    }
    // External links must not inherit the app's browsing context.
    if (tag === "A" && child.getAttribute("href")) {
      child.setAttribute("target", "_blank");
      child.setAttribute("rel", "noopener noreferrer");
    }
    sanitizeNode(child);
  }
}

export function sanitizeJiraHtml(raw: string): string {
  if (!raw) return "";
  const tpl = document.createElement("template");
  tpl.innerHTML = raw;
  sanitizeNode(tpl.content);
  return tpl.innerHTML;
}
