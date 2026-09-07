// Documentation a session touched — derived data the «Документація» tab reads, the same
// pure-and-testable shape as skillsUsed. No fs, no cloud, no omp process knowledge: the UI
// feeds it the transcript (for docs READ) and filters the Зміни listing with isDocPath (for
// docs CREATED / UPDATED).

import type { TranscriptEntry } from "./types";

// A path is documentation when it is a markup-family file, one of the conventional
// extension-less doc files (README, LICENSE, …), or sits directly under a docs/ (or doc/)
// directory. The check runs on paths an agent NAMES — a `read` target shortened to its last
// segments, or a full repo-relative path from `git diff` — so it decides from the tail alone
// and tolerates a trailing `:from-to` read range. `.txt` is deliberately excluded: it is as
// often data as prose, and the conventional-name rule still catches README.txt and friends.
const DOC_EXT_RE = /\.(?:md|mdx|mdc|markdown|rst|adoc|asciidoc)$/i;
const DOC_NAME_RE = /^(?:README|CHANGELOG|CHANGES|CONTRIBUTING|LICEN[CS]E|NOTICE|AUTHORS|TODO)(?:[.\-_]|$)/i;
const DOC_DIR_RE = /(?:^|\/)docs?\//i;

export function isDocPath(path: string): boolean {
  if (!path) return false;
  // A read target can carry a `:from-to`/`:raw` selector, and a URL-ish path a query/hash;
  // judge the bare path. Repo paths here are POSIX and never contain a colon of their own.
  const clean = path.split(/[?#]/, 1)[0]!.split(":", 1)[0]!;
  if (!clean) return false;
  const base = clean.slice(clean.lastIndexOf("/") + 1);
  return DOC_EXT_RE.test(base) || DOC_NAME_RE.test(base) || DOC_DIR_RE.test(clean);
}

// Which documentation files a session READ, in order of first read, de-duplicated. Mirrors
// skillsUsed: a `read` tool row's target is the path, so the tab needs no state of its own.
// The `:from-to` range is stripped so two ranged reads of one doc collapse to one entry, and
// only the `read` tool counts — an `edit`/`write` is a change, surfaced by the Зміни listing.
export function docsRead(entries: readonly TranscriptEntry[]): string[] {
  const seen: string[] = [];
  for (const e of entries) {
    if (e.kind !== "tool" || e.tool !== "read" || !e.target || !isDocPath(e.target)) continue;
    const path = e.target.split(":", 1)[0]!;
    if (path && !seen.includes(path)) seen.push(path);
  }
  return seen;
}
