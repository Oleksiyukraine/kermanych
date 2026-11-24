<script setup lang="ts">
// One session on the phone (decision 3): the live conversation, the agent's question, the
// composer, «Зупинити». Native sessions (decision 8): status, conversation, a message when idle,
// stop — a question is answered only on the computer, which the dock says instead of the form.
import { computed, nextTick, onMounted, ref, watch } from "vue";
// Values from core's own modules, not the barrel: the barrel drags the whole CJS core (prompts,
// parsers) into the phone bundle.
import { ACTIVE_STATUSES, INTERACTIVE_UI_METHODS } from "@kermanych/core/status";
import { useAction, useLoadPhase, usePending } from "../lib/async";
import { statusText, t } from "../lib/i18n";
import { goList } from "../lib/route";
import { actions, loadTranscript, state } from "../lib/store";
import ConnectionBanner from "./ConnectionBanner.vue";
import KButton from "./KButton.vue";
import MessageComposer from "./MessageComposer.vue";
import QuestionForm from "./QuestionForm.vue";
import StatusDot from "./StatusDot.vue";
import TranscriptView from "./TranscriptView.vue";

const props = defineProps<{ id: string }>();

const session = computed(() => state.sessions?.get(props.id));
/** The list arrived and this session is not in it: finished, archived or deleted meanwhile. */
const removed = computed(() => state.sessions !== undefined && !session.value);
const entries = computed(() => state.transcripts.get(props.id));

const { run: load, busy: loading, error: loadError } = useAction(() => loadTranscript(props.id));
const phase = useLoadPhase(() => entries.value === undefined && !loadError.value);
onMounted(() => void load());

const active = computed(() => !!session.value && ACTIVE_STATUSES.includes(session.value.status));
const question = computed(() => {
  const s = session.value;
  const req = s?.pendingUiRequest;
  return s && s.status === "waiting_input" && !s.native && req && INTERACTIVE_UI_METHODS[req.method] ? req : undefined;
});
const nativeAsks = computed(() => session.value?.native === true && session.value.status === "waiting_input");

// ── Stop, with a confirm; pending until the session's update shows it stopped ──
const confirming = ref(false);
const stopping = usePending();
const { run: stop, busy: stopBusy, error: stopError } = useAction(async () => {
  await actions.stop(props.id);
  confirming.value = false;
  stopping.mark(props.id);
});
watch(active, (on) => {
  if (!on) stopping.settle(props.id);
});
const stopLoading = computed(() => stopBusy.value || stopping.has(props.id));

// ── Auto-scroll: follow the end unless the operator scrolled up to read ──
const scroller = ref<HTMLElement>();
const stick = ref(true);
const STICK_SLACK_PX = 80;

function onScroll(): void {
  const el = scroller.value;
  if (el) stick.value = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLACK_PX;
}

function toEnd(smooth = false): void {
  const el = scroller.value;
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

// The last entry's length too: a streaming reply grows in place under the same id.
watch(
  () => {
    const list = entries.value;
    const last = list?.[list.length - 1];
    return [list?.length, last && "text" in last ? last.text.length : 0, question.value?.id];
  },
  async () => {
    if (!stick.value) return;
    await nextTick();
    toEnd();
  },
  { flush: "post" },
);
</script>

<template>
  <div class="session">
    <header class="topbar">
      <KButton variant="ghost" class="session__back" :aria-label="t('session.back')" @click="goList()">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </KButton>
      <div class="session__head">
        <span class="session__name">{{ session?.name ?? "" }}</span>
        <span v-if="session" class="session__status">
          <StatusDot :status="session.status" />
          {{ statusText(session.status) }}
          <span v-if="session.native" class="muted">· {{ t("session.native") }}</span>
        </span>
      </div>
      <KButton v-if="active" variant="danger" :loading="stopLoading" @click="confirming = true">{{ t("session.stop") }}</KButton>
    </header>
    <ConnectionBanner />

    <main ref="scroller" class="session__log pad-x" @scroll.passive="onScroll">
      <p v-if="removed" class="session__note">{{ t("session.removed") }}</p>
      <div v-if="phase === 'skeleton'" class="session__skeleton" aria-hidden="true">
        <div class="skeleton" style="height: 18px; width: 70%" />
        <div class="skeleton" style="height: 18px; width: 90%" />
        <div class="skeleton" style="height: 18px; width: 55%" />
        <div class="skeleton" style="height: 44px; width: 60%; align-self: flex-end" />
      </div>
      <div v-else-if="loadError && entries === undefined" class="session__load-error">
        <p class="error-text" role="alert">{{ loadError }}</p>
        <KButton :loading="loading" @click="load()">{{ t("banner.retry") }}</KButton>
      </div>
      <template v-else-if="entries">
        <p v-if="entries.length === 0" class="session__note muted">{{ t("session.emptyLog") }}</p>
        <TranscriptView :entries="entries" />
      </template>
    </main>

    <button v-if="!stick && entries?.length" type="button" class="session__jump" @click="toEnd(true)">
      ↓ {{ t("session.jumpEnd") }}
    </button>

    <footer v-if="session" class="session__dock pad-x">
      <QuestionForm v-if="question" :key="question.id" :session-id="id" :request="question" />
      <p v-else-if="nativeAsks" class="session__native">{{ t("question.native") }}</p>
      <MessageComposer :session-id="id" />
    </footer>

    <div v-if="confirming" class="sheet" @click.self="!stopBusy && (confirming = false)">
      <div class="sheet__body pad-x" role="dialog" aria-modal="true" :aria-label="t('session.stopConfirm')">
        <h2 class="sheet__title">{{ t("session.stopConfirm") }}</h2>
        <p class="muted">{{ t("session.stopConfirmHint") }}</p>
        <p v-if="stopError" class="error-text" role="alert">{{ stopError }}</p>
        <KButton variant="primary" block :loading="stopBusy" @click="stop()">{{ t("session.stopYes") }}</KButton>
        <KButton block :disabled="stopBusy" @click="confirming = false">{{ t("session.stopNo") }}</KButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* One screen-high column: the log scrolls between the fixed top bar and the dock. */
.session {
  position: relative;
  height: 100dvh;
  display: flex;
  flex-direction: column;
}
.session__back {
  margin-left: calc(-1 * var(--k-sp-2));
  padding: 0;
}
.session__head {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.session__name {
  font-weight: var(--k-fw-semibold);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session__status {
  display: flex;
  align-items: center;
  gap: var(--k-sp-1);
  font-size: var(--k-fs-sm);
  white-space: nowrap;
}
.session__log {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding-top: var(--k-sp-4);
  padding-bottom: var(--k-sp-4);
}
.session__note {
  margin: 0 0 var(--k-sp-3);
  text-align: center;
  font-size: var(--k-fs-base);
}
.session__skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}
.session__load-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--k-sp-3);
  padding: var(--k-sp-6) 0;
  text-align: center;
}
.session__jump {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(120px + env(safe-area-inset-bottom));
  min-height: 36px;
  padding: 0 var(--k-sp-4);
  border-radius: var(--k-r-pill);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  background: var(--k-surface2);
  box-shadow: var(--k-shadow-pop);
  font-size: var(--k-fs-sm);
  cursor: pointer;
}
.session__dock {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding-top: var(--k-sp-2);
  padding-bottom: calc(var(--k-sp-2) + env(safe-area-inset-bottom));
  border-top: var(--k-rule-thin) solid var(--k-line);
  background: var(--k-bg);
}
.session__native {
  margin: 0;
  padding: var(--k-sp-3);
  border-radius: var(--k-r);
  background: color-mix(in srgb, var(--k-accent) 12%, var(--k-surface));
  font-size: var(--k-fs-base);
}
.sheet {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: flex-end;
  background: rgba(0, 0, 0, 0.5);
}
.sheet__body {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding-top: var(--k-sp-5);
  padding-bottom: calc(var(--k-sp-4) + env(safe-area-inset-bottom));
  border-radius: var(--k-r-lg) var(--k-r-lg) 0 0;
  background: var(--k-surface);
  box-shadow: var(--k-shadow-modal);
}
.sheet__title {
  margin: 0;
  font-size: var(--k-fs-lg);
  font-weight: var(--k-fw-semibold);
}
.sheet__body p {
  margin: 0 0 var(--k-sp-2);
}
</style>
