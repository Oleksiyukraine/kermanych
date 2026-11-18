# Dictation sent «Музика» before the operator said anything

- **Branch:** `feature/fix-voice-input-phantom-submit`
- **Scope:** `packages/core` (VAD, invention filter), `apps/ui` (dictation store)

## Goal

The operator turned dictation on in an agent's composer and, before saying a word, the agent got
the message «Музика». Dictation must not send anything until the operator actually speaks.

## Context

- `vadStep` (`packages/core/src/dictation.ts`) marked a phrase as started on **one** meter reading
  (100 ms) above the speech level and committed it after an 800 ms pause. A click — the 🎤 press,
  a key, the microphone opening — is one such reading, so about a second of near-silence went to
  Whisper (`apps/ui/src/stores/dictation.ts` → `POST /api/voice/transcribe`).
- Whisper writes a described sound for near-silence. The invention filter (`isInventedPhrase`,
  decision 11 of `2026-11-14-local-voice-dictation.md`) caught «[музика]» in brackets, but not
  the bare «Музика», so the text reached the composer and the 2.5 s auto-send sent it.

## Decisions

1. **A phrase needs two readings above the level** (`DICTATION_MIN_SPEECH_READINGS = 2`, ≥ ~200 ms of
   sound). One loud reading is a click, not speech: when its pause ends, `vadStep` returns
   `drop` instead of `commit` and the store discards the audio; «Зупинити» right after a click
   sends nothing either (`vadHasSpeech`). The shortest answers («так», «ні») last longer than
   two readings [INFERENCE — not measured on the operator's recordings]. Rejected: ignoring the
   first N ms after the microphone opens — misses a click later in the session and swallows a
   word said at once.
2. **Bare sound words are inventions**: «музика», «music», «оплески», «applause» as the whole
   phrase are dropped, as their bracketed forms already were. A request that only contains the
   word («Додай музику на фон.») is kept. This is the second line of defence for a longer noise
   that passes decision 1.

## Changes

- `packages/core/src/dictation.ts`: `VadState.voiced`, `DICTATION_MIN_SPEECH_READINGS`,
  `vadHasSpeech`, `vadStep` → `{ commit, drop, … }`; four sound words in `INVENTED`.
- `packages/core/src/index.ts`: exports `vadHasSpeech`.
- `apps/ui/src/stores/dictation.ts`: on `drop` the phrase audio is discarded; `stop()` sends the
  phrase being spoken only when `vadHasSpeech`.
- Tests: `packages/core/test/dictation.spec.ts` (bare «Музика» / «Music.» dropped, «Додай музику
  на фон.» kept, one reading → `drop`, two → `commit`; the existing commit case now speaks two
  readings), `apps/ui/test/dictation-store.spec.ts` (a click then silence sends nothing and the
  next phrase carries none of its audio; stop right after a click sends nothing).

## Verification

- `packages/core`: `vitest run test/dictation.spec.ts` — 20 passed.
- `apps/ui`: `vitest run test/dictation-store.spec.ts test/composer-dictation.spec.ts` — 27
  passed; `vue-tsc --noEmit` — 0 errors.

**Not verified here:** a real microphone (the embedded browser refuses it): the click at 🎤 and a
short «так» into a decision block need the operator's run in the desktop app.

## Documentation impact

`kermanych/README.md` «Voice dictation» → «What is heard»: a lone click is not sent, «Музика» is
dropped. `docs/specs/2026-11-14-local-voice-dictation.md` decisions 10 and 11 updated.
