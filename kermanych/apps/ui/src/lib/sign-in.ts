// «Увійти як» (docs/specs/2026-11-08-synergy-login-and-session-env.md, decision 2): the
// «Тестувальник» login path read against the page the session browser shows.

// Where the login page is: a path resolves on the page's origin, a full URL stays itself. Null
// with no path, or when the page is not a web page (about:blank, a load error).
export function loginUrlFor(pageUrl: string, loginPath: string): string | null {
  const path = loginPath.trim();
  if (!path || !/^https?:/i.test(pageUrl)) return null;
  try {
    const url = new URL(path, pageUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

// The page is the login page: the same origin and route, a trailing slash and the query aside.
// A hash router's `#/login` is its route.
export function isLoginPage(pageUrl: string, loginPath: string): boolean {
  const login = loginUrlFor(pageUrl, loginPath);
  if (!login) return false;
  const route = (u: URL): string => (u.hash.startsWith('#/') ? u.hash.slice(1).split('?')[0]! : u.pathname).replace(/\/+$/, '');
  const page = new URL(pageUrl);
  const target = new URL(login);
  return page.origin === target.origin && route(page) === route(target);
}
