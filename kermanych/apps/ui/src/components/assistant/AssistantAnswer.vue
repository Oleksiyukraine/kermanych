<template>
  <!-- One assistant answer of ЦУК or the Менеджмент assistant, as it streams and once it is done
       (docs/specs/2026-11-15-faster-assistant-answers.md, decisions 5 and 7–8): the prose, a
       muted «готую дію…» while an action block is being written under it, and the mark of an
       answer that was cut off or stopped. -->
  <KChatMessage role="assistant">
    <div v-if="entry.text" class="k-log__markdown" v-html="renderMarkdown(entry.text)"></div>
    <p v-if="entry.acting" class="aans__note mono" aria-live="polite">{{ t('management.assistant.preparingAction') }}</p>
    <p v-if="entry.cut" class="aans__note aans__note--cut mono">
      {{ entry.cut === 'stopped' ? t('management.assistant.cutStopped') : t('management.assistant.cutBroken') }}
    </p>
  </KChatMessage>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import KChatMessage from 'components/kit/KChatMessage.vue';
import { renderMarkdown } from '../../lib/markdown';
import type { AssistantTurnEntry } from '../../lib/streamed-answer';

defineProps<{ entry: AssistantTurnEntry }>();

const { t } = useI18n();
</script>

<style scoped lang="scss">
.aans__note {
  margin: var(--k-sp-1) 0 0;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.aans__note--cut {
  color: var(--k-warning);
}
</style>
