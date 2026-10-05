<template>
  <div class="k-browser">
    <div class="k-browser__bar">
      <KIconButton :title="t('agents.browser.back')" :disabled="!state?.canGoBack" @click="bridge.back(session.id)">←</KIconButton>
      <KIconButton :title="t('agents.browser.forward')" :disabled="!state?.canGoForward" @click="bridge.forward(session.id)">→</KIconButton>
      <KIconButton :title="t('agents.browser.reload')" :disabled="!state" @click="bridge.reload(session.id)">
        <span :class="{ 'k-browser__spin': state?.loading }">↻</span>
      </KIconButton>
      <input
        v-model="address"
        class="k-browser__address mono"
        type="text"
        spellcheck="false"
        autocomplete="off"
        :placeholder="t('agents.browser.addressPlaceholder')"
        @focus="onAddressFocus"
        @blur="editing = false"
        @keydown.enter="go"
        @keydown.esc="resetAddress"
      />
      <button
        type="button"
        class="k-browser__pick-btn"
        :class="{ 'k-browser__pick-btn--on': picking }"
        :disabled="!state"
        :title="t('agents.browser.pickTitle')"
        @click="togglePick"
      >◎ {{ t('agents.browser.pick') }}</button>
      <KIconButton :title="t('agents.browser.external')" :disabled="!externalUrl" @click="openExternal">⤤</KIconButton>
      <KIconButton :title="t('agents.browser.devtools')" :disabled="!state" @click="bridge.openDevTools(session.id)">⚙</KIconButton>
    </div>
    <p v-if="picking" class="k-browser__hint mono">{{ t('agents.browser.pickHint') }}</p>

    <!-- The tray sits between the toolbar and the page, so a pick never covers what it was
         taken from; it scrolls on its own past a few entries. -->
    <section v-if="picks.length" class="k-browser__tray">
      <div class="k-browser__tray-list">
        <div v-for="p in picks" :key="p.id" class="k-browser__pick">
          <img
            v-if="p.pick.screenshot"
            class="k-browser__thumb"
            :src="`data:${p.pick.screenshot.mimeType};base64,${p.pick.screenshot.data}`"
            alt=""
          />
          <div v-else class="k-browser__thumb k-browser__thumb--none mono">&lt;{{ p.pick.tag.toLowerCase() }}&gt;</div>
          <div class="k-browser__pick-body">
            <span class="k-browser__pick-sel mono" :title="p.pick.selector">{{ p.pick.selector }}</span>
            <span v-if="p.pick.source" class="k-browser__pick-src mono">
              {{ p.pick.source.line != null ? `${p.pick.source.file}:${p.pick.source.line}` : p.pick.source.file }}
            </span>
            <input
              class="k-browser__comment"
              type="text"
              :value="p.comment"
              :placeholder="t('agents.browser.commentPlaceholder')"
              @input="browser.setComment(session.id, p.id, ($event.target as HTMLInputElement).value)"
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
      <div class="k-browser__tray-actions">
        <KBtn variant="primary" :loading="sending" @click="emit('send')">{{ t('agents.browser.send') }}</KBtn>
        <KBtn variant="ghost" :disabled="sending" @click="browser.clearPicks(session.id)">{{ t('agents.browser.clear') }}</KBtn>
      </div>
    </section>

    <!-- The native view is laid over this box by Electron main; the box itself stays empty. -->
    <div v-if="state" ref="viewEl" class="k-browser__view"></div>
    <div v-else class="k-browser__empty">
      <p class="k-browser__empty-text">{{ t('agents.browser.empty') }}</p>
      <KBtn v-if="previewUrl" variant="primary" @click="navigate(previewUrl)">{{ t('agents.browser.openPreview') }}</KBtn>
      <p v-else class="k-browser__empty-hint">{{ t('agents.browser.emptyHint') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
// The Браузер tab of a session (docs/specs/2026-10-05-embedded-browser.md): a toolbar, the
// operator's picks tray, and a placeholder box the session's Electron WebContentsView is laid
// over. Desktop only — the parent renders it only when `window.kermanych.browser` exists.
//
// The native view is painted above the whole DOM, so this component owns when it shows: it
// reports the placeholder's bounds while mounted and nothing covers it, and parks the view
// (`hide`) when an overlay opens (useOverlayOpen) or the pane unmounts — the parent unmounts
// it on every other tab, with no session, and when the route leaves Агенти.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session } from '@kermanych/core';
import KBtn from './KBtn.vue';
import KIconButton from './KIconButton.vue';
import { useSessionBrowser } from 'stores/browser';
import { useOrchestrator } from 'stores/orchestrator';
import { useOverlayOpen } from '../../composables/useOverlayOpen';

const props = defineProps<{ session: Session; sending: boolean }>();
const emit = defineEmits<{ send: [] }>();

const { t } = useI18n();
const browser = useSessionBrowser();
const store = useOrchestrator();
// Non-null by the parent's guard (the tab exists only with the bridge).
const bridge = window.kermanych!.browser!;

const state = computed(() => browser.states[props.session.id]);
const picks = computed(() => browser.picks[props.session.id] ?? []);
const previewUrl = computed(() => store.previews[props.session.id]);
const externalUrl = computed(() => (state.value && /^https?:/i.test(state.value.url) ? state.value.url : ''));

function fail(e: unknown): void {
  store.notify(e instanceof Error ? e.message : String(e), 'error');
}

// ── Address field ────────────────────────────────────────────────────────
// Follows the page while the operator is not typing in it; a navigation the agent makes
// must not overwrite a half-typed address.
const address = ref('');
const editing = ref(false);
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
function resetAddress(e: KeyboardEvent): void {
  address.value = state.value?.url ?? '';
  (e.target as HTMLInputElement).blur();
}
// A bare host (`localhost:5173`, `example.com/x`) gets http:// — dev servers are plain http,
// and an https site redirects. Main refuses anything but http(s) and about:blank.
function normalizeAddress(raw: string): string {
  const v = raw.trim();
  if (!v || /^(https?:\/\/|about:)/i.test(v)) return v;
  return `http://${v}`;
}
function navigate(url: string): void {
  bridge.navigate(props.session.id, props.session.projectId, url).catch(fail);
}
function go(e: KeyboardEvent): void {
  const url = normalizeAddress(address.value);
  if (!url) return;
  address.value = url;
  (e.target as HTMLInputElement).blur();
  navigate(url);
}
function openExternal(): void {
  // The app routes every window.open to the OS browser (external-links.ts).
  if (externalUrl.value) window.open(externalUrl.value, '_blank');
}

// ── Picking ──────────────────────────────────────────────────────────────
// One pick per press: the picker resolves with the clicked element or null (Esc in the page,
// cancelPick, a navigation). A second press while armed cancels.
const picking = ref(false);
async function togglePick(): Promise<void> {
  if (picking.value) {
    bridge.cancelPick(props.session.id);
    return;
  }
  picking.value = true;
  try {
    const pick = await bridge.pick(props.session.id);
    if (pick) browser.addPick(props.session.id, pick);
  } catch (e) {
    fail(e);
  } finally {
    picking.value = false;
  }
}
// Esc with focus in the app (not in the page, where the picker handles it) cancels too.
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && picking.value) bridge.cancelPick(props.session.id);
}

// ── Placing the native view ──────────────────────────────────────────────
const viewEl = ref<HTMLElement | null>(null);
const overlayOpen = useOverlayOpen();
let shownKey = '';

function park(): void {
  if (!shownKey) return;
  shownKey = '';
  bridge.hide();
}
// getBoundingClientRect is viewport-relative, which is what main positions the view in
// (the window's content area), whatever scroll offset an ancestor has.
function sync(): void {
  const el = viewEl.value;
  if (!el || overlayOpen.value) return park();
  const r = el.getBoundingClientRect();
  const bounds = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  if (bounds.width < 1 || bounds.height < 1) return park();
  const key = `${props.session.id}:${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
  if (key === shownKey) return;
  shownKey = key;
  bridge.show(props.session.id, props.session.projectId, bounds);
}

const resize = new ResizeObserver(() => sync());
watch(viewEl, (el, old) => {
  if (old) resize.unobserve(old);
  if (el) resize.observe(el);
  sync();
}, { flush: 'post' });
watch(overlayOpen, () => sync());

onMounted(() => {
  void browser.refresh(props.session.id).catch(fail);
  window.addEventListener('resize', sync);
  // Capture: an ancestor scrolling (none does today) moves the box without resizing it.
  window.addEventListener('scroll', sync, true);
  window.addEventListener('keydown', onKey);
  void nextTick(sync);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', sync);
  window.removeEventListener('scroll', sync, true);
  window.removeEventListener('keydown', onKey);
  resize.disconnect();
  if (picking.value) bridge.cancelPick(props.session.id);
  bridge.hide();
});
</script>

<style scoped lang="scss">
.k-browser {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.k-browser__bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 6px 6px 12px;
  border-bottom: 1px solid var(--k-line);
  flex: none;
}

.k-browser__spin {
  display: inline-block;
  animation: k-browser-spin 0.8s linear infinite;
}
@keyframes k-browser-spin {
  to { transform: rotate(360deg); }
}

.k-browser__address {
  flex: 1;
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

.k-browser__pick-btn {
  flex: none;
  height: 28px;
  padding: 0 10px;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-medium);
  color: var(--k-text);
  background: transparent;
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r-sm);
  cursor: pointer;

  &:hover:not(:disabled) {
    border-color: var(--k-accent);
  }
  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
}
.k-browser__pick-btn--on {
  color: var(--k-on-accent);
  background: var(--k-accent);
  border-color: var(--k-accent);
}

.k-browser__hint {
  margin: 0;
  padding: 4px 12px;
  font-size: var(--k-fs-xs);
  color: var(--k-accent);
  border-bottom: 1px solid var(--k-line);
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
  flex: 1;
  min-height: 0;
  background: var(--k-surface);
}

.k-browser__empty {
  flex: 1;
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
</style>
