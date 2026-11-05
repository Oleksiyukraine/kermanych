<template>
  <div class="k-device">
    <div class="k-device__bar">
      <KChipSelect
        v-if="baseOptions.length"
        :model-value="basePick.value.value"
        :options="baseOptions"
        :title="t('agents.device.baseTitle')"
        :loading="basePick.pending.value"
        placement="down"
        @update:model-value="chooseBase"
      />
      <!-- Without the device info there is no picker: say why and offer to read it again, also
           while the screen is on (the empty states, which say it too, are hidden then). -->
      <button
        v-else-if="infoError"
        type="button"
        class="k-device__btn k-device__btn--error"
        v-tip="t('agents.device.infoFailed', { error: infoError })"
        @click="loadInfo()"
      >⚠ <span class="k-device__label">{{ t('agents.device.retry') }}</span></button>
      <span class="k-device__gap" aria-hidden="true"></span>
      <KIconButton
        v-for="b in navButtons"
        :key="b"
        :title="t(`agents.device.buttons.${b}`)"
        :disabled="!streaming"
        @click="stream.send({ type: 'button', button: b })"
      >{{ BUTTON_GLYPHS[b] }}</KIconButton>
      <KIconButton :title="t('agents.device.rotate')" :disabled="!streaming" @click="rotate">⟳</KIconButton>
      <KIconButton
        :title="t('agents.device.screenshot')"
        :disabled="!screenOn"
        :loading="screenshotAction.busy.value"
        @click="screenshotAction.run()"
      >⎙</KIconButton>
      <button
        type="button"
        class="k-device__btn"
        :class="{ 'k-device__btn--on': picking }"
        :disabled="!streaming"
        :aria-pressed="picking"
        v-tip="t('agents.device.pickTitle')"
        @click="picking = !picking"
      >◎ <span class="k-device__label">{{ t('agents.browser.pick') }}</span></button>
      <!-- The agent's device tools and preview start/stop refuse while paused (the api enforces
           it), so the operator can take the device without the agent tapping under the cursor. -->
      <button
        type="button"
        class="k-device__btn k-device__agent"
        :class="{ 'k-device__btn--on': pausedPick.value.value }"
        :disabled="!info || pausedPick.pending.value"
        v-tip="pausedPick.value.value ? t('agents.device.agentPausedTip') : t('agents.device.agentIdleTip')"
        @click="pausedPick.set(!pausedPick.value.value)"
      >
        <template v-if="pausedPick.value.value">⏸ <span class="k-device__label">{{ t('agents.browser.agentPaused') }} · </span><u>{{ t('agents.browser.agentResume') }}</u></template>
        <template v-else><span class="k-device__agent-dot" aria-hidden="true"></span><span class="k-device__label">{{ t('agents.browser.agentIdle') }}</span></template>
      </button>
      <KIconButton
        v-if="splittable"
        :title="browser.split ? t('agents.browser.splitOff') : t('agents.browser.splitOn')"
        :active="browser.split"
        @click="browser.setSplit(!browser.split)"
      >◫</KIconButton>
    </div>

    <!-- The doer's own tab while its «Тестувальник» drives the device
         (docs/specs/2026-11-04-tester-mobile-device.md, decision 3); not in the tester's tab. -->
    <p v-if="tester" class="k-device__busy" role="status">
      <span>{{ t('tester.device.busy') }}</span>
      <button type="button" class="k-device__busy-link" @click="store.selectSession(tester.id)">{{ t('tester.device.open') }}</button>
    </p>

    <KPreviewRow :preview="preview" />

    <KPicksTray :session-id="session.id" :sending="sending" @send="emit('send')" />

    <!-- From the moment the device has booted — `setup` and `install` still running — the screen
         shows, so the build's progress on the device is visible. -->
    <div v-if="screenOn" class="k-device__screen">
      <canvas
        ref="canvasEl"
        class="k-device__canvas"
        :class="{ 'k-device__canvas--picking': picking }"
        tabindex="0"
        :aria-label="t('agents.device.screenAria', { name: runtime?.name ?? '' })"
        :aria-busy="pickAction.busy.value || undefined"
        @pointerdown="onPickDown"
      ></canvas>
      <p v-if="stream.error.value" class="k-device__overlay k-device__overlay--error" role="alert">
        {{ t('agents.device.streamFailed', { error: stream.error.value }) }}
      </p>
      <p v-else-if="!stream.frameSize.value" class="k-device__overlay">
        <KSpinner :size="12" /> {{ t('agents.device.waitingFrame') }}
      </p>
    </div>
    <div v-else-if="phase === 'starting'" class="k-device__empty">
      <KSpinner :size="16" />
      <p class="k-device__empty-text">{{ booting ? t('agents.device.booting') : t('agents.device.starting') }}</p>
    </div>
    <div v-else-if="emptyPhase !== 'ready'" class="k-device__empty">
      <KSkeleton v-if="emptyPhase === 'skeleton'" variant="lines" :rows="3" width="320px" />
    </div>
    <div v-else-if="infoError" class="k-device__empty">
      <p class="k-device__empty-text k-device__empty-text--error" role="alert">{{ t('agents.device.infoFailed', { error: infoError }) }}</p>
      <KBtn @click="loadInfo()">{{ t('agents.device.retry') }}</KBtn>
    </div>
    <!-- A missing or broken file: the row says so and offers «Доручити агенту». -->
    <div v-else-if="!preview.configOk.value" class="k-device__empty">
      <p class="k-device__empty-text">{{ t('agents.device.notConfigured') }}</p>
    </div>
    <div v-else-if="missingTools.length" class="k-device__empty">
      <p class="k-device__empty-title">{{ t('agents.device.toolsTitle') }}</p>
      <ul class="k-device__reasons">
        <li v-for="m in missingTools" :key="m.platform"><b>{{ PLATFORM_NAMES[m.platform] }}:</b> {{ m.reason }}</li>
      </ul>
    </div>
    <div v-else class="k-device__empty">
      <p class="k-device__empty-text">{{ t('agents.device.empty') }}</p>
      <KBtn variant="primary" :loading="preview.startAction.busy.value" @click="preview.start()">{{ t('agents.preview.start') }}</KBtn>
    </div>

    <KPreviewPanel v-if="preview.panel.value" :session="session" :preview="preview" />
  </div>
</template>

<script setup lang="ts">
// The «Пристрій» tab of a Mobile project's `agent` session (docs/specs/2026-11-03-mobile-
// device-preview.md, decisions 6, 8, 9, 12) — also shown in its «Тестувальник» child's tab, bound
// to the doer's session (docs/specs/2026-11-04-tester-mobile-device.md, decision 3): the base-device
// picker and the device toolbar, the preview row, the picks tray, the live screen, and the preview
// logs. Plain DOM — the screen is a <canvas> fed over the api's `/device` socket (useDeviceStream) —
// so it is the same in the desktop app and the web build, and «Поруч із логом» needs nothing like
// the browser's parking.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  DEVICE_PLATFORM_BUTTONS,
  DEVICE_PLATFORMS,
  PREVIEW_DEVICE_STEP,
  isDevicePlatform,
  type DeviceButton,
  type DeviceInfo,
  type DevicePlatform,
  type Session,
} from '@kermanych/core';
import KBtn from './KBtn.vue';
import KChipSelect from './KChipSelect.vue';
import KIconButton from './KIconButton.vue';
import KPicksTray from './KPicksTray.vue';
import KPreviewPanel from './KPreviewPanel.vue';
import KPreviewRow from './KPreviewRow.vue';
import KSkeleton from './KSkeleton.vue';
import KSpinner from './KSpinner.vue';
import { useSessionBrowser } from 'stores/browser';
import { useOrchestrator } from 'stores/orchestrator';
import { api } from '../../lib/api';
import { confirmAction } from '../../lib/confirm';
import { saveFile } from '../../lib/export-file';
import { errorText, useAsyncAction } from '../../composables/useAsyncAction';
import { useDeviceStream } from '../../composables/useDeviceStream';
import { useLoadPhase } from '../../composables/useLoadPhase';
import { useOptimisticValue } from '../../composables/useOptimisticValue';
import { useSessionPreview } from '../../composables/useSessionPreview';
import { runningTesterOf } from '../../lib/tester';

// `session`: the session whose device this is — the doer, also in its tester's tab.
// `splittable`: the host page can move the pane beside the Лог («Поруч із логом»).
// `busyBanner`: the host is the doer's own tab, which says so while a tester drives the device.
const props = withDefaults(defineProps<{ session: Session; sending: boolean; splittable?: boolean; busyBanner?: boolean }>(), {
  splittable: true,
  busyBanner: false,
});
const emit = defineEmits<{ send: [] }>();

const PLATFORM_NAMES: Record<DevicePlatform, string> = { ios: 'iOS', android: 'Android' };
// The toolbar's hardware buttons, those the platform has (an iOS simulator has no Back).
const NAV_BUTTONS: readonly DeviceButton[] = ['home', 'back', 'recents'];
const BUTTON_GLYPHS: Partial<Record<DeviceButton, string>> = { home: '⌂', back: '◁', recents: '▢' };

const { t } = useI18n();
const store = useOrchestrator();
const browser = useSessionBrowser();

function fail(e: unknown): void {
  store.notify(errorText(e), 'error');
}

const tester = computed(() => (props.busyBanner ? runningTesterOf(store.sessions, props.session.id) : undefined));

// ── Device info ────────────────────────────────────────────────────────────
// The tooling, the base devices of this machine, the project's choice and the session's clone.
// Read on mount and whenever the preview changes phase or device (a start makes the clone).
// Reads overlap (mount, then a state push a moment later): the newest answer that succeeded
// wins, so a later read failing never throws away an earlier one that landed after it.
const info = ref<DeviceInfo | null>(null);
const infoError = ref<string | null>(null);
let infoSeq = 0;
let infoApplied = 0;
async function loadInfo(): Promise<void> {
  const seq = ++infoSeq;
  try {
    const next = await api.deviceInfo(props.session.id);
    if (seq < infoApplied) return;
    infoApplied = seq;
    info.value = next;
    infoError.value = null;
  } catch (e) {
    if (seq === infoSeq && seq > infoApplied) infoError.value = errorText(e);
  }
}

// What the picker shows: the session's clone keeps its base (decision 6); without one, what a
// start would use now. ▶ / ↻ send none of it (useSessionPreview) — the api resolves the same.
function shownDevice(): { platform: DevicePlatform; base: string } | null {
  const clone = info.value?.clone;
  if (clone) return { platform: clone.platform, base: clone.base };
  const next = info.value?.next;
  return next ? { platform: next.platform, base: next.base.id } : null;
}
const preview = useSessionPreview(() => props.session, { device: true });
const runtime = computed(() => preview.device.value);
const phase = computed(() => preview.state.value?.phase);
const booting = computed(() => preview.state.value?.phase === 'starting' && preview.state.value.step === PREVIEW_DEVICE_STEP);
const screenOn = computed(() => !!runtime.value);

watch(
  () => `${phase.value ?? ''}:${runtime.value?.serial ?? ''}:${preview.config.value?.kind ?? ''}`,
  () => void loadInfo(),
);
onMounted(() => void loadInfo());

const emptyPhase = useLoadPhase(
  () => (info.value === null && infoError.value === null) || (preview.config.value === undefined && preview.configError.value === null),
);

// The platforms that matter: those the file configures, else both (nothing configured yet).
const platforms = computed<readonly DevicePlatform[]>(() => (info.value?.platforms.length ? info.value.platforms : DEVICE_PLATFORMS));
// Shown only when no platform that matters can run here: one missing tool among two is just
// absent from the picker.
const missingTools = computed(() => {
  const i = info.value;
  if (!i) return [];
  const missing = platforms.value.flatMap((platform) => {
    const tool = i.tools[platform];
    return tool.ok ? [] : [{ platform, reason: tool.reason }];
  });
  return missing.length === platforms.value.length ? missing : [];
});

// ── Base device picker ─────────────────────────────────────────────────────
// One chip over both platforms (grouped when both are configured), so choosing a device also
// chooses its platform. Values are `platform:id`.
const currentBase = computed(() => {
  const d = shownDevice();
  return d ? `${d.platform}:${d.base}` : '';
});
const baseOptions = computed(() => {
  const i = info.value;
  if (!i) return [];
  const usable = platforms.value.filter((p) => i.tools[p].ok);
  const grouped = usable.length > 1;
  const options = i.bases
    .filter((b) => usable.includes(b.platform))
    .map((b) => ({ value: `${b.platform}:${b.id}`, label: `${b.name} · ${b.os}`, group: grouped ? PLATFORM_NAMES[b.platform] : undefined }));
  // The clone's base may be gone from this machine since: the clone does not need it.
  const clone = i.clone;
  if (clone && !options.some((o) => o.value === currentBase.value)) {
    options.unshift({ value: currentBase.value, label: clone.baseName, group: grouped ? PLATFORM_NAMES[clone.platform] : undefined });
  }
  return options;
});
function baseName(value: string): string {
  return info.value?.bases.find((b) => `${b.platform}:${b.id}` === value)?.name ?? value;
}

// A new choice becomes the project's default on this machine. A session that already has a
// clone of another base is re-cloned from the new one, as a ↻ (decision 6) — its app data goes
// with the old copy, so that is confirmed first.
const basePick = useOptimisticValue(
  () => currentBase.value,
  async (value: string) => {
    const i = info.value;
    const [platform, ...rest] = value.split(':');
    const base = rest.join(':');
    if (!i || !isDevicePlatform(platform)) return;
    const recreate = !!i.clone && (i.clone.platform !== platform || i.clone.base !== base);
    const choice = await api.setDeviceChoice(props.session.projectId, { ...i.choice, platform, [platform]: base });
    if (info.value) info.value = { ...info.value, choice };
    if (recreate) await store.startPreview(props.session.id, true, { platform, base });
    await loadInfo();
  },
  { onError: fail },
);
async function chooseBase(value: string): Promise<void> {
  const clone = info.value?.clone;
  if (clone && value !== currentBase.value) {
    const ok = await confirmAction({
      title: t('agents.device.recreateTitle'),
      message: t('agents.device.recreateMessage', { from: clone.baseName, to: baseName(value) }),
      confirmLabel: t('agents.device.recreateConfirm'),
    });
    if (!ok) return;
  }
  await basePick.set(value);
}

// ── Pause ──────────────────────────────────────────────────────────────────
// The toggle flips at once; the api's answer is the new state.
const pausedPick = useOptimisticValue(
  () => info.value?.paused ?? false,
  async (paused: boolean) => {
    const res = await api.setDevicePaused(props.session.id, paused);
    if (info.value) info.value = { ...info.value, paused: res.paused };
  },
  { onError: fail },
);

// ── Screen ─────────────────────────────────────────────────────────────────
const canvasEl = ref<HTMLCanvasElement | null>(null);
const picking = ref(false);
const pickAction = useAsyncAction(
  async (point: { x: number; y: number }, more: boolean) => {
    const pick = await api.devicePick(props.session.id, point);
    browser.addPick(props.session.id, { ...pick, more });
  },
  { onError: fail },
);
const stream = useDeviceStream({
  sessionId: props.session.id,
  canvas: canvasEl,
  active: () => screenOn.value,
  // While picking, a click points at an element instead of tapping it.
  blocked: () => picking.value,
});
// The stream answers only once something is watched: the buttons need a live screen.
const streaming = computed(() => screenOn.value && !!stream.runtime.value && !stream.error.value);
watch(streaming, (on) => {
  if (!on) picking.value = false;
});

const navButtons = computed(() => {
  const platform = runtime.value?.platform;
  return platform ? NAV_BUTTONS.filter((b) => DEVICE_PLATFORM_BUTTONS[platform].includes(b)) : [];
});

// The last frame's shape says which way the device is turned now.
function rotate(): void {
  const size = stream.frameSize.value ?? runtime.value?.screen;
  const landscape = !!size && size.width > size.height;
  stream.send({ type: 'rotate', orientation: landscape ? 'portrait' : 'landscape' });
}

// «◎ Вказати»: a click on the screen picks the element under it; Shift keeps picking. The
// click is the pick's alone: useDeviceStream's own pointerdown listener (added after this one)
// must not see it as a tap once picking has just been switched off.
function onPickDown(e: PointerEvent): void {
  if (!picking.value || e.button !== 0) return;
  e.stopImmediatePropagation();
  e.preventDefault();
  const point = stream.pointAt(e);
  if (!point || pickAction.busy.value) return;
  if (!e.shiftKey) picking.value = false;
  void pickAction.run(point, e.shiftKey);
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && picking.value) {
    e.preventDefault();
    picking.value = false;
  }
}

const screenshotAction = useAsyncAction(
  async () => {
    const png = await api.deviceScreenshot(props.session.id);
    const name = (runtime.value?.name ?? 'device').replace(/[^\p{L}\p{N}._-]+/gu, '-');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    saveFile(`${name}-${stamp}.png`, png, 'image/png');
  },
  { onError: fail },
);

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<style scoped lang="scss">
.k-device {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  // The toolbar's narrow layout keys off the pane's own width, not the window's.
  container: k-device / inline-size;
}

.k-device__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 6px 6px 6px 12px;
  border-bottom: 1px solid var(--k-line);
  flex: none;
}
.k-device__gap {
  flex: 1;
}
@container k-device (max-width: 520px) {
  .k-device__label {
    display: none;
  }
}

.k-device__btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-medium);
  color: var(--k-text);
  background: transparent;
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r-sm);
  white-space: nowrap;
  cursor: pointer;

  &:hover:not(:disabled) {
    border-color: var(--k-accent);
  }
  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
}
.k-device__btn--error {
  color: var(--k-danger);
  border-color: var(--k-danger);
}
.k-device__btn--on {
  color: var(--k-on-accent);
  background: var(--k-accent);
  border-color: var(--k-accent);
}
.k-device__agent {
  color: var(--k-muted);
}
.k-device__agent.k-device__btn--on {
  color: var(--k-on-accent);
}
.k-device__agent-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--k-faint);
}

.k-device__busy {
  flex: none;
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  padding: 6px 12px;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: var(--k-surface2);
  border-bottom: 1px solid var(--k-line);
  box-shadow: inset 3px 0 0 var(--k-warning);
}
.k-device__busy-link {
  padding: 0;
  font: inherit;
  color: var(--k-accent);
  background: none;
  border: 0;
  text-decoration: underline;
  cursor: pointer;

  &:hover {
    color: var(--k-accent-hover);
  }
}

.k-device__screen {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--k-surface);
}
// Fills the box; the screen is drawn letterboxed inside it at the device's aspect ratio
// (lib/device-screen.ts), so pointer fractions are taken against the drawn rect.
.k-device__canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  outline: none;
  touch-action: none;
  cursor: default;

  &:focus-visible {
    box-shadow: inset 0 0 0 2px var(--k-accent);
  }
}
.k-device__canvas--picking {
  cursor: crosshair;
}
.k-device__overlay {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: calc(100% - 24px);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
  pointer-events: none;
}
.k-device__overlay--error {
  color: var(--k-danger);
}

.k-device__empty {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--k-sp-3);
  padding: 24px 12px;
  text-align: center;
}
.k-device__empty-title,
.k-device__empty-text {
  margin: 0;
  max-width: 48ch;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1.55;
}
.k-device__empty-title {
  font-weight: var(--k-fw-medium);
  color: var(--k-text);
}
.k-device__empty-text {
  color: var(--k-muted);
}
.k-device__empty-text--error {
  color: var(--k-danger);
}
.k-device__reasons {
  margin: 0;
  padding: 0;
  max-width: 56ch;
  list-style: none;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1.55;
  color: var(--k-muted);
  text-align: left;
}
</style>
