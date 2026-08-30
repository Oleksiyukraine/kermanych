<template>
  <main class="mgmt">
    <div class="mgmt__atmo" aria-hidden="true"></div>

    <!-- SECTION RAIL — the tab's own nav, in the app's one nav idiom: a column of
         rows on a panel, exactly like the shell's bucket rail one column to the
         left. It used to be a horizontal strip of seven labels, which is the one
         nav shape this app uses nowhere else and which has no room for the second
         line that says what a section holds. -->
    <aside class="mgmt__rail">
      <div class="mgmt__rail-head">
        <span class="mgmt__eyebrow mono">Менеджмент</span>
        <!-- The scope, stated above the rows it applies to: every section below
             reports on this one project. Greyed out and dot-less while nothing is
             chosen, so the chip reads as an empty slot rather than a label. -->
        <span class="mgmt__chip" :class="{ 'mgmt__chip--empty': !projectId }">
          <span
            v-if="projectId"
            class="mgmt__chip-dot"
            :style="{ background: projectColor }"
            aria-hidden="true"
          ></span>
          <span class="mgmt__chip-name">{{ projectName || 'проєкт не вибрано' }}</span>
        </span>
        <p class="mgmt__rail-note">Кожен розділ звітує про цей проєкт.</p>
      </div>

      <nav class="mgmt__rail-list" aria-label="Розділи менеджменту">
        <KNavItem
          v-for="s in MANAGEMENT_SECTIONS"
          :key="s.name"
          :label="s.label"
          :hint="s.hint"
          :active="s.name === activeSection"
          :aria-current="s.name === activeSection ? 'page' : undefined"
          @click="goSection(s.name)"
        />
      </nav>
    </aside>

    <section class="mgmt__pane">
      <header class="mgmt__head">
        <h1 class="mgmt__heading">{{ sectionLabel }}</h1>
      </header>

      <!-- The selection IS the access rule: every section reports on one project, so
           with none chosen there is nothing to report on. Same invitation the
           Агенти view shows, rather than seven sections each repeating it. -->
      <div v-if="!projectId" class="mgmt__blank">
        <div class="mgmt__blank-eyebrow mono">КЕРМАНИЧ</div>
        <p class="mgmt__blank-text">
          Виберіть проєкт у лівій панелі, щоб побачити його менеджмент.
        </p>
      </div>
      <template v-else>
        <div class="mgmt__body">
          <router-view :project-id="projectId" :project-name="projectName" />
        </div>

        <!-- The Менеджмент assistant, docked to the foot of the section pane like the chat
             composer: the section's content owns the space above it, the input keeps the
             pane's bottom edge whatever the section renders. The transcript hangs ABOVE the
             pill (`bottom: 100%`) rather than pushing it, so the section never reflows as
             the conversation grows — a chat that moves the register it is describing is
             unusable. Centred rather than stretched: a capsule pulled across a 1400px
             window reads as a toolbar and puts its controls a screen away from the text they
             belong to. Frosted over the page's glow layer, which is why `.mgmt__atmo` exists
             rather than a flat canvas — glass needs a substrate to bend. -->
        <div class="mgmt__dock">
          <section
            v-if="chat.hasConversation"
            class="mgmt__log"
            aria-label="Розмова з асистентом менеджменту"
          >
            <header class="mgmt__log-head">
              <span class="mgmt__log-title mono">Асистент менеджменту</span>
              <button
                v-tip="'Новий чат'"
                class="mgmt__log-close mono"
                type="button"
                :disabled="chat.busy"
                aria-label="Закрити розмову і почати новий чат"
                @click="chat.reset()"
              >×</button>
            </header>
            <div ref="logEl" class="mgmt__log-body">
              <template v-for="e in chat.entries" :key="e.id">
                <KChatMessage v-if="e.kind === 'user'" role="user">{{ e.text }}</KChatMessage>
                <KChatMessage v-else-if="e.kind === 'assistant'" role="assistant">
                  <div class="k-log__markdown" v-html="renderMarkdown(e.text)"></div>
                </KChatMessage>
                <!-- What the APP did about the turn, not what the model said about it. Mono
                     and colour-coded because a refusal that reads like prose gets skimmed as
                     part of the answer — and stating WHY a section cannot be changed is the
                     feature here, not an aside. -->
                <p v-else class="mgmt__res mono" :class="`mgmt__res--${e.level}`">{{ e.text }}</p>
              </template>
              <!-- The turn in flight. A management turn can grep three repositories before
                   it answers (the api allows four minutes), so the wait needs a heartbeat:
                   without one the chat looks dead and the operator sends the question again.
                   Same «Думаю…» idiom as the agent panel, with the seconds counting up
                   because a static label held for two minutes reads as a hang. -->
              <p v-if="chat.busy" class="mgmt__think" aria-live="polite">{{ thinkingLabel }}</p>
            </div>
          </section>

          <form
            class="mgmt__composer"
            :class="{ 'mgmt__composer--grown': grown }"
            aria-label="Асистент менеджменту"
            @submit.prevent="submit"
          >
            <button
              v-tip="'Новий чат'"
              class="mgmt__c-icon"
              type="button"
              :disabled="!chat.hasConversation || chat.busy"
              aria-label="Новий чат"
              @click="chat.reset()"
            >⊞</button>
            <textarea
              ref="fieldEl"
              v-model="draft"
              class="mgmt__c-input"
              rows="1"
              :disabled="chat.busy"
              placeholder="Запитайте про менеджмент цього воркспейсу — ризики, статуси, рішення"
              aria-label="Повідомлення асистенту менеджменту"
              @input="autoGrow"
              @keydown="onKeydown"
            ></textarea>
            <!-- The plan the turn is charged to. This chat runs through the same `omp`, the
                 same provider account and the same subscription as every agent, so a message
                 here is a message debited there — the figure sits in the composer because
                 that is where the spending decision is made. Absent entirely when no plan can
                 be reported: no figure beats a zero nobody can stand behind. -->
            <span
              v-if="planChip"
              v-tip="planChip.hint"
              class="mgmt__c-plan mono"
            >{{ planChip.short }} {{ planChip.percent }}</span>
            <button
              v-tip="chat.busy ? 'Асистент відповідає' : 'Надіслати (Enter)'"
              class="mgmt__c-send"
              type="submit"
              :disabled="!canSend"
              :aria-busy="chat.busy"
              :aria-label="chat.busy ? 'Асистент відповідає' : 'Надіслати'"
            ><span
              class="mgmt__c-glyph"
              :class="{ 'mgmt__c-glyph--busy': chat.busy }"
              aria-hidden="true"
            >↑</span></button>
          </form>
        </div>
      </template>
    </section>
  </main>
</template>

<script setup lang="ts">
// Shell of the Менеджмент tab: the section rail, the «pick a project» gate, the project
// every section is scoped to, and the assistant docked at the section pane's foot. The
// sections themselves are the child routes of /management (the table lives in
// @kermanych/core, shared with the api and the action executor) — this component decides
// WHETHER one renders and WHICH project it renders for; it never renders their content.
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { MANAGEMENT_SECTIONS } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import { useManagementChat } from 'stores/management-chat';
// The rail's row component, shared with the shell's bucket rail — it is what renders the
// `hint` second line. KSubNav is gone from this page with the horizontal strip it drove.
import KNavItem from 'components/kit/KNavItem.vue';
import KChatMessage from 'components/kit/KChatMessage.vue';
import { renderMarkdown } from '../lib/markdown';
import { percent, planWindow } from '../lib/format';
import { until } from '../lib/time';
import { useNow } from '../composables/useNow';
import { useSubscriptionUsage } from '../composables/useSubscriptionUsage';

const store = useOrchestrator();
const projects = useProjects();
const route = useRoute();
const router = useRouter();

// The child route name IS the rail's selection, so the rail follows deep links and
// the browser's back button with no state of its own.
const activeSection = computed(() => (typeof route.name === 'string' ? route.name : ''));
const sectionLabel = computed(
  () => MANAGEMENT_SECTIONS.find((s) => s.name === activeSection.value)?.label ?? 'Менеджмент',
);
function goSection(name: string): void {
  if (route.name !== name) void router.push({ name });
}

const projectId = computed(() => store.selectedProjectId);

// Prefer the cloud name, fall back to the cached local row — the shell header's
// two-lookup idiom, so a project whose sync failed still reads right here.
const projectName = computed(() => {
  const id = projectId.value;
  if (!id) return '';
  return projects.byId.get(id)?.name ?? store.projects.find((p) => p.id === id)?.name ?? '';
});

// ── The assistant ────────────────────────────────────────────────────────────
const chat = useManagementChat();
const draft = ref('');
const fieldEl = ref<HTMLTextAreaElement | null>(null);
const logEl = ref<HTMLElement | null>(null);

// The field grows with the text and then scrolls, so Shift+Enter newlines stay visible
// instead of being clipped by a one-line input. 132px ≈ six lines of the pill's type.
const MAX_FIELD_PX = 132;
// A stadium is the right shape for one line and the wrong one for three: at full pill
// radius the corners of a grown field eat the ends of its middle rows.
const grown = ref(false);

function autoGrow(): void {
  const el = fieldEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, MAX_FIELD_PX)}px`;
  // Measured against the field's OWN line-height rather than a pixel constant, so a theme
  // that changes the type scale cannot desynchronise the shape from the content.
  grown.value = el.scrollHeight > parseFloat(getComputedStyle(el).lineHeight) * 1.5;
}

const canSend = computed(() => draft.value.trim().length > 0 && !chat.busy);

// The active section travels with the message: the store has no router of its own (Quasar
// builds one per app in a factory, and a store setup has no injection context to reach it),
// and this component already knows which section is on screen. One source of truth.
function submit(): void {
  if (!canSend.value) return;
  const text = draft.value;
  // Cleared before the await: the turn is already in the transcript, and a field that keeps
  // the sent text invites sending it twice.
  draft.value = '';
  void nextTick(autoGrow);
  void chat.send(text, activeSection.value);
}

// Enter sends; Shift+Enter inserts a newline. Enter mid-IME-composition is ignored, so
// committing a Ukrainian or CJK candidate does not fire the message.
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  submit();
}

// Keep the newest entry in view as the transcript grows — deep, because a turn appends to
// the same array rather than replacing it.
function scrollLog(): void {
  void nextTick(() => {
    const el = logEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

watch(() => chat.entries, scrollLog, { deep: true });

// «Думає» — the heartbeat under the transcript while a turn is in flight. The seconds are
// counted by an interval that exists ONLY during a turn: a permanent one-second ticker would
// wake an idle tab (and the machine) forever to redraw a line that is not on screen.
const thinkingSec = ref(0);
let thinkTimer: ReturnType<typeof setInterval> | undefined;

// Silent for the first seconds — a fast answer must not flash a stopwatch — then the count
// appears and keeps the wait honest.
const thinkingLabel = computed(() => (thinkingSec.value < 3 ? 'Думає…' : `Думає… ${thinkingSec.value} с`));

watch(
  () => chat.busy,
  (busy) => {
    clearInterval(thinkTimer);
    thinkTimer = undefined;
    thinkingSec.value = 0;
    if (!busy) return;
    const startedAt = Date.now();
    thinkTimer = setInterval(() => (thinkingSec.value = Math.round((Date.now() - startedAt) / 1000)), 1000);
    // The «Думає…» line appends below the last entry, so the log has to follow it down.
    scrollLog();
  },
);

onUnmounted(() => clearInterval(thinkTimer));

// PLAN SPEND — the same figure the sidebar shows, folded to the single tightest window.
// The composer has room for one number, and the number that matters before spending a turn
// is the window closest to its ceiling. `providers` empty means nothing can be reported (no
// omp on PATH, no authenticated plan), and then the chip is absent rather than zero.
const planUsage = useSubscriptionUsage();
const planNow = useNow(30_000);

const planChip = computed(() => {
  const providers = planUsage.value?.providers ?? [];
  const windows = providers.flatMap((p) => p.windows);
  const tightest = windows.reduce<(typeof windows)[number] | undefined>(
    (worst, w) => (worst && worst.usedPercent >= w.usedPercent ? worst : w),
    undefined,
  );
  if (!tightest) return undefined;
  return {
    short: planWindow(tightest.id),
    percent: percent(tightest.usedPercent),
    // The detail the one-number chip drops, plus the sentence that explains why a
    // management chat shows a provider plan at all.
    hint: [
      'Цей чат витрачає ту саму підписку, що й агенти',
      ...providers.flatMap((p) => [
        p.provider[0]!.toUpperCase() + p.provider.slice(1),
        ...(p.accounts > 1 ? [`${p.accounts} акаунти, у середньому`] : []),
        ...p.windows.map(
          (w) =>
            `${w.label}: ${percent(w.usedPercent)}` +
            (w.resetsAt ? ` — оновиться за ${until(w.resetsAt, planNow.value)}` : ''),
        ),
      ]),
    ].join(' · '),
  };
});

// Same join the sidebar rail uses for its tile colour; the accent is the fallback
// so an uncoloured project still gets a dot instead of a hole.
const projectColor = computed(() => {
  const id = projectId.value;
  if (!id) return 'var(--k-accent)';
  const local = store.projects.find((p) => p.id === id);
  return projects.byId.get(id)?.color ?? local?.color ?? 'var(--k-accent)';
});
</script>

<style scoped lang="scss">
// Two columns: the rail keeps its width, the section pane takes the rest. The
// `minmax(0, 1fr)` is load-bearing — a plain `1fr` floors at the pane's content
// width, and one wide row inside a section (a skill body, a diff) would then push
// the rail off screen instead of scrolling inside the pane.
.mgmt {
  position: relative;
  display: grid;
  grid-template-columns: 244px minmax(0, 1fr);
  gap: var(--k-sp-4);
  height: calc(100vh - 82px);
  min-height: 0;
  padding: var(--k-sp-4);
  background: var(--k-canvas);
  overflow: hidden;
}

// Dim pools of light so the frosted capsule has something to bend — a flat canvas
// behind glass renders as plain grey. The first pool sits directly under the
// composer, which is what makes its fill read as frost rather than as paint.
//
// Carried mostly by `--k-surface2`, not the accent: surface2 is defined as
// «distance from the canvas» in BOTH palettes (lighter on dark, a shade darker on
// light), so these pools stay depth in either theme. A brand-tinted pool wide
// enough to matter on the dark canvas turns the light one pink, so the accent is
// held to a thin wash under the capsule.
.mgmt__atmo {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background:
    radial-gradient(
      520px 220px at 62% 97%,
      color-mix(in srgb, var(--k-accent) 10%, transparent),
      transparent 72%
    ),
    radial-gradient(
      680px 340px at 56% 112%,
      color-mix(in srgb, var(--k-surface2) 85%, transparent),
      transparent 70%
    ),
    radial-gradient(
      620px 320px at 88% 2%,
      color-mix(in srgb, var(--k-surface2) 70%, transparent),
      transparent 72%
    );
}

// Everything above the glow.
.mgmt__rail,
.mgmt__pane,
// `.mgmt__dock` is here for its `position: relative` as much as its layer: the transcript
// above it is absolutely positioned against this box (`bottom: 100%`), and without a
// positioned dock it would anchor to `.mgmt` and hang over the rail.
.mgmt__dock {
  position: relative;
  z-index: 1;
}

// ── Section rail ────────────────────────────────────────────────────────────
.mgmt__rail {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
  min-height: 0;
  padding: var(--k-sp-2);
  background: color-mix(in srgb, var(--k-surface) 70%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-lg);
  overflow-y: auto;
}

.mgmt__rail-head {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-3) 0;
}

// Which tab you are in, small and spaced out, over the scope it applies to.
.mgmt__eyebrow {
  font-size: 10px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--k-faint);
}

.mgmt__chip {
  display: inline-flex;
  align-items: center;
  gap: var(--k-sp-2);
  max-width: 100%;
  padding: 5px var(--k-sp-3);
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-xs);
  color: var(--k-text);
  background: color-mix(in srgb, var(--k-surface2) 55%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-pill);
}

.mgmt__chip--empty {
  color: var(--k-faint);
  border-style: dashed;
  background: transparent;
}

.mgmt__chip-dot {
  width: 7px;
  height: 7px;
  border-radius: var(--k-r-pill);
  flex: none;
}

.mgmt__chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mgmt__rail-note {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-xs);
  line-height: 1.35;
  color: var(--k-faint);
}

.mgmt__rail-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

// ── Section pane ────────────────────────────────────────────────────────────
.mgmt__pane {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-4);
  min-height: 0;
  padding: var(--k-sp-5) var(--k-sp-5) var(--k-sp-4);
  background: color-mix(in srgb, var(--k-surface) 45%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-lg);
}

.mgmt__head {
  flex: none;
  padding-bottom: var(--k-sp-3);
  border-bottom: var(--k-rule-thin) solid var(--k-line);
}

.mgmt__heading {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1;
  color: var(--k-text);
}

// The section's own content. Top-aligned and scrolling: the pane is a document
// column now, not a stage with one card centred in it.
//
// That also settles what `safe center` was here for: a section taller than the frame — Risk
// Registry with a full register — is centred INTO its own overflow by plain centering, and
// the part above the top edge cannot be scrolled back to, because scrollTop 0 is already
// past it. Flex-start has no such state; it overflows downward only, so the whole register
// stays reachable.
.mgmt__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

// ── Assistant dock — the frosted capsule and the transcript above it ─────────
// The dock is what the page's foot reserves: the pill, and a positioning context for a
// transcript that must NOT take part in the column's layout. Anchoring the log to the dock
// (rather than making it a flex sibling) is why the section above keeps its geometry as the
// conversation grows — a chat that reflows the screen it is describing is unusable.
.mgmt__dock {
  flex: none;
  // Centred on the pane's foot, not stretched across it: a capsule pulled to the
  // full width of a 1400px window reads as a toolbar, and its trailing controls
  // end up a screen away from the text they belong to. Capped at a comfortable
  // measure and centred, it stays a single object.
  align-self: center;
  width: min(680px, 100%);
}

// The same frost recipe as the pill — one glass object split in two, not two materials —
// but on `--k-r-lg`: a stadium is a shape for a control, and this is a panel of text.
.mgmt__log {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 100%;
  margin-bottom: var(--k-sp-2);
  display: flex;
  flex-direction: column;
  max-height: min(46vh, 520px);
  background: color-mix(in srgb, var(--k-surface) 74%, transparent);
  -webkit-backdrop-filter: blur(22px) saturate(150%);
  backdrop-filter: blur(22px) saturate(150%);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  box-shadow:
    var(--k-shadow-toast),
    inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent);
  overflow: hidden;
}

.mgmt__log-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-2) var(--k-sp-2) var(--k-sp-3);
  border-bottom: var(--k-rule-thin) solid var(--k-line);
}

.mgmt__log-title {
  font-size: var(--k-fs-xs);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--k-faint);
}

.mgmt__log-close {
  flex: none;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  appearance: none;
  border: none;
  border-radius: var(--k-r-sm);
  background: transparent;
  color: var(--k-muted);
  font-size: 15px;
  line-height: 1;

  &:disabled {
    cursor: not-allowed;
    opacity: 0.72;
  }

  &:not(:disabled):hover {
    color: var(--k-text);
    background: color-mix(in srgb, var(--k-surface2) 70%, transparent);
  }
}

.mgmt__log-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
  padding: var(--k-sp-3);
}

// The turn in flight. Italic, muted and gently pulsing — the app's one «working» idiom,
// shared with the agent panel's «Думаю…» (components/kit/KPanel.vue), so a wait reads the
// same wherever it happens. NOT mono: this is the assistant's own state, not the app
// reporting an outcome, and the mono rule belongs to `.mgmt__res`.
.mgmt__think {
  margin: 0;
  padding: 0 var(--k-sp-3);
  font-size: var(--k-fs-xs);
  font-style: italic;
  color: var(--k-muted);
  animation: mgmt-think-pulse 1.4s ease-in-out infinite;
}

@keyframes mgmt-think-pulse {
  0%,
  100% {
    opacity: 0.45;
  }
  50% {
    opacity: 1;
  }
}

// What the app did about a turn. A left rule and mono type, so a refusal cannot be skimmed
// as part of the answer above it: the whole point of the section table's `limitation` is
// that the operator READS why a section could not be changed.
.mgmt__res {
  margin: 0;
  padding: 6px var(--k-sp-3);
  font-size: var(--k-fs-xs);
  line-height: 1.5;
  border-left: 2px solid var(--k-line-strong);
  color: var(--k-muted);
}

// info is the quiet default above; warn and error borrow the register's own severity
// colours, so «не можу» and «зламалось» never read as the same event.
.mgmt__res--warn {
  color: var(--k-text);
  border-left-color: var(--k-accent);
  background: color-mix(in srgb, var(--k-accent) 8%, transparent);
}

.mgmt__res--error {
  color: var(--k-danger);
  border-left-color: var(--k-danger);
  background: color-mix(in srgb, var(--k-danger) 8%, transparent);
}

.mgmt__composer {
  display: flex;
  // Bottom-aligned, not centred: once the field grows to three lines the controls belong on
  // the baseline of the last one, the way they sit on the only line of a single-line pill.
  align-items: flex-end;
  gap: var(--k-sp-2);
  padding: 7px 7px 7px var(--k-sp-3);
  // Frosted, not see-through: a heavy blur under a mostly-opaque surface tint,
  // so text stays readable while the glow behind still bleeds through the edges.
  background: color-mix(in srgb, var(--k-surface) 74%, transparent);
  -webkit-backdrop-filter: blur(22px) saturate(150%);
  backdrop-filter: blur(22px) saturate(150%);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-pill);
  // Cast + the 1px top highlight that sells a glass edge under a light source.
  box-shadow:
    var(--k-shadow-toast),
    inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent);
  transition: border-radius 0.16s ease;
}

.mgmt__composer--grown {
  border-radius: var(--k-r-lg);
}

.mgmt__c-input {
  flex: 1;
  min-width: 0;
  // The height is written by autoGrow(); this is the floor it starts from and returns to.
  height: 30px;
  max-height: 132px;
  padding: 5px 0;
  appearance: none;
  resize: none;
  overflow-y: auto;
  border: none;
  background: transparent;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  line-height: 20px;
  letter-spacing: -0.01em;
  color: var(--k-text);

  &:focus {
    outline: none;
  }

  // Disabled while a turn is in flight: the field keeps its place in the pill and only
  // stops taking text, so nothing moves when the answer lands.
  &:disabled {
    cursor: not-allowed;
    color: var(--k-muted);
  }

  &::placeholder {
    color: var(--k-faint);
  }

  &::selection {
    background: color-mix(in srgb, var(--k-accent) 28%, transparent);
  }
}

// The plan chip. Mono because it is a figure, quiet because it is context for a decision
// rather than the decision — the tooltip carries the per-window detail.
.mgmt__c-plan {
  flex: none;
  align-self: center;
  padding: 3px var(--k-sp-2);
  font-size: var(--k-fs-xs);
  line-height: 1.4;
  color: var(--k-muted);
  background: color-mix(in srgb, var(--k-surface2) 60%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-pill);
  white-space: nowrap;
}

.mgmt__c-icon {
  flex: none;
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  appearance: none;
  border: none;
  border-radius: var(--k-r-pill);
  background: transparent;
  color: var(--k-muted);
  font-size: 17px;
  line-height: 1;
  transition:
    color 0.16s ease,
    background 0.16s ease;

  &:disabled {
    cursor: not-allowed;
    opacity: 0.72;
  }

  &:not(:disabled):hover {
    color: var(--k-text);
    background: color-mix(in srgb, var(--k-surface2) 70%, transparent);
  }
}

// The one loud element, exactly as in the reference: a filled accent disc.
.mgmt__c-send {
  flex: none;
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  appearance: none;
  border: none;
  border-radius: var(--k-r-pill);
  background: var(--k-accent);
  color: var(--k-on-accent);
  font-size: 19px;
  font-weight: var(--k-fw-semibold);
  line-height: 1;
  box-shadow: 0 4px 16px -4px color-mix(in srgb, var(--k-accent) 75%, transparent);

  // Not dimmed: `opacity` on an accent disc washes it to salmon over the light
  // canvas. The disabled state is carried by the cursor and by the arrow inside,
  // so the disc keeps the exact hue it has when it works.
  &:disabled {
    cursor: not-allowed;
  }
}

// The in-flight signal, on the GLYPH rather than the disc, for the reason above: the arrow
// breathes while the model is answering. The house pulse (see KToolRow, KStatusDot), which
// keeps «working» reading the same everywhere in the app.
.mgmt__c-glyph {
  display: inline-flex;
}

.mgmt__c-glyph--busy {
  animation: mgmt-send-pulse 1.4s ease-in-out infinite;
}

@keyframes mgmt-send-pulse {
  0%,
  100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}

// ── Blank / no-project state — mirrors AgentsPage's invitation ───────────────
.mgmt__blank {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 10px;
}

.mgmt__blank-eyebrow {
  font-size: var(--k-fs-xs);
  letter-spacing: 0.2em;
  color: var(--k-muted);
}

.mgmt__blank-text {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  color: var(--k-muted);
}

// The shell's own drawer already owns 264px; below this the two rails plus a
// section body stop fitting side by side at a readable measure, so the section
// rail gives up its second line's comfort first.
@media (max-width: 1180px) {
  .mgmt {
    grid-template-columns: 196px minmax(0, 1fr);
  }
}
</style>
