<template>
  <div class="k-vb" role="region" :aria-label="t('kit.voiceBar.label')">
    <span class="k-vb__state mono" :class="`k-vb__state--${stateKey}`" aria-live="polite">
      <KSpinner v-if="phase === 'connecting' || phase === 'ending'" :size="10" />
      <span v-else class="k-vb__dot" aria-hidden="true"></span>
      {{ t(`kit.voiceBar.state.${stateKey}`) }}
    </span>
    <!-- The microphone's loudness: a bar that fills with the operator's voice, empty while muted.
         With a noise gate the mark is its threshold, and the fill dims while GPT-Live does not
         hear the microphone (docs/specs/2026-11-04-voice-background-noise.md, decision 4). -->
    <span class="k-vb__level" :title="gate > 0 ? t('kit.voiceBar.gate') : undefined" aria-hidden="true">
      <span
        class="k-vb__level-fill"
        :class="{ 'k-vb__level-fill--gated': gate > 0 && !gateOpen }"
        :style="{ transform: `scaleX(${muted ? 0 : micLevel})` }"
      ></span>
      <span v-if="gate > 0" class="k-vb__gate" :style="{ left: `${Math.min(gate, 1) * 100}%` }"></span>
    </span>
    <!-- The phrase being said right now, by the operator or by the voice. Not stored anywhere:
         the session's transcript keeps what reached the agent and what it answered. -->
    <span class="k-vb__caption" :class="caption ? `k-vb__caption--${caption.who}` : ''">
      <template v-if="caption">
        <span class="k-vb__who mono">{{ t(`kit.voiceBar.who.${caption.who}`) }}</span>
        {{ caption.text }}
      </template>
    </span>
    <span class="k-vb__time mono">{{ clock }}</span>
    <KIconButton
      :active="muted"
      :disabled="phase !== 'live'"
      :title="muted ? t('kit.voiceBar.unmute') : t('kit.voiceBar.mute')"
      @click="emit('mute')"
    >
      <KIcon class="k-vb__icon" :name="muted ? 'micOff' : 'mic'" />
    </KIconButton>
    <KBtn variant="ghost" :loading="phase === 'ending'" @click="emit('end')">{{ t('kit.voiceBar.end') }}</KBtn>
  </div>
</template>

<script setup lang="ts">
// The voice conversation's bar above the composer (docs/specs/2026-11-02-voice-conversation.md,
// decision 9): what the conversation is doing, the microphone level, the live caption, the time,
// 🔇 and «Завершити». Pure presentation — the host passes the voice store's state in.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import KBtn from './KBtn.vue';
import KIcon from './KIcon.vue';
import KIconButton from './KIconButton.vue';
import KSpinner from './KSpinner.vue';

const props = defineProps<{
  phase: 'connecting' | 'live' | 'ending';
  activity: 'listening' | 'hearing' | 'speaking' | 'agent';
  caption: { who: 'operator' | 'voice'; text: string } | null;
  micLevel: number;
  /** The noise gate's threshold on `micLevel`'s scale (0 = no gate) and whether it is open now. */
  gate: number;
  gateOpen: boolean;
  muted: boolean;
  elapsedMs: number;
}>();

const emit = defineEmits<{ mute: []; end: [] }>();

const { t } = useI18n();

const stateKey = computed(() =>
  props.phase === 'live' ? (props.muted && props.activity === 'listening' ? 'muted' : props.activity) : props.phase,
);

const clock = computed(() => {
  const s = Math.floor(props.elapsedMs / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
});
</script>

<style scoped lang="scss">
.k-vb {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-top: 1px solid var(--k-line);
  background: var(--k-surface2);
  font-size: 12px;
  min-width: 0;
}
.k-vb__state {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--k-muted);
  white-space: nowrap;
}
.k-vb__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.k-vb__state--hearing,
.k-vb__state--speaking { color: var(--k-accent); }
.k-vb__state--hearing .k-vb__dot,
.k-vb__state--speaking .k-vb__dot { animation: k-vb-pulse 1s ease-in-out infinite; }
.k-vb__level {
  position: relative;
  flex: none;
  width: 48px;
  height: 4px;
  border-radius: 2px;
  background: var(--k-line);
  overflow: hidden;
}
.k-vb__level-fill {
  display: block;
  height: 100%;
  background: var(--k-accent);
  transform-origin: left center;
  transition: transform 120ms linear;
}
.k-vb__level-fill--gated { background: var(--k-muted); }
.k-vb__gate {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--k-text);
}
.k-vb__caption {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--k-text);
}
.k-vb__caption--voice { color: var(--k-muted); }
.k-vb__who {
  font-size: 10px;
  color: var(--k-muted);
  margin-right: 4px;
}
.k-vb__time {
  flex: none;
  font-size: 11px;
  color: var(--k-muted);
}
.k-vb__icon { --k-icon-size: var(--k-icon-sm); }
@keyframes k-vb-pulse {
  50% { opacity: 0.35; }
}
@media (prefers-reduced-motion: reduce) {
  .k-vb__state--hearing .k-vb__dot,
  .k-vb__state--speaking .k-vb__dot { animation: none; }
  .k-vb__level-fill { transition: none; }
}
</style>
