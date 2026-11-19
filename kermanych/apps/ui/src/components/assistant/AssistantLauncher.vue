<template>
  <!-- The avatar and its window, «ЦТ — Центральний термінал» (docs/specs/2026-11-04-cuk-control-
       console.md, docs/specs/2026-11-17-central-terminal-curtain.md). The character peeks out of
       the window's left edge on every tab; it, ⌘K and a counter-clockwise mouse circle all open
       the window: notifications on the left, the notepad on the right, and in the middle ЦУК,
       «Дослідження» and, for owners and managers, the Менеджмент assistant behind a curtain. -->
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
        :aria-label="t('cuk.terminal.name')"
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
            <div class="asst-ovl__stage">
              <CukAssistant
                id="asst-pane-cuk"
                ref="cukEl"
                role="tabpanel"
                aria-labelledby="asst-tab-cuk"
                class="asst-ovl__pane"
                :class="paneClass('cuk')"
              />
              <ResearchAssistant
                id="asst-pane-research"
                ref="researchEl"
                role="tabpanel"
                aria-labelledby="asst-tab-research"
                class="asst-ovl__pane"
                :class="paneClass('research')"
                :active="expanded === 'research'"
              />
              <ManagementAssistant
                v-if="hasManagement"
                id="asst-pane-management"
                ref="mgmtEl"
                role="tabpanel"
                aria-labelledby="asst-tab-management"
                class="asst-ovl__pane"
                :class="paneClass('management')"
                variant="overlay"
                :section="MANAGEMENT_DEFAULT_SECTION"
              />
            </div>
            <!-- The curtain: one tall strip per panel, stacked top to bottom down the stage's
                 right edge, between it and the notepad, like a door curtain's strips. A strip
                 shows its panel on the stage; the panels stay mounted and laid out, so drafts,
                 attachments and scroll positions survive the switch. -->
            <div
              class="asst-ovl__curtain"
              role="tablist"
              aria-orientation="vertical"
              :aria-label="t('cuk.terminal.curtain')"
              @keydown="onCurtainKey"
            >
              <button
                v-for="s in strips"
                :id="`asst-tab-${s.id}`"
                :key="s.id"
                type="button"
                role="tab"
                class="asst-ovl__strip"
                :class="{ 'asst-ovl__strip--on': expanded === s.id }"
                :aria-selected="expanded === s.id"
                :aria-controls="`asst-pane-${s.id}`"
                :aria-label="s.busy ? `${s.title} — ${s.busyLabel}` : s.title"
                :tabindex="expanded === s.id ? 0 : -1"
                v-tip="s.title"
                @click="pickPanel(s.id, true)"
              >
                <span class="asst-ovl__strip-label mono">{{ s.label }}</span>
                <span v-if="s.busy" class="asst-ovl__strip-busy" aria-hidden="true"></span>
              </button>
            </div>
            <!-- One notification opened from the column or its toast: over the curtain and the
                 stage, which keep their conversations and drafts underneath. A skill
                 improvement, a schedule slip's details, a scheduled task, or a version of
                 the changelog — one at a time. -->
            <SkillImprovementView
              v-if="notifications.openId"
              :id="notifications.openId"
              :key="notifications.openId"
              class="asst-ovl__entry"
              @close="closeEntry"
            />
            <ScheduleSlipView
              v-else-if="notifications.openSlipId"
              :id="notifications.openSlipId"
              :key="`slip:${notifications.openSlipId}`"
              class="asst-ovl__entry"
              @close="closeEntry"
            />
            <ScheduleTaskView
              v-else-if="notifications.openTaskId"
              :id="notifications.openTaskId"
              :key="`task:${notifications.openTaskId}`"
              class="asst-ovl__entry"
              @close="closeEntry"
            />
            <ChangelogEntryView
              v-else-if="notifications.openVersion"
              :version="notifications.openVersion"
              :key="`version:${notifications.openVersion}`"
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
// the circle gesture, ⌘K forwarded from the session browser — and the window itself, the
// central terminal: the «Центр сповіщень» column (stores/notification-center.ts), the curtain
// over ЦУК (stores/cuk-chat.ts), «Дослідження» (stores/research.ts) and the Менеджмент assistant
// (stores/management-chat.ts, always asked as «Огляд»), and the notepad.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { MANAGEMENT_DEFAULT_SECTION } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import { useManagementChat } from 'stores/management-chat';
import { useCukChat } from 'stores/cuk-chat';
import { assistantGestureOn, assistantMascot, useAssistantOverlay, type AssistantPanel } from 'stores/assistant-overlay';
import { useNotificationCenter } from 'stores/notification-center';
import { useResearch } from 'stores/research';
import ManagementAssistant from 'components/management/ManagementAssistant.vue';
import AssistantMascot from './AssistantMascot.vue';
import CukAssistant from './CukAssistant.vue';
import ResearchAssistant from './ResearchAssistant.vue';
import CukNotepad from './CukNotepad.vue';
import CukNotifications from './CukNotifications.vue';
import SkillImprovementView from './SkillImprovementView.vue';
import ScheduleSlipView from './ScheduleSlipView.vue';
import ScheduleTaskView from './ScheduleTaskView.vue';
import ChangelogEntryView from './ChangelogEntryView.vue';
import { useCircleGesture } from '../../composables/useCircleGesture';
import { useAsyncAction } from '../../composables/useAsyncAction';

const { t } = useI18n();
const orchestrator = useOrchestrator();
const projects = useProjects();
const chat = useManagementChat();
const cuk = useCukChat();
const overlay = useAssistantOverlay();
const notifications = useNotificationCenter();
const research = useResearch();

cuk.bindRouter(useRouter());
// The column follows the signed-in user from app start, not from the first opening: a change an
// agent makes, or a schedule slip, must raise its toast even if the window was never opened.
notifications.start();

const workspaceId = computed(() => orchestrator.selectedWorkspaceId);
const workspace = computed(() => (workspaceId.value ? projects.workspaceById.get(workspaceId.value) : undefined));
// Decision 9: the Менеджмент panel is the owner's and the managers' of the current workspace.
const hasManagement = computed(() => !!workspaceId.value && projects.canManageWorkspace(workspaceId.value));
// The panel on the stage: the one used last, ЦУК when that was the Менеджмент panel and it is gone.
const expanded = computed<AssistantPanel>(() => (overlay.panel === 'management' && !hasManagement.value ? 'cuk' : overlay.panel));
const panels = computed<AssistantPanel[]>(() => (hasManagement.value ? ['cuk', 'research', 'management'] : ['cuk', 'research']));

const anyBusy = computed(() => chat.busy || cuk.busy || research.busy);

// The curtain's strips, in the panels' order: a short name on the strip, the full one in its tip,
// and a pulse while that panel's assistant is answering — it may be the hidden one.
const strips = computed(() =>
  panels.value.map((id) => ({
    id,
    label: t(`cuk.terminal.tabs.${id}`),
    title: id === 'cuk' ? t('cuk.title') : id === 'research' ? t('research.title') : t('management.assistant.title'),
    busy: id === 'cuk' ? cuk.busy : id === 'research' ? research.busy : chat.busy,
    busyLabel: id === 'research' ? t('research.busyShort') : t('management.assistant.busyShort'),
  })),
);

// Where a panel lies against the one on the stage. A hidden panel is clipped to nothing on
// the edge it lies on — above the shown one or below it, as its strip does on the curtain — so
// a switch is one vertical wipe toward the strip picked.
function paneClass(panel: AssistantPanel): string {
  const list = panels.value;
  const at = list.indexOf(panel);
  const on = list.indexOf(expanded.value);
  return at === on ? 'asst-ovl__pane--on' : at < on ? 'asst-ovl__pane--before' : 'asst-ovl__pane--after';
}

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
const researchEl = ref<InstanceType<typeof ResearchAssistant> | null>(null);
// Where the keyboard was before the window took it, so closing hands it back.
let returnFocus: HTMLElement | null = null;

function focusPanel(): void {
  if (expanded.value === 'management' && mgmtEl.value) mgmtEl.value.focus();
  else if (expanded.value === 'research' && researchEl.value) researchEl.value.focus();
  else if (cukEl.value) cukEl.value.focus();
  else dialogEl.value?.focus();
}

// A click hands the keyboard to the panel's composer; the arrow keys keep it on the curtain.
function pickPanel(panel: AssistantPanel, focusComposer: boolean): void {
  overlay.panel = panel;
  if (focusComposer) void nextTick(focusPanel);
}

// The tablist's keys: ↑/↓ (and ←/→) step through the strips, Home and End jump to the ends.
function onCurtainKey(e: KeyboardEvent): void {
  const list = panels.value;
  const at = list.indexOf(expanded.value);
  let next: number;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (at + 1) % list.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (at - 1 + list.length) % list.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = list.length - 1;
  else return;
  e.preventDefault();
  const panel = list[next]!;
  pickPanel(panel, false);
  void nextTick(() => document.getElementById(`asst-tab-${panel}`)?.focus());
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
      // An entry opened from a toast takes the keyboard itself (SkillImprovementView and the
      // schedule views).
      if (!notifications.viewOpen) focusPanel();
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

// An answer landing while nobody is looking marks the character until the window is opened —
// from any assistant.
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
// owns its Esc too. An open notification entry is closed first, back to the console; then a
// turn in flight in the EXPANDED panel is stopped (docs/specs/2026-11-15-faster-assistant-
// answers.md, decision 9) — a turn in a hidden panel is not what the operator is looking at.
const stopTurn = useAsyncAction((panel: 'cuk' | 'management') => (panel === 'cuk' ? cuk.stop() : chat.stop()));
function onEscape(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented || !overlay.open) return;
  if (document.querySelector('.q-dialog')) return;
  e.preventDefault();
  const panel = expanded.value;
  if (notifications.viewOpen) closeEntry();
  else if (panel === 'research') {
    if (!researchEl.value?.stopTurn()) overlay.close();
  } else if (panel === 'cuk' ? cuk.busy : chat.busy) void stopTurn.run(panel);
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

// Notifications on the left, the console in the middle, the notepad on the right, all three at
// one height. `--asst-ovl-lip` is the room above them that the clipboard's clip, the notepad's
// rings and the curtain's rod rise into: the side columns pad their paper down by it
// (CukNotifications.vue, CukNotepad.vue), the middle column starts below it, so the three tops
// and bottoms line up.
.asst-ovl__body {
  --asst-ovl-lip: 12px;
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
  margin-top: var(--asst-ovl-lip);
  display: flex;
  gap: var(--k-sp-2);
}

.asst-ovl__notes,
.asst-ovl__alerts {
  min-height: 0;
}

// ── The curtain ─────────────────────────────────────────────────────────────
// A column of tall strips down the stage's right edge, between it and the notepad, one per
// panel, splitting the column's height between them — a door curtain's strips. Built from
// theme tokens only, the way the notepad and the clipboard are, so it reads in every theme.
.asst-ovl__curtain {
  flex: none;
  width: 44px;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}

.asst-ovl__strip {
  position: relative;
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--k-sp-3);
  padding: var(--k-sp-3) 0;
  overflow: hidden;
  appearance: none;
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  // The fabric's folds: darker at the edges, a soft highlight down the middle.
  background:
    linear-gradient(
      to right,
      color-mix(in srgb, #000 18%, transparent),
      transparent 30%,
      color-mix(in srgb, #fff 5%, transparent) 50%,
      transparent 70%,
      color-mix(in srgb, #000 18%, transparent)
    ),
    color-mix(in srgb, var(--k-surface) 94%, transparent);
  box-shadow:
    var(--k-shadow-toast),
    inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent);
  color: var(--k-muted);
  cursor: pointer;
  transition:
    transform 0.2s ease,
    color 0.15s,
    border-color 0.15s;

  // The edge toward the stage: lit on the strip whose panel is shown.
  &::before {
    content: '';
    position: absolute;
    top: var(--k-sp-3);
    bottom: var(--k-sp-3);
    left: 0;
    width: 3px;
    border-radius: 0 var(--k-r-pill) var(--k-r-pill) 0;
    background: var(--k-accent);
    transform: scaleY(0);
    transition: transform 0.35s cubic-bezier(0.65, 0, 0.35, 1);
  }

  // Touched, the strip leans a little toward the stage.
  &:hover {
    color: var(--k-text);
    transform: translateX(-2px);
  }

  &:focus-visible {
    outline: 2px solid var(--k-accent);
    outline-offset: 2px;
  }
}

// The strip whose panel is on the stage: lit in the accent, like the panels' own titles.
.asst-ovl__strip--on {
  color: var(--k-accent);
  border-color: color-mix(in srgb, var(--k-accent) 60%, var(--k-line-strong));
  background-color: color-mix(in srgb, var(--k-accent) 10%, var(--k-surface));

  &::before {
    transform: none;
  }

  &:hover {
    color: var(--k-accent);
  }
}

// The name runs down the strip, top to bottom.
.asst-ovl__strip-label {
  writing-mode: vertical-rl;
  font-size: var(--k-fs-xs);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  white-space: nowrap;
}

// That panel's assistant is answering — shown on its strip, since the panel may be hidden.
.asst-ovl__strip-busy {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: var(--k-r-pill);
  background: var(--k-accent);
  animation: asst-strip-busy 1.4s ease-in-out infinite;
}

@keyframes asst-strip-busy {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}

// ── The stage ───────────────────────────────────────────────────────────────
// Every panel lies on it, stacked. A hidden one is clipped to nothing on the edge it lies on
// (above the shown one or below it, the order of the strips) and is invisible, so the switch is
// one vertical wipe: the old panel rolls up or down out of view as the new one rolls in behind
// the same edge. The clip reaches past the edges so the shown panel keeps its shadow.
.asst-ovl__stage {
  --pane-bleed: -24px;
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.asst-ovl__pane {
  position: absolute;
  inset: 0;
  visibility: hidden;
  transition:
    clip-path 0.5s cubic-bezier(0.65, 0, 0.35, 1),
    visibility 0s linear 0.5s;
}

.asst-ovl__pane--before {
  clip-path: inset(var(--pane-bleed) var(--pane-bleed) 100% var(--pane-bleed));
}

.asst-ovl__pane--after {
  clip-path: inset(100% var(--pane-bleed) var(--pane-bleed) var(--pane-bleed));
}

.asst-ovl__pane--on {
  z-index: 1;
  visibility: visible;
  clip-path: inset(var(--pane-bleed));
  transition: clip-path 0.5s cubic-bezier(0.65, 0, 0.35, 1);
}

// An opened notification lies over the curtain and the stage, which keep their panels underneath.
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
  .asst-ovl__alerts,
  .asst-ovl__strip,
  .asst-ovl__strip::before,
  .asst-ovl__pane {
    transition: none;
  }

  .asst-ovl__strip-busy {
    animation: none;
  }
}
</style>
