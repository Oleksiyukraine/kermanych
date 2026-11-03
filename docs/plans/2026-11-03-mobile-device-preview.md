# Plan: mobile device preview

Task document: `docs/specs/2026-11-03-mobile-device-preview.md`. Paths below are relative to
`kermanych/` unless they start with `docs/`.

## Order and risks

- **Contracts first**, so that three slices can run in parallel against them:
  - `packages/core/src/{platform,preview,device,index}.ts`: the gates, the `device` block, the
    state, the HTTP and socket shapes;
  - `apps/api/src/device/device.contract.ts`: `DeviceApi` under the `DEVICE_API` token.
- **Only the device slice boots real simulators and emulators.** The other slices use fakes, so the
  shared machine never holds more than the device slice's test devices.
- **serve-sim is pinned to an exact version.** A bump is a deliberate change.
- **No cloud migration.** The two new columns are local SQLite (registry), added the additive way.

## HTTP / socket contract (between the slices)

| Route | Owner | Shape |
|---|---|---|
| `GET /sessions/:id/device` | device | → `DeviceInfo` |
| `PUT /projects/:id/device-choice` | device | `DeviceChoice` → `DeviceChoice` |
| `PUT /sessions/:id/device/pause` | device | `{paused}` → `{paused}` |
| `POST /sessions/:id/device/pick` | device | `{x, y}` (fractions) → `DevicePick` |
| `GET /sessions/:id/device/screenshot` | device | → `image/png` |
| socket.io `/device` | device | `watch` / `unwatch` / `input` / `frame` (core `device.ts`) |
| `POST /sessions/:id/preview` | preview | `{restart?, platform?, base?}` → `PreviewState` |
| `POST /sessions/:id/preview/app` | preview | `{action: "launch" \| "terminate" \| "restart"}` → `PreviewState` |

## Steps

1. **Contracts.** [x]
   - Files: `packages/core/src/{platform,preview,device,index}.ts`,
     `packages/core/test/preview-device.spec.ts`, `apps/api/src/device/device.contract.ts`.
   - Check: core `tsc --noEmit` and `vitest run`.
2. **Device slice.** `DeviceService` (implements `DeviceApi`), the iOS driver (`simctl` +
   serve-sim), the Android driver (`emulator` gRPC + `adb`), clones and the orphan sweep, the local
   registry columns, `http/device.controller.ts`, `ws/device.gateway.ts`, the dependencies, and
   `asarUnpack`. [x]
   - Files:
     - `apps/api/src/device/*`, `apps/api/src/http/device.controller.ts`,
       `apps/api/src/ws/device.gateway.ts`;
     - `apps/api/src/registry/registry.service.ts`, `apps/api/src/app.module.ts`,
       `apps/api/package.json`, `pnpm-lock.yaml`, `apps/ui/quasar.config.ts`;
     - `apps/api/test/device*.spec.ts`.
   - Check: api `tsc --noEmit`, `vitest run`, and a throwaway script against a real iPhone
     simulator and a real AVD: clone, boot, frames, tap, type (Cyrillic too), tree, pick, app
     launch/exit, shutdown, remove.
3. **Preview slice.** The `device` step, `install`, app readiness and exit, the device log step,
   `platform` / `base` on start, `…/preview/app`, the gates through
   `platformHasPreview` / `platformHasDevice`, the `device_*` tools, the pause, the supervisor's
   lifecycle (remove on finish and delete, shutdown on archive, the platform switch), and the
   `preview-config` skill. [x]
   - Files:
     - `apps/api/src/preview/*`, `apps/api/src/browser/browser-mcp.service.ts`,
       `apps/api/src/http/sessions.controller.ts`, `apps/api/src/supervisor/supervisor.service.ts`;
     - `packages/core/src/skills.ts`;
     - `apps/api/test/{preview,browser-mcp,finish,supervisor.discard}.spec.ts`.
   - Check: api `tsc --noEmit`, `vitest run`.
4. **UI slice.** The «Пристрій» tab, `KDevicePane` (canvas, input, toolbar, picker, picks),
   `useDeviceStream`, the preview row's device states, device picks in the tray, the platform
   note, and i18n. [x]
   - Files: `apps/ui/src/{components/kit,composables,lib,pages,stores}/…`, i18n,
     `apps/ui/test/*`.
   - Check: ui `vue-tsc`, `vitest run`.
5. **Integration.** [x]
   - The README.
   - Full type checks and test suites (≤ 4 workers, one run at a time): core 271, api 1274 (+4
     skipped), ui 851 pass; `tsc` / `vue-tsc` clean.
   - Review pass: 7 findings fixed (deleted-base start, project choice overwritten by ▶, ↻ not
     restarting the app, Android console-port race, iOS boot abort leak, Android rotation,
     startup sweep vs. a booting clone).
   - Smoke, api on an isolated DB + the web build in the browser pane:
     - fixture (`com.apple.Preferences` / `com.android.settings`) on iOS 26.0, iOS 18.3 and
       Android API 32: real `device_*` calls over the MCP endpoint (snapshot, tap by ref, stale
       ref refused, Cyrillic typing, wait_for, back refused on iOS, open_url, app
       restart/terminate → «Застосунок впав», pause refusal), the tab's live screen (JPEG and
       RGB888), operator tap, «◎ Вказати», the re-clone confirm iOS → Android (old clone
       deleted), ↻ keeping the emulator's pid, ◼ (device down, clone kept), ◼ during a boot (no
       booted clone left), delete (clone, emulator, serve-sim gone);
     - the device path under Electron's own runtime (`ELECTRON_RUN_AS_NODE`): 112 frames in 3 s;
     - Flutter 3.47.9 (`brew install --cask flutter`), a `flutter create` app with
       `flutter run -d $DEVICE_ID` as the `"device": true` service: running on iOS (~45 s
       first build) and Android (~5 min first Gradle build), hot reload by `kill -USR1` showed
       the new text in `device_snapshot`, `device_tap` on «Increment» worked on both;
     - g-app itself does not build on this machine: `lib/firebase_options.dart`,
       `android/app/google-services.json` and `.env.*` are not in the repository (nor in the
       operator's checkout). Kermanych ran device → setup → `flutter run` and showed the
       build's own error in the row. The operator's final check on g-app needs those files.
   - Not exercised: the packaged dmg (`asarUnpack` of serve-sim), a real agent driving the tools
     through omp/claude (the tools were called over the same MCP endpoint), «Доручити агенту» on a
     Mobile project.
