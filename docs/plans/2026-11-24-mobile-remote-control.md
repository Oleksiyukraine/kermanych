# «Пульт» — implementation plan

Spec: `docs/specs/2026-11-24-mobile-remote-control.md`. Paths below are relative to `kermanych/`.
Shared types and rules: `packages/core/src/remote.ts` (already in place; `ServerEvent` has
`remote_update`).

## Contracts

### Main api (desktop ui, bearer-guarded, under `/api`)

| Route | Body | Answer |
|---|---|---|
| `GET /remote` | — | `RemoteState` |
| `PUT /remote` | `{ enabled: boolean }` | `RemoteState` (phase `starting` while serve is set up; the rest arrives as `remote_update`) |
| `POST /remote/recheck` | — | `RemoteState` after re-running the Tailscale checks (and serve, when enabled) |
| `POST /remote/operator` | — | `RemoteState` after `pkexec tailscale set --operator=$USER` (Linux) |
| `POST /remote/pairing` | — | `RemotePairing` (replaces any earlier unused pairing) |
| `DELETE /remote/devices/:id` | — | `RemoteState` |

Every change of `RemoteState` is also published as `{ type: "remote_update", state }` on
`supervisor.events$`.

### Remote server (phone, `http://127.0.0.1:<remote port>` behind `tailscale serve`)

Static: `/` serves `apps/remote`'s built `index.html`, assets, `manifest.webmanifest`, `sw.js`.
API under `REMOTE_API_PREFIX` (`/remote/api`), JSON, key in `REMOTE_KEY_HEADER`:

| Route | Body | Answer |
|---|---|---|
| `POST /pair` (no key) | `RemotePairRequest` — `code` is the long code or the 6 digits | `RemotePairResponse` |
| `GET /me` | — | `RemoteMe` |
| `GET /sessions` | — | `RemoteList` |
| `GET /sessions/:id/transcript` | — | `TranscriptEntry[]` |
| `POST /sessions/:id/message` | `RemoteMessageRequest` | `{ ok: true }` |
| `POST /sessions/:id/answer` | `RemoteAnswerRequest` | `{ ok: true }` |
| `POST /sessions/:id/stop` | — | `{ ok: true }` |
| `PUT /push` | `RemotePushSubscription` | `{ ok: true }` |
| `DELETE /push` | — | `{ ok: true }` |

Refusals: JSON `RemoteError`, 401 `unauthorized`, 403 `foreign_login`, 503 `signed_out`, 404,
400 for the rest. Socket.io at `REMOTE_SOCKET_PATH`, handshake `auth: { key }`, channel `event`
carrying `RemoteEvent`: `list` on connect, then `session` / `session_removed` / transcript events
of listed sessions only.

### Desktop app → api

`bootstrap({ presence })`: `() => "present" | "away" | "unknown"`; `unknown` counts as away.

## Steps

1. **Core contract** — `packages/core/src/remote.ts`, `types.ts` (`remote_update`), `index.ts`.
   Check: `pnpm --filter @kermanych/core build`. ✅
2. **Bucket rule in core** — move `bucketOf` / `Bucket` / `isTracked` from `apps/ui/src/lib`
   into `packages/core/src/buckets.ts` so the api lists the same sessions as the sidebar; ui
   importers switch to core. Check: ui `buckets.spec.ts` / `attention.spec.ts` pass. ✅
3. **Registry** — `remote_settings` (single row: enabled, https_port, vapid keys) and
   `remote_devices` in `apps/api/src/registry/registry.service.ts`. Check: registry spec. ✅
4. **Tailscale** — `apps/api/src/remote/tailscale.ts`: find the CLI (PATH, macOS bundle), status,
   serve on/off on our port, operator via `pkexec`. Check: unit spec over a fake runner. ✅
5. **Remote service and server** — `apps/api/src/remote/`: settings, pairing, device keys,
   whitelist routes, filtered socket, static client, identity check, keep-awake holder `remote`,
   Web Push with presence; `RemoteController` on the main api; module wiring; `bootstrap({ presence })`.
   Check: unit specs (pairing, keys, lapse, whitelist, events filter, push rule, awake holder). ✅
6. **Phone client** — `apps/remote` (Vue + Vite): pairing, list, session, composer with camera,
   answer, stop, manifest, service worker, push subscription, uk/en. Check: `vite build`, a run
   against a local RemoteServer over fake sessions (pair, list, answer, message, stop). ✅
7. **Desktop ui** — `app-remote` settings section, bottom-bar mark, store, i18n, api client;
   Electron `presence` hook; packaging of the client. Check: ui typecheck + specs, live preview
   (blocked phase and the bottom-bar mark). ✅ Not yet seen: the pairing dialog against a real
   tailnet, and the packaged app serving the client from its asar.
8. **Docs** — README «Пульт» and «Monorepo layout». ✅
9. **Manual on a real tailnet** — the spec's Testing checklist on macOS + iPhone (Tailscale serve,
   QR, home-screen install, push). Open.

## Risks and order

- Steps 3–5 before 6–7 can be exercised end to end; 6 and 7 build against the contracts above.
- No schema migration beyond two new tables (`CREATE TABLE IF NOT EXISTS`).
- The full flow (Tailscale serve, push, iOS install) needs a tailnet and a phone: manual checklist
  in the spec's Testing section.
