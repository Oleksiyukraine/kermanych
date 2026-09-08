// apps/ui/src/lib/home-todo.ts
// The home dashboard's To-do tile model, pure — the tasks-view.ts rule dashboard.ts already
// follows: the widget (components/home/HomeTodoWidget.vue) renders and mutates a list through
// these functions, and every decision worth a test (what survives a saved blob, what HTML is
// allowed back into the DOM, how a numbered run counts) lives here.
//
// localStorage, not the cloud, and the same per-workspace scope as the tile layout
// (dashboard.ts): a personal scratch list on one operator's overview is their view of the
// workspace, not workspace data — promoting it to a section with a Supabase table is a
// different feature.

export type TodoKind = 'check' | 'number';

export type TodoItem = {
  id: string;
  // How the row is marked: a checkbox that can be done, or a position in a numbered run.
  kind: TodoKind;
  // The row's text as sanitized inline HTML — sanitizeInline is the only producer.
  html: string;
  // Only a 'check' row can be done; mergeTodo forces it false on a 'number' row.
  done: boolean;
};

// Bounds a hand-edited blob cannot push past: a tile is a scratch list, not a database.
export const TODO_MAX_ITEMS = 200;
export const TODO_MAX_HTML = 4000;

// The inline vocabulary the editor itself produces (execCommand bold/italic/underline plus
// strikethrough, and <br> from paste). Everything else — attributes included — is dropped so
// a stored blob can never carry a handler, a style or a block element back into the tile.
const INLINE_TAGS: Record<string, true> = {
  b: true, strong: true, i: true, em: true, u: true, s: true, strike: true, br: true,
};
const TAG_RE = /^<(\/?)([a-zA-Z0-9]+)(?:\s[^<>]*)?\/?>/;

// Reduce arbitrary markup to the allowed inline tags, bare (no attributes). Disallowed tags
// vanish but keep their text; a stray `<` that opens no tag is escaped. Idempotent: running
// it over its own output changes nothing, so read and write paths can both call it.
export function sanitizeInline(html: string): string {
  const src = html.length > TODO_MAX_HTML ? html.slice(0, TODO_MAX_HTML) : html;
  let out = '';
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, lt);
    const m = TAG_RE.exec(src.slice(lt));
    if (!m) {
      out += '&lt;';
      i = lt + 1;
      continue;
    }
    const close = m[1] === '/';
    const name = m[2]!.toLowerCase();
    if (INLINE_TAGS[name]) {
      if (name === 'br') out += close ? '' : '<br>';
      else out += close ? `</${name}>` : `<${name}>`;
    }
    i = lt + m[0].length;
  }
  return out;
}

// The row's text with the inline formatting shed — what the management-chat digest sends,
// because a model handed `<b>тег</b>` quotes the tag back. Runs over sanitizeInline's output,
// so the only tags to shed are the allowed inline set and the only entities to decode are the
// ones that vocabulary can carry.
export function todoPlainText(html: string): string {
  return sanitizeInline(html)
    .replace(/<br>/g, ' ')
    .replace(/<\/?[a-z]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Plain text as a row's `html` — the chat executor's producer, the inverse of
// `todoPlainText`'s decode set. Escaping BEFORE `newTodoItem` sanitizes means text an
// assistant wrote can never smuggle a tag into the tile: «use <b> here» stays those five
// words, not bold formatting.
export function todoHtmlFromText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function newTodoItem(kind: TodoKind, html = ''): TodoItem {
  return { id: crypto.randomUUID(), kind, html: sanitizeInline(html), done: false };
}

// The display number of the item at `index`: its 1-based position inside the consecutive run
// of 'number' rows it sits in. A checklist row between two numbered rows restarts the count —
// the runs read as separate lists. Zero for a row that is not numbered.
export function numberOf(items: readonly TodoItem[], index: number): number {
  if (items[index]?.kind !== 'number') return 0;
  let n = 1;
  for (let i = index - 1; i >= 0 && items[i]!.kind === 'number'; i--) n++;
  return n;
}

// A saved blob, healed: rows keep their order, unknown kinds fall back to 'check', HTML is
// re-sanitized (the stored copy is not trusted — an operator can hand-edit localStorage),
// a missing id gets a fresh one, and the list is capped. Junk rows are dropped, never thrown.
export function mergeTodo(saved: unknown): TodoItem[] {
  const rows: readonly unknown[] = Array.isArray(saved) ? saved : [];
  const out: TodoItem[] = [];
  for (const r of rows) {
    if (out.length >= TODO_MAX_ITEMS) break;
    if (!r || typeof r !== 'object') continue;
    const x = r as Record<string, unknown>;
    if (typeof x.html !== 'string') continue;
    const kind: TodoKind = x.kind === 'number' ? 'number' : 'check';
    out.push({
      id: typeof x.id === 'string' && x.id !== '' ? x.id : crypto.randomUUID(),
      kind,
      html: sanitizeInline(x.html),
      done: kind === 'check' && x.done === true,
    });
  }
  return out;
}

export function todoStorageKey(workspaceId: string): string {
  return `mgmt-todo:${workspaceId}`;
}

export function readTodo(workspaceId: string): TodoItem[] {
  try {
    const raw = localStorage.getItem(todoStorageKey(workspaceId));
    return mergeTodo(raw ? (JSON.parse(raw) as unknown) : null);
  } catch {
    return [];
  }
}

export function writeTodo(workspaceId: string, items: readonly TodoItem[]): void {
  // mergeTodo on the way OUT too: the widget stores what contenteditable produced, and this
  // is the one funnel where it becomes the sanitized shape readTodo promises.
  try {
    localStorage.setItem(todoStorageKey(workspaceId), JSON.stringify(mergeTodo(items)));
  } catch {
    /* private mode: the list just does not stick */
  }
}
