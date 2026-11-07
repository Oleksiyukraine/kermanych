<template>
  <!-- In the flow between the toolbar and the page, like the page-dialog bar: a menu over the
       page would park the native view, and the operator wants to see the form being filled. -->
  <div v-if="open" class="k-sign-in" role="group" :aria-label="t('agents.browser.signIn.label')">
    <span class="k-sign-in__label">{{ t('agents.browser.signIn.label') }}</span>
    <KSkeleton v-if="phase === 'skeleton'" variant="line" width="160px" />
    <template v-else-if="phase === 'ready'">
      <KBtn
        v-for="a in accounts"
        :key="a.id"
        variant="secondary"
        :loading="signIn.busyFor(a.id)"
        :disabled="signIn.anyBusy()"
        v-tip="a.note ? `${a.login} · ${a.note}` : a.login"
        @click="signIn.run(a.id)"
      >{{ a.name }}</KBtn>
      <span v-if="!accounts.length" class="k-sign-in__empty">
        {{ t('agents.browser.signIn.empty') }}
        <RouterLink :to="{ name: 'ai-team', params: { section: 'agents', item: TESTER_AGENT_ID } }">{{ t('agents.browser.signIn.emptyLink') }}</RouterLink>
      </span>
    </template>
    <KIconButton class="k-sign-in__close" :title="t('agents.browser.signIn.close')" @click="emit('update:open', false)">✕</KIconButton>
  </div>
</template>

<script setup lang="ts">
// «Увійти як» (docs/specs/2026-11-08-synergy-login-and-session-env.md, decision 2): the
// project's «Тестувальник» accounts as one-click sign-ins into the page the session browser
// shows. The browser's own partition has no saved passwords, and the operator does not keep
// the app's test logins in their head; the accounts are already on this machine for the tester.
//
// Opens by itself when the page reaches the tester's login path (not in a tester run's own
// browser: its agent signs in); the toolbar's «Увійти як» opens it anywhere. Main types the
// account into the page's form and submits it; a page with no form first goes to the login path.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { TESTER_AGENT_ID, type Session, type TesterSettings } from '@kermanych/core';
import KBtn from './KBtn.vue';
import KIconButton from './KIconButton.vue';
import KSkeleton from './KSkeleton.vue';
import { useOrchestrator } from 'stores/orchestrator';
import { errorText, useKeyedAction } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import { isLoginPage, loginUrlFor } from '../../lib/sign-in';

const props = defineProps<{ session: Session; url: string | null; open: boolean }>();
const emit = defineEmits<{ 'update:open': [open: boolean] }>();

const { t } = useI18n();
const store = useOrchestrator();
const bridge = window.kermanych!.browser!;

// Undefined until the first answer: the bar shows a skeleton, never «no accounts», meanwhile.
const settings = ref<TesterSettings | undefined>();
const phase = useLoadPhase(() => settings.value === undefined);
const accounts = computed(() => settings.value?.accounts ?? []);

// Read again on every opening, so an account added in «Тестувальник» a minute ago is offered.
async function load(): Promise<void> {
  const projectId = props.session.projectId;
  try {
    const res = await store.getTesterSettings(projectId);
    if (projectId === props.session.projectId) settings.value = res;
  } catch (e) {
    store.notify(errorText(e), 'error');
    emit('update:open', false);
  }
}
void load();
watch(
  () => props.open,
  (open) => {
    if (open) void load();
  },
);

// Only on arriving at the login page: hidden with ✕ there, it stays hidden until the next visit.
const offer = computed(() => props.session.tester !== true && !!props.url && !!settings.value && accounts.value.length > 0 && isLoginPage(props.url, settings.value.loginPath));
watch(
  offer,
  (now) => {
    if (now) emit('update:open', true);
  },
  { immediate: true },
);

const signIn = useKeyedAction(async (id: string) => {
  const account = accounts.value.find((a) => a.id === id);
  if (!account) return;
  const loginUrl = props.url && settings.value ? loginUrlFor(props.url, settings.value.loginPath) : null;
  const result = await bridge.signIn(props.session.id, { login: account.login, password: account.password }, loginUrl);
  if (result === 'no-form') throw new Error(t('agents.browser.signIn.noForm'));
  if (result === 'no-page') throw new Error(t('agents.browser.signIn.noPage'));
  emit('update:open', false);
});
</script>

<style scoped lang="scss">
.k-sign-in {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  padding: 6px 8px 6px 12px;
  background: var(--k-surface2);
  border-bottom: 1px solid var(--k-line);
  border-left: 3px solid var(--k-accent);
  flex: none;
}
.k-sign-in__label {
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}
.k-sign-in__empty {
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}
.k-sign-in__close {
  margin-left: auto;
}
</style>
