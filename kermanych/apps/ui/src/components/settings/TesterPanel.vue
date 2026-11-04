<template>
  <section class="ts">
    <div class="ts__row">
      <p class="ts__title">{{ t('tester.panel.title') }}</p>
      <p class="ts__lead">{{ t('tester.panel.lead') }}</p>

      <p v-if="loadError" class="ts__error mono">{{ t('tester.panel.loadFailed', { error: loadError }) }}</p>
      <KSkeleton v-else-if="phase === 'skeleton'" variant="lines" :rows="4" />
      <form v-else-if="phase === 'ready' && draft" class="ts__form" :inert="save.busy.value || undefined" @submit.prevent="save.run()">
        <!-- АКАУНТИ — in the order the tester sees them. The agent gets names, logins and notes;
             a password is typed by Kermanych itself (browser_type_credential). -->
        <p class="ts__caption">{{ t('tester.panel.accounts') }}</p>
        <ol v-if="draft.accounts.length" class="ts__accounts">
          <li v-for="(acc, i) in draft.accounts" :key="keyOf(acc)" class="ts__account">
            <div class="ts__grid">
              <KField v-model="acc.name" :label="t('tester.panel.name')" :placeholder="t('tester.panel.namePlaceholder')" />
              <KField v-model="acc.login" :label="t('tester.panel.login')" />
              <div class="ts__secret">
                <KField v-model="acc.password" :label="t('tester.panel.password')" :type="shown.has(keyOf(acc)) ? 'text' : 'password'" />
                <button type="button" class="ts__link" @click="toggleShown(acc)">
                  {{ shown.has(keyOf(acc)) ? t('tester.panel.hide') : t('tester.panel.show') }}
                </button>
              </div>
              <KField v-model="acc.note" :label="t('tester.panel.note')" :placeholder="t('tester.panel.notePlaceholder')" />
            </div>
            <div class="ts__account-actions">
              <KIconButton :title="t('tester.panel.moveUp')" :disabled="i === 0" @click="move(i, -1)">↑</KIconButton>
              <KIconButton :title="t('tester.panel.moveDown')" :disabled="i === draft.accounts.length - 1" @click="move(i, 1)">↓</KIconButton>
              <KIconButton :title="t('tester.panel.remove')" @click="remove(i)">✕</KIconButton>
            </div>
          </li>
        </ol>
        <p v-else class="ts__hint">{{ t('tester.panel.noAccounts') }}</p>
        <div class="ts__add">
          <KBtn variant="ghost" @click="add">{{ t('tester.panel.add') }}</KBtn>
        </div>

        <div class="ts__path">
          <KField v-model="draft.loginPath" :label="t('tester.panel.loginPath')" :placeholder="loginPathPlaceholder" />
          <p class="ts__hint">{{ loginPathHint }}</p>
        </div>
        <KField v-model="draft.notes" :label="t('tester.panel.notes')" :placeholder="t('tester.panel.notesPlaceholder')" multiline :rows="4" />

        <p v-if="saveError" class="ts__error" role="alert">{{ saveError }}</p>
        <p v-else-if="dirty" class="ts__hint">{{ t('tester.panel.unsaved') }}</p>
        <div class="ts__actions">
          <KBtn variant="ghost" :disabled="!dirty || save.busy.value" @click="cancel">{{ t('tester.panel.cancel') }}</KBtn>
          <KBtn variant="primary" :disabled="!dirty" :loading="save.busy.value" @click="save.run()">{{ t('tester.panel.save') }}</KBtn>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
// «ШІ-команда» → project → «Агенти»: the «Тестувальник» card (docs/specs/2026-11-04-qa-tester-agent.md,
// decisions 4, 5 and 14). Machine-local settings of THIS project — accounts the tester logs in
// with, the sign-in path and free notes — read from and saved to the local api (SQLite), never
// the cloud. An explicit Save/Cancel form: a half-typed account must not be written as it is typed.
// The instruction and skills are the workspace's, edited on the same agent page at the workspace
// scope like every agent's. This block sits on the «Тестувальник» page at the project scope.
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { platformHasDevice, type TesterAccount, type TesterSettings } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { errorText, useAsyncAction } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import KBtn from 'components/kit/KBtn.vue';
import KField from 'components/kit/KField.vue';
import KIconButton from 'components/kit/KIconButton.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';

const props = defineProps<{ projectId: string }>();

const { t } = useI18n();
const store = useOrchestrator();

// «Сторінка входу» is a path in a web project and a deep link in a Mobile one
// (docs/specs/2026-11-04-tester-mobile-device.md, decision 5).
const deepLink = computed(() => platformHasDevice(store.projects.find((p) => p.id === props.projectId)?.platform));
const loginPathPlaceholder = computed(() => t(deepLink.value ? 'tester.panel.loginPathPlaceholderDevice' : 'tester.panel.loginPathPlaceholder'));
const loginPathHint = computed(() => t(deepLink.value ? 'tester.panel.loginPathHintDevice' : 'tester.panel.loginPathHint'));

// `saved`: what the api holds; `draft`: the form. Both undefined until the read for the
// current project answers.
const saved = ref<TesterSettings | undefined>(undefined);
const draft = ref<TesterSettings | undefined>(undefined);
const loadError = ref('');
const saveError = ref('');
const phase = useLoadPhase(() => !saved.value && !loadError.value);

const copy = (s: TesterSettings): TesterSettings => ({ ...s, accounts: s.accounts.map((a) => ({ ...a })) });
const dirty = computed(() => !!draft.value && !!saved.value && JSON.stringify(draft.value) !== JSON.stringify(saved.value));

// A new account has no id until the api assigns one, so rows are keyed by object identity.
const keys = new WeakMap<TesterAccount, number>();
let nextKey = 0;
function keyOf(acc: TesterAccount): number {
  let k = keys.get(acc);
  if (k === undefined) {
    k = nextKey++;
    keys.set(acc, k);
  }
  return k;
}

// Which rows show their password in clear text. Forgotten on reload: masked is the default.
const shown = reactive(new Set<number>());
function toggleShown(acc: TesterAccount): void {
  const k = keyOf(acc);
  if (shown.has(k)) shown.delete(k);
  else shown.add(k);
}

watch(
  () => props.projectId,
  async (projectId) => {
    saved.value = undefined;
    draft.value = undefined;
    loadError.value = '';
    saveError.value = '';
    shown.clear();
    try {
      const res = await store.getTesterSettings(projectId);
      // A late reply for a project the operator has since left must not paint here.
      if (projectId !== props.projectId) return;
      saved.value = res;
      draft.value = copy(res);
    } catch (e) {
      if (projectId === props.projectId) loadError.value = errorText(e);
    }
  },
  { immediate: true },
);

function add(): void {
  draft.value?.accounts.push({ id: '', name: '', login: '', password: '', note: '' });
}

function remove(i: number): void {
  draft.value?.accounts.splice(i, 1);
}

function move(i: number, by: -1 | 1): void {
  const list = draft.value?.accounts;
  const j = i + by;
  if (!list || j < 0 || j >= list.length) return;
  const [acc] = list.splice(i, 1);
  list.splice(j, 0, acc!);
}

function cancel(): void {
  if (saved.value) draft.value = copy(saved.value);
  saveError.value = '';
}

// The api trims, drops accounts without a name or login and assigns ids; the form then shows
// exactly what is stored. The error stays inside the card (README → Async states).
const save = useAsyncAction(
  async () => {
    const projectId = props.projectId;
    if (!draft.value) return;
    saveError.value = '';
    const res = await store.putTesterSettings(projectId, draft.value);
    if (projectId !== props.projectId) return;
    saved.value = res;
    draft.value = copy(res);
    store.notify(t('tester.panel.saved'), 'info');
  },
  { onError: (e) => (saveError.value = errorText(e)) },
);
</script>

<style scoped lang="scss">
.ts { display: grid; gap: 10px; }
.ts__row { padding: 10px 12px; background: var(--k-surface); border: 1px solid var(--k-line); border-radius: var(--k-r); }
.ts__title { margin: 0; font-size: 12.5px; }
.ts__lead { margin: 8px 0 0; font-size: 13px; color: var(--k-muted); }
.ts__form { display: grid; gap: 12px; margin-top: 12px; }
.ts__caption { margin: 0; font-size: 11.5px; color: var(--k-muted); }
.ts__hint { margin: 0; font-size: 11px; color: var(--k-muted); }
.ts__error { margin: 6px 0 0; font-size: 11.5px; color: var(--k-accent); overflow-wrap: anywhere; }
.ts__accounts { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; }
.ts__account {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 8px 10px;
  background: var(--k-surface2);
  border-radius: var(--k-r);
}
.ts__grid { flex: 1; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; }
.ts__secret { display: grid; gap: 2px; }
.ts__account-actions { display: flex; flex-direction: column; gap: 2px; padding-top: 20px; }
.ts__add { display: flex; }
.ts__path { display: grid; gap: 4px; max-width: 320px; }
.ts__actions { display: flex; justify-content: flex-end; gap: 6px; }
.ts__link {
  justify-self: start;
  padding: 0;
  font: inherit;
  font-size: 11px;
  color: var(--k-accent);
  background: none;
  border: 0;
  cursor: pointer;
}
</style>
