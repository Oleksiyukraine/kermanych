// Every hyperlink the app opens belongs in the user's default browser (Chrome, Arc, …),
// never in a second Electron window. Like oauth-loopback.ts this imports no runtime
// value from `electron` — main injects `shell.openExternal` — so it runs in isolation.
//
// Only web/mail schemes reach the OS: a `file:` or custom-protocol URL from rendered
// markdown must not launch a local program.
import type { BrowserWindow } from 'electron';

const EXTERNAL_PROTOCOLS: Record<string, true> = { 'http:': true, 'https:': true, 'mailto:': true };

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

export function routeLinksToDefaultBrowser(
  win: BrowserWindow,
  openExternal: (url: string) => Promise<unknown>,
): void {
  const open = (url: string): void => {
    const protocol = parseUrl(url)?.protocol;
    if (protocol && EXTERNAL_PROTOCOLS[protocol]) void openExternal(url);
  };
  // `target="_blank"` links and `window.open(url)`. Denying also covers the preview's
  // `window.open('')` placeholder: it gets `null` and opens the URL itself once ready.
  win.webContents.setWindowOpenHandler(({ url }) => {
    open(url);
    return { action: 'deny' };
  });
  // A plain link to another origin would otherwise replace the app in this window, and so
  // would a relative one (`docs/spec.md` from an agent's markdown): it resolves against the
  // app's own origin — `file://` in production, the Vite server in dev — and loads a page
  // that is not the app, leaving the window on the boot splash. Only the app's own document
  // (a reload) may load here; the renderer opens repo paths itself (lib/log-links.ts).
  win.webContents.on('will-navigate', (event) => {
    const to = parseUrl(event.url);
    const at = parseUrl(win.webContents.getURL());
    if (to && at && to.origin === at.origin && to.pathname === at.pathname) return;
    event.preventDefault();
    if (to && to.origin !== at?.origin) open(event.url);
  });
}
