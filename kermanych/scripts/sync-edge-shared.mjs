// scripts/sync-edge-shared.mjs
// The cloud routine runner (supabase/functions/routines-runner) is a Deno Edge Function, and an
// Edge Function can only import files under supabase/functions/. The pure modules it shares
// with the rest of the monorepo — the schedule math, the release-notes and report prompts, the
// Slack formatting — therefore live in their packages and are COPIED into
// supabase/functions/_shared/ by this script, each copy headed «GENERATED».
//
//   node scripts/sync-edge-shared.mjs        (from kermanych/) — rewrite every copy
//
// apps/api/test/edge-mirrors.spec.ts runs `mirrorText` against the sources and fails when a copy
// is stale, so editing a source without syncing breaks the test suite, not production.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// `rewrite`: [from, to] pairs applied to the source — only ever an import specifier, because
// Deno needs a relative path with its extension. `extract`: build the copy from named
// declarations of the source instead of the whole file (a module whose other half imports
// what Deno cannot have).
export const EDGE_MIRRORS = [
  { from: "packages/core/src/routine-schedule.ts", to: "supabase/functions/_shared/routine-schedule.ts" },
  { from: "apps/api/src/slack/slack-format.ts", to: "supabase/functions/_shared/slack-format.ts" },
  { from: "apps/api/src/routines/routine-report-prompt.ts", to: "supabase/functions/_shared/routine-report-prompt.ts" },
  {
    from: "apps/api/src/management/release-notes-prompt.ts",
    to: "supabase/functions/_shared/release-notes-prompt.ts",
    rewrite: [['from "@kermanych/core";', 'from "./release-notes-types.ts";']],
  },
  {
    from: "packages/core/src/release-notes.ts",
    to: "supabase/functions/_shared/release-notes-types.ts",
    extract: ["export type ReleaseCommit", "export const RELEASE_GROUPINGS", "export type ReleaseGrouping"],
  },
];

// The declaration starting at `start`, through the line that closes it (`;` at the end of a
// line at depth zero).
function declaration(source, start) {
  const at = source.indexOf(start);
  if (at < 0) throw new Error(`declaration «${start}» not found`);
  let depth = 0;
  for (let i = at; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (ch === ";" && depth === 0) return source.slice(at, i + 1);
  }
  throw new Error(`declaration «${start}» never closes`);
}

export function mirrorText(mirror, source) {
  let body;
  if (mirror.extract) {
    body = mirror.extract.map((start) => declaration(source, start)).join("\n\n") + "\n";
  } else {
    body = source;
    for (const [a, b] of mirror.rewrite ?? []) {
      if (!body.includes(a)) throw new Error(`${mirror.from}: «${a}» not found — update EDGE_MIRRORS`);
      body = body.replaceAll(a, b);
    }
  }
  const bare = /^import\s[^;]*?from\s+"(?!\.\/)[^"]*";/m.exec(body);
  if (bare) throw new Error(`${mirror.from}: Deno cannot resolve «${bare[0]}» — keep the module import-free or add a rewrite`);
  return `// GENERATED from kermanych/${mirror.from} by scripts/sync-edge-shared.mjs — do not edit.\n// Edit the source, then run \`node scripts/sync-edge-shared.mjs\` from kermanych/.\n${body}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const m of EDGE_MIRRORS) {
    writeFileSync(join(ROOT, m.to), mirrorText(m, readFileSync(join(ROOT, m.from), "utf8")));
    console.log(`${m.from} → ${m.to}`);
  }
}
