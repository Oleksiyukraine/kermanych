/**
 * The VAPID public key (`RemoteMe.vapidPublicKey`, base64url without padding, as `web-push`
 * generates it) as the bytes `pushManager.subscribe({ applicationServerKey })` takes.
 */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
