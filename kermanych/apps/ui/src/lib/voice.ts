// apps/ui/src/lib/voice.ts
// The voice conversation's device-local preference (docs/specs/2026-11-02-voice-conversation.md):
// which GPT-Live voice speaks. Like the theme, a choice for the screen in front of the operator —
// localStorage, never the cloud. The OpenAI key is not here: it lives in the api (Settings →
// «Голос» writes it through PUT /voice/key).
import type { Ref } from 'vue';
import { DEFAULT_VOICE, isVoiceId, type VoiceId } from '@kermanych/core';
import { persisted } from './persisted';

export const voicePick: Ref<VoiceId> = persisted('kermanych.voice.voice', DEFAULT_VOICE, (raw) => (isVoiceId(raw) ? raw : null), (v) => v);

/** What the voice bar (KVoiceBar) shows; KPanel gets it only for the session the conversation is bound to. */
export type VoiceBarState = {
  phase: 'connecting' | 'live' | 'ending';
  /** «слухаю» / «чую тебе» / «говорю» / «агент працює». */
  activity: 'listening' | 'hearing' | 'speaking' | 'agent';
  caption: { who: 'operator' | 'voice'; text: string } | null;
  micLevel: number;
  muted: boolean;
  elapsedMs: number;
};
