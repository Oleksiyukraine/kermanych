# Voice conversation («Голосова розмова»): talk to a session's agent through GPT-Live

- **Branch:** `feature/add-voice-assistant-mode`
- **Scope:** `packages/core` (the bridge logic, the agent-side wrapper, the Live prompt),
  `apps/api` (the OpenAI key, the SDP exchange, the voice flag on a message, unwrapping on
  rehydrate), `apps/ui` (the voice store, the voice bar, the top-bar pill, the «Голос» settings
  pane, the Electron microphone permission), i18n `uk` / `en`, `kermanych/README.md`.
- **Status:** decisions agreed with the operator in the deep-analysis interview (2026-11-02),
  approved the same day; the Ukrainian checkpoint passed; implemented on this branch (see
  «Verification»).

## Goal

The operator asked for Kermanych as a voice assistant: discussing a task by voice the way
ChatGPT's voice mode works. The answer is a **voice conversation with the agent of a session**:
a full-duplex voice model listens and speaks, and every request about the task goes to the
session's own agent (Claude / omp, with the repository and its tools). The voice model is only
the agent's voice: it never answers about the task itself.

## Context

- **No voice code exists.** No microphone, speech, audio or WebRTC code or dependency anywhere;
  no `NSMicrophoneUsageDescription`; no permission handler for the main window (Electron grants
  everything when none is set); the only handler is the session browser's
  (`src-electron/session-browser/browsers.ts:591-593`). The `.dmg` is unsigned
  (`quasar.config.ts:84-86`, `identity: null`), with no hardened runtime.
- **No OpenAI credential.** AI access goes through the `claude` / `omp` / `codex` CLI logins only.
  Per-user tokens on this machine follow the Linear/Jira custody rule: a SQLite table keyed by
  user (`linear_tokens`, `registry.service.ts:470,647-676`), a password `KField` in the UI.
- **The chat.** `KPanel` + `KComposer` host every managed conversation on «Агенти» (agents, deep
  analyses, discussions, reviews), «Чат» and «Дизайн». Sending is `orchestrator.sendMessage` →
  `POST /sessions/:id/message {text, mode, images}` → `SupervisorService.deliver`. Each page
  picks the mode with an identical `nextMode()` (`AgentsPage.vue:3205`, `ChatPage.vue:504`,
  `DesignPage.vue:441`): `prompt` for an empty session, `follow_up` when `done`, else `steer`.
- **Replies are whole messages.** `transcript-reducer.ts:196-216` emits one `assistant_text` per
  assistant message at `message_end`; a turn can hold several, with tools between them. A turn
  ends when the session status leaves `thinking` / `tool` for `done` or `waiting_input`.
- **Agent questions.** omp's ask tool sets `Session.pendingUiRequest` (`RpcExtensionUIRequest`:
  `select` / `confirm` / `input` / `editor`, `types.ts:240-244`), rendered as KPanel's decision
  block (`KPanel.vue:101-156`) and answered with `POST /sessions/:id/answer`.
- **The transcript after a restart is rebuilt from the runtime's history**
  (`messages-to-transcript.ts:56-61`, both runtimes): a user row shows exactly what the model
  received. Anything Kermanych wraps around the operator's text must be unwrapped there.
- **Native sessions and «Менеджмент»** have no `KPanel` (a PTY; a separate chat store).
- **GPT-Live** (`gpt-live-1`, [guide](https://developers.openai.com/api/docs/guides/live)) is
  OpenAI's full-duplex voice model built for a separate backend:
  - *client delegation* ([delegation guide](https://developers.openai.com/api/docs/guides/live-delegation)):
    the model emits `session.delegation.created` (metadata only, no text); the application
    builds the request from `session.input_transcript.delta`, runs its own backend, and returns
    results with `session.commentary.append` (spoken, paraphrased) or `session.thinking.append`
    (silent context), ≤500 tokens per append, several per delegation allowed;
  - WebRTC ([quickstart](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)):
    the browser makes an SDP offer, the application server exchanges it with
    `POST /v1/live/sessions` using the API key, events ride the data channel;
  - $0.05 per minute billed per second, plus 15 s billed at WebRTC initialisation and credited
    once the session runs ([model page](https://developers.openai.com/api/docs/models/gpt-live-1));
  - voices are tied to a language / accent; none is Ukrainian.

## Decisions

1. **A voice conversation with the session's agent, not a separate voice assistant.** Rejected:
   dictation only (not a discussion); dictation + read-aloud (no conversation); a turn-based
   STT → agent → TTS loop (a walkie-talkie, no barge-in, its VAD/TTS plumbing thrown away later).
2. **Provider: OpenAI GPT-Live with client delegation.** The operator's call: ChatGPT's live
   voice handles Ukrainian well. Alternatives reviewed (2026-11-02):
   - Gemini 3.8 Live: Ukrainian officially listed, async `NON_BLOCKING` functions, ~$0.023/min;
     but not full duplex, ~10 min connection lifetime, 15 min sessions without compression. It is
     the **fallback** if the Ukrainian checkpoint fails; the bridge stays the same.
   - xAI Grok Voice (`grok-voice-3.0`): Ukrainian not listed, synchronous function calls only,
     $0.08/min.
   - ElevenLabs Agents: a cascade (not full duplex), the agent configured in their dashboard, a
     custom LLM needs a public endpoint.
   - Open local models (Kyutai Moshi / Unmute): English / French only.
3. **The OpenAI key is personal, on this machine.** SQLite `voice_keys (user_id PK, api_key)`,
   entered in Settings → Застосунок → «Голос»; `OPENAI_API_KEY` in the API's environment overrides
   it (the `KERMANYCH_LANGUAGE` pattern). It never reaches the renderer or the cloud. Rejected: a
   workspace key in Supabase Vault (a migration, RLS, spend control, and every machine would need
   the plaintext key or a cloud proxy); env only (no way for a normal user).
4. **Where: every page with `KPanel`** — «Агенти» (agents, deep analyses, discussions, reviews),
   «Чат», «Дизайн». Not native sessions (no transcript, only a PTY), not «Менеджмент» (its own
   chat store; a later step).
5. **GPT-Live is the agent's voice.** It delegates everything about the task, the code or a
   decision; it answers only service requests itself: «repeat», «shorter», «what is it doing
   now?» (from the silent progress it has received), «stop», greetings. It retells the agent's
   reply close to the text, adding nothing. It asks back **only** when it did not hear or the
   phrase broke off — never about substance. Rejected: GPT-Live as a co-thinker (two brains, it
   invents things about code it cannot see, and the agent misses part of the discussion — fatal
   for a deep analysis, whose document is written from this conversation).
6. **What the agent gets.** The delegated text is the input transcript since the previous
   delegation, sent with the same `nextMode()` rule as typed text (so speaking into a running
   turn steers it). The message carries `voice: true`; the API prepends a fixed voice note
   (`VOICE_NOTE` in core: «this is a speech transcript, recognition errors are possible, ask if
   something reads as nonsense; your reply will be retold aloud: keep it short, no tables or
   long code blocks, options as a short numbered list; paths and code may stay, they remain in
   the chat»). The transcript row keeps the operator's raw text and is marked
   `UserEntry.via: 'voice'` (🎤). `messagesToTranscript` recognises the note and restores the
   raw text and the mark after a restart. Rejected: no note (the agent writes tables and code,
   the retelling loses it); a system-prompt append (read at spawn only, so turning voice on
   mid-session would need a respawn).
7. **The decision block is spoken and answered by voice.** When `pendingUiRequest` appears, its
   title, message and numbered options go to `commentary.append`. The next delegation is parsed
   as the answer instead of a message:
   - `confirm`: yes / no words (`так`, `ні`, `звісно`, `не треба`, `yes`, `no`, …);
   - `input` / `editor`: the transcript as is;
   - `select`: a number (`два`, `другий`, `варіант три`, `2`) or an unambiguous match of an
     option's text; anything else selects nothing, and GPT-Live asks for the option number.

   The on-screen buttons keep working; whichever answers first wins. Rejected: not voicing the
   block (the conversation breaks exactly where deep analysis asks the most); a classifier call
   to a small OpenAI model (another paid call and failure point; can be added into the same
   parser later).
8. **One conversation per app, bound to one session.** It keeps talking to session X when the
   operator selects another agent or page. A top-bar pill «🎤 X · 04:12» with «Вимкнути
   мікрофон» and «Завершити» shows while it runs. Starting one in another panel ends the current
   one after a confirmation. It ends on «Завершити»; when the session is archived, removed or
   errors (GPT-Live says why); when the window closes; and after **3 minutes of silence** — no
   operator speech, no GPT-Live speech and no running agent turn. Ending never stops the agent's
   turn. No automatic reconnect: a dropped connection ends the conversation with a notice.
   Rejected: following the selected session (easy to dictate to the wrong agent); no silence
   timeout (a forgotten conversation keeps billing).
9. **On screen: a voice bar above the composer; the session transcript unchanged.** State
   («слухаю» / «чую тебе» / «говорю» / «агент працює»), a mic level, live captions of the current
   phrase (operator from `input_transcript.delta`, GPT-Live from `output_transcript.delta`), 🔇
   and «Завершити». Captions are not stored. Rejected: storing GPT-Live's lines as notices
   (duplicates of the agent's reply, noise the agent never sees); no captions (recognition
   errors stay invisible until they reach the agent).
10. **The bridge lives in the renderer; its logic is a pure core module.** Audio and events ride
    one WebRTC connection in the window. `packages/core/src/voice-bridge.ts` decides everything
    without side effects; a UI store wires it to the orchestrator. The API only keeps the key,
    exchanges the SDP and checks the key. Rejected: an API sideband WebSocket (a second
    connection and lifecycle, and the conversation still dies with the window that holds the
    audio).
11. **Settings → Застосунок → «Голос»:** the OpenAI key (password field, «Перевірити», a «set by
    environment variable» note when `OPENAI_API_KEY` applies) and the GPT-Live voice (default
    chosen at the live checkpoint). The conversation language is not a setting: it follows «Мова
    спілкування агента» (`en-ste*` → English), falling back to the UI locale (`uk` by default),
    so the retelling never translates. Rejected: a separate language picker (an agent writing in
    English would be translated on the fly).
12. **Verification includes a live checkpoint with the operator's key**, entered in the
    preview's «Голос» pane (its temp DB), so the key never passes through the agent: see «Steps» 1.

## Design

### Core (`packages/core`)

- `voice-bridge.ts`, pure, no I/O:
  - `VoiceBridgeState` — the input transcript since the last delegation, the open delegations,
    the bound session's last spoken entry id, the last activity timestamps.
  - `onDelegation(state, session, transcriptEntries)` → one action: `send {text}` (a message),
    `answer {requestId, value | confirmed}`, or `askAgain {commentary}` (an ambiguous `select`).
  - `parseUiAnswer(request, utterance)` — the decision 7 rules.
  - `describeUiRequest(request)` — the spoken text of a decision block.
  - `toCommentaryChunks(text)` — fenced code and tables replaced by «[code / table shown in the
    chat]», split on paragraph then sentence boundaries into chunks of ≤900 characters (a
    conservative bound under 500 tokens for Cyrillic text).
  - `progressNote(entry)` — a short fact for `thinking.append` from a tool row, at most one per
    15 s.
  - `shouldHangUp(state, agentBusy, now)` — decision 8's 3 minutes.
- `VOICE_NOTE`, `voiceMessagePrompt(text)`, `unwrapVoiceMessage(text)` — decision 6.
- `voiceLivePrompt(language)` — GPT-Live's conversation prompt (decision 5, «speak <language>
  unless the operator switches»).
- `UserEntry.via?: 'voice'` on `user_text`.
- `nextMode(session, transcript)` moves from the three pages to `apps/ui/src/lib/message-mode.ts`
  (beside `MessageMode`, which is a ui type); the pages and the voice store call it.

### API (`apps/api`)

- `voice_keys` table; `RegistryService.get/set/deleteVoiceKey(userId)`.
- `VoiceController`:
  - `GET /api/voice/key` → `{ source: 'env' | 'stored' | null, hint?: '…abcd' }`.
  - `PUT /api/voice/key {key}` (an empty key deletes).
  - `POST /api/voice/check` → `GET https://api.openai.com/v1/models/gpt-live-1` with the key →
    `{ok: true}`, or a 400 with a coded error: `voice_key_missing`, `voice_key_invalid` (401),
    `voice_no_access` (403/404), `voice_quota` (429), `voice_network`, `voice_upstream`.
  - `POST /api/voice/session {sdp, voice, language}` → `POST /v1/live/sessions` with
    `{session: {...}, transport: {type: 'webrtc', sdp}}` → `{id, sdp}`; OpenAI errors map to the
    same codes, a bad offer or voice to `voice_offer_invalid` / `voice_voice_invalid`. OpenAI's own
    error text is never relayed (it can echo part of the key). Plain `fetch`, no `openai` package.
    `voice` is checked against the voice list
    (the 31 of the API reference). The session config is `model`, `instructions`,
    `audio.output.voice` and `delegation: {type: 'client'}`; the answer is
    `{session: {id}, transport: {sdp}}`.
- `POST /sessions/:id/message` accepts `voice?: boolean`: `deliver` prepends `VOICE_NOTE` to the
  body the child gets, stamps the row `via: 'voice'`, and skips harness-command parsing for it.
  Operator triggers still match the raw text.
- `messagesToTranscript` unwraps a user message that starts with the voice note.

### UI (`apps/ui`)

- `stores/voice.ts`: the one conversation — `RTCPeerConnection`, the mic track, the data
  channel, the bound session id, the bridge state, the timer. It watches the orchestrator's
  `transcript_append` / `session_update` for the bound session:
  - an intermediate `assistant_text` or a tool row during a turn → `thinking.append`;
  - the turn's end → the last `assistant_text` as `commentary.append` chunks, then the decision
    block if one is pending;
  - `queued` → «the agent waits for a free slot»; `error` / login required → spoken and the
    conversation ends.
  Commentary uses the delegation id of the voice message that started the turn, else `null`.
- `KVoiceBar` (kit) above the composer in `KPanel` when the panel's session is the bound one;
  a «Голосова розмова» button in `KComposer`'s controls row emits `voice`; `KPanel` passes it on
  and takes the bar state as props (kit components do not talk to stores). AgentsPage,
  ChatPage and DesignPage wire it to the store.
- The top-bar pill in `MainLayout.vue`.
- `lib/settings.ts`: `app-voice` category; `SettingsPage.vue` pane; the voice choice in
  `persisted('kermanych.voice.voice', …)`.
- `KRequestBlock` shows 🎤 on a request whose `user_text` is `via: 'voice'`.
- Async states per README «Async states»: start = `useAsyncAction` (connecting), the key save
  and check = the kit's `loading`.
- i18n `uk` / `en`; kit gallery samples for `KVoiceBar` and the pill.

### Electron (`apps/ui/src-electron`)

- `mac.extendInfo.NSMicrophoneUsageDescription` in `quasar.config.ts`.
- IPC `kermanych:mic-access` → `systemPreferences.askForMediaAccess('microphone')`; preload
  `window.kermanych.voice.requestMic()`; the bridge type.
- A permission request / check handler on the main window's session: `media` allowed for audio
  only, from the app's own origin; every other permission keeps today's grant.

## Steps

1. **Ukrainian checkpoint.** Key storage + `POST /api/voice/session` + the store connecting
   WebRTC with no bridge yet; a delegation was answered by echoing what GPT-Live heard, so
   recognition and speech could be judged end to end (removed in step 4). **Passed
   2026-11-02:** the operator found conversation, voice and sound «дуже непогано» in Ukrainian;
   the default voice stays `marin`.
2. Core: `voice-bridge.ts`, the voice note, `voiceLivePrompt`, `via`, `nextMode`, with tests.
3. API: the `voice` message flag, the unwrap on rehydrate, `check`, with tests.
4. UI: the bridge wiring, `KVoiceBar`, the pill, the settings pane, the 🎤 mark, i18n.
5. Electron: the plist key, the mic-access IPC, the permission handler.
6. README; live end-to-end run with the operator.

## Verification

- `pnpm --filter @kermanych/core test`: `voice-bridge` (delegation text, `parseUiAnswer` for
  every method incl. ambiguous `select`, chunking with code and tables, progress throttle,
  hang-up timing), `voiceMessagePrompt` ↔ `unwrapVoiceMessage` round trip, `nextMode`.
- `pnpm --filter @kermanych/api test`: key custody (stored, env override, delete, the hint never
  the key), `check` and `session` against a faked OpenAI (success, 401, 403/404, 429, network),
  the `voice` flag (child gets the note, row raw with `via`), rehydrate unwrap.
- `pnpm --filter @kermanych/ui test`: the voice store against a faked data channel and injected
  `ServerEvent`s (delegation → `sendMessage` with the right mode; turn end → commentary; pending
  `select` → spoken, answered via `answerUi`; session error → ends; 3 min silence → ends);
  i18n completeness.
- Live (operator's key and voice): step 1, then a deep-analysis conversation on «Агенти» and a
  chat on «Чат» in the preview: speak, steer a running turn, answer a `select` by number, mute,
  end, silence timeout. In the packaged app: the microphone prompt appears and the conversation
  starts.

### Results

- `@kermanych/core`: 24 files, 261 passed (incl. `voice-bridge.spec.ts`, 28).
- `@kermanych/api`: 121 files, 1179 passed, 4 skipped (incl. `voice.service.spec.ts`, 12, and
  `voice.deliver.spec.ts`, 4). `tsc --noEmit` clean.
- `@kermanych/ui`: 74 files passed (incl. `voice-store.spec.ts`, 5); `vue-tsc --noEmit` reports only
  the missing `@kermanych/api` build output the base commit reports too.
- Against the real OpenAI API from the preview api: no key → `voice_key_missing`; a fake key →
  `voice_key_invalid` for both «Перевірити» and a session start.
- A real omp chat in the preview: a `voice: true` message reached the child under the voice note,
  the row showed the raw words with `via: 'voice'`, the agent answered in two short paragraphs,
  and after a restart the rehydrated row (`h1`) still read the raw words with the mark.
- Step 1 live: the operator's Ukrainian conversation in Chrome against the preview.
- In the embedded session browser the microphone is refused and the composer shows «Немає
  доступу до мікрофона…» instead of hanging.

## Risks

- Ukrainian quality of `gpt-live-1` is unverified in OpenAI's docs — step 1 gates it.
- The unsigned `.dmg`: macOS may ask for the microphone again after every new build (TCC keys
  ad-hoc signatures by code hash). The dev app runs the stock `Electron.app`.
- Cost: $0.05/min plus the 15 s initialisation per connection, on the operator's key; the
  silence timeout is the only guard.
- A long agent reply is retold, not read: details live in the chat. The voice note keeps replies
  speakable.

## Out of scope

«Менеджмент»; native sessions; a workspace key; reconnecting a dropped conversation; a second
provider; dictation into the composer without a conversation.

## Documentation impact

`kermanych/README.md`: a «Voice conversation («Голосова розмова»)» section after «Native chats»
(what it does, where the button is, the key and `OPENAI_API_KEY`, the language rule, the 🎤
mark, the silence timeout, cost, the macOS microphone prompt, what is not covered).
