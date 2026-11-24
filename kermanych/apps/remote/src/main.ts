import { createApp } from "vue";
import "@kermanych/tokens/tokens.css";
import "@kermanych/tokens/fonts.css";
import "./styles.css";
import App from "./App.vue";
import { lang } from "./lib/i18n";
import { registerWorker } from "./lib/push";
import { resume, start } from "./lib/store";

document.documentElement.lang = lang;

// The service worker carries only push (public/sw.js). Registering it needs no gesture, so it is
// done now; the «Увімкнути сповіщення» click then only asks for permission (iOS's rule). A refusal
// here (not a secure context, storage off) is not shown: enablePush registers again and that
// failure reaches the operator next to the button.
registerWorker()?.catch(() => undefined);

// A notification tapped while the app is open: sw.js asks the page to route itself when its
// own `client.navigate` is refused.
navigator.serviceWorker?.addEventListener("message", (ev: MessageEvent<{ type?: string; url?: string }>) => {
  if (ev.data?.type === "open" && ev.data.url) location.hash = new URL(ev.data.url, location.href).hash;
});

// iOS freezes a backgrounded web app with its socket; coming back reconnects at once.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resume();
});

start();
createApp(App).mount("#app");
