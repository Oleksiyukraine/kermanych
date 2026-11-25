// apps/api/src/remote/pairing.ts
// «Підключити телефон» (docs/specs/2026-11-24-mobile-remote-control.md → Pairing and devices,
// decision 5). Why a QR at all: a tailnet can be shared with colleagues, so reaching the URL is not
// enough — only a phone that read the one-time code off THIS computer's screen controls it.
//
// - A pairing is a one-time code (32 random bytes) plus a 6-digit short form of it for typing into
//   the installed iOS web app, whose storage is apart from Safari's. It lives REMOTE_PAIRING_TTL_MS,
//   only one is alive at a time (a new one replaces it), it is spent by the first phone that
//   presents it, and REMOTE_PAIRING_ATTEMPTS wrong codes withdraw it: six digits are guessable
//   only when guessing is free.
// - The phone trades it for a device key (32 random bytes). The registry keeps only its SHA-256.
//
// Memory-only on purpose: a pairing does not survive an api restart, the operator just asks again.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { REMOTE_PAIRING_ATTEMPTS, REMOTE_PAIRING_TTL_MS } from "@kermanych/core";

export type Pairing = { code: string; short: string; expiresAt: number };

/** 32 random bytes, base64url: the pairing code and the device key alike. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What the registry stores of a device key: its SHA-256, hex. */
export function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

// Constant-time over any lengths: both sides are hashed to 32 bytes first, so neither the length
// nor the first differing byte of the presented code leaks through the answer time.
function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export class Pairings {
  private current?: Pairing & { wrong: number };

  constructor(private now: () => number = Date.now) {}

  /** A fresh pairing, replacing any earlier unused one. */
  create(): Pairing {
    const p = { code: randomToken(), short: String(randomInt(0, 1_000_000)).padStart(6, "0"), expiresAt: this.now() + REMOTE_PAIRING_TTL_MS };
    this.current = { ...p, wrong: 0 };
    return p;
  }

  /** The pairing still waiting for a phone, if any. */
  alive(): Pairing | undefined {
    const c = this.current;
    if (c && c.expiresAt <= this.now()) this.current = undefined;
    return this.current ? { code: this.current.code, short: this.current.short, expiresAt: this.current.expiresAt } : undefined;
  }

  withdraw(): void {
    this.current = undefined;
  }

  /**
   * Spends the pairing when `input` is its long code or its six digits. A wrong input counts
   * against the pairing; the REMOTE_PAIRING_ATTEMPTS-th withdraws it. True only for a match.
   */
  redeem(input: string): boolean {
    const c = this.alive() && this.current;
    if (!c) return false;
    const given = input.trim();
    const ok = /^\d{6}$/.test(given) ? sameSecret(given, c.short) : sameSecret(given, c.code);
    if (ok) {
      this.current = undefined;
      return true;
    }
    c.wrong++;
    if (c.wrong >= REMOTE_PAIRING_ATTEMPTS) this.current = undefined;
    return false;
  }
}
