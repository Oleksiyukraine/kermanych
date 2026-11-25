// apps/api/src/remote/remote.service.ts
// «Пульт» (docs/specs/2026-11-24-mobile-remote-control.md): the operator's phone watches and steers
// this computer's agents through the operator's Tailscale tailnet. This service owns all of it on
// the api side:
//   - RemoteState — the switch, the Tailscale checks, the serve phase, the paired phones — read by
//     «Налаштування → Застосунок → Пульт» and the bottom-bar mark (decision 7) through
//     RemoteController and every change published as `remote_update` on supervisor.events$;
//   - the lifecycle (decision 6): on → find the CLI, check the tailnet, start the RemoteServer on
//     127.0.0.1, `tailscale serve` our own HTTPS port to it; off → the rule removed, the server
//     stopped, the phones' sockets closed (the phones stay paired); a crash's leftover rule of ours
//     removed at the next start while off;
//   - pairing and devices (decision 5), through RemotePhone and Pairings;
//   - the live feed to the phones (RemoteFeed), Web Push on a question or a failure while the
//     operator is away (decision 4, presence.ts), and the `remote` keep-awake holder while an
//     agent works or waits (decision 9);
//   - decision 10's Linux operator step.
//
// A preview api (KERMANYCH_PREVIEW=1) never changes the computer's Tailscale config: it reads the
// checks and reports «blocked» with the reason.
import { Inject, Injectable, Optional, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { Subscription } from "rxjs";
import { dirname, join } from "node:path";
import { toString as qrToString } from "qrcode";
import { generateVAPIDKeys, sendNotification, type RequestOptions } from "web-push";
import {
  ACTIVE_STATUSES,
  REMOTE_DEVICE_IDLE_MS,
  remotePushKind,
  type RemoteDevice,
  type RemotePairing,
  type RemotePhase,
  type RemotePush,
  type RemotePushSubscription,
  type RemoteState,
  type RemoteTailscale,
  type ServerEvent,
  type Session,
  type SessionStatus,
} from "@kermanych/core";
import { AuthService } from "../auth/auth.service";
import { holdAwake } from "../minion/keep-awake";
import { RegistryService, type RemoteDeviceRow } from "../registry/registry.service";
import { SupervisorService } from "../supervisor/supervisor.service";
import { Pairings } from "./pairing";
import { operatorAway } from "./presence";
import { RemoteFeed } from "./remote-feed";
import { RemotePhone } from "./remote-phone";
import { RemoteServer } from "./remote-server";
import { chooseHttpsPort, isOurServeTarget, Tailscale } from "./tailscale";

/** One Web Push delivery; web-push's sendNotification in the api, a fake in the specs. */
export type SendPush = (sub: RemotePushSubscription, payload: string, opts: RequestOptions) => Promise<unknown>;

/** What a spec swaps in. The api registers none of it: every field falls back to the real thing. */
export type RemoteDeps = {
  tailscale?: Tailscale;
  sendPush?: SendPush;
  /** The built phone client; `null` = none (the server answers 503). Default: @kermanych/remote's dist. */
  clientDir?: string | null;
  now?: () => number;
};
export const REMOTE_DEPS = Symbol("REMOTE_DEPS");

// The VAPID `sub` claim: who to contact about this sender. The project's home, not a person.
const VAPID_SUBJECT = "https://github.com/Oleksiyukraine/kermanych";
// A question an hour old is still worth the buzz; older, the phone shows it on opening anyway.
const PUSH_TTL_S = 3600;
const PUSH_TIMEOUT_MS = 15_000;

const PREVIEW_BLOCKED =
  "Це попередній перегляд Керманича: він не змінює налаштування Tailscale цього комп'ютера, тому «Пульт» тут не вмикається.";

const isPreview = (): boolean => process.env.KERMANYCH_PREVIEW === "1";

// The desktop app bundles the client next to the api; a dev checkout has it in the workspace.
// Not built (or not shipped) → undefined, and the server says how to build it.
function defaultClientDir(): string | undefined {
  try {
    return join(dirname(require.resolve("@kermanych/remote/package.json")), "dist");
  } catch {
    return undefined;
  }
}

function toDevice(d: RemoteDeviceRow): RemoteDevice {
  return { id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, push: d.push !== undefined };
}

@Injectable()
export class RemoteService implements OnModuleInit, OnModuleDestroy {
  private phase: RemotePhase = "off";
  private error?: string;
  private url?: string;
  private checks: RemoteTailscale = { installed: false, running: false, https: false, operator: true };
  private cli?: string;
  private pkexec?: string;
  // Our rule as it stands: removed with exactly the CLI and port that added it.
  private served?: { cli: string; port: number };
  private server?: RemoteServer;
  private events?: Subscription;
  // The last status of every session seen while on, for the push rule's transition (remotePushKind).
  private readonly lastStatus = new Map<string, SessionStatus>();
  // Lifecycle steps run one at a time: a switch flipped twice, a recheck and the quit never interleave.
  private chain: Promise<void> = Promise.resolve();

  private readonly tailscale: Tailscale;
  private readonly sendPush: SendPush;
  private readonly clientDir: string | undefined;
  private readonly now: () => number;
  private readonly pairings: Pairings;
  private readonly feed: RemoteFeed;
  readonly phone: RemotePhone;

  constructor(
    private registry: RegistryService,
    private supervisor: SupervisorService,
    auth: AuthService,
    @Optional() @Inject(REMOTE_DEPS) deps: RemoteDeps | null = null,
  ) {
    this.tailscale = deps?.tailscale ?? new Tailscale();
    this.sendPush = deps?.sendPush ?? ((sub, payload, opts) => sendNotification(sub, payload, opts));
    this.clientDir = deps?.clientDir === null ? undefined : (deps?.clientDir ?? defaultClientDir());
    this.now = deps?.now ?? Date.now;
    this.pairings = new Pairings(this.now);
    this.feed = new RemoteFeed({ sessions: () => supervisor.mergedSessions(), projects: () => registry.listProjects() });
    this.phone = new RemotePhone({
      registry,
      supervisor,
      auth,
      feed: this.feed,
      pairings: this.pairings,
      login: () => this.checks.login,
      host: () => this.checks.dnsName ?? "",
      vapidPublicKey: () => registry.getRemoteSettings().vapidPublic ?? "",
      changed: (removed) => {
        for (const id of removed) this.server?.disconnectDevice(id);
        this.publish();
      },
      now: this.now,
    });
    // Signed out on the computer: the phones' sockets close, and their reconnect hears `signed_out`.
    auth.onClear(() => this.server?.disconnectAll());
  }

  // Not awaited: the Tailscale checks spawn the CLI, and the api must not wait for them to listen.
  onModuleInit(): void {
    this.ensureVapid();
    this.prune();
    void this.queue(() => this.boot());
  }

  // On quit our rule goes with the server (nothing would answer behind it); the switch stays, so
  // the next start brings «Пульт» back.
  async onModuleDestroy(): Promise<void> {
    await this.queue(() => this.teardown());
  }

  /** The lifecycle steps queued so far, settled. For the specs. */
  settled(): Promise<void> {
    return this.chain;
  }

  state(): RemoteState {
    const { enabled } = this.registry.getRemoteSettings();
    return {
      enabled,
      phase: this.phase,
      ...(this.phase === "on" && this.url ? { url: this.url } : {}),
      tailscale: { ...this.checks },
      devices: this.registry.listRemoteDevices().map(toDevice),
      ...(this.error ? { error: this.error } : {}),
      platform: this.tailscale.platform,
      pkexec: this.pkexec !== undefined,
    };
  }

  /** PUT /remote. On: answers `starting` at once, the rest arrives as `remote_update`. Off: awaited. */
  async setEnabled(enabled: boolean): Promise<RemoteState> {
    this.registry.setRemoteSettings({ ...this.registry.getRemoteSettings(), enabled });
    if (enabled) {
      if (this.phase !== "on") this.set("starting");
      void this.queue(() => this.apply());
      return this.state();
    }
    await this.queue(async () => {
      await this.teardown();
      this.set("off");
    });
    return this.state();
  }

  /** POST /remote/recheck: the checks again, and serve again when on. */
  async recheck(): Promise<RemoteState> {
    await this.queue(() => this.boot());
    return this.state();
  }

  /** POST /remote/operator (decision 10): `pkexec tailscale set --operator=$USER`, then the checks again. */
  async setOperator(): Promise<RemoteState> {
    if (isPreview()) throw new Error(PREVIEW_BLOCKED);
    if (this.tailscale.platform !== "linux") throw new Error("Крок оператора Tailscale потрібен лише на Linux.");
    await this.queue(async () => {
      const cli = this.tailscale.findCli();
      if (!cli) throw new Error("Tailscale не встановлено.");
      const pkexec = this.tailscale.findPkexec();
      if (!pkexec) throw new Error("pkexec не знайдено — виконай у терміналі: sudo tailscale set --operator=$USER");
      await this.tailscale.setOperator(cli, pkexec);
    });
    return this.recheck();
  }

  /** POST /remote/pairing: a fresh one-time code and its QR, replacing any unused one. Only while on. */
  async createPairing(): Promise<RemotePairing> {
    if (this.phase !== "on" || !this.url) throw new Error("«Пульт» ще не працює — увімкни його і дочекайся, поки всі перевірки пройдуть.");
    const p = this.pairings.create();
    const link = `${this.url}/#pair=${p.code}`;
    const qrSvg = await qrToString(link, { type: "svg", margin: 1 });
    return { link, short: p.short, expiresAt: new Date(p.expiresAt).toISOString(), qrSvg };
  }

  /** DELETE /remote/devices/:id — «Відключити»: the key stops working and the phone's sockets close at once. */
  removeDevice(id: string): RemoteState {
    if (!this.registry.removeRemoteDevice(id)) throw new Error("device not found");
    this.server?.disconnectDevice(id);
    this.publish();
    return this.state();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  private queue(step: () => Promise<void>): Promise<void> {
    const next = this.chain.then(step);
    this.chain = next.catch(() => {});
    return next;
  }

  // Start and recheck alike: on → serve; off → only the checks (the section shows them before
  // the switch is flipped) and the crash cleanup.
  private async boot(): Promise<void> {
    if (this.registry.getRemoteSettings().enabled) return this.apply();
    try {
      await this.detect();
      await this.removeLeftover();
    } catch (err) {
      console.warn(`[remote] tailscale check failed: ${(err as Error).message}`);
    }
    this.publish();
  }

  // The checks of spec → Tailscale; true when every prerequisite holds.
  private async detect(): Promise<boolean> {
    this.cli = this.tailscale.findCli();
    this.pkexec = this.tailscale.findPkexec();
    const linux = this.tailscale.platform === "linux";
    if (!this.cli) {
      this.checks = { installed: false, running: false, https: false, operator: !linux };
      return false;
    }
    const status = await this.tailscale.status(this.cli);
    const operator = await this.tailscale.isOperator(this.cli);
    this.checks = { installed: true, ...status, operator };
    return status.running && status.https && !!status.dnsName && operator;
  }

  private async apply(): Promise<void> {
    if (!this.registry.getRemoteSettings().enabled) return;
    this.prune();
    let ready: boolean;
    try {
      ready = await this.detect();
    } catch (err) {
      await this.teardown();
      return this.set("error", (err as Error).message);
    }
    if (isPreview()) {
      await this.teardown();
      return this.set("blocked", PREVIEW_BLOCKED);
    }
    if (!ready) {
      // A prerequisite went missing under a running «Пульт» (tailscaled stopped, signed out):
      // nothing is served until the operator fixes it and rechecks.
      await this.teardown();
      return this.set("blocked");
    }
    if (this.phase !== "on") this.set("starting");
    const cli = this.cli!;
    try {
      this.server ??= new RemoteServer(this.phone, { clientDir: this.clientDir });
      const localPort = await this.server.start();
      const settings = this.registry.getRemoteSettings();
      const port = chooseHttpsPort(await this.tailscale.serveStatus(cli), settings.httpsPort);
      if (port === undefined) throw new Error("Порти 8443–8453 у tailscale serve зайняті іншими правилами — звільни один і натисни «Перевірити ще раз».");
      if (this.served && (this.served.port !== port || this.served.cli !== cli)) await this.serveOff();
      await this.tailscale.serveOn(cli, port, localPort);
      this.served = { cli, port };
      if (settings.httpsPort !== port) this.registry.setRemoteSettings({ ...this.registry.getRemoteSettings(), httpsPort: port });
      this.url = `https://${this.checks.dnsName}:${port}`;
      this.listen();
      this.set("on");
    } catch (err) {
      await this.teardown();
      this.set("error", (err as Error).message);
    }
  }

  // Everything «on» holds, released. Phase and publish are the caller's.
  private async teardown(): Promise<void> {
    this.events?.unsubscribe();
    this.events = undefined;
    this.lastStatus.clear();
    this.pairings.withdraw();
    this.url = undefined;
    await this.serveOff();
    const server = this.server;
    this.server = undefined;
    await server?.stop();
    holdAwake("remote", false);
  }

  private async serveOff(): Promise<void> {
    const served = this.served;
    this.served = undefined;
    if (!served || isPreview()) return;
    await this.tailscale.serveOff(served.cli, served.port).catch((err: Error) => console.warn(`[remote] tailscale serve off: ${err.message}`));
  }

  // After a crash while on, our rule outlives the server it pointed at. With «Пульт» off at the
  // next start it is removed — only when the stored port's rule is still a proxy to 127.0.0.1,
  // the shape of ours; anything else there is the operator's and stays.
  private async removeLeftover(): Promise<void> {
    const port = this.registry.getRemoteSettings().httpsPort;
    if (isPreview() || !this.cli || port === undefined) return;
    const targets = (await this.tailscale.serveStatus(this.cli)).get(port);
    if (targets?.length && targets.every(isOurServeTarget)) await this.tailscale.serveOff(this.cli, port);
  }

  private set(phase: RemotePhase, error?: string): void {
    this.phase = phase;
    this.error = error;
    this.awake();
    this.publish();
  }

  private publish(): void {
    this.supervisor.publish({ type: "remote_update", state: this.state() });
  }

  // VAPID keys are made once and kept (spec → Notifications and presence): a new pair would
  // orphan every phone's push subscription.
  private ensureVapid(): void {
    const s = this.registry.getRemoteSettings();
    if (s.vapidPublic && s.vapidPrivate) return;
    const keys = generateVAPIDKeys();
    this.registry.setRemoteSettings({ ...s, vapidPublic: keys.publicKey, vapidPrivate: keys.privateKey });
  }

  // Decision 5's sweep: the devices unused for REMOTE_DEVICE_IDLE_MS go, with their sockets.
  private prune(): void {
    const gone = this.registry.pruneRemoteDevices(new Date(this.now() - REMOTE_DEVICE_IDLE_MS).toISOString());
    for (const id of gone) this.server?.disconnectDevice(id);
    if (gone.length) this.publish();
  }

  // ── While on: the feed, push, keep-awake ──────────────────────────────────

  private listen(): void {
    if (this.events) return;
    for (const s of this.supervisor.mergedSessions()) this.lastStatus.set(s.id, s.status);
    this.feed.list();
    this.events = this.supervisor.events$.subscribe((e) => this.onEvent(e));
  }

  private onEvent(e: ServerEvent): void {
    if (e.type === "remote_update") return;
    try {
      for (const out of this.feed.map(e)) this.server?.broadcast(out);
    } catch (err) {
      console.warn(`[remote] feed: ${(err as Error).message}`);
      return;
    }
    if (e.type === "session_update") {
      const prev = this.lastStatus.get(e.session.id);
      this.lastStatus.set(e.session.id, e.session.status);
      const kind = remotePushKind(prev, e.session.status);
      if (kind && this.feed.isListed(e.session.id)) void this.push(e.session, kind);
    }
    if (e.type === "session_removed") this.lastStatus.delete(e.sessionId);
    if (e.type === "session_update" || e.type === "session_removed" || e.type === "project_update" || e.type === "project_removed") this.awake();
  }

  // Decision 9: awake while «Пульт» is on and a listed agent works or waits for an answer.
  private awake(): void {
    holdAwake("remote", this.phase === "on" && this.feed.current().some((s) => ACTIVE_STATUSES.includes(s.status)));
  }

  // Decision 4: a push on a transition into a question or a failure, only while «Пульт» is on and
  // the operator is not at the computer (presence unknown counts as away). The payload is the
  // project, the title and the kind — never conversation text: it travels through Apple's or
  // Google's push service. A subscription the push service no longer knows (404/410) is cleared.
  private async push(s: Session, kind: RemotePush["kind"]): Promise<void> {
    if (this.phase !== "on" || !operatorAway()) return;
    const { vapidPublic, vapidPrivate } = this.registry.getRemoteSettings();
    if (!vapidPublic || !vapidPrivate) return;
    const project = this.registry.listProjects().find((p) => p.id === s.projectId)?.name ?? "";
    const payload = JSON.stringify({ sessionId: s.id, project, title: s.name, kind } satisfies RemotePush);
    const opts: RequestOptions = {
      TTL: PUSH_TTL_S,
      urgency: "high",
      timeout: PUSH_TIMEOUT_MS,
      vapidDetails: { subject: VAPID_SUBJECT, publicKey: vapidPublic, privateKey: vapidPrivate },
    };
    await Promise.all(
      this.registry.listRemoteDevices().map(async (d) => {
        if (!d.push) return;
        try {
          await this.sendPush(d.push, payload, opts);
        } catch (err) {
          const status = err && typeof err === "object" && "statusCode" in err ? err.statusCode : undefined;
          if (status === 404 || status === 410) {
            this.registry.setRemoteDevicePush(d.id, undefined);
            this.publish();
          } else console.warn(`[remote] push to ${d.name}: ${(err as Error).message}`);
        }
      }),
    );
  }
}
