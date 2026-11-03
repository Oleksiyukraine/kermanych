# Voice dictation («Диктування»): speak a task description into every task popup

- **Branch:** `feature/add-voice-task-description-input`
- **Scope:** `packages/core` (pure dictation logic), `apps/api` (the transcription SDP exchange),
  `apps/ui` (the dictation store and composable, two kit components, the seven popups, the voice
  conversation's mic hold), i18n `uk` / `en`, `kermanych/README.md`.
- **Status:** decisions agreed with the operator in the deep-analysis interview (2026-11-03);
  waiting for approval. No code changed yet.

## Goal

The voice conversation (`docs/specs/2026-11-02-voice-conversation.md`) lets the operator talk to a
session's agent. The operator now wants to **dictate a task description** in every popup that
creates a task: speak, see the words appear, edit, submit.

## Context

- **What exists.** The operator's OpenAI key (Settings → Застосунок → «Голос», SQLite
  `voice_keys`, `OPENAI_API_KEY` overrides; `apps/api/src/voice/voice.service.ts:36-48,83-87`), the
  SDP exchange pattern (`POST /api/voice/session`, `voice.service.ts:58-81`), the renderer's
  WebRTC plumbing (`apps/ui/src/lib/voice-connection.ts`: microphone with echo cancellation, data
  channel `oai-events`, a mic level meter), and the macOS microphone permission (plist key, IPC
  `kermanych:mic-access`, the main window's permission handler).
- **GPT-Live is the wrong model for dictation**: it talks back and costs $0.05/min.
- **OpenAI transcription** ([realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription)):
  - `gpt-live-transcribe` ([model](https://developers.openai.com/api/docs/models/gpt-live-transcribe)),
    $0.017/min: streams `conversation.item.input_audio_transcription.delta` as speech arrives and a
    `…completed` final transcript per committed turn. It supports no server VAD
    (`turn_detection: null`): the client sends `input_audio_buffer.commit` at the end of each
    turn. Hints: `prompt`, `keywords`, `languages` (ISO 639-1), `delay`
    (`minimal`…`xhigh`). Final text may differ from the concatenated deltas.
  - A browser connects over WebRTC through the application server's `POST /v1/realtime/calls`
    (multipart `sdp` + `session`, answers the SDP as text) — the "unified interface" of the
    [WebRTC guide](https://developers.openai.com/api/docs/guides/voice-webrtc?api=realtime).
    The guide shows it for conversation sessions; a `type: "transcription"` session over it is
    **not shown in the docs** and is checked live in step 1.
  - `gpt-transcribe` ([model](https://developers.openai.com/api/docs/models/gpt-transcribe)),
    $0.0045/min, file transcription via `/v1/audio/transcriptions` — the fallback.
- **The seven popups with a task description:**

  | # | Popup | Field |
  |---|---|---|
  | 1 | «Нова задача» launcher on «Агенти», incl. «Глибокий аналіз» mode | raw `<textarea>` `draftTask`, `AgentsPage.vue:837` |
  | 2 | Card editor on «Задачі» (create + edit) | `KField` `draftDescription`, `BoardPage.vue:208` |
  | 3 | «Новий дизайн» | `KField` `newDescription`, `DesignPage.vue:219` |
  | 4 | Task from a document | `KField` `description`, `docs/DocTaskDialog.vue:30` |
  | 5 | Finding → task | `KField` `description`, `agents/SessionFindings.vue:121` |
  | 6 | Jira issue editor (create / edit / subtask) | `KField` `description`, `jira/JiraIssueEditor.vue:8` |
  | 7 | Linear issue editor (create / edit / subtask) | `KField` `description`, `linear/LinearIssueEditor.vue:5` |

- `KField` already exposes its element (`defineExpose({ focus, el })`, `KField.vue:50`), and
  `useFileMention.ts:31-76` already inserts text at the caret — the pattern dictation follows.
- Kit components take state as props and never talk to stores (the `KVoiceBar` rule).

## Decisions

1. **Streaming transcription with `gpt-live-transcribe` over WebRTC.** Text appears while the
   operator speaks, so recognition errors are fixed while the thought is fresh; cost is
   negligible for task descriptions. Gated by a **live Ukrainian checkpoint** with the operator's
   key (step 1). Fallback if it fails: record with `MediaRecorder`, then `gpt-transcribe` file
   transcription — the same UI, a different text source; the document is updated if taken.
   Rejected: record-then-transcribe as the primary (no text until stop); macOS system dictation
   (not a Kermanych feature, weaker Ukrainian and technical terms, no context hints).
2. **The same OpenAI key as the voice conversation**, no new setting. The api keeps it; the
   window never sees it.
3. **Where: the description field of all seven popups, in create and edit mode alike.** One shared
   button + composable; each popup only wires it. The title / name fields get no 🎤 (the
   launcher generates the name; a short title is faster typed). Rejected: create-only (more code,
   no benefit); Kermanych tasks only (Jira / Linear editors create tasks too).
4. **A draft caption under the field; final text goes into the field at the caret.** While the
   operator speaks, a line under the field shows the current phrase's draft (deltas). When a
   phrase is final (`…completed`), its text is inserted where the caret is, joined to the
   neighbouring text with a space (or nothing after a newline / at the start); the caret moves
   after it. The field stays editable throughout. **⌥D** toggles dictation while the focus is in
   the description field; the button's tip names it. Rejected: drafts written into the field
   (the field locks, corrected text jumps); append to the end on stop (ignores the caret, loses
   everything on close).
5. **Dictation mutes a running voice conversation.** While dictation runs, the conversation's
   microphone is muted exactly as 🔇 does (track off + `session.input_audio.mute`); when dictation
   stops, the previous state returns — a conversation the operator had muted stays muted.
   Rejected: disabling dictation during a conversation (forces ending it); doing nothing (GPT-Live
   would delegate the task description to the agent as a message).
6. **When dictation stops:**
   1. 🎤 or ⌥D again → `input_audio_buffer.commit`, wait for the final text up to **5 s**,
      insert it, close the connection.
   2. Submitting the popup (button or ⌘Enter) while dictating → stop as in 6.1 first, then submit,
      so the description holds every word; the submit button shows its loading state meanwhile.
   3. Closing the popup (Esc, ✕, backdrop) → stop without waiting; an unfinished phrase is lost,
      the popup closes at once — like any unsaved text in a popup today.
   4. **60 s of silence** → stop as in 6.1 with the notice «Диктування зупинено: тиша» (the
      billing guard). Rejected: 30 s (people pause to think while describing a task); 120 s.
   5. A dropped connection or an OpenAI error → stop with a notice; what was inserted stays. No
      reconnect.
   6. No key → the button stays visible; a click shows «Додай OpenAI-ключ у Налаштуваннях →
      Голос» with a link to the pane (the api's `voice_key_missing`).

   **One dictation per app:** starting it in another field stops the current one as in 6.1.
7. **The transcript is inserted as is.** `gpt-live-transcribe` punctuates; no LLM clean-up.
   Rejected: automatic clean-up (another paid call and failure point; a model may change the
   meaning of an instruction to an agent); a «Причесати» button (a feature of its own, useful
   for typed text too — out of scope).
8. **Fixed recognition hints, no setting:** `languages` = the conversation language's ISO code
   (from «Мова спілкування агента», falling back to the UI locale, like `voiceLanguage`) plus
   `en` (technical terms are spoken in English); `prompt` = «a software task description for a
   developer; file, library and command names are in English»; `delay: "medium"`.

## Design

### Core (`packages/core/src/dictation.ts`, pure)

- `DICTATION_MODEL = "gpt-live-transcribe"`, `DICTATION_PROMPT`.
- `dictationLanguages(agentLanguage, uiLocale)` → `["uk", "en"]` / `["en"]` (decision 8).
- `dictationSession(languages)` → the `session` object: `{ type: "transcription", audio: { input:
  { transcription: { model, prompt, languages, delay: "medium" }, turn_detection: null } } }`.
- `vadStep(state, level, now)` → `{ state, commit: boolean, idle: boolean }`: speech is a mic level
  above a threshold; a commit after ≥ 800 ms below it following speech; `idle` after 60 s with no
  speech (decision 6.4).
- `insertDictated(value, selStart, selEnd, text)` → `{ value, caret }` with the join rules of
  decision 4 (replaces a selection, like typing would).
- `DictationSegments`: committed item ids in commit order; a completion is released only when
  every earlier item has completed or failed (completions may arrive out of order).

### API (`apps/api`)

- `VoiceService.createDictation(userId, { sdp, languages })` → multipart `POST
  /v1/realtime/calls` (`sdp`, `session` = `dictationSession(...)`) with the same key rule →
  `{ sdp }` (the answer body). Same offer size check, same coded errors; `refusal()` takes the
  model so `voice_no_access` names `gpt-live-transcribe` instead of GPT-Live. `languages` is
  checked against the codes `dictationLanguages` can produce.
- `POST /api/voice/dictation {sdp, languages}` on `VoiceController`.
- «Перевірити» keeps checking `gpt-live-1` only; a key without transcription access is reported
  at the first dictation (`voice_no_access`).

### UI (`apps/ui`)

- `lib/voice-connection.ts`: `connectVoice` reused unchanged (a transcription session sends no
  audio track; the idle audio element is harmless).
- `stores/dictation.ts`: the one dictation — connection, owner token, phase (`connecting` /
  `live` / `stopping`), draft caption, mic level, the VAD tick, the segment order. `start(owner,
  insert)`, `stop()` (decision 6.1, resolves when flushed or after 5 s), `cancel()` (6.3).
  Starting while another owner holds it → `stop()` that one first.
- `stores/voice.ts`: `holdMic()` / `releaseMic()` for decision 5 (remembers whether the operator
  had muted).
- `composables/useDictation.ts(el, model)`: what a popup wires — `state`, `caption`, `level`,
  `toggle()`, `beforeSubmit()` (awaits `stop()`), `cancel()` on close/unmount, `onKeydown` (⌥D),
  insertion at the caret via `insertDictated`.
- Kit: `KDictateButton` (🎤 / ■ with the mic level, `connecting` spinner, the ⌥D tip; emits
  `toggle`) and `KDictationCaption` (the draft line). `KField` gets a `label-aside` slot so the
  button sits on the label row. Gallery samples for both.
- The seven popups: button, caption, ⌥D, `beforeSubmit()` in each submit path, `cancel()` on
  close.
- i18n `uk` / `en`: button tips, states, notices (silence stop, drop, no key, mic denied — the
  existing `voice.micDenied` / `voice.micMissing` words are reused).

### Electron

Nothing new: the microphone permission of the voice conversation covers dictation.

## Steps

1. **Ukrainian checkpoint.** `POST /api/voice/dictation` + the store connecting WebRTC, the
   caption only (no insertion yet), with the operator's key in the preview's «Голос» pane. Settles
   the undocumented parts: a transcription session over `/v1/realtime/calls`, `commit` over the
   data channel, deltas before commit. Failure → fallback of decision 1, this document updated.
2. Core `dictation.ts` with tests.
3. API endpoint with tests.
4. UI: store, composable, kit components, `holdMic`, the seven popups, i18n.
5. README; live end-to-end run with the operator.

## Verification

- `pnpm --filter @kermanych/core test`: `vadStep` (commit after a pause, none without speech, idle
  at 60 s), `insertDictated` (empty field, middle of text, after a newline, over a selection),
  segment ordering with out-of-order and failed completions, `dictationLanguages`.
- `pnpm --filter @kermanych/api test`: the multipart request carries the session config and the
  key; key missing; 401 / 403 / 429 / network mapped; oversized offer and unknown language
  refused.
- `pnpm --filter @kermanych/ui test` (`--maxWorkers=4`): the dictation store against a scripted
  connection — deltas → caption, completions → `insert` in commit order, `stop()` flushes and
  gives up at 5 s, `cancel()` drops, a second owner stops the first, a running conversation is
  muted and restored (incl. one already muted); i18n completeness.
- Live with the operator's key in the preview: step 1; then each of the seven popups — dictate,
  edit mid-dictation, ⌥D, submit while speaking (the last phrase lands), close while speaking,
  silence stop, dictation during a voice conversation (the agent gets nothing).

## Risks

- A transcription session over WebRTC `/v1/realtime/calls` and Ukrainian quality of
  `gpt-live-transcribe` are not confirmed by the docs — step 1 gates both.
- Client-side VAD on the mic level can cut a phrase on a long pause; a cut only splits the text
  into two segments, nothing is lost.
- Cost: $0.017/min on the operator's key; the 60 s silence stop is the guard.

## Out of scope

Dictation into the chat composer (`KComposer`) and other fields; LLM clean-up / «Причесати»;
custom keywords per project; a transcription-specific «Перевірити».

## Documentation impact

`kermanych/README.md`: a «Voice dictation («Диктування»)» subsection after «Voice conversation»:
where 🎤 is (the seven popups), ⌥D, the draft caption and caret insertion, the stop rules, the
shared key, muting a running conversation, cost.
