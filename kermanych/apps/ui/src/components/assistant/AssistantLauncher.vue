<template>
  <!-- The Менеджмент assistant from anywhere (docs/specs/2026-11-03-assistant-overlay.md). The
       character peeks out of the window's left edge; it, ⌘K and a counter-clockwise mouse circle
       all summon the assistant. On the Менеджмент tab none of this shows — the tab's own dock
       answers the summons there (decision 7). -->
  <button
    v-if="!onManagement"
    type="button"
    class="asst-launch"
    :class="{ 'asst-launch--out': overlay.open || overlay.unread || chat.busy }"
    v-tip="launcherTip"
    :aria-label="launcherTip"
    aria-haspopup="dialog"
    :aria-expanded="overlay.open"
    @click="overlay.summon()"
  >
    <AssistantMascot :busy="chat.busy" />
    <span v-if="overlay.unread" class="asst-launch__dot" aria-hidden="true"></span>
  </button>

  <!-- Kept mounted once opened and hidden with v-show, so a half-written question and its
       attachments survive closing (decision 5). While hidden it has no client rects, so the
       session browser's overlay check (composables/useOverlayOpen.ts) does not count it. -->
  <Teleport to="body">
    <div
      v-if="everOpened"
      v-show="overlay.open && !onManagement"
      class="asst-ovl"
      @pointerdown.self="overlay.close()"
    >
      <div
        ref="dialogEl"
        class="asst-ovl__dialog"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
      >
        <header class="asst-ovl__head">
          <!-- Which workspace the conversation is about: off the Менеджмент tab nothing else on
               screen says so, and the sidebar may be hidden in focus mode. -->
          <span v-if="workspaceId" class="asst-ovl__scope mono">
            <span v-if="workspace?.icon" class="asst-ovl__emoji" aria-hidden="true">{{ workspace.icon }}</span>
            <span
              v-else
              class="asst-ovl__dot"
              :style="{ background: workspace?.color ?? 'var(--k-accent)' }"
              aria-hidden="true"
            ></span>
            <span class="asst-ovl__scope-name">{{ workspace?.name ?? '' }}</span>
          </span>
          <span class="asst-ovl__hint mono">{{ t('management.assistant.overlayClose') }}</span>
        </header>
        <div v-if="!workspaceId" class="asst-ovl__blank">
          <div class="asst-ovl__blank-eyebrow mono">{{ t('management.blank.eyebrow') }}</div>
          <p class="asst-ovl__blank-text">{{ t('management.blank.text') }}</p>
          <p v-if="orchestrator.selectedProjectId" class="asst-ovl__blank-text asst-ovl__blank-note">
            {{ t('management.blank.note') }}
          </p>
        </div>
        <ManagementAssistant
          v-else
          ref="assistantEl"
          variant="overlay"
          :section="MANAGEMENT_DEFAULT_SECTION"
        />
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
// Mounted once by the shell (layouts/MainLayout.vue). Owns every way in — the character, ⌘K,
// the circle gesture, ⌘K forwarded from the session browser — and the overlay itself. The
// conversation is the Менеджмент tab's (stores/management-chat.ts); the overlay always asks as
// the «Огляд» section (decision 6).
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { MANAGEMENT_DEFAULT_SECTION } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import { useManagementChat } from 'stores/management-chat';
import { assistantGestureOn, useAssistantOverlay } from 'stores/assistant-overlay';
import ManagementAssistant from 'components/management/ManagementAssistant.vue';
import AssistantMascot from './AssistantMascot.vue';
import { useCircleGesture } from '../../composables/useCircleGesture';

const { t } = useI18n();
const route = useRoute();
const orchestrator = useOrchestrator();
const projects = useProjects();
const chat = useManagementChat();
const overlay = useAssistantOverlay();

const onManagement = computed(() => route.matched.some((r) => r.name === 'management'));
const workspaceId = computed(() => orchestrator.selectedWorkspaceId);
const workspace = computed(() => (workspaceId.value ? projects.workspaceById.get(workspaceId.value) : undefined));

const launcherTip = computed(() =>
  chat.busy
    ? t('management.assistant.launcherBusy')
    : overlay.unread
      ? t('management.assistant.launcherUnread')
      : t('management.assistant.launcherTip'),
);

const everOpened = ref(false);
const dialogEl = ref<HTMLElement | null>(null);
const assistantEl = ref<InstanceType<typeof ManagementAssistant> | null>(null);
// Where the keyboard was before the overlay took it, so closing hands it back.
let returnFocus: HTMLElement | null = null;

// The summons is answered here only off the Менеджмент tab; on it the dock takes focus.
watch(
  () => overlay.summons,
  () => {
    if (onManagement.value) return;
    if (overlay.open) overlay.close();
    else overlay.show();
  },
);

watch(
  () => overlay.open,
  async (open) => {
    if (open) {
      everOpened.value = true;
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      await nextTick();
      if (assistantEl.value) assistantEl.value.focus();
      else dialogEl.value?.focus();
      return;
    }
    returnFocus?.focus();
    returnFocus = null;
  },
);

// Entering Менеджмент — by the tab or by a citation clicked in the overlay (decision 8) —
// closes the overlay: the tab's own dock is the chat there.
watch(onManagement, (on) => {
  if (on) overlay.close();
});

// An answer landing while nobody is looking marks the character until the overlay is opened.
watch(
  () => chat.busy,
  (busy, was) => {
    if (was && !busy && !overlay.open && !onManagement.value) overlay.unread = true;
  },
);

// ⌘K / Ctrl+K, by physical key so the Ukrainian layout works, in fields too. Ctrl+K inside the
// terminal stays the shell's (kill-line) — the same exception the focus-mode hotkey makes.
// Capture phase, so a page's own handler for K never sees it first.
function onHotkey(e: KeyboardEvent): void {
  if (e.code !== 'KeyK' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
  if (!e.metaKey && (e.target as HTMLElement | null)?.closest?.('.xterm')) return;
  e.preventDefault();
  overlay.summon();
}

// Esc closes the overlay — in the bubble phase, so whatever inside it claims Esc first (the
// Хелпери panel stops it) keeps it. A Quasar dialog on top (the «Новий чат» confirmation)
// owns its Esc too.
function onEscape(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented || !overlay.open || onManagement.value) return;
  if (document.querySelector('.q-dialog')) return;
  e.preventDefault();
  overlay.close();
}

let offBrowserShortcut: (() => void) | undefined;
onMounted(() => {
  window.addEventListener('keydown', onHotkey, true);
  window.addEventListener('keydown', onEscape);
  // ⌘K pressed while the keyboard is inside a session browser page: main forwards it.
  offBrowserShortcut = window.kermanych?.browser?.onShortcut((_sessionId, shortcut) => {
    if (shortcut === 'assistant') overlay.summon();
  });
});
onUnmounted(() => {
  window.removeEventListener('keydown', onHotkey, true);
  window.removeEventListener('keydown', onEscape);
  offBrowserShortcut?.();
});

useCircleGesture(assistantGestureOn, () => overlay.summon());
</script>

<style scoped lang="scss">
// ── The character at the window's edge ──────────────────────────────────────
// Peeks out by about half; slides further out on hover, while it is thinking, has news, or
// its overlay is open. Above the drawer, header and footer, a full-screen session browser
// (KBrowserPane, 4000) and its own overlay — it is that overlay's toggle — but below Quasar
// dialogs (6000).
.asst-launch {
  position: fixed;
  left: 0;
  bottom: 108px;
  z-index: 5001;
  width: 66px;
  height: 66px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  transform: translateX(-46%);
  transition: transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1);

  &:hover,
  &:focus-visible {
    transform: translateX(-8%) rotate(-6deg);
  }

  &:focus-visible {
    outline: none;

    :deep(.mascot) {
      filter: drop-shadow(0 0 0 var(--k-accent)) drop-shadow(0 0 3px var(--k-accent));
    }
  }
}

.asst-launch--out {
  transform: translateX(-8%);
}

// «Відповів»: the accent dot on the character's shoulder, with the house pulse ring.
.asst-launch__dot {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 11px;
  height: 11px;
  border-radius: var(--k-r-pill);
  background: var(--k-accent);
  box-shadow: 0 0 0 2px var(--k-canvas);

  &::after {
    content: '';
    position: absolute;
    inset: -2px;
    border-radius: inherit;
    border: 2px solid var(--k-accent);
    animation: asst-launch-ring 1.6s ease-out infinite;
  }
}

@keyframes asst-launch-ring {
  from {
    transform: scale(1);
    opacity: 0.8;
  }
  to {
    transform: scale(2.2);
    opacity: 0;
  }
}

// ── The overlay ─────────────────────────────────────────────────────────────
// Above a full-screen session browser (4000), below Quasar dialogs (6000) so the «Новий чат»
// confirmation stacks on top, and below menus and toasts.
.asst-ovl {
  position: fixed;
  inset: 0;
  z-index: 5000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--k-sp-5);
  background: color-mix(in srgb, var(--k-bg) 55%, transparent);
  -webkit-backdrop-filter: blur(6px) saturate(120%);
  backdrop-filter: blur(6px) saturate(120%);
  animation: asst-ovl-in 0.16s ease-out;
}

@keyframes asst-ovl-in {
  from {
    opacity: 0;
  }
}

.asst-ovl__dialog {
  display: flex;
  flex-direction: column;
  width: min(760px, 100%);
  max-height: 75vh;
  min-height: 0;
  outline: none;
  animation: asst-ovl-rise 0.2s cubic-bezier(0.2, 0.9, 0.3, 1.1);
}

@keyframes asst-ovl-rise {
  from {
    transform: translateY(10px) scale(0.98);
    opacity: 0;
  }
}

.asst-ovl__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  margin-bottom: var(--k-sp-2);
  padding: 0 var(--k-sp-2);
}

.asst-ovl__scope {
  display: inline-flex;
  align-items: center;
  gap: var(--k-sp-2);
  min-width: 0;
  padding: 4px var(--k-sp-3);
  font-size: var(--k-fs-xs);
  color: var(--k-text);
  background: color-mix(in srgb, var(--k-surface) 94%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-pill);
}

.asst-ovl__dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: var(--k-r-pill);
}

.asst-ovl__emoji {
  flex: none;
  font-size: 13px;
  line-height: 1;
}

.asst-ovl__scope-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asst-ovl__hint {
  margin-left: auto;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

// No workspace: the Менеджмент tab's invitation, on the same glass as the chat.
.asst-ovl__blank {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: var(--k-sp-5);
  background: color-mix(in srgb, var(--k-surface) 94%, transparent);
  -webkit-backdrop-filter: blur(22px) saturate(150%);
  backdrop-filter: blur(22px) saturate(150%);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  box-shadow: var(--k-shadow-toast);
}

.asst-ovl__blank-eyebrow {
  font-size: var(--k-fs-xs);
  letter-spacing: 0.2em;
  color: var(--k-muted);
}

.asst-ovl__blank-text {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  color: var(--k-muted);
}

.asst-ovl__blank-note {
  font-size: var(--k-fs-sm);
  color: var(--k-faint);
}

@media (prefers-reduced-motion: reduce) {
  .asst-launch {
    transition: none;
  }

  .asst-launch__dot::after,
  .asst-ovl,
  .asst-ovl__dialog {
    animation: none;
  }
}
</style>
