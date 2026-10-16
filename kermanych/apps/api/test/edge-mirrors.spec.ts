// apps/api/test/edge-mirrors.spec.ts
// The cloud routine runner (supabase/functions/routines-runner) runs copies of modules that
// live in the monorepo's packages — the schedule math, the prompts, the Slack formatting
// (scripts/sync-edge-shared.mjs says why). A copy that lags its source is the cloud running
// routines by different rules than the screen describes; this fails until it is synced.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs script, no declarations
import { EDGE_MIRRORS, ROOT, mirrorText } from "../../../scripts/sync-edge-shared.mjs";

type Mirror = { from: string; to: string };

describe("supabase/functions/_shared copies", () => {
  it.each((EDGE_MIRRORS as Mirror[]).map((m) => [m.to, m] as const))("%s is in sync with its source", (_to, m) => {
    const expected = mirrorText(m, readFileSync(join(ROOT, m.from), "utf8"));
    const actual = readFileSync(join(ROOT, m.to), "utf8");
    expect(actual, "run `node scripts/sync-edge-shared.mjs` from kermanych/").toBe(expected);
  });
});
