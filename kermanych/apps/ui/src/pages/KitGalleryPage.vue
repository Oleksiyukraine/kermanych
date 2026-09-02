<template>
  <main class="kit">
    <header class="kit__masthead">
      <div class="kit__eyebrow mono">{{ t('kit.gallery.eyebrow') }}</div>
      <h1 class="kit__title">UI-kit</h1>
      <p class="kit__lede">
        Two themes on one token set. Single vermilion accent, rounded cards, mono for machine text.
      </p>
    </header>

    <!-- 00 — foundations (design system) -->
    <section class="kit__section">
      <div class="kit__label">{{ t('kit.gallery.sec.basics') }}</div>
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
      <div class="kit__label">{{ t('kit.gallery.sec.statuses') }}</div>
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
      <div class="kit__label">{{ t('kit.gallery.sec.buttons') }}</div>
      <div class="kit__row">
        <KBtn variant="primary">{{ t('kit.gallery.btn.newAgent') }}</KBtn>
        <KBtn variant="secondary">{{ t('kit.gallery.btn.changePath') }}</KBtn>
        <KBtn variant="ghost">{{ t('kit.gallery.btn.restore') }}</KBtn>
        <KBtn variant="secondary" disabled>{{ t('kit.gallery.btn.apply') }}</KBtn>
        <KBtn variant="icon">⊞</KBtn>
      </div>
      <div class="kit__caption mono">
        primary · secondary · ghost · disabled · icon
      </div>
    </section>

    <!-- 04 — action icon buttons (dense, for icon clusters) -->
    <section class="kit__section">
      <div class="kit__label">{{ t('kit.gallery.sec.actionButtons') }}</div>
      <div class="kit__row">
        <KIconButton :title="t('kit.gallery.iconTip.run')">▶</KIconButton>
        <KIconButton :title="t('kit.gallery.iconTip.edit')">✎</KIconButton>
        <KIconButton :title="t('kit.gallery.iconTip.fork')">⑂</KIconButton>
        <KIconButton :title="t('kit.gallery.iconTip.merge')">⤴</KIconButton>
        <KIconButton :title="t('kit.gallery.iconTip.reviewer')">⚖</KIconButton>
        <KIconButton :title="t('kit.gallery.iconTip.finish')">✓</KIconButton>
        <KIconButton :title="t('kit.gallery.iconTip.archive')">⤓</KIconButton>
        <KIconButton :title="t('kit.gallery.iconTip.delete')">✕</KIconButton>
        <KIconButton active :title="t('kit.gallery.iconTip.previewActive')">◼</KIconButton>
      </div>
      <div class="kit__caption mono">
        {{ t('kit.gallery.cap.actionButtons') }}
      </div>
    </section>

    <!-- 04 — tags & metadata -->
    <section class="kit__section">
      <div class="kit__label">{{ t('kit.gallery.sec.tags') }}</div>
      <div class="kit__row">
        <KTag>⑂ main</KTag>
        <KTag>opus-5</KTag>
        <KTag>142k</KTag>
        <KTag plain>{{ t('kit.gallery.tag.done') }}</KTag>
        <KTag plain>{{ t('kit.gallery.tag.waiting') }}</KTag>
      </div>
    </section>

    <!-- 04 — toggles -->
    <section class="kit__section">
      <div class="kit__label">{{ t('kit.gallery.sec.toggles') }}</div>
      <div class="kit__row">
        <KToggle v-model="harness" :options="['OMP', 'zsh']" />
        <KToggle v-model="view" :options="[t('kit.gallery.toggle.workspace'), t('kit.gallery.toggle.history')]" />
      </div>
      <div class="kit__caption mono">harness={{ harness }} · view={{ view }}</div>
    </section>

    <!-- 04 — fields -->
    <section class="kit__section">
      <div class="kit__label">{{ t('kit.gallery.sec.fields') }}</div>
      <div class="kit__row kit__row--fields">
        <KField v-model="branch" :label="t('kit.gallery.field.branch')" placeholder="feat/auth" />
        <KField v-model="focused" :label="t('kit.gallery.field.focused')" placeholder="click to focus" />
      </div>
      <div class="kit__row kit__row--fields">
        <KSelect v-model="galleryBranch" :label="t('kit.gallery.field.branchRows')" :options="galleryBranches" />
        <KSelect
          v-model="galleryWorkspace"
          :label="t('kit.gallery.field.workspacePairs')"
          :options="galleryWorkspaceOptions"
          :placeholder="t('kit.gallery.field.allWorkspaces')"
        />
      </div>
      <div class="kit__row kit__row--fields">
        <KSelect
          v-model="galleryModel"
          :label="t('kit.gallery.field.modelSearch')"
          :options="galleryModelOptions"
          :placeholder="t('kit.gallery.field.default')"
          searchable
        />
      </div>
      <div class="kit__row kit__row--fields">
        <KDateField v-model="galleryDate" :label="t('kit.gallery.field.dateCustom')" />
        <KDateField v-model="galleryDate" :label="t('kit.gallery.field.dateLocked')" disabled />
      </div>
      <div class="kit__caption mono">
        {{ t('kit.gallery.cap.fields', { branch, branchSel: galleryBranch, wsSel: galleryWorkspace || '—', modelSel: galleryModel || '—', date: galleryDate || '—' }) }}
      </div>
    </section>

    <!-- 05 — agent panels -->
    <section class="kit__section">
      <div class="kit__label">{{ t('kit.gallery.sec.panel') }}</div>
      <div class="kit__panels">
        <KPanel
          :session="runningSession"
          @send="onSend"
          @stop="onStop"
          @expand-all="onGalleryExpandAll"
          @effort="onPanelEffort"
        >
          <KLogBlock v-for="(e, i) in panelLog" :key="i" :entry="e" session-id="kit-demo" :expand-all="galleryExpandAll" />
        </KPanel>
        <KPanel
          :session="waitingSession"
          @send="onSend"
          @answer="onAnswer"
          @stop="onStop"
          @expand-all="onGalleryExpandAll"
        >
          <KLogBlock v-for="(e, i) in waitingLog" :key="i" :entry="e" session-id="kit-demo" :expand-all="galleryExpandAll" />
        </KPanel>
        <KPanel
          :session="stalledSession"
          @send="onSend"
          @restart="onRestart"
          @stop="onStop"
          @expand-all="onGalleryExpandAll"
        >
          <KLogBlock v-for="(e, i) in waitingLog" :key="i" :entry="e" session-id="kit-demo" :expand-all="galleryExpandAll" />
        </KPanel>
      </div>
      <div class="kit__caption mono">{{ t('kit.gallery.cap.lastAction', { action: lastAction || '—' }) }}</div>
    </section>

    <!-- 06 — log blocks -->
    <section class="kit__section">
      <div class="kit__label">{{ t('kit.gallery.sec.logBlocks') }}</div>
      <div class="kit__logblocks">
        <KLogBlock v-for="(e, i) in logSamples" :key="i" :entry="e" session-id="kit-demo" :expand-all="galleryExpandAll" />
      </div>
    </section>

    <!-- 07 — window chrome: rail & status bar -->
    <section class="kit__section">
      <div class="kit__label">{{ t('kit.gallery.sec.rail') }}</div>
      <div class="kit__rail">
        <KRailItem
          v-for="r in railProjects"
          :key="r.project.id"
          :project="r.project"
          :active="r.active"
          :count="r.count"
        />
        <KUserButton label="oleksii-motornyi" :title="t('kit.gallery.userTitle')" />
      </div>
      <div class="kit__caption mono">
        {{ t('kit.gallery.cap.rail') }}
      </div>
      <div class="kit__ws-tree">
        <template v-for="w in galleryWorkspaces" :key="w.id">
          <KWorkspaceRow
            :workspace="w"
            :active="w.id === wsActive"
            :expanded="wsExpanded.includes(w.id)"
            :count="w.count"
            :drop-target="w.id === wsDropTarget"
            @select="onWsSelect(w.id)"
            @toggle="onWsToggle(w.id)"
            @add-project="lastAction = `add-project: ${w.id}`"
            @dragover.prevent="wsDropTarget = w.id"
            @dragleave="wsDropTarget = wsDropTarget === w.id ? '' : wsDropTarget"
            @drop.prevent="onWsDrop(w.id)"
          />
          <KRailItem
            v-for="r in railProjects.filter((p) => p.workspaceId === w.id)"
            v-show="wsExpanded.includes(w.id)"
            :key="r.project.id"
            :project="r.project"
            :active="r.project.id === wsDragged"
            :count="r.count"
            indent
            draggable
            @dragstart="wsDragged = $event"
            @dragend="wsDragged = ''"
          />
        </template>
      </div>
      <div class="kit__caption mono">
        {{ t('kit.gallery.cap.wsTree', { action: lastAction || '—' }) }}
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
      <div class="kit__label">{{ t('kit.gallery.sec.dialog') }}</div>
      <div class="kit__row">
        <KBtn variant="primary" @click="modalOpen = true">{{ t('kit.gallery.btn.openModal') }}</KBtn>
      </div>
      <KModal v-model="modalOpen" :title="t('kit.gallery.modal.title')">
        <template #head-meta>
          <KTag>⌘N</KTag>
        </template>
        <KField v-model="branch" :label="t('kit.gallery.field.branch')" placeholder="feat/auth" />
        <p class="kit__modal-copy">
          {{ t('kit.gallery.modal.copy') }}
        </p>
        <template #controls>
          <KBtn variant="ghost" @click="modalOpen = false">{{ t('kit.gallery.btn.cancel') }}</KBtn>
          <KBtn variant="primary" @click="modalOpen = false">{{ t('kit.gallery.btn.launch') }}</KBtn>
        </template>
      </KModal>
    </section>

    <!-- 09 — data table -->
    <section class="kit__section">
      <div class="kit__label">{{ t('kit.gallery.sec.table') }}</div>
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
            <KIconButton :title="t('kit.gallery.iconTip.preview')" @click.stop="onTableAction(row.id + ':preview')">▶</KIconButton>
            <KIconButton :title="t('kit.gallery.iconTip.finish')" @click.stop="onTableAction(row.id + ':finish')">✓</KIconButton>
            <KIconButton :title="t('kit.gallery.iconTip.archive')" @click.stop="onTableAction(row.id + ':archive')">⤓</KIconButton>
          </div>
        </template>
      </KTable>
      <div class="kit__caption mono">{{ t('kit.gallery.cap.table', { selected: tableSelected, action: lastTableAction || '—' }) }}</div>
    </section>

    <!-- v3 navigation + tabs -->
    <section class="kit__section">
      <div class="kit__label">{{ t('kit.gallery.sec.navV3') }}</div>
      <div class="kit__row"><KTopNav v-model="topNav" :options="topNavOptions" /></div>
      <div class="kit__row" style="margin-top: var(--k-sp-3)"><KTabs v-model="detailTab" :tabs="detailTabs" /></div>
      <div class="kit__row" style="margin-top: var(--k-sp-3)">
        <KSubNav v-model="subNav" :items="subNavItems" :aria-label="t('kit.gallery.subNavAria')" />
      </div>
      <!-- No `icon` here: the leading mark is a MINIFIED-rail affordance, and the layout
           hides it whenever the labels are on screen. Passing one would document a
           combination the app never renders. -->
      <div class="kit__sidebar">
        <KNavItem :label="t('kit.gallery.nav.active')" :count="3" :active="navActive === 'active'" @click="navActive = 'active'" />
        <KNavItem :label="t('kit.gallery.nav.tasks')" :count="5" :active="navActive === 'tasks'" @click="navActive = 'tasks'" />
        <KNavItem :label="t('kit.gallery.nav.archived')" :count="12" :active="navActive === 'archived'" @click="navActive = 'archived'" />
        <KNavItem :label="t('kit.gallery.nav.history')" :active="navActive === 'history'" @click="navActive = 'history'" />
      </div>
      <div class="kit__caption mono">
        {{ t('kit.gallery.cap.navRow') }}
      </div>
      <div class="kit__sidebar">
        <KNavItem
          label="Skills"
          :hint="t('kit.gallery.skillsHint')"
          :active="navStacked === 'skills'"
          @click="navStacked = 'skills'"
        />
        <KNavItem
          label="Integrations"
          hint="Linear, Jira, Slack"
          :active="navStacked === 'integrations'"
          @click="navStacked = 'integrations'"
        />
      </div>
    </section>

    <!-- session cards -->
    <section class="kit__section">
      <div class="kit__label">{{ t('kit.gallery.sec.sessionCards') }}</div>
      <div class="kit__cards">
        <KSessionCard
          v-for="(c, i) in sessionCards" :key="c.branch"
          :branch="c.branch" :time="c.time"
          :status="c.status" :status-line="c.statusLine" :selected="i === 0"
          :model="c.model" :usage="c.usage"
        />
      </div>

      <!-- A FORK — a discussion/review branch of the card above it. It has to read as that
           agent's child rather than one more agent that happens to sit there, so it is
           indented and tied back by an elbow; the last fork ends the spine, the ones before
           it carry it on. The container leaves the gap the spine is drawn to cross. -->
      <div class="kit__cards kit__group">
        <KSessionCard
          branch="feature/dark-theme" :time="t('kit.gallery.sessionCard.waitTime')" status="waiting_input"
          :status-line="t('kit.gallery.sessionCard.s2Status')" model="opus-5"
          :usage="{ input: 9800, output: 4100, cacheRead: 480000, cacheWrite: 27000, cost: 1.41 }"
        />
        <KSessionCard
          fork branch="" :title="t('kit.gallery.sessionCard.forkTitle')" :time="t('kit.gallery.sessionCard.forkTime')" status="thinking"
          :status-line="t('kit.gallery.sessionCard.forkStatus')" model="haiku"
          :usage="{ input: 410, output: 180, cacheRead: 6200, cacheWrite: 0, cost: 0.004 }"
        />
        <KSessionCard
          fork branch="" :title="t('kit.gallery.sessionCard.reviewTitle')" :time="t('kit.gallery.sessionCard.reviewTime')" status="done"
          :status-line="t('kit.gallery.sessionCard.reviewStatus')" model="opus-5" selected
          :usage="{ input: 7400, output: 2900, cacheRead: 132000, cacheWrite: 9600, cost: 0.88 }"
        />
      </div>
      <div class="kit__caption mono">{{ t('kit.gallery.cap.sessionFork') }}</div>

      <!-- REMOVABLE — a backlog task, whose card click opens its editor and so cannot also
           be the way out. The ✕ appears under the cursor; its width is reserved in the top
           row, which is why the time sits a notch left of the cards above. -->
      <div class="kit__cards">
        <KSessionCard
          removable branch="" :title="t('kit.gallery.sessionCard.removeTitle')" :time="t('kit.gallery.sessionCard.removeTime')" status="backlog"
          :status-line="t('kit.gallery.sessionCard.removeStatus')" model="opus-5"
          :remove-title="t('kit.gallery.sessionCard.removeTip')"
        />
      </div>
      <div class="kit__caption mono">{{ t('kit.gallery.cap.sessionRemove') }}</div>
    </section>

    <!-- kanban -->
    <section class="kit__section">
      <div class="kit__label">{{ t('kit.gallery.sec.kanban') }}</div>
      <div class="kit__kanban">
        <KKanbanColumn :label="t('kit.gallery.kanbanCol.backlog')" :count="2">
          <KKanbanCard :title="t('kit.gallery.kanbanCard.keychainTitle')" branch="feature/keychain-rotate" project="Backend-core" :time="t('kit.gallery.kanbanCard.keychainTime')" status="backlog" :assignee="{ name: 'oleksii-motornyi' }" />
          <KKanbanCard :title="t('kit.gallery.kanbanCard.pathTitle')" branch="chore/path-ellipsis" project="FE-kit" :time="t('kit.gallery.kanbanCard.pathTime')" status="backlog" />
        </KKanbanColumn>
        <KKanbanColumn :label="t('kit.gallery.kanbanCol.inProgress')" :count="1">
          <KKanbanCard :title="t('kit.gallery.kanbanCard.rateTitle')" branch="feature/rate-limit" project="Backend-core" :time="t('kit.gallery.kanbanCard.rateTime')" status="thinking" :assignee="{ name: t('kit.gallery.kanbanCard.assignee'), avatarUrl: sampleAvatar }" />
        </KKanbanColumn>
      </div>
      <div class="kit__caption mono">
        {{ t('kit.gallery.cap.kanban') }}
      </div>
    </section>

    <!-- chat + thought -->
    <section class="kit__section">
      <div class="kit__label">{{ t('kit.gallery.sec.chat') }}</div>
      <KChatMessage role="user">{{ t('kit.gallery.chat.user') }}</KChatMessage>
      <KThoughtToggle :label="t('kit.gallery.chat.thought')" :open="thoughtOpen" @toggle="thoughtOpen = !thoughtOpen">
        {{ t('kit.gallery.chat.thoughtBody') }}
      </KThoughtToggle>
      <KChatMessage role="assistant">{{ t('kit.gallery.chat.assistant') }}</KChatMessage>
    </section>

    <!-- composer -->
    <section class="kit__section">
      <div class="kit__label">{{ t('kit.gallery.sec.composer') }}</div>
      <!-- The Хелпери picker lives inside the composer: press `/` on the empty field, or the
           `/` button in the controls row. -->
      <KComposer
        v-model="composerDraft"
        :model="composerModel"
        :models="composerModels"
        :effort="composerEffort"
        :worktree="true"
        :context="14"
        :usage="{ input: 18_400, output: 9_200, cacheRead: 214_000, cacheWrite: 620, cost: 0.62 }"
        @send="() => {}"
        @effort="(level) => (composerEffort = level)"
        @set-model="(p) => (composerModel = p.model)"
      />
    </section>

    <!-- file diff -->
    <section class="kit__section">
      <div class="kit__label">{{ t('kit.gallery.sec.diff') }}</div>
      <KDiffView
        v-if="diffOpen"
        path="src/pages/grano/fields/field-overview.component.vue"
        :diff="diffSample"
        @close="diffOpen = false"
      />
      <KBtn v-else variant="secondary" @click="diffOpen = true">{{ t('kit.gallery.btn.showDiff') }}</KBtn>
      <div class="kit__caption mono">
        {{ t('kit.gallery.cap.diff') }}
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type {
  SessionStatus, Session, TranscriptEntry, RpcExtensionUIResponse, ThinkingLevel, Usage, ModelOption,
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
import KWorkspaceRow from 'components/kit/KWorkspaceRow.vue';
import KSelect from 'components/kit/KSelect.vue';
import KDateField from 'components/kit/KDateField.vue';
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
import KSubNav from 'components/kit/KSubNav.vue';
import KComposer from 'components/kit/KComposer.vue';
import KDiffView from 'components/kit/KDiffView.vue';
import type { FileDiff } from '../lib/api';

const { t } = useI18n();

const topNav = ref('agents');
const topNavOptions = [
  { value: 'agents', label: t('kit.gallery.topNav.agents') },
  { value: 'board', label: t('kit.gallery.topNav.board') },
  { value: 'chat', label: t('kit.gallery.topNav.chat') },
];
const subNav = ref('storage');
const subNavItems = [
  { value: 'home', label: 'Home' },
  { value: 'storage', label: 'Storage' },
  { value: 'risks', label: 'Risk Registry' },
  { value: 'releases', label: 'Release Notes' },
];
const navActive = ref('active');
const navStacked = ref('skills');
const detailTab = ref('log');
const detailTabs = [
  { value: 'log', label: t('kit.gallery.detailTab.log') },
  { value: 'changes', label: t('kit.gallery.detailTab.changes') },
  { value: 'session', label: t('kit.gallery.detailTab.session') },
];
const composerDraft = ref('');
// The gallery has no session behind the chip, so the pick is held locally — the point here is
// that the menu opens upward inside the row and reports the level it landed on.
const composerEffort = ref<ThinkingLevel>('high');
// A stand-in omp catalogue so the composer's model chip renders as a picker here, with the
// pick held locally (the gallery has no session behind it). An empty list degrades the chip
// to a read-only label — the without-catalogue case.
const composerModel = ref('opus-5');
const composerModels: readonly ModelOption[] = [
  { id: 'opus-5', name: 'Claude Opus 5', provider: 'anthropic', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'sonnet-4.5', name: 'Claude Sonnet 4.5', provider: 'anthropic', efforts: ['low', 'medium', 'high'] },
  { id: 'gpt-5.2', name: 'GPT-5.2', provider: 'openai', efforts: ['minimal', 'low', 'medium', 'high'] },
];
const diffOpen = ref(true);
// Every row shape at once: context, a paired replacement, a one-sided addition and a
// one-sided removal — the four cases the two columns have to keep aligned.
const diffSample: FileDiff = {
  hunks: [
    {
      header: '@@ -14,7 +14,8 @@ function statusWord(s: Session)',
      rows: [
        { kind: 'ctx', old: { no: 14, text: '  switch (s.status) {' }, new: { no: 14, text: '  switch (s.status) {' } },
        { kind: 'mod', old: { no: 15, text: t('kit.gallery.diffRow.modOld') }, new: { no: 15, text: t('kit.gallery.diffRow.modNew') } },
        { kind: 'add', old: null, new: { no: 16, text: t('kit.gallery.diffRow.add') } },
        { kind: 'del', old: { no: 16, text: t('kit.gallery.diffRow.del') }, new: null },
        { kind: 'ctx', old: { no: 17, text: '  }' }, new: { no: 17, text: '  }' } },
      ],
    },
  ],
  binary: false,
  truncated: false,
};
const thoughtOpen = ref(false);
// The last row deliberately carries neither model nor usage: an agent whose turns were
// never counted drops the accounting line rather than printing a zero.
const sessionCards: { branch: string; title: string; time: string; status: SessionStatus; statusLine: string; model?: string; usage?: Usage }[] = [
  { branch: 'feature/rate-limit', title: t('kit.gallery.sessionCard.s1Title'), time: t('kit.gallery.sessionCard.s1Time'), status: 'thinking', statusLine: t('kit.gallery.sessionCard.s1Status'), model: 'opus-5', usage: { input: 18_400, output: 9_200, cacheRead: 1_240_000, cacheWrite: 62_000, cost: 3.18 } },
  { branch: 'refactoring/session-store', title: t('kit.gallery.sessionCard.s2Title'), time: t('kit.gallery.sessionCard.s2Time'), status: 'waiting_input', statusLine: t('kit.gallery.sessionCard.s2Status'), model: 'sonnet-4.5', usage: { input: 2_100, output: 640, cacheRead: 31_000, cacheWrite: 4_800, cost: 0.004 } },
  { branch: 'fix/remove-button', title: 'remove + button', time: t('kit.gallery.sessionCard.s3Time'), status: 'merged', statusLine: t('kit.gallery.sessionCard.s3Status'), model: 'haiku', usage: { input: 900, output: 310, cacheRead: 0, cacheWrite: 0, cost: 0.02 } },
  { branch: 'chore/ci-node-22', title: t('kit.gallery.sessionCard.s4Title'), time: t('kit.gallery.sessionCard.s4Time'), status: 'done', statusLine: t('kit.gallery.sessionCard.s4Status') },
];

const swatches = [
  { var: '--k-canvas' }, { var: '--k-bg' }, { var: '--k-surface' }, { var: '--k-surface2' },
  { var: '--k-text' }, { var: '--k-muted' }, { var: '--k-faint' },
  { var: '--k-accent' }, { var: '--k-success' }, { var: '--k-warning' }, { var: '--k-danger' },
];
const typeScale = [
  { var: '--k-fs-lg', label: t('kit.gallery.typeScale.lg') },
  { var: '--k-fs-md', label: t('kit.gallery.typeScale.md') },
  { var: '--k-fs-base', label: t('kit.gallery.typeScale.base') },
  { var: '--k-fs-sm', label: t('kit.gallery.typeScale.sm') },
  { var: '--k-fs-xs', label: t('kit.gallery.typeScale.xs') },
];
const radii = [
  { var: '--k-r-sm' }, { var: '--k-r' }, { var: '--k-r-lg' }, { var: '--k-r-pill' },
];

const statusSamples: { status: SessionStatus; name: string }[] = [
  { status: 'thinking', name: t('kit.gallery.status.working') },
  { status: 'waiting_input', name: t('kit.gallery.status.waiting') },
  { status: 'done', name: t('kit.gallery.status.done') },
  { status: 'queued', name: t('kit.gallery.status.cold') },
];

const harness = ref('OMP');
const view = ref(t('kit.gallery.toggle.workspace'));
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
const runningSession = mkSession({ id: 's1', status: 'thinking', branch: 'main', model: 'opus-5', effort: 'high', contextPercent: 42, usage: { input: 18_400, output: 9_200, cacheRead: 1_240_000, cacheWrite: 62_000, cost: 3.18 } });
const stalledSession = mkSession({ id: 's3', status: 'thinking', branch: 'feat/wedged', lastEventAt: Date.now() - 90_000 });
const waitingSession = mkSession({
  id: 's2', status: 'waiting_input', branch: 'feat/schema',
  pendingUiRequest: {
    type: 'extension_ui_request', id: 'req-1', method: 'select',
    title: t('kit.gallery.request.title'),
    options: [t('kit.gallery.request.optMerge'), t('kit.gallery.request.optKeep')],
  },
});
const agentColumns: KTableColumn[] = [
  { key: 'status', label: t('kit.gallery.column.status'), width: '132px' },
  { key: 'name', label: t('kit.gallery.column.name') },
  { key: 'branch', label: t('kit.gallery.column.branch'), width: '150px' },
  { key: 'ctx', label: t('kit.gallery.column.ctx'), align: 'right', width: '96px', mono: true },
  { key: 'activity', label: t('kit.gallery.column.activity') },
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
// Same rule for the assignee's picture: inline SVG, so the face on a card is not one more
// avatar url that can 404 in a catalogue. A member with no picture (the Беклог card above)
// falls back to initials, which is the state this one is contrasted against.
const sampleAvatar =
  'data:image/svg+xml;utf8,' +
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">' +
  '<rect width="80" height="80" fill="%23c4643a"/>' +
  '<circle cx="40" cy="32" r="14" fill="%23f2e6dc"/>' +
  '<rect x="14" y="52" width="52" height="30" rx="14" fill="%23f2e6dc"/></svg>';
const panelLog: TranscriptEntry[] = [
  { kind: 'user_text', id: '0', at: nowMs, text: t('kit.gallery.panelLog.user0') },
  {
    kind: 'tool', id: '1', at: nowMs, tool: 'edit', status: 'ok',
    target: 'auth/token.service.ts', stat: '+1 −0',
    detail: { lines: [{ t: 'add', n: '84', text: '    this.rotateShared(token);' }], totalLines: 1 },
  },
  {
    kind: 'tool', id: '2', at: nowMs, tool: 'bash', status: 'ok',
    target: 'npm run test:e2e -- auth', stat: t('kit.gallery.panelLog.statSec84'),
    detail: {
      lines: [
        { t: 'head', text: '$ npm run test:e2e -- auth' },
        { t: 'ctx', text: '12 passed, 0 failed' },
        { t: 'head', text: t('kit.gallery.panelLog.wall84') },
      ],
      totalLines: 3,
    },
  },
  { kind: 'assistant_text', id: '3', at: nowMs, text: t('kit.gallery.panelLog.assistant3') },
  // Two operator turns on purpose (kept from dev): the panel's my-message navigation
  // (▲/▼) only appears above a second user message, and the gallery is where that
  // control is documented. It now targets `.k-rb__head`, so a second request block is
  // what makes it visible at all.
  { kind: 'user_text', id: '4', at: nowMs, text: t('kit.gallery.panelLog.user4') },
];
const waitingLog: TranscriptEntry[] = [
  { kind: 'user_text', id: '0', at: nowMs, text: t('kit.gallery.waitingLog.user0') },
  { kind: 'tool', id: '1', at: nowMs, tool: 'read', status: 'pending', target: 'src/session.ts' },
  { kind: 'assistant_text', id: '2', at: nowMs, text: t('kit.gallery.waitingLog.assistant2') },
];
const logSamples: TranscriptEntry[] = [
  {
    kind: 'user_text', id: '0', at: nowMs,
    text: t('kit.gallery.logSamples.user0'),
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
  { kind: 'tool', id: '3', at: nowMs, tool: 'grep', status: 'ok', target: '/useAuth/ src', stat: t('kit.gallery.logSamples.grepStat'), count: 0 },
  {
    kind: 'tool', id: '4', at: nowMs, tool: 'bash', status: 'error',
    target: 'pnpm test', stat: t('kit.gallery.logSamples.bashStat'),
    detail: {
      lines: [
        { t: 'head', text: '$ pnpm test' },
        { t: 'ctx', text: '2 failing specs' },
        { t: 'head', text: t('kit.gallery.logSamples.bashWall') },
      ],
      totalLines: 3,
    },
  },
  // All three chip forms: both metrics, duration only, tokens only.
  {
    kind: 'assistant_thinking', id: '5', at: nowMs, ms: 12_400, tokens: 1840,
    text: t('kit.gallery.logSamples.think5'),
  },
  { kind: 'assistant_thinking', id: '5a', at: nowMs, ms: 4_200, text: t('kit.gallery.logSamples.think5a') },
  { kind: 'assistant_thinking', id: '5b', at: nowMs, tokens: 320, text: t('kit.gallery.logSamples.think5b') },
  { kind: 'assistant_text', id: '6', at: nowMs, text: t('kit.gallery.logSamples.assistant6') },
  { kind: 'notice', id: '7', at: nowMs, level: 'info', text: t('kit.gallery.logSamples.notice7') },
  { kind: 'notice', id: '8', at: nowMs, level: 'warn', text: t('kit.gallery.logSamples.notice8') },
  { kind: 'notice', id: '9', at: nowMs, level: 'error', text: t('kit.gallery.logSamples.notice9') },
  // `turn` is ledger data for block summaries — it renders nothing, by design.
  { kind: 'turn', id: '10', at: nowMs, model: 'claude-opus-5', ms: 21_300 },
];
const railProjects: { project: RailProject; active: boolean; count: number; workspaceId: string }[] = [
  { project: { id: 'p1', name: 'api-gateway', state: 'bound' }, active: true, count: 12, workspaceId: 'w1' },
  { project: { id: 'p2', name: 'web client', state: 'unbound' }, active: false, count: 0, workspaceId: 'w1' },
  { project: { id: 'p3', name: 'billing', state: 'orphan' }, active: false, count: 1, workspaceId: 'w2' },
];

// One coloured, one not, so both dot states show. The ids are what KSelect's pair form
// carries below — a filter keyed by the NAME breaks the day a second «Особисте» appears.
const galleryWorkspaces = [
  { id: 'w1', name: t('kit.gallery.workspace.kermanych'), color: '#ff563c', count: 12 },
  { id: 'w2', name: t('kit.gallery.workspace.personal'), count: 1 },
];
const wsActive = ref('w1');
const wsExpanded = ref(['w1', 'w2']);
const wsDropTarget = ref('');
// The dragged id lives here rather than in dataTransfer because `getData()` is unreadable
// during `dragover` — exactly the reason KRailItem emits the id from `dragstart`.
const wsDragged = ref('');

function onWsSelect(id: string) {
  wsActive.value = id;
  lastAction.value = `select: ${id}`;
}
function onWsToggle(id: string) {
  wsExpanded.value = wsExpanded.value.includes(id)
    ? wsExpanded.value.filter((x) => x !== id)
    : [...wsExpanded.value, id];
  lastAction.value = `toggle: ${id}`;
}
function onWsDrop(id: string) {
  lastAction.value = wsDragged.value ? `drop: ${wsDragged.value} -> ${id}` : `drop: ${id}`;
  wsDropTarget.value = '';
  wsDragged.value = '';
}

const galleryBranches = ['main', 'develop', 'feat/schema'];
const galleryBranch = ref('main');
const galleryWorkspaceOptions = galleryWorkspaces.map((w) => ({ value: w.id, label: w.name }));
const galleryWorkspace = ref('');
// The searchable form's reason to exist, in miniature: labels sharing every leading word, so
// prefix type-ahead is useless and a substring search is the only way in. Real ids as values —
// `filterByQuery` searches those too, which is how a pinned snapshot is found by its date.
const galleryModelOptions = [
  { value: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
  { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 · claude-haiku-4-5-20251001' },
];
const galleryModel = ref('');
// Seeded rather than empty: a calendar showcase whose only state is «нічого не вибрано»
// shows neither the selected day nor the today ring.
const galleryDate = ref('2026-09-20');
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
function onRestart() { lastAction.value = 'restart'; }
// The panel demo carries a live effort chip, so the pick is reported like every other action
// here: these sample sessions are plain objects, and a chip that swallowed the choice would
// be showing a control that does nothing.
function onPanelEffort(level: ThinkingLevel) { lastAction.value = `effort: ${level}`; }
</script>

<style scoped lang="scss">
.kit__sidebar { display: flex; flex-direction: column; gap: var(--k-sp-1); max-width: 240px; margin-top: var(--k-sp-4); background: var(--k-surface); border: 1px solid var(--k-line); border-radius: var(--k-r-lg); padding: var(--k-sp-2); }
.kit__cards { display: flex; flex-direction: column; gap: var(--k-sp-2); max-width: 340px; }
.kit__group { margin-top: var(--k-sp-4); }
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

// The workspace tree is drawn at the sidebar's real expanded width — .kit__rail above is
// the 44px minified rail, and a group header collapsed to that is unreadable.
.kit__ws-tree {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 240px;
  margin-top: 20px;
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
