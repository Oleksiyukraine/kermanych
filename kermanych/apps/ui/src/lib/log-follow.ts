// Whether a live log keeps following its newest entry (KPanel). The log is pinned to the
// bottom while the operator is there; scrolling up to read stops the follow until they come
// back down.
//
// Only the operator's own scrolling may stop the follow. A scroll the layout causes — the
// browser clamping `scrollTop` when the log grows taller or a block above collapses, or
// scroll anchoring — never does, or a turn would stop following on its own. And an upward
// scroll by the operator stops it at ANY distance from the bottom: a trackpad scrolls a few
// pixels per event, so a distance threshold alone never let them out while the agent was
// streaming — every new row pulled the log back down before they got past it.

/** How close to the bottom still counts as "at the bottom", in px. */
export const FOLLOW_SLACK_PX = 40;

export interface LogScroll {
  /** Following before this scroll event. */
  follow: boolean;
  /** `scrollTop` at the previous scroll event. */
  prevTop: number;
  /** `scrollTop` now. */
  top: number;
  /** Distance from the viewport's bottom edge to the end of the content, in px. */
  gap: number;
  /** The operator is scrolling right now (wheel, touch, keys, scrollbar drag). */
  byUser: boolean;
}

/** Following after a scroll event on the log. */
export function followAfterScroll(s: LogScroll): boolean {
  if (s.byUser && s.top < s.prevTop - 1 && s.gap > 1) return false;
  if (s.gap < FOLLOW_SLACK_PX) return true;
  return s.byUser ? false : s.follow;
}
