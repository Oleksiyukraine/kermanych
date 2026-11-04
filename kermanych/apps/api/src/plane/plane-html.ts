// apps/api/src/plane/plane-html.ts
// Markdown ⇄ Plane editor HTML, the two directions every Plane text crosses (spec
// Decision 7).
//
// Markdown is the app's lingua franca (see jira-adf.ts): the Менеджмент chat writes its
// tickets as «## Context» / «- [ ] criterion», the composers are plain textareas, and a
// launched ticket becomes a task body the agent reads. Plane stores bodies as its editor's
// HTML (`description_html`, `comment_html`). So every OUTBOUND body is rendered here with
// markdown-it — `- [ ]` becoming Plane's own task list — and every INBOUND body that the app
// shows as text (the editor's starting description, a launched ticket's task) is read back
// as markdown, so a save round-trips the structure instead of flattening it.
//
// The inbound direction is a small tolerant tag walker rather than a DOM: the api has no
// DOM, a dependency for one reader is not worth it, and the input is Plane's own editor
// output — a narrow, well-formed dialect. Tags it does not know contribute their text.
//
// Pure functions, no I/O — the plane-map.ts rule.
import MarkdownIt from "markdown-it";

type Token = MarkdownIt.Token;

// The UI's own renderer options (apps/ui/src/lib/markdown.ts), the jira-adf.ts reasoning:
// the same text must mean the same thing on the native board and in Plane. `html: false`
// escapes raw HTML in the source rather than passing it to Plane's sanitizer.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });

// ── markdown → Plane HTML ─────────────────────────────────────────────────────

// `<p></p>` for a blank body: it is Plane's own spelling of an empty description, and a
// blank description is exactly what clearing one means.
export function markdownToPlaneHtml(markdown: string): string {
  const source = markdown.trim();
  if (!source) return "<p></p>";
  const tokens = md.parse(source, {});
  markTaskLists(tokens);
  return md.renderer.render(tokens, md.options, {}).trim();
}

const TASK_PREFIX = /^\[([ xX])\](?:[ \t]+|$)/;

// A bullet list whose EVERY item opens with `[ ]` / `[x]` becomes Plane's task list:
// `<ul data-type="taskList"><li data-type="taskItem" data-checked="…"><p>…</p></li></ul>`,
// the markup Plane's editor parses into checkable items. A mixed list stays a plain list
// with its brackets as text — Plane's task list holds task items only. The item's
// paragraph is un-hidden (markdown-it hides it in a tight list): a task item's content is
// a paragraph in Plane's schema, not bare text.
function markTaskLists(tokens: Token[]): void {
  for (let i = 0; i < tokens.length; i++) {
    const list = tokens[i]!;
    if (list.type !== "bullet_list_open") continue;
    const items: { open: Token; inline: Token; checked: boolean; prefix: number }[] = [];
    let plain = false;
    let end = i + 1;
    for (; end < tokens.length; end++) {
      const t = tokens[end]!;
      if (t.type === "bullet_list_close" && t.level === list.level) break;
      if (t.type !== "list_item_open" || t.level !== list.level + 1) continue;
      const para = tokens[end + 1];
      const inline = tokens[end + 2];
      const m = para?.type === "paragraph_open" && inline?.type === "inline" ? TASK_PREFIX.exec(inline.content) : null;
      if (!m || !inline) plain = true;
      else items.push({ open: t, inline, checked: m[1] !== " ", prefix: m[0].length });
    }
    if (plain || items.length === 0) continue;
    list.attrSet("data-type", "taskList");
    for (const item of items) {
      item.open.attrSet("data-type", "taskItem");
      item.open.attrSet("data-checked", item.checked ? "true" : "false");
      stripPrefix(item.inline, item.prefix);
    }
    for (let k = i + 1; k < end; k++) {
      const t = tokens[k]!;
      if ((t.type === "paragraph_open" || t.type === "paragraph_close") && t.level === list.level + 2) t.hidden = false;
    }
  }
}

// The `[ ] ` marker leaves the item's text: markdown-it's text_join keeps it in the first
// text child, but the loop tolerates it being split across several.
function stripPrefix(inline: Token, length: number): void {
  inline.content = inline.content.slice(length);
  let left = length;
  for (const child of inline.children ?? []) {
    if (left === 0 || child.type !== "text") break;
    const take = Math.min(left, child.content.length);
    child.content = child.content.slice(take);
    left -= take;
  }
}

// ── Plane HTML → markdown ─────────────────────────────────────────────────────

type HtmlElement = { tag: string; attrs: Record<string, string>; children: HtmlNode[] };
// A string is a text node, entities already decoded.
type HtmlNode = HtmlElement | string;

const VOID_TAGS: Record<string, true> = {
  br: true, hr: true, img: true, input: true, meta: true, link: true, wbr: true, source: true, col: true,
  area: true, base: true, embed: true, param: true, track: true,
};

// Tags that start a block of their own; everything else is inline (or unknown, and then
// its text joins the surrounding line).
const BLOCK_TAGS: Record<string, true> = {
  p: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true, ul: true, ol: true, li: true,
  blockquote: true, pre: true, hr: true, div: true, section: true, article: true, header: true, footer: true,
  figure: true, table: true, thead: true, tbody: true, tr: true, td: true, th: true,
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

// A forgiving tree builder: a close tag pops back to its nearest matching open tag (so an
// unclosed <li> or <p> ends where its parent does), an unmatched close is ignored, and a
// `<` that starts no tag stays text.
function parseHtml(html: string): HtmlElement {
  const root: HtmlElement = { tag: "#root", attrs: {}, children: [] };
  const stack: HtmlElement[] = [root];
  const top = (): HtmlElement => stack[stack.length - 1]!;
  let last = 0;
  for (const m of html.matchAll(TAG)) {
    const at = m.index ?? 0;
    if (at > last) top().children.push(decodeEntities(html.slice(last, at)));
    last = at + m[0].length;
    if (m[0].startsWith("<!--")) continue;
    const tag = m[2]!.toLowerCase();
    if (m[1]) {
      const open = stack.map((e) => e.tag).lastIndexOf(tag);
      if (open > 0) stack.length = open;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (m[3] ?? "").matchAll(ATTR)) attrs[a[1]!.toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
    const el: HtmlElement = { tag, attrs, children: [] };
    top().children.push(el);
    if (!m[4] && !VOID_TAGS[tag]) stack.push(el);
  }
  if (last < html.length) top().children.push(decodeEntities(html.slice(last)));
  return root;
}

export function planeHtmlToMarkdown(html: string): string {
  return blocks(parseHtml(html).children).join("\n\n").trim();
}

// A container's children as markdown blocks: consecutive inline nodes form one paragraph,
// block elements render as themselves. Whitespace-only runs between blocks vanish.
function blocks(nodes: readonly HtmlNode[]): string[] {
  const out: string[] = [];
  let run: HtmlNode[] = [];
  const flush = (): void => {
    const text = tidy(inline(run));
    if (text) out.push(text);
    run = [];
  };
  for (const node of nodes) {
    if (typeof node !== "string" && BLOCK_TAGS[node.tag]) {
      flush();
      out.push(...block(node));
    } else run.push(node);
  }
  flush();
  return out;
}

function block(el: HtmlElement): string[] {
  const heading = /^h([1-6])$/.exec(el.tag);
  if (heading) {
    const text = tidy(inline(el.children)).replace(/\n/g, " ");
    return text ? [`${"#".repeat(Number(heading[1]))} ${text}`] : [];
  }
  switch (el.tag) {
    case "p": {
      const text = tidy(inline(el.children));
      return text ? [text] : [];
    }
    case "ul":
    case "ol": {
      const list = listMarkdown(el, el.tag === "ol");
      return list ? [list] : [];
    }
    case "blockquote": {
      const inner = blocks(el.children).join("\n\n");
      return inner ? [inner.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n")] : [];
    }
    case "pre": {
      const code = el.children.find((c): c is HtmlElement => typeof c !== "string" && c.tag === "code");
      const language = /(?:^|\s)language-(\S+)/.exec(code?.attrs.class ?? "")?.[1] ?? "";
      return [`\`\`\`${language}\n${textContent(el).replace(/\n$/, "")}\n\`\`\``];
    }
    case "hr":
      return ["---"];
    default:
      return blocks(el.children);
  }
}

// One list, tight: each item's blocks on consecutive lines, continuation lines indented
// under the marker so a nested list stays nested. A Plane task list (or a stray task item)
// reads back as `- [ ]` / `- [x]` from its `data-checked`.
function listMarkdown(el: HtmlElement, ordered: boolean): string {
  const taskList = el.attrs["data-type"] === "taskList";
  let n = Number(el.attrs.start ?? "1") || 1;
  const items: string[] = [];
  for (const child of el.children) {
    if (typeof child === "string" || child.tag !== "li") continue;
    const task = taskList || child.attrs["data-type"] === "taskItem";
    const marker = ordered ? `${n++}. ` : task ? `- [${child.attrs["data-checked"] === "true" ? "x" : " "}] ` : "- ";
    const indent = " ".repeat(ordered ? marker.length : 2);
    const [first = "", ...rest] = blocks(child.children).join("\n").split("\n");
    items.push(marker + first + rest.map((line) => `\n${line ? indent + line : ""}`).join(""));
  }
  return items.join("\n");
}

function inline(nodes: readonly HtmlNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (typeof node === "string") {
      out += node.replace(/\s+/g, " ");
      continue;
    }
    switch (node.tag) {
      case "br":
        out += "\n";
        break;
      case "strong":
      case "b":
        out += wrap("**", inline(node.children));
        break;
      case "em":
      case "i":
        out += wrap("*", inline(node.children));
        break;
      case "s":
      case "del":
      case "strike":
        out += wrap("~~", inline(node.children));
        break;
      case "code":
        out += `\`${textContent(node)}\``;
        break;
      case "a": {
        const text = tidy(inline(node.children));
        const href = node.attrs.href ?? "";
        out += !href ? text : !text || text === href ? href : `[${text}](${href})`;
        break;
      }
      case "img":
        out += node.attrs.alt ?? "";
        break;
      default:
        out += inline(node.children);
    }
  }
  return out;
}

// A mark around its text, with the text's edge whitespace moved OUTSIDE the mark:
// `** bold **` is not bold in markdown.
function wrap(mark: string, text: string): string {
  const core = text.trim();
  if (!core) return text;
  const lead = /^\s*/.exec(text)![0];
  const trail = /\s*$/.exec(text)![0];
  return `${lead}${mark}${core}${mark}${trail}`;
}

// A line break's neighbours lose their padding (the HTML source's own indentation), runs
// of spaces collapse, and the paragraph's edges are trimmed.
function tidy(text: string): string {
  return text
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/ {2,}/g, " ")
    .trim();
}

// Verbatim text (code), where whitespace is content: no collapsing.
function textContent(el: HtmlElement): string {
  return el.children.map((c) => (typeof c === "string" ? c : c.tag === "br" ? "\n" : textContent(c))).join("");
}
