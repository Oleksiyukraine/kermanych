<template>
  <div class="rm">
    <p v-if="remote.loadError && !remote.state" class="rm__error mono" role="alert">{{ t('settings.remote.loadFailed', { error: remote.loadError }) }}</p>
    <KSkeleton v-else-if="phase === 'skeleton'" variant="lines" :rows="5" />
    <template v-else-if="phase === 'ready' && remote.state">
      <!-- ── The switch and where it stands ───────────────────────────────── -->
      <div class="rm__group">
        <KCheckbox
          :model-value="enabledPick.value.value"
          :loading="enabledPick.pending.value"
          :label="t('settings.remote.enable')"
          @update:model-value="enabledPick.set"
        />
        <p class="rm__note">{{ t('settings.remote.enableNote') }}</p>
        <div class="rm__phase">
          <KSpinner v-if="remote.state.phase === 'starting'" :size="12" />
          <span
            class="rm__phase-text"
            :class="{
              'rm__phase-text--on': remote.state.phase === 'on',
              'rm__phase-text--warn': remote.state.phase === 'blocked',
              'rm__phase-text--bad': remote.state.phase === 'error',
            }"
          >{{ t(`settings.remote.phase.${remote.state.phase}`) }}</span>
          <KBtn variant="ghost" :loading="recheck.busy.value" @click="recheck.run()">{{ t('settings.remote.recheck') }}</KBtn>
        </div>
        <p v-if="remote.state.phase === 'on' && remote.state.url" class="rm__url mono">{{ remote.state.url }}</p>
        <!-- `error` names why serve failed; `blocked` may carry the api's own words as well
             (the live preview's api, for one, has no Tailscale at all). -->
        <p v-if="remote.state.error && remote.state.phase !== 'on'" class="rm__error mono" role="alert">{{ remote.state.error }}</p>
      </div>

      <div class="rm__rule"></div>

      <!-- ── Tailscale checklist (decisions 6 and 10) ─────────────────────── -->
      <div class="rm__group">
        <span class="rm__label">{{ t('settings.remote.checks.title') }}</span>
        <ul class="rm__checks">
          <li class="rm__check">
            <span class="rm__mark" :class="ts.installed ? 'rm__mark--ok' : 'rm__mark--bad'" aria-hidden="true">{{ ts.installed ? '✓' : '✗' }}</span>
            <div class="rm__check-body">
              <span>{{ t(ts.installed ? 'settings.remote.checks.installed' : 'settings.remote.checks.notInstalled') }}</span>
              <p v-if="!ts.installed" class="rm__note">
                {{ t('settings.remote.checks.installHint') }}
                <a class="rm__link" :href="TAILSCALE_DOWNLOAD" target="_blank" rel="noopener">{{ TAILSCALE_DOWNLOAD }}</a>
              </p>
            </div>
          </li>
          <li class="rm__check">
            <span class="rm__mark" :class="ts.running ? 'rm__mark--ok' : 'rm__mark--bad'" aria-hidden="true">{{ ts.running ? '✓' : '✗' }}</span>
            <div class="rm__check-body">
              <span>{{
                ts.running
                  ? ts.login ? t('settings.remote.checks.runningAs', { login: ts.login }) : t('settings.remote.checks.running')
                  : t('settings.remote.checks.notRunning')
              }}</span>
              <p v-if="!ts.running" class="rm__note">{{ t('settings.remote.checks.runHint') }}</p>
            </div>
          </li>
          <li class="rm__check">
            <span class="rm__mark" :class="ts.https ? 'rm__mark--ok' : 'rm__mark--bad'" aria-hidden="true">{{ ts.https ? '✓' : '✗' }}</span>
            <div class="rm__check-body">
              <span>{{ t(ts.https ? 'settings.remote.checks.https' : 'settings.remote.checks.noHttps') }}</span>
              <span v-if="ts.https && ts.dnsName" class="rm__dim mono">{{ ts.dnsName }}</span>
              <p v-if="!ts.https" class="rm__note">
                {{ t('settings.remote.checks.httpsHint') }}
                <a class="rm__link" :href="TAILSCALE_DNS_ADMIN" target="_blank" rel="noopener">{{ TAILSCALE_DNS_ADMIN }}</a>
              </p>
            </div>
          </li>
          <!-- Linux only (decision 10): serve needs this user to be Tailscale's operator. -->
          <li v-if="remote.state.platform === 'linux'" class="rm__check">
            <span class="rm__mark" :class="ts.operator ? 'rm__mark--ok' : 'rm__mark--bad'" aria-hidden="true">{{ ts.operator ? '✓' : '✗' }}</span>
            <div class="rm__check-body">
              <span>{{ t(ts.operator ? 'settings.remote.checks.operator' : 'settings.remote.checks.noOperator') }}</span>
              <template v-if="!ts.operator">
                <template v-if="remote.state.pkexec">
                  <p class="rm__note">{{ t('settings.remote.checks.operatorPkexec') }}</p>
                  <div class="rm__actions">
                    <KBtn variant="secondary" :loading="operator.busy.value" @click="operator.run()">{{ t('settings.remote.checks.grant') }}</KBtn>
                  </div>
                </template>
                <template v-else>
                  <p class="rm__note">{{ t('settings.remote.checks.operatorSudo') }}</p>
                  <div class="rm__cmd">
                    <code class="rm__code mono">{{ OPERATOR_COMMAND }}</code>
                    <KBtn variant="ghost" :loading="copy.busy.value" @click="copy.run()">{{ t('settings.remote.checks.copy') }}</KBtn>
                  </div>
                </template>
              </template>
            </div>
          </li>
        </ul>
      </div>

      <div class="rm__rule"></div>

      <!-- ── Pairing (spec → Pairing and devices) ─────────────────────────── -->
      <div class="rm__group">
        <div class="rm__actions">
          <KBtn
            variant="primary"
            :disabled="remote.state.phase !== 'on'"
            @click="openPairing()"
          >{{ t('settings.remote.pair.open') }}</KBtn>
        </div>
        <p v-if="remote.state.phase !== 'on'" class="rm__note">{{ t('settings.remote.pair.needsOn') }}</p>
      </div>

      <!-- ── Paired phones (decision 5) ───────────────────────────────────── -->
      <div class="rm__group">
        <span class="rm__label">{{ t('settings.remote.devices.title') }}</span>
        <ul v-if="remote.state.devices.length" class="rm__devices">
          <li v-for="d in remote.state.devices" :key="d.id" class="rm__device">
            <div class="rm__device-text">
              <span class="rm__device-name">{{ d.name }}</span>
              <span class="rm__dim">
                {{ t('settings.remote.devices.pairedAt', { date: dateText(d.createdAt) }) }} ·
                {{ t('settings.remote.devices.lastSeen', { ago: renderTime(t, relativeTime(d.lastSeenAt, now)) }) }} ·
                {{ t(d.push ? 'settings.remote.devices.pushOn' : 'settings.remote.devices.pushOff') }}
              </span>
            </div>
            <KBtn variant="ghost" :loading="removing.busyFor(d.id)" @click="removeDevice(d.id, d.name)">{{ t('settings.remote.devices.remove') }}</KBtn>
          </li>
        </ul>
        <p v-else class="rm__note">{{ t('settings.remote.devices.empty') }}</p>
        <p class="rm__note">{{ t('settings.remote.devices.lapse') }}</p>
      </div>

      <div class="rm__rule"></div>

      <p class="rm__security">{{ t('settings.remote.security') }}</p>
    </template>

    <!-- ── «Підключити телефон» ─────────────────────────────────────────────── -->
    <KModal v-model="pairOpen" :title="t('settings.remote.pair.title')" width="560px">
      <p v-if="pairError" class="rm__error mono" role="alert">{{ pairError }}</p>
      <KSkeleton v-else-if="pairPhase === 'skeleton'" variant="block" height="220px" />
      <div v-else-if="pairPhase === 'ready' && code" class="rm__pair">
        <div class="rm__pair-code">
          <!-- The api renders the QR as an SVG document; an <img> keeps it inert (no v-html). -->
          <img class="rm__qr" :src="qrSrc" :alt="t('settings.remote.pair.qrAlt')" />
          <div class="rm__pair-side">
            <span class="rm__dim">{{ t('settings.remote.pair.codeLabel') }}</span>
            <span class="rm__short mono" :class="{ 'rm__short--gone': !left }">{{ code.short }}</span>
            <span v-if="left" class="rm__dim">{{ t('settings.remote.pair.expiresIn', { left }) }}</span>
            <template v-else>
              <span class="rm__dim">{{ t('settings.remote.pair.expired') }}</span>
              <KBtn variant="secondary" :loading="pairing.busy.value" @click="pairing.run()">{{ t('settings.remote.pair.renew') }}</KBtn>
            </template>
          </div>
        </div>
        <p class="rm__note">{{ t('settings.remote.pair.tailnet') }}</p>
        <div class="rm__howto">
          <span class="rm__label">{{ t('settings.remote.pair.iphoneTitle') }}</span>
          <p class="rm__note">{{ t('settings.remote.pair.iphone') }}</p>
        </div>
        <div class="rm__howto">
          <span class="rm__label">{{ t('settings.remote.pair.androidTitle') }}</span>
          <p class="rm__note">{{ t('settings.remote.pair.android') }}</p>
        </div>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="pairOpen = false">{{ t('settings.remote.pair.close') }}</KBtn>
      </template>
    </KModal>
  </div>
</template>

<script setup lang="ts">
// Налаштування → Застосунок → «Пульт» (docs/specs/2026-11-24-mobile-remote-control.md,
// decisions 5, 6, 7 and 10): the switch, the Tailscale prerequisites with what to do about each,
// pairing a phone with a one-time QR and the list of paired phones. Everything is this
// machine's (stores/remote, fed by the api's `remote_update`), applied on click with no save bar,
// like «Сповіщення».
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { RemotePairing } from '@kermanych/core';
import { useRemote } from 'stores/remote';
import { useOrchestrator } from 'stores/orchestrator';
import { api } from '../../lib/api';
import { confirmAction } from '../../lib/confirm';
import { locale } from '../../lib/locale';
import { remotePairingLeft } from '../../lib/settings';
import { relativeTime, renderTime } from '../../lib/time';
import { useNow } from '../../composables/useNow';
import { errorText, useAsyncAction, useKeyedAction } from '../../composables/useAsyncAction';
import { useOptimisticValue } from '../../composables/useOptimisticValue';
import { useLoadPhase } from '../../composables/useLoadPhase';
import KBtn from 'components/kit/KBtn.vue';
import KCheckbox from 'components/kit/KCheckbox.vue';
import KModal from 'components/kit/KModal.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import KSpinner from 'components/kit/KSpinner.vue';

const TAILSCALE_DOWNLOAD = 'https://tailscale.com/download';
// MagicDNS and «HTTPS Certificates» are both switched on on this page of the admin console.
const TAILSCALE_DNS_ADMIN = 'https://login.tailscale.com/admin/dns';
// Decision 10, without pkexec: the command the operator runs once in a terminal.
const OPERATOR_COMMAND = 'sudo tailscale set --operator=$USER';

const { t } = useI18n();
const remote = useRemote();
const store = useOrchestrator();
// One second: the pairing countdown reads `m:ss`; «last active» only needs minutes but shares it.
const now = useNow(1000);

const phase = useLoadPhase(() => !remote.state && !remote.loadError);
// Only rendered inside `phase === 'ready' && remote.state`.
const ts = computed(() => remote.state!.tailscale);

// ── Switch, recheck, operator ─────────────────────────────────────────────
const enabledPick = useOptimisticValue(
  () => remote.state?.enabled ?? false,
  (next: boolean) => remote.setEnabled(next),
);
const recheck = useAsyncAction(() => remote.recheck());
const operator = useAsyncAction(() => remote.grantOperator());
const copy = useAsyncAction(async () => {
  await navigator.clipboard.writeText(OPERATOR_COMMAND);
  store.notify(t('settings.remote.checks.copied'), 'info');
});

// ── Pairing ───────────────────────────────────────────────────────────────
const pairOpen = ref(false);
const code = ref<RemotePairing>();
// The dialog shows its own failure instead of a toast behind it.
const pairError = ref('');
const pairing = useAsyncAction(
  async () => {
    pairError.value = '';
    code.value = await api.remotePairing();
  },
  { onError: (e) => (pairError.value = errorText(e)) },
);
const pairPhase = useLoadPhase(() => !code.value && pairing.busy.value);
const qrSrc = computed(() => (code.value ? `data:image/svg+xml;utf8,${encodeURIComponent(code.value.qrSvg)}` : ''));
const left = computed(() => (code.value ? remotePairingLeft(code.value.expiresAt, now.value) : undefined));

// Every opening asks for a fresh code: the api replaces any earlier unused one, so a code left
// over from an earlier opening would be dead anyway.
function openPairing(): void {
  code.value = undefined;
  pairError.value = '';
  pairOpen.value = true;
  void pairing.run();
}

// A phone that paired while the dialog is open shows up in `devices` (remote_update): the code
// is spent, so the dialog closes and says so.
watch(
  () => remote.state?.devices.length ?? 0,
  (count, before) => {
    if (pairOpen.value && count > before) {
      pairOpen.value = false;
      store.notify(t('settings.remote.pair.paired'), 'info');
    }
  },
);

// ── Devices ───────────────────────────────────────────────────────────────
const removing = useKeyedAction((id: string) => remote.removeDevice(id));
async function removeDevice(id: string, name: string): Promise<void> {
  const ok = await confirmAction({
    title: t('settings.remote.devices.confirmTitle'),
    message: t('settings.remote.devices.confirmMessage', { name }),
    confirmLabel: t('settings.remote.devices.remove'),
  });
  if (ok) await removing.run(id);
}

function dateText(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(locale.value, { day: 'numeric', month: 'short', year: 'numeric' });
}
</script>

<style scoped lang="scss">
// The settings pane's own column (SettingsPage .set__form / .set__group / .set__note), restated
// because those rules are scoped to the page.
.rm { display: flex; flex-direction: column; gap: var(--k-sp-5); }
.rm__group { display: flex; flex-direction: column; gap: 6px; }
.rm__label { font-family: var(--k-font-ui); font-size: var(--k-fs-base); color: var(--k-text); }
.rm__note { margin: 0; font-size: var(--k-fs-sm); line-height: 1.5; color: var(--k-faint); }
.rm__dim { font-size: var(--k-fs-sm); color: var(--k-muted); }
.rm__error { margin: 0; font-size: var(--k-fs-sm); color: var(--k-danger); overflow-wrap: anywhere; }
.rm__link { color: var(--k-accent); text-decoration: underline; text-underline-offset: 2px; overflow-wrap: anywhere; }
.rm__rule { height: var(--k-rule-thin); background: var(--k-line); }
.rm__actions { display: flex; gap: 6px; flex-wrap: wrap; }

.rm__phase { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.rm__phase-text { font-size: var(--k-fs-base); color: var(--k-muted); }
.rm__phase-text--on { color: var(--k-text); }
.rm__phase-text--warn { color: var(--k-warning); }
.rm__phase-text--bad { color: var(--k-danger); }
.rm__url { margin: 0; font-size: var(--k-fs-sm); color: var(--k-text); overflow-wrap: anywhere; }

.rm__checks { display: flex; flex-direction: column; gap: 10px; margin: 4px 0 0; padding: 0; list-style: none; }
.rm__check { display: flex; gap: 10px; font-size: var(--k-fs-base); }
.rm__check-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.rm__mark { flex: none; width: 14px; font-weight: var(--k-fw-medium); }
.rm__mark--ok { color: var(--k-success); }
.rm__mark--bad { color: var(--k-danger); }
.rm__cmd { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rm__code { padding: 2px 6px; font-size: var(--k-fs-sm); background: var(--k-surface2); border: 1px solid var(--k-line); border-radius: var(--k-r); }

.rm__devices { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; border: 1px solid var(--k-line); border-radius: var(--k-r); }
.rm__device { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; }
.rm__device + .rm__device { border-top: 1px solid var(--k-line); }
.rm__device-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.rm__device-name { font-size: var(--k-fs-base); color: var(--k-text); }

.rm__security { margin: 0; font-size: var(--k-fs-sm); line-height: 1.5; color: var(--k-muted); }

.rm__pair { display: flex; flex-direction: column; gap: 12px; }
.rm__pair-code { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
// The QR needs a light quiet zone whatever the theme, or a camera will not read it.
.rm__qr { width: 200px; height: 200px; padding: 8px; background: #fff; border-radius: var(--k-r); }
.rm__pair-side { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.rm__short { font-size: 34px; letter-spacing: 0.12em; color: var(--k-text); }
.rm__short--gone { color: var(--k-faint); text-decoration: line-through; }
.rm__howto { display: flex; flex-direction: column; gap: 4px; }
</style>
