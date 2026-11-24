// apps/api/src/remote/remote-phone.ts
// Everything a paired phone may do (docs/specs/2026-11-24-mobile-remote-control.md → Whitelist):
// pair, list the sessions, read one conversation, send a message, answer a question, stop an
// agent, (un)subscribe to push. Nothing else exists on the remote server — no env, files, diff,
// git, terminal, preview, settings, cloud — so nothing else can be reached from the tailnet.
//
// Who may: every request and the socket handshake present a device key (decision 5), checked here
// against its SHA-256 in the registry; a key unused for REMOTE_DEVICE_IDLE_MS is refused and its
// row removed. Defence in depth: `tailscale serve` adds `Tailscale-User-Login` to the proxied
// request, and a login other than the computer's own is refused even with a valid key (spec →
// Pairing and devices). Nobody signed in to Kermanych on the computer → refused, paired phones
// stay paired; every action runs as the user signed in there.
//
// Transport-free: RemoteServer turns these calls into HTTP and socket.io, and every refusal is a
// RemoteFailure that it answers as JSON `RemoteError`.
import {
  REMOTE_DEVICE_IDLE_MS,
  type RemoteErrorCode,
  type RemoteList,
  type RemoteMe,
  type RemotePairResponse,
  type RemotePushSubscription,
  type RpcExtensionUIResponse,
  type Session,
  type TranscriptEntry,
} from "@kermanych/core";
import { CodedError } from "../management/coded-error";
import type { AuthService } from "../auth/auth.service";
import type { RegistryService, RemoteDeviceRow } from "../registry/registry.service";
import type { SupervisorService } from "../supervisor/supervisor.service";
import { hashKey, randomToken, type Pairings } from "./pairing";
import { listedSessions, type RemoteFeed } from "./remote-feed";

const HTTP_STATUS: Record<RemoteErrorCode, number> = {
  unauthorized: 401,
  foreign_login: 403,
  signed_out: 503,
  not_found: 404,
  bad_request: 400,
  pairing: 400,
  native_busy: 400,
  native_unsupported: 400,
  failed: 500,
};

/** A refusal the remote server answers as `{ code, message }` with the code's HTTP status. */
export class RemoteFailure extends Error {
  readonly status: number;
  constructor(
    readonly code: RemoteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RemoteFailure";
    this.status = HTTP_STATUS[code];
  }
}

// A device's last-seen time is written at most this often: a phone polling or reconnecting must
// not turn every request into a registry write.
const TOUCH_EVERY_MS = 60_000;
// Images ride the message as base64; the server's body limit bounds the total.
const MAX_IMAGES = 10;
const MAX_NAME = 60;

/**
 * The send mode of the phone's message — the desktop composer's rule, mirrored
 * (apps/ui/src/lib/message-mode.ts `nextMode`, which the «Агенти» composer uses): a session with no
 * turn yet starts one with a prompt; a settled (`done`) one gets a follow-up; anything else is
 * steered mid-turn. Kept in step by hand: the ui's copy reads the ui's MessageMode type.
 */
export function messageMode(s: Session, history: readonly TranscriptEntry[]): "prompt" | "follow_up" | "steer" {
  const hasTurn = history.some((e) => e.kind === "user_text" || e.kind === "assistant_text");
  return !hasTurn ? "prompt" : s.status === "done" ? "follow_up" : "steer";
}

export type RemotePhoneDeps = {
  registry: Pick<RegistryService, "addRemoteDevice" | "findRemoteDeviceByHash" | "touchRemoteDevice" | "removeRemoteDevice" | "setRemoteDevicePush">;
  supervisor: Pick<SupervisorService, "mergedSessions" | "sessionTranscript" | "sendMessage" | "answerUi" | "stopSession">;
  auth: Pick<AuthService, "current">;
  feed: RemoteFeed;
  pairings: Pairings;
  /** The tailnet login this computer is signed in as; undefined (unknown) skips the identity check. */
  login: () => string | undefined;
  /** `<host>.<tailnet>.ts.net`, for the phone's header. */
  host: () => string;
  vapidPublicKey: () => string;
  /** The paired phones changed (paired, lapsed, push toggled, last seen): `removed` lose their sockets. */
  changed: (removed: string[]) => void;
  now?: () => number;
};

export class RemotePhone {
  constructor(private deps: RemotePhoneDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // ── Who ───────────────────────────────────────────────────────────────────

  private checkIdentity(login: string | undefined): void {
    const own = this.deps.login();
    if (login && own && login.toLowerCase() !== own.toLowerCase())
      throw new RemoteFailure("foreign_login", "Запит прийшов від іншого облікового запису Tailscale, ніж той, у якому цей комп'ютер.");
  }

  private checkSignedIn(): void {
    if (!this.deps.auth.current()) throw new RemoteFailure("signed_out", "На комп'ютері не виконано вхід.");
  }

  /**
   * The paired device behind a request or a socket handshake. Order: the tailnet identity, the key
   * (unknown or lapsed → 401, a lapsed row removed on the spot), then the computer's sign-in.
   */
  authenticate(key: unknown, login: string | undefined): RemoteDeviceRow {
    this.checkIdentity(login);
    const unauthorized = new RemoteFailure("unauthorized", "Цей телефон не підключено до комп'ютера — підключи його знову.");
    if (typeof key !== "string" || !key) throw unauthorized;
    const device = this.deps.registry.findRemoteDeviceByHash(hashKey(key));
    if (!device) throw unauthorized;
    const now = this.now();
    const idle = now - Date.parse(device.lastSeenAt);
    if (!(idle <= REMOTE_DEVICE_IDLE_MS)) {
      this.deps.registry.removeRemoteDevice(device.id);
      this.deps.changed([device.id]);
      throw unauthorized;
    }
    this.checkSignedIn();
    if (idle >= TOUCH_EVERY_MS) {
      const at = new Date(now).toISOString();
      this.deps.registry.touchRemoteDevice(device.id, at);
      this.deps.changed([]);
      return { ...device, lastSeenAt: at };
    }
    return device;
  }

  /** `POST /pair`: the one-time code (long or six digits) for a device key. */
  pair(body: unknown, login: string | undefined): RemotePairResponse {
    this.checkIdentity(login);
    this.checkSignedIn();
    const b = body as { code?: unknown; name?: unknown } | null;
    if (typeof b?.code !== "string" || !b.code.trim()) throw new RemoteFailure("bad_request", "Немає коду підключення.");
    if (!this.deps.pairings.redeem(b.code))
      throw new RemoteFailure("pairing", "Код недійсний, уже використаний або прострочений — створи новий на комп'ютері.");
    const key = randomToken();
    const device = this.deps.registry.addRemoteDevice(deviceName(b.name), hashKey(key), new Date(this.now()).toISOString());
    this.deps.changed([]);
    return { key, deviceId: device.id };
  }

  // ── What ──────────────────────────────────────────────────────────────────

  me(device: RemoteDeviceRow): RemoteMe {
    return { deviceId: device.id, name: device.name, host: this.deps.host(), vapidPublicKey: this.deps.vapidPublicKey() };
  }

  list(): RemoteList {
    return this.deps.feed.list();
  }

  // Every action names a session the phone may see; any other id is a 404, whether it exists or not.
  private listed(id: string): Session {
    const s = listedSessions(this.deps.supervisor.mergedSessions()).find((x) => x.id === id);
    if (!s) throw new RemoteFailure("not_found", "Такої сесії немає серед агентів.");
    return s;
  }

  async transcript(id: string): Promise<TranscriptEntry[]> {
    this.listed(id);
    try {
      return await this.deps.supervisor.sessionTranscript(id);
    } catch (err) {
      throw relay(err);
    }
  }

  /**
   * A message, with photos. A leading `/` is refused: commands (`/minion`, the harness's own) are
   * not available from the phone. The mode is the desktop composer's (messageMode). A native agent
   * that is not idle refuses with `native_busy` (decision 8), passed through.
   */
  async message(id: string, body: unknown): Promise<{ ok: true }> {
    const s = this.listed(id);
    const b = body as { text?: unknown; images?: unknown } | null;
    const text = typeof b?.text === "string" ? b.text : b?.text === undefined ? "" : undefined;
    if (text === undefined) throw new RemoteFailure("bad_request", "Текст повідомлення має бути рядком.");
    const images = readImages(b?.images);
    if (!text.trim() && !images.length) throw new RemoteFailure("bad_request", "Порожнє повідомлення.");
    if (text.trimStart().startsWith("/")) throw new RemoteFailure("bad_request", "Команди з телефона недоступні — надішли їх на комп'ютері.");
    try {
      const mode = messageMode(s, await this.deps.supervisor.sessionTranscript(id));
      await this.deps.supervisor.sendMessage(id, text, mode, images.length ? images : undefined);
    } catch (err) {
      throw relay(err);
    }
    return { ok: true };
  }

  /** The answer to the open question. A native agent is answered only on the computer (decision 8). */
  answer(id: string, body: unknown): { ok: true } {
    const s = this.listed(id);
    if (s.native) throw new RemoteFailure("native_unsupported", "Нативному агентові відповідають на комп'ютері, у його терміналі.");
    const res = readAnswer((body as { res?: unknown } | null)?.res);
    if (!res) throw new RemoteFailure("bad_request", "Відповідь не впізнано.");
    if (s.pendingUiRequest?.id !== res.id) throw new RemoteFailure("bad_request", "Це питання вже закрите.");
    try {
      this.deps.supervisor.answerUi(id, res);
    } catch (err) {
      throw relay(err);
    }
    return { ok: true };
  }

  async stop(id: string): Promise<{ ok: true }> {
    this.listed(id);
    try {
      await this.deps.supervisor.stopSession(id);
    } catch (err) {
      throw relay(err);
    }
    return { ok: true };
  }

  setPush(device: RemoteDeviceRow, body: unknown): { ok: true } {
    const sub = readSubscription(body);
    if (!sub) throw new RemoteFailure("bad_request", "Підписку на сповіщення не впізнано.");
    this.deps.registry.setRemoteDevicePush(device.id, sub);
    this.deps.changed([]);
    return { ok: true };
  }

  clearPush(device: RemoteDeviceRow): { ok: true } {
    this.deps.registry.setRemoteDevicePush(device.id, undefined);
    this.deps.changed([]);
    return { ok: true };
  }
}

// The computer's own refusals reach the phone with their codes; an unknown session is a 404;
// anything else failed, with the supervisor's words.
function relay(err: unknown): RemoteFailure {
  if (err instanceof RemoteFailure) return err;
  if (err instanceof CodedError && (err.code === "native_busy" || err.code === "native_unsupported")) return new RemoteFailure(err.code, err.message);
  const message = (err as Error)?.message ?? String(err);
  return message === "session not found" ? new RemoteFailure("not_found", message) : new RemoteFailure("failed", message);
}

// «iPhone · Safari» as the phone named itself; control characters out, bounded, never empty.
function deviceName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME) : "";
  return name || "Телефон";
}

function readImages(raw: unknown): { data: string; mimeType: string }[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_IMAGES) throw new RemoteFailure("bad_request", `До ${MAX_IMAGES} фото в одному повідомленні.`);
  return raw.map((i: { data?: unknown; mimeType?: unknown } | null) => {
    if (typeof i?.data !== "string" || !i.data || typeof i.mimeType !== "string" || !/^image\/[\w.+-]+$/.test(i.mimeType))
      throw new RemoteFailure("bad_request", "Фото не впізнано.");
    return { data: i.data, mimeType: i.mimeType };
  });
}

// Rebuilt field by field: nothing the phone adds rides on to the agent.
function readAnswer(raw: unknown): RpcExtensionUIResponse | undefined {
  const r = raw as { type?: unknown; id?: unknown; value?: unknown; confirmed?: unknown; cancelled?: unknown } | null;
  if (r?.type !== "extension_ui_response" || typeof r.id !== "string" || !r.id) return undefined;
  if (typeof r.value === "string") return { type: "extension_ui_response", id: r.id, value: r.value };
  if (typeof r.confirmed === "boolean") return { type: "extension_ui_response", id: r.id, confirmed: r.confirmed };
  if (r.cancelled === true) return { type: "extension_ui_response", id: r.id, cancelled: true };
  return undefined;
}

// A push service endpoint is always https; the keys are the browser's base64url strings.
function readSubscription(raw: unknown): RemotePushSubscription | undefined {
  const s = raw as { endpoint?: unknown; expirationTime?: unknown; keys?: { p256dh?: unknown; auth?: unknown } | null } | null;
  if (typeof s?.endpoint !== "string" || !s.endpoint.startsWith("https://")) return undefined;
  if (typeof s.keys?.p256dh !== "string" || !s.keys.p256dh || typeof s.keys.auth !== "string" || !s.keys.auth) return undefined;
  const expirationTime = typeof s.expirationTime === "number" ? s.expirationTime : null;
  return { endpoint: s.endpoint, expirationTime, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
}
