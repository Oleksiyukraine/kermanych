// GENERATED from kermanych/packages/core/src/release-notes.ts by scripts/sync-edge-shared.mjs — do not edit.
// Edit the source, then run `node scripts/sync-edge-shared.mjs` from kermanych/.
export type ReleaseCommit = {
  // Commit date, YYYY-MM-DD.
  date: string;
  author: string;
  subject: string;
  body: string;
};

export const RELEASE_GROUPINGS = ["topic", "person"] as const;

export type ReleaseGrouping = (typeof RELEASE_GROUPINGS)[number];
