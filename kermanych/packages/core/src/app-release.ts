// Desktop releases: version comparison and the CHANGELOG.md format
// (spec: docs/specs/2026-10-12-desktop-releases-and-updates.md).
//
// Versions are plain semver `MAJOR.MINOR.PATCH`: the release tags, apps/ui/package.json, the
// update feed and the cloud's `min_app_version` all use that form. Anything else is "not a
// version" and every helper here treats it as unknown rather than guessing an order.

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function isAppVersion(v: string): boolean {
  return VERSION_RE.test(v);
}

function parts(v: string): [number, number, number] | undefined {
  const m = VERSION_RE.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

// -1 / 0 / 1 like a sort comparator; undefined when either side is not a version.
export function compareAppVersions(a: string, b: string): -1 | 0 | 1 | undefined {
  const pa = parts(a);
  const pb = parts(b);
  if (!pa || !pb) return undefined;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! < pb[i]! ? -1 : 1;
  }
  return 0;
}

// Whether the running app is older than the cloud's minimum. An unreadable policy (offline,
// no row, a malformed value) never locks anyone out: local work does not wait for the cloud.
export function isBelowMinimumVersion(current: string, minimum: string | null | undefined): boolean {
  if (minimum == null) return false;
  return compareAppVersions(current, minimum) === -1;
}

export type ChangelogEntry = {
  version: string;
  // The heading text after the version, e.g. `2026-10-12` from `## 0.1.0 — 2026-10-12`.
  date: string;
  // The section's markdown below its heading, trimmed; '' for an empty section.
  body: string;
};

// `## <version>` optionally followed by a separator and a date. Only level-2 headings that
// start with a version open an entry; any other level-1/level-2 heading closes the open one.
const ENTRY_RE = /^##[ \t]+(\d+\.\d+\.\d+)(?:[ \t]+[—–-][ \t]+(.*?))?[ \t]*$/;
const SECTION_END_RE = /^#{1,2}[ \t]/;
const FENCE_RE = /^[ \t]{0,3}(```|~~~)/;

// Every version section of a CHANGELOG.md, in file order (newest first by convention).
export function changelogEntries(markdown: string): ChangelogEntry[] {
  const out: ChangelogEntry[] = [];
  let open: { version: string; date: string; lines: string[] } | undefined;
  let fence: string | undefined;
  const close = () => {
    if (open) out.push({ version: open.version, date: open.date, body: open.lines.join("\n").trim() });
    open = undefined;
  };
  for (const line of markdown.split(/\r?\n/)) {
    const f = FENCE_RE.exec(line);
    if (f) {
      // A heading-looking line inside a code block is code, not a section boundary.
      if (fence === undefined) fence = f[1];
      else if (f[1] === fence) fence = undefined;
    }
    if (fence === undefined && !f) {
      const m = ENTRY_RE.exec(line);
      if (m) {
        close();
        open = { version: m[1]!, date: (m[2] ?? "").trim(), lines: [] };
        continue;
      }
      if (SECTION_END_RE.test(line)) {
        close();
        continue;
      }
    }
    open?.lines.push(line);
  }
  close();
  return out;
}

// The section of one version; undefined when the file has none.
export function changelogSection(markdown: string, version: string): ChangelogEntry | undefined {
  return changelogEntries(markdown).find((e) => e.version === version);
}

// The sections a user moving from `after` to `upTo` has not seen: after < version <= upTo,
// newest first. An unparseable `after` yields only `upTo`'s own section.
export function changelogBetween(markdown: string, after: string, upTo: string): ChangelogEntry[] {
  const known = isAppVersion(after);
  return changelogEntries(markdown)
    .filter((e) => compareAppVersions(e.version, upTo) !== 1)
    .filter((e) => (known ? compareAppVersions(e.version, after) === 1 : e.version === upTo))
    .sort((a, b) => compareAppVersions(b.version, a.version) ?? 0);
}
