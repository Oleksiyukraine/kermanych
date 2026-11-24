# «Пульт»: agents from a phone, through Tailscale

## Goal

The analysis proposed «Пульт»: the operator watches and steers the agents running on their
computer from a phone, paired by a QR code, straight to the computer, without the team's cloud.
Kermanych has no remote access at all today. The phone runs a web page served by the computer; no
native app. Every pair of the desktop app's platforms (macOS, Linux) and phones (iOS, Android) is
supported.

## Context

- The local api listens on `127.0.0.1` only (`apps/api/src/main.ts:62`) and answers CORS `*`
  (`main.ts:55`). Its auth rests on that: one cached bearer (`auth/auth.guard.ts`), the session
  handoff proven by the desktop app's per-launch key or a dev-ui Origin (`auth/ui-proof.ts`), and
  per-session MCP tokens on routes that say «listens on 127.0.0.1 only»
  (`http/browser-mcp.controller.ts:5`, `http/management-mcp.controller.ts:5`,
  `http/native.controller.ts:7`). Opening that api to a network is not an option.
- Everything the phone needs already has a route or a stream: `GET /sessions`,
  `GET /sessions/:id/transcript`, `POST /sessions/:id/message`, `/answer`, `/stop`
  (`http/sessions.controller.ts`), and the default socket.io namespace pushes a snapshot then every
  `supervisor.events$` event (`ws/events.gateway.ts`).
- Attention states the desktop already ranks (`apps/ui/src/lib/attention.ts`,
  `docs/specs/2026-09-29-sidebar-attention-status.md`): `waiting_input`, `error`/`conflict`,
  `done`/`in_review`.
- Native sessions (omp / claude / codex in their own pty): the status, `waiting_input` included,
  comes from hooks (`native/native-session.service.ts:708-790`); a message is pasted only when idle
  (`native_busy`); `answerUi` refuses them (`supervisor/supervisor.service.ts:3495`).
- Keep-awake: `holdAwake(holder, hold)` (`minion/keep-awake.ts`), holders `minion` and `schedule`;
  the desktop app's hook is `powerSaveBlocker` `prevent-app-suspension`
  (`apps/ui/src-electron/electron-main.ts:99`). A closed laptop lid without an external display
  still sleeps.
- The desktop app ships for macOS (`.dmg`) and Linux (AppImage) (README → «Desktop app (macOS,
  Linux)»); there is no Windows build.
- A page served over plain HTTP to a LAN address is not a secure context: no `crypto.subtle`, no
  service worker, no Web Push, no microphone. iOS delivers Web Push only to a web app added to the
  home screen, iOS 16.4+; Chrome on Android delivers it to a site without installing it.
- On Linux `tailscale serve` needs root unless the user was made the Tailscale operator once
  (`tailscale set --operator=<user>`, itself a root command).
- No earlier attempt at remote access exists in `git log --all` or `docs/specs`.

## Decisions

Settled with the operator one question at a time.

1. **The phone runs a web page served by the computer**, installable on the home screen (PWA). No
   native app, now or planned. Rejected: an App Store / Google Play app (Apple developer account,
   store review, a second codebase).
2. **Transport: Tailscale.** The phone reaches the computer through the operator's tailnet,
   `https://<host>.<tailnet>.ts.net:<port>`, with a real certificate from `tailscale serve`, so the
   page is a secure context and Web Push works. Works from anywhere, nothing goes through the
   team's cloud. Rejected: same Wi-Fi only over HTTP (sniffable key = remote code execution on the
   computer; no push); a relay through the team's Supabase with end-to-end encryption (cloud, twice
   the work, Realtime quotas); LAN by default plus optional Tailscale (two modes, the LAN one still
   insecure).
3. **First version scope:** the list of sessions with status and the «needs you» mark, the live
   conversation, sending a message (photos from the camera included), answering an agent's
   question, stopping an agent. Rejected for now: starting new sessions, diff / PR / merge,
   preview, session browser, terminal.
4. **Push notifications for `waiting_input` and `error`/`conflict`.** Not for finished work. No
   push while the operator is at the computer (see Design → Notifications and presence).
5. **A paired phone stays paired until it is disconnected**, and its key lapses after 30 days
   without use. Settings list «Підключені телефони»: name, paired at, last active, «Відключити».
   Why the QR at all: a tailnet can be shared with colleagues; reaching the URL is not enough, only
   a phone that scanned the one-time QR from this computer's screen controls it. Rejected: never
   lapses; a fixed 7-day key; pairing valid only until the app restarts.
6. **Kermanych sets up `tailscale serve` itself** when the operator turns «Пульт» on, on its own
   HTTPS port so an existing `serve` config of the operator's is untouched, and removes it when
   «Пульт» is turned off. Missing prerequisites (Tailscale not installed, not signed in, MagicDNS
   or HTTPS certificates off in the tailnet) are explained with a link. «Пульт» is off by default.
   Rejected: the operator runs the command by hand; ask for permission before the first change.
7. **On the computer: Налаштування → Застосунок → «Пульт»** (after «Сповіщення») holds everything —
   the switch, the Tailscale checks, «Підключити телефон» with the QR, the paired phones. **The
   bottom bar shows «Пульт · N телефонів»** while «Пульт» is on, a click opens that section: an
   always visible reminder that the computer is reachable from outside. Rejected: settings only
   (easy to forget it is on); a header icon (the header is full, the QR is needed once per phone).
   Placement: `docs/design/2026-11-24-mobile-remote/screens/proposed-spots@1280.png`.
8. **Native sessions are shown with limits:** status, conversation, a message when the agent is
   idle, stop. When a native agent asks, the phone says the answer is given on the computer; the
   push still arrives. Rejected: the agent's pty on the phone (a remote shell on the computer);
   hiding native sessions.
9. **Keep-awake while «Пульт» is on and at least one agent works or waits for an answer**, through
   a new `remote` holder of `holdAwake`. Rejected: awake all the time while «Пульт» is on (drains a
   laptop overnight); no change (the phone loses the computer exactly when an agent waits).
10. **Linux: Kermanych makes the user the Tailscale operator itself** with
    `pkexec tailscale set --operator=$USER` — the system's own password dialog, once. Without
    `pkexec` the section shows the `sudo` command to run. Rejected: always show the command; no
    Linux in the first version.

Settled without a question (no operator preference expected; correct them here if wrong):

- **Which sessions the phone lists:** the non-archived, non-chat sessions of every project on this
  computer, grouped by project, «needs you» first — the same set the sidebar's attention mark
  counts.
- **Signed out on the computer → the phone is refused** with «На комп'ютері не виконано вхід»;
  paired phones stay paired. Every action from the phone runs as the user signed in on the
  computer.
- **Phone language** follows the phone's browser: Ukrainian for `uk`, English otherwise.
- **Push payload** carries only the project, the session title and the kind («чекає відповіді» /
  «помилка»), never conversation text: it travels through Apple's or Google's push service.
- **Presence unknown → away.** Where the desktop cannot tell idle time or a locked screen (some
  Linux sessions, Wayland), the operator counts as away and the push is sent: a spare notification
  is cheaper than a missed question.

## Design

### Shape

```
phone (PWA) ──HTTPS──▶ tailscaled on the computer (`tailscale serve`, :<remote https port>)
                         └─▶ http://127.0.0.1:<remote port>  RemoteServer (in the api process)
                                ├─ static: the remote client
                                ├─ /remote/api/*  whitelisted actions → SupervisorService
                                └─ /remote/socket  filtered session events
```

`RemoteServer` is a second HTTP server inside the api process, separate from the Nest app on
`:4317`: its own port, no CORS, no route of the main api reachable through it. Only the
whitelisted handlers exist on it.

### Platforms

| | iPhone | Android |
|---|---|---|
| **macOS** | push only from the home-screen app, iOS 16.4+ | push in Chrome, installing optional |
| **Linux** | as macOS + iPhone, plus decision 10 | as macOS + Android, plus decision 10 |

### Pairing and devices

- «Підключити телефон» creates a one-time pairing code (32 random bytes, 5 minutes, one active at
  a time) and shows a QR of `https://<host>.<tailnet>.ts.net:<port>/#pair=<code>` plus a 6-digit
  short form of it for typing.
- The phone trades the code for a device key (32 random bytes). The registry stores only its
  SHA-256: new table `remote_devices` (id, name, key_hash, created_at, last_seen_at,
  push_subscription). A key unused for 30 days is refused and the row is removed by the next sweep.
- Every request and the socket handshake carry the device key. Pairing attempts are rate-limited.
- Defence in depth (to verify in implementation): `tailscale serve` adds `Tailscale-User-Login` to
  proxied requests; requests whose login differs from the computer's own tailnet login are refused.
- **To measure in implementation:** on iOS a home-screen web app has storage separate from Safari
  `[INFERENCE]`. If a key stored after scanning in Safari is not visible to the installed app, the
  installed app asks for the 6-digit short code of a fresh «Підключити телефон» instead.

### Whitelist

| Phone action | Backed by |
|---|---|
| list sessions | registry rows, projected to id, project, title, status, harness, native, last activity |
| conversation | `supervisor` transcript of one session |
| live updates | `supervisor.events$`, only session status / transcript events, same projection |
| send a message (text, images) | `supervisor.sendMessage` |
| answer a question | `supervisor.answerUi` (non-native) |
| stop | `supervisor.stopSession` |
| push subscribe / unsubscribe | `remote_devices.push_subscription` |

Nothing else: no env, files, diff, git, terminal, preview, settings, cloud.

### Tailscale

- Find the CLI: `tailscale` on `PATH`; on macOS also the App Store / standalone app bundle's binary.
- Checks shown in the section: installed, running and signed in (`tailscale status --json`),
  MagicDNS on and HTTPS certificates available; on Linux, whether this user is the operator.
- On: `tailscale serve --bg --https=<port> http://127.0.0.1:<remote port>`. Off and on quit:
  `tailscale serve --https=<port> off`. At startup with «Пульт» off, a leftover rule of ours (after a
  crash) is removed.
- Linux operator: decision 10.
- The exact CLI flags and the macOS bundle path are verified against the installed Tailscale
  during implementation.

### Notifications and presence

- Web Push with VAPID keys generated once and stored in the registry (`web-push` package in the
  api). Sent on a transition into `waiting_input` or `error`/`conflict`.
- **Presence:** no push while the operator is at the computer — the desktop app reports through a
  new `bootstrap({ presence })` hook whether the system idle time is under 2 minutes and the screen
  is not locked (Electron `powerMonitor`). Where that cannot be told, and for a standalone api
  without the hook, the operator counts as away.

### Client (`apps/remote`)

A small Vue + Vite app, not a route of `apps/ui`: the desktop bundle is heavy and expects the
Electron preload. Reuses `@kermanych/tokens` and `@kermanych/core` types. Screens: pairing, the
session list, a session (conversation, composer with camera, question form, stop). Web app
manifest and a service worker for push. The desktop app bundles its build; `RemoteServer` serves
it as static files.

### Desktop UI (`apps/ui`)

- `SettingsPage.vue`: new app section `app-remote` with the switch, the checks, the QR dialog and the
  device list. Async states per README → Design → Async states.
- Bottom bar: «Пульт · N телефонів» while on.
- i18n uk/en.

## Order of work

1. Registry: `remote_devices`, «Пульт» settings, VAPID keys. Core types.
2. `RemoteServer`: listener, pairing, device keys, whitelist, filtered socket.
3. Tailscale: detection, checks, serve on/off, cleanup, the Linux operator step.
4. Desktop: the settings section, the bottom-bar mark.
5. `apps/remote` client.
6. Web Push and the presence hook.
7. Keep-awake holder `remote`.
8. Documentation.

Estimate `[INFERENCE]`, not measured: about three weeks for one developer.

## Risks

- A stolen device key is control over agents that run shell commands on the computer.
  Mitigations: the whitelist, the tailnet boundary, the Tailscale identity check, 30-day lapse,
  «Відключити».
- iOS storage split between Safari and the installed app (Pairing and devices).
- Push on iPhone only on iOS 16.4+ and only from the home-screen app.
- Keep-awake (`powerSaveBlocker`) and presence (`powerMonitor`) on Linux depend on the desktop
  session `[INFERENCE]`; verified on a Linux machine during implementation.
- A closed laptop lid without an external display still sleeps; the phone shows «Комп'ютер
  недоступний».

## Testing

- Unit: pairing code single use and expiry, device key hash check, 30-day lapse, the whitelist
  refusing every other path, the event filter, presence suppressing push and unknown presence
  counting as away, the `remote` awake holder.
- Manual, needs Tailscale with HTTPS certificates on the computer and a phone on the same tailnet:
  turn on, scan, add to home screen, receive a push for a question, answer, stop, disconnect the
  phone and see it refused. On macOS + iPhone at least; Linux and Android where a device is at hand.

## Documentation

README: a new «Пульт» section (prerequisites per platform, turning on, pairing, what the phone can
do, security notes). CHANGELOG entry.

## Out of scope

Starting sessions, diff / PR / merge, preview, session browser, terminal, answering native agents'
questions from the phone, a native app, access without Tailscale, Windows.
