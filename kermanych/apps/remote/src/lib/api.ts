// The phone's half of the remote server's contract (docs/plans/2026-11-24-mobile-remote-control.md
// → Remote server). Same-origin JSON under REMOTE_API_PREFIX, the device key in REMOTE_KEY_HEADER.
// Every refusal is a JSON `RemoteError`; a fetch that never reached the computer becomes the
// `network` pseudo-code, which the store turns into the «Комп'ютер недоступний» banner.

import { REMOTE_API_PREFIX, REMOTE_KEY_HEADER } from "@kermanych/core/remote";
import type {
  RemoteAnswerRequest,
  RemoteErrorCode,
  RemoteList,
  RemoteMe,
  RemoteMessageRequest,
  RemotePairRequest,
  RemotePairResponse,
  RemotePushSubscription,
  RpcExtensionUIResponse,
  TranscriptEntry,
} from "@kermanych/core";
import { t, type TextKey } from "./i18n";

/** Where the device key lives (the installed iOS app has its own copy of this storage). */
export const KEY_STORAGE = "kermanych.remote.key";

export function readKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

export function writeKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    // Private mode with storage off: the key lives for this page only (held by the store).
  }
}

export type ApiErrorCode = RemoteErrorCode | "network";

/**
 * A refused or failed call. `message` is what the phone shows: the api's own text for codes the
 * phone has no wording of its own for (bad_request, native_unsupported, the '/' refusal…), the
 * phone's wording for the ones it explains itself.
 */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Codes whose wording the phone owns (in its own language); the rest carry the api's message. */
const OWN_WORDING: Partial<Record<ApiErrorCode, TextKey>> = {
  unauthorized: "error.unauthorized",
  signed_out: "error.signed_out",
  foreign_login: "error.foreign_login",
  pairing: "error.pairing",
  not_found: "error.not_found",
  native_busy: "error.native_busy",
  network: "error.network",
};

const KNOWN_CODES: Record<RemoteErrorCode, true> = {
  unauthorized: true,
  signed_out: true,
  foreign_login: true,
  pairing: true,
  not_found: true,
  bad_request: true,
  native_busy: true,
  native_unsupported: true,
  failed: true,
};

export function isRemoteErrorCode(code: unknown): code is RemoteErrorCode {
  return typeof code === "string" && Object.hasOwn(KNOWN_CODES, code);
}

function codeForStatus(status: number): RemoteErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "foreign_login";
  if (status === 503) return "signed_out";
  if (status === 404) return "not_found";
  if (status === 400) return "bad_request";
  return "failed";
}

function errorFor(code: ApiErrorCode, apiMessage: string | undefined, status = 0): ApiError {
  const own = OWN_WORDING[code];
  return new ApiError(code, own ? t(own) : apiMessage || t("error.failed"), status);
}

/** The one place a thrown value becomes text for the operator. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

async function call<T>(method: Method, path: string, key: string | null, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (key) headers[REMOTE_KEY_HEADER] = key;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${REMOTE_API_PREFIX}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw errorFor("network", undefined);
  }
  const text = await res.text().catch(() => "");
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const err = (json ?? {}) as { code?: unknown; message?: unknown };
    const code = isRemoteErrorCode(err.code) ? err.code : codeForStatus(res.status);
    // A proxy in front of the remote server (tailscale serve with the api gone) answers 502/504
    // without our JSON: that is the computer being unreachable, not a refusal.
    if (json === undefined && (res.status === 502 || res.status === 504)) throw errorFor("network", undefined, res.status);
    throw errorFor(code, typeof err.message === "string" ? err.message : undefined, res.status);
  }
  return json as T;
}

const sid = (id: string) => `/sessions/${encodeURIComponent(id)}`;

export const api = {
  pair: (req: RemotePairRequest) => call<RemotePairResponse>("POST", "/pair", null, req),
  me: (key: string) => call<RemoteMe>("GET", "/me", key),
  sessions: (key: string) => call<RemoteList>("GET", "/sessions", key),
  transcript: (key: string, id: string) => call<TranscriptEntry[]>("GET", `${sid(id)}/transcript`, key),
  message: (key: string, id: string, req: RemoteMessageRequest) => call<{ ok: true }>("POST", `${sid(id)}/message`, key, req),
  answer: (key: string, id: string, res: RpcExtensionUIResponse) =>
    call<{ ok: true }>("POST", `${sid(id)}/answer`, key, { res } satisfies RemoteAnswerRequest),
  stop: (key: string, id: string) => call<{ ok: true }>("POST", `${sid(id)}/stop`, key),
  pushOn: (key: string, sub: RemotePushSubscription) => call<{ ok: true }>("PUT", "/push", key, sub),
  pushOff: (key: string) => call<{ ok: true }>("DELETE", "/push", key),
};
