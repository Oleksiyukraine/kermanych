// Hash routes, no router library: `#/` the list, `#/s/<id>` a session, `#pair=<code>` the QR's
// pairing link (RemotePairing.link). The hash keeps every route on the one `index.html` the
// remote server serves, and survives the home-screen app's start_url.

import { ref } from "vue";

export type Route = { name: "list" } | { name: "session"; id: string } | { name: "pair"; code: string };

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, "");
  const pair = /^pair=([^&]+)/.exec(h);
  if (pair) return { name: "pair", code: decodeURIComponent(pair[1]) };
  const session = /^\/s\/([^/?]+)/.exec(h);
  if (session) return { name: "session", id: decodeURIComponent(session[1]) };
  return { name: "list" };
}

export const route = ref<Route>(parseHash(location.hash));

window.addEventListener("hashchange", () => {
  route.value = parseHash(location.hash);
  if (route.value.name === "list") fromList = false;
});

export function go(hash: string): void {
  if (location.hash !== hash) location.hash = hash;
}

/** The open session was entered from the list in this page, so «Назад» can pop that entry. */
let fromList = false;

export function openSession(id: string): void {
  fromList = route.value.name === "list";
  go(`#/s/${encodeURIComponent(id)}`);
}

/**
 * Back to the list. Entered from the list: pop the history entry, so the system back gesture and
 * this button agree. Entered from a push notification: there is nothing behind it, so replace.
 */
export function goList(): void {
  if (fromList) {
    fromList = false;
    history.back();
  } else location.replace("#/");
}

/** Leaves `#pair=…` without leaving a history entry that would spend the code again on «Back». */
export function clearPairHash(): void {
  history.replaceState(null, "", "/#/");
  route.value = { name: "list" };
}
