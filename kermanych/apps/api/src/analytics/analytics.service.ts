// apps/api/src/analytics/analytics.service.ts
// «Аналітика» (docs/specs/2026-11-07-developer-analytics.md): the writer of `activity_spans` and
// the one-time history import. Spans come off `supervisor.events$` like CloudSyncService's
// statuses — a pure subscriber, the supervisor never knows it exists (decision 5). Usage is
// recorded where the supervisor and NativeSessionService already read it; the import fills the
// ledger for the time before `ledger_started_at` from the harness files still on disk (decision 6).
import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { activitySpanKind, type ActivitySpanKind, type Session } from "@kermanych/core";
import type { Subscription } from "rxjs";
import { RegistryService, type UsageHourEntry } from "../registry/registry.service";
import { SupervisorService } from "../supervisor/supervisor.service";
import {
  FILE_USAGE_EVENTS,
  NativeSessionService,
  firstLineTimeWith,
  ledgerKeep,
  ompWorkingSpans,
  usageHourEntries,
} from "../native/native-session.service";

const DAY_MS = 86_400_000;
// Decision 5: ledger rows older than this go at start.
const PRUNE_DAYS = 400;

// What the import writes for one session.
export type ImportedHistory = { usage: UsageHourEntry[]; working: { startedAt: string; endedAt: string }[]; prOpenedAt?: string };

// One session file → its share of the ledger before `ledgerStartedAt`: usage per hour (a fork's
// inherited calls left out), omp's `working` spans clipped to the same window, and the moment a
// stored PR URL first appears, for a session whose `pr_opened_at` is still unknown.
export function importedHistory(s: Session, text: string, ledgerStartedAt: string): ImportedHistory {
  const harness = s.runtime ?? "omp";
  const usage = usageHourEntries(FILE_USAGE_EVENTS[harness](text), ledgerKeep(s, ledgerStartedAt, "import"), s.model);
  const working: ImportedHistory["working"] = [];
  if (harness === "omp") {
    const from = s.parentSessionId ? Date.parse(s.createdAt) : -Infinity;
    const to = Date.parse(ledgerStartedAt);
    for (const span of ompWorkingSpans(text)) {
      const start = Math.max(span.start, from);
      const end = Math.min(span.end, to);
      if (end > start) working.push({ startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString() });
    }
  }
  const prOpenedAt = s.prUrl && !s.prOpenedAt ? firstLineTimeWith(text, s.prUrl) : undefined;
  return { usage, working, ...(prOpenedAt ? { prOpenedAt } : {}) };
}

@Injectable()
export class AnalyticsService implements OnModuleInit, OnModuleDestroy {
  // The span each session has open right now. Memory only: after a crash the rows still open in
  // SQLite are closed at start (closeDanglingSpans), so nothing is carried over.
  private open = new Map<string, { id: string; kind: ActivitySpanKind }>();
  private sub?: Subscription;
  private importRun?: Promise<void>;

  constructor(
    private supervisor: SupervisorService,
    private registry: RegistryService,
    // Only its resolver of a row's harness file is used — the one the native reader uses.
    private native: NativeSessionService,
  ) {}

  // Order matters: the previous process's open spans close before this one opens any. The
  // ledger's start (`ledger_started_at`) was already written by the registry's first start with
  // this schema, before any live write could happen.
  onModuleInit(): void {
    const now = Date.now();
    this.registry.closeDanglingSpans(new Date(now).toISOString());
    this.registry.pruneAnalytics(new Date(now - PRUNE_DAYS * DAY_MS).toISOString());
    this.sub = this.supervisor.events$.subscribe((e) => {
      if (e.type === "session_update") this.onSession(e.session);
      else if (e.type === "session_removed") this.onRemoved(e.sessionId);
    });
    void this.runImport().catch((err: unknown) => console.warn(`[analytics] import failed: ${(err as Error).message}`));
  }

  // A clean shutdown closes every open span now, so a waiting agent does not keep «waiting»
  // across the time the app was closed.
  onModuleDestroy(): void {
    this.sub?.unsubscribe();
    const at = new Date().toISOString();
    for (const span of this.open.values()) this.registry.closeSpan(span.id, at);
    this.open.clear();
  }

  // A span opens when the coarse status enters its kind and closes when it leaves (decision 5);
  // `thinking` ↔ `tool` stay one `working` span.
  private onSession(s: Session): void {
    const kind = activitySpanKind(s.status);
    const cur = this.open.get(s.id);
    if (cur?.kind === kind) return;
    const at = new Date().toISOString();
    try {
      if (cur) {
        this.registry.closeSpan(cur.id, at);
        this.open.delete(s.id);
      }
      if (kind) this.open.set(s.id, { id: this.registry.openSpan(s.id, s.projectId, kind, at), kind });
    } catch (err) {
      // Never let a bookkeeping write break the event stream.
      console.warn(`[analytics] could not record a span of ${s.id}: ${(err as Error).message}`);
    }
  }

  private onRemoved(id: string): void {
    const cur = this.open.get(id);
    if (!cur) return;
    this.open.delete(id);
    this.registry.closeSpan(cur.id, new Date().toISOString());
  }

  // The one-time history import (decision 6). Once `done`, never again. One file at a time,
  // yielding to the event loop between files; each session's rows land in one transaction with
  // the progress counter, so a run cut short by a crash simply runs again from the top.
  runImport(): Promise<void> {
    this.importRun ??= this.doImport().finally(() => (this.importRun = undefined));
    return this.importRun;
  }

  private async doImport(): Promise<void> {
    const meta = this.registry.analyticsMeta();
    if (meta.import.state === "done") return;
    const started = performance.now();
    const jobs: { session: Session; path: string }[] = [];
    for (const session of this.registry.listSessions()) {
      const path = this.native.sessionFilePath(session);
      if (path && existsSync(path)) jobs.push({ session, path });
    }
    const total = jobs.length;
    this.registry.setAnalyticsImport({ state: "running", done: 0, total });
    let files = 0;
    let bytes = 0;
    for (const [i, { session, path }] of jobs.entries()) {
      await new Promise(setImmediate);
      const text = await readFile(path, "utf8").catch(() => undefined);
      if (text !== undefined) {
        files += 1;
        bytes += Buffer.byteLength(text);
      }
      const data = text === undefined ? { usage: [], working: [] } : importedHistory(session, text, meta.ledgerStartedAt);
      this.registry.applyImport(session.id, data, (session.runtime ?? "omp") === "omp", { state: "running", done: i + 1, total });
    }
    const ms = Math.round(performance.now() - started);
    this.registry.setAnalyticsImport({ state: "done", done: total, total }, { ms, files, bytes });
    // Decision 6 asks for this measurement: the spec's Verification records it.
    console.log(`[analytics] import: ${files} files, ${(bytes / 1_048_576).toFixed(1)} MB, ${ms} ms`);
  }
}
