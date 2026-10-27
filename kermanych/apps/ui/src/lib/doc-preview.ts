import { ref, watch, type Ref } from 'vue';

// Which files the viewers (KDiffView, KFileView) can show rendered, not just as source.
// Judged by extension alone: the toggle has to appear before any body is fetched.
export type DocPreviewKind = 'markdown' | 'html' | 'pdf';

export function docPreviewKind(path: string): DocPreviewKind | null {
  const p = path.toLowerCase();
  // Not .mdx: its JSX is not Markdown, and the renderer would print it as stray text.
  if (/\.(?:md|markdown)$/.test(p)) return 'markdown';
  if (/\.html?$/.test(p)) return 'html';
  if (p.endsWith('.pdf')) return 'pdf';
  return null;
}

// The viewer's three modes (KViewModeToggle).
export type ViewMode = 'source' | 'split' | 'preview';
const VIEW_MODES: readonly ViewMode[] = ['source', 'split', 'preview'];

// Device-local screen preferences for the file viewers, like the locale (lib/locale.ts):
// localStorage, never Supabase. Every read and write is guarded — a refused storage (private
// mode, quota, vitest's node env) only means the choice lasts until the app restarts.
function persisted<T>(key: string, fallback: T, parse: (raw: string) => T | null, write: (v: T) => string): Ref<T> {
  let initial = fallback;
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    initial = (raw === null ? null : parse(raw)) ?? fallback;
  } catch {
    // unreadable storage: the fallback
  }
  const r = ref(initial) as Ref<T>;
  watch(r, (v) => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, write(v));
    } catch {
      // storage refused: kept in memory only
    }
  });
  return r;
}

/** The view mode last picked in either viewer (KDiffView, KFileView), shared across files. */
export const rememberedViewMode: Ref<ViewMode> = persisted<ViewMode>(
  'kermanych.fileView.mode',
  'source',
  (raw) => ((VIEW_MODES as readonly string[]).includes(raw) ? (raw as ViewMode) : null),
  (v) => v,
);

// The mode a newly opened file starts in: the remembered one, except that a PDF never opens
// on `source` — its source is bytes the viewer cannot show, so it opens rendered instead.
export function initialViewMode(kind: DocPreviewKind | null): ViewMode {
  const m = rememberedViewMode.value;
  return kind === 'pdf' && m === 'source' ? 'preview' : m;
}

/** KDiffView's ± choice: paired rows (true) or the whole current file. On by default. */
export const diffShown: Ref<boolean> = persisted<boolean>(
  'kermanych.diffView.showDiff',
  true,
  (raw) => raw !== '0',
  (on) => (on ? '1' : '0'),
);
