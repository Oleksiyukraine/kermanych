<template>
  <KModal
    :model-value="onb.open"
    flush
    width="min(1040px, 94vw)"
    :title="t('onboarding.checklist.title')"
    @update:model-value="(v: boolean) => { if (!v) onb.hide(); }"
  >
    <template #head-meta>
      <div class="onb__meta">
        <div class="onb__meta-text">
          <span class="onb__step">{{
            t('onboarding.checklist.stepCount', { done: onb.doneCount, total: onb.totalCount })
          }}</span>
          <span class="onb__eta">{{ etaText }}</span>
        </div>
        <button
          class="onb__close"
          type="button"
          v-tip="t('onboarding.checklist.close')"
          :aria-label="t('onboarding.checklist.close')"
          @click="onb.hide()"
        >✕</button>
      </div>
    </template>

    <div class="onb">
      <p class="onb__blurb">{{ t('onboarding.checklist.blurb') }}</p>

      <div class="onb__progress">
        <div class="onb__bar">
          <div
            class="onb__bar-fill"
            :class="{ 'onb__bar-fill--ready': onb.readyToLaunch }"
            :style="{ width: pct + '%' }"
          ></div>
        </div>
        <span class="onb__pill" :class="{ 'onb__pill--ready': onb.readyToLaunch }">
          {{ onb.readyToLaunch ? t('onboarding.checklist.ready') : t('onboarding.checklist.notReady') }}
        </span>
      </div>

      <div class="onb__cols">
        <div class="onb__main">
          <section v-for="g in groups" :key="g.key" class="onb__group">
            <button class="onb__group-head" type="button" @click="toggleGroup(g.key)">
              <span class="onb__ring" :class="{ 'onb__ring--done': g.allDone }">{{
                g.allDone ? '✓' : g.remaining
              }}</span>
              <span class="onb__group-text">
                <span class="onb__group-title-row">
                  <span class="onb__group-title">{{ g.title }}</span>
                  <span class="onb__req" :class="{ 'onb__req--required': g.required }">{{ g.reqLabel }}</span>
                </span>
                <span class="onb__group-why">{{ g.why }}</span>
              </span>
              <span class="onb__group-count">{{ g.done }}/{{ g.total }}</span>
              <span class="onb__chev" :class="{ 'onb__chev--open': openGroup === g.key }">⌄</span>
            </button>

            <div v-if="openGroup === g.key" class="onb__cards">
              <div
                v-for="c in g.cards"
                :key="c.key"
                class="onb__card"
                :class="{ 'onb__card--done': c.done }"
              >
                <div class="onb__card-top">
                  <button
                    class="onb__dot"
                    type="button"
                    :class="{ 'onb__dot--done': c.done, 'onb__dot--auto': c.kind === 'auto' }"
                    :disabled="c.kind === 'auto'"
                    :aria-label="c.title"
                    @click="c.kind === 'ack' && onb.toggleAck(c.key)"
                  >{{ c.done ? '✓' : '' }}</button>
                  <div class="onb__card-body">
                    <div class="onb__card-title" :class="{ 'onb__card-title--done': c.done }">{{ c.title }}</div>
                    <div class="onb__card-desc">{{ c.body }}</div>
                    <div v-if="c.hint" class="onb__card-hint mono">{{ c.hint }}</div>
                  </div>
                </div>
                <div class="onb__card-foot">
                  <button
                    class="onb__cta"
                    type="button"
                    :class="{ 'onb__cta--done': c.done }"
                    @click="runCard(c)"
                  >{{ c.done ? t('onboarding.checklist.open') : c.cta }}</button>
                  <span class="onb__time">{{ c.time }}</span>
                </div>
              </div>
            </div>
          </section>
        </div>

        <aside class="onb__aside">
          <div class="onb__aside-block">
            <div class="onb__aside-title">{{ t('onboarding.checklist.glossaryTitle') }}</div>
            <div v-for="term in glossary" :key="term.key" class="onb__term">
              <div class="onb__term-name">{{ term.name }}</div>
              <div class="onb__term-def">{{ term.def }}</div>
            </div>
          </div>
          <div class="onb__aside-block onb__aside-block--top">
            <div class="onb__aside-title">{{ t('onboarding.checklist.helpTitle') }}</div>
            <div v-for="h in help" :key="h.key" class="onb__help"><span class="onb__help-arrow">→</span>{{ h.label }}</div>
          </div>
        </aside>
      </div>
    </div>

    <template #controls>
      <span class="onb__foot-note">{{ t('onboarding.checklist.footerNote') }}</span>
      <KBtn variant="ghost" @click="onb.dismiss()">{{ t('onboarding.checklist.dontShow') }}</KBtn>
      <KBtn variant="primary" @click="primary()">
        {{ onb.readyToLaunch ? t('onboarding.checklist.ctaFirstTask') : t('onboarding.checklist.ctaContinue') }}
      </KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { ONBOARDING_GROUPS, useOnboarding, type OnboardingCard } from 'stores/onboarding';
import KModal from 'components/kit/KModal.vue';
import KBtn from 'components/kit/KBtn.vue';

// The first-run checklist modal (design/onboarding.html). It owns none of the truth: the
// onboarding store decides what is done and whether the account is ready, this only renders it
// and turns a card's button into either a routed navigation (done here) or one of the three
// setup acts that reuse MainLayout's own modals (emitted upward).
const onb = useOnboarding();
const { t } = useI18n();
const router = useRouter();

const emit = defineEmits<{ 'create-workspace': []; 'create-project': []; 'bind-folder': [] }>();

// Which group is expanded. One at a time, accordion-style, like the design.
const openGroup = ref<string>('connect');

const firstIncompleteGroup = (): string =>
  ONBOARDING_GROUPS.find((g) => g.cards.some((c) => !onb.isDone(c)))?.key ?? ONBOARDING_GROUPS[0]!.key;

// Each time the modal opens, jump to the first group that still has work, so the operator
// lands on the next thing to do rather than on whatever was expanded last time.
watch(
  () => onb.open,
  (open) => {
    if (open) openGroup.value = firstIncompleteGroup();
  },
);

function toggleGroup(key: string): void {
  openGroup.value = openGroup.value === key ? '' : key;
}

const pct = computed(() => Math.round((onb.doneCount / onb.totalCount) * 100));

// «ще N до першого запуску», counted over the three steps that actually gate launching
// (workspace, project, folder) — not every required card — so the number matches the pill.
const launchStepsLeft = computed(
  () => [onb.hasWorkspace, onb.hasProject, onb.hasFolder].filter((done) => !done).length,
);
const etaText = computed(() =>
  onb.readyToLaunch
    ? t('onboarding.checklist.etaReady')
    : t('onboarding.checklist.etaLeft', { n: launchStepsLeft.value }),
);

// The view model — every i18n lookup resolved here so the template stays declarative and the
// whole thing recomputes on both locale change and any store state change.
const groups = computed(() =>
  ONBOARDING_GROUPS.map((g) => {
    const base = `onboarding.checklist.groups.${g.key}`;
    const cards = g.cards.map((c) => {
      const ck = `${base}.cards.${c.key}`;
      return {
        key: c.key,
        kind: c.kind,
        action: c.action,
        // exactOptionalPropertyTypes: an absent route is an absent KEY, not `undefined`.
        ...(c.route ? { route: c.route } : {}),
        done: onb.isDone(c),
        title: t(`${ck}.title`),
        body: t(`${ck}.body`),
        hint: t(`${ck}.hint`),
        cta: t(`${ck}.cta`),
        time: t(`${ck}.time`),
      };
    });
    const done = cards.filter((c) => c.done).length;
    return {
      key: g.key,
      required: g.required,
      reqLabel: g.required ? t('onboarding.checklist.required') : t('onboarding.checklist.optional'),
      title: t(`${base}.title`),
      why: t(`${base}.why`),
      cards,
      done,
      total: cards.length,
      remaining: String(cards.length - done),
      allDone: done === cards.length,
    };
  }),
);

const glossary = computed(() =>
  (['workspace', 'project', 'worktree', 'harness'] as const).map((key) => ({
    key,
    name: t(`onboarding.checklist.glossary.${key}.term`),
    def: t(`onboarding.checklist.glossary.${key}.def`),
  })),
);

const help = computed(() =>
  (['folder', 'push', 'contact'] as const).map((key) => ({
    key,
    label: t(`onboarding.checklist.help.${key}`),
  })),
);

function runCard(card: Pick<OnboardingCard, 'kind' | 'action' | 'route' | 'key'>): void {
  if (card.action === 'create-workspace') {
    emit('create-workspace');
    return;
  }
  if (card.action === 'create-project') {
    emit('create-project');
    return;
  }
  if (card.action === 'bind-folder') {
    emit('bind-folder');
    return;
  }
  // A routed surface: seeing it is the whole point of an ack card, so opening it ticks it.
  if (card.kind === 'ack') onb.markAck(card.key);
  onb.hide();
  if (card.route) void router.push(card.route);
}

function primary(): void {
  // Ready to launch: send them to the first task. Not ready: keep the checklist open and jump
  // to the next incomplete group rather than pretending anything happened.
  if (onb.readyToLaunch) {
    onb.hide();
    void router.push({ name: 'agents' });
    return;
  }
  openGroup.value = firstIncompleteGroup();
}
</script>

<style scoped lang="scss">
.onb {
  display: flex;
  flex-direction: column;
  min-height: 0;
  color: var(--k-text);
}

// ── header meta (step count + eta + close) ─────────────────────────────────────
.onb__meta {
  display: flex;
  align-items: center;
  gap: 14px;
}

.onb__meta-text {
  text-align: right;
  line-height: 1.3;
}

.onb__step {
  display: block;
  font-size: var(--k-fs-base);
  color: var(--k-muted);
}

.onb__eta {
  display: block;
  font-size: var(--k-fs-sm);
  color: var(--k-faint);
}

.onb__close {
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: var(--k-r);
  background: var(--k-surface);
  color: var(--k-faint);
  cursor: pointer;
  font-size: var(--k-icon-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s, color 0.12s;

  &:hover {
    background: var(--k-surface2);
    color: var(--k-text);
  }
}

.onb__blurb {
  margin: 0;
  padding: 20px 24px 16px;
  max-width: 72ch;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--k-muted);
}

// ── progress bar ───────────────────────────────────────────────────────────────
.onb__progress {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 24px;
  border-top: 1px solid var(--k-line);
  border-bottom: 1px solid var(--k-line);
}

.onb__bar {
  flex: 1;
  height: 6px;
  border-radius: var(--k-r-pill);
  background: var(--k-surface);
  overflow: hidden;
}

.onb__bar-fill {
  height: 100%;
  border-radius: var(--k-r-pill);
  background: var(--k-accent);
  transition: width 0.2s ease;

  &--ready {
    background: var(--k-success);
  }
}

.onb__pill {
  flex: none;
  white-space: nowrap;
  font-size: var(--k-fs-sm);
  color: var(--k-warning);
  background: var(--k-surface);
  border-radius: var(--k-r-pill);
  padding: 4px 11px;

  &--ready {
    color: var(--k-success);
  }
}

// ── two columns ─────────────────────────────────────────────────────────────────
.onb__cols {
  display: flex;
  min-height: 0;
  max-height: 62vh;
}

.onb__main {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 20px 24px 24px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.onb__aside {
  width: 300px;
  flex: none;
  border-left: 1px solid var(--k-line);
  padding: 20px 22px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 22px;
}

// ── group ─────────────────────────────────────────────────────────────────────
.onb__group {
  flex: 0 0 auto;
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-lg);
  background: var(--k-bg);
  overflow: hidden;
}

.onb__group-head {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 16px 18px;
  background: transparent;
  border: 0;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s;

  &:hover {
    background: var(--k-surface);
  }
}

.onb__ring {
  width: 26px;
  height: 26px;
  flex: none;
  margin-top: 1px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-semibold);
  color: var(--k-muted);
  border: 1px dashed var(--k-faint);

  &--done {
    color: var(--k-on-accent);
    background: var(--k-success);
    border: 0;
  }
}

.onb__group-text {
  flex: 1;
  min-width: 0;
}

.onb__group-title-row {
  display: flex;
  align-items: center;
  gap: 9px;
}

.onb__group-title {
  font-size: var(--k-fs-md);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
}

.onb__req {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
  background: var(--k-surface);
  border-radius: var(--k-r-pill);
  padding: 2px 8px;

  &--required {
    color: var(--k-accent);
  }
}

.onb__group-why {
  display: block;
  margin-top: 5px;
  font-size: var(--k-fs-base);
  line-height: 1.6;
  color: var(--k-muted);
}

.onb__group-count {
  flex: none;
  padding-top: 3px;
  font-size: var(--k-fs-sm);
  color: var(--k-faint);
}

.onb__chev {
  flex: none;
  padding-top: 1px;
  font-size: var(--k-icon-sm);
  color: var(--k-faint);
  transition: transform 0.15s;

  &--open {
    transform: rotate(180deg);
  }
}

// ── cards grid ──────────────────────────────────────────────────────────────────
.onb__cards {
  padding: 0 18px 18px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.onb__card {
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  background: var(--k-surface);
  padding: 14px 15px;

  &--done {
    border-color: var(--k-line);
    background: transparent;
  }
}

.onb__card-top {
  display: flex;
  align-items: flex-start;
  gap: 11px;
}

.onb__dot {
  width: 19px;
  height: 19px;
  flex: none;
  margin-top: 1px;
  border-radius: 50%;
  border: 1px solid var(--k-faint);
  background: transparent;
  color: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--k-fs-xs);

  &--done {
    background: var(--k-success);
    color: var(--k-on-accent);
    border: 0;
  }

  &--auto {
    cursor: default;
  }
}

.onb__card-body {
  flex: 1;
  min-width: 0;
}

.onb__card-title {
  font-size: 13.5px;
  font-weight: var(--k-fw-semibold);
  line-height: 1.4;
  color: var(--k-text);

  &--done {
    color: var(--k-muted);
  }
}

.onb__card-desc {
  margin-top: 6px;
  font-size: var(--k-fs-sm);
  line-height: 1.65;
  color: var(--k-muted);
}

.onb__card-hint {
  margin-top: 8px;
  font-family: var(--k-font-mono);
  font-size: 11.5px;
  color: var(--k-faint);
}

.onb__card-foot {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 12px;
}

.onb__cta {
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-semibold);
  background: var(--k-surface2);
  color: var(--k-text);
  border: 0;
  border-radius: var(--k-r);
  padding: 7px 12px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;

  &:hover {
    background: var(--k-line-strong);
  }

  &--done {
    font-weight: var(--k-fw-medium);
    background: transparent;
    color: var(--k-faint);
    border: 1px solid var(--k-line);
  }
}

.onb__time {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--k-faint);
}

// ── aside ─────────────────────────────────────────────────────────────────────
.onb__aside-title {
  font-size: var(--k-fs-xs);
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--k-faint);
  margin-bottom: 12px;
}

.onb__aside-block--top {
  border-top: 1px solid var(--k-line);
  padding-top: 18px;
}

.onb__term {
  border-left: 2px solid var(--k-line-strong);
  padding-left: 12px;

  & + & {
    margin-top: 12px;
  }
}

.onb__term-name {
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
}

.onb__term-def {
  margin-top: 4px;
  font-size: var(--k-fs-sm);
  line-height: 1.6;
  color: var(--k-muted);
}

.onb__help {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: var(--k-fs-base);
  color: var(--k-muted);

  & + & {
    margin-top: 8px;
  }
}

.onb__help-arrow {
  color: var(--k-faint);
  font-size: var(--k-fs-xs);
}

// ── footer ────────────────────────────────────────────────────────────────────
.onb__foot-note {
  margin-right: auto;
  font-size: var(--k-fs-sm);
  color: var(--k-faint);
  max-width: 52ch;
  text-align: left;
}
</style>
