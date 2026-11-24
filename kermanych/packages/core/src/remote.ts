// «Пульт» (docs/specs/2026-11-24-mobile-remote-control.md): the operator's phone watches and steers
// this computer's agents through the operator's Tailscale tailnet.
//
// This module is what three parties agree on: the api (apps/api/src/remote), the desktop ui's
// «Налаштування → Застосунок → Пульт» section and bottom-bar mark (apps/ui), and the phone client
// (apps/remote). Pure: no clock, no storage, no Tailscale shapes.

import type { RpcExtensionUIRequest, RpcExtensionUIResponse, Session, SessionStatus, ToolDetail, ToolStat, TranscriptEntry } from "./types";

// ── Knobs ───────────────────────────────────────────────────────────────────

/** A one-time pairing code lives this long (spec → Pairing and devices). */
export const REMOTE_PAIRING_TTL_MS = 10 * 60_000;
/** A device key unused this long is refused and its row removed (decision 5). */
export const REMOTE_DEVICE_IDLE_MS = 30 * 24 * 60 * 60_000;
/** Wrong codes allowed against one pairing before it is withdrawn. */
export const REMOTE_PAIRING_ATTEMPTS = 5;
/** The tailnet HTTPS port tried first for `tailscale serve`; the next free one is kept for good. */
export const REMOTE_HTTPS_PORT_DEFAULT = 8443;
/** The operator is «at the computer» while the system was used within this window (decision 4). */
export const REMOTE_PRESENCE_IDLE_S = 120;
/** The phone's key travels in this header (and as `auth.key` on the socket). */
export const REMOTE_KEY_HEADER = "x-kermanych-device-key";
/** The phone client's socket.io path on the remote server. */
export const REMOTE_SOCKET_PATH = "/remote/socket";
/** Every phone route lives under this prefix on the remote server. */
export const REMOTE_API_PREFIX = "/remote/api";

// ── Desktop side (main api, bearer-guarded) ─────────────────────────────────

/** What the api found out about Tailscale on this computer. */
export type RemoteTailscale = {
  /** A `tailscale` CLI was found. */
  installed: boolean;
  /** tailscaled runs and this computer is signed in to a tailnet (`BackendState === "Running"`). */
  running: boolean;
  /** MagicDNS gives this computer a `<host>.<tailnet>.ts.net` name and HTTPS certificates are on. */
  https: boolean;
  /** Linux only: this user may change Tailscale's serve config (`tailscale set --operator`). Always true elsewhere. */
  operator: boolean;
  /** `<host>.<tailnet>.ts.net`, without the trailing dot. */
  dnsName?: string;
  /** The tailnet login this computer is signed in as; the phone must come from the same login. */
  login?: string;
};

/** One paired phone, as the desktop lists it. */
export type RemoteDevice = {
  id: string;
  /** Derived from the phone's browser at pairing, e.g. «iPhone · Safari». */
  name: string;
  createdAt: string;
  lastSeenAt: string;
  /** The phone accepted push notifications. */
  push: boolean;
};

/**
 * off       — «Пульт» is off.
 * blocked   — on, but a Tailscale prerequisite is missing (see `tailscale`); nothing is served.
 * starting  — on, `tailscale serve` is being set up.
 * on        — reachable at `url`.
 * error     — on, setting up failed (`error` says why); the operator may retry with recheck.
 */
export type RemotePhase = "off" | "blocked" | "starting" | "on" | "error";

export type RemoteState = {
  enabled: boolean;
  phase: RemotePhase;
  /** `https://<dnsName>:<port>` while `phase === "on"`. */
  url?: string;
  tailscale: RemoteTailscale;
  devices: RemoteDevice[];
  error?: string;
  /** `process.platform` of the computer, so the section can word the Linux operator step. */
  platform: string;
  /** Linux: whether `pkexec` exists, so the section offers the dialog or the `sudo` command. */
  pkexec: boolean;
};

/** «Підключити телефон»: what the desktop shows. */
export type RemotePairing = {
  /** `<url>/#pair=<code>` — what the QR encodes. */
  link: string;
  /** Six digits, for typing into the installed web app (iOS keeps its storage apart from Safari). */
  short: string;
  expiresAt: string;
  /** The QR of `link`, as an SVG document. */
  qrSvg: string;
};

// ── Phone side (remote server, device key) ──────────────────────────────────

/** A session as the phone sees it: no paths, no env, no git. */
export type RemoteSession = {
  id: string;
  projectId: string;
  name: string;
  status: SessionStatus;
  /** Runs in its own terminal: answered only on the computer; a message only when idle (decision 8). */
  native: boolean;
  kind: Session["kind"];
  lastActivityAt: string;
  currentTool?: string;
  error?: string;
  /** The open question, for a non-native session waiting for the operator. */
  pendingUiRequest?: RpcExtensionUIRequest;
};

export type RemoteProject = { id: string; name: string; color?: string };

export type RemotePairRequest = { code: string; name: string };
export type RemotePairResponse = { key: string; deviceId: string };
export type RemoteMe = { deviceId: string; name: string; host: string; vapidPublicKey: string };
export type RemoteList = { projects: RemoteProject[]; sessions: RemoteSession[] };
export type RemoteMessageRequest = { text: string; images?: { data: string; mimeType: string }[] };
export type RemoteAnswerRequest = { res: RpcExtensionUIResponse };
/** `PushSubscription.toJSON()` of the phone's service worker. */
export type RemotePushSubscription = { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } };

/**
 * A refusal from the remote server, always JSON `{ code, message }`.
 * unauthorized  — no key, an unknown key, or a lapsed one: pair again.
 * signed_out    — nobody is signed in to Kermanych on the computer.
 * foreign_login — the request came from another tailnet login than the computer's.
 * pairing       — the pairing code is wrong, used or expired.
 * native_busy / native_unsupported — the computer's own refusals, passed through.
 */
export type RemoteErrorCode = "unauthorized" | "signed_out" | "foreign_login" | "pairing" | "not_found" | "bad_request" | "native_busy" | "native_unsupported" | "failed";
export type RemoteError = { code: RemoteErrorCode; message: string };

/** What the phone's socket receives on its `event` channel. */
export type RemoteEvent =
  | ({ type: "list" } & RemoteList)
  | { type: "session"; session: RemoteSession }
  | { type: "session_removed"; sessionId: string }
  | { type: "transcript_append"; sessionId: string; entry: TranscriptEntry }
  | { type: "transcript_reset"; sessionId: string; entries: TranscriptEntry[] }
  | { type: "transcript_update"; sessionId: string; id: string; status: "ok" | "error"; target?: string; stat?: ToolStat; count?: number; ms?: number; detail?: ToolDetail };

/** What a push notification carries (decision: no conversation text). */
export type RemotePush = { sessionId: string; project: string; title: string; kind: "input" | "error" };

// ── Rules ───────────────────────────────────────────────────────────────────

/** The phone's view of a session. */
export function toRemoteSession(s: Session): RemoteSession {
  return {
    id: s.id,
    projectId: s.projectId,
    name: s.name,
    status: s.status,
    native: s.native === true,
    kind: s.kind,
    lastActivityAt: s.lastActivityAt,
    ...(s.currentTool ? { currentTool: s.currentTool } : {}),
    ...(s.error ? { error: s.error } : {}),
    ...(s.pendingUiRequest && !s.native ? { pendingUiRequest: s.pendingUiRequest } : {}),
  };
}

/** Which push a status transition earns, if any (decision 4): into `waiting_input`, or into `error`/`conflict`. */
export function remotePushKind(prev: SessionStatus | undefined, next: SessionStatus): RemotePush["kind"] | undefined {
  if (prev === next) return undefined;
  if (next === "waiting_input") return "input";
  if ((next === "error" || next === "conflict") && prev !== "error" && prev !== "conflict") return "error";
  return undefined;
}
