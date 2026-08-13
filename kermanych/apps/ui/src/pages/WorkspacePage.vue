<template>
  <main class="ws">
    <!-- No project selected — the rail invites a choice. -->
    <div v-if="!store.selectedGroupId" class="ws__blank">
      <div class="ws__blank-eyebrow mono">КЕРМАНИЧ</div>
      <p class="ws__blank-text">Виберіть проєкт у лівій панелі, щоб побачити його агентів.</p>
    </div>

    <div v-else class="ws__content" ref="contentEl" :class="{ 'ws__content--resizing': resizing }">
      <!-- BOARD — one card per session in the selected group -->
      <section class="ws__board">
        <header class="ws__board-head">
          <div class="ws__board-title">
            <h1 class="ws__heading">{{ selectedGroup?.name ?? 'Проєкт' }}</h1>
          </div>
          <div class="ws__board-controls">
            <KToggle :options="viewOptions" v-model="viewMode" />
            <KBtn variant="primary" @click="openLauncher()">+ Нова задача</KBtn>
          </div>
        </header>

        <KTable
          v-if="groupSessions.length"
          class="ws__table"
          :columns="agentColumns"
          :rows="boardRows"
          :row-key="(s) => s.id"
          :selected-key="store.selectedSessionId"
          :row-class="(s) => (isRunning(s) ? 'ws__row--running' : undefined)"
          clickable
          @row-click="onRowClick"
        >
          <template #cell-status="{ row }">
            <span class="ws__cell-status">
              <KStatusDot :status="row.status" />
              <span class="ws__cell-status-word mono">{{ statusWord(row) }}</span>
            </span>
          </template>
          <template #cell-name="{ row }">
            <span class="ws__cell-name" :class="{ 'ws__cell-name--child': row.kind === 'discussion' }">
              <span v-if="row.kind === 'discussion'" class="ws__branch-connector" aria-hidden="true">└</span>
              {{ row.name }}
              <KTag v-if="row.kind === 'discussion'">discussion</KTag>
              <KTag v-else-if="row.kind === 'task'">задача</KTag>
            </span>
          </template>
          <template #cell-branch="{ row }">
            <KTag v-if="row.branch">⑂ {{ row.branch }}</KTag>
            <span v-else class="mono ws__cell-activity">—</span>
          </template>
          <template #cell-ctx="{ row }">
            {{ ctxOf(row) ?? '—' }}
          </template>
          <template #cell-activity="{ row }">
            <span class="ws__cell-activity mono">{{ activityOf(row) || '—' }}</span>
          </template>
          <template #cell-lastActivity="{ row }">
            <span class="ws__cell-activity mono">{{ relativeTime(row.lastActivityAt, now) }}</span>
          </template>
          <template #cell-actions="{ row }">
            <div class="ws__cell-actions">
              <template v-if="row.kind === 'task'">
                <button
                  type="button"
                  class="ws__card-icon"
                  title="Запустити задачу як агента"
                  @click.stop="openLauncher(row, false)"
                >▶</button>
                <button
                  type="button"
                  class="ws__card-icon"
                  title="Редагувати задачу"
                  @click.stop="openLauncher(row, true)"
                >✎</button>
                <button
                  type="button"
                  class="ws__card-icon"
                  title="Видалити задачу"
                  @click.stop="onDeleteTask(row)"
                >✕</button>
              </template>
              <template v-else-if="row.kind === 'discussion'">
                <button
                  v-if="row.status !== 'merged'"
                  type="button"
                  class="ws__card-icon"
                  title="Влити висновок у батьківського агента"
                  @click.stop="openMerge(row)"
                >⤴</button>
                <button
                  type="button"
                  class="ws__card-icon"
                  title="Викинути гілку"
                  @click.stop="onDiscardRow(row)"
                >✕</button>
              </template>
              <template v-else-if="!showArchived">
                <button
                  type="button"
                  class="ws__card-icon"
                  :class="{ 'ws__card-icon--on': store.previews[row.id] }"
                  :title="store.previews[row.id] ? 'Зупинити превʼю' : 'Превʼю гілки в браузері'"
                  @click.stop="togglePreview(row)"
                >{{ store.previews[row.id] ? '◼' : '▶' }}</button>
                <button
                  v-if="row.status !== 'merged'"
                  type="button"
                  class="ws__card-icon"
                  title="Завершити (merge гілки в проєкт)"
                  @click.stop="openFinish(row)"
                >✓</button>
                <button
                  type="button"
                  class="ws__card-icon"
                  title="Заархівувати"
                  @click.stop="onArchive(row)"
                >⤓</button>
              </template>
              <button
                v-else
                type="button"
                class="ws__card-icon"
                title="Розархівувати"
                @click.stop="onUnarchive(row)"
              >⤒</button>
            </div>
          </template>
        </KTable>
        <div v-else class="ws__empty mono">
          {{ showArchived ? 'Немає заархівованих агентів.' : showTasks ? 'Беклог порожній. Створи задачу через «+ Нова задача».' : 'Ще немає агентів. Запусти першого через «+ Нова задача».' }}
        </div>
      </section>

      <!-- RESIZER — drag the seam to widen / narrow the chat section -->
      <div
        v-if="selectedSession"
        class="ws__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Змінити ширину секції з чатом"
        :aria-valuenow="Math.round(detailWidth)"
        :aria-valuemin="MIN_DETAIL"
        tabindex="0"
        title="Перетягніть, щоб змінити ширину секції з чатом"
        @pointerdown="startResize"
        @keydown="onResizeKeydown"
      ></div>

      <!-- DETAIL — the full panel for the selected session -->
      <aside v-if="selectedSession" class="ws__detail" :style="{ width: detailWidth + 'px' }">
        <div class="ws__detail-bar">
          <span class="ws__detail-label mono">{{ selectedSession.name }}</span>
          <button
            type="button"
            class="ws__close"
            title="Закрити"
            @click="store.selectSession(undefined)"
          >✕</button>
        </div>
        <KPanel
          class="ws__panel"
          :session="selectedSession"
          v-bind="selectedGroup ? { group: selectedGroup } : {}"
          @stop="onStop"
          @delete="onDelete"
          @send="onSend"
          @answer="onAnswer"
          @finish="onFinish"
          @editor="onEditor"
          @branch="onBranch"
          @restart="onRestart"
        >
          <template v-if="entries.length">
            <KLogBlock v-for="(entry, i) in entries" :key="i" :entry="entry" />
          </template>
          <div v-else class="ws__log-empty mono">Журнал порожній.</div>
        </KPanel>
      </aside>
    </div>

    <!-- NEW-AGENT LAUNCHER — opened by the inline button -->
    <KModal v-model="launcherOpen" :title="editingTaskId ? 'Задача' : 'Нова задача'">
      <div class="ws__form">
        <KField v-model="draftName" label="Назва" placeholder="refactor-auth" />
        <label class="ws__field">
          <span class="ws__field-label">Завдання</span>
          <textarea
            ref="taskInput"
            v-model="draftTask"
            class="ws__textarea mono"
            rows="5"
            placeholder="Опиши завдання для агента…"
            @paste="onLaunchPaste"
            @drop.prevent="onLaunchDrop"
            @dragover.prevent
          />
        </label>
        <div class="ws__attach-row">
          <button type="button" class="ws__attach-btn" @click="launchFileInput?.click()">
            📎 Додати зображення
          </button>
          <input
            ref="launchFileInput"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            class="ws__file"
            @change="onLaunchFilePick"
          />
        </div>
        <KAttachStrip v-if="launchImages.length" :images="launchImages" @remove="removeLaunchImage" />
        <p v-if="launchError" class="ws__error" role="alert">{{ launchError }}</p>
        <label class="ws__field">
          <span class="ws__field-label">Префікс гілки</span>
          <KToggle
            :options="prefixOptions"
            :modelValue="draftPrefix"
            @update:modelValue="(v) => (draftPrefix = v as BranchPrefix)"
          />
        </label>
        <div class="ws__field">
          <KCheckbox v-model="draftWorktree" label="Ізолювати у worktree" />
          <p v-if="!draftWorktree" class="ws__hint mono">
            In-place: агент працюватиме в теці проєкту на гілці
            <code class="mono">{{ branchPreview }}</code>. Дерево має бути чистим;
            одночасно лише один in-place-агент.
          </p>
        </div>
        <KField
          v-model="draftModel"
          label="Модель (необовʼязково)"
          placeholder="opus-5"
        />
        <div class="ws__field">
          <KCheckbox v-model="draftAsTask" label="Створити як задачу (не запускати зараз)" />
          <p v-if="draftAsTask" class="ws__hint mono">
            Збережеться в беклозі. Запустиш пізніше через ▶ у вкладці «Задачі».
          </p>
        </div>
        <p v-if="launcherError" class="ws__error" role="alert">{{ launcherError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="launcherOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="!canLaunch" @click="submitLauncher">
          {{ draftAsTask ? 'Зберегти' : 'Запустити' }}
        </KBtn>
      </template>
    </KModal>

    <!-- MERGE — pour a discussion branch's conclusion into its parent -->
    <KModal v-model="mergeOpen" title="Влити гілку в батьківського агента">
      <div class="ws__form">
        <label class="ws__field">
          <span class="ws__field-label">Summary (піде як повідомлення в батьківського агента)</span>
          <textarea
            v-model="mergeSummary"
            class="ws__textarea mono"
            rows="6"
            placeholder="Порожнє — візьму останню відповідь гілки"
          />
        </label>
        <p class="ws__hint mono">
          Батьківський агент отримає це й почне діяти. Гілка стане історією
          (<code class="mono">merged</code>).
        </p>
        <p v-if="mergeError" class="ws__error" role="alert">{{ mergeError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="mergeOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="mergeBusy" @click="submitMerge">⤴ Влити</KBtn>
      </template>
    </KModal>

    <!-- PREVIEW CONFIG — how to run this project's app for a live branch preview -->
    <KModal v-model="previewCfgOpen" title="Налаштувати превʼю">
      <div class="ws__form">
        <label class="ws__field">
          <span class="ws__field-label">Команда web (з $PORT)</span>
          <textarea v-model="draftWebCmd" class="ws__textarea mono" rows="2" />
        </label>
        <label class="ws__field">
          <span class="ws__field-label">Команда api (опційно; отримує PORT)</span>
          <textarea v-model="draftApiCmd" class="ws__textarea mono" rows="2" />
        </label>
        <p class="ws__hint mono">
          Запускається в worktree. web відкриється на автопорті; якщо задано api —
          підніметься першим, а web вкажеться на нього через VITE_API_BASE.
        </p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="previewCfgOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="!draftWebCmd.trim()" @click="submitPreviewConfig">
          Запустити превʼю
        </KBtn>
      </template>
    </KModal>

    <!-- FINISH — merge the session branch into the project branch, retire the worktree -->
    <KModal v-model="finishOpen" title="Завершити сесію" persistent>
      <div class="ws__form">
        <div v-show="finishFiles.length">
          <p class="ws__error" role="alert">
            Конфлікт при злитті — розвʼяжи його у worktree, потім «Влити» ще раз.
          </p>
          <p class="ws__hint mono">Файли з конфліктом:</p>
          <ul class="ws__conflict mono">
            <li v-for="f in finishFiles" :key="f">{{ f }}</li>
          </ul>
          <p class="ws__hint mono">
            Відкрий у редакторі, прибери маркери конфлікту, закоміть — тоді «Влити».
          </p>
        </div>
        <div v-show="!finishFiles.length">
          <p v-if="finishData">
            Влити <code class="mono">{{ finishData.branch }}</code> →
            <code class="mono">{{ finishData.target }}</code>
          </p>
          <p v-if="finishData" class="ws__hint mono">
            {{ finishData.ahead }} комітів{{ finishData.dirty ? ' + незакоммічені зміни (авто-коміт)' : '' }};
            worktree буде прибрано, сесія лишиться як «влито».
          </p>
          <p v-else class="ws__hint mono">Готую…</p>
        </div>
        <p v-if="finishError" class="ws__error" role="alert">{{ finishError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="finishOpen = false">Закрити</KBtn>
        <KBtn v-show="finishFiles.length" variant="secondary" @click="resolveAuto">Вирішити автоматично</KBtn>
        <KBtn
          variant="primary"
          :disabled="finishBusy || (!finishData && !finishFiles.length)"
          @click="submitFinish"
        >{{ finishFiles.length ? 'Спробувати ще' : 'Влити' }}</KBtn>
      </template>
    </KModal>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  type ImageInput,
  type Session,
  type SessionStatus,
  type TranscriptEntry,
  type RpcExtensionUIResponse,
} from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import type { MessageMode } from '../lib/api';
import KPanel from 'components/kit/KPanel.vue';
import KLogBlock from 'components/kit/KLogBlock.vue';
import KStatusDot from 'components/kit/KStatusDot.vue';
import KTag from 'components/kit/KTag.vue';
import KTable, { type KTableColumn } from 'components/kit/KTable.vue';
import KBtn from 'components/kit/KBtn.vue';
import KField from 'components/kit/KField.vue';
import KModal from 'components/kit/KModal.vue';
import KAttachStrip from 'components/kit/KAttachStrip.vue';
import KToggle from 'components/kit/KToggle.vue';
import KCheckbox from 'components/kit/KCheckbox.vue';
import type { BranchPrefix } from '@kermanych/core';
import { useImageAttach } from '../composables/useImageAttach';
import { useNow } from '../composables/useNow';
import { relativeTime } from '../lib/time';
import { useResizableWidth } from '../composables/useResizableWidth';

// The Workspace screen (design-system section 07): the board of session cards
// for the selected group + the full panel for the selected session, plus the
// new-agent launcher. All mutations go through the Pinia store.
const store = useOrchestrator();

const now = useNow();

// Board filter: "Активні" = live/finished agents; "Задачі" = the un-launched backlog;
// "Видалені" = archived. Backlog tasks (status 'backlog') never show under Активні.
const VIEW_ACTIVE = 'Активні';
const VIEW_TASKS = 'Задачі';
const VIEW_ARCHIVED = 'Видалені';
const viewOptions = [VIEW_ACTIVE, VIEW_TASKS, VIEW_ARCHIVED];
const viewMode = ref<string>(VIEW_ACTIVE);
const showArchived = computed(() => viewMode.value === VIEW_ARCHIVED);
const showTasks = computed(() => viewMode.value === VIEW_TASKS);
// Row order for the agents table. Sessions are bucketed into status tiers and
// sorted by creation time within each tier. Ranking by tier — not by the live
// status — is what stops rows from jumping while agents run: every "process
// alive" status (queued/thinking/tool/waiting_input) shares rank 0, so an agent
// flipping between `thinking` and `tool` mid-run never reorders the table. Only
// real lifecycle moves (a run ending, a branch merging) shift a row's tier.
const STATUS_RANK: Record<SessionStatus, number> = {
  backlog: 0,
  queued: 0,
  thinking: 0,
  tool: 0,
  waiting_input: 0,
  error: 1,
  conflict: 1,
  done: 2,
  stopped: 2,
  merged: 3,
};
const groupSessions = computed(() =>
  store.sessions
    .filter((s) => {
      if (s.groupId !== store.selectedGroupId) return false;
      if (showArchived.value) return !!s.archived;
      if (s.archived) return false;
      return showTasks.value ? s.status === 'backlog' : s.status !== 'backlog';
    })
    .sort((a, b) => {
      const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      return byStatus !== 0 ? byStatus : a.createdAt.localeCompare(b.createdAt);
    }),
);

// Board order: each discussion child immediately follows its parent (a one-level
// tree). Orphans (parent filtered out by the archived/group view) still render.
const boardRows = computed<Session[]>(() => {
  const all = groupSessions.value;
  const parents = all.filter((s) => !s.parentSessionId);
  const out: Session[] = [];
  for (const p of parents) {
    out.push(p);
    for (const c of all.filter((s) => s.parentSessionId === p.id)) out.push(c);
  }
  for (const s of all) if (!out.includes(s)) out.push(s);
  return out;
});
const selectedGroup = computed(() =>
  store.groups.find((g) => g.id === store.selectedGroupId),
);
const selectedSession = computed(() =>
  store.sessions.find((s) => s.id === store.selectedSessionId),
);
const entries = computed<TranscriptEntry[]>(() =>
  store.selectedSessionId
    ? store.transcripts[store.selectedSessionId] ?? []
    : [],
);

// ── Resizable chat section ────────────────────────────────────────────────
// The detail column (KPanel = the chat) is drag-resizable via the seam on its
// left edge. Width is clamped so the board keeps at least MIN_BOARD and the
// chat at least MIN_DETAIL, then persisted across reloads.
const MIN_DETAIL = 360;
const MIN_BOARD = 360;
const contentEl = ref<HTMLElement | null>(null);
const {
  width: detailWidth,
  resizing,
  startResize,
  onKeydown: onResizeKeydown,
  refresh: refreshDetailWidth,
} = useResizableWidth({
  storageKey: 'kermanych.ws.detail-width',
  defaultWidth: 560,
  min: MIN_DETAIL,
  edge: 'left',
  max: () =>
    contentEl.value ? contentEl.value.clientWidth - MIN_BOARD : Number.POSITIVE_INFINITY,
});

// Re-clamp once the detail column mounts (the container is measurable by then),
// so a persisted width from a wider viewport can't overflow a narrower one.
watch(
  () => !!selectedSession.value,
  (open) => {
    if (open) void nextTick(refreshDetailWidth);
  },
  { immediate: true },
);

// Columns for the agents table. `status`, `ctx`, `activity`, and `actions` are
// rendered by scoped slots; `name`/`branch` also carry custom cells.
const agentColumns: KTableColumn[] = [
  { key: 'status', label: 'Статус', width: '132px' },
  { key: 'name', label: 'Агент' },
  { key: 'branch', label: 'Гілка', width: '170px' },
  { key: 'ctx', label: 'Контекст', align: 'right', width: '96px', mono: true },
  { key: 'activity', label: 'Активність' },
  { key: 'lastActivity', label: 'Остання активність', width: '120px' },
  { key: 'actions', label: '', align: 'right', width: '84px' },
];

function isRunning(s: Session): boolean {
  return s.status === 'thinking' || s.status === 'tool';
}

// ctx% is already 0–100 as reported by omp — render verbatim, never ×100.
function ctxOf(s: Session): string | undefined {
  return s.contextPercent != null ? `${s.contextPercent.toFixed(0)}%` : undefined;
}

// Card sub-line: the live tool, else the in-progress todo, else the status.
function activityOf(s: Session): string {
  if (s.currentTool) return s.currentTool;
  for (const phase of s.todoPhases ?? []) {
    const task = phase.tasks.find((t) => t.status === 'in_progress');
    if (task) return task.content;
  }
  return '';
}

function statusWord(s: Session): string {
  switch (s.status) {
    case 'thinking':
      return 'думає';
    case 'tool':
      return 'виконує';
    case 'waiting_input':
      return 'чекає';
    case 'done':
      return 'готово';
    case 'error':
      return 'помилка';
    case 'queued':
      return 'у черзі';
    case 'stopped':
      return 'зупинено';
    case 'merged':
      return 'влито';
    case 'conflict':
      return 'конфлікт';
    case 'backlog':
      return 'у беклозі';
    default:
      return s.status;
  }
}

// Lazy-load the transcript the first time a session is opened.
watch(
  () => store.selectedSessionId,
  (id) => {
    if (id && store.transcripts[id] === undefined) {
      void store.loadTranscript(id);
    }
  },
  { immediate: true },
);

// ── New-agent launcher ────────────────────────────────────────────────────
const launcherOpen = ref(false);
const draftName = ref('');
const draftTask = ref('');
const draftModel = ref('');
const prefixOptions: BranchPrefix[] = ['feature', 'fix', 'refactoring', 'chore'];
const draftPrefix = ref<BranchPrefix>('feature');
const draftWorktree = ref(true);
const draftAsTask = ref(false);
const editingTaskId = ref<string | null>(null);
const branchPreview = computed(() => {
  const slug =
    draftName.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';
  return `${draftPrefix.value}/${slug}`;
});
const taskInput = ref<HTMLTextAreaElement | null>(null);
const launcherError = ref<string | null>(null);
const {
  images: launchImages,
  error: launchError,
  onPaste: onLaunchPaste,
  onDrop: onLaunchDrop,
  remove: removeLaunchImage,
  clear: clearLaunchImages,
  addFiles: addLaunchFiles,
} = useImageAttach();
const launchFileInput = ref<HTMLInputElement | null>(null);

function onLaunchFilePick(e: Event): void {
  const input = e.target as HTMLInputElement;
  if (input.files) void addLaunchFiles(input.files);
  input.value = '';
}

const canLaunch = computed(
  () =>
    !!store.selectedGroupId &&
    draftName.value.trim() !== '' &&
    draftTask.value.trim() !== '',
);

function openLauncher(task?: Session, asTask = false): void {
  editingTaskId.value = task?.id ?? null;
  draftName.value = task?.name ?? '';
  draftTask.value = task?.task ?? '';
  draftModel.value = task?.model ?? '';
  draftPrefix.value = task?.prefix ?? 'feature';
  draftWorktree.value = task?.worktree ?? true;
  draftAsTask.value = asTask;
  launcherError.value = null;
  clearLaunchImages();
  launcherOpen.value = true;
  void nextTick(() => taskInput.value?.focus());
}

async function submitLauncher(): Promise<void> {
  const groupId = store.selectedGroupId;
  if (!groupId || !canLaunch.value) return;
  const model = draftModel.value.trim() || undefined;
  const images = launchImages.value.map((i) => ({ data: i.data, mimeType: i.mimeType }));
  const draft = {
    name: draftName.value.trim(),
    task: draftTask.value.trim(),
    model,
    prefix: draftPrefix.value,
    worktree: draftWorktree.value,
  };
  const asTask = draftAsTask.value;
  launcherError.value = null;
  try {
    let session: Session | undefined;
    if (editingTaskId.value) {
      // Editing a backlog task: "Зберегти" keeps it in the backlog; "Запустити" launches it now.
      session = asTask
        ? await store.updateTask(editingTaskId.value, draft)
        : await store.startTask(editingTaskId.value, { ...draft, images });
    } else {
      session = await store.createSession(
        groupId, draft.name, draft.task, model, images, draft.worktree, draft.prefix, asTask,
      );
    }
    launcherOpen.value = false;
    clearLaunchImages();
    // Saved to the backlog → surface it under the Задачі tab; launched → jump to Активні + open its chat.
    if (asTask) {
      viewMode.value = VIEW_TASKS;
    } else {
      viewMode.value = VIEW_ACTIVE;
      if (session?.id) store.selectSession(session.id);
    }
  } catch (e) {
    // Keep the launcher open so the task/name are not lost; show the reason.
    launcherError.value = e instanceof Error ? e.message : String(e);
  }
}

async function onDeleteTask(s: Session): Promise<void> {
  if (!window.confirm(`Видалити задачу «${s.name}»?`)) return;
  try {
    await store.deleteSession(s.id);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

function onRowClick(s: Session): void {
  // A backlog task has no chat to open — clicking it edits the task instead.
  if (s.kind === 'task') openLauncher(s, true);
  else store.selectSession(s.id);
}

// ── Detail panel emits → store actions ───────────────────────────────────
async function onSend(text: string, images: ImageInput[]): Promise<void> {
  const s = selectedSession.value;
  if (!s) return;
  // Done → a fresh follow-up turn; otherwise steer the in-flight turn.
  const mode: MessageMode = s.status === 'done' ? 'follow_up' : 'steer';
  try {
    await store.sendMessage(s.id, text, mode, images);
  } catch (e) {
    // A failed send (e.g. the agent's omp child died and could not be respawned) must be
    // visible, not swallowed — otherwise the chat looks silently stuck.
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

async function onBranch(): Promise<void> {
  const s = selectedSession.value;
  if (!s) return;
  try {
    const child = await store.branchSession(s.id);
    if (child?.id) store.selectSession(child.id);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

function onStop(): void {
  const s = selectedSession.value;
  if (s) void store.stopSession(s.id);
}

async function onRestart(): Promise<void> {
  const s = selectedSession.value;
  if (!s) return;
  try {
    await store.restartSession(s.id);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

async function onDelete(): Promise<void> {
  const s = selectedSession.value;
  if (!s) return;
  if (!window.confirm(`Видалити агента «${s.name}»?`)) return;
  await store.deleteSession(s.id);
  if (store.selectedSessionId === s.id) store.selectSession(undefined);
}

function onAnswer(res: RpcExtensionUIResponse): void {
  const s = selectedSession.value;
  if (s) void store.answerUi(s.id, res);
}

// Active = agent mid-work or awaiting input; archiving these is refused (the API also
// enforces it via core's ACTIVE_STATUSES). The UI keeps its own set, like MainLayout's RUNNING.
const ACTIVE_STATUSES: readonly Session['status'][] = ['queued', 'thinking', 'tool', 'waiting_input'];

// ── Archive / unarchive ────────────────────────────────────────────────────
// Active agents can't be archived: pre-check and toast (the API also enforces).
async function onArchive(s: Session): Promise<void> {
  if (ACTIVE_STATUSES.includes(s.status)) {
    store.notify('Архівація активного агента неможлива', 'error');
    return;
  }
  try {
    await store.archiveSession(s.id);
    if (store.selectedSessionId === s.id) store.selectSession(undefined);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

async function onUnarchive(s: Session): Promise<void> {
  try {
    await store.unarchiveSession(s.id);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

// ── Finish (merge session branch → project branch, retire worktree) ────────
const finishOpen = ref(false);
const finishFor = ref<Session | null>(null);
const finishData = ref<{ branch: string; target: string; ahead: number; dirty: boolean; conflicts: string[] } | null>(null);
const finishConflict = ref<string[] | null>(null);
const finishError = ref<string | null>(null);
const finishBusy = ref(false);

// Files to resolve: from a just-attempted merge, else the worktree's current state.
const finishFiles = computed(() => finishConflict.value ?? finishData.value?.conflicts ?? []);

async function openFinish(s: Session): Promise<void> {
  finishFor.value = s;
  finishData.value = null;
  finishConflict.value = null;
  finishError.value = null;
  finishBusy.value = false;
  finishOpen.value = true;
  try {
    finishData.value = await store.finishInfo(s.id);
  } catch (e) {
    finishError.value = e instanceof Error ? e.message : String(e);
  }
}

function onFinish(): void {
  const s = selectedSession.value;
  if (s) void openFinish(s);
}

function onEditor(): void {
  const s = selectedSession.value;
  if (s) void store.openEditor(s.id).catch(() => {});
}

// ── Merge / discard a discussion branch ──────────────────────────────────
const mergeOpen = ref(false);
const mergeFor = ref<Session | null>(null);
const mergeSummary = ref('');
const mergeBusy = ref(false);
const mergeError = ref<string | null>(null);

function openMerge(s: Session): void {
  mergeFor.value = s;
  mergeError.value = null;
  mergeBusy.value = false;
  const t = store.transcripts[s.id] ?? [];
  const last = [...t].reverse().find((e) => e.kind === 'assistant_text') as
    | { kind: 'assistant_text'; text: string }
    | undefined;
  mergeSummary.value = last?.text ?? '';
  mergeOpen.value = true;
}

async function submitMerge(): Promise<void> {
  const s = mergeFor.value;
  if (!s) return;
  mergeBusy.value = true;
  mergeError.value = null;
  try {
    await store.mergeBranch(s.id, mergeSummary.value.trim() || undefined);
    mergeOpen.value = false;
    if (s.parentSessionId) store.selectSession(s.parentSessionId);
  } catch (e) {
    mergeError.value = e instanceof Error ? e.message : String(e);
  } finally {
    mergeBusy.value = false;
  }
}

function onDiscardRow(s: Session): void {
  if (!window.confirm(`Викинути гілку «${s.name}»? Розмову буде втрачено.`)) return;
  void store.deleteSession(s.id).then(() => {
    if (store.selectedSessionId === s.id) store.selectSession(undefined);
  });
}

async function resolveAuto(): Promise<void> {
  const s = finishFor.value;
  if (!s) return;
  try {
    await store.resolveConflict(s.id);
    finishConflict.value = null;
    finishOpen.value = false; // agent resolves in the background — watch it on the card
    store.selectSession(s.id);
  } catch (e) {
    finishError.value = e instanceof Error ? e.message : String(e);
  }
}

async function submitFinish(): Promise<void> {
  const s = finishFor.value;
  if (!s) return;
  finishBusy.value = true;
  finishError.value = null;
  try {
    const res = await store.finishSession(s.id);
    if ('conflict' in res && res.conflict) {
      finishConflict.value = res.files;
    } else {
      finishConflict.value = null;
      finishOpen.value = false;
    }
  } catch (e) {
    finishError.value = e instanceof Error ? e.message : String(e);
  } finally {
    finishBusy.value = false;
  }
}

// ── Live preview (per-session worktree app on a free port) ─────────────────
const LOADING_HTML =
  '<p style="font:14px system-ui;padding:24px;color:#888">Піднімаю превʼю гілки… (перший раз довше — встановлення залежностей).</p>';
const DEFAULT_WEB_CMD = 'cd kermanych && pnpm --filter @kermanych/ui dev';
// Fresh worktrees carry no build output (dist is gitignored), so build the shared
// core and the api before starting it — otherwise `node dist/main.js` is MODULE_NOT_FOUND.
const DEFAULT_API_CMD =
  'cd kermanych && pnpm install && pnpm --filter @kermanych/core build && pnpm --filter @kermanych/api build && pnpm --filter @kermanych/api start';
const previewCfgOpen = ref(false);
const previewCfgSession = ref<Session | null>(null);
const draftWebCmd = ref('');
const draftApiCmd = ref('');

async function launchInto(win: Window | null, s: Session): Promise<void> {
  try {
    const res = await store.startPreview(s.id);
    if (res.needsCommand) {
      win?.close();
      openPreviewConfig(s);
      return;
    }
    if (res.url && win) win.location.href = res.url;
    else win?.close();
  } catch (e) {
    win?.close();
    window.alert(`Превʼю не запустилось: ${e instanceof Error ? e.message : String(e)}`);
    openPreviewConfig(s, true); // reopen prefilled with working defaults so the user can fix it
  }
}

async function togglePreview(s: Session): Promise<void> {
  if (store.previews[s.id]) {
    await store.stopPreview(s.id);
    return;
  }
  const g = store.groups.find((x) => x.id === s.groupId);
  if (!g?.previewCommand) {
    openPreviewConfig(s);
    return;
  }
  const win = window.open('', '_blank');
  win?.document.write(LOADING_HTML);
  await launchInto(win, s);
}

function openPreviewConfig(s: Session, forceDefaults = false): void {
  previewCfgSession.value = s;
  const g = store.groups.find((x) => x.id === s.groupId);
  draftWebCmd.value = (forceDefaults ? '' : g?.previewCommand ?? '') || DEFAULT_WEB_CMD;
  draftApiCmd.value = (forceDefaults ? '' : g?.apiCommand ?? '') || DEFAULT_API_CMD;
  previewCfgOpen.value = true;
}

async function submitPreviewConfig(): Promise<void> {
  const s = previewCfgSession.value;
  if (!s) return;
  const win = window.open('', '_blank');
  win?.document.write(LOADING_HTML);
  previewCfgOpen.value = false;
  try {
    const patch: { previewCommand: string; apiCommand?: string } = {
      previewCommand: draftWebCmd.value.trim(),
    };
    const apiCmd = draftApiCmd.value.trim();
    if (apiCmd) patch.apiCommand = apiCmd;
    await store.updateGroup(s.groupId, patch);
  } catch (e) {
    win?.close();
    window.alert(`Не вдалось зберегти: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  await launchInto(win, s);
}
</script>

<style scoped lang="scss">
// Fixed header (48px) + footer (30px) are overlaid by the Quasar layout; the
// workspace fills exactly the space between them.
.ws {
  height: calc(100vh - 78px);
  overflow: hidden;
}

// ── Blank / no-project state ──────────────────────────────────────────────
.ws__blank {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 10px;
  padding: 0 40px;
}

.ws__blank-eyebrow {
  font-size: 11px;
  letter-spacing: 0.2em;
  color: var(--k-muted);
}

.ws__blank-text {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: 15px;
  color: var(--k-muted);
}

// ── Board + detail split ──────────────────────────────────────────────────
.ws__content {
  display: flex;
  height: 100%;
  min-height: 0;
}

// While dragging the seam, force the resize cursor everywhere and kill text
// selection so a fast drag doesn't highlight the board or the log.
.ws__content--resizing,
.ws__content--resizing * {
  cursor: col-resize !important;
  user-select: none;
}

// The draggable seam between the board and the chat section. It stands in for
// the detail column's old static left border: a faint line by default, accent
// on hover / focus / active drag.
.ws__resizer {
  flex: none;
  width: 7px;
  position: relative;
  z-index: 3;
  padding: 0;
  border: none;
  background: transparent;
  cursor: col-resize;
  touch-action: none;
  user-select: none;
}

.ws__resizer::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 2px;
  transform: translateX(-50%);
  background: var(--k-line-strong);
  transition: background 0.12s;
}

.ws__resizer:hover::before,
.ws__resizer:focus-visible::before,
.ws__content--resizing .ws__resizer::before {
  background: var(--k-accent);
}

.ws__resizer:focus-visible {
  outline: none;
}

.ws__board {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 22px 24px 28px;
}

.ws__board-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 20px;
}

.ws__board-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.ws__heading {
  margin: 4px 0 0;
  text-align: left;
  font-family: var(--k-font-ui);
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.01em;
  color: var(--k-text);
}

// ── Agents table ──────────────────────────────────────────────────────────
.ws__cell-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.ws__cell-status-word {
  font-size: 11px;
  color: var(--k-muted);
  white-space: nowrap;
}

.ws__cell-name--child { padding-left: 6px; color: var(--k-muted); }
.ws__branch-connector { color: var(--k-accent); margin-right: 4px; }

.ws__cell-name {
  font-family: var(--k-font-ui);
  font-size: 14px;
  font-weight: 700;
  color: var(--k-text);
}

.ws__cell-activity {
  display: inline-block;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--k-muted);
  vertical-align: middle;
}

.ws__cell-actions {
  display: inline-flex;
  gap: 4px;
  justify-content: flex-end;
}

// running — accent strip on the row's leading edge (mirrors the card).
.ws__table :deep(tr.ws__row--running td:first-child) {
  box-shadow: inset 2px 0 0 0 var(--k-accent);
}

.ws__card-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--k-line);
  background: transparent;
  color: var(--k-muted);
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  border-radius: 0;
}

.ws__card-icon:hover {
  border-color: var(--k-text);
  color: var(--k-text);
}

.ws__card-icon--on {
  border-color: var(--k-accent);
  color: var(--k-accent);
}

.ws__hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--k-muted);
}

.ws__empty {
  padding: 24px 2px;
  font-size: 13px;
  color: var(--k-muted);
}

// ── Detail column ─────────────────────────────────────────────────────────
.ws__detail {
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

.ws__detail-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  height: 34px;
  padding: 0 6px 0 14px;
  background: var(--k-bg);
  border-bottom: 2px solid var(--k-line-strong);
  flex: none;
}

.ws__detail-label {
  font-size: 12px;
  color: var(--k-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws__close {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--k-muted);
  font-size: 13px;
  cursor: pointer;

  &:hover {
    color: var(--k-text);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: -1px;
  }
}

.ws__panel {
  flex: 1;
  min-height: 0;
}

.ws__log-empty {
  font-size: 12px;
  color: var(--k-muted);
}

// ── Launcher form ─────────────────────────────────────────────────────────
.ws__form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.ws__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-family: var(--k-font-ui);
}

.ws__field-label {
  text-align: left;
  font-size: 13px;
  color: var(--k-text);
}

.ws__textarea {
  font-family: var(--k-font-mono);
  font-size: 13px;
  line-height: 1.5;
  color: var(--k-text);
  background: var(--k-surface);
  border: 1px solid var(--k-line-strong);
  padding: 9px 11px;
  border-radius: 0;
  outline: none;
  resize: vertical;
  transition: border-color 0.12s, box-shadow 0.12s;

  &::placeholder {
    color: var(--k-muted);
  }

  &:focus {
    border-color: var(--k-accent);
    box-shadow: inset 0 0 0 1px var(--k-accent);
  }
}

.ws__error {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--k-accent);
}

.ws__attach-row {
  display: flex;
}

.ws__attach-btn {
  padding: 6px 10px;
  background: var(--k-surface2);
  border: 1px solid var(--k-line-strong);
  color: var(--k-text);
  font-family: var(--k-font-ui);
  font-size: 12px;
  cursor: pointer;
  border-radius: 0;
}

.ws__attach-btn:hover {
  border-color: var(--k-text);
}

.ws__file {
  display: none;
}
</style>
