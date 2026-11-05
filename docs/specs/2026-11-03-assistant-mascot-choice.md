# Assistant character: the operator picks it

- **Branch:** `feature/redesign-leader-avatar-variants`
- **Scope:** `apps/ui` only — `components/assistant/AssistantMascot.vue`,
  `components/assistant/AssistantLauncher.vue`, `stores/assistant-overlay.ts`, the «Загальне»
  settings pane, i18n `uk` / `en`, `kermanych/README.md`. No api, core or cloud change.
- **Status:** agreed with the operator in the session chat (2026-11-03); implemented on this branch.
  Extended 2026-11-04 on `feature/add-cowboy-cossack-vader-avatars`: three more characters at the
  operator's request (decision 6).

## Goal

The character that peeks out of the window's left edge
(`docs/specs/2026-11-03-assistant-overlay.md`, decision 1) «looks fine but something is off».
Five alternatives were drawn and compared in the browser; the operator liked the terminal bot,
and also the current character's eyes. Rather than settle on one, the operator asked to let
each person choose: every drawn variant plus the new one, picked in Settings.

## Context

- `AssistantMascot.vue` draws one character: a glossy graphite drop with white eyes, the logo's
  chevrons as pupils and the logo's bar as the mouth. It uses fixed gradient ids because it was
  rendered once.
- `AssistantLauncher.vue` mounts it at the left edge (66 px, 46 % hidden), passing `busy`.
- Device-local screen preferences live in `localStorage` through `lib/persisted.ts`; the gesture
  switch (`assistantGestureOn`, `stores/assistant-overlay.ts`) sits in «Загальне».

## Decisions

1. **Ten characters, one component.** `AssistantMascot.vue` takes `variant`:
   - `bot-eyes` «Бот із шевронами» — the terminal bot with the drop's eyes (new; the default);
   - `bot` «Термінал-бот» — monitor head, block-cursor eyes, accent mouth, antenna light;
   - `drop` «Крапля» — the character that shipped first;
   - `tile` «Логотип» — the logo tile, its chevron a winking eye;
   - `eyes` «Великі очі» — a flat squircle with big eyes and an accent cursor mouth;
   - `captain` «Капітан» — a round head in a peaked cap with the chevron as its badge;
   - `spark` «Іскра» — the character in the accent colour, dark face;
   - `cowboy` «Ковбой» — a round head under a wide-brimmed brown hat, an accent neckerchief;
   - `cossack` «Козак» — a shaven head with an accent оселедець and a drooping white moustache;
   - `vader` «Дарт Вейдер» — a glossy black helmet turned right, dark lenses, an accent grille.

   All keep the same motion vocabulary: eyes blink; while a turn runs the body breathes, the
   pupils read and the mouth blinks like a cursor (the bot's antenna light flickers, the tile's
   chevron nudges forward); `prefers-reduced-motion` stills them. Faces sit in the right half,
   because the launcher hides the left 46 %.
   Rejected: one file per character (ten copies of the same motion CSS).
2. **Default `bot-eyes`.** It is the operator's pick of this round; the first character stays
   one click away as «Крапля».
3. **Stored on this machine** (`kermanych.assistant.mascot`), like the theme and the gesture
   switch; an unknown stored value reads as the default. Rejected: an account setting (a screen
   preference, not data the team shares).
4. **Picker in Settings → «Загальне»**, beside the gesture switch: a row of tiles, each the
   character itself at 44 px with its name under it; applies on click, no save bar, like the
   theme.
5. **Gradient and clip ids per instance** (`useId()`), because the picker renders every
   character next to the launcher's.
6. **Three more, appended (2026-11-04).** `cowboy`, `cossack`, `vader` go to the end of
   `ASSISTANT_MASCOTS`, so the default and every stored choice stay as they were. The cowboy's
   hat and the Cossack's moustache are outlined, like the captain's crown, so they hold in the
   light theme; the helmet keeps the dark characters' faint white rim.

## Changes

- `stores/assistant-overlay.ts`: `ASSISTANT_MASCOTS`, `AssistantMascotId`, persisted
  `assistantMascot`.
- `components/assistant/AssistantMascot.vue`: `variant` prop, ten drawings, per-instance ids.
- `components/assistant/AssistantLauncher.vue`: passes `assistantMascot`.
- `pages/SettingsPage.vue`: «Персонаж асистента» picker in «Загальне».
- i18n `uk` / `en`: `settings.appGeneral.assistantMascot*`.

## Verification

- `pnpm typecheck` (apps/ui): clean. `vitest run test/i18n-completeness.spec.ts
  test/runtime-messages.spec.ts`: 13 passed (`uk` / `en` keys match).
- Live preview (web build): the launcher shows `bot-eyes` with nothing stored; Settings →
  «Загальне» lists the seven tiles with `bot-eyes` pressed; picking «Капітан» swaps the launcher
  at once, writes `captain` to `kermanych.assistant.mascot`, and survives a reload; a stored
  `ghost` reads as `bot-eyes`; every tile draws in the dark and light themes (gradient ids are
  per instance: `k-mascot-v-1-eye`, `k-mascot-v-3-body`, …).
- Decision 6 (2026-11-04): `pnpm typecheck` clean; the two i18n specs: 13 passed. Live preview:
  «Загальне» lists ten tiles; «Ковбой», «Козак», «Дарт Вейдер» drawn at 200 px on the dark and
  a light canvas; picking «Козак» writes `cossack`, swaps the launcher and survives a reload.
- Not exercised: the Electron build (no Electron-specific code changed).

## Documentation impact

`kermanych/README.md` → «The Менеджмент tab and its assistant»: the character can be changed in
Settings → «Загальне». `docs/specs/2026-11-03-assistant-overlay.md` → the `AssistantMascot.vue`
paragraph points here.
