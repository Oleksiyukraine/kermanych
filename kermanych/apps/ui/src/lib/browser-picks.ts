// The message «Надіслати агенту» hands the session's agent: every element the operator pointed
// at in the session browser (docs/specs/2026-10-05-embedded-browser.md, «Picking»), with the
// operator's comments, as ONE text message — plus how the tray survives a renderer reload.
// Pure (the storage is passed in), so the template and the persistence fallbacks are pinned
// by a spec rather than by clicking through the app.
//
// The template is Ukrainian whatever the UI locale: it is a prompt for the agent, like the
// other machine-composed prompts Kermanych sends, not a UI string.
import type { ImageInput } from '@kermanych/core';

// One tray entry: what the picker returned plus what the operator typed next to it.
export type TrayPick = { id: string; pick: KermanychBrowserPick; comment: string };

// Every session's tray: the picks and the general comment typed above «Надіслати агенту».
export type PicksTray = { picks: Record<string, TrayPick[]>; notes: Record<string, string> };

// Text past this is noise for the agent; the picker already trims, this only caps.
const TEXT_MAX = 300;

// A fence longer than any backtick run inside the HTML, so an HTML snippet that itself
// contains ``` cannot close the block early (CommonMark: a fence closes only on a run at
// least as long as the opener).
function fenceFor(body: string): string {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function sourceLine(src: NonNullable<KermanychBrowserPick['source']>): string {
  const at = src.line != null ? `${src.file}:${src.line}` : src.file;
  return src.component ? `${src.component} — ${at}` : at;
}

// `native`: a native session gets the screenshots' file paths; a managed one gets the crops as
// attached images (picksImages) and the text says which. A tray restored after a storage quota
// error has lost the image bytes (only the temp-file path survived, see savePicksTray), so such
// a crop is named by its path for a managed session too — the agent can still open the file.
// `comment`: the operator's general comment over the whole tray, written first because it
// frames every element below it.
export function composePicksMessage(picks: TrayPick[], opts: { native: boolean; comment?: string | undefined }): string {
  const parts: string[] = [`Елементи, вказані на сторінці в браузері сесії (${picks.length}):`];
  const general = opts.comment?.trim();
  if (general) parts.unshift(`Загальний коментар: ${general}`);
  let image = 0;
  picks.forEach(({ pick, comment }, i) => {
    const lines: string[] = [`## Елемент ${i + 1}`];
    const note = comment.trim();
    if (note) lines.push(`Коментар: ${note}`);
    lines.push(`Сторінка: ${pick.url}`);
    if (pick.frame) lines.push(`Фрейм: ${pick.frame}`);
    lines.push(`Селектор: \`${pick.selector}\` (<${pick.tag.toLowerCase()}>)`);
    if (pick.source) lines.push(`Компонент: ${sourceLine(pick.source)}`);
    // Breakpoints and scroll position decide most layout bugs, so the agent gets the window
    // the operator saw and where in it the element sat (CSS pixels, viewport-relative).
    lines.push(`Вікно: ${pick.viewport.width}×${pick.viewport.height}, прокрутка ${pick.scroll.x},${pick.scroll.y}`);
    const r = pick.rect;
    lines.push(`Розташування: ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    const text = pick.text.replace(/\s+/g, ' ').trim();
    if (text) lines.push(`Текст: «${text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}…` : text}»`);
    const styles = Object.entries(pick.styles).map(([prop, value]) => `${prop}: ${value}`);
    if (styles.length) lines.push(`Стилі: ${styles.join('; ')}`);
    const html = pick.html.trim();
    if (html) {
      const fence = fenceFor(html);
      lines.push('HTML:', `${fence}html`, html, fence);
    }
    if (pick.screenshot) {
      if (!opts.native && pick.screenshot.data) {
        image += 1;
        lines.push(`Скриншот: зображення ${image} у вкладенні`);
      } else lines.push(`Скриншот: ${pick.screenshot.path}`);
    }
    parts.push(lines.join('\n'));
  });
  return parts.join('\n\n');
}

// The images that ride along with the message: the crops, in pick order, for a managed
// session; none for a native one (its harness accepts text only — the paths are in the text).
export function picksImages(picks: TrayPick[], opts: { native: boolean }): ImageInput[] {
  return picks.flatMap(({ pick }) =>
    pick.screenshot?.data && !opts.native ? [{ data: pick.screenshot.data, mimeType: pick.screenshot.mimeType }] : [],
  );
}

// ── Persistence ────────────────────────────────────────────────────────────
// sessionStorage, not localStorage: the tray is work in progress for this window — it has to
// survive a renderer reload (Cmd+R, a Vite HMR full reload), not an app restart, whose
// browsers start over anyway.
export const PICKS_STORAGE_KEY = 'kermanych.browser.picks';

// A few crops already run into megabytes of base64, and sessionStorage holds ~5 MB. On a
// quota error the image bytes go first (the temp-file path stays, and the message falls back
// to it); if even that does not fit, the tray stays in memory only. Never throws: the tray in
// memory is the source of truth and a failed save must not break adding a pick.
export function savePicksTray(storage: Storage, tray: PicksTray): void {
  const write = (value: PicksTray): boolean => {
    try {
      if (!Object.keys(value.picks).length && !Object.keys(value.notes).length) storage.removeItem(PICKS_STORAGE_KEY);
      else storage.setItem(PICKS_STORAGE_KEY, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  };
  if (write(tray)) return;
  const picks: PicksTray['picks'] = {};
  for (const [sessionId, list] of Object.entries(tray.picks)) {
    picks[sessionId] = list.map((p) =>
      p.pick.screenshot ? { ...p, pick: { ...p.pick, screenshot: { ...p.pick.screenshot, data: '' } } } : p,
    );
  }
  if (write({ picks, notes: tray.notes })) return;
  try {
    storage.removeItem(PICKS_STORAGE_KEY);
  } catch {
    // Storage unusable altogether: nothing to clean up.
  }
}

// A missing, unreadable or foreign value reads as an empty tray.
export function loadPicksTray(storage: Storage): PicksTray {
  const empty: PicksTray = { picks: {}, notes: {} };
  let raw: string | null;
  try {
    raw = storage.getItem(PICKS_STORAGE_KEY);
  } catch {
    return empty;
  }
  if (!raw) return empty;
  try {
    const value = JSON.parse(raw) as Partial<PicksTray> | null;
    if (!value || typeof value !== 'object') return empty;
    return {
      picks: value.picks && typeof value.picks === 'object' ? value.picks : {},
      notes: value.notes && typeof value.notes === 'object' ? value.notes : {},
    };
  } catch {
    return empty;
  }
}
