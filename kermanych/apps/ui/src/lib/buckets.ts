// apps/ui/src/lib/buckets.ts
// The «Агенти» tabs. Which tab a session belongs to — `bucketOf`, with the `Bucket` type — is
// one rule for every reader and lives in @kermanych/core (packages/core/src/buckets.ts): the api
// of «Пульт» lists the same sessions as the sidebar (docs/specs/2026-11-24-mobile-remote-control.md).
// What stays here is the ui's own: the tab order and reading a stored bucket.
import type { Bucket } from '@kermanych/core';

// The tabs, in the order they are drawn.
export const BUCKETS: readonly Bucket[] = ['agents', 'completed', 'tasks'];

// A stored bucket from before the merge — `kermanych.selection`, the map's chips — read as
// today's. The three retired names all mean «an agent exists», so they all become `agents`;
// anything else unknown reads as nothing.
const RETIRED: Readonly<Record<string, Bucket>> = { active: 'agents', waiting: 'agents', errors: 'agents' };
export function readBucket(raw: unknown): Bucket | undefined {
  if (typeof raw !== 'string') return undefined;
  // Own keys only: the raw value comes from storage, and `toString` must not resolve.
  return BUCKETS.find((b) => b === raw) ?? (Object.hasOwn(RETIRED, raw) ? RETIRED[raw] : undefined);
}
