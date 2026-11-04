<template>
  <!-- The avatar and its window (docs/specs/2026-11-04-cuk-control-console.md). The character
       peeks out of the window's left edge on every tab; it, ⌘K and a counter-clockwise mouse
       circle all open the window: ЦУК expanded, the Менеджмент assistant folded under its bar
       for owners and managers, the notepad on the right. -->
  <button
    type="button"
    class="asst-launch"
    :class="{ 'asst-launch--out': overlay.open || overlay.unread || notifications.unread || anyBusy }"
    v-tip="launcherTip"
    :aria-label="launcherTip"
    aria-haspopup="dialog"
    :aria-expanded="overlay.open"
    @click="overlay.summon()"
  >
    <AssistantMascot :busy="anyBusy" :variant="assistantMascot" />
    <span v-if="overlay.unread || notifications.unread" class="asst-launch__dot" aria-hidden="true"></span>
  </button>

  <!-- Kept mounted once opened and hidden with v-show, so half-written questions and their
       attachments survive closing. While hidden it has no client rects, so the session
       browser's overlay check (composables/useOverlayOpen.ts) does not count it. -->
  <Teleport to="body">
    <div
      v-if="everOpened"
      v-show="overlay.open"
      class="asst-ovl"
      @pointerdown.self="overlay.close()"
    >
      <div
        ref="dialogEl"
        class="asst-ovl__dialog"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        :aria-label="t('cuk.title')"
      >
        <header class="asst-ovl__head">
          <!-- Which workspace the notepad and the Менеджмент panel are about: nothing else on
               screen says so under the backdrop, and the sidebar may be hidden in focus mode. -->
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
          <!-- Below ~1280 px the notification column leaves the row and waits behind this button;
               its count rides on it, so news is not hidden with the column. -->
          <button
            class="asst-ovl__alerts-toggle"
            type="button"
            :aria-pressed="alertsOpen"
            :aria-label="t('cuk.notifications.toggle')"
            v-tip="t('cuk.notifications.toggle')"
            @click="alertsOpen = !alertsOpen"
          >🔔<span v-if="notifications.unread" class="asst-ovl__alerts-count mono">{{ notifications.unread }}</span></button>
          <!-- Below ~900 px the notepad leaves the row and waits behind this button. -->
          <button
            class="asst-ovl__notes-toggle"
            type="button"
            :aria-pressed="notesOpen"
            :aria-label="t('cuk.notes.toggle')"
            v-tip="t('cuk.notes.toggle')"
            @click="notesOpen = !notesOpen"
          >📝</button>
          <span class="asst-ovl__hint mono">{{ t('management.assistant.overlayClose') }}</span>
        </header>
        <div class="asst-ovl__body">
          <CukNotifications class="asst-ovl__alerts" :class="{ 'asst-ovl__alerts--open': alertsOpen }" />
          <div class="asst-ovl__main">
            <!-- The folded panel is ordered first, so its bar sits on top and the expanded
                 panel's composer is always the window's last row. -->
            <CukAssistant
              ref="cukEl"
              :class="{ 'asst-ovl__panel--folded': cukFolded }"
              :folded="cukFolded"
              :foldable="hasManagement"
              @toggle="switchPanel"
            />
            <ManagementAssistant
              v-if="hasManagement"
              ref="mgmtEl"
              :class="{ 'asst-ovl__panel--folded': !cukFolded }"
              variant="overlay"
              :folded="!cukFolded"
              :section="MANAGEMENT_DEFAULT_SECTION"
              @toggle="switchPanel"
            />
            <!-- One notification opened from the column or its toast: over the console, which
                 keeps its conversation and draft underneath. -->
            <SkillImprovementView
              v-if="notifications.openId"
              :id="notifications.openId"
              :key="notifications.openId"
              class="asst-ovl__entry"
              @close="closeEntry"
            />
          </div>
          <CukNotepad class="asst-ovl__notes" :class="{ 'asst-ovl__notes--open': notesOpen }" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
// Mounted once by the shell (layouts/MainLayout.vue). Owns every way in — the character, ⌘K,
// the circle gesture, ⌘K forwarded from the session browser — and the window itself: the
// «Центр сповіщень» column (stores/notification-center.ts), the accordion of ЦУК
// (stores/cuk-chat.ts) and the Менеджмент assistant (stores/management-chat.ts, always asked as
// «Огляд»), and the notepad.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { MANAGEMENT_DEFAULT_SECTION } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import { useManagementChat } from 'stores/management-chat';
import { useCukChat } from 'stores/cuk-chat';
import { assistantGestureOn, assistantMascot, useAssistantOverlay } from 'stores/assistant-overlay';
import { useNotificationCenter } from 'stores/notification-center';
import ManagementAssistant from 'components/management/ManagementAssistant.vue';
import AssistantMascot from './AssistantMascot.vue';
import CukAssistant from './CukAssistant.vue';
import CukNotepad from './CukNotepad.vue';
import CukNotifications from './CukNotifications.vue';
import SkillImprovementView from './SkillImprovementView.vue';
import { useCircleGesture } from '../../composables/useCircleGesture';

const { t } = useI18n();
const orchestrator = useOrchestrator();
const projects = useProjects();
const chat = useManagementChat();
const cuk = useCukChat();
const overlay = useAssistantOverlay();
const notifications = useNotificationCenter();

cuk.bindRouter(useRouter());
// The column follows the signed-in user from app start, not from the first opening: a change an
// agent makes must raise its toast even if the window was never opened.
notifications.start();

const workspaceId = computed(() => orchestrator.selectedWorkspaceId);
const workspace = computed(() => (workspaceId.value ? projects.workspaceById.get(workspaceId.value) : undefined));
// Decision 9: the Менеджмент panel is the owner's and the managers' of the current workspace.
const hasManagement = computed(() => !!workspaceId.value && projects.canManageWorkspace(workspaceId.value));
const cukFolded = computed(() => hasManagement.value && overlay.panel !== 'cuk');

const anyBusy = computed(() => chat.busy || cuk.busy);

const launcherTip = computed(() =>
  anyBusy.value
    ? t('cuk.launcherBusy')
    : overlay.unread
      ? t('cuk.launcherUnread')
      : notifications.unread
        ? t('cuk.launcherNotifications', { n: notifications.unread })
        : t('cuk.launcherTip'),
);

const everOpened = ref(false);
const notesOpen = ref(false);
const alertsOpen = ref(false);
const dialogEl = ref<HTMLElement | null>(null);
const cukEl = ref<InstanceType<typeof CukAssistant> | null>(null);
const mgmtEl = ref<InstanceType<typeof ManagementAssistant> | null>(null);
// Where the keyboard was before the window took it, so closing hands it back.
let returnFocus: HTMLElement | null = null;

function focusPanel(): void {
  if (overlay.panel === 'management' && mgmtEl.value) mgmtEl.value.focus();
  else if (cukEl.value) cukEl.value.focus();
  else dialogEl.value?.focus();
}

// The accordion: one panel expanded, the other folded to its bar; either bar swaps them.
function switchPanel(): void {
  overlay.panel = overlay.panel === 'cuk' ? 'management' : 'cuk';
  void nextTick(focusPanel);
}

watch(
  () => overlay.summons,
  () => {
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
      // The role decides whether the Менеджмент panel is there at all; a roster nobody has read
      // yet is read now. A failed read leaves the window ЦУК-only, the least-privileged view.
      const ws = workspaceId.value;
      if (ws && !projects.members[ws]) void projects.loadMembers(ws).catch(() => {});
      await nextTick();
      // An entry opened from a toast takes the keyboard itself (SkillImprovementView).
      if (!notifications.openId) focusPanel();
      return;
    }
    // A closed window reopens on the console, not on the entry last looked at.
    notifications.close();
    returnFocus?.focus();
    returnFocus = null;
  },
);

function closeEntry(): void {
  notifications.close();
  void nextTick(focusPanel);
}

// The Менеджмент panel can vanish while it is expanded (another workspace, another role):
// the accordion then falls back to ЦУК.
watch(hasManagement, (has) => {
  if (!has) overlay.panel = 'cuk';
});

// An answer landing while nobody is looking marks the character until the window is opened —
// from either assistant.
watch(anyBusy, (busy, was) => {
  if (was && !busy && !overlay.open) overlay.unread = true;
});

// ⌘K / Ctrl+K, by physical key so the Ukrainian layout works, in fields too. Ctrl+K inside the
// terminal stays the shell's (kill-line) — the same exception the focus-mode hotkey makes.
// Capture phase, so a page's own handler for K never sees it first.
function onHotkey(e: KeyboardEvent): void {
  if (e.code !== 'KeyK' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
  if (!e.metaKey && (e.target as HTMLElement | null)?.closest?.('.xterm')) return;
  e.preventDefault();
  overlay.summon();
}

// Esc closes the window — in the bubble phase, so whatever inside it claims Esc first (the
// Хелпери panel stops it) keeps it. A Quasar dialog on top (the «Новий чат» confirmation)
// owns its Esc too. An open notification entry is closed first, back to the console.
function onEscape(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented || !overlay.open) return;
  if (document.querySelector('.q-dialog')) return;
  e.preventDefault();
  if (notifications.openId) closeEntry();
  else overlay.close();
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

// ── The window ──────────────────────────────────────────────────────────────
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

// Decision 7: one fixed size, whatever the conversation holds — the console is a workplace,
// not a bubble that grows with each answer. Wider since the notification column joined the row
// (docs/specs/2026-11-04-skill-self-improvement.md, decision 6), so the console keeps its room.
.asst-ovl__dialog {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(1440px, 94vw);
  height: min(780px, 84vh);
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

// Shown only where their column leaves the row (the narrow layouts below).
.asst-ovl__notes-toggle,
.asst-ovl__alerts-toggle {
  display: none;
  position: relative;
  width: 28px;
  height: 28px;
  padding: 0;
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-pill);
  background: color-mix(in srgb, var(--k-surface) 94%, transparent);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;

  &[aria-pressed='true'] {
    border-color: var(--k-accent);
  }
}

.asst-ovl__alerts-count {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 16px;
  padding: 0 4px;
  border-radius: var(--k-r-pill);
  background: var(--k-accent);
  color: var(--k-on-accent);
  font-size: 10px;
  line-height: 16px;
}

// Notifications on the left, the console in the middle, the notepad on the right — the two
// side columns at the console's full height.
.asst-ovl__body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr) 300px;
  gap: var(--k-sp-3);
}

.asst-ovl__main {
  position: relative;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.asst-ovl__panel--folded {
  order: -1;
}

.asst-ovl__notes,
.asst-ovl__alerts {
  min-height: 0;
}

// An opened notification lies over the console, which keeps its conversation underneath.
.asst-ovl__entry {
  position: absolute;
  z-index: 3;
  inset: 0;
}

@media (max-width: 1279px) {
  .asst-ovl__body {
    grid-template-columns: minmax(0, 1fr) 300px;
  }

  .asst-ovl__alerts-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  // Behind 🔔: slides over the console from the left when asked for.
  .asst-ovl__alerts {
    position: absolute;
    z-index: 4;
    top: 0;
    left: 0;
    bottom: 0;
    width: min(300px, 100%);
    transform: translateX(calc(-100% - var(--k-sp-5)));
    visibility: hidden;
    transition: transform 0.2s ease, visibility 0s linear 0.2s;
  }

  .asst-ovl__alerts--open {
    transform: none;
    visibility: visible;
    transition: transform 0.2s ease;
  }
}

@media (max-width: 900px) {
  .asst-ovl__body {
    position: relative;
    grid-template-columns: minmax(0, 1fr);
  }

  .asst-ovl__notes-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  // Behind 📝: slides over ЦУК from the right when asked for.
  .asst-ovl__notes {
    position: absolute;
    z-index: 2;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(300px, 100%);
    transform: translateX(calc(100% + var(--k-sp-5)));
    visibility: hidden;
    transition: transform 0.2s ease, visibility 0s linear 0.2s;
  }

  .asst-ovl__notes--open {
    transform: none;
    visibility: visible;
    transition: transform 0.2s ease;
  }
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

  .asst-ovl__notes,
  .asst-ovl__alerts {
    transition: none;
  }
}
</style>
