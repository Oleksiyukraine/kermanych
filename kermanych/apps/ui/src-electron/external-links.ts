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
  // A plain link to another origin would otherwise replace the app in this window.
  // Same-origin loads (Vite reload in dev, `file://` in production) stay here.
  win.webContents.on('will-navigate', (event) => {
    if (parseUrl(event.url)?.origin === parseUrl(win.webContents.getURL())?.origin) return;
    event.preventDefault();
    open(event.url);
  });
}
