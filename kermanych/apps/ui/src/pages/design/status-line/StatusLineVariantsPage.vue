<template>
  <!-- PROTOTYPE (docs/design/2026-11-24-status-line-redo): three ways to show a task's state once,
       «like GitHub / GitLab». Each variant is a list card + the session pane it opens, so the
       placement is visible. Dev-only route; deleted after implementation. -->
  <div class="proto">
    <header class="proto__bar">
      <span class="mono">статус задачі · прототип</span>
      <nav class="proto__states">
        <button
          v-for="s in STATES"
          :key="s"
          type="button"
          class="proto__state mono"
          :class="{ 'proto__state--on': s === state }"
          @click="state = s"
        >
          {{ s }}
        </button>
      </nav>
    </header>

    <section v-for="v in VARIANTS" :key="v.key" class="proto__variant">
      <h2 class="proto__title">{{ v.title }}</h2>
      <p class="proto__note">{{ v.note }}</p>

      <div class="mock">
        <!-- the «Агенти» list card -->
        <div class="mock__list">
          <div class="card">
            <div class="card__top">
              <span class="card__name">{{ f.title }}</span>
              <span class="card__time mono">щойно</span>
            </div>
            <span class="card__branch mono">{{ f.branch }}</span>

            <!-- 1 · pipeline: the dots ARE the status -->
            <div v-if="v.key === 'pipeline'" class="card__row">
              <span class="mini">
                <span v-for="st in f.stages" :key="st.key" class="mini__dot" :class="`st--${st.state}`" />
              </span>
              <span class="card__word mono" :class="`tone--${f.tone}`">{{ currentStage.label.toLowerCase() }}<template v-if="currentStage.note"> · {{ currentStage.note }}</template></span>
            </div>

            <!-- 2 · merge-box: one status row, as today, nothing doubled -->
            <div v-else-if="v.key === 'mergebox'" class="card__row">
              <KStatusDot :status="dotStatus" />
              <span class="card__word mono">{{ f.headline }}</span>
            </div>

            <!-- 3 · state pill -->
            <div v-else class="card__row">
              <span class="pill" :class="`pill--${f.tone}`"><span class="pill__glyph">{{ glyph }}</span>{{ f.status }}</span>
            </div>
          </div>
        </div>

        <!-- the session pane -->
        <div class="mock__pane">
          <div class="pane__head">
            <span class="pane__title">{{ f.title }}</span>
            <KTag>⑂ {{ f.branch }}</KTag>
            <span v-if="v.key === 'pill'" class="pill" :class="`pill--${f.tone}`"><span class="pill__glyph">{{ glyph }}</span>{{ f.status }}</span>
            <span class="pane__spacer" />
            <span class="pane__harness mono">omp</span>
          </div>
          <div class="pane__tabs">
            <span class="pane__tab pane__tab--on">Лог</span><span class="pane__tab">Зміни</span><span class="pane__tab">Сесія</span><span class="pane__tab">Документація</span>
          </div>

          <!-- 1 · pipeline under the tabs -->
          <div v-if="v.key === 'pipeline'" class="pipe">
            <template v-for="(st, i) in f.stages" :key="st.key">
              <span v-if="i" class="pipe__link" :class="{ 'pipe__link--done': st.state !== 'todo' }" />
              <span class="pipe__stage" :class="`st--${st.state}`">
                <span class="pipe__node">
                  <KSpinner v-if="st.state === 'running'" :size="12" />
                  <template v-else>{{ NODE[st.state] }}</template>
                </span>
                <span class="pipe__label">{{ st.label }}</span>
                <span v-if="st.note" class="pipe__sub mono">{{ st.note }}</span>
              </span>
            </template>
            <span class="pane__spacer" />
            <KBtn v-if="f.action" variant="primary">{{ f.action }}</KBtn>
          </div>

          <div class="pane__log">
            <div class="log__line" />
            <div class="log__line log__line--short" />
            <div class="log__line" />
            <div class="log__line log__line--mid" />
          </div>

          <!-- 2 · merge-box right above the composer, where the eye already is -->
          <div v-if="v.key === 'mergebox'" class="box" :class="`box--${f.tone}`">
            <div class="box__head">
              <span class="box__icon" :class="`tone--${f.tone}`">{{ glyph }}</span>
              <span class="box__headline">{{ f.headline }}</span>
              <span class="pane__spacer" />
              <KBtn v-if="f.action" variant="primary">{{ f.action }}</KBtn>
            </div>
            <ul class="box__rows">
              <li v-for="(c, i) in f.checks" :key="i" class="box__row" :class="`st--${c.state}`">
                <span class="box__mark">
                  <KSpinner v-if="c.state === 'running'" :size="12" />
                  <template v-else>{{ NODE[c.state] }}</template>
                </span>
                <span class="box__text">{{ c.text }}</span>
              </li>
            </ul>
          </div>

          <div class="pane__composer mono">❯ напиши наступний крок…</div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { SessionStatus } from '@kermanych/core';
import KBtn from '../../../components/kit/KBtn.vue';
import KSpinner from '../../../components/kit/KSpinner.vue';
import KStatusDot from '../../../components/kit/KStatusDot.vue';
import KTag from '../../../components/kit/KTag.vue';
import { FIXTURES, STATES, type StageState } from './fixtures';

const VARIANTS = [
  {
    key: 'pipeline',
    title: '1 · Стрічка етапів (pipeline у GitLab)',
    note: 'Під вкладками, на всіх вкладках: де задача зараз і що далі. У картці — та сама стрічка крапками замість двох рядків статусу. Рядок над полем вводу і «omp · статус» у заголовку прибираються.',
  },
  {
    key: 'mergebox',
    title: '2 · Merge-box (низ ПР на GitHub)',
    note: 'Блок над полем вводу: одне речення-заголовок + рядки-перевірки + головна кнопка. У картці — один рядок (заголовок блоку). Рядок під вкладками, рядок над полем вводу і «omp · статус» прибираються.',
  },
  {
    key: 'pill',
    title: '3 · Бейдж стану (Open / Merged у GitHub)',
    note: 'Кольоровий бейдж поруч із назвою задачі в заголовку та в картці. Жодних додаткових рядків; подробиці — у підказці при наведенні.',
  },
] as const;

const NODE: Record<StageState, string> = { done: '✓', running: '', waiting: '●', failed: '✗', todo: '○' };

const initial = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('state');
const state = ref(initial && STATES.includes(initial) ? initial : 'review');
const f = computed(() => FIXTURES[state.value]!);

const currentStage = computed(
  () => f.value.stages.find((s) => s.state === 'failed') ?? [...f.value.stages].reverse().find((s) => s.state !== 'todo')!,
);
const dotStatus = computed<SessionStatus>(() =>
  state.value === 'working' ? 'tool' : state.value === 'waiting' ? 'waiting_input' : 'in_review',
);
const glyph = computed(() => ({ running: '◆', waiting: '◇', done: '✓', error: '✗', cold: '○' })[f.value.tone]);
</script>

<style scoped lang="scss">
.proto {
  min-height: 100vh;
  padding: var(--k-sp-5) var(--k-sp-6) var(--k-sp-7);
  background: var(--k-canvas);
  color: var(--k-text);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
}

.proto__bar {
  display: flex;
  align-items: center;
  gap: var(--k-sp-4);
  margin-bottom: var(--k-sp-5);
  color: var(--k-muted);
}

.proto__states { display: flex; gap: var(--k-sp-1); }

.proto__state {
  padding: 4px 10px;
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-pill);
  background: transparent;
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
  cursor: pointer;

  &--on { border-color: var(--k-accent); color: var(--k-text); }
}

.proto__variant { margin-bottom: var(--k-sp-7); }
.proto__title { margin: 0 0 var(--k-sp-1); font-size: var(--k-fs-md); font-weight: var(--k-fw-semibold); }
.proto__note { margin: 0 0 var(--k-sp-3); max-width: 900px; color: var(--k-muted); line-height: 1.5; }

// ── mock shell ───────────────────────────────────────────────────────────────
.mock {
  display: grid;
  grid-template-columns: 300px 1fr;
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-lg);
  background: var(--k-bg);
  overflow: hidden;
  min-height: 300px;
}

.mock__list { padding: var(--k-sp-3); border-right: 1px solid var(--k-line); }
.mock__pane { display: flex; flex-direction: column; min-width: 0; }

.card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  background: var(--k-surface);
}

.card__top { display: flex; justify-content: space-between; gap: 8px; }
.card__name { font-weight: var(--k-fw-medium); }
.card__time, .card__branch { font-size: var(--k-fs-xs); color: var(--k-faint); }
.card__row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.card__word { font-size: var(--k-fs-xs); color: var(--k-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.pane__head {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  padding: 12px 16px;
  border-bottom: 1px solid var(--k-line);
}

.pane__title { font-size: var(--k-fs-md); font-weight: var(--k-fw-semibold); }
.pane__spacer { flex: 1; }
.pane__harness { font-size: var(--k-fs-xs); color: var(--k-faint); }

.pane__tabs {
  display: flex;
  gap: var(--k-sp-4);
  padding: 10px 16px;
  border-bottom: 1px solid var(--k-line);
  color: var(--k-muted);
}

.pane__tab--on { color: var(--k-text); box-shadow: 0 9px 0 -7px var(--k-accent); }

.pane__log { flex: 1; display: flex; flex-direction: column; gap: 10px; padding: 16px; }
.log__line { height: 8px; border-radius: 4px; background: var(--k-surface2); width: 80%; }
.log__line--short { width: 35%; }
.log__line--mid { width: 55%; }

.pane__composer {
  margin: 0 16px 16px;
  padding: 12px;
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  color: var(--k-faint);
  font-size: var(--k-fs-sm);
}

// ── stage colours, shared by every variant ───────────────────────────────────
.st--done { --st: var(--k-success); }
.st--running { --st: var(--k-accent); }
.st--waiting { --st: var(--k-warning); }
.st--failed { --st: var(--k-danger); }
.st--todo { --st: var(--k-faint); }

.tone--running { color: var(--k-accent); }
.tone--waiting { color: var(--k-warning); }
.tone--done { color: var(--k-success); }
.tone--error { color: var(--k-danger); }
.tone--cold { color: var(--k-faint); }

// ── 1 · pipeline ─────────────────────────────────────────────────────────────
.pipe {
  display: flex;
  align-items: flex-start;
  gap: 0;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--k-line);
}

.pipe__stage {
  display: grid;
  grid-template-columns: 22px auto;
  grid-template-rows: 22px auto;
  column-gap: 8px;
  align-items: center;
  color: var(--st);
}

.pipe__node {
  grid-row: 1;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: 1.5px solid var(--st);
  border-radius: 50%;
  font-size: 11px;
  line-height: 1;
}

.st--done .pipe__node,
.st--failed .pipe__node { background: var(--st); color: var(--k-on-accent); }

.pipe__label { color: var(--k-text); font-size: var(--k-fs-sm); font-weight: var(--k-fw-medium); }
.st--todo .pipe__label { color: var(--k-faint); }
.pipe__sub { grid-column: 2; font-size: var(--k-fs-xs); color: var(--st); }

.pipe__link {
  flex: 0 1 36px;
  min-width: 14px;
  height: 1.5px;
  margin: 10px 8px 0;
  background: var(--k-line-strong);

  &--done { background: var(--k-success); }
}

.mini { display: inline-flex; align-items: center; gap: 3px; }
.mini__dot { width: 8px; height: 8px; border-radius: 50%; background: var(--st); }
.st--todo.mini__dot { background: transparent; border: 1px solid var(--k-line-strong); }

// ── 2 · merge-box ────────────────────────────────────────────────────────────
.box {
  margin: 0 16px 8px;
  border: 1px solid var(--k-line-strong);
  border-left: 3px solid var(--tone);
  border-radius: var(--k-r);
  background: var(--k-surface);

  &--running { --tone: var(--k-accent); }
  &--waiting { --tone: var(--k-warning); }
  &--done { --tone: var(--k-success); }
  &--error { --tone: var(--k-danger); }
}

.box__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--k-line);
}

.box__icon { font-size: var(--k-icon-md); }
.box__headline { font-weight: var(--k-fw-semibold); }
.box__rows { margin: 0; padding: 6px 12px 8px; list-style: none; }
.box__row { display: flex; align-items: center; gap: 10px; min-height: 26px; color: var(--k-muted); }
.box__mark { width: 14px; display: grid; place-items: center; color: var(--st); }

// ── 3 · pill ─────────────────────────────────────────────────────────────────
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px 3px 8px;
  border-radius: var(--k-r-pill);
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-semibold);
  color: var(--k-on-accent);
  background: var(--tone);

  &--running { --tone: var(--k-accent); }
  &--waiting { --tone: var(--k-warning); }
  &--done { --tone: var(--k-success); }
  &--error { --tone: var(--k-danger); }
  &--cold { --tone: var(--k-surface2); color: var(--k-text); }
}

.pill__glyph { font-size: 11px; }
</style>
