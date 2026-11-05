# Voice conversation: stop background voices and sounds from reaching the agent

- **Branch:** `feature/filter-background-voice-noise`
- **Scope:** `packages/core` (`voice-bridge.ts`: what a delegation takes, the hang-up activity;
  `voice.ts`: GPT-Live's prompt), `apps/ui` (`lib/voice-gate.ts` + its audio worklet: the noise
  gate; `lib/voice-connection.ts`: microphone constraints and the gate graph; `stores/voice.ts`:
  fragment timing, activity, the gate; `KVoiceBar`: the threshold mark; the «Голос» settings
  pane), i18n `uk` / `en`, `kermanych/README.md`.
- **Status:** decisions agreed with the operator in the deep-analysis interview (2026-11-04),
  approved the same day; step 1 took decision 4 to its fallback; implemented on this branch (see
  «Verification»). The live run in a noisy room (step 5) is the operator's.

## Goal

The voice conversation (`docs/specs/2026-11-02-voice-conversation.md`) often takes other sounds —
music, a TV, neighbours — for the operator's words and hands them to the agent. The conversation
stays hands-free and full duplex; what reaches the agent must be the operator's own request.

## Context

Background sound gets in at three places:

1. **The microphone.** `connectVoice` asks for
   `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })`
   (`apps/ui/src/lib/voice-connection.ts:95`). Chromium's noise suppression removes stationary
   noise (a fan, hum), not speech or music. `autoGainControl` is left at Chromium's default (on),
   which lifts quiet, distant sound while the operator is silent. Dictation shares `connectVoice`
   (`stores/dictation.ts:147`), so whatever changes here changes for dictation too.
2. **GPT-Live.** `POST /v1/live/sessions` takes no input-audio settings: the session config is
   `model`, `instructions`, `input`, `audio.output.voice`, `delegation`, `client`, `store`
   ([reference](https://developers.openai.com/api/reference/resources/live/methods/create)) — no
   `noise_reduction`, no `turn_detection`, unlike the Realtime API. The only lever is the prompt.
   OpenAI's [prompting guide](https://developers.openai.com/api/docs/guides/live-prompting)
   («Silence and background noise») suggests «Keep listening while the user pauses to think. Do
   not treat a cough, music, or nearby conversation as a new request.»; `voiceLivePrompt`
   (`packages/core/src/voice.ts:35-51`) has nothing of the kind.
3. **Our bridge amplifies it.** `session.delegation.created` carries no text; the bridge builds the
   request from `session.input_transcript.delta`. `takeUtterance`
   (`packages/core/src/voice-bridge.ts:42-46`) takes **every** fragment since the previous
   delegation. While the agent works for minutes, the TV is transcribed into `heard`, and the
   operator's next request reaches the agent with all of it glued in front — even when GPT-Live
   correctly ignored the TV. Each fragment also sets `lastActivityAt`
   (`apps/ui/src/stores/voice.ts:130`), so with a TV on the 3-minute silence hang-up never fires
   and the conversation keeps billing. Only `start_ms` is kept (`HeardFragment`), not `end_ms`.

**macOS Voice Isolation.** macOS offers «Mic Mode» → «Voice Isolation» in Control Center to apps
that capture through the system voice processing (VPIO)
([Apple](https://support.apple.com/guide/mac-help/mchle82b42f0/mac)). Chromium can route capture
through the system echo canceller with `echoCancellation: "all"`; the `voiceIsolation` constraint
is shipped (M123) but backed only on some ChromeOS devices. Whether Electron 43 on macOS then shows
Mic Mode for Kermanych is **not documented** and is checked in step 1. An app cannot switch the
mode itself: the operator picks it in Control Center and macOS remembers it per app.

## Decisions

1. **Scope: the bridge, the prompt and the microphone; the conversation stays hands-free.**
   Rejected:
   - push-to-talk / hold-to-talk (a key or button held while speaking): it turns the live
     conversation into a walkie-talkie, which the voice-conversation spec rejected (its
     decision 1), and the operator rejected it again;
   - speaker verification (an enrolled voiceprint and a local ONNX model, ~20–25 MB, gating audio
     to the operator's voice): the only option that tells «mine» from «someone else's», but
     needs ~0.5–1 s of audio per decision (delay or clipped first words), false rejections and
     the most work. **The next step if decisions 2–4 are not enough**;
   - Krisp «Background Voice Cancellation»: a paid licence and a third-party SDK.
2. **What reaches the agent: the last continuous phrase.** `takeUtterance` walks back from the
   delegation's `offset_ms` through the fragments that started at or before it and keeps them
   while the gap between one fragment's `end_ms` and the next one's `start_ms` is under
   **3 s** (`VOICE_PHRASE_GAP_MS`, a core constant, not a setting). Older fragments are dropped,
   not kept for the next delegation; fragments after the offset stay for the next one as today.
   `HeardFragment` gains `endMs` from the delta's `end_ms` (missing → `startMs`). Consequence
   the operator accepted: a pause over 3 s inside one request delivers only its second part;
   GPT-Live waits for the operator to finish, so such pauses are rare. Rejected: everything said
   after GPT-Live's or the agent's last words (the background while the agent works stays in);
   showing dropped words struck out in the captions (more UI; captions are transient).
3. **GPT-Live's prompt names the background.** `voiceLivePrompt` gains a «Background» block: the
   operator speaks to you directly and close to the microphone; speech from a TV, radio, video,
   music or other people in the room is not addressed to you; keep listening while the operator
   pauses; never delegate or answer a sound or phrase that is not addressed to you — when unsure,
   keep listening. Risk: GPT-Live ignores a real request; the operator repeats it.
4. **The microphone: macOS Voice Isolation, with a level gate as the fallback.** Step 1 decides:
   - **If Voice Isolation works** — `connectVoice` asks for `echoCancellation: "all"` (and
     whatever else the check shows is needed, e.g. `autoGainControl: false`), Control Center
     shows «Mic Mode» for Kermanych, and with «Voice Isolation» picked a TV or music near the
     operator no longer reaches the input transcript — the «Голос» pane and the README tell the
     operator where to switch it on (Control Center → «Режим мікрофона» → «Ізоляція голосу»). No
     level gate.
   - **If it does not** — `connectVoice` keeps today's constraints plus `autoGainControl: false`,
     and gets a level gate: the track sent to GPT-Live passes through Web Audio (mic → gain →
     `MediaStreamDestination`); the gain opens when the mic level is above a threshold and closes
     after it stayed below for a hold time (hysteresis, so word endings are not cut). The
     threshold is picked in the «Голос» pane, stored with `persisted('kermanych.voice.gate', …)`.
     It applies to the conversation only; dictation keeps its own `vadStep`, no gate and the
     browser's automatic gain. Known limit: a loud source close to the microphone still passes.

   **Outcome of step 1 (2026-11-04): the fallback.** In Electron 43 on this Mac,
   `getSupportedConstraints()` lists `voiceIsolation` and the track's capabilities offer
   `voiceIsolation: [true, false]` and `echoCancellation: [true, false, "remote-only", "all"]`;
   `echoCancellation: "all"` was granted (`getSettings()` echoes it). But `getUserMedia` with
   `voiceIsolation: true` never resolved, and afterwards no `getUserMedia` resolved in a fresh
   Electron process (a fake capture device included) and the CoreAudio device list itself hung —
   the system audio daemon was left stuck. Shipping a constraint that can hang the conversation's
   start and the machine's audio is not acceptable, so decision 4 took its fallback. As built:
   - the gate runs in an **AudioWorklet** (`lib/voice-gate.worklet.ts`, loaded via Vite's
     `?worker&url`), not on a timer in the window: Chromium throttles a background window's
     timers, and the operator often talks while looking at another app. Its decision,
     `gateStep`, is a pure function in `apps/ui/src/lib/voice-gate.ts` rather than core: the
     worklet bundles only that file, with no core index and nothing that assumes a window;
   - the threshold is a **choice of four levels**, not a slider (the kit has no slider):
     «Вимкнено» 0, «Низький» 0.04, «Середній» 0.08 (default), «Високий» 0.15 on the meter's scale
     (`levelOf`: RMS × 6, shared with the voice bar's meter). It applies at once, to a running
     conversation too;
   - calibration happens in the conversation itself: the voice bar's level meter shows the
     threshold as a mark and dims while the gate is closed. No microphone is opened in Settings.

   The level gate and `autoGainControl: false` are passed by the voice store only, so dictation,
   which shares `connectVoice`, keeps today's microphone.
5. **Background sound no longer keeps the conversation alive.** `lastActivityAt` stops updating on
   `session.input_transcript.delta`; it still updates on GPT-Live's speech
   (`output_transcript.delta`), on a delegation, on `session.started` and when the agent's turn
   ends. The 3 minutes (`shouldHangUp`) now mean «no conversation happened», whatever the room
   sounds like. Talking to GPT-Live still counts: every answer it gives is its speech.
6. **README:** «What the agent gets» says «your last phrase before the hand-off» instead of «your
   words since the previous hand-off»; the hang-up line drops «no speech either way»; a short
   «Noisy room» bullet: what is filtered, the threshold and its mark, a headset as the most
   effective fix.

## Design

### Core (`packages/core`)

- `HeardFragment = { text; startMs; endMs }`.
- `VOICE_PHRASE_GAP_MS = 3000`; `takeUtterance(heard, offsetMs)` → `{ text, rest }` per
  decision 2 (`rest` = fragments with `startMs > offsetMs`; dropped ones are in neither).
- `voiceLivePrompt(language)` — decision 3's lines.
- `gateStep` and `levelOf` live in `apps/ui/src/lib/voice-gate.ts` (decision 4, as built).

### UI (`apps/ui`)

- `stores/voice.ts`: store `endMs: Number(e.end_ms ?? e.start_ms ?? 0)`; drop the
  `lastActivityAt` update on input deltas, add it on `session.delegation.created` (decision 5);
  start the connection with `{ gate }`, forward a changed threshold with `setGate`, expose
  `gate` / `gateOpen` in the bar state.
- `lib/voice-gate.ts`: `levelOf`, `gateStep` (open at the threshold; kept open above 0.6 × it and
  for 500 ms below; 5 ms attack, 80 ms release), `VOICE_GATE_LEVELS`.
- `lib/voice-gate.worklet.ts`: `kermanych-voice-gate`, the gain glided per block; port in
  `{ threshold }`, out `{ open }` on change.
- `lib/voice-connection.ts`: with `options.gate`, `autoGainControl: false` and mic → worklet →
  `MediaStreamDestination` → the peer connection; the meter reads the microphone before the
  gate; `setGate(threshold)`; `onGate(open)`.
- `lib/voice.ts`: `voiceGatePick` (persisted); `VoiceBarState.gate` / `gateOpen`.
- `KVoiceBar`: the threshold mark and the dimmed fill; the kit gallery sample.
- `SettingsPage` «Голос»: «Поріг шуму мікрофона» (`KSelect`) with a note; i18n `uk` / `en`.
- `src/env.d.ts`: a `*?worker&url` module declaration (Vite's own types do not resolve here).

## Steps

1. **Check Voice Isolation** in the dev app (Electron 43) on macOS: start a conversation with
   `echoCancellation: "all"` (then with `voiceIsolation: true`, then both); see whether Control
   Center offers «Mic Mode» for Kermanych / Electron; with «Voice Isolation» on and a video playing
   speech near the laptop, read the input transcript (captions). Record the result here and pick
   the branch of decision 4.
2. Core: `takeUtterance` with the gap rule, `endMs`, the prompt lines, with tests.
3. UI: fragment timing, activity, the microphone branch from step 1 (the gate and its level
   choice).
4. README.
5. Live run with the operator in a noisy room (a video with speech and music playing).

## Verification

- `pnpm --filter @kermanych/core test`: `takeUtterance` — a request after a long stretch of
  background keeps only the last phrase; a pause under 3 s keeps both halves; a pause over 3 s
  keeps the second; fragments after the offset stay for the next delegation; a missing `end_ms`.
  `gateStep` opens, holds, closes (`apps/ui/test/voice-gate.spec.ts`).
- `pnpm --filter @kermanych/ui test`: the voice store — input deltas alone do not postpone the
  hang-up; GPT-Live's speech does; a delegation sends only the last phrase.
- Live with the operator: a video with speech playing while the agent works → the next spoken
  request reaches the agent without the video's words; music in the room → GPT-Live does not
  delegate it; with only background sound for 3 minutes and no running turn → the conversation
  ends. Dictation still transcribes. The «Середній» default neither cuts the operator's normal
  speech nor lets the TV through — else the levels in `VOICE_GATE_LEVELS` are retuned.

### Results

- `@kermanych/core`: 323 passed (incl. `voice-bridge.spec.ts`: the background before the last
  phrase dropped, a pause under the gap kept). `tsc --noEmit` clean.
- `@kermanych/ui`: 86 files, 938 passed (incl. `voice-gate.spec.ts`, 5, and the store's «hangs
  up while only the background is heard»). `vue-tsc --noEmit` reports nothing in the touched
  code; its other errors come from unbuilt workspace packages, as on the base commit.
- `@kermanych/api`: `voice.service.spec.ts` and `voice.deliver.spec.ts`, 20 passed.
- The worklet in the dev server (preview, Chromium): an `OfflineAudioContext` fed a 220 Hz sine
  through `kermanych-voice-gate` with threshold 0.08 — amplitude 0.1 passed unchanged (RMS
  0.0707), amplitude 0.005 came out silent (RMS 0), and the same quiet input passed with the
  gate off (RMS 0.0035).
- `quasar build -m electron --skip-pkg` emits `assets/voice-gate.worklet-*.js` as one
  self-contained script and references it with `new URL(…, import.meta.url)`, so it resolves
  under `file://`.
- The «Голос» pane shows «Поріг шуму мікрофона» with «Середній» picked; the kit gallery's voice
  bar shows the mark at the threshold.
- Not run here: a live conversation with a real microphone. After step 1 this machine's audio
  capture hung (see decision 4), so the end-to-end check is the operator's (step 5).

## Risks

- Voice Isolation may be unavailable to Electron; the fallback gate does not stop a loud source
  next to the microphone.
- The gate levels are reasoned from the meter's scale, not measured in a real room; step 5 tunes
  them.
- The prompt is a hint: GPT-Live may still delegate a TV phrase (decision 2 then keeps it short)
  or ignore a quiet real request.
- A request with a pause over 3 s loses its first part.

## Out of scope

Push-to-talk; speaker verification and Krisp (decision 1, the next step if needed); switching
Mic Mode from inside Kermanych (macOS gives apps no API for it); noise handling in Windows / Linux
builds beyond the fallback gate.

## Documentation impact

`kermanych/README.md`, «Voice conversation»: decision 6.
