// «Синергія», decision 8 (docs/specs/2026-11-06-synergy.md): every request to a Синергія session
// carries the page the operator looks at and the elements they pointed at with ◎, whichever way
// it was sent — the composer, «Надіслати агенту» or the voice conversation. Pure, so the rule is
// pinned by a spec; `stores/orchestrator.ts` applies it in `sendMessage`, the one door all three
// pass through.
import { synergyMessage, type ImageInput } from '@kermanych/core';
import { composePicksMessage, picksImages, type TrayPick } from './browser-picks';

export type SynergyContext = {
  // The session browser's current URL; absent while no page is open.
  page?: string | undefined;
  // The picks tray and its general comment.
  picks: TrayPick[];
  note?: string | undefined;
};

// The operator's words stay the request (what the checkpoint names). «Надіслати агенту» sends no
// words of its own: then the tray's general comment is the request, and it is not repeated in
// the picks block. A Синергія session is always managed, so the crops go as images.
export function synergyOutgoing(
  text: string,
  images: readonly ImageInput[],
  ctx: SynergyContext,
): { text: string; images: ImageInput[] } {
  const typed = text.trim();
  const note = ctx.note?.trim() || undefined;
  const request = typed || note || '';
  const picks = ctx.picks.length
    ? composePicksMessage(ctx.picks, { native: false, comment: typed ? note : undefined })
    : undefined;
  return {
    text: synergyMessage(request, { page: ctx.page, picks }),
    images: [...images, ...picksImages(ctx.picks, { native: false })],
  };
}
