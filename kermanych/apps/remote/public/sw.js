// «Пульт»'s service worker: Web Push only (spec decision 4). No fetch handler and no cache —
// the client is useless without the computer anyway, and leaving `fetch` alone keeps every
// navigation and api call going straight to the network.
//
// The payload is `RemotePush` (packages/core/src/remote.ts): project, session title, kind — never
// conversation text, since it travels through Apple's or Google's push service.

const TEXTS = {
  uk: { input: "Агент чекає на вашу відповідь", error: "Агент зупинився з помилкою" },
  en: { input: "The agent is waiting for your answer", error: "The agent stopped with an error" },
};

function texts() {
  const lang = (self.navigator && self.navigator.language) || "";
  return lang.toLowerCase().startsWith("uk") ? TEXTS.uk : TEXTS.en;
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let push;
  try {
    push = event.data ? event.data.json() : undefined;
  } catch {
    push = undefined;
  }
  if (!push || !push.sessionId) return;
  const t = texts();
  event.waitUntil(
    self.registration.showNotification(`${push.project}: ${push.title}`, {
      body: push.kind === "error" ? t.error : t.input,
      tag: push.sessionId,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: push,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.sessionId ? `/#/s/${encodeURIComponent(data.sessionId)}` : "/";
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of open) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        // navigate() can be refused for an uncontrolled client; a message lets the page route itself.
        try {
          await client.navigate(url);
        } catch {
          client.postMessage({ type: "open", url });
        }
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
