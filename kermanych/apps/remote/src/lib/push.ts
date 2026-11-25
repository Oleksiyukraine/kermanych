// Web Push on the phone (spec decision 4; Platforms: iOS only from the home-screen app, 16.4+;
// Chrome on Android also from the browser). The subscription is made with the computer's VAPID
// key (`RemoteMe.vapidPublicKey`) and handed to the remote server with PUT /push; turning it off
// is DELETE /push, then unsubscribing here.

import { reactive } from "vue";
import type { RemotePushSubscription } from "@kermanych/core";
import { base64UrlToBytes } from "./bytes";
import { isIos, isStandalone } from "./device";
import { t } from "./i18n";
import { actions, state } from "./store";

/**
 * supported    — service worker + PushManager + Notification exist.
 * ios_install  — iPhone/iPad outside the home-screen app: push exists only after installing.
 * unsupported  — this browser cannot receive Web Push at all.
 */
export type PushSupport = "supported" | "ios_install" | "unsupported";

export function pushSupport(): PushSupport {
  const has = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (isIos() && !isStandalone()) return "ios_install";
  return has ? "supported" : "unsupported";
}

/** `subscribed` is `undefined` while the phone is still looking for its subscription. */
export const pushState = reactive<{ subscribed: boolean | undefined; permission: NotificationPermission | undefined }>({
  subscribed: undefined,
  permission: "Notification" in window ? Notification.permission : undefined,
});

/** Registered at startup (no gesture needed), so the click only has to ask for permission. */
export function registerWorker(): Promise<ServiceWorkerRegistration> | undefined {
  if (!("serviceWorker" in navigator)) return undefined;
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== "supported") return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

function toRemoteSubscription(sub: PushSubscription): RemotePushSubscription {
  const json = sub.toJSON();
  return {
    endpoint: sub.endpoint,
    expirationTime: sub.expirationTime,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
  };
}

/**
 * Once per launch with a key: find this phone's subscription and hand it to the computer again.
 * A re-paired phone is a new device row, and PUT /push is idempotent, so this keeps the computer
 * in step without asking the operator anything.
 */
export async function checkPush(): Promise<void> {
  try {
    const sub = await currentSubscription();
    pushState.subscribed = sub !== null && pushState.permission === "granted";
    if (sub && pushState.subscribed && state.key) await actions.pushOn(toRemoteSubscription(sub));
  } catch {
    // The banners (store.noteError) already say why the computer was not reached; the panel
    // shows what this phone itself knows.
    pushState.subscribed ??= false;
  }
}

/**
 * «Увімкнути сповіщення». Must be called straight from the click: iOS grants `requestPermission`
 * only inside a user gesture, so it is the first thing this does, before any other await.
 */
export async function enablePush(): Promise<void> {
  const permission = await Notification.requestPermission();
  pushState.permission = permission;
  if (permission !== "granted") throw new Error(permission === "denied" ? t("push.denied") : t("push.notGranted"));
  const vapid = state.me?.vapidPublicKey;
  if (!vapid) throw new Error(t("error.network"));
  await registerWorker();
  const reg = await navigator.serviceWorker.ready;
  // A subscription made with another computer's VAPID key cannot be reused — subscribe() would
  // refuse it — so any earlier one is dropped first.
  await (await reg.pushManager.getSubscription())?.unsubscribe();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(vapid) });
  await actions.pushOn(toRemoteSubscription(sub));
  pushState.subscribed = true;
}

/** «Вимкнути сповіщення»: the computer forgets the endpoint first, so a failure changes nothing. */
export async function disablePush(): Promise<void> {
  await actions.pushOff();
  await (await currentSubscription())?.unsubscribe();
  pushState.subscribed = false;
}
