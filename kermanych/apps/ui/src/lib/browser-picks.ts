// The message «Надіслати агенту» hands the session's agent: every element the operator pointed
// at in the session browser (docs/specs/2026-10-05-embedded-browser.md, «Picking»), with the
// operator's comment, as ONE text message. Pure, so the template is pinned by a spec rather
// than by clicking through the app.
//
// The template is Ukrainian whatever the UI locale: it is a prompt for the agent, like the
// other machine-composed prompts Kermanych sends, not a UI string.
import type { ImageInput } from '@kermanych/core';

// One tray entry: what the picker returned plus what the operator typed next to it.
export type TrayPick = { id: string; pick: KermanychBrowserPick; comment: string };

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

// `native`: a native session runs a text-only TUI, so it gets the screenshot's file path; a
// managed one gets the crops as attached images (picksImages) and the text says which.
export function composePicksMessage(picks: TrayPick[], opts: { native: boolean }): string {
  const parts: string[] = [`Елементи, вказані на сторінці в браузері сесії (${picks.length}):`];
  let image = 0;
  picks.forEach(({ pick, comment }, i) => {
    const lines: string[] = [`## Елемент ${i + 1}`];
    const note = comment.trim();
    if (note) lines.push(`Коментар: ${note}`);
    lines.push(`Сторінка: ${pick.url}`);
    lines.push(`Селектор: \`${pick.selector}\` (<${pick.tag.toLowerCase()}>)`);
    if (pick.source) lines.push(`Компонент: ${sourceLine(pick.source)}`);
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
      image += 1;
      lines.push(opts.native ? `Скриншот: ${pick.screenshot.path}` : `Скриншот: зображення ${image} у вкладенні`);
    }
    parts.push(lines.join('\n'));
  });
  return parts.join('\n\n');
}

// The images that ride along with the message: the crops, in pick order, for a managed
// session; none for a native one (its harness accepts text only — the paths are in the text).
export function picksImages(picks: TrayPick[], opts: { native: boolean }): ImageInput[] {
  if (opts.native) return [];
  return picks.flatMap(({ pick }) =>
    pick.screenshot ? [{ data: pick.screenshot.data, mimeType: pick.screenshot.mimeType }] : [],
  );
}
