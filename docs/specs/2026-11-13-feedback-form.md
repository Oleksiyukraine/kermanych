# Форма зворотного зв'язку

- **Date:** 2026-11-13
- **Branch:** `feature/add-feedback-form`
- **Scope:** `supabase/migrations` (a table and a bucket), `packages/cloud` (`sendFeedback`),
  `apps/ui` (a store, the modal, two entry points, i18n `uk` / `en`), `kermanych/README.md`.
- **Status:** asked by the operator on 2026-11-13: «Оскільки ми випустили релізне оновлення і тепер
  більше людей буде користуватись керманичем… Перше з них це форму зворотнього зʼязку.»

## Goal

Since 1.2.0 Kermanych is a public desktop app. People who install it have no way inside the app
to tell the maintainers about a bug or an idea. A feedback form lets them do that in one step,
with the facts a maintainer needs to act on a report.

## Context

- **Every user is signed in to the team's Supabase project.** Sign-in is open to any GitHub
  account (README «Start here»). The router sends a signed-out window to `/login`, so the main
  layout always has `auth.user`. The UI writes to the cloud directly through `packages/cloud`
  functions on the user's client. RLS is the only authorization surface.
- **No app-wide role exists.** Every role in the schema is per workspace. The closest app-global
  precedent is `app_release_policy` (`20261112090000_app_release_policy.sql`).
- **Images.** Task images go to the private `task-images` bucket, keyed by project
  (`20260830160000_task_images.sql`). The client side (`useImageAttach`, `KAttachStrip`,
  `imageToFile`) is generic.
- **The version** is `APP_VERSION` (`stores/app-update.ts`). The desktop build has
  `window.kermanych`; the web build does not.

## Decisions

1. **Feedback is a row in the team's cloud: `public.app_feedback`.** A user may only insert, and
   only as themselves (`user_id = auth.uid()`). Nobody reads it from a client. The maintainers read
   it in the Supabase dashboard (Table Editor, or SQL joined with `profiles` for the GitHub name).
   - Rejected: a prefilled GitHub issue. It makes every report public, and a report may name a
     private repository or contain a screenshot of one.
   - Rejected: an in-app inbox for maintainers. It needs an app-wide role the schema does not
     have. The dashboard is enough for the people who own the project.
   - Rejected: Slack or e-mail delivery. Either needs a server-side secret (an Edge Function with a
     webhook URL) for one notification. The dashboard can add a database webhook later without a
     client change.
2. **What a report carries.**
   - The kind: «Помилка», «Ідея» or «Інше» (`bug` / `idea` / `other`). The default is «Помилка».
   - The text: required, 1–5000 characters.
   - Up to 3 screenshots: paste ⌘V, drag-and-drop, or «Додати знімок».
   - Context added automatically: the app version, `desktop` or `web`, the browser's user agent
     (OS and Electron version), the UI language, and the name of the screen the form was opened
     from (the route name, never its parameters). The form says so under the text.
   - The author is the account. The form shows `@github-name`, so nobody needs an e-mail field.
3. **Screenshots get their own private bucket, `feedback-images`.** The path is
   `{user_id}/{uuid}-{name}`. A user may insert, read and delete only under their own folder
   (delete is what removes an upload when the batch or the row fails). Limits: 10 MiB per file,
   PNG / JPEG / GIF / WebP. The `task-images` bucket does not fit: its policies need a project.
4. **A rate limit in the database: 10 reports per user per hour.** Sign-in is open, so the table
   needs a bound. A `before insert` trigger counts the author's rows of the last hour and refuses
   the eleventh with `feedback_rate_limited`. The form shows that as «Забагато відгуків за годину.
   Спробуйте пізніше.»
5. **Two entry points, one modal.** A «Надіслати відгук» icon in the header, beside the settings
   gear, always visible. A «Надіслати відгук» button in Налаштування → Застосунок → «Загальне»,
   beside «Що нового». The modal is mounted once in `MainLayout`. A store holds `open` and the
   draft, the same shape as `stores/onboarding.ts`.
   - Rejected: an Electron «Help» menu. The app sets no menu of its own, and the web build would
     not have it.
6. **The draft survives closing the modal.** The text, the kind and the screenshots stay until
   the report is sent. A modal closed by accident costs nothing. A sent report clears the draft,
   closes the modal and shows «Дякуємо! Відгук надіслано.».
7. **Sending follows the modal rule of «Async states».** The modal is `persistent` while it
   sends, «Надіслати» spins, and an error shows inside the modal with the draft intact. Screenshots
   upload first. If the row insert then fails, the uploads are removed.

## Changes

- **migration `20261113090000_app_feedback.sql`:** the table `app_feedback`, its insert-only RLS
  and grants (`insert` to `authenticated`, `select` to `service_role` for a maintainer's
  server-side tool; the local stack grants `service_role` nothing by default), the rate-limit
  trigger `app_feedback_rate_limit()` (it also stamps `created_at`, so a back-dated row cannot
  leave the counted hour), and the private bucket `feedback-images` with own-folder policies.
- **cloud, `feedback.ts`:** `sendFeedback(client, userId, input, files)` uploads the screenshots,
  inserts the row and removes the uploads when the insert fails. `FeedbackRateLimitedError` is
  thrown for `feedback_rate_limited`. Constants: `FEEDBACK_KINDS`, `FEEDBACK_MAX_LENGTH`,
  `FEEDBACK_MAX_IMAGES`, `FEEDBACK_MAX_IMAGE_BYTES`, `FEEDBACK_IMAGE_BUCKET`. `tasks.ts` exports
  its path slug `safeName` for it.
- **ui:**
  - `stores/feedback.ts`: `open`, the draft, `show()` / `hide()`, `send()` and the context it
    collects.
  - `components/feedback/FeedbackDialog.vue`: the modal.
  - `KIcon` gets `feedback`.
  - `MainLayout.vue`: the header button and the mounted modal.
  - `SettingsPage.vue`: the «Загальне» button.
  - i18n: `feedback.*` in `uk` / `en`.
- **README:** a «Feedback» section (what is sent, where the maintainers read it, the rate limit)
  and the migration under «Applying a migration to the team's project».

## Verification

Run on 2026-11-13:

- `@kermanych/cloud`: 286 tests against a local stack (`supabase start`, `supabase db reset`
  with the new migration, the three `SUPABASE_TEST_*` variables set). `test/feedback.spec.ts`
  (4, new): the upload paths under the author's folder and the row payload; a refused row removes
  the uploads; the rate-limit refusal becomes `FeedbackRateLimitedError`; a failed upload removes
  the earlier ones and inserts nothing. `test/rls.spec.ts` «app feedback» (4, new): a report with
  a screenshot lands, and its author gets `42501` reading it back; a forged `user_id` and an
  anonymous insert get `42501`; an upload into another user's folder is refused; the eleventh
  report of the hour is refused, also with a back-dated `created_at`.
- `@kermanych/ui`: 1006 tests. `test/feedback-store.spec.ts` (3, new): a sent draft carries its
  context and is cleared, closed and thanked; a failed send keeps the draft and the modal and
  words the rate limit; too long, too many and too large screenshots are refused and nothing is
  sent. `test/i18n-completeness.spec.ts` passes. `vue-tsc --noEmit` is clean.
- **Live preview:** the header icon «Надіслати відгук» sits left of the gear and opens the modal
  («Помилка» picked, the text focused). The «Загальне» button opens the same modal, with the
  text typed earlier and the modal closed by Esc still in it. A pasted PNG showed as a thumbnail.
  With the page's cloud requests blocked, «Надіслати» left the modal open with the text, the
  «Ідея» kind and the screenshot intact, and showed the error inside it.
- Not verified:
  - a send to the team's project: the migration is not pushed yet, and the preview has no cloud;
  - the success toast on screen (covered by the store test only);
  - the `en` texts and the light theme on screen;
  - the desktop build (`client: 'desktop'`): the preview is the web build.

## Documentation impact

`kermanych/README.md`: a «Feedback («Надіслати відгук»)» section (what is sent, where the
maintainers read it, the rate limit) and the migration note under «Applying a migration to the
team's project».
