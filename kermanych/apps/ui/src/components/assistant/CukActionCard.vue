<template>
  <!-- One ЦУК action that waits for the operator (docs/specs/2026-11-04-cuk-control-console.md,
       decision 4): what will happen, the text editable before it does, «Виконати» / «Скасувати».
       After either, the card stays in the transcript as the record of the decision. -->
  <article class="cukcard" :class="`cukcard--${state}`" :aria-label="kindLabel">
    <header class="cukcard__head">
      <span class="cukcard__kind mono">{{ kindLabel }}</span>
      <span v-if="state !== 'pending'" class="cukcard__state mono">{{ t(`cuk.card.state.${state}`) }}</span>
    </header>

    <dl class="cukcard__facts">
      <template v-if="'project' in action">
        <dt>{{ t('cuk.card.project') }}</dt>
        <dd>{{ action.project }}</dd>
      </template>
      <template v-if="'session' in action">
        <dt>{{ t('cuk.card.session') }}</dt>
        <dd>{{ sessionName }}</dd>
      </template>
    </dl>

    <template v-if="action.kind === 'task.create' || action.kind === 'agent.start'">
      <label class="cukcard__field">
        <span class="cukcard__label mono">{{ t('cuk.card.title') }}</span>
        <input
          v-model="title"
          class="cukcard__input"
          type="text"
          :maxlength="CUK_TITLE_MAX"
          :placeholder="titlePlaceholder"
          :disabled="state !== 'pending'"
        />
      </label>
      <label class="cukcard__field">
        <span class="cukcard__label mono">{{ t('cuk.card.task') }}</span>
        <textarea v-model="text" class="cukcard__input cukcard__input--area" rows="4" :disabled="state !== 'pending'"></textarea>
      </label>
      <KCheckbox v-model="deep" :label="t('cuk.card.deep')" :disabled="state !== 'pending'" />
    </template>
    <label v-else-if="action.kind === 'session.message'" class="cukcard__field">
      <span class="cukcard__label mono">{{ t('cuk.card.message') }}</span>
      <textarea v-model="text" class="cukcard__input cukcard__input--area" rows="3" :disabled="state !== 'pending'"></textarea>
    </label>

    <footer v-if="state === 'pending' || state === 'running'" class="cukcard__foot">
      <KBtn variant="ghost" :disabled="state === 'running'" @click="emit('cancel')">{{ t('cuk.card.cancel') }}</KBtn>
      <KBtn variant="primary" :loading="state === 'running'" :disabled="!canRun" @click="run">{{ t('cuk.card.run') }}</KBtn>
    </footer>
  </article>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { CUK_TITLE_MAX, taskNameFromText, type CukAction } from '@kermanych/core';
import KBtn from 'components/kit/KBtn.vue';
import KCheckbox from 'components/kit/KCheckbox.vue';
import { useOrchestrator } from 'stores/orchestrator';
import type { CukCardState } from 'stores/cuk-chat';
import { findSessionByRef } from '../../lib/cuk-digest';

const props = defineProps<{ action: CukAction; state: CukCardState }>();
const emit = defineEmits<{ confirm: [action: CukAction]; cancel: [] }>();

const { t } = useI18n();
const store = useOrchestrator();

// The card's working copy: the operator edits these, «Виконати» hands the result back.
const text = ref(
  props.action.kind === 'session.message'
    ? props.action.text
    : props.action.kind === 'task.create' || props.action.kind === 'agent.start'
      ? props.action.task
      : '',
);
const title = ref(props.action.kind === 'task.create' || props.action.kind === 'agent.start' ? (props.action.title ?? '') : '');
const deep = ref(props.action.kind === 'task.create' || props.action.kind === 'agent.start' ? !!props.action.deepAnalysis : false);

// Message keys cannot hold a dot (vue-i18n reads it as a path), so `session.stop` → `session_stop`.
const kindLabel = computed(() => t(`cuk.card.kind.${props.action.kind.replace('.', '_')}`));
// The launcher's own rule for a name nobody typed — so the placeholder is the title it will get.
const titlePlaceholder = computed(() => taskNameFromText(text.value));

const sessionName = computed(() => {
  if (!('session' in props.action)) return '';
  return findSessionByRef(store.sessions, props.action.session)?.name ?? props.action.session;
});

const needsText = computed(() => ['task.create', 'agent.start', 'session.message'].includes(props.action.kind));
const canRun = computed(() => props.state === 'pending' && (!needsText.value || text.value.trim() !== ''));

function run(): void {
  const a = props.action;
  if (a.kind === 'task.create' || a.kind === 'agent.start') {
    const name = title.value.trim();
    emit('confirm', {
      kind: a.kind,
      project: a.project,
      task: text.value.trim(),
      ...(name ? { title: name } : {}),
      ...(deep.value ? { deepAnalysis: true } : {}),
    });
    return;
  }
  if (a.kind === 'session.message') {
    emit('confirm', { ...a, text: text.value.trim() });
    return;
  }
  emit('confirm', a);
}
</script>

<style scoped lang="scss">
// A card, not a line: it is the one thing in the transcript that waits for a decision, so it is
// boxed and carries the accent edge until the decision is made.
.cukcard {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-3);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-left: 2px solid var(--k-accent);
  border-radius: var(--k-r);
  background: color-mix(in srgb, var(--k-surface2) 45%, transparent);
}

.cukcard--done,
.cukcard--cancelled {
  border-left-color: var(--k-line-strong);
  opacity: 0.8;
}

.cukcard__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-2);
}

.cukcard__kind {
  font-size: var(--k-fs-xs);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--k-text);
}

.cukcard__state {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.cukcard__facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px var(--k-sp-3);
  margin: 0;
  font-size: var(--k-fs-sm);

  dt {
    color: var(--k-muted);
  }

  dd {
    margin: 0;
    color: var(--k-text);
    overflow-wrap: anywhere;
  }
}

.cukcard__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cukcard__label {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.cukcard__input {
  width: 100%;
  padding: 6px var(--k-sp-2);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-sm);
  background: var(--k-surface);
  color: var(--k-text);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1.5;

  &:focus {
    outline: none;
    border-color: var(--k-accent);
  }

  &:disabled {
    color: var(--k-muted);
  }

  &::placeholder {
    color: var(--k-faint);
  }
}

.cukcard__input--area {
  resize: vertical;
}

.cukcard__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--k-sp-2);
}
</style>
