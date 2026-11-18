# Local voice dictation: speak to «Синергія» and every dictation field without OpenAI

- **Branch:** `feature/synergy-voice-dictation-summary`
- **Scope:** `packages/core` (the hallucination filter, the send countdown, the model manifest,
  the Live prompt), `apps/api` (the local recogniser: model download, the engine, the
  transcription endpoint; removal of the OpenAI dictation path), `apps/ui` (the dictation store on
  a local transport, composer dictation with the send countdown and voice answers, the 🎤 mode
  menu, the «Голос» settings pane, the Live barge-in), `apps/ui` packaging (`whisper-server` in
  the `.dmg`, `sherpa-onnx-node` in the AppImage), i18n `uk` / `en`, `kermanych/README.md`.
- **Status:** decisions agreed with the operator in the deep-analysis interview (2026-11-14) on
  top of a measured comparison of local recognisers on the operator's own recordings; approved
  the same day; implemented on this branch (see «Verification»). The live microphone run is the
  operator's.

## Goal

The operator used the voice conversation on «Синергія» and liked it, with two problems:

1. **Cost.** GPT-Live bills $0.05 per minute of an open connection; some sessions ran over an
   hour (≈ $3). In «Синергія» the operator is always speaking or watching a change, so the
   3-minute silence hang-up never fires.
2. **It cannot be interrupted.** After a change that took seconds, GPT-Live spends ~15 s retelling
   it and ignores the next request or «відміни» until it finishes.

In «Синергія» the result is on screen: no spoken answer is needed, only the operator's words as
text. That needs speech-to-text, not a voice model, and speech-to-text can run on this machine
for free.

## Context

- **Voice today.** Two OpenAI paths share one WebRTC module (`apps/ui/src/lib/voice-connection.ts`):
  - the voice conversation (`stores/voice.ts`, GPT-Live, `POST /api/voice/session`) on every
    `KPanel` with `voiceable`: «Агенти», «Чат», «Синергія» (`useVoicePanel`);
  - dictation (`stores/dictation.ts`, `gpt-live-transcribe`, `POST /api/voice/dictation`,
    $0.017/min) under the description of eight task popups via `useDictationField` +
    `KDictation`: «Нова задача» on «Агенти», the «Дошка» card editor, «Синергія»'s «Задача →»,
    a task from a document, a finding → task, the Jira / Linear / Plane issue editors.
- **Pieces that stay.** `packages/core/src/dictation.ts`: `vadStep` (phrase end after 800 ms below
  `DICTATION_SPEECH_LEVEL`, idle stop), `insertDictated` (a phrase at the caret).
  `packages/core/src/voice-bridge.ts`: `parseUiAnswer` (number / yes-no / free text against a
  `pendingUiRequest`). `lib/voice-gate.ts`: the noise gate and its threshold setting.
- **The decision block** («Потрібне рішення», `KPanel.vue:101-156`) is separate from the
  composer: `select` options, `confirm` buttons, or its own input / editor field.
- **Platforms.** The app ships a macOS arm64 `.dmg` and a Linux x64 AppImage
  (`apps/ui/quasar.config.ts:108-127`). The api runs inside Electron's main process; native
  modules ship as N-API prebuilds unpacked from the asar (`asarUnpack`, `quasar.config.ts:143`).
- **GPT-Live's interruptions** ([prompting guide](https://developers.openai.com/api/docs/guides/live-prompting)):
  instructions can encourage it to yield but give no precise control; a guaranteed stop is the
  client's own playback ([server controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live#control-playback-when-needed)).
  `voiceLivePrompt` has no interruption policy and asks to retell «close to its text», and
  `speakPending` sends every ≤900-character chunk of the reply at once.

### The comparison (2026-11-14)

The operator recorded 15 phrases (11 with a reference text including «еее», «мммм», a cough, a
quiet phrase and English terms; one cough/silence-only clip; three free phrases) in Chrome with
the app's microphone constraints (echo cancellation, noise suppression). Throwaway bench outside
the repository (`~/kermanych-stt-bakeoff`). M4 Pro.

| Engine | WER | Noise-only clip | Median latency per phrase |
|---|---:|---|---:|
| whisper.cpp large-v3-turbo q8 (Metal) | 26 % | «Дякую за перегляд!» | 0.5–0.6 s |
| same + vocabulary prompt | 27 % | «Дякую.» | 0.5–0.6 s |
| same + prompt + whisper.cpp's Silero VAD | 22 % | empty | 0.6 s |
| same + Silero VAD, no prompt | 30 % | empty | 0.6 s |
| Whisper turbo int8 via sherpa-onnx, CPU | 26 % | «Дякую за перегляд!» | 1.7 s (3.6 s for 23 s of speech) |
| same, CoreML | 27 % | «Дякую за перегляд!» | 4.4 s (14.7 s) |
| Parakeet TDT 0.6B v3 int8 via sherpa-onnx, CPU | 30 % | empty | 0.2 s (0.5 s) |
| Apple `DictationTranscriber` uk-UA | 42 % | empty | 0.14 s |
| Apple `SFSpeechRecognizer` uk-UA on-device | 54 % | empty | 0.11 s |

WER is inflated by the operator paraphrasing the reference («Так, цей блок…»); the reading of
the texts:

- Whisper is best on long free speech (the 18 s and 23 s phrases are near verbatim with «UI-кит,
  дропдаун, deploy, production»); the prompt brings «KPanel», «placeholder», «email».
- Whisper invents text on silence or a cough. whisper.cpp's Silero VAD stops that but cut quiet
  speech: the quiet phrase lost «Прибери» and one run truncated a free phrase.
- Parakeet never invents text and is 3× faster, but breaks more Ukrainian words («зробирнішим»,
  «Окей, Пену», «стрінки»).
- Apple loses English terms («Hold він», «Колиска») and `SFSpeechRecognizer` drops the start of
  long phrases. Apple's new `SpeechTranscriber` has no Ukrainian (checked on this Mac).
- No engine let «еее» / «ммм» through; whisper keeps a leading «Ну,». No clean-up pass is needed.
- Web Speech API is not an option: in Electron it fails with `network`
  ([electron#46143](https://github.com/electron/electron/issues/46143)).

## Decisions

1. **Local dictation replaces OpenAI for every «speak → text» case.** «Синергія»'s 🎤 becomes
   local dictation only, and the eight task-popup dictation fields move to the local engine.
   GPT-Live stays only where a spoken reply is the point: «Агенти» and «Чат». Rejected: «Синергія»
   only (dictation would keep needing a paid key for the same job); removing GPT-Live entirely
   (no spoken decision blocks in «Глибокий аналіз»; can follow later as a small change).
2. **On «Агенти» and «Чат» the operator picks the mode at the 🎤 button.** A click starts the
   last mode used; a ▾ beside it opens «🎙 Диктування (локально, безкоштовно)» / «🗣 Live-розмова
   (GPT-Live, $0.05/хв)». The choice is remembered on this machine (`persisted`), default
   **dictation**, so the paid mode never starts by accident. «Синергія» has no menu. Rejected: a
   setting (a trip to Settings to talk in a deep analysis); two buttons (composer space for the
   rarer mode).
3. **In a composer, dictated text lands in the composer, then sends itself after a visible
   countdown.** Each phrase is inserted at the caret (`insertDictated`); after a longer pause a
   countdown runs on the send button. Speaking again appends and restarts it; editing the
   text by hand cancels the auto-send until Enter; Enter sends at once; Esc cancels the send and
   keeps the text. Dictation stays on between messages until stopped, so changes can follow each
   other hands-free. The pause is `DICTATION_SEND_MS` = **2.5 s**, measured: on the operator's
   15 recordings (100 ms level windows, the dictation speech level) pauses inside one request
   reached 2.0 s (a list said with pauses, a 21 s free request), so the send waits half a second
   longer. Rejected: sending at once (a misheard word goes to the agent); insert only (not
   hands-free).
4. **Engine by platform: Whisper on macOS, Parakeet on Linux.** macOS runs whisper.cpp
   (`large-v3-turbo` q8, Metal) as a `whisper-server` binary built for the `.dmg`; Linux runs
   Parakeet TDT 0.6B v3 (int8) through `sherpa-onnx-node`, whose N-API prebuilds ship like
   `better-sqlite3`. No setting: the platform decides. Whisper over sherpa-onnx was measured 3×
   slower on CPU and worse with CoreML, so Whisper means whisper.cpp. **Fallback:** if building
   and shipping `whisper-server` for the `.dmg` proves impractical, macOS uses Parakeet too.
   Rejected: Whisper everywhere (several seconds per phrase on a Linux CPU [INFERENCE], a second
   native build); both engines with a setting (the most to maintain).
5. **The model is downloaded on demand.** The first dictation without a model, and Settings →
   «Голос», offer «Завантажити модель розпізнавання (874 МБ / 670 МБ)»: progress, cancel, resume
   after a break (HTTP Range), a sha256 check, stored in `~/.kermanych/models/` (beside
   `~/.kermanych/resources`), and «Видалити модель». Until it is there, dictation is unavailable
   and shows that button; there is no fallback to OpenAI. Rejected: inside the `.dmg` (+0.9 GB on
   every install and update, for users who never speak); a background download at first launch.
6. **Text appears phrase by phrase, not word by word.** `vadStep` already splits speech on 0.8 s
   pauses; each finished phrase is transcribed and inserted at once, while the send countdown of
   decision 3 waits for the longer pause. While a phrase is spoken the bar shows «слухаю…» with
   the level. Rejected: text only at the end of the whole utterance (a 20 s monologue appears at
   once); live re-transcription every second (constant GPU/CPU load on a machine shared with
   agents, cost growing with phrase length).
7. **Live gets a working barge-in; nothing else in Live changes.** `voiceLivePrompt` gains
   OpenAI's interruption policy (stop at once, even mid-sentence; a new request or a correction
   while retelling drops the rest of the retelling and is delegated). The client guarantees it:
   when the operator is heard while GPT-Live is speaking (a `session.input_transcript.delta`
   arrives — GPT-Live heard them — or the gate opens within 300 ms of GPT-Live's last words), the
   window mutes GPT-Live's audio element and drops the retelling chunks not yet sent; audio
   returns 0.8 s after the operator stops. Retelling chunks are sent one at a time, the next once
   GPT-Live's speech of the previous one has been quiet for 0.7 s (8 s safety timeout), so there
   is something to drop. Rejected: no
   Live change; an auto-pause of idle Live sessions (a visible behaviour change with its own
   risks — resume delay, lost first words — for a mode that is now opt-in; its own task if Live
   stays expensive).
8. **Dictation answers the decision block.** While `pendingUiRequest` waits, each dictated phrase
   goes through `parseUiAnswer` first:
   - `select` / `confirm` recognised («другий», «2», «варіант три», «так», «ні»): the option or
     button is highlighted and the answer goes through the same countdown as decision 3; Esc
     cancels;
   - `input` / `editor`: the text goes into the block's own field, under decision 3's rules;
   - not an answer (a question to the agent, say): into the composer as usual.

   Rejected: composer only (constant switching between voice and mouse in «Глибокий аналіз»);
   only the text fields.

### Defaults taken without a separate question

9. **Where the engine runs.** In the local api. whisper.cpp is a `whisper-server` child process
   on a free 127.0.0.1 port (in the child ledger, stopped on quit like the other children);
   Parakeet decodes in a worker thread so the api's event loop never blocks. The model (~1 GB of
   RAM) starts loading when 🎤 is pressed, so it loads while the first phrase is spoken, and is
   unloaded after 10 minutes without dictation. Measured: `whisper-server` alone accepts
   connections 0.3–0.4 s after spawn (model file in the page cache), and through the api the
   first phrase after a cold start took 4.2 s (spawn, model load, ledger, readiness poll) against
   ~0.5 s for every later one — the reason the load starts at 🎤, not at the first phrase.
   Parakeet in the worker: 1.6 s for the first phrase, 0.1–0.5 s after.
10. **One transport.** The window captures PCM through an AudioWorklet (echo cancellation and
    noise suppression on, as today), runs `vadStep` on it, and posts each finished phrase as a
    16 kHz mono WAV to `POST /api/voice/transcribe` → `{ text }`. The noise gate's threshold
    (Settings → «Голос» → «Поріг шуму мікрофона») applies to dictation too: a phrase whose level
    never crossed it is not sent.
11. **Hallucinations are filtered, whisper.cpp's VAD is not used.** A phrase whose whole text is a
    known Whisper invention («Дякую.», «Дякую за перегляд!», «Субтитри …», «Продовження далі»,
    their English counterparts, a bare «Музика» / «Music» heard for background music or a hum)
    or a described sound («*coughs*», «*клук*», «[музика]» — seen on the cough-only recording
    with some prompts) is dropped — a pure core rule with a spec. Silero
    VAD inside whisper.cpp is off: it cut quiet speech in the comparison.
12. **Language and vocabulary.** The engine's language is the agent's language («Мова спілкування
    агента»), else the UI locale, as dictation picks it today. Whisper gets a fixed one-sentence
    prompt with technical vocabulary (`DICTATION_PROMPT`). Measured on the recordings:
    no prompt 25.9 % WER (no «KPanel», «placeholder», «email»); the word-list prompt from the
    comparison 27.0 % (got the terms, broke «відміни» → «від мені»); an English instruction
    36.2 %; a natural Ukrainian sentence naming KPanel / toast / placeholder / email **23.7 %**
    and kept «відміни» — chosen. One speaker, 15 phrases: a direction, not a benchmark.
    Parakeet takes no prompt.
13. **⌥D toggles dictation in a composer too**, as in the popups. A dictated message is sent as
    plain text: no voice note (the reply is not read aloud, and the operator saw the text before
    it went) and no 🎤 mark in the log.
14. **Stopping.** Composer dictation stops on 🎤 / ⌥D, when the panel unmounts (text already
    inserted stays), and after 10 minutes without speech (free, but the microphone should not
    stay open forever). Popup dictation keeps today's rules (1 minute of silence; submit waits
    for the last phrase; close drops it). One dictation per app, as today; a Live conversation
    elsewhere is muted while dictation runs, as today.
15. **Clean cutover of the OpenAI dictation path.** `POST /api/voice/dictation`,
    `VoiceService.createDictation`, `dictationSession`, `DICTATION_MODEL`, `DICTATION_PROMPT`,
    `isDictationLanguages` and the dictation half of `voice-connection.ts` usage are removed. The
    OpenAI key in Settings → «Голос» is described as the Live-only key.

## Design

### Core (`packages/core`)

- `dictation.ts`: keeps `vadStep`, `insertDictated`; gains `DICTATION_SEND_MS` (decision 3),
  `DICTATION_COMPOSER_IDLE_MS` (decision 14), `isHallucination(text, language)` (decision 11),
  the Whisper prompt (decision 12). Loses the OpenAI session builder (decision 15).
- `local-stt.ts`: the model manifest per platform — engine, file names, URLs, sizes, sha256.
- `voice.ts`: `voiceLivePrompt` with the interruption policy (decision 7).

### API (`apps/api`)

- `LocalSttService`: model status (`absent` / `downloading {received, total}` / `ready`),
  download with Range resume and sha256 check into `~/.kermanych/models/`, cancel, delete; the
  engine lifecycle of decision 9 behind one `transcribe(wav, language) → text` interface with
  a `WhisperCppEngine` and a `SherpaParakeetEngine`.
- `VoiceController`: `GET /api/voice/model`, `POST /api/voice/model/download`,
  `DELETE /api/voice/model/download` (cancel), `DELETE /api/voice/model`,
  `POST /api/voice/transcribe` (WAV body, size-capped) → `{ text }`; coded errors
  `stt_model_missing`, `stt_engine_failed`, `stt_audio_invalid`. `POST /api/voice/dictation` is
  removed.

### UI (`apps/ui`)

- `lib/voice-capture.ts`: microphone → AudioWorklet PCM + level, shared by dictation (the gate
  graph of `voice-connection.ts` reused, without WebRTC).
- `stores/dictation.ts`: the local transport; per-phrase transcribe calls kept in speaking order
  (the existing segment ordering); owners are a popup field or a composer.
- `composables/useComposerDictation.ts`: decision 3's countdown, decision 8's routing to the
  decision block, decision 14's stopping. `KComposer` shows the countdown on the send button and
  the «слухаю…» bar; `KPanel` highlights the pending option.
- `KComposer` 🎤: a split button with the ▾ mode menu where the host offers Live (decision 2).
  `useVoicePanel` routes to dictation or Live.
- Settings → «Голос»: «Локальне розпізнавання» — the model, its size, download / progress /
  cancel / delete; the OpenAI key text says it is for Live only.
- `stores/voice.ts`: barge-in (decision 7) — sequential retelling chunks, mute and drop on
  operator speech.
- Async states per README «Async states»: download = progress + cancel, model load = the
  «слухаю…» bar's connecting state, transcribe = the phrase's pending draft.

### Packaging (`apps/ui`)

- macOS: `apps/ui/scripts/build-whisper-server.sh` builds `whisper-server` from whisper.cpp
  **v1.9.5** (commit pinned and checked) as a static arm64 binary (`BUILD_SHARED_LIBS=OFF`,
  `GGML_METAL=ON`, `GGML_METAL_EMBED_LIBRARY=ON`, `GGML_NATIVE=OFF`, `GGML_OPENMP=OFF`, minimum
  macOS 13.3 — ggml's BLAS path needs it), ~8 MB, system frameworks only (the script fails
  otherwise). `beforePackaging` runs it on macOS; `mac.extraResources` ships it as
  `bin/whisper-server`. The api looks for `KERMANYCH_WHISPER_SERVER`, then the bundled binary,
  then the monorepo's `.whisper-build/bin/whisper-server` (a dev run uses what the release
  ships), then `whisper-server` on PATH (Homebrew's `whisper-cpp`).
- Linux: `sherpa-onnx-node` + `sherpa-onnx-linux-x64` in the api's dependencies, unpacked from
  the asar.

## Steps

1. Core: the constants, the hallucination filter, the manifest, the Live prompt, with tests.
2. API: the model manager and the engines, the endpoints, removal of OpenAI dictation, with tests.
3. UI: capture, the dictation store on the local transport, popups unchanged in behaviour.
4. UI: composer dictation — countdown, decision-block answers, the 🎤 mode menu, «Синергія».
5. UI: the settings pane; Live barge-in.
6. Packaging: `whisper-server` in the `.dmg`, sherpa-onnx in the AppImage.
7. Measurements on the operator's recordings (send pause, prompt on/off, model load time); README;
   a live run with the operator in the preview.

## Verification

- `@kermanych/core` (`vitest run`): 33 files, 473 passed — incl. `dictation.spec.ts` (language,
  inventions incl. described sounds, the gate-raised speech level, the composer idle limit).
- `@kermanych/api` (`vitest run`): 135 files, 1412 passed, 4 skipped — incl.
  `local-stt.service.spec.ts` (14: download through a redirect, Range resume, a server ignoring
  Range, sha256 mismatch, cancel then resume, delete; WAV validation; model missing; inventions →
  `""`; one phrase at a time; warm once; engine error and restart; idle unload; shutdown) against
  a local fake server and a fake engine. `tsc --noEmit` clean.
- `@kermanych/ui` (`vitest run`): 95 files, 1026 passed — incl. the rewritten
  `dictation-store.spec.ts`, `stt-model-store.spec.ts`, `composer-dictation.spec.ts` (10:
  countdown, restart on speech, hand edit holds the send, Esc, «другий» answers a `select`, an
  `input` answer, a non-answer to the composer) and `voice-store.spec.ts` (sequential retelling
  chunks; barge-in mutes, drops the rest, unmutes). `vue-tsc --noEmit` clean.
- Both real engines through `LocalSttService` on the operator's recordings (a throwaway script):
  Whisper — «Ні, відміни останню зміну, поверни як було.», «KPanel: зверху додай перемикач
  темної теми.», the 21 s free request verbatim, the cough-only clip `""`; Parakeet in its worker
  on macOS (`KERMANYCH_STT_ENGINE=parakeet`) — the same four, cough `""`.
- Preview (`.kermanych/preview.json`): Settings → «Голос» shows «Локальне розпізнавання ·
  Whisper large-v3-turbo · 874 МБ · готова»; «Агенти» shows 🎤 with ▾ and the menu «Диктування
  (локально, безкоштовно)» / «Live-розмова (GPT-Live, $0.05/хв)»; 🎤 warms the engine (the api
  spawned `.whisper-build/bin/whisper-server`) and, in the embedded browser that never gets a
  microphone, ends in «Немає доступу до мікрофона…»; `POST /api/voice/transcribe` with a recording
  → its text in 0.57 s; a bad WAV → `stt_audio_invalid`; `POST /api/voice/dictation` → 404.
- `build-whisper-server.sh`: v1.9.5 built in ~20 s, `--help` runs, a request to `/inference`
  answered with Metal in use; `otool -L` lists system frameworks and libraries only.

**Not verified here:**

- Speaking into the composer or a popup with a real microphone (the embedded browser refuses it):
  the countdown, Esc, a voice answer to a decision block and «Синергія» hands-free need the
  operator's run in Chrome against the preview or in the desktop app.
- Live barge-in against GPT-Live itself (needs the operator's key and voice).
- A packaged `.dmg` running the shipped `whisper-server`, and the Linux AppImage with
  sherpa-onnx — no package was built.
- Parakeet's speed and quality on a Linux machine.

## Risks

- Building `whisper-server` for the release (decision 4's fallback is Parakeet on macOS).
- Whisper's inventions beyond the filter list reach the composer; the countdown lets the operator
  catch them.
- A quiet operator below the gate threshold is not transcribed; the threshold is the existing
  setting.
- ~1 GB of RAM while the model is loaded, on a machine shared with agents (decision 9 unloads it).
- Linux quality and speed are the comparison's Parakeet numbers on an M4 Pro, not on a Linux
  machine.

## Out of scope

An auto-pause of idle Live sessions; removing GPT-Live; a project glossary for the Whisper
prompt; dictation in native sessions and «Менеджмент»; speaker verification.

## Documentation impact

`kermanych/README.md`: «Voice dictation («Диктування»)» rewritten for the local engine (model
download, platforms, composer dictation with the countdown, voice answers to decision blocks);
«Voice conversation («Голосова розмова»)» — the 🎤 mode menu on «Агенти» / «Чат», «Синергія»
dictation-only, interrupting GPT-Live, the key being Live-only. The earlier specs
(`2026-11-02-voice-conversation.md`, `2026-11-03-voice-dictation.md`) stay as history; this
document supersedes their OpenAI dictation and «Синергія» voice parts.
