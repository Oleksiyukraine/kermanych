import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { RegistryService } from "./registry/registry.service";
import { seedDemo } from "./preview/seed";
import { setBrowserHost, type BrowserHost } from "./browser/browser-host";
import { setKeepAwake, type KeepAwake } from "./minion/keep-awake";
import { setScheduleTray, type ScheduleTrayListener } from "./schedules/schedule-tray";
import { setUiProof, uiProofFor } from "./auth/ui-proof";
import { ChildLedger, setChildLedger } from "./runtime/child-ledger";

export type {
  BrowserActionResult,
  BrowserConsoleEntry,
  BrowserDialogInfo,
  BrowserHost,
  BrowserNetworkEntry,
  BrowserPageInfo,
  BrowserTarget,
  BrowserViewport,
} from "./browser/browser-host";
export type { KeepAwake } from "./minion/keep-awake";
export type { ScheduleTrayListener } from "./schedules/schedule-tray";

// Build + start the Kermanych API. Exported so the Electron main process can host
// it in-process; still self-runs for standalone `node dist/main.js` / `pnpm dev:api`.
// `browser` is the desktop app's session browser (browser/browser-host.ts); without it no
// session gets the browser tools. `keepAwake` is its power-save blocker
// (minion/keep-awake.ts), held while a «Посіпака» run or a scheduled agent run is in progress;
// without it the machine sleeps as usual. `schedules` hears whether any scheduled task is enabled
// and the next firing (schedules/schedule-tray.ts) — at start and on every change — for the
// desktop app's menu-bar icon and background mode. `uiKey` is the desktop app's per-launch
// secret, also handed to its renderer: only a request carrying it (or the current bearer, or a
// trusted dev-ui Origin) may hand over a session (auth/ui-proof.ts).
export async function bootstrap(
  opts: { port?: number; browser?: BrowserHost; keepAwake?: KeepAwake; schedules?: ScheduleTrayListener; uiKey?: string } = {},
): Promise<{ app: INestApplication; url: string }> {
  setBrowserHost(opts.browser);
  setKeepAwake(opts.keepAwake);
  setScheduleTray(opts.schedules);
  setUiProof(uiProofFor(opts.uiKey, process.env.KERMANYCH_UI_ORIGINS));
  // Before Nest: the agents and previews a crashed predecessor left running are stopped first, so
  // the ports they held are free and nothing of theirs is mistaken for this api's. From here on
  // every omp child and preview step is written down until it exits (runtime/child-ledger.ts).
  const ledger = new ChildLedger();
  await ledger.open().catch((err: unknown) => console.warn(`[children] ledger unavailable: ${(err as Error).message}`));
  setChildLedger(ledger);
  // Images ride message/create payloads as base64 (omp caps each at 20 MiB),
  // so lift the body limit well past Express's 100 KB default.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.useBodyParser("json", { limit: "64mb" });
  app.useBodyParser("urlencoded", { extended: true, limit: "64mb" });
  app.enableCors({ origin: "*" });
  app.setGlobalPrefix("api", { exclude: [] });
  app.enableShutdownHooks();
  // Only a preview api sets KERMANYCH_SEED (the repository's .kermanych/preview.json); the real api never
  // does, so its registry is never touched. Idempotent on an already-populated DB.
  if (process.env.KERMANYCH_SEED) seedDemo(app.get(RegistryService));
  const port = opts.port ?? (Number(process.env.PORT) || 4317);
  await app.listen(port, "127.0.0.1");
  const url = `http://127.0.0.1:${port}`;
  console.log(`Kermanych API on ${url}`);
  return { app, url };
}

// The ids of the projects this machine's registry knows, for the desktop app's own sweep of the
// session-browser partitions (`persist:kermanych-browser-<projectId>`) that deleted projects left
// on disk. Undefined for an api on a custom KERMANYCH_DB (a preview api, a demo): it knows none
// of the real projects, and a sweep by it would wipe their logins.
export function knownProjectIds(app: INestApplication): Set<string> | undefined {
  if (process.env.KERMANYCH_DB) return undefined;
  return new Set(app.get(RegistryService).listProjects().map((p) => p.id));
}

if (require.main === module) void bootstrap();
