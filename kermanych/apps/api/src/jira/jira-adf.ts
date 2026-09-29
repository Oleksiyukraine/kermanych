// apps/api/src/jira/jira-adf.ts
// Markdown ⇄ Atlassian Document Format, the two directions every Jira text crosses.
//
// Markdown is the app's lingua franca: the Менеджмент chat renders its tickets as markdown
// (`renderTicketDescription`: «## Context», «- [ ] …»), the native board displays markdown,
// and the Jira composers are plain textareas people type markdown-ish text into. Jira v3
// takes none of it — its bodies are ADF trees, and a markdown source sent as text nodes
// lands in Jira as literal hashes and brackets. So every OUTBOUND body (description,
// comment, worklog note) is parsed here into real headings, lists, action items, code and
// marks; and every INBOUND ADF body that the app shows as text (the editor's starting
// description, a launched ticket's task, a worklog note) is read back as markdown, so a
// save round-trips the structure instead of flattening it.
//
// Pure functions, no I/O — the jira-map.ts rule.
import { randomUUID } from "node:crypto";
import MarkdownIt from "markdown-it";

type Token = MarkdownIt.Token;

export type AdfMark = { type: string; attrs?: Record<string, unknown> };

export type AdfNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: AdfMark[];
};

export type AdfDoc = { type: "doc"; version: 1; content: AdfNode[] };

// The UI's own renderer options (apps/ui/src/lib/markdown.ts): the same text must mean the
// same thing on the native board and in Jira. `breaks` has no parser effect — a single
// newline is a `softbreak` token either way — and is honoured below by mapping it to
// `hardBreak`, because a line typed on its own line is meant to stay there.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });

// ── markdown → ADF ─────────────────────────────────────────────────────────────

// Empty content for a blank string, because Jira reads a present-but-empty description as
// «clear it», and that is precisely what an empty description means.
export function adfDoc(markdown: string): AdfDoc {
  const content = blocks(md.parse(markdown.trim(), {}));
  return {
    type: "doc",
    version: 1,
    content: content.flatMap((node) => (node.type === "bulletList" ? splitTasks(node) : [node])),
  };
}

// Containers ADF refuses empty: an item or cell with nothing in it is an empty paragraph.
const NEEDS_CHILD: Record<string, true> = { listItem: true, tableHeader: true, tableCell: true, blockquote: true };

function blocks(tokens: Token[]): AdfNode[] {
  const root: AdfNode = { type: "doc", content: [] };
  const stack: AdfNode[] = [root];
  // Headings ADF allows only at the top level (and in cells); one nested in a list item or
  // a quote is written as a bold paragraph instead of earning a refusal for the whole body.
  const demoted = new Set<AdfNode>();
  const top = (): AdfNode => stack[stack.length - 1]!;
  const add = (node: AdfNode): void => {
    (top().content ??= []).push(node);
  };
  const open = (node: AdfNode): void => {
    add(node);
    stack.push(node);
  };
  for (const t of tokens) {
    switch (t.type) {
      case "heading_open":
        if (top() === root) open({ type: "heading", attrs: { level: Number(t.tag.slice(1)) }, content: [] });
        else {
          const p: AdfNode = { type: "paragraph", content: [] };
          demoted.add(p);
          open(p);
        }
        break;
      case "paragraph_open":
        open({ type: "paragraph", content: [] });
        break;
      case "bullet_list_open":
        open({ type: "bulletList", content: [] });
        break;
      case "ordered_list_open": {
        const start = Number(t.attrGet("start") ?? 1);
        open({ type: "orderedList", ...(start !== 1 ? { attrs: { order: start } } : {}), content: [] });
        break;
      }
      case "list_item_open":
        open({ type: "listItem", content: [] });
        break;
      case "blockquote_open":
        open({ type: "blockquote", content: [] });
        break;
      case "table_open":
        open({ type: "table", attrs: { isNumberColumnEnabled: false, layout: "default" }, content: [] });
        break;
      case "tr_open":
        open({ type: "tableRow", content: [] });
        break;
      case "th_open":
        open({ type: "tableHeader", attrs: {}, content: [] });
        break;
      case "td_open":
        open({ type: "tableCell", attrs: {}, content: [] });
        break;
      case "heading_close":
      case "paragraph_close":
      case "bullet_list_close":
      case "ordered_list_close":
      case "list_item_close":
      case "blockquote_close":
      case "table_close":
      case "tr_close":
      case "th_close":
      case "td_close": {
        const node = stack.pop()!;
        if (NEEDS_CHILD[node.type] && !node.content?.length) node.content = [{ type: "paragraph", content: [] }];
        break;
      }
      case "inline": {
        const parent = top();
        const nodes = inline(t.children ?? [], demoted.has(parent));
        // Table cells hold blocks, while markdown-it hands their text over bare.
        if (parent.type === "tableHeader" || parent.type === "tableCell") add({ type: "paragraph", content: nodes });
        else (parent.content ??= []).push(...nodes);
        break;
      }
      case "fence":
      case "code_block": {
        const language = t.info.trim().split(/\s+/)[0] ?? "";
        const text = t.content.replace(/\n$/, "");
        add({
          type: "codeBlock",
          ...(language ? { attrs: { language } } : {}),
          content: text ? [{ type: "text", text }] : [],
        });
        break;
      }
      case "hr":
        add({ type: "rule" });
        break;
      // thead/tbody carry no ADF node; html tokens cannot occur with `html: false`.
    }
  }
  return root.content ?? [];
}

function inline(tokens: Token[], bold: boolean): AdfNode[] {
  const out: AdfNode[] = [];
  const marks: AdfMark[] = bold ? [{ type: "strong" }] : [];
  const close = (type: string): void => {
    for (let i = marks.length - 1; i >= 0; i--)
      if (marks[i]!.type === type) {
        marks.splice(i, 1);
        return;
      }
  };
  const text = (value: string, own: AdfMark[]): void => {
    // ADF refuses an empty text node outright.
    if (!value) return;
    const prev = out[out.length - 1];
    // Adjacent runs with the same marks are one node — the shape Jira's editor writes, and
    // what the task-item check below reads its «[ ]» from.
    if (prev?.type === "text" && sameMarks(prev.marks, own)) {
      prev.text += value;
      return;
    }
    out.push(own.length ? { type: "text", text: value, marks: own.map((m) => ({ ...m })) } : { type: "text", text: value });
  };
  for (const t of tokens) {
    switch (t.type) {
      case "text":
        text(t.content, marks);
        break;
      case "softbreak":
      case "hardbreak":
        out.push({ type: "hardBreak" });
        break;
      case "strong_open":
        marks.push({ type: "strong" });
        break;
      case "em_open":
        marks.push({ type: "em" });
        break;
      case "s_open":
        marks.push({ type: "strike" });
        break;
      case "link_open":
        marks.push({ type: "link", attrs: { href: t.attrGet("href") ?? "" } });
        break;
      case "strong_close":
        close("strong");
        break;
      case "em_close":
        close("em");
        break;
      case "s_close":
        close("strike");
        break;
      case "link_close":
        close("link");
        break;
      // `code` combines with nothing but `link` in ADF, so the surrounding bold/italic is
      // dropped for the code span rather than failing the whole body.
      case "code_inline":
        text(t.content, [...marks.filter((m) => m.type === "link"), { type: "code" }]);
        break;
      // An inline image cannot be uploaded from a URL; its alt text links to it instead.
      case "image": {
        const src = t.attrGet("src") ?? "";
        text(t.content || src, src ? [{ type: "link", attrs: { href: src } }] : []);
        break;
      }
    }
  }
  while (out[out.length - 1]?.type === "hardBreak") out.pop();
  return out;
}

function sameMarks(a: AdfMark[] | undefined, b: AdfMark[]): boolean {
  const x = a ?? [];
  return x.length === b.length && x.every((m, i) => m.type === b[i]!.type && JSON.stringify(m.attrs) === JSON.stringify(b[i]!.attrs));
}

// «- [ ] …» / «- [x] …» — GitHub's task-list spelling, and the one renderTicketDescription
// writes acceptance criteria in — become Jira's action items (taskList/taskItem, the
// checkboxes its own editor inserts for «[]»).
//
// Only top-level lists are converted, and a task's nested lists only when they are task
// lists themselves: ADF has no taskList inside a listItem, and one invalid node costs the
// whole write. A mixed list splits into runs, each item keeping its own kind.
const TASK = /^\[([ xX])\](?:[ \t]+|$)/;

function splitTasks(list: AdfNode): AdfNode[] {
  const runs: AdfNode[] = [];
  for (const item of list.content ?? []) {
    const task = asTask(item);
    const kind = task ? "taskList" : "bulletList";
    let run = runs[runs.length - 1];
    if (run?.type !== kind) {
      run = task ? { type: "taskList", attrs: { localId: randomUUID() }, content: [] } : { type: "bulletList", content: [] };
      runs.push(run);
    }
    run.content!.push(...(task ?? [item]));
  }
  return runs;
}

// The taskItem plus any nested task lists, which ADF places as SIBLINGS of the item inside
// the parent taskList — or undefined when this list item is not a task.
function asTask(item: AdfNode): AdfNode[] | undefined {
  const [first, ...rest] = item.content ?? [];
  if (first?.type !== "paragraph") return undefined;
  const lead = first.content?.[0];
  if (lead?.type !== "text" || lead.marks?.length) return undefined;
  const m = TASK.exec(lead.text ?? "");
  if (!m) return undefined;
  const nested: AdfNode[] = [];
  for (const child of rest) {
    const sub = child.type === "bulletList" ? toTaskList(child) : undefined;
    if (!sub) return undefined;
    nested.push(sub);
  }
  const remainder = (lead.text ?? "").slice(m[0].length);
  const taskItem: AdfNode = {
    type: "taskItem",
    attrs: { localId: randomUUID(), state: m[1] === " " ? "TODO" : "DONE" },
    // A task item holds inline content directly, not a paragraph.
    content: [...(remainder ? [{ type: "text", text: remainder }] : []), ...(first.content ?? []).slice(1)],
  };
  return [taskItem, ...nested];
}

function toTaskList(list: AdfNode): AdfNode | undefined {
  const content: AdfNode[] = [];
  for (const item of list.content ?? []) {
    const task = asTask(item);
    if (!task) return undefined;
    content.push(...task);
  }
  return { type: "taskList", attrs: { localId: randomUUID() }, content };
}

// ── ADF → markdown ─────────────────────────────────────────────────────────────

// The same dialect adfDoc parses, so what this writes survives a save unchanged in
// structure. Text is not escaped: a description whose markdown once arrived in Jira as
// literal text (before this module existed) reads back as that markdown, and the next save
// turns it into the formatting it always meant. Media and other nodes markdown cannot
// carry are skipped; unknown containers contribute their children.
export function adfMarkdown(node: unknown): string {
  return isNode(node) ? block(node).trim() : "";
}

function isNode(v: unknown): v is AdfNode {
  return !!v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string";
}

function kids(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? node.content.filter(isNode) : [];
}

function blocksOf(nodes: AdfNode[], sep = "\n\n"): string {
  return nodes
    .map(block)
    .filter((s) => s !== "")
    .join(sep);
}

function block(node: AdfNode): string {
  const attrs = node.attrs ?? {};
  switch (node.type) {
    case "paragraph":
      return inlines(kids(node));
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(attrs.level) || 1));
      return `${"#".repeat(level)} ${inlines(kids(node))}`;
    }
    case "bulletList":
      return kids(node)
        .map((li) => item("- ", blocksOf(kids(li), "\n")))
        .join("\n");
    case "orderedList": {
      const start = Number(attrs.order) || 1;
      return kids(node)
        .map((li, i) => item(`${start + i}. `, blocksOf(kids(li), "\n")))
        .join("\n");
    }
    case "taskList":
      return kids(node)
        .map((child) =>
          child.type === "taskItem"
            ? item(`- [${child.attrs?.state === "DONE" ? "x" : " "}] `, inlines(kids(child)))
            : indent(block(child), "  "),
        )
        .join("\n");
    case "codeBlock": {
      const language = typeof attrs.language === "string" ? attrs.language : "";
      return `\`\`\`${language}\n${kids(node)
        .map((n) => n.text ?? "")
        .join("")}\n\`\`\``;
    }
    case "blockquote":
    case "panel":
      return blocksOf(kids(node))
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
    case "rule":
      return "---";
    case "table":
      return table(node);
    case "expand":
    case "nestedExpand": {
      const title = typeof attrs.title === "string" && attrs.title.trim() ? `**${attrs.title.trim()}**` : "";
      return [title, blocksOf(kids(node))].filter(Boolean).join("\n\n");
    }
    case "mediaSingle":
    case "mediaGroup":
    case "media":
      return "";
    default: {
      // An inline node at block level (a bare text run) reads as a paragraph; any other
      // container reads as its children.
      const children = kids(node);
      return children.some((c) => INLINE[c.type]) ? inlines(children) : blocksOf(children);
    }
  }
}

const INLINE: Record<string, true> = {
  text: true,
  hardBreak: true,
  mention: true,
  emoji: true,
  inlineCard: true,
  status: true,
  date: true,
};

// A list marker on the first line, the continuation lines indented under it.
function item(marker: string, body: string): string {
  return marker + indent(body, " ".repeat(marker.length)).slice(marker.length);
}

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((l) => (l ? pad + l : l))
    .join("\n");
}

function inlines(nodes: AdfNode[]): string {
  return nodes.map(inlineOf).join("");
}

function inlineOf(n: AdfNode): string {
  const attrs = n.attrs ?? {};
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  switch (n.type) {
    case "text":
      return marked(n.text ?? "", n.marks ?? []);
    case "hardBreak":
      return "\n";
    case "mention":
    case "status":
      return str(attrs.text);
    case "emoji":
      return str(attrs.text) || str(attrs.shortName);
    case "inlineCard":
      return str(attrs.url);
    case "date": {
      const d = new Date(Number(attrs.timestamp));
      return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
    }
    default:
      return inlines(kids(n));
  }
}

// Marks wrap the run innermost-first (code, em, strong, strike, link). Surrounding
// whitespace stays outside the delimiters: «** bold **» is not bold in markdown.
function marked(text: string, marks: AdfMark[]): string {
  if (!marks.length || !text.trim()) return text;
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  const has = (type: string): AdfMark | undefined => marks.find((m) => m.type === type);
  let out = core!;
  if (has("code")) {
    const fence = out.includes("`") ? "``" : "`";
    out = fence === "``" ? `\`\` ${out} \`\`` : `\`${out}\``;
  }
  if (has("em")) out = `*${out}*`;
  if (has("strong")) out = `**${out}**`;
  if (has("strike")) out = `~~${out}~~`;
  const link = has("link");
  const href = typeof link?.attrs?.href === "string" ? link.attrs.href : "";
  if (href) out = out === href ? href : `[${out}](${href})`;
  return lead + out + trail;
}

function table(node: AdfNode): string {
  const rows = kids(node).map((row) =>
    kids(row).map((cell) =>
      blocksOf(kids(cell), " ")
        .replace(/\n/g, " ")
        .replace(/\|/g, "\\|"),
    ),
  );
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  return [line(rows[0]!), line(Array.from({ length: width }, () => "---")), ...rows.slice(1).map(line)].join("\n");
}
