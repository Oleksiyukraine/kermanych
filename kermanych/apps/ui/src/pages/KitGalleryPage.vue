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

    <!-- 05 — agent panels -->
    <section class="kit__section">
      <div class="kit__label">05 · Панель агента</div>
      <div class="kit__panels">
        <KPanel
          :session="runningSession"
          :group="group"
          @send="onSend"
          @stop="onStop"
          @delete="onDelete"
        >
          <KLogBlock v-for="(e, i) in panelLog" :key="i" :entry="e" />
        </KPanel>
        <KPanel
          :session="waitingSession"
          :group="group"
          @send="onSend"
          @answer="onAnswer"
          @stop="onStop"
          @delete="onDelete"
        >
          <KLogBlock v-for="(e, i) in waitingLog" :key="i" :entry="e" />
        </KPanel>
      </div>
      <div class="kit__caption mono">остання дія: {{ lastAction || '—' }}</div>
    </section>

    <!-- 06 — log blocks -->
    <section class="kit__section">
      <div class="kit__label">06 · Блоки логу</div>
      <div class="kit__logblocks">
        <KLogBlock v-for="(e, i) in logSamples" :key="i" :entry="e" />
      </div>
    </section>

    <!-- 07 — window chrome: rail & status bar -->
    <section class="kit__section">
      <div class="kit__label">07 · Рейка та рядок стану</div>
      <div class="kit__rail">
        <KRailItem
          v-for="r in railGroups"
          :key="r.group.id"
          :group="r.group"
          :active="r.active"
          :count="r.count"
        />
      </div>
      <div class="kit__statusbar-wrap">
        <KStatusBar
          :counts="{ running: 1, waiting: 1, done: 2 }"
          model="opus-5"
          :tokens="142000"
          :cost="3.18"
        />
      </div>
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
import type {
  SessionStatus, Session, Group, TranscriptEntry, RpcExtensionUIResponse,
} from '@kermanych/core';
import KBtn from 'components/kit/KBtn.vue';
import KTag from 'components/kit/KTag.vue';
import KStatusDot from 'components/kit/KStatusDot.vue';
import KField from 'components/kit/KField.vue';
import KToggle from 'components/kit/KToggle.vue';
import KModal from 'components/kit/KModal.vue';
import KPanel from 'components/kit/KPanel.vue';
import KLogBlock from 'components/kit/KLogBlock.vue';
import KRailItem from 'components/kit/KRailItem.vue';
import KStatusBar from 'components/kit/KStatusBar.vue';

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

const now = new Date().toISOString();
const group: Group = {
  id: 'g1', name: 'api-gateway', projectDir: '/repo/api-gateway', createdAt: now,
};
function mkSession(over: Partial<Session>): Session {
  return {
    id: 's', groupId: 'g1', name: 'api-gateway', task: '',
    worktreePath: '', branch: 'main', status: 'thinking', createdAt: now, ...over,
  };
}
const runningSession = mkSession({ id: 's1', status: 'thinking', branch: 'main' });
const waitingSession = mkSession({
  id: 's2', status: 'waiting_input', branch: 'feat/schema',
  pendingUiRequest: {
    type: 'extension_ui_request', id: 'req-1', method: 'select',
    title: 'Куди звести логіку сесії?',
    options: ["Об'єднати в session.ts", 'Лишити як є, додати тест'],
  },
});
const panelLog: TranscriptEntry[] = [
  { kind: 'tool_call', tool: 'Edit', summary: 'src/auth/token.service.ts\n+ this.rotateShared(token);' },
  { kind: 'tool_call', tool: 'Bash', summary: 'npm run test:e2e -- auth' },
  { kind: 'tool_result', tool: 'Bash', ok: true, summary: '12 passed, 0 failed (8.4s)' },
  { kind: 'assistant_text', text: 'Готово. Ротація токенів зведена в один запит.' },
];
const waitingLog: TranscriptEntry[] = [
  { kind: 'tool_call', tool: 'Read', summary: 'src/session.ts' },
  { kind: 'assistant_text', text: 'Знайшов два місця, де зберігається сесія.' },
];
const logSamples: TranscriptEntry[] = [
  { kind: 'tool_call', tool: 'Read', summary: 'src/routes/login.tsx' },
  { kind: 'tool_call', tool: 'Edit', summary: 'db/schema/users.ts\n+ lastSeenAt: timestamp("last_seen_at"),' },
  { kind: 'tool_result', tool: 'Vitest', ok: true, summary: '12 passed, 0 failed (8.4s)' },
  { kind: 'tool_result', tool: 'Bash', ok: false, summary: 'exit 1 — 2 failing specs' },
  { kind: 'assistant_thinking', text: 'Сесія зберігається у двох місцях — треба звести.' },
  { kind: 'assistant_text', text: 'Знайшов два місця, де зберігається сесія.' },
  { kind: 'notice', text: 'Гілку перемкнено на feat/schema.' },
];
const railGroups: { group: Group; active: boolean; count: number }[] = [
  { group: { id: 'g1', name: 'api-gateway', projectDir: '', createdAt: now }, active: true, count: 4 },
  { group: { id: 'g2', name: 'web client', projectDir: '', createdAt: now }, active: false, count: 0 },
  { group: { id: 'g3', name: 'billing', projectDir: '', createdAt: now }, active: false, count: 1 },
];
const lastAction = ref('');
function onSend(text: string) { lastAction.value = `send: ${text}`; }
function onAnswer(res: RpcExtensionUIResponse) { lastAction.value = `answer: ${JSON.stringify(res)}`; }
function onStop() { lastAction.value = 'stop'; }
function onDelete() { lastAction.value = 'delete'; }
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

.kit__panels {
  display: flex;
  flex-direction: column;
  max-width: 640px;
}

.kit__panels > * + * {
  margin-top: -1px; // dock panels on a shared 2px rule
}

.kit__logblocks {
  max-width: 640px;
  padding: 16px;
  background: var(--k-bg);
  border: 1px solid var(--k-line-strong);
}

.kit__rail {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 44px;
}

.kit__statusbar-wrap {
  margin-top: 20px;
  max-width: 640px;
  border: 1px solid var(--k-line-strong);
  border-top: none;
}
</style>
