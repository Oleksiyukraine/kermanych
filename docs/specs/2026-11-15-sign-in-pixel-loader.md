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
4. **One quote, the one the operator gave:** Theodore von Kármán, «Науковець вивчає світ, який є;
   інженер творить світ, якого ніколи не було». English: "Scientists study the world as it is;
   engineers create the world that has never been."
   - Rejected: a rotating set of quotes. Popular engineer quotes are often misattributed, and the
     operator named this one.
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
- i18n `common.login.quote`, `common.login.quoteAuthor` (`uk`, `en`).
- `apps/ui/src/lib/sign-in-loader.ts` — the minimum time: `markSignInLoader`, `signInLoaderHold`.
- `apps/ui/src/router/index.ts` — the sign-in redirect waits for `signInLoaderHold()`.

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
- `vue-tsc --noEmit`: no errors. `vitest run test/i18n-completeness.spec.ts`: 8 passed.

Not verified: a real GitHub sign-in in the desktop build (Electron), and the reduced-motion
rendering.

## Documentation impact

None. README describes sign-in only as pressing «Увійти через GitHub»; the flow and its steps did
not change, only how the wait looks. The release changelog is written at release time.
