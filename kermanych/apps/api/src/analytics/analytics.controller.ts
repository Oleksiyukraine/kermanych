// apps/api/src/analytics/analytics.controller.ts
// «Аналітика» (docs/specs/2026-11-07-developer-analytics.md, decision 9): one endpoint, the
// aggregation in the api. The registry reads the ledger rows of the scope; core's pure
// `analyticsReport` turns them into what the page draws. Local-only: nothing here touches the cloud.
import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { ANALYTICS_PERIODS, ANALYTICS_PERIOD_DAYS, analyticsReport, isAnalyticsPeriod, type AnalyticsReport } from "@kermanych/core";
import { RegistryService } from "../registry/registry.service";

const DAY_MS = 86_400_000;
// A read slower than this is logged: the page re-reads every 60 s while visible.
const SLOW_MS = 200;

@Controller("analytics")
export class AnalyticsController {
  constructor(private registry: RegistryService) {}

  // `projectIds` absent = every project on this machine; present but empty = none (a workspace
  // with no project here), which reads as an empty report. `tz` absent = the machine's zone.
  @Get()
  report(@Query("period") period?: string, @Query("projectIds") projectIds?: string, @Query("tz") tz?: string): AnalyticsReport {
    if (!isAnalyticsPeriod(period)) throw new BadRequestException(`period must be one of ${ANALYTICS_PERIODS.join(", ")}, got ${JSON.stringify(period)}`);
    const timeZone = tz?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
    } catch {
      throw new BadRequestException(`unknown time zone ${JSON.stringify(tz)}`);
    }
    const started = performance.now();
    const now = new Date();
    const ids = projectIds === undefined ? undefined : projectIds.split(",").map((s) => s.trim()).filter(Boolean);
    // A bound safely before the previous period's first local midnight (two periods, plus slack
    // for the zone offset); the aggregation clips to the exact boundaries.
    const since = new Date(now.getTime() - (2 * ANALYTICS_PERIOD_DAYS[period] + 2) * DAY_MS).toISOString();
    const meta = this.registry.analyticsMeta();
    const report = analyticsReport({
      period,
      timeZone,
      now,
      ...this.registry.analyticsRows(ids, since, now.toISOString()),
      ledgerStartedAt: meta.ledgerStartedAt,
      import: meta.import,
    });
    const ms = Math.round(performance.now() - started);
    if (ms > SLOW_MS) console.log(`[analytics] report ${period} (${ids ? `${ids.length} projects` : "all projects"}) took ${ms} ms`);
    return report;
  }
}
