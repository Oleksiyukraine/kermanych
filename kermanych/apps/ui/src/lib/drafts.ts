// apps/ui/src/lib/drafts.ts
// Unsent input, kept per target the way Slack keeps a draft per channel
// (docs/specs/2026-11-14-persist-input-drafts.md): an agent's composer, the «Нова задача» form of a
// project, a card being edited. What was typed survives switching to another agent, closing the
// form, leaving the screen and restarting the app, and comes back when the same target opens.
//
// Device-local, like the other screen state in lib/persisted.ts: one localStorage entry, never
// Supabase. Text only — an attached image is megabytes of base64, past what localStorage holds.
// Every storage access is guarded; a refused storage only means drafts last until the app restarts.
import { reactive, watch, type Ref } from 'vue';

/** A form's text fields by name; a single composer is `{ text }`. */
export type DraftFields = Record<string, string>;

/**
 * `fields` is what was typed; `base` is what the form opened with (the card's own title and
 * description, or blanks) — a draft is only ever the difference between the two.
 */
interface StoredDraft {
  fields: DraftFields;
  base: DraftFields;
  at: number;
}

const STORAGE_KEY = 'kermanych.drafts';
// An untouched draft is dropped after this long: the session or card it belonged to is most
// likely gone, and nothing else would ever clear it.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function load(): Record<string, StoredDraft> {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const cutoff = Date.now() - MAX_AGE_MS;
    const out: Record<string, StoredDraft> = {};
    for (const [key, d] of Object.entries(parsed as Record<string, Partial<StoredDraft>>)) {
      if (!d || typeof d.at !== 'number' || d.at < cutoff) continue;
      if (!isFields(d.fields) || !isFields(d.base)) continue;
      out[key] = { fields: d.fields, base: d.base, at: d.at };
    }
    return out;
  } catch {
    return {};
  }
}

function isFields(v: unknown): v is DraftFields {
  return !!v && typeof v === 'object' && Object.values(v).every((s) => typeof s === 'string');
}

const drafts = reactive<Record<string, StoredDraft>>(load());

function save(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // storage refused (quota, private mode): the draft still holds in memory
  }
}

function sameFields(a: DraftFields, b: DraftFields): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? '') !== (b[k] ?? '')) return false;
  return true;
}

/** Reactive: the target has unsent text — the ✎ mark on an agent's row reads it. */
export function hasDraft(key: string): boolean {
  return key in drafts;
}

/** The draft key of an agent session's composer. */
export function sessionDraftKey(sessionId: string): string {
  return `session:${sessionId}`;
}

/** The draft key of a new card in a project — shared by the board's editor and the launcher. */
export function newTaskDraftKey(projectId: string): string {
  return `task-new:${projectId}`;
}

/** The draft key of an existing card being edited. */
export function taskDraftKey(taskId: string): string {
  return `task:${taskId}`;
}

/**
 * Binds a form's text refs to a draft slot. `bind(key, base)` is called when the form opens on a
 * target, with `base` the text it opens with (omitted: the refs as they are now). The refs are set
 * to the target's stored draft, or to `base` when there is none — so a composer switched to
 * another agent never carries the previous agent's text over. From then on every edit is stored
 * under the key, and an edit back to `base` (sent, saved, erased) removes the draft. `bind(null)`
 * unbinds; `discard()` drops the draft and unbinds — after a save, whose later resets must not be
 * written back.
 *
 * Pass the text a form opens with as `base` rather than assigning the refs before bind(): the
 * refs are still bound to the previous target then, and the assignment would be stored as that
 * target's draft. A form that must fill them in steps (an async prefill) calls bind(null) first.
 *
 * A draft for a card is only restored over the text it was typed against: when the card itself
 * changed since (a teammate's edit), restoring would silently overwrite their text on the next
 * save, so the stale draft is dropped and the form opens on the card as it is now.
 */
export function useDraft(fields: Record<string, Ref<string>>): {
  bind: (key: string | null, base?: DraftFields) => void;
  discard: () => void;
} {
  let key: string | null = null;
  let base: DraftFields = {};

  function current(): DraftFields {
    const out: DraftFields = {};
    for (const [name, r] of Object.entries(fields)) out[name] = r.value;
    return out;
  }

  function bind(next: string | null, opened?: DraftFields): void {
    // Unbound while the refs are rewritten, so the watcher below stores none of it.
    key = null;
    base = opened ?? current();
    let apply = base;
    const stored = next ? drafts[next] : undefined;
    if (next && stored) {
      if (sameFields(stored.base, base)) {
        apply = stored.fields;
      } else {
        delete drafts[next];
        save();
      }
    }
    for (const [name, r] of Object.entries(fields)) {
      const v = apply[name];
      if (v !== undefined) r.value = v;
    }
    key = next;
  }

  function discard(): void {
    if (key && key in drafts) {
      delete drafts[key];
      save();
    }
    key = null;
  }

  // `flush: 'sync'`: a write lands under the key that was bound when it was typed — a deferred
  // watcher would run after the next bind() and file one target's text under another's key.
  watch(
    () => current(),
    (now) => {
      if (!key) return;
      if (sameFields(now, base)) {
        if (!(key in drafts)) return;
        delete drafts[key];
      } else {
        drafts[key] = { fields: now, base, at: Date.now() };
      }
      save();
    },
    { flush: 'sync' },
  );

  return { bind, discard };
}
