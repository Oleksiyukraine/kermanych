// apps/ui/src/stores/home-todo.ts
// The To-do tile's list, as ONE reactive copy per workspace — shared by the two writers
// that must see each other's rows the moment they land:
//
//   1. HomeTodoWidget renders and edits it on the Home overview;
//   2. the management chat's `todo.create` executor (stores/management-chat.ts) appends to
//      it — the same rule «Дошка» follows: a row the assistant filed is on the screen
//      without a refetch, because both parties hold the same store.
//
// The store is a reactivity shell only: what a row IS, how HTML is sanitized and where the
// list persists (localStorage, per workspace) all live in lib/home-todo.ts.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  newTodoItem,
  readTodo,
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

  return { byWorkspace, listFor, persist, append };
});
