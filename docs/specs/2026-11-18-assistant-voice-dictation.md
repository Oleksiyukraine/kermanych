# Voice dictation in ЦУК and the Менеджмент assistant

- **Branch:** `feature/add-voice-input-to-chats`
- **Scope:** `apps/ui` — `AssistantComposer.vue` (the pill both assistants type into),
  `composables/useComposerDictation.ts`, `KComposer.vue` (shared dictation words),
  `test/composer-dictation.spec.ts`, `kermanych/README.md`.

## Goal

The operator asked for voice input in the ЦУК and Менеджмент chat composers, «як у Синергії»:
🎤 / ⌥D, each phrase lands in the field, and after a pause the message sends itself behind a
countdown (`docs/specs/2026-11-14-local-voice-dictation.md`, decisions 3, 13, 14).

## Context

- «Синергія» dictates through `useVoicePanel(…, { live: false })` → `useComposerDictation`, with
  KPanel lending its composer as a `ComposerDictationHost`; KComposer renders the 🎤, the
  «слухаю…» line and the countdown ring on the send button.
- ЦУК (`CukAssistant.vue`) and Менеджмент (`ManagementAssistant.vue`, dock on «Менеджмент» and
  the panel in «ЦТ») do not use KComposer: both type into `AssistantComposer.vue`, which had no
  voice at all. The assistants have no session and no «Потрібне рішення» block.
- The field is `disabled` while a turn is in flight or a new chat is being created (`locked`),
  and while omp is missing or signed out (`ompBlock`); `submit` silently does nothing then.
- Esc in «ЦТ» (`AssistantLauncher.onEscape`, bubble phase, honours `defaultPrevented`) stops the
  expanded panel's turn or closes the window; the dictation's own Esc (cancel the countdown) was
  a plain bubble listener that never claimed the key.

## Decisions

1. **Dictation lives in `AssistantComposer`**, so ЦУК and both Менеджмент hosts get it from one
   place; the hosts do not change. The composer builds its own `ComposerDictationHost` over its
   draft and field; with no decision block, `request()` is always `undefined`. Rejected: wiring it
   in each host (three copies of the same host object).
2. **Dictation only, no Live.** No session to talk to — the same as «Синергія» (no ▾ menu).
3. **While the composer cannot send, the countdown waits.** New optional
   `ComposerDictationHost.sendable()`: a dictated message is not counted down while it returns
   false and the countdown starts (at least `DICTATION_SEND_NOTICE_MS`) once it turns true. So a
   phrase said while the assistant answers lands in the (disabled) field and goes after the
   answer — hands-free between turns. Rejected: dropping the phrase, or firing `submit` into a
   locked composer (it is a no-op, and the dictated text would sit there unsent with no notice).
4. **Esc during a countdown belongs to the countdown.** The composable listens in the capture
   phase and calls `preventDefault()` when it cancels a send, so «ЦТ» stays open (and a
   «Дослідження» countdown no longer closes the window either). Esc without a countdown behaves
   as before.
5. **The 🎤 stays usable during a turn** (start or stop dictation while the assistant answers);
   it is disabled only while omp blocks the composer and nothing is dictating.
6. **Look.** 🎤 is a round tool button beside 📎, lit in the accent while dictating, a spinner
   while the microphone opens. The «слухаю… / розпізнаю… / Надішлю через N… · Esc — скасувати»
   line is a frosted strip above the pill, like the attachment strip; the countdown is the ring
   on the send disc. The words come from one `useDictationWords` shared with KComposer.

## Changes

- `composables/useComposerDictation.ts`: `sendable?` on the host (reconsidered on change, gates
  the composer send); Esc listener in capture phase with `preventDefault`; `useDictationWords`.
- `components/kit/KComposer.vue`: its dictation words come from `useDictationWords`.
- `components/assistant/AssistantComposer.vue`: 🎤 button, ⌥D in the field, the dictation
  strip, the countdown ring; field height follows every draft change (dictated text included).
- `test/composer-dictation.spec.ts`: the send waits while the host is not sendable; Esc during
  a countdown is claimed.
- `composables/useDictationWords.ts` (new): the dictation line's words and countdown clock,
  moved out of KComposer.
- `kermanych/README.md` → «Voice dictation»: ЦУК and Менеджмент listed among chat composers.

## Verification

- `vitest run test/composer-dictation.spec.ts` (apps/ui): 12 passed, incl. the two new cases —
  a dictated message waits while `sendable()` is false and goes after a
  `DICTATION_SEND_NOTICE_MS` countdown once it is true; Esc during a countdown is
  `defaultPrevented` for a later window listener, Esc without one is not.
- `vue-tsc --noEmit` (apps/ui): clean.
- Preview (`.kermanych/preview.json`), ЦУК in «ЦТ», with `getUserMedia` replaced in the page by
  a stream playing a macOS `say -v Lesya` recording of «Які агенти зараз працюють?» (the embedded
  browser has no microphone; the real local recogniser transcribed it):
  - 🎤 lights, the strip shows the level and «слухаю…», then «розпізнаю…»; the phrase lands in
    the field, «Надішлю через N… · Esc — скасувати» and the ring on the send disc run, and the
    message is sent by itself.
  - Esc during the countdown: the send is cancelled, the text stays, «ЦТ» stays open.
  - Dictating while a typed question is being answered: the phrase lands in the disabled field,
    no countdown while «■» is shown; once the answer ends a 1 s countdown runs and the phrase is
    sent.
  - Without the fake stream: 🎤 ends in «Немає доступу до мікрофона…», as on other composers.

**Not verified here:**

- The Менеджмент assistant on screen: the preview seed has no workspace, so neither its dock nor
  its «ЦТ» panel renders. It is the same `AssistantComposer` with the same props.
- A real microphone and the desktop app — the operator's run.

## Documentation impact

`kermanych/README.md` → «Voice dictation («Диктування»)» (ЦУК and Менеджмент among the chat
composers, waiting during an answer, Esc in «ЦТ») and «Voice conversation» → «Where» (ЦУК and
Менеджмент have dictation only).
