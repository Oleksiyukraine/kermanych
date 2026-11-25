// «Пульт»: pairing codes, device keys and their 30-day lapse (docs/specs/2026-11-24-mobile-remote-control.md,
// decision 5 and → Pairing and devices), and the registry rows behind them.
import { describe, expect, it } from "vitest";
import { REMOTE_DEVICE_IDLE_MS, REMOTE_PAIRING_ATTEMPTS, REMOTE_PAIRING_TTL_MS } from "@kermanych/core";
import { RegistryService } from "../src/registry/registry.service";
import { hashKey, Pairings, randomToken } from "../src/remote/pairing";
import { RemoteFeed } from "../src/remote/remote-feed";
import { RemoteFailure, RemotePhone } from "../src/remote/remote-phone";

describe("pairing codes", () => {
  it("are 32 random bytes plus six digits, and one pairing at a time", () => {
    const p = new Pairings();
    const first = p.create();
    expect(Buffer.from(first.code, "base64url")).toHaveLength(32);
    expect(first.short).toMatch(/^\d{6}$/);
    const second = p.create();
    expect(p.redeem(first.code)).toBe(false);
    expect(p.redeem(second.code)).toBe(true);
  });

  it("are spent by the first phone", () => {
    const p = new Pairings();
    const { code, short } = p.create();
    expect(p.redeem(` ${short} `)).toBe(true);
    expect(p.redeem(code)).toBe(false);
    expect(p.alive()).toBeUndefined();
  });

  it("expire after the TTL", () => {
    let now = 1_000_000;
    const p = new Pairings(() => now);
    const { code } = p.create();
    now += REMOTE_PAIRING_TTL_MS;
    expect(p.redeem(code)).toBe(false);
    expect(p.alive()).toBeUndefined();
  });

  it("are withdrawn after too many wrong codes", () => {
    const p = new Pairings();
    const { code, short } = p.create();
    const wrong = short === "000000" ? "111111" : "000000";
    for (let i = 0; i < REMOTE_PAIRING_ATTEMPTS - 1; i++) expect(p.redeem(i % 2 ? wrong : "not-the-code")).toBe(false);
    expect(p.alive()).toBeDefined();
    expect(p.redeem(wrong)).toBe(false);
    expect(p.alive()).toBeUndefined();
    expect(p.redeem(code)).toBe(false);
  });
});

describe("device keys", () => {
  it("are stored only as their SHA-256", () => {
    const key = randomToken();
    expect(hashKey(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashKey(key)).not.toContain(key);
    expect(hashKey(key)).toBe(hashKey(key));
    expect(randomToken()).not.toBe(key);
  });
});

describe("the registry rows", () => {
  it("reads «Пульт» as off with no port and no keys until written", () => {
    const r = new RegistryService(":memory:");
    expect(r.getRemoteSettings()).toEqual({ enabled: false });
    r.setRemoteSettings({ enabled: true, httpsPort: 8444, vapidPublic: "pub", vapidPrivate: "priv" });
    expect(r.getRemoteSettings()).toEqual({ enabled: true, httpsPort: 8444, vapidPublic: "pub", vapidPrivate: "priv" });
  });

  it("keeps paired phones by key hash, with their push subscription, and prunes the lapsed", () => {
    const r = new RegistryService(":memory:");
    const a = r.addRemoteDevice("iPhone · Safari", "hash-a", "2026-10-01T00:00:00.000Z");
    const b = r.addRemoteDevice("Android · Chrome", "hash-b", "2026-11-20T00:00:00.000Z");
    expect(() => r.addRemoteDevice("dup", "hash-a")).toThrow();
    expect(r.findRemoteDeviceByHash("hash-b")?.id).toBe(b.id);
    expect(r.findRemoteDeviceByHash("nope")).toBeUndefined();

    const sub = { endpoint: "https://push.example/x", expirationTime: null, keys: { p256dh: "p", auth: "a" } };
    r.setRemoteDevicePush(b.id, sub);
    expect(r.findRemoteDeviceByHash("hash-b")?.push).toEqual(sub);
    r.touchRemoteDevice(b.id, "2026-11-24T00:00:00.000Z");
    expect(r.findRemoteDeviceByHash("hash-b")?.lastSeenAt).toBe("2026-11-24T00:00:00.000Z");

    expect(r.pruneRemoteDevices("2026-10-25T00:00:00.000Z")).toEqual([a.id]);
    expect(r.listRemoteDevices().map((d) => d.id)).toEqual([b.id]);
    expect(r.removeRemoteDevice(b.id)).toBe(true);
    expect(r.removeRemoteDevice(b.id)).toBe(false);
  });
});

describe("the 30-day lapse", () => {
  function makePhone(now: () => number) {
    const registry = new RegistryService(":memory:");
    const changed: string[][] = [];
    const phone = new RemotePhone({
      registry,
      supervisor: { mergedSessions: () => [] } as never,
      auth: { current: () => ({ userId: "u", accessToken: "t" }) } as never,
      feed: new RemoteFeed({ sessions: () => [], projects: () => [] }),
      pairings: new Pairings(now),
      login: () => undefined,
      host: () => "h",
      vapidPublicKey: () => "",
      changed: (removed) => void changed.push(removed),
      now,
    });
    return { registry, phone, changed };
  }

  it("keeps a key used within 30 days and touches it at most once a minute", () => {
    const t0 = Date.parse("2026-11-24T12:00:00.000Z");
    let now = t0;
    const { registry, phone, changed } = makePhone(() => now);
    const d = registry.addRemoteDevice("p", hashKey("k"), new Date(t0 - REMOTE_DEVICE_IDLE_MS).toISOString());
    expect(phone.authenticate("k", undefined).id).toBe(d.id);
    expect(registry.findRemoteDeviceByHash(hashKey("k"))?.lastSeenAt).toBe(new Date(t0).toISOString());
    now += 30_000;
    phone.authenticate("k", undefined);
    expect(registry.findRemoteDeviceByHash(hashKey("k"))?.lastSeenAt).toBe(new Date(t0).toISOString());
    now += 30_000;
    phone.authenticate("k", undefined);
    expect(registry.findRemoteDeviceByHash(hashKey("k"))?.lastSeenAt).toBe(new Date(now).toISOString());
    expect(changed.every((r) => r.length === 0)).toBe(true);
  });

  it("refuses and removes a key unused for longer", () => {
    const now = Date.parse("2026-11-24T12:00:00.000Z");
    const { registry, phone, changed } = makePhone(() => now);
    const d = registry.addRemoteDevice("p", hashKey("k"), new Date(now - REMOTE_DEVICE_IDLE_MS - 1).toISOString());
    expect(() => phone.authenticate("k", undefined)).toThrow(RemoteFailure);
    expect(registry.listRemoteDevices()).toEqual([]);
    expect(changed).toEqual([[d.id]]);
  });
});
