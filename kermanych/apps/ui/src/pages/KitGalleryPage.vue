<template>
  <main class="kit">
    <header class="kit__masthead">
      <div class="kit__eyebrow mono">ДИЗАЙН-СИСТЕМА · КЕРМАНИЧ</div>
      <h1 class="kit__title">UI-kit</h1>
      <p class="kit__lede">
        Two themes on one token set. Single vermilion accent, rounded cards, mono for machine text.
      </p>
    </header>

    <!-- 00 — foundations (design system) -->
    <section class="kit__section">
      <div class="kit__label">00 · Основи</div>
      <div class="kit__swatches">
        <div v-for="c in swatches" :key="c.var" class="kit__swatch">
          <span class="kit__chip" :style="{ background: `var(${c.var})` }"></span>
          <span class="kit__swatch-name mono">{{ c.var }}</span>
        </div>
      </div>
      <div class="kit__typescale">
        <div v-for="t in typeScale" :key="t.var" class="kit__type" :style="{ fontSize: `var(${t.var})` }">
          {{ t.label }} <span class="mono kit__type-tag">{{ t.var }}</span>
        </div>
      </div>
      <div class="kit__radii">
        <div v-for="r in radii" :key="r.var" class="kit__radius" :style="{ borderRadius: `var(${r.var})` }">
          <span class="mono">{{ r.var }}</span>
        </div>
      </div>
    </section>

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

    <!-- 04 — action icon buttons (dense, for icon clusters) -->
    <section class="kit__section">
      <div class="kit__label">04 · Кнопки-дії (рядок таблиці, хедер панелі)</div>
      <div class="kit__row">
        <KIconButton title="Запустити">▶</KIconButton>
        <KIconButton title="Редагувати">✎</KIconButton>
        <KIconButton title="Форк у worktree">⑂</KIconButton>
        <KIconButton title="Влити висновок">⤴</KIconButton>
        <KIconButton title="Ревізор">⚖</KIconButton>
        <KIconButton title="Завершити">✓</KIconButton>
        <KIconButton title="Відкласти">⤓</KIconButton>
        <KIconButton title="Видалити">✕</KIconButton>
        <KIconButton active title="Превʼю активне">◼</KIconButton>
      </div>
      <div class="kit__caption mono">
        28×28 · щільний контроль для груп глиф-дій: рядок таблиці й хедер панелі (компактніший за KBtn variant="icon" 34×34). active = акцент. Підказка — власний тултіп (v-tip), не нативний title.
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
          @send="onSend"
          @stop="onStop"
          @delete="onDelete"
          @expand-all="onGalleryExpandAll"
        >
          <KLogBlock v-for="(e, i) in panelLog" :key="i" :entry="e" session-id="kit-demo" :expand-all="galleryExpandAll" />
        </KPanel>
        <KPanel
          :session="waitingSession"
          @send="onSend"
          @answer="onAnswer"
          @stop="onStop"
          @delete="onDelete"
          @expand-all="onGalleryExpandAll"
        >
          <KLogBlock v-for="(e, i) in waitingLog" :key="i" :entry="e" session-id="kit-demo" :expand-all="galleryExpandAll" />
        </KPanel>
        <KPanel
          :session="stalledSession"
          @send="onSend"
          @restart="onRestart"
          @stop="onStop"
          @delete="onDelete"
          @expand-all="onGalleryExpandAll"
        >
          <KLogBlock v-for="(e, i) in waitingLog" :key="i" :entry="e" session-id="kit-demo" :expand-all="galleryExpandAll" />
        </KPanel>
      </div>
      <div class="kit__caption mono">остання дія: {{ lastAction || '—' }}</div>
    </section>

    <!-- 06 — log blocks -->
    <section class="kit__section">
      <div class="kit__label">06 · Блоки логу</div>
      <div class="kit__logblocks">
        <KLogBlock v-for="(e, i) in logSamples" :key="i" :entry="e" session-id="kit-demo" :expand-all="galleryExpandAll" />
      </div>
    </section>

    <!-- 07 — window chrome: rail & status bar -->
    <section class="kit__section">
      <div class="kit__label">07 · Рейка та рядок стану</div>
      <div class="kit__rail">
        <KRailItem
          v-for="r in railProjects"
          :key="r.project.id"
          :project="r.project"
          :active="r.active"
          :count="r.count"
        />
        <KUserButton label="oleksii-motornyi" title="@oleksii-motornyi · вийти" />
      </div>
      <div class="kit__caption mono">
        Плитка проєкту 44×44 · плитка акаунта 34×34 у підніжжі рейки (клік — вихід із
        акаунта). Без картинки з GitHub — ініціали.
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

    <!-- 09 — data table -->
    <section class="kit__section">
      <div class="kit__label">09 · Таблиця агентів</div>
      <KTable
        class="kit__table"
        :columns="agentColumns"
        :rows="tableSessions"
        :row-key="(s) => s.id"
        :selected-key="tableSelected"
        :row-class="(s) => (s.status === 'thinking' || s.status === 'tool' ? 'kit__row--running' : undefined)"
        clickable
        @row-click="tableSelected = $event.id"
      >
        <template #cell-status="{ row }">
          <span class="kit__cell-status">
            <KStatusDot :status="row.status" />
            <span class="mono">{{ row.status }}</span>
          </span>
        </template>
        <template #cell-name="{ row }">
          <strong>{{ row.name }}</strong>
        </template>
        <template #cell-branch="{ row }">
          <KTag>⑂ {{ row.branch }}</KTag>
        </template>
        <template #cell-ctx="{ row }">
          {{ row.contextPercent != null ? row.contextPercent + '%' : '—' }}
        </template>
        <template #cell-activity="{ row }">
          <span class="mono">{{ row.currentTool ?? '—' }}</span>
        </template>
        <template #cell-actions="{ row }">
          <div class="kit__cell-actions">
            <KIconButton title="Превʼю" @click.stop="onTableAction(row.id + ':preview')">▶</KIconButton>
            <KIconButton title="Завершити" @click.stop="onTableAction(row.id + ':finish')">✓</KIconButton>
            <KIconButton title="Відкласти" @click.stop="onTableAction(row.id + ':archive')">⤓</KIconButton>
          </div>
        </template>
      </KTable>
      <div class="kit__caption mono">вибрано: {{ tableSelected }} · дія: {{ lastTableAction || '—' }}</div>
    </section>

    <!-- v3 navigation + tabs -->
    <section class="kit__section">
      <div class="kit__label">05 · Навігація v3</div>
      <div class="kit__row"><KTopNav v-model="topNav" :options="topNavOptions" /></div>
      <div class="kit__row" style="margin-top: var(--k-sp-3)"><KTabs v-model="detailTab" :tabs="detailTabs" /></div>
      <div class="kit__sidebar">
        <KNavItem label="Активні" :count="3" :active="navActive === 'active'" @click="navActive = 'active'" />
        <KNavItem label="Задачі" :count="5" :active="navActive === 'tasks'" @click="navActive = 'tasks'" />
        <KNavItem label="Відкладені" :count="12" :active="navActive === 'archived'" @click="navActive = 'archived'" />
        <KNavItem label="Історія" :active="navActive === 'history'" @click="navActive = 'history'" />
      </div>
    </section>

    <!-- session cards -->
    <section class="kit__section">
      <div class="kit__label">06 · Картки сесій</div>
      <div class="kit__cards">
        <KSessionCard
          v-for="(c, i) in sessionCards" :key="c.branch"
          :branch="c.branch" :time="c.time"
          :status="c.status" :status-line="c.statusLine" :selected="i === 0"
          :model="c.model" :usage="c.usage"
        />
      </div>
    </section>

    <!-- kanban -->
    <section class="kit__section">
      <div class="kit__label">07 · Дошка (kanban)</div>
      <div class="kit__kanban">
        <KKanbanColumn label="Беклог" :count="2">
          <KKanbanCard title="ротація ключів у Keychain" branch="feature/keychain-rotate" project="Backend-core" time="1 дн" status="backlog" />
          <KKanbanCard title="скорочення шляху в топбарі" branch="chore/path-ellipsis" project="FE-kit" time="4 дн" status="backlog" />
        </KKanbanColumn>
        <KKanbanColumn label="В роботі" :count="1">
          <KKanbanCard title="rate limiting на /v1/messages" branch="feature/rate-limit" project="Backend-core" time="2 хв" status="thinking" />
        </KKanbanColumn>
      </div>
    </section>

    <!-- chat + thought -->
    <section class="kit__section">
      <div class="kit__label">08 · Чат</div>
      <KChatMessage role="user">Чому drag інколи падає не в ту клітинку?</KChatMessage>
      <KThoughtToggle label="Думав 8с" :open="thoughtOpen" @toggle="thoughtOpen = !thoughtOpen">
        Ціль дропа рахується проти геометрії на початку перетягування, а не поточної.
      </KThoughtToggle>
      <KChatMessage role="assistant">Дерево панелей ще старе на момент drop — перерахуй рамки на drag move.</KChatMessage>
    </section>

    <!-- composer -->
    <section class="kit__section">
      <div class="kit__label">09 · Композер</div>
      <KComposer v-model="composerDraft" model="opus-5" :worktree="true" :token-count="31600" @send="() => {}" />
    </section>
  </main>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type {
  SessionStatus, Session, TranscriptEntry, RpcExtensionUIResponse, Usage,
} from '@kermanych/core';
import { EXPAND_ALL_NONE, nextExpandAll, type ExpandAllCommand } from '../lib/expand-all';
import KBtn from 'components/kit/KBtn.vue';
import KIconButton from 'components/kit/KIconButton.vue';
import KTag from 'components/kit/KTag.vue';
import KStatusDot from 'components/kit/KStatusDot.vue';
import KField from 'components/kit/KField.vue';
import KToggle from 'components/kit/KToggle.vue';
import KModal from 'components/kit/KModal.vue';
import KPanel from 'components/kit/KPanel.vue';
import KLogBlock from 'components/kit/KLogBlock.vue';
import KRailItem, { type RailProject } from 'components/kit/KRailItem.vue';
import KUserButton from 'components/kit/KUserButton.vue';
import KStatusBar from 'components/kit/KStatusBar.vue';
import KTable, { type KTableColumn } from 'components/kit/KTable.vue';
import KTopNav from 'components/kit/KTopNav.vue';
import KNavItem from 'components/kit/KNavItem.vue';
import KSessionCard from 'components/kit/KSessionCard.vue';
import KKanbanColumn from 'components/kit/KKanbanColumn.vue';
import KKanbanCard from 'components/kit/KKanbanCard.vue';
import KChatMessage from 'components/kit/KChatMessage.vue';
import KThoughtToggle from 'components/kit/KThoughtToggle.vue';
import KTabs from 'components/kit/KTabs.vue';
import KComposer from 'components/kit/KComposer.vue';

const topNav = ref('agents');
const topNavOptions = [
  { value: 'agents', label: 'Агенти' },
  { value: 'board', label: 'Дошка' },
  { value: 'chat', label: 'Чат' },
];
const navActive = ref('active');
const detailTab = ref('log');
const detailTabs = [
  { value: 'log', label: 'Лог' },
  { value: 'changes', label: 'Зміни' },
  { value: 'session', label: 'Сесія' },
];
const composerDraft = ref('');
const thoughtOpen = ref(false);
// The last row deliberately carries neither model nor usage: an agent whose turns were
// never counted drops the accounting line rather than printing a zero.
const sessionCards: { branch: string; title: string; time: string; status: SessionStatus; statusLine: string; model?: string; usage?: Usage }[] = [
  { branch: 'feature/rate-limit', title: 'rate limiting на /v1/messages', time: '2 хв', status: 'thinking', statusLine: 'працює · 12 кроків', model: 'opus-5', usage: { input: 18_400, output: 9_200, cacheRead: 1_240_000, cacheWrite: 62_000, cost: 3.18 } },
  { branch: 'refactoring/session-store', title: 'обʼєднати сесії', time: '14 хв', status: 'waiting_input', statusLine: 'чекає · потрібне рішення', model: 'sonnet-4.5', usage: { input: 2_100, output: 640, cacheRead: 31_000, cacheWrite: 4_800, cost: 0.004 } },
  { branch: 'fix/remove-button', title: 'remove + button', time: '1 год', status: 'merged', statusLine: 'влито · 2 файли +41 −12', model: 'haiku', usage: { input: 900, output: 310, cacheRead: 0, cacheWrite: 0, cost: 0.02 } },
  { branch: 'chore/ci-node-22', title: 'node 22 в CI', time: '1 дн', status: 'done', statusLine: 'готово · без тесту' },
];

const swatches = [
  { var: '--k-canvas' }, { var: '--k-bg' }, { var: '--k-surface' }, { var: '--k-surface2' },
  { var: '--k-text' }, { var: '--k-muted' }, { var: '--k-faint' },
  { var: '--k-accent' }, { var: '--k-success' }, { var: '--k-warning' }, { var: '--k-danger' },
];
const typeScale = [
  { var: '--k-fs-lg', label: 'Заголовок екрана 18' },
  { var: '--k-fs-md', label: 'Заголовок 15' },
  { var: '--k-fs-base', label: 'Основний текст 13' },
  { var: '--k-fs-sm', label: 'Другорядний 12' },
  { var: '--k-fs-xs', label: 'Мета 11' },
];
const radii = [
  { var: '--k-r-sm' }, { var: '--k-r' }, { var: '--k-r-lg' }, { var: '--k-r-pill' },
];

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
// Sessions carry ISO strings; transcript entries carry epoch millis.
const nowMs = Date.now();
function mkSession(over: Partial<Session>): Session {
  return {
    id: 's', projectId: 'p1', name: 'api-gateway', task: '',
    worktreePath: '', worktree: true, branch: 'main', kind: 'agent', status: 'thinking', createdAt: now, lastActivityAt: now, ...over,
  };
}
const runningSession = mkSession({ id: 's1', status: 'thinking', branch: 'main', model: 'opus-5', contextPercent: 42, usage: { input: 18_400, output: 9_200, cacheRead: 1_240_000, cacheWrite: 62_000, cost: 3.18 } });
const stalledSession = mkSession({ id: 's3', status: 'thinking', branch: 'feat/wedged', lastEventAt: Date.now() - 90_000 });
const waitingSession = mkSession({
  id: 's2', status: 'waiting_input', branch: 'feat/schema',
  pendingUiRequest: {
    type: 'extension_ui_request', id: 'req-1', method: 'select',
    title: 'Куди звести логіку сесії?',
    options: ["Об'єднати в session.ts", 'Лишити як є, додати тест'],
  },
});
const agentColumns: KTableColumn[] = [
  { key: 'status', label: 'Статус', width: '132px' },
  { key: 'name', label: 'Агент' },
  { key: 'branch', label: 'Гілка', width: '150px' },
  { key: 'ctx', label: 'Контекст', align: 'right', width: '96px', mono: true },
  { key: 'activity', label: 'Активність' },
  { key: 'actions', label: '', align: 'right', width: '96px' },
];
const tableSessions: Session[] = [
  mkSession({ id: 't1', name: 'api-gateway', status: 'thinking', branch: 'main', currentTool: 'Edit', contextPercent: 42 }),
  mkSession({ id: 't2', name: 'schema-migrate', status: 'waiting_input', branch: 'feat/schema', currentTool: 'Read', contextPercent: 68 }),
  mkSession({ id: 't3', name: 'billing-fix', status: 'done', branch: 'fix/billing', contextPercent: 90 }),
  mkSession({ id: 't4', name: 'web-client', status: 'queued', branch: 'feat/ui', contextPercent: 12 }),
];
const tableSelected = ref('t1');
const lastTableAction = ref('');
function onTableAction(a: string): void { lastTableAction.value = a; }
// Log fixtures use the v2 transcript shape, and deliberately mirror what the core
// reducers actually emit: tool names are the lowercase runtime vocabulary (`read`,
// `edit`, `grep`, `bash` — `KToolCard` keys its wrapping mode off `edit`/`write`),
// `stat` follows each reducer's own format, and every `detail.totalLines` equals the
// lines supplied so no sample offers a «показати всі» button the gallery cannot serve.
// A tiny inline SVG stands in for a pasted screenshot — the catalogue never hits the network.
const sampleImage =
  'data:image/svg+xml;utf8,' +
  '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="110">' +
  '<rect width="180" height="110" fill="%232a2724"/>' +
  '<text x="14" y="60" fill="%238f8b88" font-family="monospace" font-size="11">session.png</text></svg>';
const panelLog: TranscriptEntry[] = [
  { kind: 'user_text', id: '0', at: nowMs, text: 'Зведи ротацію токенів в один запит.' },
  {
    kind: 'tool', id: '1', at: nowMs, tool: 'edit', status: 'ok',
    target: 'auth/token.service.ts', stat: '+1 −0',
    detail: { lines: [{ t: 'add', n: '84', text: '    this.rotateShared(token);' }], totalLines: 1 },
  },
  {
    kind: 'tool', id: '2', at: nowMs, tool: 'bash', status: 'ok',
    target: 'npm run test:e2e -- auth', stat: '8.4 с',
    detail: {
      lines: [
        { t: 'head', text: '$ npm run test:e2e -- auth' },
        { t: 'ctx', text: '12 passed, 0 failed' },
        { t: 'head', text: 'wall 8.4 с' },
      ],
      totalLines: 3,
    },
  },
  { kind: 'assistant_text', id: '3', at: nowMs, text: 'Готово. Ротація токенів зведена в один запит.' },
  // Two operator turns on purpose (kept from dev): the panel's my-message navigation
  // (▲/▼) only appears above a second user message, and the gallery is where that
  // control is documented. It now targets `.k-rb__head`, so a second request block is
  // what makes it visible at all.
  { kind: 'user_text', id: '4', at: nowMs, text: 'Додай тест на прострочений refresh.' },
];
const waitingLog: TranscriptEntry[] = [
  { kind: 'user_text', id: '0', at: nowMs, text: 'Де саме зберігається сесія?' },
  { kind: 'tool', id: '1', at: nowMs, tool: 'read', status: 'pending', target: 'src/session.ts' },
  { kind: 'assistant_text', id: '2', at: nowMs, text: 'Знайшов два місця, де зберігається сесія.' },
];
const logSamples: TranscriptEntry[] = [
  {
    kind: 'user_text', id: '0', at: nowMs,
    text: 'Ось скрин — зведи зберігання сесії в одне місце.',
    images: [sampleImage],
  },
  // A partial read is one of exactly three tools that flag upstream truncation (`read`,
  // `glob`, `grep`); the marker belongs on a row whose reducer can actually set it.
  {
    kind: 'tool', id: '1', at: nowMs, tool: 'read', status: 'ok',
    target: 'routes/login.tsx', stat: '4/145 ln', count: 4,
    detail: {
      lines: [
        { t: 'ctx', n: '1', text: "import { useAuth } from '../auth';" },
        { t: 'ctx', n: '2', text: 'export function Login() {' },
        { t: 'ctx', n: '3', text: '  return <Form onSubmit={useAuth().login} />;' },
        { t: 'ctx', n: '4', text: '}' },
      ],
      totalLines: 4,
      truncatedUpstream: true,
    },
  },
  {
    kind: 'tool', id: '2', at: nowMs, tool: 'edit', status: 'ok',
    target: 'db/schema/users.ts', stat: '+1 −1',
    detail: {
      lines: [
        { t: 'del', n: '17', text: '  seenAt: timestamp("seen_at"),' },
        { t: 'add', n: '17', text: '  lastSeenAt: timestamp("last_seen_at"),' },
      ],
      totalLines: 2,
    },
  },
  // A grep with no hits is the real detail-less row: expanding it shows the empty state.
  { kind: 'tool', id: '3', at: nowMs, tool: 'grep', status: 'ok', target: '/useAuth/ src', stat: '0 збігів', count: 0 },
  {
    kind: 'tool', id: '4', at: nowMs, tool: 'bash', status: 'error',
    target: 'pnpm test', stat: 'exit 1 · 3.2 с',
    detail: {
      lines: [
        { t: 'head', text: '$ pnpm test' },
        { t: 'ctx', text: '2 failing specs' },
        { t: 'head', text: 'wall 3.2 с · exit 1' },
      ],
      totalLines: 3,
    },
  },
  // All three chip forms: both metrics, duration only, tokens only.
  {
    kind: 'assistant_thinking', id: '5', at: nowMs, ms: 12_400, tokens: 1840,
    text: 'Сесія зберігається у двох місцях — треба звести.',
  },
  { kind: 'assistant_thinking', id: '5a', at: nowMs, ms: 4_200, text: 'Лише тривалість — без токенів.' },
  { kind: 'assistant_thinking', id: '5b', at: nowMs, tokens: 320, text: 'Лише токени — без тривалості.' },
  { kind: 'assistant_text', id: '6', at: nowMs, text: '## Знайшов два місця\n\nСесія зберігається у **двох** місцях — треба звести:\n\n- `session.ts` — запис у файл\n- `store.ts` — дубль у памʼяті\n\n```ts\nconst s = load();\n```' },
  { kind: 'notice', id: '7', at: nowMs, level: 'info', text: 'Гілку перемкнено на feat/schema.' },
  { kind: 'notice', id: '8', at: nowMs, level: 'warn', text: 'Контекст заповнено на 82% — скоро потрібне стиснення.' },
  { kind: 'notice', id: '9', at: nowMs, level: 'error', text: 'Сесію зупинено: процес завершився з кодом 1.' },
  // `turn` is ledger data for block summaries — it renders nothing, by design.
  { kind: 'turn', id: '10', at: nowMs, model: 'claude-opus-5', ms: 21_300 },
];
const railProjects: { project: RailProject; active: boolean; count: number }[] = [
  { project: { id: 'p1', name: 'api-gateway', state: 'bound' }, active: true, count: 4 },
  { project: { id: 'p2', name: 'web client', state: 'unbound' }, active: false, count: 0 },
  { project: { id: 'p3', name: 'billing', state: 'orphan' }, active: false, count: 1 },
];
const lastAction = ref('');
// The gallery panels carry the real detail toolbar, so it drives a real command here too
// — a showcase with a dead button showcases the wrong thing.
const galleryExpandAll = ref<ExpandAllCommand>(EXPAND_ALL_NONE);
function onGalleryExpandAll(on: boolean): void {
  galleryExpandAll.value = nextExpandAll(galleryExpandAll.value, on);
}
function onSend(text: string) { lastAction.value = `send: ${text}`; }
function onAnswer(res: RpcExtensionUIResponse) { lastAction.value = `answer: ${JSON.stringify(res)}`; }
function onStop() { lastAction.value = 'stop'; }
function onDelete() { lastAction.value = 'delete'; }
function onRestart() { lastAction.value = 'restart'; }
</script>

<style scoped lang="scss">
.kit__sidebar { display: flex; flex-direction: column; gap: var(--k-sp-1); max-width: 240px; margin-top: var(--k-sp-4); background: var(--k-surface); border: 1px solid var(--k-line); border-radius: var(--k-r-lg); padding: var(--k-sp-2); }
.kit__cards { display: flex; flex-direction: column; gap: var(--k-sp-2); max-width: 340px; }
.kit__kanban { display: flex; gap: var(--k-sp-3); align-items: flex-start; }
.kit__kanban > * { flex: 1; max-width: 280px; }
.kit__swatches { display: flex; flex-wrap: wrap; gap: var(--k-sp-3); }
.kit__swatch { display: flex; flex-direction: column; gap: var(--k-sp-1); align-items: center; }
.kit__chip { width: 56px; height: 40px; border-radius: var(--k-r); border: 1px solid var(--k-line-strong); }
.kit__swatch-name { font-size: var(--k-fs-xs); color: var(--k-muted); }
.kit__typescale { display: flex; flex-direction: column; gap: var(--k-sp-2); margin-top: var(--k-sp-4); color: var(--k-text); }
.kit__type-tag { font-size: var(--k-fs-xs); color: var(--k-faint); }
.kit__radii { display: flex; gap: var(--k-sp-3); margin-top: var(--k-sp-4); }
.kit__radius { width: 72px; height: 48px; background: var(--k-surface); border: 1px solid var(--k-line-strong); display: flex; align-items: center; justify-content: center; font-size: var(--k-fs-xs); color: var(--k-muted); }
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

.kit__cell-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.kit__cell-actions {
  display: inline-flex;
  gap: 4px;
  justify-content: flex-end;
}

// running — accent strip on the row's leading edge (via KTable rowClass).
.kit__table :deep(tr.kit__row--running td:first-child) {
  box-shadow: inset 2px 0 0 0 var(--k-accent);
}
</style>
