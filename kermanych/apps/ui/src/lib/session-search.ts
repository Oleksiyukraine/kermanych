// The Агенти board's session search, kept out of the .vue file so the one decision worth a
// test — WHAT a query matches — is covered. It narrows the rendered rows to those whose NAME
// or BRANCH contains the query, case-insensitively. Those two strings are exactly what a
// KSessionCard shows (`branch || title`), so matching anything else would surface rows whose
// reason for matching the operator cannot see. A blank or whitespace-only query is "no
// filter": the same array passes through untouched, which is what lets the field start empty
// without hiding every card, and keeps the computed's identity stable so an empty search
// never forces a re-render of the list.
import type { Session } from '@kermanych/core';

export function searchSessions(rows: Session[], query: string): Session[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (s) => s.name.toLowerCase().includes(q) || s.branch.toLowerCase().includes(q),
  );
}
