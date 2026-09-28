// Can a Project Documentation link be drawn in an iframe? The browser will not tell the page
// that frames it — a refused frame just renders blank — so the local api fetches the page
// once and reads the two headers a site refuses framing with. Only headers are read; the body
// is cancelled unread and nothing is cached or forwarded.
//
// The fetch carries no cookies, and neither does the desktop app's iframe (its Chromium
// session is not the user's browser), so «needs a sign-in» shows up here the same way it
// would in the frame: a private Google Doc redirects to accounts.google.com, which answers
// X-Frame-Options: DENY.
import type { DocLinkEmbedCheck } from "@kermanych/core";

const TIMEOUT_MS = 6000;
// Some hosts serve a different page (and different headers) to a non-browser client; ask the
// way the iframe will.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// The header that refuses framing, or null when the page may be framed. CSP `frame-ancestors`
// wins over X-Frame-Options when both are present — that is the browsers' rule, and it is
// what lets a site allow specific embedders with CSP while sending XFO for old clients.
export function frameRefusal(headers: Headers): "x-frame-options" | "frame-ancestors" | null {
  // Multiple CSP headers arrive joined by ", "; each is a separate policy and every one is
  // enforced, so any policy whose frame-ancestors excludes us refuses.
  const csp = headers.get("content-security-policy");
  let sawFrameAncestors = false;
  if (csp) {
    for (const policy of csp.split(",")) {
      for (const directive of policy.split(";")) {
        const [name, ...sources] = directive.trim().split(/\s+/);
        if (name?.toLowerCase() !== "frame-ancestors") continue;
        sawFrameAncestors = true;
        // The app's own origin (localhost in dev, file:// in the desktop build) is never one a
        // site lists, so only a wildcard admits it.
        if (!sources.includes("*")) return "frame-ancestors";
      }
    }
  }
  if (sawFrameAncestors) return null;
  const xfo = headers.get("x-frame-options");
  if (xfo) {
    // DENY and SAMEORIGIN both refuse a cross-origin parent. ALLOW-FROM is obsolete and
    // ignored by current browsers, like any other unknown value.
    const values = xfo.split(",").map((v) => v.trim().toLowerCase());
    if (values.some((v) => v === "deny" || v === "sameorigin")) return "x-frame-options";
  }
  return null;
}

export async function checkEmbeddable(url: string, fetchImpl: typeof fetch = fetch): Promise<DocLinkEmbedCheck> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("not a URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("only http(s) links can be embedded");
  let res: Response;
  try {
    res = await fetchImpl(parsed, {
      redirect: "follow",
      headers: { "user-agent": BROWSER_UA, accept: "text/html,*/*;q=0.8" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { embeddable: null, reason: "unreachable" };
  }
  void res.body?.cancel().catch(() => undefined);
  const refusal = frameRefusal(res.headers);
  return refusal ? { embeddable: false, reason: refusal, status: res.status } : { embeddable: true, status: res.status };
}
