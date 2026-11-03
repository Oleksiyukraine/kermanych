import { DESIGN_SCREENS_DIR, designDirOf, designReadmePath, docsLayoutKind, type Platform } from '@kermanych/core';

// «Задача з документа» (components/docs/DocTaskDialog.vue): a document of a running session
// becomes a card. The rules that decide WHICH documents, WHERE the card goes and WHAT it carries
// live here, so the «Документація» tab, the Дизайн page and the dialog agree on them.

// A design folder's own README — the one document a design session is judged by — and not
// another Markdown file the folder happens to hold.
export function isDesignReadme(path: string): boolean {
  const dir = designDirOf(path);
  return !!dir && path === designReadmePath(dir);
}

// The documents «Задача →» is offered for: an API request or a handoff goes to the other side's
// project; a design README goes to whoever implements the screen
// (docs/specs/2026-10-29-design-tab.md, «From design to implementation»).
export function canTaskFromDoc(path: string): boolean {
  const kind = docsLayoutKind(path);
  return kind === 'api-request' || kind === 'handoff' || isDesignReadme(path);
}

// The card's platform, when the document decides it: an API request is backend work by
// definition, a design is a screen of the web app.
export function docTaskPlatform(path: string): Platform | undefined {
  if (docsLayoutKind(path) === 'api-request') return 'backend';
  if (isDesignReadme(path)) return 'web';
  return undefined;
}

// The title the dialog proposes: the document's first heading, else its file name without the
// date prefix — for a design README, whose file name says nothing, the folder's name.
export function docTaskTitle(path: string, content: string): string {
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
  if (heading) return heading;
  const named = isDesignReadme(path) ? designDirOf(path)! : path;
  return (named.split('/').pop() ?? named).replace(/\.[^.]+$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

// The projects the card may go to, in the order the picker lists them (the first is the
// default). A handoff or an API request is for the OTHER side, so the session's own project is
// not offered; a design is usually implemented where it was drawn, so its own project comes
// first and the rest of the workspace stays selectable.
export function docTaskTargets<P extends { id: string; workspaceId: string }>(
  projects: readonly P[],
  home: { id: string; workspaceId: string },
  path: string,
): P[] {
  const others = projects.filter((p) => p.workspaceId === home.workspaceId && p.id !== home.id);
  if (!isDesignReadme(path)) return others;
  const own = projects.find((p) => p.id === home.id);
  return own ? [own, ...others] : others;
}

// Where a design README's screenshots sit: `<designDir>/screens`. Undefined for any other
// document — only a design card carries images.
export function docTaskScreensDir(path: string): string | undefined {
  return isDesignReadme(path) ? `${designDirOf(path)!}/${DESIGN_SCREENS_DIR}` : undefined;
}
