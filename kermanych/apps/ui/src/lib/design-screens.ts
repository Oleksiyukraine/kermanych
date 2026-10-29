import { DESIGN_SCREENS_DIR, designScreenshots } from '@kermanych/core';
import { api } from './api';

// A design folder's saved screenshots (docs/specs/2026-10-29-design-tab.md), read from the
// session's worktree: `screens/` through the session tree, then each PNG's bytes through the raw
// endpoint, widest first (core designScreenshots). The folder must exist (callers read its README
// first); `screens/` may not — a design not saved yet has none, which is «none yet», not a
// failure, so the folder is listed first. Used by «Задача →» (the card's images) and by the
// Дизайн page's folder view.
export async function readDesignScreens(sessionId: string, designDir: string): Promise<{ path: string; file: File }[]> {
  const dir = `${designDir}/${DESIGN_SCREENS_DIR}`;
  const parent = await api.sessionTree(sessionId, designDir);
  const entries = parent.some((e) => e.type === 'dir' && e.name === DESIGN_SCREENS_DIR) ? await api.sessionTree(sessionId, dir) : [];
  const paths = designScreenshots(
    designDir,
    entries.filter((e) => e.type === 'file').map((e) => `${dir}/${e.name}`),
  );
  const blobs = await Promise.all(paths.map((p) => api.sessionRaw(sessionId, p)));
  return paths.map((p, i) => ({ path: p, file: new File([blobs[i]!], p.split('/').pop() ?? p, { type: 'image/png' }) }));
}
