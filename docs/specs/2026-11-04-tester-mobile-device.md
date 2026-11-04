# «Тестувальник» on a Mobile project's device

- **Status:** decisions settled with the operator on 2026-11-04 (deep analysis, voice and chat; the
  clean start reworked after checking it against `flutter run`). Awaiting the go-ahead to implement.
- **Scope:** `packages/core` (`testerRefusal`, the tester contract, the login line),
  `apps/api` (`BrowserMcpService`: device and preview tools for a tester, the doer lock, the
  credential tool; `PreviewService`: the clean start; `apps/api/src/device`: clearing app data),
  `apps/ui` (the tester's «Пристрій» tab, the busy banner on the doer's tab, the QA button hint,
  the «Сторінка входу» hint), README.
- **Builds on:** `docs/specs/2026-11-04-qa-tester-agent.md`,
  `docs/specs/2026-11-03-mobile-device-preview.md`,
  `docs/specs/2026-11-04-session-env-and-tester-preview-gate.md`.

## Context (before this change)

Paths are relative to `kermanych/`.

- A Mobile project's «Виконати тестування» is refused with `platform`: `testerRefusal` requires
  `platformHasBrowser`, which is false for `mobile` (`packages/core/src/tester.ts:73`,
  `packages/core/src/platform.ts:15`).
- `tools/list` gives a tester `preview_*` only when the platform has a browser, and never
  `device_*` (`apps/api/src/browser/browser-mcp.service.ts:824-829`). `callPreview` refuses a tester
  on a device project (`:1016`). `callDevice` accepts only `kind === "agent"` (`:1077`) and acts on
  the caller's own session id: its device, its pause (`DeviceService.paused`), its snapshot refs
  (`deviceRefs`) and its action queue (`queues`).
- The agent session's device is its own clone of an iOS Simulator or an AVD (mobile spec,
  decision 4). App data survives preview restarts. `preview.json`'s `device.<platform>.app` names
  the bundle id / package.
- The app gets onto the device in one of two ways (mobile spec, decision 5). A `"device": true`
  service installs and launches it and keeps running: `flutter run -d $DEVICE_ID`, as g-app does.
  Otherwise the platform's `install` command runs and Kermanych launches `app`. `flutter run`
  exits when the app process dies, which `PreviewService` reports as `crashed`
  (`apps/api/src/preview/preview.service.ts:651-652`).
- `PreviewService.execute` boots the device, then terminates the previous run's app, then runs
  `setup`, the services and `install` (`preview.service.ts:410-471`). A ↻ keeps the device.
- «Змінні» (the session `.env`) is already on the device pane (`KDevicePane`).
- The default tester instruction (`packages/core/src/agents.ts:175-191`) and the contract
  (`testerContract`, `packages/core/src/tester.ts:168-185`) speak of the browser only.

## Decisions

### 1. The tester drives the doer's device and starts it clean once per run

The tester gets `device_*` and `preview_*`, and both act on the **doer's** device and preview:
`previewOwner` is applied to device calls too. The device's pause, snapshot refs and action queue
are keyed by the owner (the doer's id), so the device has one queue whichever session calls. There
is no second clone and no second set of services.

**The clean start is a preview start with `clean`.** `PreviewStartOptions` gains `clean: true`.
When it is set, `execute` clears the app's data right after the device has booted and the previous
app has been terminated (`preview.service.ts:424-431`), before `setup`, the services and `install`:

- **Android:** `adb -s <serial> shell pm clear <app>`. It is a no-op error when the app is not
  installed yet, and that is ignored.
- **iOS Simulator** has no clear-data command: `xcrun simctl uninstall <udid> <app>`, then
  `xcrun simctl keychain <udid> reset`, so no saved sign-in survives in the keychain.
- Then the run goes on as usual: the `"device": true` service or `install` puts the app back
  (an incremental build) and the app starts with empty data.

The clean step is logged under the `device` step. A failure fails the start at `device`, like any
other device error.

**When it happens.** The first `preview_start` of a tester run always restarts the doer's preview
with `{ restart: true, clean: true }`, whether it was running or not. Kermanych keeps a
per-tester-session `cleaned` flag in memory. Later `preview_start` calls in the same run (after a
crash, say) start without `clean`. Until the first clean start has run, the tester's `device_*`
calls are refused with «Start the preview with preview_start first: the run starts from a clean
app». `preview_status` and `preview_logs` stay allowed. A failed clean start leaves `cleaned` unset,
so the next `preview_start` tries again.

**The platform.** The tester's `preview_start` takes no `platform`: the run uses the doer's device
as it is (the running one, or the project's device choice when none runs). A `platform` argument
from a tester is refused.

**Cost.** Each run pays one incremental rebuild and reinstall. [INFERENCE] This is tens of seconds
for `flutter run` and up to 1–2 min for `expo run`. Measure it on g-app (iOS and Android) during
implementation and record the numbers here. A «Чистий старт» switch is added only if the
measurements call for it.

Side effect, accepted: the tester always tests a fresh build of the current worktree, never a
build the doer left behind after editing code without restarting.

Rejected:

- Clearing data in place on a running preview. This is the original version of this decision.
  The clear kills the app process, `flutter run` exits with it, and the preview of every
  `"device": true` project (g-app) crashes.
- A hybrid: in place for `install` projects, a restart for `"device": true` ones. Two code paths,
  an iOS copy-uninstall-reinstall of the `.app`, and a run that may test a stale build.
- The device as it is: dirty state hides first-sign-in bugs.
- A tester clone of its own: a second boot, build and install, double RAM/CPU, and two previews
  from one worktree, which goes against decision 6 of the tester spec.

### 2. The doer is locked out of the device while a tester runs

While a tester child of the session is not retired (`status !== "merged"`, the same test as the
`running` refusal), the doer's `device_*`, `preview_start` and `preview_stop` calls are refused with
«The device is busy with a «Тестувальник» run: wait until it ends». This covers `device_app`, which
is a `device_*` tool. `preview_status` and `preview_logs` stay allowed, since they only read.
Messages to the doer are still allowed (tester spec, decision 12). The operator's own ▶ / ◼ and
input are not locked: the operator decides.

The lock lasts until the run is retired: ⤴ «Передати виконавцю», «Відкинути», or the parent's
finish. ⤴ retires the tester **before** it sends the hand-off message, so the doer's first turn on
the failures finds the device free.

Rejected: both agents on one device. The verdicts would describe a state the other agent changed.

### 3. What the operator sees

- The tester session gets a «Пристрій» tab that shows the doer's device live with the same
  controls: ▶ / ◼, input, «Агент» pause, «Змінні», «Логи». The pane is bound to the doer's session
  id, so the pause and the preview row are the device's own and both tabs show the same state.
  The operator can step in, for example for an SSO sign-in the agent cannot pass.
- The doer's «Пристрій» tab shows the same screen with a banner «Пристрій зайнятий тестуванням»
  and a link that selects the tester session.

Rejected: the screen only in the doer's tab. The operator could not complete a sign-in from the
tester session it belongs to.

### 4. Credentials: `device_type_credential`

A new tester-only tool, `device_type_credential(account, field: "login" | "password", submit?)`,
types into the focused field on the device's queue. It is the device counterpart of
`browser_type_credential` (tester spec, decision 5). Kermanych resolves the value
(`credentialValue`). The call shows only the account name and the field. Neither the result nor an
error echoes the value (`maskSecret`). A value with characters the keyboard cannot type goes
through the device clipboard (mobile spec, decision 9). The clipboard is set to an empty string
right after, so the password does not stay on the device or in a synced Mac pasteboard.

### 5. «Сторінка входу» takes a deep link in a Mobile project

The same setting accepts a deep link (`myapp://login`). In a Mobile project, the login line of the
prompt tells the tester to open it with `device_open_url`. A value without a scheme (`/login`) is
ignored there, and the line says to find the sign-in screen in the app. The hint under the field
in `TesterPanel` depends on the project's platform.

### 6. A hint on the button, no dialog

In a Mobile project, «Виконати тестування» carries the hint «Дані застосунку на пристрої сесії буде
очищено, а превʼю перезапущено». There is no confirmation dialog.

### 7. The gate and the contract

- `testerRefusal` takes `platformHasPreview` and `platformHasBrowser` instead of the browser flag
  alone. `platform` refuses only a project with neither a browser nor a device (`backend`).
  `no-browser` applies only to projects with a browser (web in the web build): a device runs in
  the api, so a Mobile project can be tested in the web build too. A Mobile project needs a valid
  `preview.json` with a `device` block (the existing `no-preview`, since `PreviewService` already
  marks a Mobile config without `device` as invalid). The api guard and `lib/tester.ts` pass the
  same flags.
- The tester gets its tools on a Mobile project: `device_*`, `preview_*` (on the doer),
  `device_type_credential`, the QA and findings tools. Not `browser_*` and not
  `browser_type_credential`.
- `testerContract` takes the platform and gets a Mobile variant:
  - the first call is `preview_start` (decision 1); everything happens on the device with
    `device_*`, and where the instruction above says browser or page, read device or screen;
  - a screenshot for every `failed` item with `device_screenshot` and `path` set to
    `<dir>/<itemId>.png`, saved into the doer's worktree as browser screenshots are;
  - type logins and passwords only with `device_type_credential`.

  The contract is appended after any instruction, so a workspace override written for the web
  still gets the device rules. The default instruction's browser-only lines move into the web
  variant of the contract, so the editable text stays neutral.

## Out of scope

- Physical devices. Testing on both iOS and Android in one run: the run uses the doer's current
  device platform.
- A «Чистий старт» switch, unless the measurements require it (decision 1).

## Verification

- core: `testerRefusal` lets `mobile` through with a device config in both builds, refuses
  `backend`, and keeps `no-browser` for web in the web build. `testerContract` / the login line
  give the device wording and the deep link for Mobile, and ignore `/login` there.
- api:
  - A Mobile tester lists `device_*`, `preview_*` and `device_type_credential`, and no `browser_*`.
  - Its device calls reach the doer's device and are refused before the first `preview_start`.
  - Its first `preview_start` restarts the doer's preview with `clean`, and the next one does not.
  - The doer's `device_*` / `preview_start` / `preview_stop` are refused while the tester is not
    retired and accepted after ⤴ / «Відкинути».
  - With `clean`, the start calls `pm clear <app>` on Android, and `uninstall <app>` plus
    `keychain reset` on iOS, after the boot and before `setup`. A failure fails the `device` step.
  - `device_type_credential` never answers the value and clears the clipboard after a paste.
- Smoke on g-app (iOS and Android): run the tester, time the clean start, check that the app starts
  signed out, the tester's tab shows the device, and the doer's tab shows the banner.

## Docs

The README sections «Тестувальник» and «Mobile device preview». Decisions 7, 8 and 12 of the
tester spec point here (the clean start, the Mobile tools, the narrowed `platform` refusal).
