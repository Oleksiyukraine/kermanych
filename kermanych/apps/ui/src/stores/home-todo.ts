// apps/ui/src/stores/home-todo.ts
// The Action List tile's list, as ONE reactive copy per workspace — shared by the two writers
// that must see each other's rows the moment they land:
//
//   1. HomeTodoWidget renders and edits it on the Home overview;
//   2. the management chat's todo.create / todo.update / todo.delete executor
//      (stores/management-chat.ts) appends, changes and removes rows through it — the same
//      rule «Дошка» follows: a row the assistant filed is on the screen without a refetch,
//      because both parties hold the same store.
//
// The store is a reactivity shell only: what a row IS, how HTML is sanitized and where the
// list persists (localStorage, per workspace) all live in lib/home-todo.ts.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  newTodoItem,
  readTodo,
  sanitizeInline,
  todoHtmlFromText,
  writeTodo,
  type TodoItem,
  type TodoKind,
} from '../lib/home-todo';

export const useHomeTodo = defineStore('home-todo', () => {
  const byWorkspace = ref<Record<string, TodoItem[]>>({});

  // The workspace's list, read from localStorage exactly once — after that the reactive
  // copy is the truth and localStorage is only its shadow (see persist).
  function listFor(workspaceId: string): TodoItem[] {
    return (byWorkspace.value[workspaceId] ??= readTodo(workspaceId));
  }

  function persist(workspaceId: string): void {
    writeTodo(workspaceId, byWorkspace.value[workspaceId] ?? []);
  }

  // The `todo.create` executor's whole write: plain text in, escaped and sanitized rows
  // appended, persisted at once — there is no pointerup or blur here to debounce behind.
  // Returns the minted rows so the caller can say what landed.
  function append(workspaceId: string, rows: readonly { text: string; kind: TodoKind }[]): TodoItem[] {
    const list = listFor(workspaceId);
    const made = rows.map((r) => newTodoItem(r.kind, todoHtmlFromText(r.text)));
    list.push(...made);
    persist(workspaceId);
    return made;
  }

  // The todo.update executor's write, addressed by the 1-based position the digest prints
  // (`#N`). Returns the row as it now stands, or null when the position names none — the
  // caller then says so rather than reporting a change that never happened. A text change
  // mints a FRESH row identity so HomeTodoWidget, which hydrates each contenteditable exactly
  // once and then leaves it to the browser, re-renders it: reusing the id would persist the
  // new html but leave the stale text on screen until a reload. Marker and done-mark are
  // mutated in place — Vue's bindings already track them — and a numbered row cannot be
  // «done», the same rule the tile enforces.
  function updateAt(workspaceId: string, index: number, patch: { text?: string; kind?: TodoKind; done?: boolean }): TodoItem | null {
    const list = listFor(workspaceId);
    const cur = list[index - 1];
    if (!cur) return null;
    if (patch.text !== undefined) {
      const kind = patch.kind ?? cur.kind;
      const done = kind === 'number' ? false : patch.done ?? cur.done;
      const next: TodoItem = { id: crypto.randomUUID(), kind, html: sanitizeInline(todoHtmlFromText(patch.text)), done };
      list.splice(index - 1, 1, next);
      persist(workspaceId);
      return next;
    }
    if (patch.kind !== undefined) {
      cur.kind = patch.kind;
      if (patch.kind === 'number') cur.done = false;
    }
    if (patch.done !== undefined && cur.kind !== 'number') cur.done = patch.done;
    persist(workspaceId);
    return cur;
  }

  // The todo.delete executor's write, addressed the same way. Returns the removed row so the
  // caller can quote what went, or null when the position named none.
  function removeAt(workspaceId: string, index: number): TodoItem | null {
    const list = listFor(workspaceId);
    const [removed] = list.splice(index - 1, 1);
    if (!removed) return null;
    persist(workspaceId);
    return removed;
  }

  return { byWorkspace, listFor, persist, append, updateAt, removeAt };
});
