<template>
  <div class="k-browser">
    <div class="k-browser__bar">
      <KIconButton :title="t('agents.browser.back')" :disabled="!state?.canGoBack" @click="bridge.back(session.id)">←</KIconButton>
      <KIconButton :title="t('agents.browser.forward')" :disabled="!state?.canGoForward" @click="bridge.forward(session.id)">→</KIconButton>
      <KIconButton v-if="state?.loading" :title="t('agents.browser.stop')" @click="bridge.stop(session.id)">✕</KIconButton>
      <KIconButton v-else :title="t('agents.browser.reload')" :disabled="!state" @click="bridge.reload(session.id)">↻</KIconButton>
      <input
        ref="addressEl"
        v-model="address"
        class="k-browser__address mono"
        type="text"
        spellcheck="false"
        autocomplete="off"
        :placeholder="t('agents.browser.addressPlaceholder')"
        @focus="onAddressFocus"
        @blur="onAddressBlur"
        @keydown.enter="go"
        @keydown.esc="resetAddress"
      />
      <span class="k-browser__break" aria-hidden="true"></span>
      <KChipSelect
        :model-value="viewportValue"
        :options="viewportOptions"
        :title="t('agents.browser.viewportTitle')"
        :disabled="!state"
        placement="down"
        @update:model-value="setViewport"
      />
      <span
        v-if="state && state.scale < 1"
        class="k-browser__scale mono"
        v-tip="t('agents.browser.scaleTip', { pct: scalePct })"
      >{{ scalePct }}%</span>
      <button
        type="button"
        class="k-browser__btn"
        :class="{ 'k-browser__btn--on': picking }"
        :disabled="!state"
        v-tip="t('agents.browser.pickTitle')"
        @click="togglePick"
      >◎ <span class="k-browser__label">{{ t('agents.browser.pick') }}</span></button>
      <!-- Who drives the page. The agent's browser tools refuse while paused (main enforces it),
           so the operator can take the page without the agent clicking under the cursor. -->
      <button
        v-if="state"
        type="button"
        class="k-browser__btn k-browser__agent"
        :class="{ 'k-browser__agent--live': agentLive && !state.agentPaused, 'k-browser__btn--on': state.agentPaused }"
        v-tip="state.agentPaused ? t('agents.browser.agentPausedTip') : agentLive ? t('agents.browser.agentLiveTip') : t('agents.browser.agentIdleTip')"
        @click="bridge.setAgentPaused(session.id, !state.agentPaused)"
      >
        <template v-if="state.agentPaused">⏸ <span class="k-browser__label">{{ t('agents.browser.agentPaused') }} · </span><u>{{ t('agents.browser.agentResume') }}</u></template>
        <template v-else>
          <span class="k-browser__agent-dot" aria-hidden="true"></span><span class="k-browser__label">{{ agentLive ? t('agents.browser.agentLive') : t('agents.browser.agentIdle') }}</span>
        </template>
      </button>
      <KIconButton :title="t('agents.browser.external')" :disabled="!externalUrl" @click="openExternal(externalUrl)">⤤</KIconButton>
      <KIconButton :title="t('agents.browser.devtools')" :disabled="!state" @click="bridge.openDevTools(session.id)">
        <span class="mono">&lt;/&gt;</span>
      </KIconButton>
      <KIconButton
        :title="browser.split ? t('agents.browser.splitOff') : t('agents.browser.splitOn')"
        :active="browser.split"
        @click="browser.setSplit(!browser.split)"
      >◫</KIconButton>
      <!-- Indeterminate: Chromium reports no load progress worth showing. Absolute, so it
           never shifts the page box (and the native view laid over it). -->
      <span v-if="state?.loading" class="k-browser__progress" aria-hidden="true"></span>
    </div>

    <div v-if="findOpen" class="k-browser__find">
      <input
        ref="findEl"
        v-model="findQuery"
        class="k-browser__find-input"
        type="text"
        spellcheck="false"
        :placeholder="t('agents.browser.find.placeholder')"
        @keydown.enter.prevent="findStep(!$event.shiftKey)"
        @keydown.esc.prevent="closeFind"
      />
      <span class="k-browser__find-count mono">{{ findCount }}</span>
      <KIconButton :title="t('agents.browser.find.prev')" :disabled="!findQuery" @click="findStep(false)">↑</KIconButton>
      <KIconButton :title="t('agents.browser.find.next')" :disabled="!findQuery" @click="findStep(true)">↓</KIconButton>
      <KIconButton :title="t('agents.browser.find.close')" @click="closeFind">✕</KIconButton>
    </div>

    <!-- The page is blocked on alert/confirm until someone answers: the operator here, or the
         agent through its tools (the bar goes away when main reports it answered). -->
    <div v-if="state?.dialog" class="k-browser__dialog" role="group" :aria-label="t(`agents.browser.dialog.${state.dialog.type}`)">
      <div class="k-browser__dialog-body">
        <span class="k-browser__dialog-type mono">{{ t(`agents.browser.dialog.${state.dialog.type}`) }}</span>
        <p class="k-browser__dialog-message">{{ state.dialog.message }}</p>
        <span class="k-browser__dialog-note">{{ t('agents.browser.dialog.agentNote') }}</span>
      </div>
      <div class="k-browser__dialog-actions">
        <KBtn variant="primary" @click="answerDialog(true)">{{ t('agents.browser.dialog.ok') }}</KBtn>
        <KBtn v-if="state.dialog.type !== 'alert'" variant="ghost" @click="answerDialog(false)">{{ t('agents.browser.dialog.cancel') }}</KBtn>
      </div>
    </div>

    <!-- The tray sits between the toolbar and the page, so a pick never covers what it was
         taken from; it scrolls on its own past a few entries, and folds to one row. -->
    <section v-if="picks.length" class="k-browser__tray" :class="{ 'k-browser__tray--folded': trayFolded }">
      <button
        type="button"
        class="k-browser__tray-head"
        :aria-expanded="!trayFolded"
        v-tip="trayFolded ? t('agents.browser.tray.expand') : t('agents.browser.tray.collapse')"
        @click="trayFolded = !trayFolded"
      >
        <span class="k-browser__tray-caret" aria-hidden="true">{{ trayFolded ? '▸' : '▾' }}</span>
        {{ t('agents.browser.tray.title', { n: picks.length }) }}
      </button>
      <template v-if="!trayFolded">
        <div class="k-browser__tray-list">
          <div v-for="p in picks" :key="p.id" class="k-browser__pick">
            <img
              v-if="p.pick.screenshot?.data"
              class="k-browser__thumb"
              :src="`data:${p.pick.screenshot.mimeType};base64,${p.pick.screenshot.data}`"
              alt=""
            />
            <div v-else class="k-browser__thumb k-browser__thumb--none mono">&lt;{{ p.pick.tag.toLowerCase() }}&gt;</div>
            <div class="k-browser__pick-body">
              <span class="k-browser__pick-sel mono" v-tip="p.pick.selector">{{ p.pick.selector }}</span>
              <span v-if="p.pick.source" class="k-browser__pick-src mono">
                {{ p.pick.source.line != null ? `${p.pick.source.file}:${p.pick.source.line}` : p.pick.source.file }}
              </span>
              <input
                class="k-browser__comment"
                type="text"
                :value="p.comment"
                :placeholder="t('agents.browser.commentPlaceholder')"
                @input="browser.setComment(session.id, p.id, ($event.target as HTMLInputElement).value)"
                @keydown.enter="sendOnModEnter"
              />
            </div>
            <button
              type="button"
              class="k-browser__pick-x"
              :title="t('agents.browser.removePick')"
              :aria-label="t('agents.browser.removePick')"
              @click="browser.removePick(session.id, p.id)"
            >✕</button>
          </div>
        </div>
        <input
          class="k-browser__comment k-browser__note"
          type="text"
          :value="browser.notes[session.id] ?? ''"
          :placeholder="t('agents.browser.tray.notePlaceholder')"
          @input="browser.setNote(session.id, ($event.target as HTMLInputElement).value)"
          @keydown.enter="sendOnModEnter"
        />
      </template>
      <div class="k-browser__tray-actions">
        <KBtn variant="primary" :loading="sending" @click="emit('send')">{{ t('agents.browser.send') }}</KBtn>
        <KBtn variant="ghost" :disabled="sending" @click="browser.clearPicks(session.id)">{{ t('agents.browser.clear') }}</KBtn>
      </div>
    </section>

    <!-- The native view is laid over this box by Electron main. The box shows something of its
         own only while the view is parked: a still frame of the page while an overlay is open,
         or the load error / crash panel in place of a blank page. -->
    <div v-if="state" ref="viewEl" class="k-browser__view">
      <div v-if="failed" class="k-browser__failure">
        <h3 class="k-browser__failure-title">
          {{ state.crashed ? t('agents.browser.failure.crashedTitle') : t('agents.browser.failure.title') }}
        </h3>
        <p class="k-browser__failure-text">
          <template v-if="state.error">
            {{ state.error.description }} <span class="mono">({{ state.error.code }})</span>
          </template>
          <template v-else>{{ t('agents.browser.failure.crashedText') }}</template>
        </p>
        <span v-if="failedUrl" class="k-browser__failure-url mono" v-tip="failedUrl">{{ failedUrl }}</span>
        <div class="k-browser__failure-actions">
          <KBtn variant="primary" @click="retry">{{ t('agents.browser.failure.retry') }}</KBtn>
          <KBtn v-if="/^https?:/i.test(failedUrl)" variant="ghost" @click="openExternal(failedUrl)">{{ t('agents.browser.external') }}</KBtn>
        </div>
      </div>
      <img v-else-if="frozen" class="k-browser__frozen" :src="frozen" alt="" />
    </div>
    <div v-else class="k-browser__empty">
      <p class="k-browser__empty-text">{{ t('agents.browser.empty') }}</p>
      <template v-if="lastUrl">
        <KBtn variant="primary" @click="navigate(lastUrl)">{{ t('agents.browser.reopen') }}</KBtn>
        <span class="k-browser__empty-url mono" v-tip="lastUrl">{{ lastUrl }}</span>
      </template>
      <KBtn v-if="previewUrl" :variant="lastUrl ? 'secondary' : 'primary'" @click="navigate(previewUrl)">{{ t('agents.browser.openPreview') }}</KBtn>
      <p v-if="!lastUrl && !previewUrl" class="k-browser__empty-hint">{{ t('agents.browser.emptyHint') }}</p>
    </div>

    <!-- HTTP sign-in (basic/digest, a proxy). A KModal is role="dialog", so opening it parks
         the view by itself (useOverlayOpen); closing it any way but «Увійти» cancels. -->
    <KModal
      :model-value="authOpen"
      :title="state?.auth?.isProxy ? t('agents.browser.auth.proxyTitle', { host: state.auth.host }) : t('agents.browser.auth.title', { host: state?.auth?.host ?? '' })"
      @update:model-value="(open: boolean) => { if (!open) answerAuth(false); }"
    >
      <div class="k-browser__auth">
        <p v-if="state?.auth?.realm" class="k-browser__auth-realm">{{ t('agents.browser.auth.realm', { realm: state.auth.realm }) }}</p>
        <KField v-model="authUser" :label="t('agents.browser.auth.username')" />
        <KField v-model="authPass" type="password" :label="t('agents.browser.auth.password')" @keydown.enter="answerAuth(true)" />
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="answerAuth(false)">{{ t('agents.browser.auth.cancel') }}</KBtn>
        <KBtn variant="primary" @click="answerAuth(true)">{{ t('agents.browser.auth.submit') }}</KBtn>
      </template>
    </KModal>
  </div>
</template>

<script setup lang="ts">
// The session browser of a session (docs/specs/2026-10-05-embedded-browser.md): a toolbar,
// the find / page-dialog bars, the operator's picks tray, and a placeholder box the session's
// Electron WebContentsView is laid over. Desktop only — the parent renders it only when
// `window.kermanych.browser` exists, either as the Браузер tab or beside the Лог («Поруч із
// логом», stores/browser.ts `split`).
//
// The native view is painted above the whole DOM, so this component owns when it shows: it
// reports the placeholder's bounds while mounted and nothing covers it, and parks the view
// (`hide`) when an overlay opens (useOverlayOpen) or the parent holds it (`hold`: a seam
// drag, whose pointer would otherwise vanish into the page), when the page failed to load,
// and when the pane unmounts — the parent unmounts it on every other tab, with no session,
// and when the route leaves Агенти. An overlay or a hold parks it with a still frame of the
// page in the box, so the pane does not blink empty for every menu; the rest park it plainly.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session } from '@kermanych/core';
import KBtn from './KBtn.vue';
import KChipSelect from './KChipSelect.vue';
import KField from './KField.vue';
import KIconButton from './KIconButton.vue';
import KModal from './KModal.vue';
import { useSessionBrowser } from 'stores/browser';
import { useOrchestrator } from 'stores/orchestrator';
import { useOverlayOpen } from '../../composables/useOverlayOpen';
import { addressToUrl } from '../../lib/browser-url';

const props = withDefaults(defineProps<{ session: Session; sending: boolean; hold?: boolean }>(), { hold: false });
const emit = defineEmits<{ send: [] }>();

const { t } = useI18n();
const browser = useSessionBrowser();
const store = useOrchestrator();
// Non-null by the parent's guard (the pane exists only with the bridge).
const bridge = window.kermanych!.browser!;

const state = computed(() => browser.states[props.session.id]);
const picks = computed(() => browser.picks[props.session.id] ?? []);
const previewUrl = computed(() => store.previews[props.session.id]);
const agentLive = computed(() => browser.agentLive.has(props.session.id));
const externalUrl = computed(() => (state.value && /^https?:/i.test(state.value.url) ? state.value.url : ''));

function fail(e: unknown): void {
  store.notify(e instanceof Error ? e.message : String(e), 'error');
}
function navigate(url: string): void {
  browser.navigate(props.session.id, props.session.projectId, url);
}
function openExternal(url: string): void {
  // The app routes every window.open to the OS browser (external-links.ts).
  if (url) window.open(url, '_blank');
}

// ── Address field ────────────────────────────────────────────────────────
// Follows the page while the operator is not typing in it; a navigation the agent makes
// must not overwrite a half-typed address. Leaving the field without Enter puts the page's
// address back, as in any browser.
const addressEl = ref<HTMLInputElement | null>(null);
const address = ref('');
const editing = ref(false);
let submitted = false;
watch(
  () => state.value?.url,
  (url) => {
    if (!editing.value) address.value = url ?? '';
  },
  { immediate: true },
);
function onAddressFocus(e: FocusEvent): void {
  editing.value = true;
  (e.target as HTMLInputElement).select();
}
function onAddressBlur(): void {
  editing.value = false;
  if (!submitted) address.value = state.value?.url ?? '';
  submitted = false;
}
function resetAddress(e: KeyboardEvent): void {
  (e.target as HTMLInputElement).blur();
}
// addressToUrl: a URL-looking entry opens (a bare local host gets http://), anything else is a
// web search. Main still refuses what the session browser may not load.
function go(e: KeyboardEvent): void {
  if (!address.value.trim()) return;
  let url: string;
  try {
    url = addressToUrl(address.value);
  } catch (err) {
    return fail(err);
  }
  submitted = true;
  address.value = url;
  (e.target as HTMLInputElement).blur();
  navigate(url);
}

// ── Viewport ─────────────────────────────────────────────────────────────
// The width the page lays out at. Wider than the pane, main draws it scaled down (state.scale)
// rather than clipped, so a desktop layout can be checked in a narrow split pane.
const VIEWPORT_PRESETS: { value: string; width: number | null; label: string }[] = [
  { value: 'fit', width: null, label: 'agents.browser.viewport.fit' },
  { value: '390', width: 390, label: 'agents.browser.viewport.mobile' },
  { value: '768', width: 768, label: 'agents.browser.viewport.tablet' },
  { value: '1280', width: 1280, label: 'agents.browser.viewport.laptop' },
  { value: '1440', width: 1440, label: 'agents.browser.viewport.desktop' },
];
const viewportValue = computed(() => (state.value?.viewport ? String(state.value.viewport.width) : 'fit'));
// The agent may set a width no preset has; it shows as its own entry rather than as «fit».
const viewportOptions = computed(() => {
  const options = VIEWPORT_PRESETS.map((p) => ({ value: p.value, label: t(p.label) }));
  if (!options.some((o) => o.value === viewportValue.value)) {
    options.push({ value: viewportValue.value, label: t('agents.browser.viewport.custom', { width: viewportValue.value }) });
  }
  return options;
});
const scalePct = computed(() => Math.round((state.value?.scale ?? 1) * 100));
function setViewport(value: string): void {
  bridge.setViewport(props.session.id, props.session.projectId, value === 'fit' ? null : { width: Number(value) });
}

// ── Picking ──────────────────────────────────────────────────────────────
// The picker resolves with the clicked element or null (Esc in the page, cancelPick, a
// navigation). A Shift-click (`more`) re-arms it at once, so several elements are pointed at
// in one go. A second press while armed cancels.
const picking = ref(false);
let alive = true;
async function togglePick(): Promise<void> {
  if (picking.value) {
    bridge.cancelPick(props.session.id);
    return;
  }
  picking.value = true;
  try {
    for (;;) {
      const pick = await bridge.pick(props.session.id);
      if (!pick || !alive) break;
      browser.addPick(props.session.id, pick);
      if (!pick.more) break;
    }
  } catch (e) {
    fail(e);
  } finally {
    picking.value = false;
  }
}

// ── Tray ─────────────────────────────────────────────────────────────────
const trayFolded = ref(false);
function sendOnModEnter(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey) || props.sending) return;
  e.preventDefault();
  emit('send');
}

// ── Find in page ─────────────────────────────────────────────────────────
const findOpen = ref(false);
const findQuery = ref('');
const findEl = ref<HTMLInputElement | null>(null);
const findCount = computed(() => {
  const f = state.value?.find;
  return f && findQuery.value && f.query === findQuery.value ? `${f.active} / ${f.matches}` : '';
});
// Reopened with the last query still in the field: its highlights come back with it.
async function openFind(): Promise<void> {
  if (!findOpen.value && findQuery.value) bridge.find(props.session.id, findQuery.value, true);
  findOpen.value = true;
  await nextTick();
  findEl.value?.focus();
  findEl.value?.select();
}
function closeFind(): void {
  if (!findOpen.value) return;
  findOpen.value = false;
  bridge.stopFind(props.session.id);
}
function findStep(forward: boolean): void {
  if (findQuery.value) bridge.find(props.session.id, findQuery.value, forward);
}
// Every edit searches anew from the top; an emptied field clears the highlights (main).
watch(findQuery, (query) => {
  if (findOpen.value) bridge.find(props.session.id, query, true);
});

// ── Page dialogs and sign-in ─────────────────────────────────────────────
function answerDialog(accept: boolean): void {
  if (!state.value?.dialog) return;
  bridge.answerDialog(props.session.id, accept).catch(fail);
}

// Closed as soon as it is answered, not when main's next state arrives.
const answeredAuth = ref('');
const authUser = ref('');
const authPass = ref('');
const authOpen = computed(() => !!state.value?.auth && state.value.auth.id !== answeredAuth.value);
watch(
  () => state.value?.auth?.id,
  () => {
    authUser.value = '';
    authPass.value = '';
  },
);
function answerAuth(submit: boolean): void {
  const a = state.value?.auth;
  if (!a || a.id === answeredAuth.value) return;
  answeredAuth.value = a.id;
  bridge.answerAuth(props.session.id, a.id, submit ? { username: authUser.value, password: authPass.value } : null);
}

// ── Failure panel ────────────────────────────────────────────────────────
const failed = computed(() => !!state.value && (!!state.value.error || state.value.crashed));
const failedUrl = computed(() => state.value?.error?.url || state.value?.url || '');
// A failed load is retried at the address that failed (the view may still be on the page
// before it); a crashed renderer comes back with a reload.
function retry(): void {
  if (state.value?.error?.url) navigate(state.value.error.url);
  else bridge.reload(props.session.id);
}

// ── Empty state ──────────────────────────────────────────────────────────
// Where the session's browser was before it closed (an idle close, an app restart): offered
// as the way back. Asked again whenever the view goes away.
const lastUrl = ref<string | null>(null);
watch(
  () => !!state.value,
  (has) => {
    if (has) return;
    bridge
      .lastUrl(props.session.id)
      .then((url) => {
        lastUrl.value = url;
      })
      .catch(() => {
        lastUrl.value = null;
      });
  },
  { immediate: true },
);

// ── Keyboard ─────────────────────────────────────────────────────────────
// Cmd/Ctrl+L and Cmd/Ctrl+F belong to the browser while the pane is on screen: here when the
// app has focus, and forwarded by main (onShortcut) when the page has it. By key code, so a
// Ukrainian layout works too. Esc with focus in the app (not in the page, where the picker
// handles it) cancels picking.
function runShortcut(shortcut: KermanychBrowserShortcut): void {
  if (shortcut === 'find') {
    if (state.value) void openFind();
    return;
  }
  addressEl.value?.focus();
  addressEl.value?.select();
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && picking.value) {
    bridge.cancelPick(props.session.id);
    return;
  }
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
  if (e.code === 'KeyL') {
    e.preventDefault();
    runShortcut('focus-address');
  } else if (e.code === 'KeyF' && state.value) {
    e.preventDefault();
    runShortcut('find');
  }
}

// ── Placing the native view ──────────────────────────────────────────────
const viewEl = ref<HTMLElement | null>(null);
const overlayOpen = useOverlayOpen();
// The still frame shown while the view is parked for an overlay; `freezeGen` drops a capture
// that resolves after the view was shown again (or parked for another reason).
const frozen = ref<string | null>(null);
let freezeGen = 0;
let shownKey = '';

function park(freeze: boolean): void {
  if (!freeze) frozen.value = null;
  if (!shownKey) return;
  shownKey = '';
  browser.shownRect = null;
  const gen = ++freezeGen;
  bridge
    .hide({ freeze })
    .then((frame) => {
      if (freeze && gen === freezeGen) frozen.value = frame;
    })
    .catch(() => {
      // A failed capture leaves the box empty, as before still frames existed.
    });
}
// getBoundingClientRect is viewport-relative, which is what main positions the view in
// (the window's content area), whatever scroll offset an ancestor has.
function sync(): void {
  const el = viewEl.value;
  if (!el || failed.value) return park(false);
  if (overlayOpen.value || props.hold) return park(true);
  const r = el.getBoundingClientRect();
  const bounds = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  if (bounds.width < 1 || bounds.height < 1) return park(false);
  const key = `${props.session.id}:${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
  if (key === shownKey) return;
  shownKey = key;
  freezeGen += 1;
  frozen.value = null;
  browser.shownRect = bounds;
  bridge.show(props.session.id, props.session.projectId, bounds);
}

const resize = new ResizeObserver(() => sync());
watch(viewEl, (el, old) => {
  if (old) resize.unobserve(old);
  if (el) resize.observe(el);
  sync();
}, { flush: 'post' });
watch([overlayOpen, () => props.hold, failed], () => sync(), { flush: 'post' });

let offShortcut: (() => void) | undefined;
onMounted(() => {
  void browser.refresh(props.session.id).catch(fail);
  window.addEventListener('resize', sync);
  // Capture: an ancestor scrolling (none does today) moves the box without resizing it.
  window.addEventListener('scroll', sync, true);
  window.addEventListener('keydown', onKey);
  offShortcut = bridge.onShortcut((sessionId, shortcut) => {
    if (sessionId === props.session.id) runShortcut(shortcut);
  });
  void nextTick(sync);
});
onBeforeUnmount(() => {
  alive = false;
  window.removeEventListener('resize', sync);
  window.removeEventListener('scroll', sync, true);
  window.removeEventListener('keydown', onKey);
  offShortcut?.();
  resize.disconnect();
  if (picking.value) bridge.cancelPick(props.session.id);
  if (findOpen.value) bridge.stopFind(props.session.id);
  browser.shownRect = null;
  void bridge.hide();
});
</script>

<style scoped lang="scss">
.k-browser {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  // The toolbar's narrow layout keys off the pane's own width, not the window's.
  container: k-browser / inline-size;
}

// One row while it fits. Narrower (beside the Лог the pane can be a third of the window) it is
// two tidy rows instead of three ragged ones: navigation and the address, then the tools, which
// drop their text labels (their tooltips keep them).
.k-browser__bar {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 6px 6px 6px 12px;
  border-bottom: 1px solid var(--k-line);
  flex: none;
}
.k-browser__break {
  display: none;
}
@container k-browser (max-width: 640px) {
  .k-browser__break {
    display: block;
    flex-basis: 100%;
    height: 0;
  }
  .k-browser__label {
    display: none;
  }
}

.k-browser__progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  overflow: hidden;
  pointer-events: none;

  &::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    width: 30%;
    background: var(--k-accent);
    animation: k-browser-progress 1.1s ease-in-out infinite;
  }
}
@keyframes k-browser-progress {
  from { left: -30%; }
  to { left: 100%; }
}

.k-browser__address {
  flex: 1 1 180px;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: var(--k-surface);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-sm);
  outline: none;

  &:focus {
    border-color: var(--k-accent);
  }
}

.k-browser__scale {
  flex: none;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.k-browser__btn {
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
.k-browser__btn--on {
  color: var(--k-on-accent);
  background: var(--k-accent);
  border-color: var(--k-accent);
}

.k-browser__agent {
  color: var(--k-muted);
}
.k-browser__agent-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--k-faint);
}
.k-browser__agent--live {
  color: var(--k-text);

  .k-browser__agent-dot {
    background: var(--k-accent);
    animation: k-browser-live 1.2s ease-in-out infinite;
  }
}
.k-browser__agent.k-browser__btn--on {
  color: var(--k-on-accent);
}
@keyframes k-browser-live {
  50% { opacity: 0.3; }
}

.k-browser__find {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px 4px 12px;
  border-bottom: 1px solid var(--k-line);
  flex: none;
}
.k-browser__find-input {
  flex: 1;
  min-width: 0;
  max-width: 320px;
  height: 26px;
  padding: 0 8px;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: var(--k-surface);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-sm);
  outline: none;

  &:focus {
    border-color: var(--k-accent);
  }
}
.k-browser__find-count {
  min-width: 48px;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
  text-align: center;
}

.k-browser__dialog {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px 12px;
  padding: 10px 12px;
  background: var(--k-surface2);
  border-bottom: 1px solid var(--k-line);
  border-left: 3px solid var(--k-accent);
  flex: none;
}
.k-browser__dialog-body {
  flex: 1 1 240px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.k-browser__dialog-type {
  font-size: var(--k-fs-xs);
  color: var(--k-accent);
}
.k-browser__dialog-message {
  margin: 0;
  max-height: 8em;
  overflow-y: auto;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.k-browser__dialog-note {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}
.k-browser__dialog-actions {
  display: flex;
  gap: 8px;
  flex: none;
}

.k-browser__tray {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--k-line);
  flex: none;
  max-height: 40%;
}
// Folded: the header and the actions share one row.
.k-browser__tray--folded {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}

.k-browser__tray-head {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-xs);
  font-weight: var(--k-fw-medium);
  color: var(--k-muted);
  background: transparent;
  border: none;
  cursor: pointer;

  &:hover {
    color: var(--k-text);
  }
}
.k-browser__tray--folded .k-browser__tray-head {
  align-self: center;
}
.k-browser__tray-caret {
  width: 10px;
}

.k-browser__tray-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  min-height: 0;
}

.k-browser__pick {
  display: flex;
  align-items: center;
  gap: 10px;
}

.k-browser__thumb {
  flex: none;
  width: 64px;
  height: 40px;
  object-fit: contain;
  background: var(--k-surface);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-sm);
}
.k-browser__thumb--none {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.k-browser__pick-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.k-browser__pick-sel,
.k-browser__pick-src {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-xs);
}
.k-browser__pick-sel { color: var(--k-text); }
.k-browser__pick-src { color: var(--k-muted); }

.k-browser__comment {
  height: 24px;
  padding: 0 6px;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: transparent;
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-sm);
  outline: none;

  &:focus {
    border-color: var(--k-accent);
  }
}
.k-browser__note {
  flex: none;
  height: 28px;
}

.k-browser__pick-x {
  flex: none;
  border: none;
  background: transparent;
  color: var(--k-faint);
  cursor: pointer;

  &:hover {
    color: var(--k-danger);
  }
}

.k-browser__tray-actions {
  display: flex;
  gap: 8px;
  flex: none;
}

.k-browser__view {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--k-surface);
}

// The page as it was when an overlay parked it: drawn where the view was, a little dimmed so
// it does not read as live. The capture is at device pixels, hence contain + top-left.
.k-browser__frozen {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: top left;
  opacity: 0.7;
  pointer-events: none;
  user-select: none;
}

.k-browser__failure {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--k-sp-3);
  padding: 24px;
  text-align: center;
}
.k-browser__failure-title {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  font-weight: var(--k-fw-medium);
  color: var(--k-text);
}
.k-browser__failure-text {
  margin: 0;
  max-width: 52ch;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1.55;
  color: var(--k-muted);
}
.k-browser__failure-url,
.k-browser__empty-url {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}
.k-browser__failure-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}

.k-browser__empty {
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

.k-browser__empty-text,
.k-browser__empty-hint {
  margin: 0;
  max-width: 44ch;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1.55;
}
.k-browser__empty-text { color: var(--k-muted); }
.k-browser__empty-hint { color: var(--k-faint); }

.k-browser__auth {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}
.k-browser__auth-realm {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}
</style>
