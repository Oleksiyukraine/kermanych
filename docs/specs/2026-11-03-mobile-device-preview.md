# Mobile device preview: a virtual iOS / Android device in the session

Deep analysis, session 2026-11-03. The operator asked for the analogue of the session browser and
live preview (`docs/specs/2026-11-03-session-browser-preview.md`) for mobile projects: Kermanych
boots a virtual device the way it opens the browser. Every decision below was settled with the
operator, one question at a time.

## Goal

- A **Mobile** project's session gets a «Пристрій» tab. Its preview boots a per-session copy of
  an iOS Simulator or Android Emulator, builds and installs the branch's app, and shows the device
  screen live inside Kermanych, the way Android Studio's «Running Devices» panel does.
- The operator taps, swipes and types on that screen with the mouse and keyboard, and can point
  the agent at an element («◎ Вказати»).
- The agent drives the same device through `device_*` tools and runs it through the existing
  `preview_*` tools.

## Context (before this change)

- **The platform gate** (`packages/core/src/platform.ts:14`): `platformHasBrowser` is false for
  `backend` and `mobile`. A Mobile project has no «Браузер» tab, no preview, no `browser_*` and no
  `preview_*` (gate sites: `browser-mcp.service.ts:525,577,682`, `preview.service.ts:268`,
  `supervisor.service.ts:950,1112`, `AgentsPage.vue:1967`, `DesignPage.vue:587`,
  `stores/browser.ts:113`).
- **The session browser** is an Electron `WebContentsView` driven over CDP from Electron main; the
  api reaches it in-process through `BrowserHost`. It exists only in the desktop app.
- **The live preview** (`apps/api/src/preview/preview.service.ts`) runs `.kermanych/preview.json`
  (`setup` plus ordered services, readiness by TCP port) in the api. It works in both builds.
- **No mobile tooling exists** in the code or docs: no `simctl`, `adb`, emulator, Expo or Flutter.

### What was measured on this Mac (macOS 27.0.1, Xcode 27.2, Android emulator 35.1.21)

| Probe | Result |
|---|---|
| `xcrun simctl boot` without Simulator.app | iPhone 16 (iOS 18.3) booted in ~19 s, headless; `simctl io screenshot` works (~0.4 s per frame) |
| AXe 1.8 CLI | Works headless, but each call is a fresh process: `tap` 1.0–1.1 s, `describe-ui` ~0.9 s. `batch --stdin` runs only after EOF, so no live drag |
| serve-sim 0.1.49 helper | Persistent per device: MJPEG/H.264 stream and WebSocket input. `gesture` CLI round trip 0.11 s including node start-up. Headless tap, `type` and `button home` work on iOS 18.3 and iOS 26.0 |
| `emulator -avd TinyApp -no-window -read-only -grpc 8599` | Booted in ~16 s; gRPC `streamScreenshot` gave 28.6 fps while scrolling; `sendTouch` works |

## Decisions

### 1. The device screen lives in the session, like Android Studio «Running Devices»

- Kermanych boots the device headless and draws its screen in the session tab. Operator input goes
  back to the device as touches and keys.
- No native Simulator / Emulator window is opened.

Rejected:
- native windows outside Kermanych (VS Code + Flutter style): many unlabelled windows with parallel
  sessions, no picks, the device outlives the session unnoticed;
- a native-window ⤤ button next to the embedded screen: an Android emulator started headless
  cannot open a window without a restart. It can be a later task.
- agent tools only, the operator seeing screenshots in the chat.

### 2. iOS and Android in this change

- One device abstraction with two drivers: iOS (`simctl` + serve-sim) and Android (`emulator`
  gRPC + `adb`).
- **Out of scope:** physical devices (iOS needs WebDriverAgent and signing; Android would be cheap
  through `adb` and can be a later task).

Rejected: Android first (the interface would be shaped by one driver), iOS first.

### 3. Tooling: serve-sim for iOS, the Android SDK's own emulator API

- **Prerequisites the developer installs.** Kermanych finds them and does not install them:
  - Xcode: `xcode-select -p`;
  - Android SDK: `ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then `~/Library/Android/sdk`.

  When one is missing, the preview row says what is missing and what to install.
- **iOS: serve-sim** (npm `serve-sim`, Apache-2.0, ~5 MB). It provides the stream, live touches,
  hardware buttons, typing and the accessibility tree from one persistent helper per device.
  - It is pinned to an exact version in `apps/api`'s dependencies and shipped in the dmg (the
    native parts in `asarUnpack`).
  - `KERMANYCH_SERVE_SIM=/path/to/serve-sim` overrides the bundled copy. It exists for an Xcode
    update that breaks the pinned version before a Kermanych release ships a new one.
  - serve-sim ships arm64 only: on an Intel Mac, iOS is unavailable with that reason.
- **Android:** the emulator's own gRPC API (`emulator -grpc`) for the screen and input, and `adb`
  for install, launch, the UI tree and logcat. The gRPC client is `@grpc/grpc-js` (pure JS). The
  `.proto` files are loaded at runtime from the SDK (`emulator/lib/`), so they always match the
  installed emulator.

Rejected:
- AXe (MIT, 46 MB CLI), first chosen as «bundled + override». The measurements above showed about
  1 s per action and no live drag, which is not the Android Studio feel asked for in decision 1.
- serve-sim for the operator plus AXe for the agent: two dependencies on private Apple APIs.
- downloading the tool on first use, or requiring `brew install` with an unpredictable version.

### 4. One device per session, a copy-on-write clone of a base device

- On the session's first start the chosen base device (decision 6) is cloned:
  - iOS: `xcrun simctl clone <base> kermanych-<sessionId>`;
  - Android: the base `.avd` directory is copied with `cp -c -R` (APFS clonefile) to
    `kermanych-<sessionId>.avd`. A matching `kermanych-<sessionId>.ini` is written, and the AVD
    name/paths in `config.ini` are rewritten.
- The clone keeps the base device's state (sign-ins, installed apps) and costs little disk until
  it diverges.
- ◼/▶ and ↻ keep the clone and its app data.
- The clone is deleted on «Завершити» and on every delete path. Archive keeps it.
- Orphans (`kermanych-*` devices and AVDs whose session no longer exists) are swept at api start,
  under the same rule as `PREVIEW_DIR`: only by an api on the machine's own registry.
- **Edge cases:**
  - A base iOS simulator that is booted, or a base AVD that is locked (running in Android Studio),
    cannot be cloned. The start fails with «закрийте `<device>`, щоб Kermanych міг зробити копію».
  - A base device deleted since the clone was made does not matter: the clone is independent.

Rejected:
- a fresh throw-away device on every start (`-read-only`): every ◼ loses the sign-in and data;
- one shared device with a «busy» lock: parallel agents on one mobile project would block each
  other.

### 5. The config: a `device` block in `.kermanych/preview.json`

Kermanych owns the device; the repository owns building and installing, the same split as the web
preview.

```json
{
  "setup": "flutter pub get",
  "services": [
    { "name": "app", "device": true, "command": "flutter run -d $DEVICE_ID" }
  ],
  "device": {
    "ios":     { "app": "grano.app.com" },
    "android": { "app": "grano.app.com" }
  }
}
```

```json
{
  "setup": "npm ci",
  "services": [{ "name": "metro", "command": "npx expo start --port $PORT" }],
  "device": {
    "ios":     { "app": "com.acme.app", "install": "npx expo run:ios --device $DEVICE_ID --no-bundler --port $PORT_METRO" },
    "android": { "app": "com.acme.app", "install": "npx expo run:android --device $DEVICE_ID --no-bundler --port $PORT_METRO" }
  }
}
```

- **`device`** (optional) has the keys `ios` and/or `android`, at least one. Each holds:
  - `app` (required): the bundle id or package. Kermanych uses it to launch the app, to tell that
    it is running, and to notice when it exits.
  - `install` (optional): a shell command that builds and installs the app on the device. It must
    exit 0 within 20 min, after which Kermanych launches `app`.
- **`"device": true` on a service** (at most one, only when the `device` block exists): this
  service installs and launches the app itself and keeps running (`flutter run`, a bundler that
  installs).
  - The TCP readiness rule does not apply to it. It is ready when the `app` process runs on the
    device (limit 20 min, for a first build).
  - Its exit is a crash of the preview, like any service.
  - It and `install` for the same platform are mutually exclusive: the file is invalid with both.
- **With a `device` block:**
  - `services` may be empty or omitted (a native app needs only `setup` + `install`);
  - no service may have `open: true` (a Mobile project has no browser).
  - Neither `install` nor a `device` service → Kermanych only launches `app`, which is already on
    the device.
- **Variables**, added to `PORT_<NAME>` / `PORT` / `PREVIEW_DIR` for `setup`, every service and
  `install`:
  - `DEVICE_ID`: the simulator UDID or the emulator serial (`emulator-5584`);
  - `DEVICE_PLATFORM`: `ios` or `android`;
  - `ANDROID_SERIAL` (Android only), which `adb`, Gradle and Flutter read by themselves.
- **Hot reload** of `flutter run` is the agent's own `kill -USR1` / `-USR2` on that process. The
  `preview-config` skill documents it, and there is no tool for it.
- A `device` block in a project whose platform is not Mobile gives the preview row the error
  «блок `device` працює лише для проєкту з платформою Mobile».

Rejected:
- a separate `.kermanych/device.json` (two files cross-referencing ports, two validators);
- Kermanych installing a built `.app` / `.apk` itself (no fit for `flutter run` / `expo run` with
  hot reload);
- `install` as the only path, exiting 0 (every change would need a ↻ with a full rebuild).

### 6. The base device is a choice on this machine, not in the file

- **Where it is chosen.** The device row offers the installed iOS simulators
  (`simctl list -j devices available`) and AVDs (`emulator -list-avds`), plus the platform when the
  file configures both.
- **Where it is stored.** Locally per project (registry SQLite, never the cloud), like the machine
  resource profile.
- **The default**, when nothing is chosen yet (for example the agent starts first):
  - iOS: the first iPhone of the newest runtime;
  - Android: the first AVD by name.

  The row shows what was picked, and it can be changed.
- `preview_start` takes an optional `platform: "ios" | "android"` when the file configures both.
- **The project's choice is the default for a session that has no clone yet.** A session with a
  clone keeps its base: changing the project's choice does not touch the other sessions' devices.
- **Changing the base device or the platform in a session's row** acts as ↻ with a re-clone for
  that session: the old clone is deleted and a new one is made from the new base. The new choice
  also becomes the project's default.

Rejected:
- device names in the file (AVD names and runtimes differ per machine);
- a file hint with a local override (two sources and a precedence rule, and an AVD name in the
  file means nothing on a teammate's machine).

### 7. No limit on concurrent devices

- Same as the web preview (decision 5 of 2026-11-03): no cap, no priority change.
- **Accepted risk:** a device costs about 2–3 GB of RAM (iOS ~1.5–2 GB; Android `hw.ramSize` plus
  ~1 GB of QEMU). Agents can boot devices without bound on a machine shared with other agents. A
  «Пристроїв одночасно» limit in the machine resource profile can be a later task.

Rejected: a profile limit that refuses (B), a limit that evicts the least recently used device (C).

### 8. A Mobile project's session has a «Пристрій» tab in place of «Браузер»

- **The tab.** It holds the same preview row (status, service chips, ▶/◼/↻, «Логи», «Доручити
  агенту»), the device picker, the screen and the device toolbar. It supports «Поруч із логом».
  The tab dot shows the preview status, as for the browser.
- **The gate:**

  | Platform | «Браузер» + `browser_*` | preview + `preview_*` | «Пристрій» + `device_*` |
  |---|---|---|---|
  | `web`, not set | yes | yes | no |
  | `mobile` | no | yes | yes |
  | `backend` | no | no | no |

  `platformHasBrowser` keeps its meaning. `platformHasDevice(p) = p === "mobile"` and
  `platformHasPreview(p) = platformHasBrowser(p) || platformHasDevice(p)` are added. Every current
  preview gate site switches to `platformHasPreview`.
- **Which sessions:**
  - `agent` sessions, managed and native;
  - discussion and review forks get no «Пристрій» tab: the device belongs to the agent session and
    forks have no preview;
  - chats have none.
- **Switching a project away from Mobile:** its devices stop (as previews stop today), and agents'
  `device_*` calls are refused.
- The «Дизайн» tab is unchanged: a Mobile project still shows its note in place of the canvas.

Rejected:
- both tabs on a Mobile project (for Expo web or an admin page). It can be added later without
  breaking this.
- letting the file, not the platform, decide which tab exists.

### 9. The operator's controls

- **Mouse:** click = tap, drag = a live touch drag (`begin`/`move`/`end` follow the cursor), wheel =
  scroll.
- **Keyboard,** while the screen has focus:
  - ASCII is sent as keys;
  - anything else (Cyrillic, emoji) goes through the device clipboard and a paste: iOS
    `simctl pbcopy` + Cmd+V, Android gRPC `setClipboard` + paste.
- **Toolbar:** the device picker (decision 6), Home, Back and Recents (Android), rotate,
  screenshot, and «◎ Вказати».
- **«◎ Вказати»:** a click picks the accessibility element under the point (serve-sim's tree on
  iOS, `uiautomator dump` on Android) together with a cropped screenshot. Picks go to the agent the
  same way as browser picks (`composePicksMessage`), with the element's type, label, id, value and
  frame instead of a CSS selector.
- **The «Агент» pause** refuses `device_*` actions as well as `preview_start` / `preview_stop`.
  Because the device also exists in the web build, this pause state lives in the api, not in
  Electron main.

Rejected: no picks in this change (B), view only (C).

### 10. Agent tools: `device_*`

The tools live in the same MCP server `kermanych`, behind the platform gate of decision 8, on the
per-session queue, and under the pause.

| Tool | Behaviour |
|---|---|
| `device_snapshot` | The accessibility tree as compact text with refs: `e12 Button "Увійти" [24,610 345×48]`. Coordinates are in points (iOS) / pixels (Android), the space every other tool takes |
| `device_screenshot` | PNG. With `path`, it is saved under the worktree's `docs/`, as `browser_screenshot` does |
| `device_tap` | By `ref`, by `label` / `id`, or by `x,y` |
| `device_swipe` | Between two points, or a direction (`up/down/left/right`) from a point or ref |
| `device_type` | Text into the focused field (non-ASCII through the clipboard, as in decision 9); `submit` presses Enter |
| `device_press` | `home`, `back`, `recents`, `lock`, `enter`, `volume_up`, `volume_down`. A button the platform lacks is refused |
| `device_wait_for` | Waits until a text or element appears in, or disappears from, the tree |
| `device_open_url` | A deep link: `simctl openurl` / `adb shell am start -a VIEW -d` |
| `device_app` | `launch` / `terminate` / `restart` of the file's `app` |
| `device_rotate` | `portrait` / `landscape` |

- A ref is bound to its snapshot. A ref from an older snapshot whose element is no longer at that
  place is refused with «зроби новий `device_snapshot`», rather than tapping blind.
- `preview_*` is unchanged, except:
  - `preview_start` takes `platform`;
  - `preview_logs` has the step `device`: the app's log (iOS `simctl spawn <udid> log stream` for
    the app's process; Android `logcat --pid` of the app, following a new pid), plus the device's
    own boot and exit lines.
- `browser_navigate`'s «no preview» hint is irrelevant on Mobile, because the browser tools are
  not listed there.

Rejected:
- a minimal set, with the rest through the agent's shell (it would need UDIDs and the right tools
  on `PATH`);
- reusing the `browser_*` names on Mobile (ambiguous descriptions, diverging semantics).

### 11. Lifecycle

| Event | What happens |
|---|---|
| ▶ | Steps `device` (clone if missing, boot, wait for boot completion; limit 3 min) → `setup` → services → `install` → launch `app` → running |
| ◼ | Services stop and **the device shuts down** (`simctl shutdown` / `adb emu kill`). The clone keeps its data |
| ↻ | Services stop, **the device keeps running**; `setup` → services → `install` → launch run again |
| Base device or platform changed | As ↻, with the old clone deleted and a new one made (decision 6) |
| **The app exits** (the `app` process is gone while running) | New state «застосунок впав». Services and the device keep running. The row turns red and offers «Запустити застосунок» (`device_app launch`). The step `device` logs show the exit |
| The device process exits (simulator or emulator) | «впало: `device`»: the rest stops, like a crashed service |
| A service crashes | As on the web: everything stops, the device included |
| «Завершити», closing a merged session, delete | Stop + device shutdown. Finish and delete also **delete the clone**. Archive stops and keeps the clone |
| Kermanych quits | Devices shut down; clones stay. Nothing restarts by itself after a relaunch |
| End of the agent's turn, stopping the agent, ✕ on the tab | Nothing stops |

- The app's liveness is polled every second while running:
  - iOS: `simctl spawn <udid> launchctl list`, matching `UIKitApplication:<app>`;
  - Android: `adb shell pidof <app>`.
- Launch:
  - iOS: `simctl launch <udid> <app>`;
  - Android: `adb shell monkey -p <app> -c android.intent.category.LAUNCHER 1`.

Rejected:
- ◼ keeping the device on with a separate «Вимкнути пристрій» (a forgotten device holds 2–3 GB, and
  there is no limit);
- an app exit counting as a crash of the whole preview (every app crash would cost a reboot and a
  rebuild).

### 12. The same device tab in both builds

- The device is driven from the api, not Electron main, so the web build shows the screen, takes
  input and supports picks the same way.
- The stream and input go over the `/device` socket.io namespace of the api, behind the same
  bearer check as `/terminal`. The api listens on `127.0.0.1` only, so the device is reachable from
  this machine only.

Rejected: the web build without the screen (B), no device in the web build (C).

### 13. Verification target

- A fixture without a build (see «Verification»).
- The operator's real Flutter project **g-app** (`~/Documents/Projects/FaynoSoft/grano/grano-app`,
  bundle id / applicationId `grano.app.com`).
  - It runs in Kermanych preview mode with an isolated DB, where g-app is registered as Mobile. The
    real project's cloud platform is not touched.
  - Nothing is committed to the g-app repository.
- The Flutter SDK is not installed on this Mac. It is installed for the check with
  `brew install --cask flutter` and stays afterwards (`brew uninstall --cask flutter` removes it).
- The operator runs his own final check on g-app afterwards.

Rejected: a throw-away Expo app in `/tmp` instead of the real project; the fixture only.

## Technical decisions (made in the analysis, not discussed separately)

- **Where the code lives.** A `DeviceService` in `apps/api/src/device/` with two drivers
  (`ios.driver.ts`, `android.driver.ts`) behind one interface:
  - `list`, `clone`, `boot`, `shutdown`, `remove`;
  - `screenshot`, `tree`, `touch`, `key`, `text`, `button`, `rotate`;
  - `openUrl`, `launch`, `terminate`, `appRunning`, `logs`.

  `PreviewService` gains the `device` step and calls it. No `DeviceHost` in Electron main.
- **Stream format.** The `/device` socket.io namespace: `watch {sessionId, width, height}` /
  `unwatch` / `input`, with binary `frame` events (`{kind:"jpeg"|"rgb888", width, height, data}`).
  The contract is in `packages/core/src/device.ts`.
  - iOS: serve-sim's MJPEG frames are passed through.
  - Android: gRPC `streamScreenshot` in RGB888, at the size the client asks for (the pane's pixel
    size).
  - The renderer draws on a `<canvas>`. A device is streamed only while a client is subscribed.
- **Input** goes over the same socket as JSON. Coordinates are normalised 0..1 and mapped by the
  driver.
- **Android ports.** The console/adb port is an even port in 5554–5584, so `adb` finds the
  emulator by itself. The gRPC port is a free port.
- **The serve-sim helper** is started per booted iOS device (`serve-sim --no-preview -p <free
  port> <udid>`) and stopped with the device. Kermanych talks to its stream and WebSocket on
  loopback.
- **Local storage** (registry SQLite, additive columns, never published to the cloud):
  - `projects.device_choice` (JSON: platform, iOS base UDID, Android base AVD);
  - `sessions.device` (JSON: platform, base, clone id).
- **State.**
  - `PreviewState.running` gains `device: {platform, name, id}` and `app: "running" | "exited"`.
  - The `starting` step can be `device`.
  - The snapshot and `preview_update` carry it unchanged.
- **Snapshot format** is shared by iOS and Android (`type "label" [x,y w×h]`, ids and values when
  present). Android's `uiautomator dump` XML is mapped to it: `class` → type, `text` /
  `content-desc` → label, `resource-id` → id.

## Changes

- **`packages/core`**:
  - `platform.ts`: `platformHasDevice`, `platformHasPreview`;
  - `preview.ts`: the `device` block, `"device": true` on a service, the optional `services` and
    the no-`open` rule with a `device` block, the variables, the state additions, the device
    shapes (base device list, choice);
  - `skills.ts`: the `preview-config` skill gains the mobile part (the block, the variables,
    Flutter / Expo / native examples, hot reload by signal).
- **`apps/api`**:
  - new `device/` (service, drivers, serve-sim helper process, gRPC client, clone/orphan sweep);
  - `preview/preview.service.ts`: the `device` step, `install`, the app-process readiness, the
    app-exit state, the device log step, the platform rule, re-clone on a base change;
  - `browser/browser-mcp.service.ts`: the `device_*` tools, `platform` on `preview_start`, gates by
    `platformHasPreview` / `platformHasDevice`, the device pause;
  - `http/device.controller.ts` and `ws/device.gateway.ts`: device info, choice, pause, pick,
    screenshot, and the `/device` stream namespace;
  - `http/sessions.controller.ts`: `platform` and `base` on the preview start, `POST …/preview/app`;
  - `supervisor.service.ts`: clone deletion on finish/delete, shutdown on archive/quit, the
    platform-switch stop through `platformHasPreview`;
  - `registry.service.ts`: the two local columns;
  - `package.json`: `serve-sim` (exact pin), `@grpc/grpc-js`, `@grpc/proto-loader`.
- **`apps/ui`**:
  - new `components/kit/KDevicePane.vue` (screen canvas, input, toolbar, picker, picks) and
    `composables/useDeviceStream.ts`;
  - `KPreviewRow.vue` / `useSessionPreview.ts`: device steps, platform choice, «застосунок впав» +
    «Запустити застосунок»;
  - `pages/AgentsPage.vue`: the «Пристрій» tab, its gating and «Поруч із логом»;
  - `lib/browser-picks.ts`: device picks;
  - `lib/preview-view.ts`: the new status texts;
  - `quasar.config.ts`: `asarUnpack` for serve-sim's native parts;
  - i18n uk/en.
- **Tests:**
  - core: the validator's `device` rules;
  - api: the device lifecycle against fake `simctl` / `adb` / emulator / serve-sim processes (clone,
    boot, app readiness, app exit, re-clone, orphan sweep, the gates);
  - ui: `preview-view` status texts and the picks message.

## Verification

- `packages/core`, `apps/api`, `apps/ui`: type checks and vitest (`--maxWorkers=4`).
- **Fixture in the dev app:**
  - setup: `install: "true"`, `app` = `com.apple.Preferences` / `com.android.settings`;
  - on both platforms: clone → boot → live screen → mouse tap and drag → typing, Cyrillic included
    → «◎ Вказати» → a real agent's `device_snapshot` / `device_tap` / `device_type`;
  - app exit (`simctl terminate` / `am force-stop`) → «застосунок впав» → «Запустити застосунок»;
  - then ◼, ↻ (device stays up), a base-device change (re-clone), «Завершити» (clone gone), and the
    web build's tab.
- **g-app** with Flutter: `flutter run` as the `device` service on iOS and Android; hot reload by
  `kill -USR1`; «Доручити агенту» writes the `device` block itself.

## Accepted risks

- **No limit on concurrent devices** (decision 7).
- **Private Apple APIs.** serve-sim drives the simulator through private frameworks, and an Xcode
  update can break it. The pin and `KERMANYCH_SERVE_SIM` mitigate this. The serve-sim README notes
  that Xcode 27 «Device Hub» may need a visible simulator window for keyboard input: typing was
  verified headless here on Xcode 27.2 with the iOS 18.3 and 26.0 runtimes, but not with an iOS 27
  runtime, which is not installed.
- **serve-sim is young** (0.1.x). Its helper protocol is internal to it, so a version bump is a
  deliberate change, tested before the pin moves.
- **Apple Silicon only for iOS** (serve-sim ships arm64).

## Documentation impact

`kermanych/README.md`:
- «Session browser» names the «Пристрій» tab for Mobile projects and the new platform table.
- A new «Mobile device preview» subsection under «Live preview»: prerequisites, the `device` block
  and variables, the device picker, the clone lifecycle, `device_*`, `KERMANYCH_SERVE_SIM`.
- The platform note (Mobile no longer means «no preview»), and the uk/en `platformNote` text.
