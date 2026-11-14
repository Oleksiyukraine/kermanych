<template>
  <!-- Persistent while the write runs: closing mid-write would hide its refusal. -->
  <KModal
    :model-value="modelValue"
    :title="server ? t('aiTeam.mcp.editor.editTitle', { name: server.name }) : t('aiTeam.mcp.editor.newTitle')"
    :persistent="save.busy.value"
    width="600px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <!-- The name is the key in two files; renaming is a delete and an add, so it is fixed once
         the server exists. -->
    <KField v-model="draft.name" :label="t('aiTeam.mcp.editor.name')" :disabled="!!server" placeholder="linear" />

    <div class="mcpe__kind">
      <span class="mcpe__label">{{ t('aiTeam.mcp.editor.kind') }}</span>
      <div class="mcpe__kinds" role="radiogroup" :aria-label="t('aiTeam.mcp.editor.kind')">
        <KBtn
          v-for="o in kindOptions"
          :key="o.value"
          :variant="draft.kind === o.value ? 'primary' : 'secondary'"
          role="radio"
          :aria-checked="draft.kind === o.value"
          @click="setKind(o.value)"
        >{{ o.label }}</KBtn>
      </div>
    </div>

    <template v-if="draft.kind === 'stdio'">
      <KField v-model="draft.command" :label="t('aiTeam.mcp.editor.command')" placeholder="npx" />
      <KField v-model="draft.args" :label="t('aiTeam.mcp.editor.args')" multiline :rows="3" placeholder="-y&#10;@playwright/mcp@latest" />
    </template>
    <KField v-else v-model="draft.url" :label="t('aiTeam.mcp.editor.url')" placeholder="https://mcp.example.com/mcp" />

    <div class="mcpe__pairs">
      <span class="mcpe__label">{{ draft.kind === 'stdio' ? t('aiTeam.mcp.editor.env') : t('aiTeam.mcp.editor.headers') }}</span>
      <div v-for="(p, i) in draft.pairs" :key="i" class="mcpe__pair">
        <input
          v-model="p.key"
          class="mcpe__cell mono"
          :placeholder="draft.kind === 'stdio' ? 'API_KEY' : 'Authorization'"
          :aria-label="t('aiTeam.mcp.editor.key')"
        />
        <input
          v-model="p.value"
          class="mcpe__cell mono"
          :type="p.secret ? 'password' : 'text'"
          :placeholder="p.stored ? t('aiTeam.mcp.editor.keepSecret') : t('aiTeam.mcp.editor.value')"
          :aria-label="t('aiTeam.mcp.editor.value')"
        />
        <KCheckbox v-model="p.secret" :label="t('aiTeam.mcp.editor.secret')" />
        <KIconButton :title="t('aiTeam.mcp.editor.removePair')" @click="draft.pairs.splice(i, 1)">✕</KIconButton>
        <label v-if="p.secret" class="mcpe__var mono">
          <span>→ .env</span>
          <input v-model="p.varName" class="mcpe__cell mono" :placeholder="mcpPairVarName(draft, p)" :aria-label="t('aiTeam.mcp.editor.varName')" />
        </label>
      </div>
      <KBtn variant="ghost" @click="draft.pairs.push(emptyMcpPair())">
        {{ draft.kind === 'stdio' ? t('aiTeam.mcp.editor.addEnv') : t('aiTeam.mcp.editor.addHeader') }}
      </KBtn>
      <p class="mcpe__hint">{{ t('aiTeam.mcp.editor.secretHint') }}</p>
      <p v-if="hasSecret && !envIgnored" class="mcpe__warn" role="alert">{{ t('aiTeam.mcp.editor.envNotIgnored') }}</p>
    </div>

    <p v-if="codexNote" class="mcpe__hint">{{ codexNote }}</p>

    <!-- A save that stopped at a codex table someone wrote by hand: both versions, and the
         primary button turns into the explicit replace. -->
    <McpCodexConflict v-if="conflict" :conflict="conflict" :name="draft.name.trim()" />

    <p v-if="formError" class="mcpe__error mono">{{ formError }}</p>

    <template #controls>
      <KBtn :disabled="save.busy.value" @click="emit('update:modelValue', false)">{{ t('settings.modal.cancel') }}</KBtn>
      <KBtn variant="primary" :loading="save.busy.value" @click="save.run()">
        {{ conflict ? t('aiTeam.mcp.replaceCodex') : t('aiTeam.mcp.editor.save') }}
      </KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// Adds or changes one server of the project's `.mcp.json`; the api mirrors it into
// `.codex/config.toml` (docs/specs/2026-11-14-project-mcp-servers.md, decisions 5–6).
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { mcpToCodex, type McpCodexConflict as Conflict, type McpProjectView, type McpServerRow } from '@kermanych/core';
import { api } from '../../lib/api';
import { emptyMcpDraft, emptyMcpPair, mcpDraftFrom, mcpDraftToSave, mcpPairVarName, type McpDraft } from '../../lib/mcp';
import { errorText, useAsyncAction } from '../../composables/useAsyncAction';
import KModal from 'components/kit/KModal.vue';
import KField from 'components/kit/KField.vue';
import KBtn from 'components/kit/KBtn.vue';
import KIconButton from 'components/kit/KIconButton.vue';
import KCheckbox from 'components/kit/KCheckbox.vue';
import McpCodexConflict from './McpCodexConflict.vue';

const props = defineProps<{ modelValue: boolean; projectId: string; server?: McpServerRow | undefined; envIgnored: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [open: boolean]; saved: [view: McpProjectView] }>();
const { t } = useI18n();

const draft = ref<McpDraft>(emptyMcpDraft());
const conflict = ref<Conflict>();
const formError = ref('');

// Each open starts from the server on screen (or a blank one); a close drops the draft.
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    draft.value = props.server ? mcpDraftFrom(props.server.name, props.server.def) : emptyMcpDraft();
    conflict.value = undefined;
    formError.value = '';
  },
  { immediate: true },
);

const kindOptions = computed(() => [
  { value: 'stdio', label: t('aiTeam.mcp.kind.stdio') },
  { value: 'http', label: t('aiTeam.mcp.kind.http') },
]);
function setKind(kind: string): void {
  draft.value.kind = kind === 'http' ? 'http' : 'stdio';
}

const hasSecret = computed(() => draft.value.pairs.some((p) => p.secret && p.key.trim()));

// What codex will get, said before the save: a placeholder it cannot forward means no codex
// table at all, and the operator should know that while the form is still open.
const codexNote = computed(() => {
  const out = mcpDraftToSave(draft.value);
  if (!('body' in out)) return '';
  const mapped = mcpToCodex(out.body.def);
  return 'gap' in mapped ? t('aiTeam.mcp.codexGap.' + mapped.gap) : '';
});

// Any edit after a conflict is a new draft: the comparison on screen would no longer be the one
// the operator agrees to.
watch(draft, () => (conflict.value = undefined), { deep: true });

const save = useAsyncAction(
  async () => {
    formError.value = '';
    const out = mcpDraftToSave(draft.value);
    if (!('body' in out)) {
      formError.value = t('aiTeam.mcp.editor.problem.' + out.problem, { detail: out.detail ?? '' });
      return;
    }
    const body = { ...out.body, ...(conflict.value ? { replaceCodex: true } : {}) };
    const name = draft.value.name.trim();
    const res = props.server ? await api.mcpUpdate(props.projectId, name, body) : await api.mcpCreate(props.projectId, name, body);
    if ('conflict' in res) {
      conflict.value = res.conflict;
      return;
    }
    emit('saved', res.view);
    emit('update:modelValue', false);
  },
  { onError: (e) => (formError.value = errorText(e)) },
);
</script>

<style scoped lang="scss">
.mcpe__label {
  display: block;
  margin-bottom: var(--k-sp-1);
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.mcpe__kind {
  margin: var(--k-sp-2) 0 var(--k-sp-3);
}

.mcpe__kinds {
  display: flex;
  gap: var(--k-sp-2);
}

.mcpe__pairs {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--k-sp-2);
  margin-top: var(--k-sp-3);
}

.mcpe__pair {
  display: grid;
  grid-template-columns: minmax(110px, 1fr) minmax(140px, 1.5fr) auto 28px;
  align-items: center;
  gap: var(--k-sp-2);
  width: 100%;
}

.mcpe__var {
  grid-column: 2 / -1;
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
  white-space: nowrap;
}

.mcpe__cell {
  min-width: 0;
  width: 100%;
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: var(--k-surface);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-sm);
  padding: 5px 7px;

  &::placeholder {
    color: var(--k-faint);
  }

  &:focus {
    outline: none;
    border-color: var(--k-accent);
  }
}

.mcpe__hint {
  margin: 0;
  font-size: var(--k-fs-xs);
  line-height: 1.5;
  color: var(--k-muted);
}

.mcpe__warn {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-accent);
}

.mcpe__error {
  margin: var(--k-sp-2) 0 0;
  font-size: var(--k-fs-sm);
  color: var(--k-accent);
}
</style>
