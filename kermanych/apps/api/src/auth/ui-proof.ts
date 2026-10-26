// apps/api/src/auth/ui-proof.ts
// Who may hand the local api a session (POST /api/auth/session, the one @Public() route).
// Any valid Supabase JWT is NOT enough: sign-in is open to every GitHub account, and the api
// answers CORS `*` on 127.0.0.1, so any web page in the operator's browser could push its
// own throwaway account's token and from then on drive the api — and the /terminal socket —
// as the operator. The handoff is accepted only from the app's own ui, which proves itself
// in one of three ways (docs/specs/2026-10-26-auth-session-handoff-proof.md):
//
//   1. the current bearer (AuthController checks it via AuthService.userForToken) — every
//      token refresh of a signed-in ui;
//   2. the per-launch key the desktop app generates, hands to this api through
//      `bootstrap({ uiKey })` and to its own renderer only, through the preload — sent in
//      the `x-kermanych-ui-key` header;
//   3. the request's Origin being one of the trusted ui origins — the dev ui of a
//      standalone api (`pnpm dev:ui` on :5317). A browser sets Origin itself; a page
//      cannot forge it. `null` (file://, sandboxed iframes) is never trusted.
import { timingSafeEqual } from "node:crypto";

export const UI_KEY_HEADER = "x-kermanych-ui-key";

// `pnpm dev:ui` (apps/ui/quasar.config.ts), under both names of the loopback host.
export const DEV_UI_ORIGINS: readonly string[] = ["http://localhost:5317", "http://127.0.0.1:5317"];

export interface UiProof {
  // The desktop app's per-launch key; undefined for a standalone api.
  key?: string;
  // Exact Origin values whose requests are the app's ui.
  origins: readonly string[];
}

// Nothing is trusted until bootstrap() configures it: an api built without it (a test module)
// accepts only the current bearer.
let configured: UiProof = { origins: [] };

export function setUiProof(proof: UiProof): void {
  configured = proof;
}

// What bootstrap() configures. The desktop app (a key) trusts no origin: its renderer always
// has the key, and the dev ui's port could be any local page there. A standalone api trusts
// the dev ui. `KERMANYCH_UI_ORIGINS` (comma-separated) overrides the origin list either way,
// e.g. for a dev ui moved off :5317.
export function uiProofFor(key: string | undefined, envOrigins: string | undefined): UiProof {
  const listed = envOrigins
    ?.split(",")
    .map((o) => o.trim())
    .filter((o) => o && o !== "null");
  const origins = listed ?? (key ? [] : DEV_UI_ORIGINS);
  return key ? { key, origins } : { origins };
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// True when the request carries the per-launch key or comes from a trusted ui origin. Header
// names arrive lower-cased from Node's http parser.
export function provesAppUi(
  headers: Record<string, string | string[] | undefined>,
  proof: UiProof = configured,
): boolean {
  const key = header(headers, UI_KEY_HEADER);
  if (proof.key && key && sameSecret(key, proof.key)) return true;
  const origin = header(headers, "origin");
  return origin !== undefined && proof.origins.includes(origin);
}
