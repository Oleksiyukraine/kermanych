// apps/api/test/omp-usage.spec.ts
import { expect, test } from "vitest";
import { mapOmpUsage } from "../src/usage/omp-usage";

const AT = Date.UTC(2026, 7, 26, 12, 0, 0);
const RESET_5H = Date.UTC(2026, 7, 26, 16, 0, 0);
const RESET_7D = Date.UTC(2026, 7, 30, 12, 0, 0);

// The shape `omp usage --json` actually emits, trimmed to the fields the mapper reads.
function limit(
  windowId: string,
  usedFraction: number,
  extra: { durationMs?: number; resetsAt?: number; tier?: string; label?: string } = {},
): unknown {
  return {
    label: extra.label ?? `Claude ${windowId}`,
    scope: { provider: "anthropic", windowId, ...(extra.tier ? { tier: extra.tier } : {}) },
    window: {
      id: windowId,
      label: extra.label ?? windowId,
      durationMs: extra.durationMs ?? 18_000_000,
      ...(extra.resetsAt ? { resetsAt: extra.resetsAt } : {}),
    },
    amount: { used: usedFraction * 100, limit: 100, usedFraction, unit: "percent" },
  };
}

test("one account: shared windows in duration order, tiered buckets dropped", () => {
  const usage = mapOmpUsage(
    {
      reports: [
        {
          provider: "anthropic",
          limits: [
            limit("7d", 0.57, { durationMs: 604_800_000, resetsAt: RESET_7D, label: "7 Day" }),
            limit("7d", 0.99, { durationMs: 604_800_000, tier: "fable" }),
            limit("5h", 0, { resetsAt: RESET_5H, label: "5 Hour" }),
          ],
        },
      ],
    },
    AT,
  );

  expect(usage.fetchedAt).toBe(new Date(AT).toISOString());
  expect(usage.providers).toEqual([
    {
      provider: "anthropic",
      accounts: 1,
      windows: [
        { id: "5h", label: "5 Hour", usedPercent: 0, resetsAt: new Date(RESET_5H).toISOString() },
        { id: "7d", label: "7 Day", usedPercent: 57, resetsAt: new Date(RESET_7D).toISOString() },
      ],
    },
  ]);
});

// omp balances turns across every authenticated account of a provider, so the plan's spent
// capacity is their mean — the same figure `omp usage` prints as `capacity: … used`.
test("several accounts of one provider average into one figure at the nearest reset", () => {
  const usage = mapOmpUsage(
    {
      reports: [
        { provider: "anthropic", limits: [limit("5h", 0.8, { resetsAt: RESET_5H })] },
        { provider: "anthropic", limits: [limit("5h", 0.2, { resetsAt: RESET_5H - 3_600_000 })] },
      ],
    },
    AT,
  );

  expect(usage.providers).toEqual([
    {
      provider: "anthropic",
      accounts: 2,
      windows: [
        { id: "5h", label: "5h", usedPercent: 50, resetsAt: new Date(RESET_5H - 3_600_000).toISOString() },
      ],
    },
  ]);
});

// A provider that meters only per-model buckets still gets a figure: the fullest bucket is
// what will block the next turn.
test("with no shared bucket the fullest tiered one stands in", () => {
  const usage = mapOmpUsage({
    reports: [
      {
        provider: "openai",
        limits: [limit("7d", 0.3, { tier: "gpt" }), limit("7d", 0.71, { tier: "codex" })],
      },
    ],
  });

  expect(usage.providers[0]?.windows).toEqual([{ id: "7d", label: "7d", usedPercent: 71 }]);
});

// Everything the mapper cannot stand behind must vanish rather than read as 0% used.
test("junk, absent and out-of-range figures are dropped, not defaulted", () => {
  expect(mapOmpUsage(undefined).providers).toEqual([]);
  expect(mapOmpUsage({ reports: "nope" }).providers).toEqual([]);
  expect(mapOmpUsage({ reports: [{ provider: "anthropic" }] }).providers).toEqual([]);
  expect(
    mapOmpUsage({
      reports: [
        // An api-key account reports no limits at all: it is not capacity, so it must not
        // dilute the provider's average or its account count.
        { provider: "anthropic", limits: [] },
        {
          provider: "anthropic",
          limits: [
            { window: { id: "5h" }, amount: { usedFraction: "57%" } },
            { window: { id: "7d" }, amount: { usedFraction: 12 } },
            limit("30d", 0.42, { durationMs: 2_592_000_000 }),
          ],
        },
      ],
    }).providers,
  ).toEqual([{ provider: "anthropic", accounts: 1, windows: [{ id: "30d", label: "30d", usedPercent: 42 }] }]);
});

// Sub-percent spend is real spend; the UI decides how to word it, so the mapper keeps the
// tenth rather than rounding it to a zero.
test("a fraction of a percent survives as a tenth", () => {
  const usage = mapOmpUsage({ reports: [{ provider: "anthropic", limits: [limit("5h", 0.004)] }] });
  expect(usage.providers[0]?.windows[0]?.usedPercent).toBe(0.4);
});
