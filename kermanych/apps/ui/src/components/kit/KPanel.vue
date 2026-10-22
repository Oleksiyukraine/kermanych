<template>
  <section ref="rootEl" class="k-panel" :class="{ 'k-panel--active': isActive }">
    <!-- floor 1 — header (34px). Hidden when `bare`: the detail column owns the header. -->
    <header v-if="!bare" class="k-panel__header">
      <div class="k-panel__id">
        <KStatusDot :status="session.status" />
        <span class="k-panel__harness mono">{{ session.runtime || 'omp' }}</span>
        <KTag v-if="session.branch">⑂ {{ session.branch }}</KTag>
      </div>
      <div class="k-panel__controls">
        <span class="k-panel__status mono">{{ statusLabel }}</span>
        <KIconButton
          v-if="session.kind === 'chat'"
          :loading="promoting"
          :disabled="pending"
          :title="promoting
            ? t('kit.panel.promoting')
            : t('kit.panel.promoteAgent')"
          @click="emit('promoteAgent')"
        >▶</KIconButton>
        <KIconButton
          v-if="session.kind === 'chat'"
          :loading="filing"
          :disabled="pending"
          :title="t('kit.panel.promoteTask')"
          @click="emit('promoteTask')"
        >⊕</KIconButton>
        <KIconButton
          v-if="session.kind === 'chat'"
          :loading="clearing"
          :disabled="pending"
          :title="t('kit.panel.clear')"
          @click="emit('clear')"
        >✕</KIconButton>
        <KIconButton
          v-if="session.kind === 'agent'"
          :loading="branching"
          :disabled="pending"
          :title="t('kit.panel.branch')"
          @click="emit('branch')"
        >⑂</KIconButton>
        <KIconButton
          v-if="running || stopping"
          :loading="stopping"
          :disabled="pending"
          :title="t('kit.panel.stop')"
          @click="emit('stop')"
        >■</KIconButton>
        <KIconButton
          :loading="openingEditor"
          :title="t('kit.panel.editor')"
          @click="emit('editor')"
        >⧉</KIconButton>
      </div>
    </header>

    <!-- detail toolbar — the log's density switch (muted rows of finished blocks).
         «стиснути все», not «згорнути все»: Ukrainian `роз|горнути` contains `з|горнути`,
         so «згорнути все» is a strict substring of «розгорнути все» and the two controls
         had no distinguishable accessible name — every name-based consumer, from voice
         control to a text locator, resolved the collapse button to the expand one.
         «стиснути» is the plain antonym and shares no prefix with it. -->
    <div v-if="!bare" class="k-panel__tools mono">
      <span class="k-panel__tools-label">{{ t('kit.panel.detailsLabel') }}</span>
      <button type="button" class="k-panel__tools-btn" @click="emit('expandAll', true)">{{ t('kit.panel.expandAll') }}</button>
      <button type="button" class="k-panel__tools-btn" @click="emit('expandAll', false)">{{ t('kit.panel.collapseAll') }}</button>
    </div>

    <!-- my-message navigation — jump between the operator's own messages -->
    <div v-if="userMsgCount > 1" class="k-panel__nav" role="group" :aria-label="t('kit.panel.navGroup')">
      <button type="button" class="k-panel__nav-btn" v-tip="t('kit.panel.prevMsgTip')" :aria-label="t('kit.panel.prevMsg')" @click="jumpUser(-1)">▲</button>
      <span class="k-panel__nav-count mono">{{ userNavLabel }}</span>
      <button type="button" class="k-panel__nav-btn" v-tip="t('kit.panel.nextMsgTip')" :aria-label="t('kit.panel.nextMsg')" @click="jumpUser(1)">▼</button>
    </div>

    <!-- floor 2 — scrollable log -->
    <div
      ref="logEl"
      class="k-panel__log"
      @scroll="onLogScroll"
      @wheel.passive="onLogWheel"
      @touchmove.passive="markUserScroll"
      @pointerdown="holdPointer"
    >
      <slot />

      <!-- «надсилаю…» — what the operator sent that the transcript does not show yet (a dormant
           agent is woken before its entry is written). Replaced by the real entry. -->
      <div v-for="msg in outgoing" :key="msg.id" class="k-panel__outgoing" aria-live="polite">
        <div class="k-panel__outgoing-text mono">{{ msg.text }}</div>
        <div v-if="msg.images.length" class="k-panel__outgoing-meta mono">
          {{ t('kit.panel.outgoingImages', { count: msg.images.length }) }}
        </div>
        <div class="k-panel__outgoing-meta mono">
          <KSpinner :size="10" />
          {{ t('kit.panel.sending') }}
        </div>
      </div>

      <!-- decision block — the ONE accent block-strip in the log -->
      <div v-if="req" class="k-panel__decision">
        <div class="k-panel__decision-head mono">{{ t('kit.panel.decisionNeeded') }}</div>
        <div v-if="req.title" class="k-panel__decision-title">{{ req.title }}</div>
        <div v-if="req.message" class="k-panel__decision-msg">{{ req.message }}</div>

        <!-- confirm -->
        <div v-if="req.method === 'confirm'" class="k-panel__decision-row">
          <KBtn variant="primary" :loading="answering" @click="answerConfirm(true)">{{ t('kit.panel.yes') }}</KBtn>
          <KBtn variant="secondary" :disabled="answering" @click="answerConfirm(false)">{{ t('kit.panel.no') }}</KBtn>
        </div>

        <!-- select -->
        <div v-else-if="req.method === 'select'" class="k-panel__decision-options">
          <button
            v-for="(opt, i) in req.options ?? []"
            :key="i"
            class="k-panel__option mono"
            type="button"
            :disabled="answering"
            @click="answerValue(opt)"
          >{{ i + 1 }} — {{ opt }}</button>
        </div>

        <!-- input -->
        <form
          v-else-if="req.method === 'input'"
          class="k-panel__decision-form"
          @submit.prevent="answerValue(decisionText)"
        >
          <input
            v-model="decisionText"
            class="k-panel__decision-input mono"
            :placeholder="req.placeholder ?? ''"
          />
          <KBtn variant="primary" type="submit" :loading="answering">{{ t('kit.panel.submit') }}</KBtn>
        </form>

        <!-- editor -->
        <form
          v-else-if="req.method === 'editor'"
          class="k-panel__decision-form k-panel__decision-form--editor"
          @submit.prevent="answerValue(decisionText)"
        >
          <textarea
            v-model="decisionText"
            class="k-panel__decision-editor mono"
            rows="4"
            :placeholder="req.placeholder ?? ''"
          />
          <KBtn variant="primary" type="submit" :loading="answering">{{ t('kit.panel.submit') }}</KBtn>
        </form>

        <div class="k-panel__decision-cancel">
          <KBtn variant="ghost" :disabled="answering" @click="answerCancel">{{ t('kit.panel.cancel') }}</KBtn>
        </div>
      </div>

      <!-- error banner — the omp child exited before finishing; surface the reason. A child
           that died of a signed-out provider names the login command instead of its raw text. -->
      <div v-if="session.status === 'error'" class="k-panel__error" role="alert">
        <div class="k-panel__error-head mono">{{ signIn ? t('kit.panel.signInHead') : t('kit.panel.error') }}</div>
        <div class="k-panel__error-msg">{{ signIn ? t(`notices.${session.errorCode}`) : session.error || t('kit.panel.sessionErrored') }}</div>
      </div>

      <!-- live activity — a pinned, pulsing heartbeat so a long turn (thinking or a
           minutes-long tool call) never looks dead -->
      <div v-if="stalled" class="k-panel__stall" role="alert">
        <span class="k-panel__stall-msg">{{ t('kit.panel.stalled', { label: silentLabel }) }}</span>
        <button
          type="button"
          class="k-panel__stall-btn"
          :disabled="restarting"
          :aria-busy="restarting || undefined"
          @click="emit('restart')"
        ><KSpinner v-if="restarting" :size="10" /> {{ t('kit.panel.restart') }}</button>
      </div>
      <div v-else-if="liveActivity" class="k-panel__thinking" aria-live="polite">{{ liveActivity }}</div>
    </div>

    <!-- plan lane — present only while the agent keeps a todo list -->
    <KTodoLane v-if="session.todoPhases?.length && session.runtime !== 'claude-code'" :phases="session.todoPhases" />

    <!-- live lane — what the agent is doing right now; absent while idle. Everything
         countable (model, effort, isolation, context, spend) is printed once, in the
         composer's chip row below. -->
    <KStatusRow :session="session" />

    <!-- floor 3 — composer: attachment strip + input row (paste / drop / 📎), with the
         session-level actions (rehydrate, summarise) parked on its right edge -->
    <div v-if="!isMerged" class="k-panel__composer">
      <KComposer
        ref="composerEl"
        v-model="draft"
        :placeholder="placeholder"
        :disabled="composerDisabled"
        :model="modelOverride ?? session.model"
        :models="models"
        :effort="effortOverride ?? session.effort"
        :model-loading="modelLoading"
        :effort-loading="effortLoading"
        :worktree="session.worktree"
        :context="session.contextPercent"
        :usage="session.usage"
        @send="(text, images) => emit('send', text, images)"
        @effort="(level) => emit('effort', level)"
        @set-model="(p) => emit('setModel', p)"
      >
        <template #actions>
          <KIconButton
            :loading="refreshing"
            :title="t('kit.panel.refreshTip')"
            @click="emit('refresh')"
          >↻</KIconButton>
          <KIconButton
            :loading="summarizing"
            :disabled="running"
            :title="running
              ? t('kit.panel.summaryBusyTip')
              : t('kit.panel.summaryTip')"
            @click="emit('summary')"
          >≡</KIconButton>
        </template>
      </KComposer>
    </div>
    <div v-else class="k-panel__composer k-panel__merged-note mono">
      {{ t('kit.panel.mergedNote') }}
    </div>

    <!-- floating "+ Задача" — appears over a text selection in the log -->
    <button
      v-if="selBtn"
      type="button"
      class="k-panel__sel-task"
      :style="{ left: selBtn.x + 'px', top: selBtn.y + 'px' }"
      v-tip="t('kit.panel.newTaskTip')"
      @mousedown.prevent.stop="emitNewTask"
    >{{ t('kit.panel.newTask') }}</button>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session, RpcExtensionUIResponse, ImageInput, ModelOption, ThinkingLevel } from '@kermanych/core';
import KStatusDot from './KStatusDot.vue';
import KTag from './KTag.vue';
import KBtn from './KBtn.vue';
import KComposer from './KComposer.vue';
import KTodoLane from './KTodoLane.vue';
import KStatusRow from './KStatusRow.vue';
import KIconButton from './KIconButton.vue';
import KSpinner from './KSpinner.vue';
import { useNow } from '../../composables/useNow';
import { followAfterScroll } from '../../lib/log-follow';
import { slotWaitLabel } from '../../lib/slot-wait';
import type { OutgoingMessage } from '../../lib/outgoing';
import { needsSignIn } from '../../lib/session-auth';

const { t } = useI18n();

// The application atom (design-system section 05): three floors — header, log,
// input — stacked with no gaps (panels dock via 2px rules). The active panel
// (a running agent) takes surface2 and a 2px accent strip on its top edge.
const props = withDefaults(
  defineProps<{
    session: Session;
    placeholder?: string;
    // Busy props (README «Design → Async states»): each turns its control into the kit spinner
    // and blocks it, so the click is answered at once and a second one cannot race the first.
    // The chat is being turned into an agent (worktree + omp respawn) — ▶.
    promoting?: boolean;
    // The session is being rehydrated (omp respawn + history reload) — the composer's ↻.
    refreshing?: boolean;
    // «В беклог» files a cloud card — ⊕.
    filing?: boolean;
    // The chat is being discarded and re-created — ✕.
    clearing?: boolean;
    // A fork is being created — ⑂; stays until the child session appears.
    branching?: boolean;
    // A stop is in flight — ■; stays until the status is no longer running.
    stopping?: boolean;
    // A stalled agent is being restarted — the stall banner's «Перезапустити».
    restarting?: boolean;
    // An answer to the decision block is being delivered — its buttons.
    answering?: boolean;
    // «≡ Підсумок» is being sent — ≡.
    summarizing?: boolean;
    // The editor is being spawned — ⧉.
    openingEditor?: boolean;
    // The session itself is pending a result (deleted, archived, reopened…; stores/pending):
    // every session action here is blocked until it settles.
    pending?: boolean;
    // Sent messages the transcript does not show yet — the «надсилаю…» bubbles.
    outgoing?: readonly OutgoingMessage[];
    // A model / effort pick being saved (useOptimisticValue): the chip shows the picked value
    // and spins until the session reports it.
    modelOverride?: string | undefined;
    effortOverride?: ThinkingLevel | undefined;
    modelLoading?: boolean;
    effortLoading?: boolean;
    // The log is not loaded yet: sending would land in a transcript the operator cannot see.
    composerDisabled?: boolean;
    // The omp model catalog, forwarded to the composer's model chip so it can offer a picker.
    models?: readonly ModelOption[] | undefined;
    // Suppresses this panel's own header + density toolbar. The agent detail column
    // (AgentsPage) owns one consolidated header — identity, status, actions, expand/collapse —
    // above its tabs, so the embedded panel would only stack a second, redundant one.
    bare?: boolean;
  }>(),
  {
    promoting: false,
    refreshing: false,
    filing: false,
    clearing: false,
    branching: false,
    stopping: false,
    restarting: false,
    answering: false,
    summarizing: false,
    openingEditor: false,
    pending: false,
    outgoing: () => [],
    modelLoading: false,
    effortLoading: false,
    composerDisabled: false,
    models: () => [],
    bare: false,
  },
);

// `finish`, `reopen` and `delete` are NOT declared here: завершити / відновити / видалити are
// session-level actions that live in the agent's top nav (AgentsPage `.agents__detail-bar`),
// reachable from every tab; a second copy in this header stacked the same ✓/✕ two rows apart.
const emit = defineEmits<{
  stop: [];
  send: [text: string, images: ImageInput[]];
  answer: [res: RpcExtensionUIResponse];
  editor: [];
  branch: [];
  restart: [];
  refresh: [];
  summary: [];
  newTask: [text: string];
  promoteAgent: [];
  promoteTask: [];
  clear: [];
  expandAll: [value: boolean];
  effort: [level: ThinkingLevel];
  setModel: [patch: { model: string; provider?: string }];
}>();

const draft = ref('');
const composerEl = ref<InstanceType<typeof KComposer> | null>(null);

// A send that failed hands its text and images back here, so nothing typed is lost. Only
// into an empty composer: if the operator has started a new message, theirs wins and the
// failed one stays in the error toast.
function restoreDraft(text: string, images: readonly ImageInput[]): void {
  if (draft.value.trim()) return;
  draft.value = text;
  composerEl.value?.restoreImages(images);
}
defineExpose({ restoreDraft });
const decisionText = ref('');

// Auto-scroll: keep the log pinned to the newest entry while the user is at the
// bottom; if they scroll up to read history, stop following until they return.
// Only the operator's own scrolling may stop it — see lib/log-follow.ts.
const logEl = ref<HTMLElement | null>(null);
let stick = true;
let lastTop = 0;
let logObserver: MutationObserver | undefined;
// The operator is scrolling: a wheel / touch / scroll key within the last USER_SCROLL_MS
// (covers a smooth-scroll animation and trackpad momentum), or a pointer held on the log
// (scrollbar drag, drag-selecting past the edge).
const USER_SCROLL_MS = 600;
let userScrollUntil = 0;
let pointerHeld = false;
function markUserScroll(): void {
  userScrollUntil = performance.now() + USER_SCROLL_MS;
}
function holdPointer(): void {
  pointerHeld = true;
}
function releasePointer(): void {
  pointerHeld = false;
}
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
function onKeyScroll(e: KeyboardEvent): void {
  if (!SCROLL_KEYS.has(e.key)) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  markUserScroll();
}
function scrollToBottom(): void {
  const el = logEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}
function onLogScroll(): void {
  const el = logEl.value;
  if (el) {
    const top = el.scrollTop;
    stick = followAfterScroll({
      follow: stick,
      prevTop: lastTop,
      top,
      gap: el.scrollHeight - top - el.clientHeight,
      byUser: pointerHeld || performance.now() < userScrollUntil,
    });
    lastTop = top;
  }
  hideSelectionButton();
}
// A wheel up stops the follow before the log has moved, so a pending scrollToBottom cannot
// snap it back mid-animation. Not when a scroller inside the log (a diff, a long tool
// output) is the one taking the wheel.
function onLogWheel(e: WheelEvent): void {
  markUserScroll();
  const el = logEl.value;
  if (!el || e.deltaY >= 0 || el.scrollTop <= 0) return;
  for (let n = e.target as HTMLElement | null; n && n !== el; n = n.parentElement) {
    if (n.scrollTop > 0) return;
  }
  stick = false;
}

// ── "+ Задача" from a text selection in the log ────────────────────────────
// Selecting any text inside the transcript surfaces a floating button that turns
// the selection into a new backlog task. The text is captured when the button
// appears (not on click), and the button uses mousedown.prevent so pressing it
// never collapses the selection first.
const selBtn = ref<{ x: number; y: number; text: string } | null>(null);
function updateSelectionButton(): void {
  const log = logEl.value;
  const sel = window.getSelection();
  if (!log || !sel || sel.rangeCount === 0 || sel.isCollapsed) {
    selBtn.value = null;
    return;
  }
  const text = sel.toString().trim();
  if (!text || !log.contains(sel.anchorNode) || !log.contains(sel.focusNode)) {
    selBtn.value = null;
    return;
  }
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  selBtn.value = { x: rect.left + rect.width / 2, y: rect.top, text };
}
function hideSelectionButton(): void {
  selBtn.value = null;
}
function emitNewTask(): void {
  const text = selBtn.value?.text;
  hideSelectionButton();
  window.getSelection()?.removeAllRanges();
  if (text) emit('newTask', text);
}

// My-message navigation: step between the operator's own messages. Since the log is
// grouped into request blocks, the operator's message IS the block header
// (`.k-rb__head` in KRequestBlock) — that is the element we count, scroll to and
// flash. Count is kept in sync with the log via the existing MutationObserver.
const rootEl = ref<HTMLElement | null>(null);
const userMsgCount = ref(0);
const userIndex = ref(-1); // last message we jumped to; -1 = derive from scroll

function userEls(): HTMLElement[] {
  const el = logEl.value;
  return el ? Array.from(el.querySelectorAll<HTMLElement>('.k-rb__head')) : [];
}
function refreshUserCount(): void {
  userMsgCount.value = userEls().length;
}
// Before the first jump the stepper sits on the first message, so it reads 1/N — a
// "–/N" would suggest the panel had lost its place.
const userNavLabel = computed(
  () => `${userIndex.value < 0 ? 1 : userIndex.value + 1}/${userMsgCount.value}`,
);
// Index of the last user message whose top is at/above the log viewport top.
function currentUserIdx(els: HTMLElement[]): number {
  const log = logEl.value;
  if (!log) return 0;
  const logTop = log.getBoundingClientRect().top;
  let idx = 0;
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    if (el && el.getBoundingClientRect().top - logTop <= 4) idx = i;
    else break;
  }
  return idx;
}
function jumpUser(dir: 1 | -1): void {
  const els = userEls();
  if (!els.length) return;
  const base = userIndex.value >= 0 && userIndex.value < els.length ? userIndex.value : currentUserIdx(els);
  const idx = Math.min(els.length - 1, Math.max(0, base + dir));
  userIndex.value = idx;
  const target = els[idx];
  if (!target) return;
  stick = false; // stop auto-follow while the operator browses history
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  target.classList.remove('k-log--flash');
  void target.offsetWidth; // reflow so the animation restarts on re-jump
  target.classList.add('k-log--flash');
}
function onNavKeydown(e: KeyboardEvent): void {
  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  if (!rootEl.value?.contains(e.target as Node)) return; // only when this panel is focused
  if (userMsgCount.value <= 1) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  e.preventDefault();
  jumpUser(e.key === 'ArrowUp' ? -1 : 1);
}
onMounted(() => {
  const el = logEl.value;
  if (!el) return;
  scrollToBottom();
  refreshUserCount();
  logObserver = new MutationObserver(() => {
    refreshUserCount();
    // Re-checked in the frame: the operator may have scrolled up since this was queued.
    if (stick) requestAnimationFrame(() => {
      if (stick) scrollToBottom();
    });
  });
  logObserver.observe(el, { childList: true, subtree: true });
  window.addEventListener('keydown', onNavKeydown);
  window.addEventListener('keydown', onKeyScroll);
  window.addEventListener('pointerup', releasePointer);
  window.addEventListener('pointercancel', releasePointer);
  document.addEventListener('mouseup', updateSelectionButton);
  document.addEventListener('mousedown', hideSelectionButton);
});
onBeforeUnmount(() => {
  logObserver?.disconnect();
  window.removeEventListener('keydown', onNavKeydown);
  window.removeEventListener('keydown', onKeyScroll);
  window.removeEventListener('pointerup', releasePointer);
  window.removeEventListener('pointercancel', releasePointer);
  document.removeEventListener('mouseup', updateSelectionButton);
  document.removeEventListener('mousedown', hideSelectionButton);
});
// Session switch → jump to the newest entry of the newly selected session.
watch(
  () => props.session.id,
  () => {
    stick = true;
    userIndex.value = -1;
    hideSelectionButton();
    void nextTick(() => {
      scrollToBottom();
      refreshUserCount();
    });
  },
);

const req = computed(() => props.session.pendingUiRequest);

const running = computed(
  () => props.session.status === 'thinking' || props.session.status === 'tool',
);
// active — a running agent lights the top strip; matches KStatusDot's running kind.
const isActive = computed(() => running.value);
const isMerged = computed(() => props.session.status === 'merged');
const signIn = computed(() => props.session.status === 'error' && needsSignIn(props.session.errorCode));

const statusLabel = computed(() => {
  switch (props.session.status) {
    case 'thinking':
      return props.session.currentTool ?? t('kit.panel.status.working');
    case 'tool':
      return props.session.currentTool ?? t('kit.panel.status.running');
    case 'waiting_input':
      return t('kit.panel.status.waiting');
    case 'done':
      return t('kit.panel.status.done');
    case 'in_review':
      return t('kit.panel.status.review');
    case 'error':
      return signIn.value ? t('kit.panel.status.signIn') : t('kit.panel.status.error');
    case 'queued':
      return t('kit.panel.status.queued');
    case 'stopped':
      return t('kit.panel.status.stopped');
    case 'merged':
      return t('kit.panel.status.merged');
    case 'conflict':
      return t('kit.panel.status.conflict');
    default:
      return props.session.status;
  }
});

// A pinned "what's happening now" line under the log. `thinking` has no committed entry
// yet, and a tool call can run for minutes (e.g. dispatching a subagent), so without it
// the chat looks dead between messages. Mirrors the omp terminal's live status.
const liveActivity = computed(() => {
  switch (props.session.status) {
    case 'queued':
      return slotWaitLabel(props.session, t) ?? t('kit.panel.live.launching');
    case 'thinking':
      return t('kit.panel.live.thinking');
    case 'tool':
      return props.session.currentTool ? t('kit.panel.live.runningTool', { tool: props.session.currentTool }) : t('kit.panel.live.running');
    default:
      return '';
  }
});

// Stall detection: a running turn that has emitted no omp event for a while is likely
// wedged (e.g. a provider request hung with no internal timeout). lastEventAt is bumped on
// every omp event but NOT on user sends, so it isolates real agent progress from nudges.
const now = useNow(5000);
const STALL_MS = 60_000;
const silentMs = computed(() =>
  running.value && props.session.lastEventAt ? Math.max(0, now.value - props.session.lastEventAt) : 0,
);
const stalled = computed(() => silentMs.value >= STALL_MS);
// NOT the shared `dur()`, and deliberately so: this label only renders once `stalled` is
// true, so a sub-second value is unreachable and a floor marker would be dead code, and it
// holds seconds until 90 rather than 60 because `89 с` reads as a sharper stall figure than
// a rounded `1 хв` at the moment the operator is deciding whether the turn is wedged.
// Do not fold it into the shared formatter.
const silentLabel = computed(() => {
  const s = Math.round(silentMs.value / 1000);
  return s >= 90 ? t('kit.panel.unit.min', { n: Math.round(s / 60) }) : t('kit.panel.unit.sec', { n: s });
});

function answerConfirm(confirmed: boolean) {
  if (!req.value) return;
  emit('answer', { type: 'extension_ui_response', id: req.value.id, confirmed });
}

function answerValue(value: string) {
  if (!req.value) return;
  emit('answer', { type: 'extension_ui_response', id: req.value.id, value });
  decisionText.value = '';
}

function answerCancel() {
  if (!req.value) return;
  emit('answer', { type: 'extension_ui_response', id: req.value.id, cancelled: true });
}
</script>

<style scoped lang="scss">
.k-panel {
  display: flex;
  flex-direction: column;
  background: var(--k-surface);
  border: 1px solid var(--k-line-strong);
  min-height: 320px;
  position: relative;
  border-radius: var(--k-r-lg);
  overflow: hidden;
}

// detail toolbar — a fixed-height strip under the header; the nav stepper is pinned
// below it, so its height is declared rather than left to the content.
.k-panel__tools {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 26px;
  padding: 0 12px;
  box-shadow: inset 0 -1px 0 0 var(--k-line); // a rule that costs no layout height
  font-size: 11px;
  color: var(--k-muted);
}
.k-panel__tools-btn {
  padding: 0;
  background: transparent;
  border: none;
  color: var(--k-muted);
  font: inherit;
  cursor: pointer;
  transition: color 0.12s;
}
.k-panel__tools-btn:hover { color: var(--k-text); }
.k-panel__tools-btn:focus-visible { outline: 1px solid var(--k-accent); outline-offset: 2px; }

// my-message nav — floating stepper pinned to the log's top-right, over the log
// (outside the scroll container so it stays put while the log scrolls). Its right edge is
// the column's 12px gutter, so it stops where the transcript under it stops.
.k-panel__nav {
  position: absolute;
  top: 68px; // header (34px) + tools (26px) + 8px
  right: 12px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 4px 3px;
  background: color-mix(in srgb, var(--k-surface2) 88%, transparent);
  border: 1px solid var(--k-line-strong);
}
.k-panel__nav-btn {
  width: 22px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--k-muted);
  // Glyph-only pager control — an icon size, matched to the 22x20 box.
  font-size: var(--k-icon-sm);
  cursor: pointer;
  transition: color 0.12s;
}
.k-panel__nav-btn:hover { color: var(--k-text); }
.k-panel__nav-btn:focus-visible { outline: 1px solid var(--k-accent); outline-offset: -1px; }
.k-panel__nav-count {
  font-size: 10px;
  color: var(--k-muted);
  user-select: none;
}

// active — surface2 fill + 2px accent strip on the top edge.
.k-panel--active {
  background: var(--k-surface2);

  .k-panel__header {
    box-shadow: inset 0 2px 0 0 var(--k-accent);
    background: var(--k-surface2);
  }
}

// floor 1 — header
.k-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  // Only bites at the narrow end, where `space-between` has no free space left to give:
  // it keeps the ellipsised branch tag from sitting flush against the status word.
  gap: 8px;
  height: 34px;
  // The 2px of top padding is the counterweight to the 2px rule below, which `height`
  // (border-box) takes out of the interior: without it `align-items: center` centres this
  // row's dot, harness, tag and controls in the 32px above the rule and the floor reads
  // 1px high. It also lands the content exactly between this header's two 2px edges while
  // a session is active, when the accent strip is inset over the top one.
  padding: 2px 6px 0 12px;
  background: var(--k-surface);
  border-bottom: 2px solid var(--k-line-strong);
  flex: none;
}

.k-panel__id {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

// At the 360px panel minimum the branch tag and the status word overlapped: `.k-panel__id`
// shrinks, but its tag child did not, so `space-between` drove the tag straight through
// `.k-panel__controls`. The tag is the one box here with a droppable tail — a branch name is
// recognisable from its head — so it ellipsises and the controls keep their width.
// `display: block` (not the tag's own inline-flex) is what makes `text-overflow` apply:
// a flex container wraps its text in an anonymous item and never renders the ellipsis.
.k-panel__id .k-tag {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.k-panel__harness {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--k-text);
  white-space: nowrap;
}

.k-panel__controls {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}

.k-panel__status {
  font-size: 11px;
  color: var(--k-muted);
  margin-right: 6px;
  white-space: nowrap;
}

// floor 2 — log. Horizontally on the panel's 12px gutter, the same one the header above
// and the status row and composer below use, so the transcript's left edge is the column's
// left edge; the vertical figures are free to differ — they are breathing room, not a
// gutter.
.k-panel__log {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 14px 12px 16px;
}

// live reasoning placeholder — muted, gently pulsing; replaced by the collapsed
// reasoning block + answer at message_end.
.k-panel__thinking {
  margin-top: 14px;
  font-family: var(--k-font-ui);
  font-size: 13px;
  font-style: italic;
  color: var(--k-muted);
  animation: k-panel-think-pulse 1.4s ease-in-out infinite;
}
@keyframes k-panel-think-pulse {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}

// stall — a running turn went silent; warn + offer a one-click respawn (stop + resume).
.k-panel__stall {
  margin-top: 14px;
  display: flex;
  align-items: center;
  gap: 12px;
  font-family: var(--k-font-ui);
  font-size: 13px;
}
.k-panel__stall-msg { color: var(--k-accent); }
.k-panel__stall-btn {
  flex: none;
  border: 1px solid var(--k-accent);
  background: transparent;
  color: var(--k-accent);
  font-family: var(--k-font-mono);
  font-size: 12px;
  padding: 3px 10px;
  cursor: pointer;
}
.k-panel__stall-btn:hover:not(:disabled) { background: var(--k-accent); color: var(--k-on-accent); }
.k-panel__stall-btn:disabled { cursor: progress; opacity: 0.8; }

// «надсилаю…» — the operator's own message, muted until the transcript confirms it.
.k-panel__outgoing {
  margin-top: 14px;
  padding: var(--k-sp-2) var(--k-sp-3);
  border-left: 2px solid var(--k-line-strong);
  opacity: 0.6;
}
.k-panel__outgoing-text {
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
}
.k-panel__outgoing-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

// error — the omp child exited before finishing; full accent border reads as failure.
.k-panel__error {
  margin-top: 14px;
  padding: 12px 14px 14px;
  background: var(--k-surface);
  border: 1px solid var(--k-accent);
  border-left: 2px solid var(--k-accent);
}
.k-panel__error-head {
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--k-accent);
  margin-bottom: 8px;
}
.k-panel__error-msg {
  font-family: var(--k-font-mono);
  font-size: 12px;
  line-height: 1.55;
  color: var(--k-text);
  white-space: pre-wrap;
  word-break: break-word;
}

// decision — accent left strip, the only accent block in the log.
.k-panel__decision {
  margin-top: 14px;
  padding: 12px 14px 14px;
  background: var(--k-surface);
  border: 1px solid var(--k-line-strong);
  border-left: 2px solid var(--k-accent);
}

.k-panel__decision-head {
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--k-accent);
  margin-bottom: 10px;
}

.k-panel__decision-title {
  font-family: var(--k-font-ui);
  font-size: 14px;
  color: var(--k-text);
  margin-bottom: 4px;
}

.k-panel__decision-msg {
  font-family: var(--k-font-ui);
  font-size: 13px;
  line-height: 1.6;
  color: var(--k-muted);
  margin-bottom: 12px;
}

.k-panel__decision-row {
  display: flex;
  gap: 10px;
}

.k-panel__decision-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.k-panel__option {
  display: flex;
  align-items: center;
  text-align: left;
  font-size: 12px;
  color: var(--k-text);
  background: transparent;
  border: 1px solid var(--k-line-strong);
  padding: 8px 12px;
  cursor: pointer;
  border-radius: var(--k-r);
  transition: border-color 0.12s, background 0.12s;

  &:hover {
    border-color: var(--k-text);
    background: var(--k-surface2);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

.k-panel__decision-form {
  display: flex;
  gap: 10px;
  align-items: stretch;

  &--editor {
    flex-direction: column;
    align-items: flex-start;
  }
}

.k-panel__decision-input,
.k-panel__decision-editor {
  flex: 1 1 auto;
  font-size: 12.5px;
  color: var(--k-text);
  background: var(--k-bg);
  border: 1px solid var(--k-line-strong);
  padding: 8px 11px;
  border-radius: var(--k-r);
  outline: none;

  &::placeholder {
    color: var(--k-muted);
  }

  &:focus {
    border-color: var(--k-accent);
  }
}

.k-panel__decision-editor {
  width: 100%;
  resize: vertical;
  line-height: 1.5;
}

.k-panel__decision-cancel {
  margin-top: 10px;
}

.k-panel__merged-note {
  padding: 14px 12px;
  color: var(--k-muted);
  font-size: 12.5px;
  line-height: 1.5;
}

// floating "+ Задача" over a text selection — accent chip, fixed so it escapes
// the log's scroll clipping; centered just above the selection.
.k-panel__sel-task {
  position: fixed;
  z-index: 50;
  transform: translate(-50%, calc(-100% - 6px));
  white-space: nowrap;
  user-select: none;
  border: 1px solid var(--k-accent);
  background: var(--k-bg);
  color: var(--k-accent);
  font-family: var(--k-font-mono);
  font-size: 12px;
  line-height: 1;
  padding: 5px 10px;
  cursor: pointer;
  box-shadow: var(--k-shadow-pop);
}
.k-panel__sel-task:hover { background: var(--k-accent); color: var(--k-on-accent); }
</style>
