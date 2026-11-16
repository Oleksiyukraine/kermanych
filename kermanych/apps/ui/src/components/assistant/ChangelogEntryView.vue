<template>
  <!-- One version of this build's changelog (docs/specs/2026-11-16-changelog-tab.md), opened
       from the «Оновлення» tab over the console, the way an improvement or a slip is opened. -->
  <section class="cev" :aria-labelledby="headingId">
    <header class="cev__head">
      <button
        ref="backEl"
        class="cev__back mono"
        type="button"
        :aria-label="t('cuk.notifications.entry.close')"
        v-tip="t('cuk.notifications.entry.close')"
        @click="emit('close')"
      >←</button>
      <h2 :id="headingId" class="cev__title mono">{{ t('cuk.notifications.changelog.title', { version }) }}</h2>
      <span v-if="version === APP_VERSION" class="cev__state mono">{{ t('cuk.notifications.changelog.current') }}</span>
    </header>

    <div class="cev__body">
      <p v-if="!entry" class="cev__note" role="note">{{ t('cuk.notifications.gone') }}</p>
      <template v-else>
        <p v-if="entry.date" class="cev__meta mono">{{ entry.date }}</p>
        <!-- html:false (lib/markdown.ts), so the notes render as a controlled tag set. -->
        <div v-if="entry.body" class="cev__notes" v-html="renderReleaseNotes(entry.body)"></div>
        <p v-else class="cev__note">{{ t('appUpdate.noNotes') }}</p>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
// Rendered by AssistantLauncher over the console while `notification-center.openVersion` is set.
import { computed, nextTick, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { APP_VERSION, useAppUpdate } from 'stores/app-update';
import { renderReleaseNotes } from '../../lib/markdown';

const props = defineProps<{ version: string }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const appUpdate = useAppUpdate();
const headingId = useId();
const backEl = ref<HTMLButtonElement | null>(null);

const entry = computed(() => appUpdate.changelog.find((e) => e.version === props.version));

onMounted(() => void nextTick(() => backEl.value?.focus()));
</script>

<style scoped lang="scss">
// The improvement view's frame (SkillImprovementView .siv): opaque, over the console.
.cev {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  background: var(--k-surface);
  box-shadow: var(--k-shadow-pop);
  overflow: hidden;
}

.cev__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-3);
  border-bottom: var(--k-rule-thin) solid var(--k-line);
}

.cev__back {
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

.cev__title {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-semibold);
}

.cev__state {
  flex: none;
  padding: 0 6px;
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-pill);
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.cev__body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-3);
  overflow: auto;
}

.cev__meta {
  margin: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.cev__note {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.cev__notes {
  font-size: var(--k-fs-sm);
  line-height: 1.55;
  overflow-wrap: anywhere;

  :deep(h3) {
    margin: var(--k-sp-3) 0 var(--k-sp-1);
    font-size: var(--k-fs-xs);
    // Quasar's global h3 carries a display line-height.
    line-height: 1.4;
    font-weight: var(--k-fw-semibold);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--k-muted);
  }

  :deep(h3:first-child) {
    margin-top: 0;
  }

  :deep(ul) {
    margin: 0;
    padding-left: 18px;
  }

  :deep(li + li) {
    margin-top: var(--k-sp-1);
  }

  :deep(p) {
    margin: 0 0 var(--k-sp-1);
  }

  :deep(code) {
    font-size: 0.92em;
  }
}
</style>
