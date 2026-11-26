<template>
  <!-- Persistent while the write runs: closing mid-write would hide its refusal. -->
  <KModal
    :model-value="modelValue"
    :title="title"
    :persistent="save.busy.value"
    :width="step === 'catalog' ? '760px' : '640px'"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <!-- A new server starts at the catalog; a pick (or «Власний сервер») fills the form below. -->
    <McpCatalog v-if="step === 'catalog'" :existing="existing" @pick="pick" />
    <div v-else class="mcpe">
      <button v-if="!server" type="button" class="mcpe__back" @click="step = 'catalog'">← {{ t('aiTeam.mcp.catalog.back') }}</button>

      <!-- What the pick needs from the operator: a key, a sign-in in the agent, or nothing. -->
      <div v-if="picked" class="mcpe__picked">
        <p class="mcpe__picked-about">{{ t('aiTeam.mcp.catalog.about.' + picked.id) }}</p>
        <p class="mcpe__picked-auth">{{ t('aiTeam.mcp.catalog.pick.' + picked.auth, { name: draft.name.trim() || picked.name }) }}</p>
        <p class="mcpe__picked-links">
          <a v-if="picked.key" :href="picked.key.url" target="_blank" rel="noopener">{{ t('aiTeam.mcp.catalog.getKey') }} ↗</a>
          <a :href="picked.docs" target="_blank" rel="noopener">{{ t('aiTeam.mcp.catalog.docs') }} ↗</a>
        </p>
      </div>

      <!-- The name is the key in two files; renaming is a delete and an add, so it is fixed once
           the server exists. -->
      <div class="mcpe__field">
        <KField v-model="draft.name" :label="t('aiTeam.mcp.editor.name')" :disabled="!!server" placeholder="linear" />
        <p class="mcpe__hint">{{ t('aiTeam.mcp.editor.nameHint') }}</p>
      </div>

      <div class="mcpe__field">
        <span class="mcpe__label">{{ t('aiTeam.mcp.editor.kind') }}</span>
        <KToggle class="mcpe__kind" :options="[kindLabel.stdio, kindLabel.http]" :model-value="kindLabel[draft.kind]" @update:model-value="setKind" />
      </div>

      <template v-if="draft.kind === 'stdio'">
        <KField v-model="draft.command" :label="t('aiTeam.mcp.editor.command')" placeholder="npx" />
        <div class="mcpe__field">
          <KField v-model="draft.args" :label="t('aiTeam.mcp.editor.args')" multiline :rows="3" placeholder="-y&#10;@playwright/mcp@0.0.86" />
          <p class="mcpe__hint">{{ t('aiTeam.mcp.editor.argsHint') }}</p>
        </div>
        <!-- The command line as a session will run it: the one-argument-per-line rule shows here. -->
        <p v-if="runLine" class="mcpe__run">
          <span class="mcpe__run-label">{{ t('aiTeam.mcp.editor.run') }}</span>
          <code class="mono">{{ runLine }}</code>
        </p>
      </template>
      <KField v-else v-model="draft.url" :label="t('aiTeam.mcp.editor.url')" placeholder="https://mcp.example.com/mcp" />

      <div class="mcpe__field">
        <span class="mcpe__label">{{ draft.kind === 'stdio' ? t('aiTeam.mcp.editor.env') : t('aiTeam.mcp.editor.headers') }}</span>
        <div v-if="draft.pairs.length" class="mcpe__pairs">
          <div class="mcpe__pair mcpe__pair--head" aria-hidden="true">
            <span>{{ keyLabel }}</span>
            <span>{{ t('aiTeam.mcp.editor.value') }}</span>
          </div>
          <div v-for="(p, i) in draft.pairs" :key="i" class="mcpe__pair-block">
            <div class="mcpe__pair">
              <input
                v-model="p.key"
                class="mcpe__cell mono"
                :placeholder="draft.kind === 'stdio' ? 'API_KEY' : 'Authorization'"
                :aria-label="keyLabel"
              />
              <input
                v-model="p.value"
                class="mcpe__cell mono"
                :type="p.secret ? 'password' : 'text'"
                :placeholder="p.stored ? t('aiTeam.mcp.editor.keepSecret') : (p.placeholder ?? t('aiTeam.mcp.editor.valuePlaceholder'))"
                :aria-label="t('aiTeam.mcp.editor.value')"
              />
              <KCheckbox v-model="p.secret" :label="t('aiTeam.mcp.editor.secret')" />
              <KIconButton :title="t('aiTeam.mcp.editor.removePair')" @click="draft.pairs.splice(i, 1)">✕</KIconButton>
            </div>
            <!-- Where a secret's value goes, in one line; the variable is renamed only on request. -->
            <p v-if="p.secret && mcpPairVarName(draft, p)" class="mcpe__target">
              <template v-if="openVars.has(p)">
                <label class="mcpe__target-edit">
                  <span>{{ t('aiTeam.mcp.editor.secretTarget') }}</span>
                  <input
                    v-model="p.varName"
                    class="mcpe__cell mcpe__cell--var mono"
                    :placeholder="autoVarName(p)"
                    :aria-label="t('aiTeam.mcp.editor.varName')"
                  />
                </label>
              </template>
              <template v-else>
                {{ t('aiTeam.mcp.editor.secretTarget') }}
                <code class="mono">{{ mcpPairVarName(draft, p) }}</code>
                <button type="button" class="mcpe__link" @click="openVar(p)">{{ t('aiTeam.mcp.editor.secretTargetChange') }}</button>
              </template>
            </p>
          </div>
        </div>
        <p v-else class="mcpe__hint">{{ draft.kind === 'stdio' ? t('aiTeam.mcp.editor.noEnv') : t('aiTeam.mcp.editor.noHeaders') }}</p>
        <div>
          <KBtn variant="secondary" class="mcpe__add" @click="draft.pairs.push(emptyMcpPair())">
            + {{ draft.kind === 'stdio' ? t('aiTeam.mcp.editor.addEnv') : t('aiTeam.mcp.editor.addHeader') }}
          </KBtn>
        </div>
        <p v-if="draft.pairs.length" class="mcpe__hint">{{ t('aiTeam.mcp.editor.secretHint') }}</p>
        <p v-if="hasSecret && !envIgnored" class="mcpe__notice mcpe__notice--warn" role="alert">{{ t('aiTeam.mcp.editor.envNotIgnored') }}</p>
      </div>

      <p v-if="codexNote" class="mcpe__notice">{{ codexNote }}</p>

      <!-- A save that stopped at a codex table someone wrote by hand: both versions, and the
           primary button turns into the explicit replace. -->
      <McpCodexConflict v-if="conflict" :conflict="conflict" :name="draft.name.trim()" />

      <p v-if="formError" class="mcpe__notice mcpe__notice--error mono" role="alert">{{ formError }}</p>
    </div>

    <template #controls>
      <KBtn :disabled="save.busy.value" @click="emit('update:modelValue', false)">{{ t('settings.modal.cancel') }}</KBtn>
      <KBtn v-if="step === 'form'" variant="primary" :loading="save.busy.value" @click="save.run()">
        {{ conflict ? t('aiTeam.mcp.replaceCodex') : t('aiTeam.mcp.editor.save') }}
      </KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// Adds or changes one server of the project's `.mcp.json`; the api mirrors it into
// `.codex/config.toml` (docs/specs/2026-11-14-project-mcp-servers.md, decisions 5–6; layout:
// docs/specs/2026-11-16-mcp-servers-ux-redesign.md, decision 8; the catalog step:
// docs/specs/2026-11-16-mcp-catalog.md).
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { mcpToCodex, type McpCodexConflict as Conflict, type McpProjectView, type McpServerRow } from '@kermanych/core';
import { api } from '../../lib/api';
import { emptyMcpDraft, emptyMcpPair, mcpDefLine, mcpDraftFrom, mcpDraftToSave, mcpPairVarName, type McpDraft, type McpPair } from '../../lib/mcp';
import { mcpCatalogDraft, type McpCatalogEntry } from '../../lib/mcp-catalog';
import { errorText, useAsyncAction } from '../../composables/useAsyncAction';
import KModal from 'components/kit/KModal.vue';
import KField from 'components/kit/KField.vue';
import KBtn from 'components/kit/KBtn.vue';
import KIconButton from 'components/kit/KIconButton.vue';
import KCheckbox from 'components/kit/KCheckbox.vue';
import KToggle from 'components/kit/KToggle.vue';
import McpCodexConflict from './McpCodexConflict.vue';
import McpCatalog from './McpCatalog.vue';

const props = defineProps<{
  modelValue: boolean;
  projectId: string;
  server?: McpServerRow | undefined;
  envIgnored: boolean;
  /** Names already in the root `.mcp.json`: the catalog marks them as added. */
  existing: string[];
}>();
const emit = defineEmits<{ 'update:modelValue': [open: boolean]; saved: [view: McpProjectView] }>();
const { t } = useI18n();

const draft = ref<McpDraft>(emptyMcpDraft());
const conflict = ref<Conflict>();
const formError = ref('');
// Secret rows whose `.env` variable name is open for editing; the rest show it as one line.
const openVars = ref(new WeakSet<McpPair>());

/** The variable a secret row gets when the operator names none. */
const autoVarName = (p: McpPair) => mcpPairVarName(draft.value, { ...p, varName: '' });

function openVar(p: McpPair): void {
  if (!p.varName.trim()) p.varName = autoVarName(p);
  openVars.value.add(p);
}

// Each open starts from the server on screen, or at the catalog for a new one; a close drops the
// draft.
const step = ref<'catalog' | 'form'>('catalog');
const picked = ref<McpCatalogEntry>();

function reset(next: McpDraft): void {
  draft.value = next;
  openVars.value = new WeakSet();
  conflict.value = undefined;
  formError.value = '';
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    picked.value = undefined;
    step.value = props.server ? 'form' : 'catalog';
    reset(props.server ? mcpDraftFrom(props.server.name, props.server.def) : emptyMcpDraft());
  },
  { immediate: true },
);

/** A catalog card fills the form from its entry; «Власний сервер» (no entry) starts blank. */
function pick(entry: McpCatalogEntry | undefined): void {
  picked.value = entry;
  reset(entry ? mcpCatalogDraft(entry) : emptyMcpDraft());
  step.value = 'form';
}

const title = computed(() => {
  if (props.server) return t('aiTeam.mcp.editor.editTitle', { name: props.server.name });
  if (picked.value && step.value === 'form') return t('aiTeam.mcp.catalog.formTitle', { title: picked.value.title });
  return t('aiTeam.mcp.editor.newTitle');
});

const kindLabel = computed(() => ({ stdio: t('aiTeam.mcp.kind.stdio'), http: t('aiTeam.mcp.kind.http') }));
function setKind(label: string): void {
  draft.value.kind = label === kindLabel.value.http ? 'http' : 'stdio';
}

const keyLabel = computed(() => (draft.value.kind === 'stdio' ? t('aiTeam.mcp.editor.envKey') : t('aiTeam.mcp.editor.headerKey')));

const runLine = computed(() => {
  const d = draft.value;
  if (d.kind !== 'stdio' || !d.command.trim()) return '';
  const args = d.args.split('\n').map((a) => a.trim()).filter(Boolean);
  return mcpDefLine({ kind: 'stdio', command: d.command.trim(), args, env: {} });
});

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
.mcpe {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-4);
}

.mcpe__back {
  align-self: flex-start;
  margin-bottom: calc(-1 * var(--k-sp-2));
  padding: 0;
  font: inherit;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
  background: none;
  border: none;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    color: var(--k-text);
  }
}

.mcpe__picked {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--k-sp-2) var(--k-sp-3);
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  background: var(--k-surface2);
  border-left: 3px solid var(--k-accent);
  border-radius: var(--k-r-sm);

  p {
    margin: 0;
  }
}

.mcpe__picked-about {
  color: var(--k-muted);
}

.mcpe__picked-auth {
  color: var(--k-text);
}

.mcpe__picked-links {
  display: flex;
  gap: var(--k-sp-3);
  font-size: var(--k-fs-xs);

  a {
    color: var(--k-muted);

    &:hover {
      color: var(--k-text);
    }
  }
}

.mcpe__field {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
}

.mcpe__kind {
  align-self: flex-start;
}

// The same as KField's label, for the fields KField does not draw.
.mcpe__label {
  font-size: 13px;
  color: var(--k-text);
}

.mcpe__hint {
  margin: 0;
  font-size: var(--k-fs-xs);
  line-height: 1.5;
  color: var(--k-muted);
}

.mcpe__run {
  display: flex;
  align-items: baseline;
  gap: var(--k-sp-2);
  margin: calc(-1 * var(--k-sp-2)) 0 0;
  padding: var(--k-sp-2);
  font-size: var(--k-fs-xs);
  background: var(--k-surface2);
  border-radius: var(--k-r-sm);

  code {
    color: var(--k-text);
    overflow-wrap: anywhere;
  }
}

.mcpe__run-label {
  flex: none;
  color: var(--k-faint);
}

.mcpe__pairs {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}

.mcpe__pair-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mcpe__pair {
  display: grid;
  // Fixed tracks for the checkbox and the ✕: the header row has neither, and `auto` would give
  // it other column widths than the rows under it.
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr) 88px 28px;
  align-items: center;
  gap: var(--k-sp-2);

  &--head {
    font-size: var(--k-fs-xs);
    color: var(--k-faint);
  }
}

.mcpe__target {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);

  code {
    color: var(--k-text);
  }
}

.mcpe__target-edit {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mcpe__link {
  padding: 0;
  font: inherit;
  color: var(--k-muted);
  text-decoration: underline;
  background: none;
  border: none;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    color: var(--k-text);
  }
}

.mcpe__cell {
  min-width: 0;
  width: 100%;
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: var(--k-surface);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-sm);
  padding: 6px 8px;

  &::placeholder {
    color: var(--k-faint);
  }

  &:focus {
    outline: none;
    border-color: var(--k-accent);
  }

  &--var {
    width: 240px;
    font-size: var(--k-fs-xs);
    padding: 3px 6px;
  }
}

.mcpe__field .mcpe__add {
  padding: 7px 12px;
  font-size: var(--k-fs-xs);
}

.mcpe__notice {
  margin: 0;
  padding: var(--k-sp-2) var(--k-sp-3);
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-muted);
  border-left: 3px solid var(--k-line-strong);
  border-radius: var(--k-r-sm);
  background: var(--k-surface2);

  &--warn {
    color: var(--k-text);
    border-left-color: var(--k-warning);
    background: color-mix(in srgb, var(--k-warning) 8%, transparent);
  }

  &--error {
    color: var(--k-text);
    border-left-color: var(--k-danger);
    background: color-mix(in srgb, var(--k-danger) 8%, transparent);
  }
}
</style>
