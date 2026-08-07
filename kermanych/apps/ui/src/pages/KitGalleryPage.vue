<template>
  <main class="kit">
    <header class="kit__masthead">
      <div class="kit__eyebrow mono">ДИЗАЙН-СИСТЕМА · КЕРМАНИЧ</div>
      <h1 class="kit__title">UI-kit</h1>
      <p class="kit__lede">
        Modernist dark kit. Radius 0, single accent, flush-left labels, mono for machine text.
      </p>
    </header>

    <!-- 03 — agent statuses -->
    <section class="kit__section">
      <div class="kit__label">03 · Статуси агента</div>
      <div class="kit__row">
        <div v-for="s in statusSamples" :key="s.status" class="kit__status">
          <KStatusDot :status="s.status" />
          <span class="kit__status-name">{{ s.name }}</span>
          <KTag>{{ s.status }}</KTag>
        </div>
      </div>
    </section>

    <!-- 04 — buttons -->
    <section class="kit__section">
      <div class="kit__label">04 · Кнопки</div>
      <div class="kit__row">
        <KBtn variant="primary">+ Новий агент</KBtn>
        <KBtn variant="secondary">Змінити шлях</KBtn>
        <KBtn variant="ghost">Відновити</KBtn>
        <KBtn variant="secondary" disabled>Застосувати</KBtn>
        <KBtn variant="icon">⊞</KBtn>
      </div>
      <div class="kit__caption mono">
        primary · secondary · ghost · disabled · icon
      </div>
    </section>

    <!-- 04 — tags & metadata -->
    <section class="kit__section">
      <div class="kit__label">04 · Теги й метадані</div>
      <div class="kit__row">
        <KTag>⑂ main</KTag>
        <KTag>opus-5</KTag>
        <KTag>142k</KTag>
        <KTag plain>завершено</KTag>
        <KTag plain>чекає</KTag>
      </div>
    </section>

    <!-- 04 — toggles -->
    <section class="kit__section">
      <div class="kit__label">04 · Перемикачі</div>
      <div class="kit__row">
        <KToggle v-model="harness" :options="['OMP', 'zsh']" />
        <KToggle v-model="view" :options="['Робочий простір', 'Історія']" />
      </div>
      <div class="kit__caption mono">harness={{ harness }} · view={{ view }}</div>
    </section>

    <!-- 04 — fields -->
    <section class="kit__section">
      <div class="kit__label">04 · Поля</div>
      <div class="kit__row kit__row--fields">
        <KField v-model="branch" label="Гілка" placeholder="feat/auth" />
        <KField v-model="focused" label="У фокусі" placeholder="click to focus" />
      </div>
      <div class="kit__caption mono">branch={{ branch }}</div>
    </section>

    <!-- 08 — dialog -->
    <section class="kit__section">
      <div class="kit__label">08 · Діалог</div>
      <div class="kit__row">
        <KBtn variant="primary" @click="modalOpen = true">Відкрити модалку</KBtn>
      </div>
      <KModal v-model="modalOpen" title="Новий агент">
        <template #head-meta>
          <KTag>⌘N</KTag>
        </template>
        <KField v-model="branch" label="Гілка" placeholder="feat/auth" />
        <p class="kit__modal-copy">
          Окрема worktree буде створена під цю гілку. Порожні поля успадкують дефолти проєкту.
        </p>
        <template #controls>
          <KBtn variant="ghost" @click="modalOpen = false">Скасувати</KBtn>
          <KBtn variant="primary" @click="modalOpen = false">Запустити</KBtn>
        </template>
      </KModal>
    </section>
  </main>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { SessionStatus } from '@kermanych/core';
import KBtn from 'components/kit/KBtn.vue';
import KTag from 'components/kit/KTag.vue';
import KStatusDot from 'components/kit/KStatusDot.vue';
import KField from 'components/kit/KField.vue';
import KToggle from 'components/kit/KToggle.vue';
import KModal from 'components/kit/KModal.vue';

const statusSamples: { status: SessionStatus; name: string }[] = [
  { status: 'thinking', name: 'працює' },
  { status: 'waiting_input', name: 'чекає' },
  { status: 'done', name: 'завершено' },
  { status: 'queued', name: 'холодна' },
];

const harness = ref('OMP');
const view = ref('Робочий простір');
const branch = ref('feat/auth');
const focused = ref('');
const modalOpen = ref(false);
</script>

<style scoped lang="scss">
.kit {
  max-width: 960px;
  margin: 0 auto;
  padding: 48px 40px 96px;
  background: var(--k-canvas);
  color: var(--k-text);
}

.kit__masthead {
  margin-bottom: 40px;
}

.kit__eyebrow {
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--k-muted);
}

.kit__title {
  margin: 10px 0 0;
  font-family: var(--k-font-ui);
  font-size: 34px;
  font-weight: 800;
  letter-spacing: -0.02em;
}

.kit__lede {
  margin: 12px 0 0;
  max-width: 560px;
  color: var(--k-muted);
  font-size: 14px;
  line-height: 1.65;
}

.kit__section {
  padding: 24px 0;
  border-top: 2px solid var(--k-line-strong);
}

.kit__label {
  font-family: var(--k-font-ui);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--k-muted);
  margin-bottom: 18px;
}

.kit__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;

  &--fields {
    align-items: flex-start;
  }
}

.kit__caption {
  margin-top: 14px;
  font-size: 11px;
  color: var(--k-muted);
}

.kit__status {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 200px;
}

.kit__status-name {
  font-size: 13px;
}

.kit__modal-copy {
  margin: 16px 0 0;
  font-size: 13px;
  line-height: 1.65;
  color: var(--k-muted);
}
</style>
