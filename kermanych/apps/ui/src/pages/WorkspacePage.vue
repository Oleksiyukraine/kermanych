<template>
  <main class="ws">
    <!-- No project selected — the rail invites a choice. -->
    <div v-if="!store.selectedProjectId" class="ws__blank">
      <div class="ws__blank-eyebrow mono">КЕРМАНИЧ</div>
      <p class="ws__blank-text">Виберіть проєкт у лівій панелі, щоб побачити його агентів.</p>
    </div>

    <div v-else class="ws__content" ref="contentEl" :class="{ 'ws__content--resizing': resizing }">
      <!-- BOARD — one card per session in the selected project -->
      <section class="ws__board" :style="{ width: detailWidth + 'px' }">
        <header class="ws__board-head">
          <div class="ws__board-title">
            <span class="ws__bucket-label">{{ bucketLabel }}</span>
            <span class="ws__bucket-count mono">{{ boardRows.length }}</span>
          </div>
          <div class="ws__board-controls">
            <KBtn variant="primary" @click="openLauncher()">Нова задача</KBtn>
          </div>
        </header>

        <div v-if="boardRows.length" class="ws__cards">
          <KSessionCard
            v-for="s in boardRows"
            :key="s.id"
            :branch="s.branch"
            :time="relativeTime(s.lastActivityAt, now)"
            :status="s.status"
            :status-line="activityOf(s) || statusWord(s)"
            :model="s.model"
            :usage="s.usage"
            :selected="store.selectedSessionId === s.id"
            @click="onRowClick(s)"
          />
        </div>
        <div v-else class="ws__empty mono">
          {{ showArchived ? 'Немає відкладених агентів.' : showTasks ? 'Беклог порожній. Створи задачу через «Нова задача».' : showHistory ? 'Історія порожня.' : 'Ще немає агентів. Запусти першого через «Нова задача».' }}
        </div>
      </section>

      <!-- RESIZER — drag the seam to widen / narrow the chat section -->
      <div
        class="ws__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Змінити ширину секції з чатом"
        :aria-valuenow="Math.round(detailWidth)"
        :aria-valuemin="MIN_DETAIL"
        tabindex="0"
        v-tip="'Перетягніть, щоб змінити ширину секції з чатом'"
        @pointerdown="startResize"
        @keydown="onResizeKeydown"
      ></div>

      <!-- DETAIL — the full panel for the selected session -->
      <aside class="ws__detail">
        <template v-if="selectedSession">
        <div class="ws__detail-bar">
          <span class="ws__detail-label mono">{{ selectedSession.name }}</span>
          <button
            type="button"
            class="ws__close"
            v-tip="'Закрити'"
            aria-label="Закрити"
            @click="store.selectSession(undefined)"
          >✕</button>
        </div>
        <KTabs v-model="detailTab" :tabs="detailTabs" class="ws__detail-tabs" />
        <div v-show="detailTab === 'log'" class="ws__tabpane ws__tabpane--log">
          <KPanel
            class="ws__panel"
            :session="selectedSession"
            :refreshing="refreshingId === selectedSession.id"
            @stop="onStop"
            @delete="onDelete"
            @send="onSend"
            @answer="onAnswer"
            @finish="onFinish"
            @editor="onEditor"
            @branch="onBranch"
            @restart="onRestart"
            @refresh="onRefreshChat"
            @summary="onSummary"
            @reopen="onReopenSelected"
            @newTask="openTaskFromText"
            @expand-all="onExpandAll"
          >
            <template v-if="blocks.length">
              <KRequestBlock
                v-for="(block, i) in blocks"
                :key="selectedSession.id + ':' + block.id"
                :block="block"
                :session-id="selectedSession.id"
                :open="i === blocks.length - 1"
                :expand-all="expandAll"
              />
            </template>
            <div v-else class="ws__log-empty mono">Журнал порожній.</div>
          </KPanel>
        </div>
        <div v-if="detailTab === 'changes'" class="ws__tabpane ws__changes">
          <p v-if="changesLoading" class="ws__log-empty mono">Готую…</p>
          <p v-else-if="changesError" class="ws__error" role="alert">{{ changesError }}</p>
          <template v-else-if="changesInfo">
            <div class="ws__changes-summary mono">
              <span class="ws__changes-branch">{{ changesInfo.branch }} → {{ changesInfo.target || '—' }}</span>
              <span>{{ changesInfo.ahead }} комітів</span>
              <span v-if="changesInfo.dirty" class="ws__changes-dirty">незакоммічені зміни</span>
            </div>
            <ul v-if="changesInfo.conflicts.length" class="ws__conflict mono">
              <li class="ws__conflict-head">Конфлікти:</li>
              <li v-for="f in changesInfo.conflicts" :key="f">{{ f }}</li>
            </ul>
            <ul v-if="changesInfo.files.length" class="ws__file-list">
              <li v-for="f in changesInfo.files" :key="f.path" class="ws__file-row">
                <span class="ws__file-path mono">{{ f.path }}</span>
                <span class="ws__file-stat mono">
                  <span class="ws__diff-add">+{{ f.added }}</span>
                  <span class="ws__diff-del">−{{ f.removed }}</span>
                </span>
              </li>
            </ul>
            <p v-else class="ws__log-empty mono">Немає змінених файлів.</p>
          </template>
        </div>
        <div v-if="detailTab === 'session'" class="ws__tabpane ws__session">
          <dl class="ws__meta">
            <div class="ws__meta-row">
              <dt class="ws__meta-label">Статус</dt>
              <dd class="ws__meta-value">
                <KStatusDot :status="selectedSession.status" />
                <span class="mono">{{ statusWord(selectedSession) }}</span>
              </dd>
            </div>
            <div class="ws__meta-row">
              <dt class="ws__meta-label">Модель</dt>
              <dd class="ws__meta-value mono">{{ selectedSession.model || '—' }}</dd>
            </div>
            <div class="ws__meta-row">
              <dt class="ws__meta-label">Гілка</dt>
              <dd class="ws__meta-value mono">{{ selectedSession.branch || '—' }}</dd>
            </div>
            <div class="ws__meta-row">
              <dt class="ws__meta-label">Worktree</dt>
              <dd class="ws__meta-value mono">{{ selectedSession.worktree ? 'так' : 'ні' }}</dd>
            </div>
            <div class="ws__meta-row">
              <dt class="ws__meta-label">База</dt>
              <dd class="ws__meta-value mono">{{ selectedSession.baseBranch || '—' }}</dd>
            </div>
            <div class="ws__meta-row">
              <dt class="ws__meta-label">Контекст</dt>
              <dd class="ws__meta-value mono">{{ ctxOf(selectedSession) ?? '—' }}</dd>
            </div>
            <div class="ws__meta-row">
              <dt class="ws__meta-label">Токени</dt>
              <dd class="ws__meta-value mono">{{ tokenTotal ?? '—' }}</dd>
            </div>
            <div class="ws__meta-row">
              <dt class="ws__meta-label">Вартість</dt>
              <dd class="ws__meta-value mono">{{ costLabel || '—' }}</dd>
            </div>
          </dl>
          <div class="ws__actions">
            <template v-if="selectedSession.kind === 'discussion' || selectedSession.kind === 'review'">
              <KIconButton
                v-if="selectedSession.status !== 'merged'"
                :title="selectedSession.kind === 'review' ? 'Віддати висновок ревізора виконавцю' : 'Влити висновок у батьківського агента'"
                @click="openMerge(selectedSession)"
              >⤴</KIconButton>
              <KIconButton
                :title="selectedSession.kind === 'review' ? 'Викинути ревізію' : 'Викинути гілку'"
                @click="onDiscardRow(selectedSession)"
              >✕</KIconButton>
            </template>
            <template v-else-if="!showArchived">
              <KIconButton
                :active="!!store.previews[selectedSession.id]"
                :disabled="!isBoundFor(selectedSession.projectId)"
                :title="
                  !isBoundFor(selectedSession.projectId)
                    ? BIND_HINT
                    : store.previews[selectedSession.id]
                      ? 'Зупинити превʼю'
                      : 'Превʼю гілки в браузері'
                "
                @click="togglePreview(selectedSession)"
              >{{ store.previews[selectedSession.id] ? '◼' : '▶' }}</KIconButton>
              <KIconButton
                v-if="canReview(selectedSession)"
                title="Запросити ревізора (незалежний аудит гілки)"
                @click="onReview(selectedSession)"
              >⚖</KIconButton>
              <KIconButton
                v-if="selectedSession.status !== 'merged'"
                title="Завершити (merge гілки в проєкт)"
                @click="openFinish(selectedSession)"
              >✓</KIconButton>
              <KIconButton
                v-if="selectedSession.status === 'merged'"
                title="Відновити (підняти worktree заново, щоб продовжити)"
                @click="onReopen(selectedSession)"
              >↻</KIconButton>
              <KIconButton title="Відкласти" @click="onArchive(selectedSession)">⤓</KIconButton>
              <KIconButton title="Видалити агента" @click="onDeleteAgent(selectedSession)">✕</KIconButton>
            </template>
            <template v-else>
              <KIconButton title="Повернути в активні" @click="onUnarchive(selectedSession)">⤒</KIconButton>
              <KIconButton title="Видалити агента" @click="onDeleteAgent(selectedSession)">✕</KIconButton>
            </template>
          </div>
        </div>
        </template>
        <div v-else class="ws__detail-blank mono">Виберіть сесію зі списку.</div>
      </aside>
    </div>

    <!-- NEW-TASK LAUNCHER — two columns: left = what to do, right = where it lands -->
    <KModal v-model="launcherOpen" :title="launcherTitle" width="880px" flush>
      <template #head-meta>
        <div class="ws-launcher__headmeta">
          <span v-if="selectedProject" class="ws-launcher__tag mono">{{ selectedProject.name }}</span>
          <span class="ws-launcher__spacer"></span>
          <span class="ws-launcher__esc mono">Esc — закрити</span>
        </div>
      </template>

      <div class="ws-launcher" @keydown="onLauncherKeydown">
        <!-- LEFT — the task itself -->
        <div class="ws-launcher__main">
          <div>
            <div class="ws-launcher__label-row">
              <span class="ws-launcher__label ws-launcher__label--strong">Завдання</span>
              <span class="ws-launcher__hint-inline mono">⌘⏎ — запустити</span>
            </div>
            <textarea
              ref="taskInput"
              v-model="draftTask"
              class="ws-launcher__task"
              rows="9"
              placeholder="Що має зробити агент? Один абзац — далі він сам поставить уточнення."
              @paste="onLaunchPaste"
              @drop.prevent="onLaunchDrop"
              @dragover.prevent
            />
          </div>

          <div class="ws-launcher__attach">
            <button type="button" class="ws-launcher__attach-btn mono" @click="launchFileInput?.click()">
              ⛶ Зображення
            </button>
            <input
              ref="launchFileInput"
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              class="ws__file"
              @change="onLaunchFilePick"
            />
            <span class="ws-launcher__attach-note mono">або перетягни сюди</span>
          </div>
          <KAttachStrip v-if="launchImages.length" :images="launchImages" @remove="removeLaunchImage" />
          <p v-if="launchError" class="ws__error" role="alert">{{ launchError }}</p>

          <div class="ws-launcher__name">
            <div class="ws-launcher__label">Назва задачі</div>
            <input
              ref="nameField"
              v-model="draftName"
              class="ws-launcher__name-input"
              placeholder="виводиться із завдання"
              @input="nameEdited = true"
            />
            <div class="ws-launcher__hint mono">
              {{ draftName.trim() ? branchPreview : 'зʼявиться, як напишеш завдання' }}
            </div>
          </div>
        </div>

        <!-- RIGHT — where it lands -->
        <div class="ws-launcher__side">
          <div>
            <div class="ws-launcher__label">Гілка</div>
            <div class="ws-launcher__branch mono">{{ branchPreview }}</div>
            <div class="ws-launcher__hint mono">{{ branchHint }}</div>
          </div>

          <div>
            <div class="ws-launcher__label">Тип</div>
            <div class="ws-launcher__seg ws-launcher__seg--grid2">
              <button
                v-for="opt in prefixOptions"
                :key="opt"
                type="button"
                class="ws-launcher__seg-btn mono"
                :class="{ 'ws-launcher__seg-btn--active': opt === draftPrefix }"
                @click="draftPrefix = opt"
              >{{ opt }}</button>
            </div>
          </div>

          <div>
            <div class="ws-launcher__label-row ws-launcher__label-row--tight">
              <span class="ws-launcher__label">Платформа</span>
              <span class="ws-launcher__optional mono">необовʼязково</span>
            </div>
            <div class="ws-launcher__seg">
              <button
                v-for="opt in platformOptions"
                :key="opt"
                type="button"
                class="ws-launcher__seg-btn mono"
                :class="{ 'ws-launcher__seg-btn--active': opt === draftPlatform }"
                @click="draftPlatform = draftPlatform === opt ? undefined : opt"
              >{{ opt }}</button>
            </div>
          </div>

          <div class="ws-launcher__block ws-launcher__block--stack">
            <div class="ws-launcher__check">
              <KCheckbox v-model="draftWorktree" label="Ізолювати у worktree" />
              <p class="ws-launcher__check-desc">
                Окрема тека, окремий чекаут. Агент не чіпає твій робочий стан.
              </p>
            </div>
            <div v-if="draftWorktree" class="ws-launcher__from">
              <span class="ws-launcher__from-label mono">від</span>
              <KSelect v-model="draftBaseBranch" :options="launchBranches" />
            </div>
          </div>

          <div class="ws-launcher__block">
            <div class="ws-launcher__label">Модель</div>
            <div class="ws-launcher__seg">
              <button
                v-for="opt in modelOptions"
                :key="opt"
                type="button"
                class="ws-launcher__seg-btn mono"
                :class="{ 'ws-launcher__seg-btn--active': opt === draftModel }"
                @click="draftModel = opt"
              >{{ opt }}</button>
            </div>
          </div>
        </div>
      </div>

      <template #controls>
        <div class="ws-launcher__foot">
          <span v-if="launcherError" class="ws__error" role="alert">{{ launcherError }}</span>
          <span v-else class="ws-launcher__foot-hint mono">{{ footHint }}</span>
          <span class="ws-launcher__spacer"></span>
          <KBtn variant="ghost" @click="launcherOpen = false">Скасувати</KBtn>
          <KBtn
            variant="secondary"
            :disabled="!canLaunch"
            @click="submitLauncher(true)"
          >{{ editingTaskId ? 'Зберегти' : 'В беклог' }}</KBtn>
          <KBtn
            variant="primary"
            :disabled="!canLaunch || !isBound"
            :title="isBound ? '' : BIND_HINT"
            @click="submitLauncher(false)"
          >
            Запустити<span class="ws-launcher__kbd mono">⌘⏎</span>
          </KBtn>
        </div>
      </template>
    </KModal>

    <!-- MERGE — pour a discussion branch's conclusion into its parent -->
    <KModal v-model="mergeOpen" :title="mergeIsReview ? 'Віддати висновок ревізора виконавцю' : 'Влити гілку в батьківського агента'">
      <div class="ws__form">
        <label class="ws__field">
          <span class="ws__field-label">Summary (піде як повідомлення в батьківського агента)</span>
          <textarea
            v-model="mergeSummary"
            class="ws__textarea mono"
            rows="6"
            :placeholder="mergeIsReview ? 'Порожнє — візьму висновок ревізора' : 'Порожнє — візьму останню відповідь гілки'"
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
        <KBtn variant="primary" :disabled="mergeBusy" @click="submitMerge">{{ mergeIsReview ? '⤴ Віддати' : '⤴ Влити' }}</KBtn>
      </template>
    </KModal>

    <!-- MOVE TASK — re-parent a backlog task to another project -->
    <KModal v-model="moveOpen" :title="`Перемістити задачу · ${moveFor?.name ?? ''}`">
      <div class="ws__form">
        <p class="ws__hint mono">
          Задача переїде в інший проєкт разом із назвою, промптом і налаштуваннями запуску.
        </p>
        <div class="ws__move-list">
          <button
            v-for="p in moveTargets"
            :key="p.id"
            type="button"
            class="ws__move-option"
            :disabled="moveBusy"
            @click="confirmMove(p.id)"
          >{{ p.name }}</button>
        </div>
        <p v-if="moveError" class="ws__error" role="alert">{{ moveError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="moveOpen = false">Скасувати</KBtn>
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
          v-show="!finishFiles.length"
          variant="secondary"
          :disabled="prBusy || finishBusy || !finishData"
          @click="submitPr"
        >Створити ПР</KBtn>
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
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import {
  slugify,
  buildChatBlocks,
  branchName,
  taskNameFromText,
  type ImageInput,
  type Session,
  type SessionStatus,
  type TranscriptEntry,
  type RpcExtensionUIResponse,
} from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { useBoard } from 'stores/board';
import { useRouter } from 'vue-router';
import { useProjects } from 'stores/projects';
import type { MessageMode } from '../lib/api';
import { EXPAND_ALL_NONE, nextExpandAll, type ExpandAllCommand } from '../lib/expand-all';
import KPanel from 'components/kit/KPanel.vue';
import KRequestBlock from 'components/kit/KRequestBlock.vue';
import KStatusDot from 'components/kit/KStatusDot.vue';
import KSessionCard from 'components/kit/KSessionCard.vue';
import KTabs from 'components/kit/KTabs.vue';
import KBtn from 'components/kit/KBtn.vue';
import KIconButton from 'components/kit/KIconButton.vue';
import KModal from 'components/kit/KModal.vue';
import KAttachStrip from 'components/kit/KAttachStrip.vue';
import KCheckbox from 'components/kit/KCheckbox.vue';
import KSelect from 'components/kit/KSelect.vue';
import type { BranchPrefix, Platform } from '@kermanych/core';
import { useImageAttach } from '../composables/useImageAttach';
import { useNow } from '../composables/useNow';
import { relativeTime } from '../lib/time';
import { tokens, usageTokens, usd } from '../lib/format';
import { useResizableWidth } from '../composables/useResizableWidth';

// The Workspace screen (design-system section 07): the board of session cards
// for the selected project + the full panel for the selected session, plus the
// new-agent launcher. All mutations go through the Pinia store.
const store = useOrchestrator();
// previewCommand/apiCommand are CLOUD config (owner-only), so the write goes to Supabase and
// mirrors itself into the local row — a local-only edit would not survive the next sync.
const projects = useProjects();

const now = useNow();

const board = useBoard();
const router = useRouter();

// Sessions launched from the shared board carry `taskId`; naming the cloud task next to the
// local row is what ties the two boards together. load() — not subscribe() — on purpose:
// Realtime belongs to /board, this page only needs the titles, and load() swallows an
// unreachable cloud into board.loadError instead of toasting on every app open.
onMounted(() => {
  void board.load();
});

// Board buckets mirror the sidebar (MainLayout.bucketCounts): archived wins, then
// backlog → Задачі, then merged/done/stopped → Історія, everything else → Активні
// (error/conflict count as active — they need attention). Driven by store.selectedBucket.
const HISTORY_STATUSES: readonly SessionStatus[] = ['merged', 'done', 'stopped'];
const showArchived = computed(() => store.selectedBucket === 'archived');
const showTasks = computed(() => store.selectedBucket === 'tasks');
const showHistory = computed(() => store.selectedBucket === 'history');
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
const projectSessions = computed(() =>
  store.sessions
    .filter((s) => {
      if (s.projectId !== store.selectedProjectId) return false;
      if (store.selectedBucket === 'archived') return !!s.archived;
      if (s.archived) return false;
      if (store.selectedBucket === 'tasks') return s.status === 'backlog';
      if (store.selectedBucket === 'history') return HISTORY_STATUSES.includes(s.status);
      return s.status !== 'backlog' && !HISTORY_STATUSES.includes(s.status);
    })
    .sort((a, b) => {
      const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      return byStatus !== 0 ? byStatus : a.createdAt.localeCompare(b.createdAt);
    }),
);

// Board order: each discussion child immediately follows its parent (a one-level
// tree). Orphans (parent filtered out by the archived/project view) still render.
const boardRows = computed<Session[]>(() => {
  const all = projectSessions.value.filter((s) => s.kind !== 'chat');
  const parents = all.filter((s) => !s.parentSessionId);
  const out: Session[] = [];
  for (const p of parents) {
    out.push(p);
    for (const c of all.filter((s) => s.parentSessionId === p.id)) out.push(c);
  }
  for (const s of all) if (!out.includes(s)) out.push(s);
  return out;
});
const selectedProject = computed(() =>
  store.projects.find((p) => p.id === store.selectedProjectId),
);

// Requirement 3 in the UI: a task can be created, edited and moved without a binding, but
// nothing that touches the repo may run. `BIND_HINT` is the same string MainLayout uses; both
// copies are the operator's next action, not an apology.
const BIND_HINT = 'Прив’яжіть локальну теку репозиторію';
const isBound = computed(() => !!selectedProject.value?.localRepoPath);

// Row-level check: the board can show sessions of an orphan project whose row is still here
// but whose binding was never made, so per-row actions ask about the row's own project.
function isBoundFor(projectId: string): boolean {
  return !!store.projects.find((p) => p.id === projectId)?.localRepoPath;
}
const selectedSession = computed(() =>
  store.sessions.find((s) => s.id === store.selectedSessionId),
);
const entries = computed<TranscriptEntry[]>(() =>
  store.selectedSessionId
    ? store.transcripts[store.selectedSessionId] ?? []
    : [],
);

// The log is grouped into request blocks: one collapsed summary row per finished
// request. The detail toolbar drives the whole block — muted rows, coalesced groups,
// tool cards and reasoning chains — so it is a command with a sequence number rather
// than a boolean: pressing «стиснути все» while already collapsed still has to collapse
// what the operator opened by hand.
const expandAll = ref<ExpandAllCommand>(EXPAND_ALL_NONE);
function onExpandAll(on: boolean): void {
  expandAll.value = nextExpandAll(expandAll.value, on);
}
// Both row watchers on the command are immediate, and the blocks remount on switch (they
// are keyed on the session id), so a stale «розгорнути все» would be adopted by every row
// of the session the operator just opened. The command is per-session state: reset it.
watch(() => store.selectedSessionId, () => { expandAll.value = EXPAND_ALL_NONE; });
const blocks = computed(() => buildChatBlocks(entries.value));
// The «Сесія» tab's accounting, read off the session row the api keeps rather than summed
// out of the loaded transcript: a forked branch's transcript opens with its parent's turns,
// which it never paid for, and a transcript is only loaded for the session on screen. Both
// figures are absent — not zero — until the agent has taken a turn the api counted.
const tokenTotal = computed(() => {
  const u = selectedSession.value?.usage;
  return u ? `${tokens(usageTokens(u))} ток` : undefined;
});
const costLabel = computed(() => usd(selectedSession.value?.usage?.cost ?? 0));

// ── Resizable chat section ────────────────────────────────────────────────
// The detail column (KPanel = the chat) is drag-resizable via the seam on its
// left edge. Width is clamped so the board keeps at least MIN_BOARD and the
// chat at least MIN_DETAIL, then persisted across reloads.
const MIN_DETAIL = 360;
const MIN_BOARD = 300;
const contentEl = ref<HTMLElement | null>(null);
const {
  width: detailWidth,
  resizing,
  startResize,
  onKeydown: onResizeKeydown,
  refresh: refreshDetailWidth,
} = useResizableWidth({
  storageKey: 'kermanych.ws.board-width',
  defaultWidth: 340,
  min: MIN_BOARD,
  edge: 'right',
  max: () =>
    contentEl.value ? contentEl.value.clientWidth - MIN_DETAIL : Number.POSITIVE_INFINITY,
});

const bucketLabel = computed(() =>
  store.selectedBucket === 'tasks'
    ? 'Задачі'
    : store.selectedBucket === 'archived'
      ? 'Відкладені'
      : store.selectedBucket === 'history'
        ? 'Історія'
        : 'Активні',
);

// Re-clamp once the detail column mounts (the container is measurable by then),
// so a persisted width from a wider viewport can't overflow a narrower one.
watch(
  () => !!selectedSession.value,
  (open) => {
    if (open) void nextTick(refreshDetailWidth);
  },
  { immediate: true },
);

// ── Detail tabs (Лог / Зміни / Сесія) ─────────────────────────────────────
// The right panel splits the session into three views. The choice is persisted
// per session (localStorage `ws.tab.<id>`) so reopening an agent lands where the
// operator left it; a fresh session defaults to the log.
const detailTabs = [
  { value: 'log', label: 'Лог' },
  { value: 'changes', label: 'Зміни' },
  { value: 'session', label: 'Сесія' },
];
const detailTab = ref('log');
watch(
  () => store.selectedSessionId,
  (id) => {
    const saved = id ? localStorage.getItem(`ws.tab.${id}`) : null;
    detailTab.value = saved === 'changes' || saved === 'session' ? saved : 'log';
  },
  { immediate: true },
);
watch(detailTab, (t) => {
  const id = store.selectedSessionId;
  if (id) localStorage.setItem(`ws.tab.${id}`, t);
});

// ── Зміни tab (finishInfo: ahead/dirty/conflicts + changed files) ──────────
// Loaded lazily whenever the changes tab is open for a session; a non-worktree
// session or a git error surfaces as a message rather than throwing.
const changesInfo = ref<Awaited<ReturnType<typeof store.finishInfo>> | null>(null);
const changesError = ref<string | null>(null);
const changesLoading = ref(false);

async function loadChanges(id: string): Promise<void> {
  changesInfo.value = null;
  changesError.value = null;
  changesLoading.value = true;
  try {
    changesInfo.value = await store.finishInfo(id);
  } catch (e) {
    changesError.value = e instanceof Error ? e.message : String(e);
  } finally {
    changesLoading.value = false;
  }
}

watch(
  [() => store.selectedSessionId, detailTab],
  ([id, tab]) => {
    if (tab === 'changes' && id) void loadChanges(id);
  },
  { immediate: true },
);

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
const draftModel = ref('opus-5');
const prefixOptions: BranchPrefix[] = ['feature', 'fix', 'refactoring', 'chore'];
const draftPrefix = ref<BranchPrefix>('feature');
const platformOptions: Platform[] = ['backend', 'web', 'mobile'];
const modelOptions = ['opus-5', 'sonnet-4.5', 'haiku'];
const draftPlatform = ref<Platform | undefined>(undefined);
const draftWorktree = ref(true);
const nameEdited = ref(false);
const draftBaseBranch = ref('');
const launchBranches = ref<string[]>([]);
const editingTaskId = ref<string | null>(null);
const branchPreview = computed(() =>
  draftName.value.trim()
    ? branchName(slugify(draftName.value), draftPrefix.value)
    : `${draftPrefix.value}/…`,
);
// Right-column summary line under the branch box.
const branchHint = computed(() =>
  draftWorktree.value
    ? `нова worktree, чекаут від ${draftBaseBranch.value || selectedProject.value?.defaultBranch || 'HEAD'}`
    : 'in-place у теці проєкту; дерево має бути чистим',
);
const taskInput = ref<HTMLTextAreaElement | null>(null);
const nameField = ref<HTMLInputElement | null>(null);
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
  () => !!store.selectedProjectId && draftName.value.trim() !== '' && draftTask.value.trim() !== '',
);

const launcherTitle = computed(() => (editingTaskId.value ? 'Задача' : 'Нова задача'));
// Footer status: the binding first (it blocks launching outright), then the form nudge,
// then silence once launchable.
const footHint = computed(() => {
  if (!isBound.value) return BIND_HINT;
  return canLaunch.value ? '' : 'опиши завдання, щоб запустити';
});

// The name is derived from the task text until the operator edits it by hand.
watch(draftTask, (t) => {
  if (!nameEdited.value) draftName.value = taskNameFromText(t);
});

// ⌘⏎ / Ctrl+⏎ anywhere in the launcher launches now (never saves to backlog).
function onLauncherKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    if (canLaunch.value && isBound.value) void submitLauncher(false);
  }
}

// Load the project's branches into the fork-base picker. `preferred` is a base already
// chosen on the task being edited; otherwise it falls back to the project default, then
// (after the fetch) to the repo's current HEAD, so the picker always shows a sane base.
async function loadLaunchBranches(preferred: string | undefined): Promise<void> {
  const projectId = store.selectedProjectId;
  launchBranches.value = [];
  draftBaseBranch.value = preferred ?? selectedProject.value?.defaultBranch ?? '';
  if (!projectId || !isBound.value) return;
  try {
    const info = await store.listBranches(projectId);
    launchBranches.value = info.branches;
    if (!draftBaseBranch.value) draftBaseBranch.value = info.default ?? info.current ?? '';
  } catch {
    // Non-fatal: the picker degrades to the preferred/default value only.
  }
}

function openLauncher(task?: Session): void {
  editingTaskId.value = task?.id ?? null;
  draftName.value = task?.name ?? '';
  draftTask.value = task?.task ?? '';
  draftModel.value = task?.model ?? 'opus-5';
  draftPrefix.value = task?.prefix ?? 'feature';
  draftPlatform.value = task?.platform;
  draftWorktree.value = task?.worktree ?? true;
  void loadLaunchBranches(task?.baseBranch);
  nameEdited.value = !!task;
  launcherError.value = null;
  clearLaunchImages();
  launcherOpen.value = true;
  void nextTick(() => taskInput.value?.focus());
}

// Rehydration in flight for this session — the composer's ↻ stays down so a second click
// cannot spawn a second respawn while the first is still talking to omp.
const refreshingId = ref<string | null>(null);

// Turn a transcript text selection into a new backlog task: prefill the launcher
// with the selection as the task body and a name suggested from its first line,
// defaulting to "save to backlog" so a finding is parked rather than run now.
function openTaskFromText(text: string): void {
  editingTaskId.value = null;
  draftName.value = taskNameFromText(text);
  draftTask.value = text;
  draftModel.value = 'opus-5';
  draftPrefix.value = 'feature';
  draftPlatform.value = undefined;
  draftWorktree.value = true;
  void loadLaunchBranches(undefined);
  nameEdited.value = true;
  launcherError.value = null;
  clearLaunchImages();
  launcherOpen.value = true;
  void nextTick(() => nameField.value?.focus());
}

async function submitLauncher(asTask: boolean): Promise<void> {
  const projectId = store.selectedProjectId;
  if (!projectId || !canLaunch.value) return;
  // Saving to the backlog is allowed unbound; starting an agent is not, and the api would
  // refuse it with `project not bound` anyway.
  if (!asTask && !isBound.value) {
    launcherError.value = BIND_HINT;
    return;
  }
  const model = draftModel.value.trim() || undefined;
  const images = launchImages.value.map((i) => ({ data: i.data, mimeType: i.mimeType }));
  const draft = {
    name: draftName.value.trim(),
    task: draftTask.value.trim(),
    model,
    prefix: draftPrefix.value,
    platform: draftPlatform.value,
    worktree: draftWorktree.value,
    baseBranch: draftWorktree.value ? (draftBaseBranch.value || undefined) : undefined,
  };
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
        projectId, draft.name, draft.task, model, images, draft.worktree, draft.prefix, asTask, draft.platform, draft.baseBranch,
      );
    }
    launcherOpen.value = false;
    clearLaunchImages();
    // Saved to the backlog → surface it under the Задачі tab; launched → jump to Активні + open its chat.
    if (asTask) {
      store.setBucket('tasks');
    } else {
      store.setBucket('active');
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
  if (s.kind === 'task') openLauncher(s);
  else store.selectSession(s.id);
}

// ── Detail panel emits → store actions ───────────────────────────────────
// Which omp message mode the session's next message takes. An empty session (a fresh quick
// chat) starts its first turn with a prompt. Otherwise: a settled session gets a fresh
// follow-up; a live one is steered mid-turn.
function nextMode(s: Session): MessageMode {
  const history = store.transcripts[s.id] ?? [];
  const hasTurn = history.some((e) => e.kind === 'user_text' || e.kind === 'assistant_text');
  return !hasTurn ? 'prompt' : s.status === 'done' ? 'follow_up' : 'steer';
}

async function onSend(text: string, images: ImageInput[]): Promise<void> {
  const s = selectedSession.value;
  if (!s) return;
  try {
    await store.sendMessage(s.id, text, nextMode(s), images);
  } catch (e) {
    // A failed send (e.g. the agent's omp child died and could not be respawned) must be
    // visible, not swallowed — otherwise the chat looks silently stuck.
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

// Composer ↻ — wake a dormant session so its history comes back. After an app restart the
// api has no omp child for the session, so the transcript endpoint can only serve a "dormant"
// notice and every chat reads empty; this respawns the child and reloads its transcript
// WITHOUT sending anything, which used to be the only way to trigger the same rehydration.
async function onRefreshChat(): Promise<void> {
  const s = selectedSession.value;
  if (!s || refreshingId.value) return;
  refreshingId.value = s.id;
  try {
    await store.resumeSession(s.id);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    refreshingId.value = null;
  }
}

// Composer ≡ — ask the agent itself to recap, rather than stitching a digest out of the
// transcript locally: it has the whole session in context and can say where the work stands.
// A canned operator message, the same shape as the server-side resolve/PR prompts.
const SUMMARY_PROMPT =
  'Дай коротке саммарі цієї сесії: що зроблено, де ми зараз, що далі. ' +
  'Відповідай українською, стисло. Нічого не змінюй.';

async function onSummary(): Promise<void> {
  const s = selectedSession.value;
  if (!s) return;
  try {
    await store.sendMessage(s.id, SUMMARY_PROMPT, nextMode(s));
  } catch (e) {
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

async function onReview(s: Session): Promise<void> {
  try {
    const review = await store.reviewSession(s.id);
    if (review?.id) store.selectSession(review.id);
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

// Reopen a merged session: the server re-forks its worktree/branch from the base; jump to
// Активні and select it so the operator can continue and finish again.
async function onReopen(s: Session): Promise<void> {
  try {
    const session = await store.reopenSession(s.id);
    store.setBucket('active');
    if (session?.id) store.selectSession(session.id);
    store.notify(`Сесію «${s.name}» відновлено — worktree піднято, можна продовжувати`);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

function onReopenSelected(): void {
  const s = selectedSession.value;
  if (s) void onReopen(s);
}

async function onDelete(): Promise<void> {
  const s = selectedSession.value;
  if (s) await onDeleteAgent(s);
}

// Physical delete (archive teardown + removal): stops the omp process, removes the
// worktree/branch and the registry row, cascading to child branches. Works on any
// status, unlike archive which refuses active agents.
async function onDeleteAgent(s: Session): Promise<void> {
  if (!window.confirm(`Видалити агента «${s.name}»?`)) return;
  try {
    await store.deleteSession(s.id);
    if (store.selectedSessionId === s.id) store.selectSession(undefined);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

function onAnswer(res: RpcExtensionUIResponse): void {
  const s = selectedSession.value;
  if (s) void store.answerUi(s.id, res);
}

// Active = agent mid-work or awaiting input; archiving these is refused (the API also
// enforces it via core's ACTIVE_STATUSES). The UI keeps its own set, like MainLayout's RUNNING.
const ACTIVE_STATUSES: readonly Session['status'][] = ['queued', 'thinking', 'tool', 'waiting_input'];

// Independent review can be requested on a settled (non-active, non-merged) agent that
// owns a branch to audit. The API re-checks (refuses a mid-turn or non-agent session).
function canReview(s: Session): boolean {
  return s.kind === 'agent' && !!s.branch && s.status !== 'merged' && !ACTIVE_STATUSES.includes(s.status);
}

// ── Archive / unarchive ────────────────────────────────────────────────────
// Active agents can't be archived: pre-check and toast (the API also enforces).
async function onArchive(s: Session): Promise<void> {
  if (ACTIVE_STATUSES.includes(s.status)) {
    store.notify('Не можна відкласти активного агента', 'error');
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
const prBusy = ref(false);

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
const mergeIsReview = computed(() => mergeFor.value?.kind === 'review');

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

// ── Move a backlog task to another project ────────────────────────────────
const moveOpen = ref(false);
const moveFor = ref<Session | null>(null);
const moveBusy = ref(false);
const moveError = ref<string | null>(null);
const moveTargets = computed(() => store.projects.filter((p) => p.id !== moveFor.value?.projectId));

function openMove(s: Session): void {
  moveFor.value = s;
  moveError.value = null;
  moveBusy.value = false;
  moveOpen.value = true;
}

async function confirmMove(projectId: string): Promise<void> {
  const s = moveFor.value;
  if (!s) return;
  moveBusy.value = true;
  moveError.value = null;
  try {
    await store.moveTask(s.id, projectId);
    moveOpen.value = false;
    const dest = store.projects.find((p) => p.id === projectId);
    store.notify(`Задачу «${s.name}» перенесено в «${dest?.name ?? 'проєкт'}»`);
  } catch (e) {
    moveError.value = e instanceof Error ? e.message : String(e);
  } finally {
    moveBusy.value = false;
  }
}

function onDiscardRow(s: Session): void {
  if (!window.confirm(`Викинути ${s.kind === 'review' ? 'ревізію' : 'гілку'} «${s.name}»? Розмову буде втрачено.`)) return;
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

async function submitPr(): Promise<void> {
  const s = finishFor.value;
  if (!s) return;
  prBusy.value = true;
  finishError.value = null;
  try {
    await store.createPr(s.id);
    finishOpen.value = false; // agent pushes + opens the PR in the background — watch it in chat
    store.selectSession(s.id);
    store.notify(`Створюю ПР для «${s.name}» — стежу за гілкою в чаті`, 'info');
  } catch (e) {
    finishError.value = e instanceof Error ? e.message : String(e);
  } finally {
    prBusy.value = false;
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
  const p = store.projects.find((x) => x.id === s.projectId);
  if (!p?.previewCommand) {
    openPreviewConfig(s);
    return;
  }
  const win = window.open('', '_blank');
  win?.document.write(LOADING_HTML);
  await launchInto(win, s);
}

function openPreviewConfig(s: Session, forceDefaults = false): void {
  previewCfgSession.value = s;
  const p = store.projects.find((x) => x.id === s.projectId);
  draftWebCmd.value = (forceDefaults ? '' : p?.previewCommand ?? '') || DEFAULT_WEB_CMD;
  draftApiCmd.value = (forceDefaults ? '' : p?.apiCommand ?? '') || DEFAULT_API_CMD;
  previewCfgOpen.value = true;
}

async function submitPreviewConfig(): Promise<void> {
  const s = previewCfgSession.value;
  if (!s) return;
  // previewCommand/apiCommand are owner-only cloud config (projects_update_owner). RLS is the
  // real gate, but a non-owner UPDATE matches zero rows and postgrest reports it as "Cannot
  // coerce the result to a single JSON object" — unreadable. Refuse here in Ukrainian instead,
  // and keep the modal open so the entered commands are not lost.
  if (!projects.isOwner(s.projectId)) {
    store.notify('Налаштування проєкту може змінювати лише власник', 'error');
    return;
  }
  const win = window.open('', '_blank');
  win?.document.write(LOADING_HTML);
  previewCfgOpen.value = false;
  try {
    const patch: { previewCommand: string; apiCommand?: string } = {
      previewCommand: draftWebCmd.value.trim(),
    };
    const apiCmd = draftApiCmd.value.trim();
    if (apiCmd) patch.apiCommand = apiCmd;
    await projects.patch(s.projectId, patch);
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
  height: calc(100vh - 56px);
  overflow: hidden;
  padding: var(--k-sp-3);
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
  gap: 0;
  height: 100%;
  min-height: 0;
  background: var(--k-bg);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-lg);
  overflow: hidden;
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
  width: 1px;
  transform: translateX(-50%);
  background: var(--k-line);
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
  flex: none;
  min-width: 0;
  overflow-y: auto;
  padding: var(--k-sp-4);
}

.ws__board-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 20px;
}

.ws__board-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.ws__bucket-label {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
}

.ws__bucket-count {
  margin-left: var(--k-sp-2);
  font-size: var(--k-fs-sm);
  color: var(--k-faint);
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
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  padding-top: var(--k-sp-4);
}

.ws__detail-blank {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--k-faint);
  font-size: var(--k-fs-sm);
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

// In the unified workspace card the panel is not its own box — the outer card owns the
// border, so the transcript flows flat on the card surface instead of a box-in-a-box.
.ws__tabpane .ws__panel {
  border: none;
  border-radius: 0;
  background: transparent;
}

.ws__cards {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

// ── Detail tabs + panes ────────────────────────────────────────────────────
.ws__detail-tabs {
  flex: none;
  padding: 0 14px;
}

.ws__tabpane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.ws__changes,
.ws__session {
  overflow-y: auto;
  gap: 14px;
  padding: 16px 14px;
}

.ws__changes-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
  color: var(--k-muted);
}
.ws__changes-branch { color: var(--k-text); }
.ws__changes-dirty { color: var(--k-accent); }

.ws__conflict {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--k-accent);
}
.ws__conflict-head { list-style: none; margin-left: -18px; }

.ws__file-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
}
.ws__file-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 0;
  border-bottom: 1px solid var(--k-line);
  font-size: 12px;
}
.ws__file-path {
  color: var(--k-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws__file-stat {
  flex: none;
  display: inline-flex;
  gap: 8px;
}
.ws__diff-add { color: var(--k-diff-add); }
.ws__diff-del { color: var(--k-diff-del); }

// ── Session metadata + actions ─────────────────────────────────────────────
.ws__meta {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ws__meta-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.ws__meta-label {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--k-muted);
}
.ws__meta-value {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--k-text);
  text-align: right;
  overflow-wrap: anywhere;
}
.ws__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 12px;
  border-top: 1px solid var(--k-line);
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

.ws__file {
  display: none;
}

// ── New-task launcher (two-column) ────────────────────────────────────────
.ws-launcher__headmeta {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 12px;
}
.ws-launcher__tag {
  font-size: 11.5px;
  color: var(--k-muted);
  border: 1px solid var(--k-line);
  padding: 1px 6px;
}
.ws-launcher__spacer {
  flex: 1;
}
.ws-launcher__esc {
  font-size: 11.5px;
  color: var(--k-muted);
}

.ws-launcher {
  display: grid;
  grid-template-columns: 1fr 320px;
}
.ws-launcher__main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 22px 24px;
  border-right: 1px solid var(--k-line);
}
.ws-launcher__side {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 20px;
  padding: 22px 24px;
  background: var(--k-surface);
}

.ws-launcher__label {
  font-family: var(--k-font-ui);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--k-muted);
  margin-bottom: 8px;
}
.ws-launcher__label--strong {
  color: var(--k-text);
}
.ws-launcher__label-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
}
.ws-launcher__label-row .ws-launcher__label {
  margin-bottom: 0;
}
.ws-launcher__label-row--tight {
  justify-content: flex-start;
  gap: 8px;
}
.ws-launcher__hint-inline,
.ws-launcher__optional {
  font-size: 11px;
  color: var(--k-muted);
}
.ws-launcher__optional {
  font-size: 10.5px;
}

.ws-launcher__task {
  width: 100%;
  background: var(--k-surface);
  border: none;
  border-left: 2px solid var(--k-accent);
  color: var(--k-text);
  font-family: var(--k-font-mono);
  font-size: 13.5px;
  line-height: 1.7;
  padding: 12px 13px;
  resize: vertical;
  outline: none;
}
.ws-launcher__task::placeholder {
  color: var(--k-muted);
}

.ws-launcher__attach {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.ws-launcher__attach-btn {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  background: transparent;
  border: 1px solid var(--k-line);
  color: var(--k-muted);
  font-size: 12px;
  cursor: pointer;
}
.ws-launcher__attach-btn:hover {
  border-color: var(--k-accent);
  color: var(--k-text);
}
.ws-launcher__attach-note {
  font-size: 11.5px;
  color: var(--k-muted);
}

.ws-launcher__name {
  border-top: 1px solid var(--k-line);
  padding-top: 16px;
}
.ws-launcher__name-input {
  width: 100%;
  background: var(--k-bg);
  border: 1px solid var(--k-line);
  color: var(--k-text);
  font-family: var(--k-font-mono);
  font-size: 13px;
  padding: 9px 11px;
  outline: none;
}
.ws-launcher__name-input::placeholder {
  color: var(--k-muted);
}
.ws-launcher__name-input:focus {
  border-color: var(--k-accent);
}
.ws-launcher__hint {
  margin-top: 7px;
  font-family: var(--k-font-mono);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--k-muted);
}

.ws-launcher__branch {
  background: var(--k-bg);
  border: 1px solid var(--k-line-strong);
  padding: 10px 12px;
  font-family: var(--k-font-mono);
  font-weight: 500;
  font-size: 13px;
  color: var(--k-text);
  word-break: break-all;
}

.ws-launcher__seg {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  background: var(--k-line-strong);
  border: 1px solid var(--k-line-strong);
}
.ws-launcher__seg--grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
}
.ws-launcher__seg-btn {
  flex: 1;
  min-width: 0;
  padding: 7px 8px;
  background: var(--k-bg);
  border: 0;
  color: var(--k-muted);
  font-family: var(--k-font-mono);
  font-weight: 500;
  font-size: 12px;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.ws-launcher__seg-btn:hover {
  color: var(--k-text);
}
.ws-launcher__seg-btn--active {
  background: var(--k-accent);
  color: var(--k-on-accent);
}

.ws-launcher__block {
  border-top: 1px solid var(--k-line);
  padding-top: 16px;
}
.ws-launcher__block--stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ws-launcher__check-desc {
  margin: 3px 0 0;
  padding-left: 24px;
  font-family: var(--k-font-ui);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--k-muted);
}
.ws-launcher__from {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ws-launcher__from-label {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--k-muted);
}
.ws-launcher__from :deep(.k-select) {
  flex: 1;
  min-width: 0;
}
.ws-launcher__from :deep(.k-select__input) {
  background: var(--k-bg);
  font-size: 12.5px;
  padding: 8px 10px;
  width: 100%;
  min-width: 0;
}

.ws-launcher__foot {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 12px;
}
.ws-launcher__foot-hint {
  font-size: 11.5px;
  color: var(--k-muted);
}
.ws-launcher__kbd {
  margin-left: 10px;
  font-size: 11px;
  opacity: 0.7;
}

.ws__move-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ws__move-option {
  font-family: var(--k-font-ui);
  font-size: 14px;
  text-align: left;
  color: var(--k-text);
  background: var(--k-surface);
  border: 1px solid var(--k-line-strong);
  padding: 11px 13px;
  border-radius: 0;
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s;
}

.ws__move-option:hover {
  border-color: var(--k-accent);
  color: var(--k-accent);
}

.ws__move-option:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
