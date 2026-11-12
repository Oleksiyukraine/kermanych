<template>
  <!-- The whole answer of an agent run without a project (docs/specs/2026-11-06-scheduled-tasks.md,
       decision 9), over the console: the run has no session to open, so its text is shown here,
       and «Обговорити в ЦУК» carries it into the ЦУК composer — the follow-up goes through ЦУК. -->
  <section class="ssv" :aria-labelledby="headingId">
    <header class="ssv__head">
      <button
        ref="backEl"
        class="ssv__back mono"
        type="button"
        :aria-label="t('cuk.notifications.entry.close')"
        v-tip="t('cuk.notifications.entry.close')"
        @click="emit('close')"
      >←</button>
      <h2 :id="headingId" class="ssv__title mono">{{ slip?.scheduleName ?? '' }}</h2>
      <span v-if="slip?.late" class="ssv__state mono">{{ t('cuk.notifications.slip.late') }}</span>
    </header>

    <div class="ssv__body">
      <p v-if="!slip" class="ssv__note" role="note">{{ t('cuk.notifications.gone') }}</p>
      <template v-else>
        <p class="ssv__meta mono">{{ renderTime(t, relativeTime(slip.at, now)) }}</p>
        <div class="k-log__markdown ssv__text" v-html="renderMarkdown(slip.body ?? slip.text)"></div>
      </template>
    </div>

    <footer v-if="slip" class="ssv__controls">
      <KBtn variant="primary" @click="discuss">{{ t('cuk.notifications.slip.discuss') }}</KBtn>
    </footer>
  </section>
</template>

<script setup lang="ts">
// Rendered by AssistantLauncher over the console while `notification-center.openSlipId` is set.
import { computed, nextTick, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { useNotificationCenter } from 'stores/notification-center';
import { useSchedules } from 'stores/schedules';
import { useCukChat } from 'stores/cuk-chat';
import { useNow } from '../../composables/useNow';
import { relativeTime, renderTime } from '../../lib/time';
import { renderMarkdown } from '../../lib/markdown';
import KBtn from 'components/kit/KBtn.vue';

const props = defineProps<{ id: string }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const nc = useNotificationCenter();
const schedules = useSchedules();
const chat = useCukChat();
const now = useNow(60_000);
const headingId = useId();
const backEl = ref<HTMLButtonElement | null>(null);

const slip = computed(() => schedules.slips?.find((s) => s.id === props.id));

onMounted(() => void nextTick(() => backEl.value?.focus()));

// The answer, headed by the task's name, lands in the draft; the operator writes the question.
function discuss(): void {
  const s = slip.value;
  if (!s) return;
  nc.close();
  chat.discuss(t('cuk.notifications.slip.discussDraft', { name: s.scheduleName, body: s.body ?? s.text }));
}
</script>

<style scoped lang="scss">
// The improvement view's frame (SkillImprovementView .siv): opaque, over the console.
.ssv {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  background: var(--k-surface);
  box-shadow: var(--k-shadow-pop);
  overflow: hidden;
}

.ssv__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-3);
  border-bottom: var(--k-rule-thin) solid var(--k-line);
}

.ssv__back {
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-pill);
  background: transparent;
  color: var(--k-text);
  cursor: pointer;

  &:hover,
  &:focus-visible {
    border-color: var(--k-accent);
  }
}

.ssv__title {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-semibold);
}

.ssv__state {
  flex: none;
  margin-left: auto;
  padding: 0 6px;
  border: var(--k-rule-thin) solid var(--k-warning);
  border-radius: var(--k-r-pill);
  font-size: var(--k-fs-xs);
}

.ssv__body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-3);
  overflow: auto;
}

.ssv__meta {
  margin: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.ssv__note {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.ssv__text {
  font-size: var(--k-fs-sm);
  line-height: 1.5;
}

.ssv__controls {
  flex: none;
  display: flex;
  justify-content: flex-end;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-3);
  border-top: var(--k-rule-thin) solid var(--k-line);
}
</style>
