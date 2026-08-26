// apps/api/src/usage/omp-usage.ts
// `omp usage --json` → SubscriptionUsage. Pure, and deliberately paranoid: the payload comes
// from a separately-versioned binary on the user's PATH, so every field is treated as
// unknown. Anything unreadable is DROPPED rather than defaulted — a plan window the mapper
// cannot understand must vanish from the chip, never render as "0% used".
import type { ProviderUsage, SubscriptionUsage, UsageWindow } from "@kermanych/core";

type Raw = {
  reports?: unknown;
};

type RawReport = {
  provider?: unknown;
  limits?: unknown;
};

type RawLimit = {
  label?: unknown;
  scope?: { windowId?: unknown; tier?: unknown } | undefined;
  window?: { id?: unknown; label?: unknown; durationMs?: unknown; resetsAt?: unknown } | undefined;
  amount?: { used?: unknown; limit?: unknown; usedFraction?: unknown } | undefined;
};

// A window as it comes off one account, before accounts are folded together.
type Scoped = UsageWindow & { durationMs: number; tiered: boolean };

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

// Percent of the window's quota already spent, to one decimal. `usedFraction` is the
// provider-normalised figure; `used`/`limit` is the fallback for a provider that reports
// only raw counters. Out-of-range fractions are junk, not a 300%-used plan.
function usedPercent(a: RawLimit["amount"]): number | undefined {
  const f = num(a?.usedFraction);
  const used = num(a?.used);
  const limit = num(a?.limit);
  const raw = f ?? (used !== undefined && limit !== undefined && limit > 0 ? used / limit : undefined);
  if (raw === undefined || raw < 0 || raw > 1.5) return undefined;
  return Math.round(Math.min(raw, 1) * 1000) / 10;
}

function scoped(limit: RawLimit): Scoped | undefined {
  const id = str(limit.window?.id) ?? str(limit.scope?.windowId);
  const percent = usedPercent(limit.amount);
  if (id === undefined || percent === undefined) return undefined;
  const resetsAt = num(limit.window?.resetsAt);
  return {
    id,
    label: str(limit.window?.label) ?? str(limit.label) ?? id,
    usedPercent: percent,
    // A window with no reset instant (a monthly plan bucket, a tier omp cannot date) simply
    // has no countdown — the field stays absent instead of inventing "now".
    ...(resetsAt === undefined ? {} : { resetsAt: new Date(resetsAt).toISOString() }),
    // Sort key only; the wire shape carries no duration, the UI never needs one.
    durationMs: num(limit.window?.durationMs) ?? Number.MAX_SAFE_INTEGER,
    // Anthropic reports a shared 7d window AND per-model 7d sub-buckets (Opus, Fable…).
    // Both are real, but the chip shows one figure per window: the shared one, because it
    // is the limit every model spends against.
    tiered: str(limit.scope?.tier) !== undefined,
  };
}

// One account's windows, one entry per window id. The shared bucket wins; a provider that
// reports only tiered buckets falls back to the fullest of them — the binding constraint.
function accountWindows(limits: unknown): Scoped[] {
  const best = new Map<string, Scoped>();
  for (const raw of Array.isArray(limits) ? (limits as RawLimit[]) : []) {
    const w = scoped(raw ?? {});
    if (!w) continue;
    const prev = best.get(w.id);
    if (prev === undefined) best.set(w.id, w);
    else if (prev.tiered && (!w.tiered || w.usedPercent > prev.usedPercent)) best.set(w.id, w);
  }
  return [...best.values()];
}

export function mapOmpUsage(raw: unknown, at = Date.now()): SubscriptionUsage {
  const reports = Array.isArray((raw as Raw | null)?.reports) ? ((raw as Raw).reports as RawReport[]) : [];
  // provider -> window id -> the same window seen on each authenticated account.
  const byProvider = new Map<string, Map<string, Scoped[]>>();
  const accounts = new Map<string, number>();
  for (const report of reports) {
    const provider = str(report?.provider);
    if (provider === undefined) continue;
    const windows = accountWindows(report?.limits);
    // An account whose plan reports nothing (an api key, a provider without limits) is not
    // capacity — counting it would dilute every average with a phantom idle account.
    if (windows.length === 0) continue;
    accounts.set(provider, (accounts.get(provider) ?? 0) + 1);
    const perWindow = byProvider.get(provider) ?? new Map<string, Scoped[]>();
    byProvider.set(provider, perWindow);
    for (const w of windows) perWindow.set(w.id, [...(perWindow.get(w.id) ?? []), w]);
  }

  const providers: ProviderUsage[] = [];
  for (const [provider, perWindow] of byProvider) {
    const total = accounts.get(provider) ?? 0;
    const windows = [...perWindow.values()]
      .sort((a, b) => a[0]!.durationMs - b[0]!.durationMs)
      .map((seen): UsageWindow => {
        // Mean over the accounts that reported this window — omp spreads turns across them,
        // so "0.57 of one account used" is what fraction of the plan's capacity is gone.
        const mean = seen.reduce((s, w) => s + w.usedPercent, 0) / seen.length;
        // The nearest reset is the one that changes the figure next.
        const resets = seen.map((w) => w.resetsAt).filter((r): r is string => r !== undefined).sort();
        return {
          id: seen[0]!.id,
          label: seen[0]!.label,
          usedPercent: Math.round(mean * 10) / 10,
          ...(resets[0] === undefined ? {} : { resetsAt: resets[0] }),
        };
      });
    providers.push({ provider, accounts: total, windows });
  }

  return { fetchedAt: new Date(at).toISOString(), providers };
}
