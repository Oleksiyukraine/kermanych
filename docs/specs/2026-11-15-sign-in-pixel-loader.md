# Завантаження під час входу: КЕРМАНИЧ із пікселів і цитата

- **Date:** 2026-11-15
- **Branch:** `feature/add-pixel-login-loading-quote`
- **Scope:** `apps/ui` (a loader component, `lib/pixel-word.ts`, `LoginPage`, `AuthCallbackPage`,
  i18n `uk` / `en`).
- **Status:** asked by the operator on 2026-11-15: «Я хочу зробити лоадінг стейт при "вхід" так щоб
  збиралось слово "Керманич" а під ним цитата видатного інженера винахідника … нижче і правіше
  ім'я і прізвище автора.»

## Goal

The wait after «Увійти через GitHub» shows the word КЕРМАНИЧ gathering from pixels, the way the
landing page's coda draws it, with an engineer's quote under it and the author's name below the
quote on the right.

## Context

- **The landing coda** (`kermanych-landing`, `assets/site.js` `initHelm`, `assets/styles.css`
  «helm») draws КЕРМАНИЧ from 5×7 SVG pixel glyphs. Every pixel has a seeded scatter
  (`--dx`, `--dy`, `--r`); 70 noise pixels belong to no letter; 14% of letter pixels are accent.
  The scroll position drives the gathering there.
- **Sign-in wait before this change.** `LoginPage` disabled the button and relabelled it
  «Входимо…». In Electron that lasts while the operator signs in in the system browser (up to the
  120 s loopback timeout, `src-electron/oauth-loopback.ts`); in the browser, until the page
  navigates to GitHub. `AuthCallbackPage` (the OAuth redirect target) showed a card with
  «Входимо…».
- `LoginPage` dropped `busy` in `finally`, also on success. The router leaves `/login` only once
  `auth.apply` has handed the token to the local api and set `user`, so the sign-in card came back
  for that moment.

## Decisions

1. **One component, `components/auth/AuthLoader.vue`, for both waits.** `LoginPage` renders it
   instead of the card while `busy`; `AuthCallbackPage` is only the loader.
2. **Time drives the animation, not scroll.** A 3.6 s CSS loop: scattered → gathered (40%) → held
   → scattered. Each rect reads its own scatter from CSS variables, so one keyframe list moves the
   picture. Reduced motion shows the word assembled and still.
3. **Same glyphs and seed as the landing** (`lib/pixel-word.ts`), so the app and the site draw the
   same picture.
4. **A random quote from a set of 15, one per showing.** The first version had one quote, Theodore
   von Kármán's, which the operator gave as an example. The operator then supplied 14 more:
   Корольов, Євген Патон, Кондратюк, Борис Патон, Глушков, Люлька, Романків, Лебедєв, Сенека,
   Леонардо да Вінчі, Едісон, Форд, Алан Кей, Стів Джобс. The texts are the operator's; the
   English versions are the known English originals (Kay, Ford, Edison, Jobs, Seneca's Gummere
   translation, von Kármán) or translations of the Ukrainian text. The ids are `SIGN_IN_QUOTES`
   (`lib/sign-in-loader.ts`), the texts `common.login.quotes.<id>.{text,author}`. The quote does
   not change while the loader is on screen.
   - Attribution: the operator chose the list. Several of these sayings have disputed sources
     (the Ford and Edison ones in particular; the Jobs line is from Apple's «Think Different»
     ad). This was flagged to the operator, and the list was kept as given.
5. **«Входимо…» stays as a screen-reader `role="status"`**, visually hidden. The animation is the
   visible feedback.
6. **Success keeps the loader up.** `LoginPage` drops `busy` only on failure; on success the
   `auth.user` watcher in `router/index.ts` replaces the route, so the card no longer flashes
   between the exchange and the redirect. A failure (the 120 s timeout included) brings the card
   back with the error.
7. **The loader stays at least 3 s** (`SIGN_IN_LOADER_MIN_MS`, `lib/sign-in-loader.ts`), asked by
   the operator after the first version: a fast sign-in blinked the word and the quote away.
   `AuthLoader` records when it appeared; the `auth.user` watcher in `router/index.ts` waits out
   the rest before it leaves `/login` or `/auth/callback`, then checks again that the session
   still exists and the route is still a signed-out one. The guard's redirect for a persisted
   session landing on `/auth/callback` is not held: no loader was shown there.
   - Rejected: a longer animation cycle. The cycle is already 3.6 s; the problem was the loader
     leaving early, not the loop's speed.

## Changes

- `apps/ui/src/lib/pixel-word.ts` — glyphs and `pixelWord(word, seed)`: pixel positions and
  scatter.
- `apps/ui/src/components/auth/AuthLoader.vue` — the pixel word, the quote, the author aligned
  right, the hidden status.
- `apps/ui/src/pages/LoginPage.vue` — the loader while signing in; `busy` reset only on failure.
- `apps/ui/src/pages/AuthCallbackPage.vue` — the loader instead of the card and its hard-coded
  Ukrainian text.
- i18n `common.login.quotes.<id>.text` / `.author` (`uk`, `en`), 15 quotes.
- `apps/ui/src/lib/sign-in-loader.ts` — the minimum time: `markSignInLoader`, `signInLoaderHold`.
- `apps/ui/src/router/index.ts` — the sign-in redirect waits for `signInLoaderHold()`.
- `apps/ui/test/i18n-completeness.spec.ts` — both locales have exactly the `SIGN_IN_QUOTES` ids.

## Verification

- Live preview, `#/auth/callback` with `auth.user` cleared in the page: the assembled word, the
  quote and «— Теодор фон Карман» on the right below it (screenshot). Pausing the animations at
  600 ms showed the pixels mid-flight.
- `#/login` with `signInWithGithub` stubbed to reject after 1.5 s: 400 ms after the click the
  loader was on screen with the status «Входимо…»; after the rejection the card came back with the
  error.
- Minimum time: `#/auth/callback` with the session restored 300 ms after the loader appeared —
  the route changed to `agents` at 3001 ms after the loader appeared. With the loader already
  on screen 2.26 s, the redirect came 742 ms after the session.
- Quote set: Корольов's quote, the longest, picked on `#/auth/callback`: it wraps to three lines
  under the word, with the author on the right (screenshot).
- `vue-tsc --noEmit`: no errors. `vitest run test/i18n-completeness.spec.ts`: 10 passed.

Not verified: a real GitHub sign-in in the desktop build (Electron), and the reduced-motion
rendering.

## Follow-up: the start-up splash (after PR #295)

After the merge the operator still saw the old «Входжу…» when launching the app. That text was the
start-up splash in `apps/ui/index.html` (mark, spinner, «Запускаю локальний сервіс…» → «Входжу…»,
`docs/specs/2026-10-21-async-feedback.md` decision 10), which covers the boot files while the
session is read — not the sign-in screens this change had touched.

**Decisions**

8. **The splash is the sign-in loader.** `boot/splash.ts` mounts `AuthLoader` into `#k-splash` as
   a separate small Vue app, because the boot files run before Quasar mounts the main one. Before
   the bundle loads, `index.html` paints only the theme's canvas; the mark, spinner and inline
   status script are gone.
   - Rejected: drawing the pixel word in `index.html` with an inline script. It would copy the
     glyphs, the scatter and 15 quotes in two languages into a second place.
9. **Its own vue-i18n instance.** vue-i18n wraps `app.unmount` of the app it is installed in and
   disposes the instance (`vue-i18n` 10.0.8, `install`), so installing the shared `i18n` into the
   splash app and unmounting it would break the main app's messages.
10. **Boot order `tokens`, `i18n`, `splash`, `backend`, …** The splash needs the tokens and the
    messages; neither boot talks to the local api, so moving them ahead of `backend` keeps decision
    10 of the async-feedback spec. The status (`common.login.startingBackend`, then «Входимо…»)
    follows `onBootStatus` and is screen-reader text, as on the sign-in screens.
11. **The 3 s minimum applies to the splash too.** `closeSplash()` (called from `App.vue` on mount)
    waits for `signInLoaderHold()` and then fades the overlay. A launch where the app is ready
    sooner now waits up to 3 s; otherwise the word would leave mid-gather.

**Changes:** `apps/ui/index.html`, `apps/ui/src/boot/splash.ts` (new), `boot/backend.ts` (no longer
flips the splash status), `App.vue` (`closeSplash`), `quasar.config.ts` (boot order),
`AuthLoader.vue` (`status` prop), i18n `common.login.startingBackend`, `kermanych/README.md`.

**Verification** (live preview, web build, signed in):

- Opening `#/` shows the pixel word with a random quote over the app, with the status «Входимо…».
  The app was mounted underneath. The splash was removed 3287 ms after navigation start: the 3 s hold
  plus the 200 ms fade.
- After the splash closed, switching the language to English re-translated the main app (tabs
  «Agents | Board | …»), so the main vue-i18n instance survives the splash unmount. Reloading in
  English showed the English quote on the splash.
- `vue-tsc --noEmit`: no errors. `vitest run test/i18n-completeness.spec.ts`: 10 passed.

Not verified: the desktop build (Electron) launch with the «Запускаю локальний сервіс…» step.

## Documentation impact

`kermanych/README.md` «Desktop app»: the start-up splash is now the sign-in loader, stays at least
3 s, and its status is for screen readers. Sign-in itself is still described only as pressing
«Увійти через GitHub».
