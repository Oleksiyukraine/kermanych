import type { Ref } from 'vue';
import { persisted } from './persisted';

// Which files the viewers (KDiffView, KFileView) can show rendered, not just as source.
// Judged by extension alone: the toggle has to appear before any body is fetched. `svg` is a
// picture with a text source; `image` is a raster one, whose source is bytes.
export type DocPreviewKind = 'markdown' | 'html' | 'pdf' | 'svg' | 'image';

export function docPreviewKind(path: string): DocPreviewKind | null {
  const p = path.toLowerCase();
  // Not .mdx: its JSX is not Markdown, and the renderer would print it as stray text.
  if (/\.(?:md|markdown)$/.test(p)) return 'markdown';
  if (/\.html?$/.test(p)) return 'html';
  if (p.endsWith('.pdf')) return 'pdf';
  if (p.endsWith('.svg')) return 'svg';
  if (/\.(?:png|jpe?g|gif|webp|avif|bmp|ico)$/.test(p)) return 'image';
  return null;
}

// The viewer's three modes (KViewModeToggle).
export type ViewMode = 'source' | 'split' | 'preview';
const VIEW_MODES: readonly ViewMode[] = ['source', 'split', 'preview'];

/** The view mode last picked in either viewer (KDiffView, KFileView), shared across files. */
export const rememberedViewMode: Ref<ViewMode> = persisted<ViewMode>(
  'kermanych.fileView.mode',
  'source',
  (raw) => ((VIEW_MODES as readonly string[]).includes(raw) ? (raw as ViewMode) : null),
  (v) => v,
);

// The mode a newly opened file starts in: the remembered one, except that a PDF or a raster
// image never opens on `source` — its source is bytes the viewer cannot show, so it opens
// rendered instead. `rendered` (the docs page, where files are there to be read) extends that
// to every previewable file; a pick there still holds for the file it was made on.
export function initialViewMode(kind: DocPreviewKind | null, rendered = false): ViewMode {
  const m = rememberedViewMode.value;
  if (m !== 'source' || !kind) return m;
  return rendered || kind === 'pdf' || kind === 'image' ? 'preview' : m;
}

/** KDiffView's ± choice: paired rows (true) or the whole current file. On by default. */
export const diffShown: Ref<boolean> = persisted<boolean>(
  'kermanych.diffView.showDiff',
  true,
  (raw) => raw !== '0',
  (on) => (on ? '1' : '0'),
);
