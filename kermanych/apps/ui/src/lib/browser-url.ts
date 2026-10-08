// What the session browser (docs/specs/2026-10-05-embedded-browser.md) may load, and how a
// typed address becomes a URL. Shared by Electron main (the agent's browser_navigate and the
// renderer's navigate IPC) and the Браузер tab's address bar, so both read an address alike.
// Pure: no DOM, no electron.

const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i;

// The agent or the operator types `localhost:5173` as often as a full URL. A bare local host
// gets http:// (dev servers are plain http), any other bare host https://. http(s) and
// about:blank like every page-initiated navigation; data: too for an explicit load (Chromium
// refuses page-initiated top-level data: navigations on its own).
export function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) throw new Error('No URL to open');
  if (s === 'about:blank') return s;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[\w.-]+:\d+(?:[/?#]|$)/.test(s);
  const full = hasScheme ? s : (LOCAL_HOST.test(s) ? 'http://' : 'https://') + s;
  let url: URL;
  try {
    url = new URL(full);
  } catch {
    throw new Error(`Not a URL: ${raw}`);
  }
  if (!['http:', 'https:', 'data:'].includes(url.protocol)) throw new Error(`Only http(s) pages open in the session browser, not ${url.protocol} (${raw})`);
  return url.href;
}

// The address bar: a URL-looking entry opens as normalizeUrl reads it; anything else (words,
// a phrase with spaces) is a web search, as in any browser.
export function addressToUrl(raw: string): string {
  const s = raw.trim();
  if (!s) throw new Error('No URL to open');
  const looksLikeUrl =
    !/\s/.test(s) && (/^[a-z][a-z0-9+.-]*:/i.test(s) || LOCAL_HOST.test(s) || /^[^/?#]+\.[a-z0-9-]{2,}(?:[:/?#]|$)/i.test(s));
  return looksLikeUrl ? normalizeUrl(s) : `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

// Page-initiated navigations (links, redirects, location=) the view follows.
export function navigationAllowed(url: string): boolean {
  if (url === 'about:blank') return true;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// Links the view hands to the OS instead (mail, phone) when the operator follows them.
export function isExternalScheme(url: string): boolean {
  return /^(mailto|tel|sms|facetime|callto):/i.test(url);
}
