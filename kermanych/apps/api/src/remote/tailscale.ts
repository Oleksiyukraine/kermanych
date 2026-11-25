// apps/api/src/remote/tailscale.ts
// «Пульт» reaches the phone through the operator's tailnet (docs/specs/2026-11-24-mobile-remote-control.md,
// decision 2): `tailscale serve` gives this computer a real certificate on
// `https://<host>.<tailnet>.ts.net:<port>` and proxies it to the remote server on 127.0.0.1. This
// module is everything the api asks the `tailscale` CLI: where it is, whether this computer is in
// a tailnet with HTTPS certificates, whether this Linux user may change its serve config, and the
// serve rule of our own port on and off (decision 6). Decision 10's `pkexec tailscale set
// --operator=<user>` is here too.
//
// The parsers are pure and exported (the CLI's JSON in, plain values out), so the spec feeds them
// fixtures; the process calls go through an injectable runner and host, so the service's spec
// fakes the CLI and never touches a real tailnet.
//
// Tailscale reference: https://tailscale.com/docs/features/tailscale-serve — `serve --bg
// --https=<port> <target>` adds a persistent rule, `serve --https=<port> off` removes exactly that
// one, and the proxied request carries `Tailscale-User-Login` for tailnet users and for users the
// device was shared with.
import { accessSync, constants } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, join } from "node:path";
import { REMOTE_HTTPS_PORT_DEFAULT, type RemoteTailscale } from "@kermanych/core";
import { lastLines, run, ToolError, type RunOptions, type RunResult } from "../device/device-proc";

/** One CLI call; `run` from device-proc in the api, a fake in the specs. */
export type TailscaleRun = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

/** What the finder and the operator check read of the machine. */
export type TailscaleHost = {
  platform: NodeJS.Platform;
  /** `$PATH`. */
  path: string;
  executable: (file: string) => boolean;
  user: () => { username: string; uid: number };
};

/** `tailscale status --json`, reduced to what «Пульт» checks. */
export type TailscaleStatus = Pick<RemoteTailscale, "running" | "https" | "dnsName" | "login">;

// The tailnet ports tried for our rule: the default and the next ten. A port the operator's own
// serve config uses is skipped (decision 6: their config stays untouched).
const PORT_SPAN = 11;

// `status`, `serve status`, `debug prefs`: local IPC answers, quick. `serve` itself may wait for
// the control plane (and, with HTTPS off in the tailnet, for the operator to approve it in a
// browser — it never ends on its own then). `set --operator` behind pkexec waits for the
// operator's password in the system dialog.
const QUERY_TIMEOUT_MS = 10_000;
const SERVE_TIMEOUT_MS = 20_000;
const OPERATOR_TIMEOUT_MS = 180_000;

// macOS: the App Store / standalone app bundle's binary doubles as the CLI (taken first, see
// findCli); Homebrew's formula installs `tailscale` under its prefix, which a GUI app's PATH
// (launched from the Dock) usually lacks.
const MACOS_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const MACOS_CLI = ["/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"];

export function realTailscaleHost(): TailscaleHost {
  return {
    platform: process.platform,
    path: process.env.PATH ?? "",
    executable: (file) => {
      try {
        accessSync(file, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    user: () => {
      const u = userInfo();
      return { username: u.username, uid: u.uid };
    },
  };
}

// ── Pure parsers ────────────────────────────────────────────────────────────

/** The first executable `name` on PATH, then the platform's fixed spots. */
export function findOnPath(name: string, host: TailscaleHost, extra: readonly string[] = []): string | undefined {
  for (const dir of host.path.split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    if (host.executable(file)) return file;
  }
  return extra.find((file) => host.executable(file));
}

type StatusJson = {
  BackendState?: unknown;
  Self?: { DNSName?: unknown; UserID?: unknown } | null;
  CertDomains?: unknown;
  User?: Record<string, { LoginName?: unknown } | null> | null;
};

/**
 * `tailscale status --json`. `running`: tailscaled runs and is signed in (`BackendState` is
 * `Running`; `NeedsLogin`, `Stopped`, `Starting` are not). `https`: the tailnet hands this computer
 * a certificate — `CertDomains` lists names only while MagicDNS and HTTPS certificates are both on.
 * `login`: the tailnet user this computer is signed in as, `User[Self.UserID].LoginName` (a tagged
 * computer has a synthetic user; the identity check then compares against that).
 * Anything unreadable reads as not running.
 */
export function parseTailscaleStatus(text: string): TailscaleStatus {
  let j: StatusJson;
  try {
    j = JSON.parse(text) as StatusJson;
  } catch {
    return { running: false, https: false };
  }
  if (!j || typeof j !== "object") return { running: false, https: false };
  const running = j.BackendState === "Running";
  const rawDns = typeof j.Self?.DNSName === "string" ? j.Self.DNSName.replace(/\.$/, "") : "";
  const https = Array.isArray(j.CertDomains) && j.CertDomains.some((d) => typeof d === "string" && d.length > 0);
  const userId = j.Self?.UserID;
  const user = userId !== undefined && userId !== null && j.User ? j.User[String(userId)] : undefined;
  const login = typeof user?.LoginName === "string" && user.LoginName ? user.LoginName : undefined;
  return { running, https, ...(rawDns ? { dnsName: rawDns } : {}), ...(login ? { login } : {}) };
}

type ServeConfigJson = {
  TCP?: Record<string, { HTTPS?: unknown; HTTP?: unknown; TCPForward?: unknown } | null> | null;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown; Path?: unknown; Text?: unknown } | null> | null } | null> | null;
  Foreground?: Record<string, ServeConfigJson | null> | null;
};

/**
 * `tailscale serve status --json` (ipn.ServeConfig): every tailnet port that has a rule, with what
 * it serves — a proxy target (`http://127.0.0.1:3000`), `path:<dir>`, `text:…`, `tcp:<forward>`, or
 * `?` for a port listed without a handler we can read. Foreground (non-`--bg`) sessions' rules
 * count too: their ports are taken while they run. Empty output (no config) is no ports.
 */
export function parseServeStatus(text: string): Map<number, string[]> {
  const used = new Map<number, string[]>();
  if (!text.trim()) return used;
  let j: ServeConfigJson;
  try {
    j = JSON.parse(text) as ServeConfigJson;
  } catch {
    return used;
  }
  const add = (port: number, target: string) => {
    if (!Number.isInteger(port) || port <= 0) return;
    const list = used.get(port) ?? [];
    if (!list.includes(target)) list.push(target);
    used.set(port, list);
  };
  const walk = (c: ServeConfigJson | null | undefined) => {
    if (!c || typeof c !== "object") return;
    for (const [hostPort, web] of Object.entries(c.Web ?? {})) {
      const port = Number(hostPort.slice(hostPort.lastIndexOf(":") + 1));
      for (const h of Object.values(web?.Handlers ?? {})) {
        if (typeof h?.Proxy === "string") add(port, h.Proxy);
        else if (typeof h?.Path === "string") add(port, `path:${h.Path}`);
        else if (typeof h?.Text === "string") add(port, `text:${h.Text}`);
        else add(port, "?");
      }
    }
    for (const [key, tcp] of Object.entries(c.TCP ?? {})) {
      const port = Number(key);
      if (typeof tcp?.TCPForward === "string") add(port, `tcp:${tcp.TCPForward}`);
      else if (!used.has(port)) add(port, "?");
    }
    for (const fg of Object.values(c.Foreground ?? {})) walk(fg);
  };
  walk(j);
  return used;
}

/**
 * A rule of ours: a proxy to the remote server, which always listens on 127.0.0.1 (on a port that
 * changes per start). Used for the leftover cleanup at startup and to keep our stored port.
 */
export function isOurServeTarget(target: string): boolean {
  return /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(target);
}

/**
 * The tailnet HTTPS port for our rule: the stored one is kept for good (a paired phone's URL does
 * not move) unless another target took it since; otherwise the first of 8443…8453 nobody uses.
 * Undefined when all of them are taken.
 */
export function chooseHttpsPort(used: ReadonlyMap<number, readonly string[]>, stored: number | undefined): number | undefined {
  if (stored !== undefined && (used.get(stored) ?? []).every(isOurServeTarget)) return stored;
  for (let p = REMOTE_HTTPS_PORT_DEFAULT; p < REMOTE_HTTPS_PORT_DEFAULT + PORT_SPAN; p++) if (!used.has(p)) return p;
  return undefined;
}

/**
 * Linux (decision 10): whether this user may change the serve config — root, or the user
 * `tailscale set --operator` named (`OperatorUser` in `tailscale debug prefs`).
 */
export function parseOperator(prefsText: string, user: { username: string; uid: number }): boolean {
  if (user.uid === 0) return true;
  try {
    const j = JSON.parse(prefsText) as { OperatorUser?: unknown };
    return typeof j?.OperatorUser === "string" && j.OperatorUser === user.username;
  } catch {
    return false;
  }
}

/**
 * The words of a failed `tailscale serve`. With HTTPS (or Serve) not enabled in the tailnet the CLI
 * prints a consent link and waits for it to be approved — the operator needs that link, so it
 * leads; anything else is the CLI's own last lines.
 */
export function serveFailure(err: unknown): string {
  if (!(err instanceof ToolError)) return (err as Error)?.message ?? String(err);
  const said = `${err.stdout}\n${err.stderr}`.trim();
  const consent = /https:\/\/login\.tailscale\.com\/\S+/.exec(said)?.[0];
  if (consent) return `Tailscale просить увімкнути Serve і HTTPS-сертифікати у твоїй мережі. Відкрий ${consent}, підтверди і натисни «Перевірити ще раз».`;
  return said && err.code === null ? `${err.message}: ${lastLines(said, 6)}` : err.message;
}

// ── Process calls ───────────────────────────────────────────────────────────

export class Tailscale {
  constructor(
    private runner: TailscaleRun = run,
    readonly host: TailscaleHost = realTailscaleHost(),
  ) {}

  get platform(): NodeJS.Platform {
    return this.host.platform;
  }

  /**
   * The CLI, or undefined when Tailscale is not installed (spec → Tailscale → «Find the CLI»).
   * macOS: the app bundle's binary first. It is the only CLI that talks to the App Store /
   * standalone app's daemon; a Homebrew `tailscale` left on PATH talks only to Homebrew's own
   * `tailscaled` and reads «failed to connect» next to a running app.
   */
  findCli(): string | undefined {
    if (this.host.platform === "darwin" && this.host.executable(MACOS_APP_CLI)) return MACOS_APP_CLI;
    return findOnPath("tailscale", this.host, this.host.platform === "darwin" ? MACOS_CLI : []);
  }

  /** Linux: `pkexec`, for the operator step's system password dialog (decision 10). */
  findPkexec(): string | undefined {
    return this.host.platform === "linux" ? findOnPath("pkexec", this.host) : undefined;
  }

  /** A stopped tailscaled answers with an error and no JSON: that is «not running», not a failure. */
  async status(cli: string): Promise<TailscaleStatus> {
    const r = await this.runner(cli, ["status", "--json"], { timeoutMs: QUERY_TIMEOUT_MS, allowFail: true });
    return parseTailscaleStatus(r.stdout.toString("utf8"));
  }

  /** Always true off Linux: there `tailscale serve` needs no extra right. */
  async isOperator(cli: string): Promise<boolean> {
    if (this.host.platform !== "linux") return true;
    const user = this.host.user();
    if (user.uid === 0) return true;
    const r = await this.runner(cli, ["debug", "prefs"], { timeoutMs: QUERY_TIMEOUT_MS, allowFail: true });
    return r.code === 0 && parseOperator(r.stdout.toString("utf8"), user);
  }

  async serveStatus(cli: string): Promise<Map<number, string[]>> {
    const r = await this.runner(cli, ["serve", "status", "--json"], { timeoutMs: QUERY_TIMEOUT_MS, allowFail: true });
    return r.code === 0 ? parseServeStatus(r.stdout.toString("utf8")) : new Map();
  }

  /** Our rule on: the tailnet's `https://<host>:<httpsPort>` → the remote server. Throws `serveFailure` words. */
  async serveOn(cli: string, httpsPort: number, localPort: number): Promise<void> {
    try {
      await this.runner(cli, ["serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${localPort}`], { timeoutMs: SERVE_TIMEOUT_MS });
    } catch (err) {
      throw new Error(serveFailure(err));
    }
  }

  /** Our rule off — only that port's rule, the operator's own config stays (decision 6). */
  async serveOff(cli: string, httpsPort: number): Promise<void> {
    try {
      await this.runner(cli, ["serve", `--https=${httpsPort}`, "off"], { timeoutMs: SERVE_TIMEOUT_MS });
    } catch (err) {
      throw new Error(serveFailure(err));
    }
  }

  /** Decision 10: `pkexec <cli> set --operator=<user>` — the system's own password dialog, once. */
  async setOperator(cli: string, pkexec: string): Promise<void> {
    const { username } = this.host.user();
    try {
      await this.runner(pkexec, [cli, "set", `--operator=${username}`], { timeoutMs: OPERATOR_TIMEOUT_MS });
    } catch (err) {
      throw new Error((err as Error).message);
    }
  }
}
