# Session `.env` in the «Браузер» tab; «Тестувальник» needs a preview config

- **Status:** decisions settled with the operator on 2026-11-04 (deep analysis); approved and
  implemented on this branch.
- **Scope:** `apps/api` (session env endpoints, tester launch guard), `packages/core`
  (`testerRefusal`), `apps/ui` (preview row «Змінні», env panel, QA button hint), README.
- **Builds on:** `docs/specs/2026-11-04-qa-tester-agent.md`,
  `docs/specs/2026-11-03-session-browser-preview.md`.

## Problem (what the operator saw)

Project «Platinum OS - FE» (platform `web`), doer session `1250b4cd…`, tester run `2214df2e…`.

1. **Requests go to the wrong host.** The preview of the front end ran at
   `http://localhost:53610`, but sign-in sent `POST http://localhost:3000/api/auth/admin/sign-in`
   → `ERR_CONNECTION_REFUSED` (the tester's `browser_network`). The address is
   `NEXT_PUBLIC_API_URL=http://localhost:3000/api` from `.env`, which Kermanych copies from the
   project checkout into every worktree (`carry_files: [".env"]`) when the session is created.
   The worktree's `.kermanych/preview.json` has only a `web` service; nothing listens on 3000,
   and Kermanych cannot run the back end (project «Platinum OS - BE» is `backend`: no preview).
   The only way to change the host per session today is to edit the worktree's `.env` by hand.
   Different tasks are tested against different back-end versions, so a project-wide value is
   not enough.
2. **«The tester knows nothing about the parent's settings».** Two separate facts:
   - The first run started at 13:15:31Z, before the doer's `.kermanych/preview.json` existed
     (written 13:17:42Z). `preview_start` answered «missing», and all 21 items got `blocked` — a
     run that took a slot and cost money for nothing. After «Спробуй ще раз» the tester started the
     **parent's** preview (`BrowserMcpService.previewOwner` → `parentSessionId`), so it does see the
     parent's config.
   - The tester's browser has its own in-memory partition `kermanych-tester-<id>` (decision 7 of
     the tester spec): no cookies, storage or sign-in from the parent's browser. Kept as designed
     (decision 5 below).

## Decisions

### 1. The back end of a session is chosen through the worktree's `.env`

No new setting and no new store: the front end reads its API base from its own env variable
(`NEXT_PUBLIC_API_URL`, `VITE_API_BASE`, `BASE_URL`…), exactly as `GIT_TOKEN` is read from `.env`
for a PR. The operator edits the `.env` **of the session's directory**; the project's `.env`
(Settings → Проєкт → «Змінні середовища») stays the default every new session starts from.

The tester runs in the parent's worktree and drives the parent's preview, so it gets the value
with no setting of its own.

Rejected:
- a fixed per-project answer (the dev back end, or a local back end on `localhost:3000`): tasks are
  tested on different back-end versions;
- a «Бекенд» field in the launcher, written into the new worktree's `.env` (cannot change an
  existing session; may be added later on top of this);
- a field on the cloud card (the whole team sees it, while `.env` and hosts are per machine).

### 2. «Змінні» in the preview row edits the whole session `.env`

- **Where.** A «Змінні» button in `KPreviewRow`, next to «Логи», so it is everywhere the row is:
  the «Браузер» tab (`KBrowserPane`), the web build (`KPreviewWebPane`) and a Mobile project's
  device pane (`KDevicePane`). Only `agent` sessions have the row (forks and the tester's own tab
  do not), which is exactly who gets the editor.
- **What.** The same `KEnvEditor` table as Settings → «Змінні середовища»: every key of the
  directory's `.env`, add / edit / remove, values masked with the same «Показати». The
  project's required-keys flags (cloud `envKeys`) are shown but locked: they are a project
  setting, not a session one.
- **How it opens.** A bottom panel inside the tab, the same place and seam as «Логи» (never an
  overlay: the native view sits above the DOM). «Змінні» and «Логи» share the panel
  (`KPreviewPanel`, formerly `KPreviewLogs`); the pressed button says which one is shown. A crash
  opens «Логи» by itself only while «Змінні» is not shown, so unsaved edits are not lost.
- **Save.** «Зберегти» / «Скасувати», enabled while the table differs from the file. The write
  goes through `EnvFileService.write` (atomic, keeps comments and lines it did not touch).
- **Apply.** Dev servers read `.env` at start, so a save while the preview is running or
  starting shows «Перезапустіть превʼю, щоб застосувати» with ↻ (the existing restart). Nothing
  restarts by itself: the operator may be mid-check.
- **Which directory.** The same one the preview runs from (`PreviewService.resolve`): the
  worktree, or the project checkout of an in-place session — there the panel says that it edits
  the project's `.env`. A finished session (no worktree) has no row and no editor.
- **Only `.env`.** No file switch, as in Settings. Next.js and Vite prefer `.env.local` over
  `.env`; a key set in `.env.local` is not overridden by this editor (stated under the table).

Api, in `sessions.controller.ts`, next to `GET :id/preview`:

- `GET /api/sessions/:id/env` → `EnvFileView` of the session directory's `.env`;
- `PUT /api/sessions/:id/env` with `{ set?, remove? }` → the new `EnvFileView`.

Both resolve the directory with the preview's own rule and refuse non-agent and finished
sessions with its message. `PreviewService.dirOf` exposes that resolution; the controller does
not duplicate it.

Rejected:
- one «Бекенд» field bound to a variable named in project settings (one more setting; a front end
  with two back-end variables — API and websocket — does not fit);
- both a field and the table (two editors of the same value).

### 3. «Виконати тестування» needs a valid `.kermanych/preview.json`

`testerRefusal` gets a new reason `no-preview`, checked after `platform` / `no-browser` and before
`busy`, fed by the config status of the **parent's** directory (`PreviewService.info`):

- `missing` → «Спершу налаштуйте превʼю у вкладці «Браузер»…»;
- `invalid` → the same code; the api message and the button hint carry the validation error.

A running preview is not required (the tester starts it). The api guard (`runTester`) and the UI
button (`lib/tester.ts`; `QaRunButton` reads the doer's preview info again when its status or
preview changes) use the same function, so they never disagree. The hint shows on the disabled
button as the other refusals do; no new UI.

Rejected: letting the tester start and stop at its first step (still takes a slot and tokens);
today's behaviour (21 `blocked` items for a config that does not exist).

### 4. Nothing else changes in how the tester finds the preview

It keeps acting on the parent's preview and worktree (tester spec, decision 6).

### 5. The tester's browser stays clean and temporary

No change to decision 7 of the tester spec: an in-memory partition per run, signed out, logging in
with the accounts from the «Тестувальник» page. The sign-in in this run failed because the API was
unreachable, not because of the partition; decision 1 fixes that.

Rejected: sharing the project partition (its sign-out or role switch signs the operator out; dirty
storage hides first-visit bugs); copying the parent's storage into the temporary one on start
(complex, and hides the same bugs).

## Out of scope

- Running a back-end project as part of a front-end preview (back-end platform previews, linking
  two projects).
- Editing `.env.local` or other env files.

## Verification

- `packages/core` spec: `testerRefusal` returns `no-preview` for a missing and an invalid config,
  in the stated order against the other reasons.
- `apps/api` spec: `runTester` refuses without `.kermanych/preview.json` in the parent's worktree
  and with an invalid one; `GET/PUT /sessions/:id/env` read and write the worktree's `.env`, not
  the project's, and refuse a fork and a finished session.
- Smoke in the running app: a session with a preview — «Змінні» shows the worktree `.env`, a changed
  `NEXT_PUBLIC_API_URL`-style key is saved into the worktree only (the project `.env` unchanged),
  the restart hint appears while running, ↻ makes the page send requests to the new host; a session
  without `preview.json` — «Виконати тестування» is disabled with the hint.

## Docs

- README: the live preview section gets «Змінні» (session `.env`, restart to apply, `.env.local`
  caveat); the «Тестувальник» section lists the preview-config requirement.
- `docs/specs/2026-11-04-qa-tester-agent.md`, decision 12: add the new refusal, linking here.
