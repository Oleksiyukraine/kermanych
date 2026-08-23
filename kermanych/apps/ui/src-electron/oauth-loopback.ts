// One-shot loopback listener for the desktop OAuth round trip. Electron's window
// cannot receive a browser redirect, and no custom protocol is registered
// (app.setAsDefaultProtocolClient / protocol.handle / open-url are all absent),
// so a loopback redirect is the only wired-up-able path.
//
// The port is FIXED, not probed. It is baked into Supabase's redirect allow-list
// (supabase/config.toml additional_redirect_urls) and into LOOPBACK_REDIRECT in
// src/stores/auth.ts; a drifting port would produce a redirect URL Supabase
// refuses. If 53170 is taken we fail loudly with EADDRINUSE instead.
import { createServer, type Server } from 'node:http';

export const OAUTH_PORT = 53170;
export const OAUTH_REDIRECT = `http://127.0.0.1:${OAUTH_PORT}/callback`;

const TIMEOUT_MS = 120_000;

let active: Server | undefined;

// Called on completion, on failure, and from before-quit — a stray listener would
// keep a handle open and block the app from quitting.
export function closeLoopback(): void {
  active?.close();
  active = undefined;
}

export async function startLoopbackOAuth(
  authorizeUrl: string,
  open: (url: string) => Promise<unknown>,
): Promise<{ code: string }> {
  closeLoopback();
  const { promise, resolve, reject } = Promise.withResolvers<{ code: string }>();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', OAUTH_REDIRECT);
    const code = url.searchParams.get('code');
    const failure = url.searchParams.get('error_description') ?? url.searchParams.get('error');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      code
        ? '<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:40px">Готово. Повертайтесь до Kermanych.</body>'
        : '<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:40px">Не вдалося увійти. Повертайтесь до Kermanych.</body>',
    );
    if (code) resolve({ code });
    else reject(new Error(failure ?? 'oauth callback carried no code'));
  });

  active = server;
  server.once('error', (err) => reject(err));
  server.listen(OAUTH_PORT, '127.0.0.1');

  const timer = setTimeout(
    () => reject(new Error(`oauth timed out after ${TIMEOUT_MS / 1000}s`)),
    TIMEOUT_MS,
  );

  void open(authorizeUrl);

  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    closeLoopback();
  }
}
