<template>
  <main class="agents">
    <!-- Nothing in scope — neither a workspace nor a project — so the rail invites a choice. -->
    <div v-if="!store.selectedProjectId && !store.selectedWorkspaceId" class="agents__blank">
      <div class="agents__blank-eyebrow mono">{{ t('agents.blank.eyebrow') }}</div>
      <p class="agents__blank-text">{{ t('agents.blank.text') }}</p>
    </div>

    <div v-else class="agents__content" ref="contentEl" :class="{ 'agents__content--resizing': resizing || splitResizing }">
      <!-- BOARD — one card per session in scope: one project, or every project of a workspace -->
      <section ref="boardEl" class="agents__board" :style="{ width: detailWidth + 'px' }">
        <header class="agents__board-head">
          <!-- «Карта агентів»: every agent on this machine and what it spawned, in place of the
               chat (spec docs/specs/2026-10-22-agent-map.md). The count is machine-wide, so an
               agent working outside this scope is never quiet. A toggle: pressed while open.
               It takes the place of the bucket's name and count: the sidebar rail already
               shows both on the selected bucket, and the board gets a row back. -->
          <button
            type="button"
            class="agents__map-btn"
            :class="{ 'agents__map-btn--on': mapOpen }"
            :aria-pressed="mapOpen"
            @click="toggleAgentMap()"
          >
            <span class="agents__map-btn-label"><span aria-hidden="true">◈</span> {{ t('agents.map.title') }}</span>
            <span class="agents__map-btn-count mono">{{ t('agents.map.activeCount', activeAgents) }}</span>
          </button>
          <div class="agents__board-controls">
            <!-- Creating anything needs ONE project (a session row carries a projectId), so
                 under a workspace scope this is the one control that cannot act. Its reason is
                 the visible line below and NOT a `title`: KBtn routes `title` into v-tip,
                 which binds mouseenter/focusin on the element, and Chromium dispatches
                 neither on a disabled button — nor can one take focus. A tooltip on a
                 disabled control is unreachable by construction.
                 A split button: the main half is the plain «Нова задача», ▾ offers the other
                 ways to start one — today «Глибокий аналіз». -->
            <KSplitButton
              :label="t('agents.board.newTask')"
              :menu-label="t('agents.board.newTaskMenu')"
              :items="newTaskModes"
              :disabled="!store.selectedProjectId"
              @click="openLauncher()"
              @select="onNewTaskMode"
            />
          </div>
        </header>

        <!-- SEARCH — sticky at the top of the scrolling column, so a query typed over a long
             board stays reachable while the cards move under it. It narrows the ROWS only:
             the bucket the rail chose still decides which rows are candidates, the rail keeps
             counting the whole bucket, and «знайдено N з M» beside the box is where the
             matched figure is stated. -->
        <div class="agents__search">
          <KField
            v-model="query"
            class="agents__search-field"
            type="search"
            :placeholder="t('agents.board.searchPlaceholder')"
          />
          <span v-if="filtering" class="agents__search-count mono">
            {{ t('agents.board.searchCount', { n: matchedCount, total: boardCount }) }}
          </span>
        </div>

        <!-- Why «Нова задача» cannot act — a muted line above the cards the scope decided; the
             rule beneath keeps the cards reading as a separate list. -->
        <div v-if="!store.selectedProjectId" class="agents__notes mono">
          <p class="agents__note">{{ t('agents.hints.pickProject') }}</p>
        </div>

        <!-- THE LIST — one flat, windowed run of rows: under «Задачі» my cloud backlog cards
             first, then the note about whatever stranded pre-cutover local rows follow, then
             the session cards. Flat because it is VIRTUALISED — only the pages around the fold
             are mounted and two spacers stand in for the rest, which a nest of
             group-then-cards blocks cannot express. `data-vkey` on every row is how
             useVirtualList finds a height and whose it is. -->
        <div v-if="boardItems.length" ref="listEl" class="agents__cards">
          <div class="agents__pad" aria-hidden="true" :style="{ height: listWindow.padTop + 'px' }"></div>
          <div v-for="item in visibleItems" :key="item.key" class="agents__vrow" :data-vkey="item.key">
            <!-- Which project a run of cards belongs to; rendered only under a workspace scope. -->
            <div
              v-if="item.kind === 'group'"
              class="agents__group-label mono"
              :class="{ 'agents__group-label--lead': item.lead }"
            >{{ item.name }}</div>
            <!-- Whatever survived the publication pass: rows whose project has no cloud row at
                 all, so there is nothing for a card to point at. Only under «Задачі» — in every
                 other bucket these are ordinary local sessions. -->
            <p v-else-if="item.kind === 'note'" class="agents__note agents__note--stranded mono">
              {{ t('agents.board.stranded') }}
            </p>
            <!-- `branch` is deliberately EMPTY for a card, and must stay empty: KSessionCard
                 heads the card with `branch || title`, so anything passed wins over the title.
                 A card's `branch` is its BASE branch («Базова гілка»), seeded from the project
                 default — passing it made every card in the inbox read «main» and hid the
                 title in the ✕ tooltip. A BACKLOG card has no branch of its own to name; the
                 session cards do, which is why they pass theirs. -->
            <KSessionCard
              v-else-if="item.kind === 'card'"
              :branch="''"
              :title="item.card.title"
              :time="renderTime(t, relativeTime(item.card.updatedAt, now))"
              :status="item.card.status"
              :status-line="item.card.description ?? ''"
              :model="item.card.model"
              :deep-analysis="item.card.deepAnalysis"
              :auto-run="item.card.autoRun"
              :needs-decision="cardDecisionReason(t, item.card)"
              :not-needed="cardNotNeededReason(t, item.card)"
              :selected="false"
              :pending="cardDelete.busyFor(item.card.id)"
              removable
              :remove-title="t('agents.board.removeTask', { title: item.card.title })"
              @click="openLauncher(item.card)"
              @remove="onDeleteCard(item.card)"
            />
            <KSessionCard
              v-else-if="item.kind === 'session'"
              :branch="item.session.branch"
              :title="item.session.name"
              :time="renderTime(t, relativeTime(item.session.lastActivityAt, now))"
              :status="item.session.status"
              :status-line="cardLine(item.session)"
              :model="item.session.model"
              :harness="item.session.kind === 'task' ? undefined : sessionLaunchMode(item.session)"
              :deep-analysis="item.session.deepAnalysis"
              :minion="item.session.minion"
              :needs-decision="sessionDecisionReason(t, item.session)"
              :not-needed="sessionNotNeededReason(t, item.session)"
              :usage="item.session.usage"
              :selected="store.selectedSessionId === item.session.id"
              :removable="item.session.kind === 'task'"
              :browsing="sessionBrowser.agentLive.has(item.session.id)"
              :findings="item.session.openFindings ?? 0"
              :pending="isSessionPending(item.session.id) || deleteAction.busyFor(item.session.id)"
              :remove-title="t('agents.board.removeStranded', { name: item.session.name })"
              @click="onRowClick(item.session)"
              @remove="onDeleteStranded(item.session)"
            />
          </div>
          <div class="agents__pad" aria-hidden="true" :style="{ height: listWindow.padBottom + 'px' }"></div>
        </div>
        <!-- Before the socket snapshot (and, under «Задачі», the cloud backlog read) an empty
             list is «not loaded», not «empty»: card skeletons, and never `emptyText`. -->
        <KSkeleton v-else-if="boardPhase === 'skeleton'" variant="card" :rows="4" />
        <template v-else-if="boardPhase === 'ready'">
          <p v-if="backlogError" class="agents__error" role="alert">{{ backlogError }}</p>
          <div v-else class="agents__empty mono">{{ emptyText }}</div>
        </template>
      </section>

      <!-- RESIZER — drag the seam to widen / narrow the chat section -->
      <div
        class="agents__resizer"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('agents.board.resizeAria')"
        :aria-valuenow="Math.round(detailWidth)"
        :aria-valuemin="MIN_DETAIL"
        tabindex="0"
        v-tip="t('agents.board.resizeTip')"
        @pointerdown="startResize"
        @keydown="onResizeKeydown"
      ></div>

      <!-- DETAIL — the full panel for the selected session -->
      <aside class="agents__detail">
        <AgentMap
          v-if="mapOpen"
          :focus-id="mapFocus.id"
          :unfold-focus="mapFocus.unfold"
          :selected-session-id="store.selectedSessionId"
          :session-line="cardLine"
          @open-session="onMapOpenSession"
          @close="mapOpen = false"
        />
        <template v-else-if="selectedSession">
        <!-- CONSOLIDATED HEADER — identity on the left, live status + controls on the right.
             One bar for the whole chat column: the embedded KPanel runs `bare`, so this is the
             only place the session's dot, name, branch, harness and actions appear. -->
        <div class="agents__detail-bar">
          <div class="agents__detail-id">
            <!-- A forked branch names the agent it hangs off, and opens it. -->
            <button
              v-if="parentOfSelected"
              type="button"
              class="agents__detail-parent"
              v-tip="t('agents.detail.openParent')"
              :aria-label="t('agents.detail.openParentAria', { name: parentOfSelected.name })"
              @click="store.selectSession(parentOfSelected.id)"
            >
              <span class="agents__detail-parent-mark" aria-hidden="true">↑</span>
              <span class="agents__detail-parent-name mono">{{ parentOfSelected.branch || parentOfSelected.name }}</span>
            </button>
            <KStatusDot :status="selectedSession.status" />
            <input
              v-if="renaming"
              ref="renameInput"
              v-model="renameDraft"
              class="agents__detail-rename"
              :aria-label="t('agents.detail.renameAria')"
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent.stop="cancelRename"
              @blur="commitRename"
            />
            <span
              v-else
              class="agents__detail-name"
              :class="{ 'agents__detail-name--pending': renameOnScreen && sessionName.pending.value }"
              v-tip="t('agents.detail.renameHint')"
              @dblclick="startRename"
            >{{ shownName }}</span>
            <KTag v-if="selectedSession.branch" class="agents__detail-branch">⑂ {{ selectedSession.branch }}</KTag>
            <KAnalysisMark v-if="selectedSession.deepAnalysis" />
            <KMinionMark v-if="selectedSession.minion" kind="running" />
            <KDecisionMark v-if="selectedDecision" :reason="selectedDecision" />
            <KNotNeededMark v-else-if="selectedNotNeeded" :reason="selectedNotNeeded" />
          </div>

          <div class="agents__detail-controls">
            <span class="agents__detail-status mono">{{ harnessLabel }} · {{ statusWord(selectedSession) }}</span>
            <!-- Waiting for an agent slot: one way past the limit for this session only. -->
            <KBtn
              v-if="selectedSession.slotWait"
              variant="secondary"
              :loading="runNowAction.busy.value"
              @click="onRunNow(selectedSession)"
            >{{ t('agents.slotWait.runNow') }}</KBtn>
            <!-- Primary session actions — one column that outlives the tab choice, so preview,
                 finish and defer are on screen in Лог, Зміни and Сесія alike. -->
            <div class="agents__actions">
              <KIconButton
                v-if="(store.subagents[selectedSession.id]?.length ?? 0) > 0"
                :title="t('agents.actions.agentMap')"
                @click="openAgentMapAt(selectedSession.id)"
              >◈</KIconButton>
              <template v-if="selectedSession.kind === 'discussion' || selectedSession.kind === 'review'">
                <KIconButton
                  v-if="selectedSession.status !== 'merged'"
                  :disabled="selectedPending"
                  :title="selectedSession.kind === 'review' ? t('agents.merge.reviewTitle') : t('agents.actions.mergeTip')"
                  @click="openMerge(selectedSession)"
                >⤴</KIconButton>
              </template>
              <template v-else-if="!selectedSession.archived">
                <!-- `title` names the action even while disabled; the reason a disabled ▶ can't
                     act is the visible line under this bar. -->
                <KIconButton
                  :active="!!store.previews[selectedSession.id]"
                  :loading="previewStarting(selectedSession.id) || previewStopAction.busy.value"
                  :disabled="!isBoundFor(selectedSession.projectId) || selectedBlocked || (previewStart.busy.value && !previewStarting(selectedSession.id))"
                  :title="store.previews[selectedSession.id] ? t('agents.actions.previewStop') : t('agents.actions.previewStart')"
                  @click="togglePreview(selectedSession)"
                >{{ store.previews[selectedSession.id] ? '◼' : '▶' }}</KIconButton>
                <KIconButton
                  v-if="selectedSession.status !== 'merged'"
                  :disabled="selectedPending"
                  :title="t('agents.actions.finish')"
                  @click="openFinish(selectedSession)"
                >✓</KIconButton>
                <KIconButton
                  v-if="selectedSession.status === 'merged'"
                  :loading="reopenAction.busy.value"
                  :disabled="selectedBlocked"
                  :title="t('agents.actions.reopen')"
                  @click="onReopen(selectedSession)"
                >↻</KIconButton>
                <KIconButton
                  :loading="archiveAction.busy.value"
                  :disabled="selectedBlocked"
                  :title="t('agents.actions.archive')"
                  @click="onArchive(selectedSession)"
                >⤓</KIconButton>
              </template>
              <template v-else>
                <KIconButton
                  :loading="unarchiveAction.busy.value"
                  :disabled="selectedBlocked"
                  :title="t('agents.actions.unarchive')"
                  @click="onUnarchive(selectedSession)"
                >⤒</KIconButton>
              </template>
            </div>

            <!-- Overflow — the actions that don't earn a permanent glyph, plus the two
                 destructive ones, kept one click (or ⌘⌫) away so a slip can't fire them. -->
            <div class="agents__menu" ref="menuEl">
              <KIconButton
                :title="t('agents.detail.more')"
                :active="menuOpen"
                @click.stop="menuOpen = !menuOpen"
              >⋯</KIconButton>
              <div v-if="menuOpen" class="agents__menu-pop" role="menu">
                <template v-if="selectedSession.kind === 'discussion' || selectedSession.kind === 'review'">
                  <button type="button" class="agents__menu-item" role="menuitem" :disabled="selectedPending || editorAction.busy.value" @click="menuEditor">
                    <span class="agents__menu-mark" aria-hidden="true">⧉</span>
                    <span class="agents__menu-label">{{ t('agents.detail.menu.editor') }}</span>
                    <KKbd tone="muted" class="agents__menu-kbd">⌘E</KKbd>
                  </button>
                  <div class="agents__menu-sep" role="separator"></div>
                  <button v-if="runningSelected" type="button" class="agents__menu-item agents__menu-item--danger" role="menuitem" :disabled="selectedBlocked" @click="menuStop">
                    <span class="agents__menu-mark" aria-hidden="true">■</span>
                    <span class="agents__menu-label">{{ t('agents.detail.menu.stop') }}</span>
                    <KKbd tone="muted" class="agents__menu-kbd">⌘.</KKbd>
                  </button>
                  <button type="button" class="agents__menu-item agents__menu-item--danger" role="menuitem" :disabled="selectedBlocked" @click="menuDiscard">
                    <span class="agents__menu-mark" aria-hidden="true">✕</span>
                    <span class="agents__menu-label">{{ selectedSession.kind === 'review' ? t('agents.actions.discardReview') : t('agents.actions.discardBranch') }}</span>
                    <KKbd tone="muted" class="agents__menu-kbd">⌘⌫</KKbd>
                  </button>
                </template>
                <template v-else-if="!selectedSession.archived">
                  <button v-if="canReview(selectedSession) && !selectedSession.native" type="button" class="agents__menu-item" role="menuitem" :disabled="selectedBlocked" @click="menuReview">
                    <span class="agents__menu-mark" aria-hidden="true">⚖</span>
                    <span class="agents__menu-label">{{ t('agents.detail.menu.review') }}</span>
                    <KKbd tone="muted" class="agents__menu-kbd">⌘D</KKbd>
                  </button>
                  <button v-if="selectedSession.kind === 'agent' && !selectedSession.native" type="button" class="agents__menu-item" role="menuitem" :disabled="selectedBlocked" @click="menuBranch">
                    <span class="agents__menu-mark" aria-hidden="true">⑂</span>
                    <span class="agents__menu-label">{{ t('agents.detail.menu.branch') }}</span>
                  </button>
                  <button type="button" class="agents__menu-item" role="menuitem" :disabled="selectedPending || editorAction.busy.value" @click="menuEditor">
                    <span class="agents__menu-mark" aria-hidden="true">⧉</span>
                    <span class="agents__menu-label">{{ t('agents.detail.menu.editor') }}</span>
                    <KKbd tone="muted" class="agents__menu-kbd">⌘E</KKbd>
                  </button>
                  <div class="agents__menu-sep" role="separator"></div>
                  <button v-if="selectedSession.kind === 'agent'" type="button" class="agents__menu-item agents__menu-item--danger" role="menuitem" :disabled="selectedBlocked" @click="menuStop">
                    <span class="agents__menu-mark" aria-hidden="true">■</span>
                    <span class="agents__menu-label">{{ t('agents.detail.menu.stop') }}</span>
                    <KKbd tone="muted" class="agents__menu-kbd">⌘.</KKbd>
                  </button>
                  <button type="button" class="agents__menu-item agents__menu-item--danger" role="menuitem" :disabled="selectedBlocked" @click="menuDelete">
                    <span class="agents__menu-mark" aria-hidden="true">✕</span>
                    <span class="agents__menu-label">{{ t('agents.detail.menu.delete') }}</span>
                    <KKbd tone="muted" class="agents__menu-kbd">⌘⌫</KKbd>
                  </button>
                </template>
                <template v-else>
                  <button type="button" class="agents__menu-item agents__menu-item--danger" role="menuitem" :disabled="selectedBlocked" @click="menuDelete">
                    <span class="agents__menu-mark" aria-hidden="true">✕</span>
                    <span class="agents__menu-label">{{ t('agents.detail.menu.delete') }}</span>
                    <KKbd tone="muted" class="agents__menu-kbd">⌘⌫</KKbd>
                  </button>
                </template>
              </div>
            </div>

            <button
              type="button"
              class="agents__close"
              v-tip="t('agents.detail.close')"
              :aria-label="t('agents.detail.close')"
              @click="store.selectSession(undefined)"
            >✕</button>
          </div>
        </div>
        <!-- The reason the ▶ above is down, on its own strip so it shows in every tab the
             disabled button is — a disabled control carries no reachable tooltip. -->
        <p v-if="previewBlocked" class="agents__detail-note">{{ previewBindHint }}</p>
        <KTabs v-model="detailTab" :tabs="detailTabs" class="agents__detail-tabs" @close="onDetailTabClose">
          <template #end>
            <template v-if="detailTab === 'log' && !selectedSession.native">
              <button type="button" class="agents__log-ctl" @click="onExpandAll(true)">{{ t('agents.detail.expandAll') }}</button>
              <button type="button" class="agents__log-ctl" @click="onExpandAll(false)">{{ t('agents.detail.collapseAll') }}</button>
            </template>
          </template>
        </KTabs>
        <!-- Лог, and — with «Поруч із логом» on (stores/browser.ts `split`) — the session browser
             beside it, behind its own seam. The browser half is mounted only while this tab is
             open, for the same parking reason as the Браузер tab below. -->
        <div
          v-show="detailTab === 'log'"
          ref="splitEl"
          class="agents__tabpane agents__tabpane--log"
          :class="{ 'agents__tabpane--split': browserSplit }"
        >
          <div class="agents__log-main">
            <!-- A native session's Лог is the harness's own TUI; Kermanych only hosts its pty. -->
            <template v-if="selectedSession.native">
              <KTerminalView
                v-if="selectedSession.terminalId"
                :key="selectedSession.terminalId"
                class="agents__native-term"
                :terminal-id="selectedSession.terminalId"
                :active="detailTab === 'log'"
              />
              <div v-else class="agents__pane-blank agents__native-idle">
                <span class="agents__pane-blank-eyebrow mono">{{ harnessLabel }} · {{ statusWord(selectedSession) }}</span>
                <p class="agents__pane-blank-text">{{ t('agents.native.idle') }}</p>
                <KBtn
                  v-if="selectedSession.status !== 'merged' && !selectedSession.archived"
                  variant="primary"
                  :loading="resumeNativeAction.busy.value"
                  :disabled="selectedBlocked"
                  @click="onResumeNative(selectedSession)"
                >{{ t('agents.native.resume') }}</KBtn>
              </div>
            </template>
            <KPanel
              v-else
              ref="panelRef"
              class="agents__panel"
              :bare="true"
              :session="selectedSession"
              :refreshing="refreshingId === selectedSession.id"
              :models="store.models"
              :branching="branchAction.busy.value"
              :stopping="stopAction.busy.value"
              :restarting="restartAction.busy.value || selectedPending"
              :answering="answering"
              :summarizing="summaryAction.busy.value"
              :opening-editor="editorAction.busy.value"
              :pending="selectedPending"
              :outgoing="store.outgoing[selectedSession.id] ?? []"
              :model-override="pickOnScreen ? modelPick.value.value : undefined"
              :effort-override="pickOnScreen ? effortPick.value.value : undefined"
              :model-loading="pickOnScreen && modelPick.pending.value"
              :effort-loading="pickOnScreen && effortPick.pending.value"
              :composer-disabled="!transcriptLoaded"
              @stop="onStop"
              @send="onSend"
              @answer="onAnswer"
              @editor="onEditor"
              @branch="onBranch"
              @restart="onRestart"
              @refresh="onRefreshChat"
              @summary="onSummary"
              @newTask="openTaskFromText"
              @expand-all="onExpandAll"
              @effort="onEffort"
              @set-model="onSetModel"
            >
              <!-- Not loaded yet ≠ empty: «Журнал порожній» only once the transcript answered. -->
              <KSkeleton v-if="logPhase === 'skeleton'" variant="lines" :rows="6" />
              <template v-else-if="logPhase === 'ready'">
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
                <div v-else class="agents__log-empty mono">{{ t('agents.detail.logEmpty') }}</div>
              </template>
            </KPanel>
          </div>
          <template v-if="browserSplit && detailTab === 'log'">
            <div
              class="agents__resizer"
              role="separator"
              aria-orientation="vertical"
              :aria-label="t('agents.browser.splitResizeAria')"
              :aria-valuenow="Math.round(splitWidth)"
              :aria-valuemin="MIN_SPLIT_BROWSER"
              tabindex="0"
              v-tip="t('agents.browser.splitResizeTip')"
              @pointerdown="startSplitResize"
              @keydown="onSplitResizeKeydown"
            ></div>
            <div class="agents__split-browser" :style="{ width: splitWidth + 'px' }">
              <KBrowserPane
                :key="selectedSession.id"
                :session="selectedSession"
                :sending="sendingPicks"
                :starting="previewStarting(selectedSession.id)"
                :hold="resizing || splitResizing"
                @send="onSendPicks(selectedSession)"
              />
            </div>
          </template>
        </div>
        <!-- Desktop only. Mounted only while this tab is open: the pane parks the native view
             when it unmounts, so every other tab, a deselect and leaving Агенти hide the page. -->
        <div v-if="detailTab === 'browser' && sessionBrowser.available && !browserSplit" class="agents__tabpane">
          <KBrowserPane
            :key="selectedSession.id"
            :session="selectedSession"
            :sending="sendingPicks"
            :starting="previewStarting(selectedSession.id)"
            :hold="resizing"
            @send="onSendPicks(selectedSession)"
          />
        </div>
        <div v-if="detailTab === 'changes'" class="agents__tabpane agents__changes">
          <div v-if="worktreeGone" class="agents__pane-blank">
            <span class="agents__pane-blank-eyebrow mono">{{ t('agents.changes.historyEyebrow') }}</span>
            <p class="agents__pane-blank-text">
              {{ t('agents.changes.gone') }}
            </p>
          </div>
          <p v-else-if="changesLoading" class="agents__log-empty mono">{{ t('agents.changes.preparing') }}</p>
          <p v-else-if="changesError" class="agents__error" role="alert">{{ changesError }}</p>
          <template v-else-if="changesInfo">
            <div class="agents__changes-summary mono">
              <span class="agents__changes-branch">{{ changesInfo.branch }} → {{ changesInfo.target || '—' }}</span>
              <span>{{ t('agents.changes.commits', { n: changesInfo.ahead }, changesInfo.ahead) }}</span>
              <span v-if="changesInfo.dirty" class="agents__changes-dirty">{{ t('agents.changes.dirty') }}</span>
            </div>
            <ul v-if="changesInfo.conflicts.length" class="agents__conflict mono">
              <li class="agents__conflict-head">{{ t('agents.changes.conflicts') }}</li>
              <li v-for="f in changesInfo.conflicts" :key="f">{{ f }}</li>
            </ul>
            <ul v-if="changesInfo.files.length" class="agents__file-list">
              <li v-for="f in changesInfo.files" :key="f.path" class="agents__file-item">
                <button
                  type="button"
                  class="agents__file-row"
                  :class="{ 'agents__file-row--open': openFile === f.path }"
                  :aria-expanded="openFile === f.path"
                  @click="toggleFile(f.path)"
                >
                  <span class="agents__file-path mono">{{ f.path }}</span>
                  <span class="agents__file-stat mono">
                    <span class="agents__diff-add">+{{ f.added }}</span>
                    <span class="agents__diff-del">−{{ f.removed }}</span>
                  </span>
                </button>
                <KDiffView
                  v-if="openFile === f.path"
                  class="agents__file-diff"
                  :path="f.path"
                  :diff="fileDiff"
                  :loading="fileDiffLoading"
                  :error="fileDiffError"
                  :load="loadSessionRaw"
                  :start-maximized="openFileMaximized"
                  @update:maximized="onFileMaximized"
                  @close="closeFile(true)"
                />
              </li>
            </ul>
            <p v-else class="agents__log-empty mono">{{ t('agents.changes.noFiles') }}</p>
          </template>
        </div>
        <div v-if="detailTab === 'session'" class="agents__tabpane agents__session">
          <section class="agents__task">
            <h3 class="agents__task-title">{{ t('agents.session.description') }}</h3>
            <p v-if="selectedSession.task" class="agents__task-desc">{{ selectedSession.task }}</p>
            <p v-else class="agents__task-empty">{{ t('agents.session.descriptionEmpty') }}</p>
            <!-- The card's copies are signed after the tab opens: one block per image meanwhile. -->
            <div v-if="cardImagesSigning && !taskImages.length" class="agents__task-images">
              <KSkeleton v-for="i in cardImagesSigning" :key="i" variant="block" width="160px" height="120px" />
            </div>
            <div v-else-if="taskImages.length" class="agents__task-images">
              <img
                v-for="(src, i) in taskImages"
                :key="i"
                :src="src"
                class="agents__task-img"
                :alt="t('agents.session.imageAlt')"
              />
            </div>
          </section>
          <dl class="agents__meta">
            <div class="agents__meta-row">
              <dt class="agents__meta-label">{{ t('agents.session.status') }}</dt>
              <dd class="agents__meta-value">
                <KStatusDot :status="selectedSession.status" />
                <span class="mono">{{ statusWord(selectedSession) }}</span>
              </dd>
            </div>
            <div class="agents__meta-row">
              <dt class="agents__meta-label">{{ t('agents.session.model') }}</dt>
              <dd class="agents__meta-value mono">{{ selectedSession.model || '—' }}</dd>
            </div>
            <div class="agents__meta-row">
              <dt v-tip="t('agents.session.sessionIdHint')" class="agents__meta-label">{{ t('agents.session.sessionId') }}</dt>
              <dd class="agents__meta-value mono">
                <button
                  v-if="selectedSession.ompSessionId"
                  type="button"
                  class="agents__meta-copy"
                  v-tip="t('agents.session.sessionIdCopy')"
                  @click="copySessionId(selectedSession.ompSessionId)"
                >{{ selectedSession.ompSessionId }}</button>
                <span v-else>{{ t('agents.session.sessionIdPending') }}</span>
              </dd>
            </div>
            <div class="agents__meta-row">
              <dt class="agents__meta-label">{{ t('agents.session.branch') }}</dt>
              <dd class="agents__meta-value mono">{{ selectedSession.branch || '—' }}</dd>
            </div>
            <div class="agents__meta-row">
              <dt class="agents__meta-label">Worktree</dt>
              <dd class="agents__meta-value mono">{{ selectedSession.worktree ? t('agents.session.worktreeYes') : t('agents.session.worktreeNo') }}</dd>
            </div>
            <div class="agents__meta-row">
              <dt class="agents__meta-label">{{ t('agents.session.base') }}</dt>
              <dd class="agents__meta-value mono">{{ selectedSession.baseBranch || '—' }}</dd>
            </div>
            <!-- The PR «Створити ПР» opened and what GitHub says about it now. Checked only when
                 the session is selected and eligible (prCheckEligible); otherwise just the link. -->
            <div v-if="selectedSession.prOpened" class="agents__meta-row">
              <dt class="agents__meta-label">{{ t('agents.pr.label') }}</dt>
              <dd class="agents__meta-value mono">
                <a
                  v-if="prLink"
                  class="agents__meta-link"
                  :href="prLink.url"
                  target="_blank"
                  rel="noopener noreferrer"
                >{{ prLink.label }}</a>
                <span v-if="prStateWord">{{ prStateWord }}</span>
                <template v-if="!prLink && !prStateWord">—</template>
              </dd>
            </div>
            <div class="agents__meta-row">
              <dt class="agents__meta-label">{{ t('agents.session.context') }}</dt>
              <dd class="agents__meta-value mono">{{ ctxOf(selectedSession) ?? '—' }}</dd>
            </div>
            <div class="agents__meta-row">
              <dt
                v-tip="skillsHint"
                class="agents__meta-label"
              >{{ t('agents.session.skills') }}</dt>
              <dd class="agents__meta-value mono">{{ usedSkills.join(', ') || '—' }}</dd>
            </div>
            <div class="agents__meta-row">
              <dt class="agents__meta-label">{{ t('agents.session.tokens') }}</dt>
              <dd class="agents__meta-value mono">{{ tokenTotal ?? '—' }}</dd>
            </div>
            <!-- claude writes no cost into its transcript, so a native claude session has none. -->
            <div v-if="sessionCostKnown(selectedSession)" class="agents__meta-row">
              <dt class="agents__meta-label">{{ t('agents.session.cost') }}</dt>
              <dd class="agents__meta-value mono">{{ costLabel || '—' }}</dd>
            </div>
            <div class="agents__meta-row">
              <dt
                v-tip="sessionIdHint"
                class="agents__meta-label"
              >{{ t('agents.session.id') }}</dt>
              <dd class="agents__meta-value mono agents__meta-value--id">{{ selectedSession.id }}</dd>
            </div>
            <div v-if="engineSessionId" class="agents__meta-row">
              <dt
                v-tip="engineSessionIdHint"
                class="agents__meta-label"
              >{{ selectedSession?.native && selectedSession.runtime === 'codex' ? t('agents.native.engineIdCodex') : t('agents.session.engineId') }}</dt>
              <dd class="agents__meta-value mono agents__meta-value--id">{{ engineSessionId }}</dd>
            </div>
          </dl>
        </div>
        <div v-if="detailTab === 'docs'" class="agents__tabpane agents__docs">
          <!-- Mid-task documents: the agent writes the request / handoff now, without the
               finish sheet. Agent sessions only — a chat has no branch to put it on. -->
          <div v-if="selectedSession.kind === 'agent' && !worktreeGone" class="agents__docs-actions">
            <KBtn
              v-for="k in DOCS_WRITE_KINDS"
              :key="k"
              variant="secondary"
              :loading="docWriting === k"
              :disabled="!!docWriting"
              :title="t(`agents.docs.write.${k}Hint`)"
              @click="writeDoc(k)"
            >{{ t(`agents.docs.write.${k}`) }}</KBtn>
          </div>
          <KSkeleton v-if="docsPhase === 'skeleton'" variant="rows" :rows="4" />
          <template v-else-if="docsPhase === 'blank'"></template>
          <template v-else-if="usedDocs.length || changedDocs.length">
            <section v-if="usedDocs.length" class="agents__docs-group">
              <h3 v-tip="docsUsedHint" class="agents__docs-title">{{ t('agents.docs.usedTitle') }}</h3>
              <ul class="agents__docs-read">
                <li v-for="p in usedDocs" :key="p" class="agents__docs-read-item">
                  <span class="agents__docs-read-path mono">{{ p }}</span>
                </li>
              </ul>
            </section>
            <section v-if="changedDocs.length" class="agents__docs-group">
              <h3 class="agents__docs-title">{{ t('agents.docs.changedTitle') }}</h3>
              <!-- A finished session's rows are the card's copy: no worktree behind them, so no
                   diff and no «Задача →» — only the way back to both. -->
              <p v-if="changedDocsListOnly" class="agents__hint mono">{{ t('agents.docs.finishedHint') }}</p>
              <ul class="agents__file-list">
                <li v-for="d in changedDocs" :key="d.path" class="agents__file-item">
                  <div v-if="changedDocsListOnly" class="agents__docs-row">
                    <div class="agents__file-row agents__file-row--static">
                      <span class="agents__file-path mono">{{ d.path }}</span>
                      <KTag v-if="docsLayoutKind(d.path)" class="agents__docs-kind">
                        {{ t(`agents.docs.kind.${docsLayoutKind(d.path)}`) }}
                      </KTag>
                      <span class="agents__file-stat mono">
                        <span class="agents__diff-add">+{{ d.added }}</span>
                        <span class="agents__diff-del">−{{ d.removed }}</span>
                      </span>
                    </div>
                  </div>
                  <div v-else class="agents__docs-row">
                    <button
                      type="button"
                      class="agents__file-row"
                      :class="{ 'agents__file-row--open': openFile === d.path }"
                      :aria-expanded="openFile === d.path"
                      @click="toggleFile(d.path)"
                    >
                      <span class="agents__file-path mono">{{ d.path }}</span>
                      <KTag v-if="docsLayoutKind(d.path)" class="agents__docs-kind">
                        {{ t(`agents.docs.kind.${docsLayoutKind(d.path)}`) }}
                      </KTag>
                      <span class="agents__file-stat mono">
                        <span class="agents__diff-add">+{{ d.added }}</span>
                        <span class="agents__diff-del">−{{ d.removed }}</span>
                      </span>
                    </button>
                    <button
                      v-if="docsLayoutKind(d.path) === 'api-request' || docsLayoutKind(d.path) === 'handoff'"
                      v-tip="t('agents.docs.toTaskHint')"
                      type="button"
                      class="agents__docs-handover mono"
                      @click="openDocTask(d.path)"
                    >{{ t('agents.docs.toTask') }}</button>
                  </div>
                  <KDiffView
                    v-if="!changedDocsListOnly && openFile === d.path"
                    class="agents__file-diff"
                    :path="d.path"
                    :diff="fileDiff"
                    :loading="fileDiffLoading"
                    :error="fileDiffError"
                    :load="loadSessionRaw"
                    :start-maximized="openFileMaximized"
                    @update:maximized="onFileMaximized"
                    @close="closeFile(true)"
                  />
                </li>
              </ul>
            </section>
          </template>
          <p v-else class="agents__log-empty mono">{{ t('agents.docs.empty') }}</p>
        </div>
        <!-- Знахідки: what the agent reported outside its task; filed from here, never automatically. -->
        <div v-if="detailTab === 'findings'" class="agents__tabpane agents__docs">
          <SessionFindings :session="selectedSession" />
        </div>
        <!-- QA tab: the checklist lives on the linked cloud CARD, so it is read from the board
             store (not the transcript) and persists past this session's archive. A brand-new
             task has none until a «Створити ПР» run generates it — hence the empty state. -->
        <div v-if="detailTab === 'qa'" class="agents__tabpane agents__docs">
          <KSkeleton v-if="qaPhase === 'skeleton'" variant="rows" :rows="4" />
          <template v-else-if="qaPhase === 'blank'"></template>
          <template v-else-if="qaChecklist?.items.length">
            <div class="agents__qa-head">
              <h3 class="agents__docs-title">{{ t('agents.qa.title') }}</h3>
              <span class="agents__qa-count mono">{{ qaDone }}/{{ qaChecklist.items.length }}</span>
            </div>
            <ul class="agents__qa-list">
              <li v-for="item in qaChecklist.items" :key="item.id" class="agents__qa-item">
                <KCheckbox
                  :model-value="item.checked"
                  :label="item.text"
                  @update:model-value="(v: boolean) => onQaToggle(item.id, v)"
                />
              </li>
            </ul>
          </template>
          <p v-else class="agents__log-empty mono">{{ t('agents.qa.empty') }}</p>
        </div>
        </template>
        <div v-else class="agents__detail-blank mono">{{ t('agents.detail.blank') }}</div>
      </aside>
    </div>

    <!-- NEW-TASK LAUNCHER — two columns: left = what to do, right = where it lands -->
    <!-- Persistent while a submit or a publish runs: Esc/backdrop cannot drop the form under a
         request that is still writing it, and `inert` holds every field still meanwhile. -->
    <KModal v-model="launcherOpen" :title="launcherTitle" width="880px" flush :persistent="launcherLocked">
      <template #head-meta>
        <div class="agents-launcher__headmeta">
          <span class="agents-launcher__spacer"></span>
          <span v-if="launchScopeName" class="agents-launcher__ws">{{ launchScopeName }}</span>
          <span class="agents-launcher__spacer"></span>
          <span class="agents-launcher__esc mono">{{ t('agents.launcher.esc') }}</span>
        </div>
      </template>

      <div class="agents-launcher" :inert="launcherLocked" @keydown="onLauncherKeydown">
        <!-- LEFT — what to do and which agent runs it -->
        <div class="agents-launcher__main">
          <div>
            <div class="agents-launcher__label-row">
              <span class="agents-launcher__label agents-launcher__label--strong">{{ t('agents.launcher.taskLabel') }}</span>
              <span class="agents-launcher__hint-inline mono">{{ t('agents.launcher.taskKbd') }}</span>
            </div>
            <textarea
              ref="taskInput"
              v-model="draftTask"
              class="agents-launcher__task"
              rows="9"
              :placeholder="t('agents.launcher.taskPlaceholder')"
              @paste="!launchNative && onLaunchPaste($event)"
              @drop.prevent="!launchNative && onLaunchDrop($event)"
              @dragover.prevent
            />
          </div>

          <div v-if="!launchNative" class="agents-launcher__attach">
            <button type="button" class="agents-launcher__attach-btn mono" @click="launchFileInput?.click()">
              {{ t('agents.launcher.image') }}
            </button>
            <input
              ref="launchFileInput"
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              class="agents__file"
              @change="onLaunchFilePick"
            />
            <span class="agents-launcher__attach-note mono">{{ t('agents.launcher.dragHint') }}</span>
          </div>
          <KAttachStrip v-if="launchImages.length && !launchNative" :images="launchImages" @remove="removeLaunchImage" />
          <p v-if="launchError" class="agents__error" role="alert">{{ launchError }}</p>

          <div class="agents-launcher__name">
            <div class="agents-launcher__label">{{ t('agents.launcher.nameLabel') }}</div>
            <input
              ref="nameField"
              v-model="draftName"
              class="agents-launcher__name-input"
              :placeholder="t('agents.launcher.namePlaceholder')"
              @input="nameEdited = true"
            />
            <div class="agents-launcher__hint mono">{{ t('agents.launcher.branchNameGenerated') }}</div>
          </div>

          <!-- «Модель» and «Рівень роздумів» — how the agent runs, not where it lands, so
               they sit under the ask rather than in the right column. Paired on one row: two
               narrow selects read as a couple and keep the modal from growing a scrollbar. -->
          <div v-if="!launchNative" class="agents-launcher__run">
            <div class="agents-launcher__duo">
              <div>
                <div class="agents-launcher__label">{{ t('agents.session.model') }}</div>
                <!-- `searchable`: the catalog is ~26 rows all named «Claude …», so the way to
                     «Haiku» is to type it, not to scroll past twenty siblings. -->
                <KSelect
                  v-model="draftModel"
                  :options="modelPickOptions"
                  :placeholder="t('agents.launcher.defaultOption')"
                  searchable
                />
              </div>
              <div>
                <div class="agents-launcher__label">{{ t('agents.launcher.effortLabel') }}</div>
                <KSelect v-model="draftEffort" :options="effortPickOptions" :placeholder="t('agents.launcher.defaultOption')" />
              </div>
            </div>
          </div>

          <!-- «Глибокий аналіз» — HOW the agent takes the task on, so it sits with the ask and
               the model rather than with where the branch lands. A card field: seeded from the
               «Нова задача» menu or from the card being edited, and switchable here either way,
               so a mis-picked menu item or a backlog card's mode is one click to change. Not
               conditional on «Режим»: a native harness gets the same opening prompt. -->
          <div class="agents-launcher__block agents-launcher__block--stack">
            <div class="agents-launcher__check">
              <KCheckbox
                :model-value="draftDeep"
                :label="t('agents.launcher.deepLabel')"
                :disabled="draftAutoRun"
                @update:model-value="onDraftModes(withDeepAnalysis, $event)"
              />
              <p class="agents-launcher__check-desc">
                {{ t('agents.launcher.deepDesc') }}
              </p>
            </div>
            <!-- «Дозволити автовиконання»: «Посіпака» on the author's machine may take the card
                 by itself. It takes effect for «В беклог»; «Запустити» is a manual run and only
                 stores the flag. Not with «Глибокий аналіз» (nobody is there to interview), and
                 only the author may switch it on — tasks_guard() refuses anyone else. -->
            <div class="agents-launcher__check">
              <KCheckbox
                :model-value="draftAutoRun"
                :label="t('minion.autoRun.label')"
                :disabled="draftDeep || draftAutoRunLocked"
                @update:model-value="onDraftModes(withAutoRun, $event)"
              />
              <p class="agents-launcher__check-desc">
                {{ draftAutoRunLocked ? t('minion.autoRun.authorOnly') : t('minion.autoRun.caption') }}
              </p>
            </div>
          </div>
        </div>

        <!-- RIGHT — where it lands -->
        <div class="agents-launcher__side">
          <div>
            <div class="agents-launcher__label">{{ t('agents.session.branch') }}</div>
            <div class="agents-launcher__branch mono">{{ branchPreview }}</div>
            <div class="agents-launcher__hint mono">{{ branchHint }}</div>
          </div>

          <!-- «Режим» — Kermanych's managed session, or the harness's own TUI in a terminal. -->
          <div>
            <div class="agents-launcher__label">{{ t('agents.native.modeLabel') }}</div>
            <div class="agents-launcher__seg agents-launcher__seg--fit">
              <button
                v-for="opt in LAUNCH_MODES"
                :key="opt"
                type="button"
                class="agents-launcher__seg-btn mono"
                :class="{ 'agents-launcher__seg-btn--active': opt === draftMode }"
                @click="pickLaunchMode(opt)"
              >{{ opt === 'managed' ? t('agents.native.modeManaged') : opt }}</button>
            </div>
            <div class="agents-launcher__hint mono">{{ t('agents.native.modeHint') }}</div>
          </div>

          <div>
            <div class="agents-launcher__label">{{ t('agents.launcher.typeLabel') }}</div>
            <div class="agents-launcher__seg agents-launcher__seg--grid2">
              <button
                v-for="opt in prefixOptions"
                :key="opt"
                type="button"
                class="agents-launcher__seg-btn mono"
                :class="{ 'agents-launcher__seg-btn--active': opt === draftPrefix }"
                @click="draftPrefix = opt"
              >{{ opt }}</button>
            </div>
          </div>

          <div>
            <div class="agents-launcher__label-row agents-launcher__label-row--tight">
              <span class="agents-launcher__label">{{ t('agents.launcher.platformLabel') }}</span>
              <span class="agents-launcher__optional mono">{{ t('agents.launcher.optional') }}</span>
            </div>
            <div class="agents-launcher__seg">
              <button
                v-for="opt in platformOptions"
                :key="opt"
                type="button"
                class="agents-launcher__seg-btn mono"
                :class="{ 'agents-launcher__seg-btn--active': opt === draftPlatform }"
                @click="draftPlatform = draftPlatform === opt ? undefined : opt"
              >{{ opt }}</button>
            </div>
          </div>

          <div class="agents-launcher__block agents-launcher__block--stack">
            <div class="agents-launcher__check">
              <KCheckbox v-model="draftWorktree" :label="t('agents.launcher.worktreeLabel')" />
              <p class="agents-launcher__check-desc">
                {{ t('agents.launcher.worktreeDesc') }}
              </p>
            </div>
            <div v-if="draftWorktree" class="agents-launcher__from">
              <span class="agents-launcher__from-label mono">{{ t('agents.launcher.from') }}</span>
              <!-- `searchable`: `listBranches` hands over every local `refs/heads`, and in a
                   long-lived repo that is hundreds of rows sharing a handful of prefixes
                   («feature/…», «fix/…»). Scrolling to the base is hopeless there and
                   closed-list prefix type-ahead only walks the prefix; typing «csp» has to
                   find «fix/csp-iframe». -->
              <KSelect v-model="draftBaseBranch" :options="launchBranches" :loading="launchBranchesLoading" searchable />
            </div>
          </div>

          <!-- «Приховати з дошки» — a VIEW flag, so it sits beside the other launch
               switches rather than in the footer: it changes nothing about how the agent
               runs, only who has to look at the card. Not conditional on `draftWorktree`
               and not conditional on edit mode — unchecking it here is the only way back
               onto the board, since a hidden card has no card to click there. -->
          <div class="agents-launcher__block">
            <div class="agents-launcher__check">
              <KCheckbox v-model="draftHidden" :label="t('agents.launcher.hiddenLabel')" />
              <p class="agents-launcher__check-desc">
                {{ t('agents.launcher.hiddenDesc') }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- The way out of a local-only project: a card lives in the cloud, so the project has
           to get there first. Below the form, above the controls, so it reads as the reason
           «В беклог» would refuse rather than as another launch option. -->
      <div v-if="needsPublish" class="agents-launcher__publish">
        <p class="agents__hint mono">{{ t('agents.hints.publishFirst') }}</p>
        <KSelect
          v-model="publishInto"
          :label="t('agents.launcher.workspaceLabel')"
          :options="workspaceOptions"
          :placeholder="t('agents.launcher.workspacePlaceholder')"
        />
        <KBtn :loading="publishing" :disabled="!publishInto || launchBusy !== null" @click="publishAndFile">
          {{ t('agents.launcher.publishBtn') }}
        </KBtn>
        <p v-if="!workspaceOptions.length" class="agents__hint mono">
          {{ t('agents.launcher.createWorkspaceFirst') }}
        </p>
      </div>

      <template #controls>
        <div class="agents-launcher__foot">
          <!-- Destructive, so it sits alone on the far side of the spacer instead of beside
               «Запустити». Only while editing: there is nothing to delete before the task
               exists, and this modal is the task's only detail view — the board's cards
               carry a ✕, but a task opened for editing must be closable from here too. -->
          <KBtn
            v-if="editingTask"
            variant="ghost"
            :loading="cardDelete.busyFor(editingTask.id)"
            :disabled="launcherLocked"
            @click="onDeleteCard(editingTask)"
          >
            {{ t('agents.launcher.delete') }}
          </KBtn>
          <span v-if="launcherError" class="agents__error" role="alert">{{ launcherError }}</span>
          <span v-else class="agents-launcher__foot-hint mono">{{ footHint }}</span>
          <span class="agents-launcher__spacer"></span>
          <KBtn variant="ghost" :disabled="launcherLocked" @click="launcherOpen = false">{{ t('agents.launcher.cancel') }}</KBtn>
          <KBtn
            variant="secondary"
            :loading="launchBusy === 'task'"
            :disabled="!canLaunch || launcherLocked"
            @click="submitLauncher(true)"
          >{{ editingTaskId ? t('agents.launcher.save') : t('agents.launcher.backlog') }}</KBtn>
          <!-- No `title` here either, and for the same reason: it only ever had content while
               the button was disabled, so it was never reachable. `footHint` above already
               renders BIND_HINT visibly, which is why the user never lost anything — the dead
               attribute only told the next reader that the reason was covered. -->
          <KBtn
            variant="primary"
            :loading="launchBusy === 'launch'"
            :disabled="!canLaunch || !isBound || launcherLocked"
            @click="submitLauncher(false)"
          >
            {{ t('agents.launcher.launch') }}<KKbd class="agents-launcher__kbd">⌘⏎</KKbd>
          </KBtn>
        </div>
      </template>
    </KModal>

    <!-- MERGE — pour a discussion branch's conclusion into its parent -->
    <KModal v-model="mergeOpen" :title="mergeIsReview ? t('agents.merge.reviewTitle') : t('agents.merge.branchTitle')">
      <div class="agents__form">
        <label class="agents__field">
          <span class="agents__field-label">{{ t('agents.merge.summaryLabel') }}</span>
          <textarea
            v-model="mergeSummary"
            class="agents__textarea mono"
            rows="6"
            :placeholder="mergeIsReview ? t('agents.merge.summaryPlaceholderReview') : t('agents.merge.summaryPlaceholder')"
          />
        </label>
        <p class="agents__hint mono">
          {{ t('agents.merge.hint') }}
          (<code class="mono">merged</code>).
        </p>
        <p v-if="mergeError" class="agents__error" role="alert">{{ mergeError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="mergeOpen = false">{{ t('agents.launcher.cancel') }}</KBtn>
        <KBtn variant="primary" :loading="mergeBusy" @click="submitMerge">{{ mergeIsReview ? t('agents.merge.give') : t('agents.merge.pour') }}</KBtn>
      </template>
    </KModal>

    <!-- PREVIEW CONFIG — how to run this project's app for a live branch preview -->
    <KModal v-model="previewCfgOpen" :title="t('agents.preview.title')" :persistent="previewCfgSave.busy.value">
      <div class="agents__form">
        <label class="agents__field">
          <span class="agents__field-label">{{ t('agents.preview.webLabel') }}</span>
          <textarea v-model="draftWebCmd" class="agents__textarea mono" rows="2" />
        </label>
        <label class="agents__field">
          <span class="agents__field-label">{{ t('agents.preview.apiLabel') }}</span>
          <textarea v-model="draftApiCmd" class="agents__textarea mono" rows="2" />
        </label>
        <p class="agents__hint mono">
          {{ t('agents.preview.hint') }}
        </p>
        <p v-if="previewCfgError" class="agents__error" role="alert">{{ previewCfgError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" :disabled="previewCfgSave.busy.value" @click="previewCfgOpen = false">{{ t('agents.launcher.cancel') }}</KBtn>
        <KBtn variant="primary" :loading="previewCfgSave.busy.value" :disabled="!draftWebCmd.trim()" @click="submitPreviewConfig">
          {{ t('agents.preview.run') }}
        </KBtn>
      </template>
    </KModal>

    <!-- FINISH — retire the session: the worktree goes, the branch stays for its pull request -->
    <KModal v-model="finishOpen" :title="t('agents.finish.title')" persistent>
      <div class="agents__form">
        <div v-show="finishFiles.length">
          <p class="agents__error" role="alert">
            {{ t('agents.finish.conflictError') }}
          </p>
          <p class="agents__hint mono">{{ t('agents.finish.conflictFiles') }}</p>
          <ul class="agents__conflict mono">
            <li v-for="f in finishFiles" :key="f">{{ f }}</li>
          </ul>
          <p class="agents__hint mono">
            {{ t('agents.finish.conflictHint') }}
          </p>
        </div>
        <div v-show="!finishFiles.length">
          <p v-if="finishData">
            {{ t('agents.finish.action') }} <code class="mono">{{ finishData.branch }}</code>
          </p>
          <p v-if="finishData" class="agents__hint mono">
            {{ t('agents.finish.aheadInfo', { n: finishData.ahead, base: finishData.target, dirty: finishData.dirty ? t('agents.finish.aheadDirty') : '' }, finishData.ahead) }}
          </p>
          <p v-else class="agents__hint mono">{{ t('agents.changes.preparing') }}</p>
          <p v-if="finishData && finishData.behind > 0" class="agents__hint">
            {{ t('agents.finish.behindInfo', { n: finishData.behind, base: finishData.target, action: finishHasPr ? t('agents.finish.commit') : t('agents.finish.createPr') }, finishData.behind) }}
          </p>
          <!-- DOCUMENTATION POLICY — only for a project that switched it on: what the api will
               refuse PR / commit / finish over. A handoff or an API request the operator wants
               on this branch is asked for from the «Документація» tab, not here. -->
          <template v-if="finishData?.docsGate.enabled">
            <template v-if="docsFailures.length">
              <p class="agents__error" role="alert">{{ t('agents.finish.docsMissing') }}</p>
              <ul class="agents__conflict">
                <li v-for="f in docsFailures" :key="f">{{ t(DOCS_FAILURE_KEYS[f]) }}</li>
              </ul>
              <p class="agents__hint mono">{{ t('agents.finish.docsBlocked') }}</p>
            </template>
          </template>
        </div>
        <p v-if="finishError" class="agents__error" role="alert">{{ finishError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="finishOpen = false">{{ t('agents.finish.close') }}</KBtn>
        <KBtn v-show="finishFiles.length" variant="secondary" :loading="resolveBusy" @click="resolveAuto">{{ t('agents.finish.resolveAuto') }}</KBtn>
        <KBtn
          v-if="!finishFiles.length && docsFailures.length"
          variant="secondary"
          :loading="docsBusy"
          :disabled="prBusy || finishBusy"
          @click="submitDocs"
        >{{ t('agents.finish.completeDocs') }}</KBtn>
        <KBtn
          v-show="!finishFiles.length"
          variant="secondary"
          :loading="prBusy"
          :disabled="finishBusy || docsBusy || !finishData || !!docsFailures.length"
          @click="finishHasPr ? submitCommit() : submitPr()"
        >{{ finishHasPr ? t('agents.finish.commit') : t('agents.finish.createPr') }}</KBtn>
        <KBtn
          variant="primary"
          :loading="finishBusy"
          :disabled="prBusy || docsBusy || !!finishFiles.length || !finishData || !!docsFailures.length"
          @click="submitFinish"
        >{{ t('agents.finish.action') }}</KBtn>
      </template>
    </KModal>

    <!-- MERGED PR — the PR this session opened is merged on GitHub: offer to retire the session
         the way «Завершити» does (the api re-checks the merge and skips the documentation gate).
         Asked once per selection; «Не зараз» is not remembered. -->
    <KModal
      :model-value="!!prMerged"
      :title="t('agents.pr.mergedTitle')"
      :persistent="closeMergedAction.busy.value"
      @update:model-value="(open: boolean) => { if (!open) prMerged = null; }"
    >
      <div v-if="prMerged" class="agents__form">
        <i18n-t keypath="agents.pr.mergedLead" tag="p">
          <template #pr>
            <a
              v-if="prMerged.check.url"
              class="agents__meta-link mono"
              :href="prMerged.check.url"
              target="_blank"
              rel="noopener noreferrer"
            >{{ prLabel(prMerged.check.url, prMerged.check.number) }}</a>
            <span v-else class="mono">PR</span>
          </template>
        </i18n-t>
        <template v-if="prMerged.check.leftover?.dirty || prMerged.check.leftover?.unpushed">
          <p v-if="prMerged.check.leftover?.dirty" class="agents__error">{{ t('agents.pr.leftoverDirty') }}</p>
          <p v-if="prMerged.check.leftover?.unpushed" class="agents__error">{{ t('agents.pr.leftoverUnpushed') }}</p>
          <i18n-t keypath="agents.pr.leftoverBranch" tag="p" class="agents__hint">
            <template #branch><code class="mono">{{ prMerged.branch }}</code></template>
          </i18n-t>
        </template>
        <p v-if="closeMergedError" class="agents__error" role="alert">{{ closeMergedError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" :disabled="closeMergedAction.busy.value" @click="prMerged = null">{{ t('agents.pr.notNow') }}</KBtn>
        <KBtn
          variant="primary"
          :loading="closeMergedAction.busy.value"
          @click="prMerged && closeMergedAction.run(prMerged.id)"
        >{{ t('agents.pr.close') }}</KBtn>
      </template>
    </KModal>

    <!-- DOCUMENT → CARD — an API request (or handoff) becomes a task on another project's board
         mid-task: the other side's agent starts from the card, this session keeps working. -->
    <KModal v-model="docTaskOpen" :title="t('agents.docTask.title')" width="720px">
      <div class="agents__form">
        <p class="agents__hint mono">{{ t('agents.docTask.source', { path: docTaskPath }) }}</p>
        <KSelect
          v-model="docTaskProject"
          :label="t('agents.docTask.project')"
          :options="docTaskProjectOptions"
          :placeholder="t('agents.docTask.projectPlaceholder')"
        />
        <KSkeleton v-if="docTaskReadPhase === 'skeleton'" variant="line" :label="t('agents.docTask.taskTitle')" />
        <KField v-else v-model="docTaskTitle" :label="t('agents.docTask.taskTitle')" />
        <KSelect
          v-model="docTaskAssignee"
          :label="t('agents.docTask.assignee')"
          :options="docTaskAssigneeOptions"
          :placeholder="t('agents.docTask.unassigned')"
          :loading="docTaskMembersLoading"
        />
        <KSkeleton v-if="docTaskReadPhase === 'skeleton'" variant="lines" :rows="8" :label="t('agents.docTask.description')" />
        <KField v-else v-model="docTaskDescription" :label="t('agents.docTask.description')" multiline :rows="12" />
        <p v-if="docTaskError" class="agents__error" role="alert">{{ docTaskError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="docTaskOpen = false">{{ t('agents.finish.close') }}</KBtn>
        <KBtn variant="secondary" :disabled="!docTaskDescription.trim()" @click="copyDocTask">{{ t('agents.docTask.copy') }}</KBtn>
        <KBtn
          variant="primary"
          :loading="docTaskBusy"
          :disabled="!docTaskTitle.trim() || !projects.byId.has(docTaskProject)"
          @click="submitDocTask"
        >{{ t('agents.docTask.create') }}</KBtn>
      </template>
    </KModal>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { confirmAction } from '../lib/confirm';
import {
  buildChatBlocks,
  branchName,
  taskNameFromText,
  skillsUsed,
  docsRead,
  isDocPath,
  docsLayoutKind,
  type DocsWriteKind,
  type DocsGateFailure,
  type ImageInput,
  type PrCheck,
  type PrCheckState,
  type Session,
  type SessionStatus,
  type TranscriptEntry,
  type ThinkingLevel,
  type RpcExtensionUIResponse,
} from '@kermanych/core';
import { createTask as cloudCreateTask, signedTaskImageUrls } from '@kermanych/cloud';
import type { Task } from '@kermanych/cloud';
import { useOrchestrator } from 'stores/orchestrator';
import { useRouter } from 'vue-router';
import { useProjects } from 'stores/projects';
import { useBoard } from 'stores/board';
import { useAuth } from 'stores/auth';
import { useSeen } from 'stores/seen';
import { api, type FileDiff, type MessageMode } from '../lib/api';
import { EXPAND_ALL_NONE, nextExpandAll, type ExpandAllCommand } from '../lib/expand-all';
import { sessionScopedProjectIds } from '../lib/scope';
import type { Bucket } from '../lib/buckets';
import { activeAgentCount, projectNodeId, sessionNodeId, workspaceNodeId } from '../lib/agentMap';
import { changedDocsView, ownReports, unionInOrder } from '../lib/session-reports';
import { imageToFile } from '../lib/images';
import {
  autoRunSwitchLocked,
  cardModesFromCard,
  myBacklogTasks,
  taskInsertFromDraft,
  taskPatchFromDraft,
  withAutoRun,
  withDeepAnalysis,
  type CardModes,
} from '../lib/tasks-view';
import { planBacklogPublication } from '../lib/publish-backlog';
import {
  byNewestLaunch,
  byNewestSession,
  byNewestTask,
  filterSessions,
  filterTaskCards,
  newestActivityAt,
  newestLaunchAt,
  newestUpdateAt,
} from '../lib/agents-board';
import KPanel from 'components/kit/KPanel.vue';
import KRequestBlock from 'components/kit/KRequestBlock.vue';
import AgentMap from 'components/agents/AgentMap.vue';
import KStatusDot from 'components/kit/KStatusDot.vue';
import KTag from 'components/kit/KTag.vue';
import KSessionCard from 'components/kit/KSessionCard.vue';
import SessionFindings from 'components/agents/SessionFindings.vue';
import KAnalysisMark from 'components/kit/KAnalysisMark.vue';
import KMinionMark from 'components/kit/KMinionMark.vue';
import KDecisionMark from 'components/kit/KDecisionMark.vue';
import KNotNeededMark from 'components/kit/KNotNeededMark.vue';
import { cardDecisionReason, cardNotNeededReason, sessionDecisionReason, sessionNotNeededReason } from '../lib/minion';
import KSplitButton from 'components/kit/KSplitButton.vue';
import { type KIconName } from 'components/kit/KIcon.vue';
import KTabs from 'components/kit/KTabs.vue';
import KDiffView from 'components/kit/KDiffView.vue';
import KBtn from 'components/kit/KBtn.vue';
import KKbd from 'components/kit/KKbd.vue';
import KIconButton from 'components/kit/KIconButton.vue';
import KModal from 'components/kit/KModal.vue';
import KAttachStrip from 'components/kit/KAttachStrip.vue';
import KCheckbox from 'components/kit/KCheckbox.vue';
import KField from 'components/kit/KField.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import { handleOf } from '../lib/members';
import { BRANCH_PREFIXES, PLATFORMS, type BranchPrefix, type Platform } from '@kermanych/core';
import { useImageAttach } from '../composables/useImageAttach';
import { useNow } from '../composables/useNow';
import { relativeTime, renderTime } from '../lib/time';
import { tokens, usageTokens, usd } from '../lib/format';
import { EFFORT_OPTIONS } from '../lib/effort';
import { modelOptions, effortOptions } from '../lib/models';
import { useResizablePanel } from '../composables/useResizablePanel';
import { useVirtualList } from '../composables/useVirtualList';
import { nativeHarnessName, nativeRuntimeFor, sessionCostKnown, sessionLaunchMode, LAUNCH_MODES, readLaunchMode, writeLaunchMode, type LaunchMode } from '../lib/native-session';
import KTerminalView from 'components/kit/KTerminalView.vue';
import KBrowserPane from 'components/kit/KBrowserPane.vue';
import { useSessionBrowser } from 'stores/browser';
import { composePicksMessage, picksImages } from '../lib/browser-picks';
import { historyLoadFor } from '../lib/open-session-history';
import { slotWaitLabel } from '../lib/slot-wait';
import KSkeleton from 'components/kit/KSkeleton.vue';
import { useAsyncAction, useKeyedAction, errorText } from '../composables/useAsyncAction';
import { useOptimisticValue } from '../composables/useOptimisticValue';
import { useLoadPhase } from '../composables/useLoadPhase';
import { usePending } from 'stores/pending';
import { needsSignIn } from '../lib/session-auth';

// The Агенти screen (design-system section 07): the board of session cards for whatever is
// in scope — one project, or every project of a workspace — plus the full panel for the
// selected session and the new-agent launcher. All mutations go through the Pinia store.
const store = useOrchestrator();
const { t } = useI18n();
// Sessions waiting for the server to report an action's result (stopped, deleted, forked…).
const pending = usePending();

// ── Agent map (spec docs/specs/2026-10-22-agent-map.md) ───────────────────
// Open: the map stands in for the chat pane. Not persisted — a reload shows the usual screen.
const mapOpen = ref(false);
// What the map fits into view when it opens: the button aims at the rail's selection, ◈ at its
// session (unfolded, so the subagents it was pressed for are on screen).
const mapFocus = ref<{ id: string | undefined; unfold: boolean }>({ id: undefined, unfold: false });
const activeAgents = computed(() => activeAgentCount(store.sessions));

function toggleAgentMap(): void {
  if (mapOpen.value) {
    mapOpen.value = false;
    return;
  }
  const scope = store.selectedProjectId
    ? projectNodeId(store.selectedProjectId)
    : store.selectedWorkspaceId
      ? workspaceNodeId(store.selectedWorkspaceId)
      : undefined;
  mapFocus.value = { id: scope, unfold: false };
  mapOpen.value = true;
}

function openAgentMapAt(sessionId: string): void {
  mapFocus.value = { id: sessionNodeId(sessionId), unfold: true };
  mapOpen.value = true;
}

// A session card on the map, like a card in the list, means «go to this agent».
function onMapOpenSession(id: string): void {
  mapOpen.value = false;
  store.selectSession(id);
}
// Anything else that opens a session — a notification, the parent ↑ — shows its chat too.
watch(
  () => store.selectedSessionId,
  (id) => {
    if (id) mapOpen.value = false;
  },
);

// Two things come from here: previewCommand/apiCommand are CLOUD config that any workspace
// member may edit, so that write goes to Supabase and mirrors itself into the local row —
// a local-only edit would not survive the next sync — and the cloud project list, which is
// the authority on which projects a selected workspace holds (see `scopedIds`).
const projects = useProjects();
// The shared board's task cards. «Нова задача» files one here — a card is the only form of
// task a teammate can ever see — and «Задачі» lists the ones assigned to me.
const board = useBoard();
// The card's assignee is the person filing it, so the launcher needs to know who that is.
const auth = useAuth();

const now = useNow();

const router = useRouter();

// Board buckets mirror the sidebar (lib/buckets.ts): completed (merged or set aside) wins,
// then backlog → Задачі, error/conflict → Помилки, done/in_review/stopped → Очікують,
// everything else → Активні. Driven by store.selectedBucket.
const WAITING_STATUSES: readonly SessionStatus[] = ['done', 'in_review', 'stopped'];
const ERROR_STATUSES: readonly SessionStatus[] = ['error', 'conflict'];
// Active = an agent whose process is alive or is blocked on the operator. Shared: archiving
// refuses these (the API re-checks with core's ACTIVE_STATUSES).
const ACTIVE_STATUSES: readonly SessionStatus[] = ['queued', 'thinking', 'tool', 'waiting_input'];
// The one bucket whose ACTIONS differ (unarchive vs. the full control set) keys off the
// session's own `archived` flag, not this — a merged agent shares the «Завершені» view but
// keeps its reopen/delete controls.
const showCompleted = computed(() => store.selectedBucket === 'completed');
const showTasks = computed(() => store.selectedBucket === 'tasks');

// ── Search ────────────────────────────────────────────────────────────────
// One query over both kinds of row the column holds. It narrows what is RENDERED and nothing
// else: the rail still decides which bucket, and the header still counts that bucket whole.
const query = ref('');
const filtering = computed(() => query.value.trim() !== '');
// A query belongs to the list in front of the operator, so it dies with that list: a
// leftover «auth» after a click on another bucket or another project reads as an empty
// board, and that bucket's own empty-state text would then be a lie about what is there.
watch(
  () => [store.selectedBucket, store.selectedProjectId, store.selectedWorkspaceId],
  () => {
    query.value = '';
  },
);

// ── Scope: workspace → project → session ──────────────────────────────────
// The same three levels the board answers one step up, with the one difference that decides
// this whole file: a local session needs NO cloud to exist. So the cloud is consulted for
// exactly one question here — which projects a workspace holds — and nothing else on this
// page (the sessions, the buckets, the launcher, the log, the changes, git) reads it at all.
//
// The rule itself lives in lib/scope.ts, with its three cases and the reason each is what it
// is. It is there rather than here because it decides whether a developer's running agents
// render at all, apps/ui has no component tests, and a `.vue` file is where that decision
// cannot be covered (scope.ts:1-3). MainLayout's bucket counters ask the same function, so
// the rail and this header cannot disagree about what is in scope.
const scopedIds = computed(() =>
  sessionScopedProjectIds(
    { workspaceId: store.selectedWorkspaceId, projectId: store.selectedProjectId },
    { projects: projects.projects, listRead: projects.listRead },
    store.projectWorkspace,
  ),
);
const inScope = computed(() => new Set(scopedIds.value));

// Every row the bucket holds, before the search box narrows it. The header's count and the
// «знайдено N з M» line are both stated against this, which is what keeps the figure beside
// the bucket label agreeing with the rail's badge while a query is open.
const scopedSessions = computed(() =>
  store.sessions.filter((s) => {
    if (!inScope.value.has(s.projectId)) return false;
    if (store.selectedBucket === 'completed') return !!s.archived || s.status === 'merged';
    if (s.archived) return false;
    if (store.selectedBucket === 'tasks') return s.status === 'backlog';
    if (store.selectedBucket === 'errors') return ERROR_STATUSES.includes(s.status);
    if (store.selectedBucket === 'waiting') return WAITING_STATUSES.includes(s.status);
    return ACTIVE_STATUSES.includes(s.status);
  }),
);

// What the column orders: the rows the query kept, newest first.
//
// «Активні» orders by LAUNCH (createdAt): every running agent stamps lastActivityAt on each
// event, so ordering live rows by it made two agents working at once trade places on every
// tool call. A launch time never moves mid-run — each card keeps its slot until its run ends
// and it leaves the bucket. Every other bucket holds agents that have stopped, so recency
// there is stable and still means «the one that finished last leads».
const activeBucket = computed(() => store.selectedBucket === 'active');
const projectSessions = computed(() =>
  [...filterSessions(scopedSessions.value, query.value)].sort(
    activeBucket.value ? byNewestLaunch : byNewestSession,
  ),
);

// Board order: each discussion child immediately follows its parent (a one-level
// tree). Orphans (parent filtered out by the completed/project view) still render.
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

// One resolver for a project's label: the LOCAL row's name, which the last successful sync
// mirrored from the cloud — so it is the name the online tree shows, and it still reads with
// Supabase unreachable.
function projectName(id: string): string {
  return store.projects.find((p) => p.id === id)?.name ?? t('agents.board.unknownProject');
}

// Under a workspace scope the cards come from several projects, and KSessionCard names only
// the branch — so the project is stated once per run of cards rather than once per card: the
// column is 300px wide and a per-card label would cost more than it tells. Under a project
// scope there is one group and no label — the rail already says which project that is.
//
// Group ORDER follows the rows' own promise: a project leads on its freshest row, so «newest
// at the top» holds across the whole column and not merely inside each group. Taken from the
// group's rows rather than from the first one pushed into it, which is not equivalent: a fork
// may be newer than the parent it follows, and boardRows sweeps orphans (a child whose parent
// the bucket filtered out) to the very END.
const groupByProject = computed(() => !store.selectedProjectId);
type BoardGroup = { projectId: string; name: string; newest: number; rows: Session[] };
const boardGroups = computed<BoardGroup[]>(() => {
  const groups = new Map<string, BoardGroup>();
  for (const s of boardRows.value) {
    let group = groups.get(s.projectId);
    if (!group) {
      group = { projectId: s.projectId, name: projectName(s.projectId), newest: 0, rows: [] };
      groups.set(s.projectId, group);
    }
    group.rows.push(s);
  }
  const out = [...groups.values()];
  const newestOf = activeBucket.value ? newestLaunchAt : newestActivityAt;
  for (const g of out) g.newest = newestOf(g.rows);
  return out.sort((a, b) => b.newest - a.newest);
});

// My backlog inbox: the cards I have to work, in the same scope the session list uses, so
// one sidebar click narrows both. Unclaimed team cards live on Дошка by design.
const scopedCards = computed(() =>
  myBacklogTasks(board.tasks, auth.user?.id ?? '', scopedIds.value),
);
// myBacklogTasks filters WITHOUT sorting — listTasks hands the rows over `created_at`
// ascending — so this is where the inbox's order is decided: the card touched last leads.
const taskCards = computed(() =>
  [...filterTaskCards(scopedCards.value, query.value)].sort(byNewestTask),
);

type TaskGroup = { projectId: string; name: string; newest: number; rows: Task[] };
// Cards are all `backlog`, so there is no status to order groups by — and no need for one:
// the freshest card leads its project, the same rule the session groups follow.
const taskGroups = computed<TaskGroup[]>(() => {
  const groups = new Map<string, TaskGroup>();
  for (const c of taskCards.value) {
    let group = groups.get(c.projectId);
    if (!group) {
      group = { projectId: c.projectId, name: projectName(c.projectId), newest: 0, rows: [] };
      groups.set(c.projectId, group);
    }
    group.rows.push(c);
  }
  const out = [...groups.values()];
  for (const g of out) g.newest = newestUpdateAt(g.rows);
  return out.sort((a, b) => b.newest - a.newest);
});

// The header counts what the BUCKET holds — the same sum the rail's badge shows — and not
// what the search box left on screen: a header disagreeing with the badge is the drift
// MainLayout.bucketCounts exists to avoid. The matched figure gets its own line, beside the
// box that produced it.
const boardCount = computed(
  () =>
    scopedSessions.value.filter((s) => s.kind !== 'chat').length +
    (showTasks.value ? scopedCards.value.length : 0),
);
const matchedCount = computed(
  () => boardRows.value.length + (showTasks.value ? taskCards.value.length : 0),
);

// ── The rendered list ─────────────────────────────────────────────────────
// One flat row model for the whole column, because the list is virtualised: a windowed list
// mounts rows by INDEX, and a nest of «group label, then its cards» blocks cannot answer what
// row 37 is. `lead` marks the very first row, so the leading group label drops the padding
// that separates the later ones from the cards above them.
type BoardItem =
  | { kind: 'group'; key: string; name: string; lead: boolean }
  | { kind: 'note'; key: string }
  | { kind: 'card'; key: string; card: Task }
  | { kind: 'session'; key: string; session: Session };

const boardItems = computed<BoardItem[]>(() => {
  const items: BoardItem[] = [];
  if (showTasks.value) {
    for (const g of taskGroups.value) {
      if (groupByProject.value)
        items.push({ kind: 'group', key: `tg:${g.projectId}`, name: g.name, lead: !items.length });
      for (const c of g.rows) items.push({ kind: 'card', key: `t:${c.id}`, card: c });
    }
    if (boardRows.value.length) items.push({ kind: 'note', key: 'stranded' });
  }
  for (const g of boardGroups.value) {
    if (groupByProject.value)
      items.push({ kind: 'group', key: `sg:${g.projectId}`, name: g.name, lead: !items.length });
    for (const s of g.rows) items.push({ kind: 'session', key: `s:${s.id}`, session: s });
  }
  return items;
});

// Rows per mounted page. The board is the one list in the app with no upper bound on its
// length — every agent a machine has ever run ends up in «Завершені» — and every row is a
// KSessionCard subtree with a status dot, a relative clock and an accounting line, so the
// cost of mounting them all is paid on every tick of `now`. Twenty is a screenful and a half
// at the 300px column's card height, which is what makes a page boundary invisible.
const BOARD_PAGE = 20;
// A card with no accounting line measures ~76px and one with ~104px; the estimate only has to
// make the scrollbar plausible for rows nobody has scrolled to yet, and is replaced by the
// real height the moment a row is mounted.
const BOARD_ROW_ESTIMATE = 96;
const boardEl = ref<HTMLElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
const { window: listWindow } = useVirtualList({
  root: boardEl,
  list: listEl,
  count: () => boardItems.value.length,
  keyAt: (i) => boardItems.value[i]!.key,
  page: BOARD_PAGE,
  estimate: BOARD_ROW_ESTIMATE,
});
const visibleItems = computed(() =>
  boardItems.value.slice(listWindow.value.start, listWindow.value.end),
);

// Back to the top whenever the list itself changes meaning: a narrowed list shown from its
// middle hides its best matches above the fold, and a bucket switch that kept the old scroll
// offset would open the new list somewhere in its past.
watch([query, () => store.selectedBucket], () => {
  if (boardEl.value) boardEl.value.scrollTop = 0;
});

// Which project the launcher acts ON. Creating: the selected project. Editing a backlog task
// or spinning one out of a transcript: the SESSION's own project — a workspace scope can list
// a task from a project other than the selection, and editing it must not read another
// project's branches, ask about another project's binding, or silently move it. Set by
// openLauncher()/openTaskFromText(), so the head tag, the fork-base list and the launch gate
// all answer about one project.
const launchProjectId = ref<string | undefined>(undefined);
const launchProject = computed(() =>
  store.projects.find((p) => p.id === launchProjectId.value),
);

// The single accented context name in the launcher head: the workspace the task lands in.
// `projectWorkspace` is the orchestrator's downward map (project id → workspace id); the
// name comes from the cloud workspace list. Falls back to the project name for a local
// project that has no workspace yet, so the head is never blank.
const launchScopeName = computed(() => {
  const id = launchProjectId.value;
  const wsId = id ? store.projectWorkspace[id] : undefined;
  return (wsId ? projects.workspaceById.get(wsId)?.name : undefined) ?? launchProject.value?.name;
});

// Requirement 3 in the UI: a task can be created, edited and moved without a binding, but
// nothing that touches the repo may run. `BIND_HINT` is the same string MainLayout uses; both
// copies are the operator's next action, not an apology.
// A card lives in the cloud, and `tasks.project_id` is what tasks_insert_member checks
// membership against — so a project that never left this machine has nothing to hang one on.
// The way out is the publish hatch in the launcher, which this line points at.
// A workspace is not a place a session can be created: it holds several projects and a session
// row carries exactly one projectId. Rendered as visible text beside the disabled button, not
// as its tooltip — see the template.
// The three explanatory bubbles in the meta list. `v-tip`, not the native `title` they used to
// be: that one drew the OS rectangle after a ~1s delay, the single square bubble left in a
// rounded UI. A <dt> is neither focusable nor disabled, so the directive fires on it.
const skillsHint = computed(() => t('agents.session.skillsHint'));
// The id is the same string the worktree folder under ~/.kermanych/worktrees is named after,
// so the bubble says where to spend it rather than leaving an opaque uuid on screen.
const sessionIdHint = computed(() => t('agents.session.idHint'));
// The engine's own handle, which is what `--resume` takes — our id names the folder, not the
// conversation. A claude or codex session keeps its id in `ompSessionId` (`codex resume`
// takes the id, not the rollout file). A managed omp agent reports
// a sessionId too, but its resume goes through Kermanych, so printing it would promise a
// `--resume` that does not exist; a native omp session prints its session FILE, which
// `omp --resume` takes. Read from the session row, so a dormant agent still states it.
const engineSessionId = computed(() => {
  const s = selectedSession.value;
  if (s?.runtime === 'claude-code' || s?.runtime === 'codex') return s.ompSessionId;
  return s?.native ? s.ompSessionFile ?? s.ompSessionId : undefined;
});
const engineSessionIdHint = computed(() => {
  const s = selectedSession.value;
  if (!s?.native || s.runtime === 'claude-code') return t('agents.session.engineIdHint');
  return s.runtime === 'codex' ? t('agents.native.engineIdHintCodex') : t('agents.native.engineIdHintOmp');
});
const isBound = computed(() => !!launchProject.value?.localRepoPath);

// Row-level check: the board can show sessions of an orphan project whose row is still here
// but whose binding was never made, so per-row actions ask about the row's own project.
function isBoundFor(projectId: string): boolean {
  return !!store.projects.find((p) => p.id === projectId)?.localRepoPath;
}
const selectedSession = computed(() =>
  store.sessions.find((s) => s.id === store.selectedSessionId),
);
const selectedDecision = computed(() => (selectedSession.value ? sessionDecisionReason(t, selectedSession.value) : undefined));

// Inline rename of the open agent: double-click its name in the header. Enter and blur
// commit, Esc discards; `renaming` also gates the blur so an Enter commit does not save twice
// (the Чат page's rename works the same way). The new name shows at once and is held until the
// session row reports it (useOptimisticValue); it belongs to the session it was made on
// (`renameFor`), so switching agents mid-save never paints it onto another one.
const renaming = ref(false);
const renameDraft = ref('');
const renameInput = ref<HTMLInputElement | null>(null);
const renameFor = ref<string | null>(null);
const sessionName = useOptimisticValue<string>(
  () => (renameFor.value ? store.sessions.find((s) => s.id === renameFor.value)?.name ?? '' : ''),
  async (name) => {
    if (renameFor.value) await store.renameSession(renameFor.value, name);
  },
);
const renameOnScreen = computed(() => !!selectedSession.value && renameFor.value === selectedSession.value.id);
const shownName = computed(() =>
  renameOnScreen.value ? sessionName.value.value : selectedSession.value?.name ?? '',
);
function startRename(): void {
  if (!selectedSession.value) return;
  renameDraft.value = shownName.value;
  renaming.value = true;
  void nextTick(() => renameInput.value?.select());
}
function cancelRename(): void {
  renaming.value = false;
}
// One save at a time (useOptimisticValue ignores a set while one runs): a rename of another
// agent made while the last one is still saving waits its turn instead of being dropped, and
// `renameFor` moves only when its own save starts, so the in-flight name stays on its agent.
let renameQueue: Promise<void> = Promise.resolve();
function commitRename(): void {
  if (!renaming.value) return;
  renaming.value = false;
  const s = selectedSession.value;
  const name = renameDraft.value.trim();
  if (!s || !name || name === shownName.value) return;
  renameQueue = renameQueue.then(() => {
    renameFor.value = s.id;
    return sessionName.set(name);
  });
}
// Another agent opened mid-edit: the draft belonged to the one that was on screen.
watch(() => store.selectedSessionId, () => { renaming.value = false; });
const selectedNotNeeded = computed(() => (selectedSession.value ? sessionNotNeededReason(t, selectedSession.value) : undefined));

// The open session is READ, as it stands, for the sidebar's unread-result mark
// (stores/seen.ts). Re-marked whenever it moves while open, so a result that lands under the
// operator's eyes never lights the sidebar — but only while the window is actually visible:
// a result that arrives behind another app has not been seen, and is marked the moment the
// window comes back.
const seen = useSeen();
function markOpenSessionSeen(): void {
  const s = selectedSession.value;
  if (s && document.visibilityState === 'visible') seen.markSeen(s.id, s.lastActivityAt);
}
watch(() => [selectedSession.value?.id, selectedSession.value?.lastActivityAt], markOpenSessionSeen, { immediate: true });
onMounted(() => document.addEventListener('visibilitychange', markOpenSessionSeen));
onBeforeUnmount(() => document.removeEventListener('visibilitychange', markOpenSessionSeen));

// A session whose worktree has been retired keeps `worktree: true` but loses its
// `worktreePath` — this is every finished/merged agent now in «Завершені» or «Очікують». The
// git-backed Зміни pane has no directory to read then, so instead of firing a request that
// comes back «session has no worktree» / ENOENT and painting the pane with a red error, it
// shows a calm empty-state. Derived so the pane and the file-manager dock agree on it.
const worktreeGone = computed(
  () => !!selectedSession.value?.worktree && !selectedSession.value.worktreePath,
);

// The agent this session was forked off, when it is a branch. Read from the whole session
// list, not the board: a branch stays open while its parent sits in another bucket, and the
// way back up the tree has to work from there too — the board's elbow may be off screen.
const parentOfSelected = computed<Session | undefined>(() =>
  selectedSession.value?.parentSessionId
    ? store.sessions.find((s) => s.id === selectedSession.value?.parentSessionId)
    : undefined,
);

// The one control in the Сесія tab a missing binding disables, and the third instance of the
// dead-tooltip pattern in this file — the only one with no visible substitute anywhere, since
// the meta list above carries no binding row. Derived from BIND_HINT rather than written out,
// so the two cannot drift into saying different things about the same state.
const previewBindHint = computed(() => t('agents.hints.previewBind', { bind: t('agents.hints.bind') }));
const previewBlocked = computed(() => {
  const s = selectedSession.value;
  if (!s || s.archived) return false;
  // Matches the branch that renders the preview toggle, so the line cannot appear beside a
  // cluster that has no such button (a discussion, a review, or the archived view).
  if (s.kind === 'discussion' || s.kind === 'review') return false;
  return !isBoundFor(s.projectId);
});
// A plain load that failed leaves `transcripts[id]` unset; this ends the skeleton for it.
const transcriptFailed = ref<string | null>(null);
// `transcripts[id]` is `undefined` until the first load answers; the derived views below fold
// that into [] (nothing to count yet), and `logPhase` is what tells «not loaded» from «empty»,
// so «Журнал порожній» never stands in for a log that is still on its way.
const transcriptLoaded = computed(() => {
  const id = store.selectedSessionId;
  return !id || store.transcripts[id] !== undefined || transcriptFailed.value === id;
});
const logPhase = useLoadPhase(() => !transcriptLoaded.value);
const entries = computed<TranscriptEntry[]>(() =>
  store.selectedSessionId
    ? store.transcripts[store.selectedSessionId] ?? []
    : [],
);

// The session's cloud card. The QA checklist lives on it (the QA tab below), and so do the
// «Документація» / «Сесія» reports the api writes there after every turn and on «Завершити».
// Declared ahead of the image watcher below, which reads it eagerly.
const linkedTask = computed(() =>
  selectedSession.value?.taskId ? board.tasks.find((t) => t.id === selectedSession.value!.taskId) : undefined,
);
// The card's «Документація» / «Сесія» reports, only when they describe THIS session — a
// relaunch of the card overwrites them with the newer run's.
const cardReports = computed(() => ownReports(linkedTask.value, selectedSession.value?.id));

// The images the operator attached at task creation ride the FIRST user message into the
// transcript (supervisor.userEntry maps them to data URLs). The «Сесія» tab surfaces them
// beside the full task text so the brief is visible without scrolling the whole log; a
// session created without attachments simply has none.
const logImages = computed<string[]>(() => {
  const first = entries.value.find(
    (e): e is Extract<TranscriptEntry, { kind: 'user_text' }> => e.kind === 'user_text',
  );
  return first?.images ?? [];
});
// After an api restart the log is only the dormant notice, so the images fall back to the
// card's copies (the launcher uploads what it sends; «Дошка» uploads its own). The bucket is
// private, so they render through short-lived signed URLs — re-signed whenever the session or
// the card's paths change, and a reply that lands after a newer request is dropped. A failed
// sign shows nothing: the images are a convenience beside the text, not worth an error line.
const cardImageUrls = ref<string[]>([]);
// How many card images are being signed — that many skeleton blocks stand in for them.
const cardImagesSigning = ref(0);
let cardImagesRun = 0;
watch(
  () => [store.selectedSessionId, logImages.value.length ? '' : (linkedTask.value?.imagePaths ?? []).join('\n')] as const,
  async ([, joined]) => {
    const run = ++cardImagesRun;
    cardImageUrls.value = [];
    cardImagesSigning.value = 0;
    if (!joined) return;
    const paths = joined.split('\n');
    cardImagesSigning.value = paths.length;
    try {
      const urls = await signedTaskImageUrls(auth.client, paths);
      if (run === cardImagesRun) cardImageUrls.value = urls;
    } catch {
      // See above: nothing to show.
    } finally {
      if (run === cardImagesRun) cardImagesSigning.value = 0;
    }
  },
  { immediate: true },
);
const taskImages = computed(() => (logImages.value.length ? logImages.value : cardImageUrls.value));

// Which library skills this session took, read straight off the transcript rows the
// reducer already produced, joined with the card's record of them — the transcript is only the
// dormant notice after an api restart, and the card's list is what survives it.
const usedSkills = computed(() => unionInOrder(cardReports.value.session?.skills, skillsUsed(entries.value)));

// The session's provider-side identifier — omp's session id, or Claude Code's session UUID —
// stored on the row as `ompSessionId` once the child answers its first state poll. The «Сесія»
// tab prints it so the operator can locate this exact run in the corresponding provider later;
// clicking copies it to the clipboard rather than making the operator select a wrapped UUID.
async function copySessionId(id: string | undefined): Promise<void> {
  if (!id) return;
  try {
    await navigator.clipboard.writeText(id);
    store.notify(t('agents.session.sessionIdCopied'), 'info');
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

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
  return u ? t('agents.session.tokenTotal', { n: tokens(usageTokens(u)) }) : undefined;
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
  size: detailWidth,
  resizing,
  startResize,
  onKeydown: onResizeKeydown,
  refresh: refreshDetailWidth,
} = useResizablePanel({
  storageKey: 'kermanych.agents.board-width',
  defaultSize: 340,
  min: MIN_BOARD,
  edge: 'right',
  max: () =>
    contentEl.value ? contentEl.value.clientWidth - MIN_DETAIL : Number.POSITIVE_INFINITY,
});

// The list is «not loaded» until the socket snapshot has filled `store.sessions` and — under
// «Задачі» — until the cloud backlog read answers with nothing on screen yet. Before that an
// empty list is not an empty bucket, so it renders card skeletons rather than `emptyText`.
const boardPhase = useLoadPhase(
  () => !store.snapshotReceived || (showTasks.value && board.loading && !scopedCards.value.length),
);
// A failed backlog read is its own sentence, not «Беклог порожній».
const backlogError = computed(() => (showTasks.value && !scopedCards.value.length ? board.loadError : null));

// The empty list, per bucket. The two creatable buckets split again on scope, because
// «Нова задача» is disabled under a workspace scope and an invitation to press it would be a
// dead end there. The click that unblocks it is NOT repeated here — PICK_PROJECT_HINT is
// already on screen a few pixels above, and saying it twice reads as two different problems.
const emptyText = computed(() => {
  // A query that matched nothing is a different problem from an empty bucket, and it names
  // its own cure: change the words, not the scope.
  if (filtering.value) return t('agents.board.searchEmpty', { q: query.value.trim() });
  if (showCompleted.value) return t('agents.empty.completed');
  if (store.selectedBucket === 'waiting') return t('agents.empty.waiting');
  if (store.selectedBucket === 'errors') return t('agents.empty.errors');
  const pickFirst = !store.selectedProjectId;
  if (showTasks.value) {
    return pickFirst ? t('agents.empty.backlog') : t('agents.empty.backlogScoped');
  }
  return pickFirst
    ? t('agents.empty.none')
    : t('agents.empty.noneScoped');
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

// ── Документація tab: docs the agent used vs docs it changed ────────────────
// The session's own data, joined with its report on the card (lib/session-reports.ts) so the
// tab survives an api restart and «Завершити». `usedDocs` is the documentation the agent READ —
// off the transcript, the same way usedSkills is, plus the card's accumulated list — as shortened
// display paths, hence list-only. `changedDocs` is the documentation among the Зміни listing while
// the worktree exists, so it carries full paths and opens the same diff view; once the session is
// finished it is the card's copy, list-only (`changedDocsListOnly`), because there is no worktree
// behind a row any more. A doc read and then edited legitimately appears in both. Only real
// documentation paths qualify (isDocPath), so source files never leak in.
const usedDocs = computed(() => unionInOrder(cardReports.value.docs?.read, docsRead(entries.value)));
const changedDocsState = computed(() =>
  changedDocsView({
    finished: selectedSession.value?.status === 'merged' || worktreeGone.value,
    liveFiles: changesInfo.value?.files ?? null,
    card: cardReports.value.docs?.changed,
  }),
);
const changedDocs = computed(() => changedDocsState.value.docs);
const changedDocsListOnly = computed(() => changedDocsState.value.listOnly);
const docsUsedHint = computed(() => t('agents.docs.usedHint'));

// ── QA tab: the checklist off the linked cloud CARD ─────────────────────────
// Like «Документація»'s reports, the QA checklist lives on the task and outlives the session,
// so it is read off `linkedTask` (above) and ticked back through the same store method the
// board dialog uses.
const qaChecklist = computed(() => linkedTask.value?.qaChecklist);
const qaDone = computed(() => qaChecklist.value?.items.filter((i) => i.checked).length ?? 0);
// Not loaded: the session has a card the board has not read yet. A session without a card is
// «loaded» at once — its empty state is the true answer.
const qaNotLoaded = computed(() => !!selectedSession.value?.taskId && !linkedTask.value && board.loading);
const qaPhase = useLoadPhase(() => qaNotLoaded.value);
// «Документація» joins the transcript, the Зміни listing and the card; until the first two
// have answered its lists are incomplete, so it is a skeleton rather than «немає документів».
const docsNotLoaded = computed(
  () => !transcriptLoaded.value || (changesLoading.value && changesInfo.value === null) || qaNotLoaded.value,
);

function onQaToggle(itemId: string, checked: boolean): void {
  const task = linkedTask.value;
  if (task) void board.setQaItemChecked(task.id, itemId, checked);
}

// ── Detail tabs (Лог / Зміни / Сесія / Документація / QA / Браузер) ─────────
// The right panel splits the session into these views. The choice is persisted
// per session (localStorage `kermanych.agents.tab.<id>`) so reopening an agent lands where the
// operator left it; a fresh session defaults to the log.
const sessionBrowser = useSessionBrowser();
// Beside the Лог instead of its own tab — see «Session browser beside the Лог» below.
const browserSplit = computed(() => sessionBrowser.available && sessionBrowser.split);
const detailTabs = computed(() => {
  const tabs: { value: string; label: string; count?: number; live?: boolean; closeLabel?: string }[] = [
    { value: 'log', label: t('agents.tabs.log') },
    // Counts appear once their data has: a «0» on a tab still loading would be a false answer.
    { value: 'changes', label: t('agents.tabs.changes'), ...(changesInfo.value ? { count: changesInfo.value.files.length } : {}) },
    { value: 'session', label: t('agents.tabs.session') },
    { value: 'docs', label: t('agents.tabs.docs'), ...(docsNotLoaded.value ? {} : { count: usedDocs.value.length + changedDocs.value.length }) },
    { value: 'findings', label: t('agents.tabs.findings'), count: selectedSession.value?.openFindings ?? 0 },
  ];
  // Always present, like the other tabs — a missing tab reads as breakage. The pane shows the
  // checklist for a task-linked session and an empty state otherwise (it fills after «Створити
  // ПР»); the count is 0 until then.
  tabs.push({ value: 'qa', label: t('agents.tabs.qa'), ...(qaNotLoaded.value ? {} : { count: qaChecklist.value?.items.length ?? 0 }) });
  // The session browser exists only in the desktop app. Its dot pulses while the agent is
  // driving the page (a browser tool call in the last few seconds). Beside the Лог («Поруч із
  // логом») it has no tab of its own, and the dot moves to Лог, where the page now is. Its ✕
  // closes the page and is there only while one is open: the tab itself always stays.
  if (sessionBrowser.available) {
    const id = store.selectedSessionId;
    const live = !!id && sessionBrowser.agentLive.has(id);
    if (browserSplit.value) tabs[0]!.live = live;
    else
      tabs.push({
        value: 'browser',
        label: t('agents.tabs.browser'),
        live,
        ...(id && sessionBrowser.states[id] ? { closeLabel: t('agents.browser.close') } : {}),
      });
  }
  return tabs;
});
const detailTab = ref('log');
watch(
  () => store.selectedSessionId,
  (id) => {
    const saved = id ? localStorage.getItem(`kermanych.agents.tab.${id}`) : null;
    detailTab.value =
      saved === 'changes' || saved === 'session' || saved === 'docs' || saved === 'findings' || saved === 'qa' ||
      (saved === 'browser' && sessionBrowser.available && !browserSplit.value)
        ? saved
        : 'log';
  },
  { immediate: true },
);
watch(detailTab, (t) => {
  const id = store.selectedSessionId;
  if (id) localStorage.setItem(`kermanych.agents.tab.${id}`, t);
});
// The Браузер tab's ✕: the page closes and the tab stays where it is, showing «Відкрити знову».
function onDetailTabClose(tab: string): void {
  const id = store.selectedSessionId;
  if (tab === 'browser' && id) sessionBrowser.close(id);
}

// ── Session browser beside the Лог («Поруч із логом») ────────────────────────
// One app-wide preference, toggled from the browser's own toolbar — so the operator is looking
// at the browser when it flips, and the detail follows it: on, the Браузер tab folds into Лог;
// off, the page gets its tab back and stays on screen. The seam between log and browser works
// like the board's (drag or arrow keys), and both halves keep a usable minimum.
watch(browserSplit, (on) => {
  if (on && detailTab.value === 'browser') detailTab.value = 'log';
  else if (!on && detailTab.value === 'log' && sessionBrowser.available) detailTab.value = 'browser';
});
const MIN_SPLIT_LOG = 360;
const MIN_SPLIT_BROWSER = 320;
// The seam's own width (.agents__resizer).
const SPLIT_SEAM = 7;
const splitEl = ref<HTMLElement | null>(null);
const {
  size: splitWidth,
  resizing: splitResizing,
  startResize: startSplitResize,
  onKeydown: onSplitResizeKeydown,
  refresh: refreshSplitWidth,
} = useResizablePanel({
  storageKey: 'kermanych.agents.browser-split-width',
  defaultSize: 480,
  min: MIN_SPLIT_BROWSER,
  edge: 'left',
  // A hidden Лог pane (v-show) measures 0: no bound yet, rather than clamping the stored width
  // down to the minimum and persisting that.
  max: () =>
    splitEl.value?.clientWidth ? splitEl.value.clientWidth - MIN_SPLIT_LOG - SPLIT_SEAM : Number.POSITIVE_INFINITY,
});
// Re-clamp whenever the split becomes measurable or its container changes width: the board
// seam narrows the detail column without a window resize.
watch(
  [browserSplit, () => detailTab.value === 'log', () => !!selectedSession.value, detailWidth],
  () => {
    if (browserSplit.value) void nextTick(refreshSplitWidth);
  },
);

// ── Consolidated header: overflow menu + keyboard shortcuts ─────────────────
// The chat column carries ONE header (the embedded KPanel runs `bare`): the session's
// harness and live status, the primary session actions, and — behind ⋯ — the rest.
const harnessLabel = computed(() => {
  const s = selectedSession.value;
  const harness = s?.runtime || 'omp';
  return s?.native ? t('agents.native.label', { harness: nativeHarnessName(harness) }) : harness;
});
const runningSelected = computed(
  () => selectedSession.value?.status === 'thinking' || selectedSession.value?.status === 'tool',
);

const menuOpen = ref(false);
// ── Session actions ──────────────────────────────────────────────────────────
// Each runs through useAsyncAction — one busy guard shared by the header icon, the ⋯ item and
// the ⌘ shortcut, and a failure becomes a toast — and on success marks the session pending
// (stores/pending) until the store shows the result: the HTTP call answers before the socket
// echo changes the row, and that gap is what made a click look ignored. While a session is
// pending, every action on it is blocked (header, menu, shortcuts, KPanel `pending`).
const sessionKey = (id: string): string => `session:${id}`;
const findSession = (id: string): Session | undefined => store.sessions.find((x) => x.id === id);
const goneFrom = (id: string) => (): boolean => !findSession(id);
// A child of `id` the store did not hold before the fork/review — the result being waited on.
function childAppeared(id: string): () => boolean {
  const before = new Set(store.sessions.map((x) => x.id));
  return () => store.sessions.some((x) => x.parentSessionId === id && !before.has(x.id));
}
const RUNNING_STATUSES: readonly SessionStatus[] = ['queued', 'thinking', 'tool'];
// A fork or a delete can run for longer than the echo window; while the call itself is still
// out, the session stays pending at least this long.
const CALL_PENDING_MS = 5 * 60_000;
// The card turns pending at the click, not at the HTTP answer — a fork or delete can take
// seconds before the server even replies. Once the call returns, the usual echo window
// (PENDING_TIMEOUT_MS) starts over; a failed call drops the mark at once (the toast says why).
async function pendingWhile<T>(id: string, settled: () => boolean, call: () => Promise<T>): Promise<T> {
  const key = sessionKey(id);
  pending.mark(key, settled, CALL_PENDING_MS);
  try {
    const res = await call();
    pending.mark(key, settled);
    return res;
  } catch (e) {
    pending.clear(key);
    throw e;
  }
}

const branchAction = useAsyncAction(async (s: Session) => {
  const child = await pendingWhile(s.id, childAppeared(s.id), () => store.branchSession(s.id));
  if (child?.id) store.selectSession(child.id);
});
const reviewAction = useAsyncAction(async (s: Session) => {
  const review = await pendingWhile(s.id, childAppeared(s.id), () => store.reviewSession(s.id));
  if (review?.id) store.selectSession(review.id);
});
const stopAction = useAsyncAction(async (s: Session) => {
  await pendingWhile(
    s.id,
    () => {
      const x = findSession(s.id);
      return !x || (!RUNNING_STATUSES.includes(x.status) && !(x.native && x.terminalId));
    },
    () => store.stopSession(s.id),
  );
});
// Keyed: ✕ on one stranded card must not block (or spin) the others.
const deleteAction = useKeyedAction(async (id: string) => {
  await pendingWhile(id, goneFrom(id), () => store.deleteSession(id));
  if (store.selectedSessionId === id) store.selectSession(undefined);
});
// Reopen a merged session: the server re-forks its worktree/branch from the base (seconds);
// jump to Активні and select it so the operator can continue and finish again.
const reopenAction = useAsyncAction(async (s: Session) => {
  const session = await pendingWhile(s.id, () => findSession(s.id)?.status !== 'merged', () => store.reopenSession(s.id));
  store.setBucket('active');
  if (session?.id) store.selectSession(session.id);
  store.notify(t('agents.notify.reopened', { name: s.name }));
});
const archiveAction = useAsyncAction(async (s: Session) => {
  await pendingWhile(
    s.id,
    () => { const x = findSession(s.id); return !x || x.archived === true; },
    () => store.archiveSession(s.id),
  );
  if (store.selectedSessionId === s.id) store.selectSession(undefined);
});
const unarchiveAction = useAsyncAction(async (s: Session) => {
  await pendingWhile(s.id, () => !findSession(s.id)?.archived, () => store.unarchiveSession(s.id));
});
// A native session whose harness is not running: start it again (resume) in a new pty.
const resumeNativeAction = useAsyncAction(async (s: Session) => {
  await pendingWhile(
    s.id,
    () => { const x = findSession(s.id); return !x || !!x.terminalId; },
    () => store.resumeSession(s.id),
  );
});
const editorAction = useAsyncAction((s: Session) => store.openEditor(s.id));
// The stall banner's «Перезапустити»: settled once the agent emits again or stops running.
const restartAction = useAsyncAction(async (s: Session) => {
  const lastEventAt = s.lastEventAt;
  await pendingWhile(
    s.id,
    () => {
      const x = findSession(s.id);
      return !x || x.lastEventAt !== lastEventAt || !RUNNING_STATUSES.includes(x.status);
    },
    () => store.restartSession(s.id),
  );
});
// A decision card stays «answering» until the session drops that request, not just until the
// POST answers — the card would otherwise come back clickable for a beat. Its own pending key
// (`answer:<id>`), not `session:<id>`: the rest of the session's actions stay usable meanwhile,
// and the 15 s cap frees the card if the session never reports the request gone.
const answerKey = (id: string): string => `answer:${id}`;
const answerAction = useAsyncAction(async (s: Session, res: RpcExtensionUIResponse) => {
  await store.answerUi(s.id, res);
  pending.mark(answerKey(s.id), () => findSession(s.id)?.pendingUiRequest?.id !== res.id);
});
const answering = computed(
  () => answerAction.busy.value || (!!selectedSession.value && pending.isPending(answerKey(selectedSession.value.id))),
);
const summaryAction = useAsyncAction((s: Session) => store.sendMessage(s.id, t('agents.prompt.summary'), nextMode(s)));
const previewStopAction = useAsyncAction((s: Session) => store.stopPreview(s.id));

// Any session action in flight (the actions are page-wide, like the one header they serve).
const actionInFlight = computed(
  () =>
    branchAction.busy.value ||
    reviewAction.busy.value ||
    stopAction.busy.value ||
    deleteAction.anyBusy() ||
    reopenAction.busy.value ||
    archiveAction.busy.value ||
    unarchiveAction.busy.value ||
    resumeNativeAction.busy.value ||
    restartAction.busy.value ||
    previewStopAction.busy.value,
);
function isSessionPending(id: string): boolean {
  return pending.isPending(sessionKey(id));
}
// Blocks every action on `s`: its own pending result, or another action still talking.
function sessionBlocked(s: Session): boolean {
  return isSessionPending(s.id) || actionInFlight.value;
}
const selectedPending = computed(() => !!selectedSession.value && isSessionPending(selectedSession.value.id));
const selectedBlocked = computed(() => !!selectedSession.value && sessionBlocked(selectedSession.value));
const menuEl = ref<HTMLElement | null>(null);
// Any pointerdown outside the ⋯ cluster dismisses the menu; captured so a click on another
// control closes the menu before that control's own handler runs.
function onMenuOutside(e: PointerEvent): void {
  if (menuEl.value && !menuEl.value.contains(e.target as Node)) menuOpen.value = false;
}
watch(menuOpen, (open) => {
  if (open) document.addEventListener('pointerdown', onMenuOutside, true);
  else document.removeEventListener('pointerdown', onMenuOutside, true);
});
// A session switch (deselect included) drops an open menu — it belonged to the old session.
watch(() => store.selectedSessionId, () => { menuOpen.value = false; });

function menuReview(): void { const s = selectedSession.value; menuOpen.value = false; if (s) void onReview(s); }
function menuBranch(): void { menuOpen.value = false; void onBranch(); }
function menuEditor(): void { menuOpen.value = false; void onEditor(); }
function menuStop(): void { menuOpen.value = false; void onStop(); }
function menuDelete(): void { const s = selectedSession.value; menuOpen.value = false; if (s) void onDeleteAgent(s); }
function menuDiscard(): void { const s = selectedSession.value; menuOpen.value = false; if (s) void onDiscardRow(s); }

// The menu's shortcuts, live whenever a session is open: ⌘ (or Ctrl) + key. Never while the
// operator is typing, and each is guarded by the same condition that renders its menu item —
// so a shortcut can't fire an action the header doesn't currently offer — and by the same
// pending/busy check that disables the items, so a held ⌘⌫ cannot delete twice. Never while
// the agent map covers the chat either: ⌘⌫ must not delete a session that is not on screen.
function onDetailShortcut(e: KeyboardEvent): void {
  const s = selectedSession.value;
  if (!s || mapOpen.value) return;
  if (e.key === 'Escape') {
    if (menuOpen.value) { menuOpen.value = false; e.preventDefault(); }
    return;
  }
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
  const branchKind = s.kind === 'discussion' || s.kind === 'review';
  const blocked = sessionBlocked(s);
  switch (e.key.toLowerCase()) {
    case 'd':
      if (!branchKind && !s.archived && !s.native && canReview(s)) {
        e.preventDefault();
        menuOpen.value = false;
        if (!blocked) void onReview(s);
      }
      break;
    case 'e':
      if (!s.archived) {
        e.preventDefault();
        menuOpen.value = false;
        if (!isSessionPending(s.id)) void onEditor();
      }
      break;
    case '.':
      if (runningSelected.value || (s.native && s.terminalId)) {
        e.preventDefault();
        menuOpen.value = false;
        if (!blocked) void onStop();
      }
      break;
    case 'backspace':
      e.preventDefault();
      menuOpen.value = false;
      if (blocked) break;
      if (branchKind) void onDiscardRow(s);
      else void onDeleteAgent(s);
      break;
  }
}
onMounted(() => window.addEventListener('keydown', onDetailShortcut));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onDetailShortcut);
  document.removeEventListener('pointerdown', onMenuOutside, true);
});

// ── Зміни tab (finishInfo: ahead/dirty/conflicts + changed files) ──────────
// Loaded when the tab opens for a session, then refreshed while the agent works: the
// listing covers uncommitted work, so it goes stale on every edit the agent makes. A
// non-worktree session or a git error surfaces as a message rather than throwing.
const changesInfo = ref<Awaited<ReturnType<typeof store.finishInfo>> | null>(null);
const changesError = ref<string | null>(null);
const changesLoading = ref(false);
const docsPhase = useLoadPhase(() => docsNotLoaded.value);
// Orders overlapping loads: a reply that lands after a newer request is discarded.
let changesRun = 0;

// One file's diff, opened by clicking its row above. The request is ordered the same way
// the listing is: a reply that lands after a newer click, a session switch or a collapse
// is dropped. `reset` separates opening a file (spinner) from re-reading the one already
// open, where blanking first would flash the pane on every refresh below.
const openFile = ref<string | null>(null);
const fileDiff = ref<FileDiff | null>(null);
const fileDiffError = ref<string | null>(null);
const fileDiffLoading = ref(false);
let fileDiffRun = 0;

async function loadFileDiff(id: string, path: string, reset: boolean): Promise<void> {
  const run = ++fileDiffRun;
  if (reset) {
    fileDiff.value = null;
    fileDiffError.value = null;
    fileDiffLoading.value = true;
  }
  try {
    const d = await store.fileDiff(id, path);
    if (run !== fileDiffRun) return;
    fileDiff.value = d;
    fileDiffError.value = null;
  } catch (e) {
    if (run !== fileDiffRun) return;
    fileDiffError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (run === fileDiffRun) fileDiffLoading.value = false;
  }
}

// The diff open in «Зміни» / «Документація» (and whether it is full screen) survives a reload
// and a restart, per agent, like the open tab. Written when a file opens or goes full screen,
// cleared when the operator closes it; switching agents keeps each agent's own.
const openFileMaximized = ref(false);
const openFileKey = (id: string) => `kermanych.agents.openFile.${id}`;
function rememberOpenFile(): void {
  const id = store.selectedSessionId;
  if (!id) return;
  try {
    if (openFile.value) localStorage.setItem(openFileKey(id), JSON.stringify({ path: openFile.value, maximized: openFileMaximized.value }));
    else localStorage.removeItem(openFileKey(id));
  } catch {
    /* storage unavailable: the diff is just not restored */
  }
}
function savedOpenFile(id: string): { path: string; maximized: boolean } | null {
  try {
    const v = JSON.parse(localStorage.getItem(openFileKey(id)) ?? 'null') as { path?: unknown; maximized?: unknown } | null;
    return v && typeof v.path === 'string' ? { path: v.path, maximized: v.maximized === true } : null;
  } catch {
    return null;
  }
}
function onFileMaximized(on: boolean): void {
  openFileMaximized.value = on;
  rememberOpenFile();
}
// Once the agent's changed files are listed: reopen the file from last time, if it is still
// among them.
function restoreOpenFile(id: string): void {
  if (store.selectedSessionId !== id || openFile.value) return;
  const saved = savedOpenFile(id);
  if (!saved || !changesInfo.value?.files.some((f) => f.path === saved.path)) return;
  openFileMaximized.value = saved.maximized;
  openFile.value = saved.path;
  void loadFileDiff(id, saved.path, true);
}

// Bumping the run counter is what makes a collapse final: an in-flight reply for the file
// just closed would otherwise land in the pane the operator dismissed. `forget` for a close
// the operator asked for — the file is not reopened next time.
function closeFile(forget = false): void {
  openFile.value = null;
  openFileMaximized.value = false;
  fileDiffLoading.value = false;
  fileDiffRun++;
  if (forget) rememberOpenFile();
}

// Raw bytes for the diff's preview mode (Markdown/HTML/PDF), read from the session's worktree.
function loadSessionRaw(path: string): Promise<Blob> {
  const id = store.selectedSessionId;
  if (!id) return Promise.reject(new Error('no session selected'));
  return store.sessionRaw(id, path);
}

function toggleFile(path: string): void {
  const id = store.selectedSessionId;
  if (!id || openFile.value === path) {
    closeFile(true);
    return;
  }
  openFileMaximized.value = false;
  openFile.value = path;
  rememberOpenFile();
  void loadFileDiff(id, path, true);
}

// `reset` separates opening the tab (blank + spinner) from refreshing it in place,
// where clearing first would flash the pane empty on every agent event.
async function loadChanges(id: string, reset: boolean): Promise<void> {
  const run = ++changesRun;
  if (reset) {
    changesInfo.value = null;
    changesError.value = null;
    changesLoading.value = true;
  }
  try {
    const info = await store.finishInfo(id);
    if (run !== changesRun) return;
    changesInfo.value = info;
    changesError.value = null;
    // The open file tracks the same refresh as the listing: the agent is still editing it.
    // It can also drop out of the listing entirely (an edit reverted), and then there is no
    // diff left to show.
    if (openFile.value && !info.files.some((f) => f.path === openFile.value)) closeFile();
    else if (openFile.value) void loadFileDiff(id, openFile.value, false);
  } catch (e) {
    if (run !== changesRun) return;
    changesError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (run === changesRun) changesLoading.value = false;
  }
}

watch(
  () => store.selectedSessionId,
  (id) => {
    // A new session invalidates whatever file was open in the changes pane.
    closeFile();
    changesInfo.value = null;
    // Load up front — not on tab-open — so the «Зміни» tab count is truthful the moment the
    // session opens, and switching to the pane is then instant. A retired worktree has
    // nothing to read; the pane renders `worktreeGone` instead.
    if (!id || worktreeGone.value) return;
    void loadChanges(id, true).then(() => restoreOpenFile(id));
  },
  { immediate: true },
);

// A working agent bumps lastActivityAt once per tool call; coalesce a burst of those
// into one trailing git read so the open tab tracks the worktree without hammering
// the api.
const CHANGES_REFRESH_MS = 2500;
let changesTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => selectedSession.value?.lastActivityAt,
  () => {
    if (changesTimer || worktreeGone.value || !selectedSession.value?.worktree) return;
    changesTimer = setTimeout(() => {
      changesTimer = undefined;
      const id = store.selectedSessionId;
      if (id) void loadChanges(id, false);
    }, CHANGES_REFRESH_MS);
  },
);
onBeforeUnmount(() => clearTimeout(changesTimer));

// ── Merged PR (docs/specs/2026-10-26-pr-merged-close-prompt.md) ─────────────
// Selecting a session that opened a PR asks GitHub (through the api) whether it is merged.
// Only a resting agent with its worktree still there is checked: an active agent is still
// working, a merged one is already retired. The answer lives here until the next selection;
// nothing is persisted.
function prCheckEligible(s: Session): boolean {
  return (
    s.kind === 'agent' &&
    !!s.prOpened &&
    s.status !== 'merged' &&
    !s.archived &&
    !ACTIVE_STATUSES.includes(s.status) &&
    !(s.worktree && !s.worktreePath)
  );
}

// Keyed by session id so a result never shows against another session's row.
const prCheckResult = ref<{ id: string; check: PrCheck } | null>(null);
const prChecking = ref(false);
// The popup: which session, its PR and its branch (captured, so the text survives the
// session row turning `merged` while the request settles).
const prMerged = ref<{ id: string; branch: string; check: PrCheck } | null>(null);
const closeMergedError = ref<string | null>(null);
// Orders overlapping checks: a reply for a previously selected session is dropped.
let prCheckRun = 0;

async function runPrCheck(s: Session): Promise<void> {
  const run = ++prCheckRun;
  prChecking.value = true;
  let check: PrCheck;
  try {
    check = await store.prCheck(s.id);
  } catch {
    // The api maps every GitHub failure to a state; a throw is the local api itself.
    check = { state: 'error' };
  }
  if (run !== prCheckRun) return;
  prChecking.value = false;
  prCheckResult.value = { id: s.id, check };
  // A failed check never prompts; manual «Завершити» stays available.
  if (check.state === 'merged') {
    closeMergedError.value = null;
    prMerged.value = { id: s.id, branch: s.branch, check };
  }
}

// Keyed on the resolved session's id rather than `selectedSessionId` alone: a selection that
// lands before the session list does still gets its check once the row arrives, while a
// `session_update` on the same session never re-asks.
watch(
  () => selectedSession.value?.id,
  () => {
    // Invalidate any check in flight and whatever the previous session showed.
    prCheckRun++;
    prChecking.value = false;
    prCheckResult.value = null;
    prMerged.value = null;
    const s = selectedSession.value;
    if (s && prCheckEligible(s)) void runPrCheck(s);
  },
  { immediate: true },
);

const closeMergedAction = useAsyncAction(
  async (id: string) => {
    closeMergedError.value = null;
    await store.closeMerged(id);
    // The row turns `merged` through the normal session_update; nothing new is selected.
    prMerged.value = null;
  },
  { onError: (e) => { closeMergedError.value = errorText(e); } },
);

// `#<number>` for a GitHub PR; a stored non-GitHub URL still ends in its number
// (GitLab `/merge_requests/12`, Bitbucket `/pull-requests/7`).
function prLabel(url: string, number?: number): string {
  const n = number ?? url.match(/\/(\d+)\/?$/)?.[1];
  return n != null ? `#${n}` : 'PR';
}

const PR_STATE_KEYS: Record<PrCheckState, string> = {
  open: 'agents.pr.state.open',
  merged: 'agents.pr.state.merged',
  closed: 'agents.pr.state.closed',
  not_found: 'agents.pr.state.notFound',
  unsupported: 'agents.pr.state.unsupported',
  no_access: 'agents.pr.state.noAccess',
  rate_limited: 'agents.pr.state.rateLimited',
  offline: 'agents.pr.state.offline',
  error: 'agents.pr.state.error',
};

const selectedPrCheck = computed(() =>
  prCheckResult.value && prCheckResult.value.id === selectedSession.value?.id ? prCheckResult.value.check : undefined,
);
const prLink = computed(() => {
  const url = selectedPrCheck.value?.url ?? selectedSession.value?.prUrl;
  return url ? { url, label: prLabel(url, selectedPrCheck.value?.number) } : undefined;
});
const prStateWord = computed(() => {
  if (selectedPrCheck.value) return t(PR_STATE_KEYS[selectedPrCheck.value.state]);
  return prChecking.value ? t('agents.pr.state.checking') : undefined;
});

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

// The whole sub-line a session card shows — on the board and on the agent map alike.
function cardLine(s: Session): string {
  return slotWaitLabel(s, t) ?? (activityOf(s) || statusWord(s));
}

function statusWord(s: Session): string {
  switch (s.status) {
    case 'thinking':
      return t('agents.statusWord.thinking');
    case 'tool':
      return t('agents.statusWord.tool');
    case 'waiting_input':
      return t('agents.statusWord.waiting');
    case 'done':
      return t('agents.statusWord.done');
    case 'in_review':
      return t('agents.statusWord.review');
    case 'error':
      return needsSignIn(s.errorCode) ? t('agents.statusWord.signIn') : t('agents.statusWord.error');
    case 'queued':
      return slotWaitLabel(s, t) ?? t('agents.statusWord.queued');
    case 'stopped':
      return t('agents.statusWord.stopped');
    case 'merged':
      return t('agents.statusWord.merged');
    case 'conflict':
      return t('agents.statusWord.conflict');
    case 'backlog':
      return t('agents.statusWord.backlog');
    default:
      return s.status;
  }
}

// Bring the transcript back the first time a session is opened — resuming it when that is
// what it takes. A plain load cannot rehydrate: after an app restart the api has no child for
// the session, and once the idle reaper has stopped one but kept its Live, GET /transcript
// answers an EMPTY list that reads as «Журнал порожній» with nothing explaining why. Only a
// resume replays the harness's own persisted history. `historyLoadFor` holds which sessions
// must not be woken by a mere click (native, merged, backlog) and which are already live;
// `resumeSession` reloads the transcript itself, so no separate load follows it.
// Rehydration in flight for this session — the composer's ↻ spins (and stays down, so a second
// click cannot spawn a second respawn) both for the wake below and for ↻ itself. Declared here
// because the immediate watcher below reads it.
const refreshingId = ref<string | null>(null);
function loadTranscriptOf(id: string): void {
  transcriptFailed.value = null;
  void store.loadTranscript(id).catch((e: unknown) => {
    store.notify(errorText(e), 'error');
    // Ends the skeleton: the pane falls back to its empty state rather than loading forever.
    if (store.transcripts[id] === undefined) transcriptFailed.value = id;
  });
}
watch(
  () => store.selectedSessionId,
  (id) => {
    // A failure recorded on an earlier visit must not end this visit's skeleton: the session
    // is being loaded (or woken) again, so «Журнал порожній» waits for that answer.
    transcriptFailed.value = null;
    if (!id || store.transcripts[id] !== undefined) return;
    const s = store.sessions.find((x) => x.id === id);
    if (s && historyLoadFor(s) === 'resume') {
      refreshingId.value = id;
      void store
        .resumeSession(id)
        .catch((e: unknown) => {
          // A wake that fails (a worktree that will not come up, a signed-out CLI) must still
          // leave the operator with the pane they opened, so fall back to the dormant notice
          // the plain load serves rather than an empty log and a silent failure.
          store.notify(errorText(e), 'error');
          loadTranscriptOf(id);
        })
        .finally(() => {
          if (refreshingId.value === id) refreshingId.value = null;
        });
      return;
    }
    loadTranscriptOf(id);
  },
  { immediate: true },
);

// ── New-agent launcher ────────────────────────────────────────────────────
const launcherOpen = ref(false);
const draftName = ref('');
const draftTask = ref('');
const draftModel = ref('');
// Reasoning effort for the launch, the other half of `model`. '' is «за замовчуванням» —
// the card stores nothing and omp picks. A card being edited keeps its own.
const draftEffort = ref<ThinkingLevel | ''>('');
// The segmented pickers offer core's vocabularies verbatim — the same constants openLauncher
// validates a card's free-text launch params against, so a prefix added to core cannot show
// up as accepted-but-unpickable here.
const prefixOptions = BRANCH_PREFIXES;
const draftPrefix = ref<BranchPrefix>('feature');
const platformOptions = PLATFORMS;
const modelPickOptions = computed(() => modelOptions(store.models));
// The effort ladder narrows to the chosen model's own (empty for a non-reasoning model);
// «за замовчуванням» or an unknown alias keeps the full ladder. Labels stay ours (lib/effort).
const effortPickOptions = computed(() => {
  const allowed = effortOptions(store.models, draftModel.value || undefined);
  return EFFORT_OPTIONS.filter((o) => allowed.includes(o.value)).map((o) => ({ value: o.value, label: t(o.labelKey) }));
});
const draftPlatform = ref<Platform | undefined>(undefined);
const draftWorktree = ref(true);
// «Приховати з дошки». Off by default: a card is team work unless its author says
// otherwise, and a default-hidden launcher would quietly empty the board.
const draftHidden = ref(false);
// «Глибокий аналіз»: the card's agent interviews, documents and only then codes. Seeded from
// the «Нова задача» menu (a new card) or from the card being edited.
const draftDeep = ref(false);
// «Дозволити автовиконання» — excludes «Глибокий аналіз»: checking either clears the other.
const draftAutoRun = ref(false);
function onDraftModes(flip: (m: CardModes, on: boolean) => CardModes, on: boolean): void {
  const next = flip({ deepAnalysis: draftDeep.value, autoRun: draftAutoRun.value }, on);
  draftDeep.value = next.deepAnalysis;
  draftAutoRun.value = next.autoRun;
}
const nameEdited = ref(false);
const draftBaseBranch = ref('');
// «Режим»: a launch choice, not a card field — «В беклог» and board launches stay managed.
// Each launcher opens on the mode last picked here (remembered per device).
const draftMode = ref<LaunchMode>(readLaunchMode());
function pickLaunchMode(mode: LaunchMode): void {
  draftMode.value = mode;
  writeLaunchMode(mode);
}
const launchNative = computed(() => draftMode.value !== 'managed');
const launchBranches = ref<string[]>([]);
const editingTaskId = ref<string | null>(null);
// The card `editingTaskId` points at, resolved from the store rather than snapshotted, so a
// realtime edit to the card being edited is not lost behind the modal.
const editingTask = computed<Task | undefined>(() =>
  editingTaskId.value ? board.tasks.find((t) => t.id === editingTaskId.value) : undefined,
);
// A colleague's card (one assigned to me from «Задачі») cannot be switched to auto-run by me.
const draftAutoRunLocked = computed(() => autoRunSwitchLocked(draftAutoRun.value, editingTask.value, auth.user?.id ?? ''));
// The switch as the launcher opened, so a save sends `autoRun` only when this form changed it.
let openedAutoRun = false;
// The slug is generated from the task by a model at launch (docs/specs/2026-10-26-branch-name-from-task.md),
// so the launcher can only show the prefix it lands under.
const branchPreview = computed(() => branchName('…', draftPrefix.value));
// Right-column summary line under the branch box.
const branchHint = computed(() =>
  draftWorktree.value
    ? t('agents.launcher.branchHintWorktree', { base: draftBaseBranch.value || launchProject.value?.defaultBranch || 'HEAD' })
    : t('agents.launcher.branchHintInplace'),
);
const taskInput = ref<HTMLTextAreaElement | null>(null);
const nameField = ref<HTMLInputElement | null>(null);
const launcherError = ref<string | null>(null);
// Busy affordance for the launcher's submit buttons. `api.createSessionFromTask` takes a
// couple of seconds (git worktree + omp spawn), and «В беклог»/«Зберегти» hit the cloud too;
// without this the operator presses «Запустити» and sees nothing move. The value names WHICH
// button is in flight so only that one spins, and it doubles as the re-entrancy guard.
const launchBusy = ref<'task' | 'launch' | null>(null);
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
  () => !!launchProjectId.value && draftName.value.trim() !== '' && draftTask.value.trim() !== '',
);

// A NEW deep-analysis card says so in the title too: the checkbox alone is easy to miss in a
// form the operator opened through a different menu item than they think.
const launcherTitle = computed(() => {
  if (editingTaskId.value) return t('agents.launcher.editTitle');
  return draftDeep.value ? t('agents.launcher.deepTitle') : t('agents.board.newTask');
});

// The «Нова задача» split button's menu: the ways a task can start, each with a caption that
// says how it differs. Picking «Нова задача» there is the main half's own click.
type NewTaskMode = 'task' | 'deepAnalysis';
const newTaskModes = computed<{ value: NewTaskMode; label: string; caption: string; icon: KIconName }[]>(() => [
  { value: 'task', label: t('agents.board.newTaskModes.task'), caption: t('agents.board.newTaskModes.taskCaption'), icon: 'plus' },
  {
    value: 'deepAnalysis',
    label: t('agents.board.newTaskModes.deepAnalysis'),
    caption: t('agents.board.newTaskModes.deepAnalysisCaption'),
    icon: 'analysis',
  },
]);
function onNewTaskMode(mode: NewTaskMode): void {
  openLauncher(undefined, mode === 'deepAnalysis');
}

// Footer status: the binding first (it blocks launching outright), then the form nudge,
// then silence once launchable.
const footHint = computed(() => {
  if (!isBound.value) return t('agents.hints.bind');
  return canLaunch.value ? '' : t('agents.launcher.footDescribe');
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
// A reopened launcher (another project, another card) starts a newer run; the older reply is
// dropped so it cannot fill the picker with the wrong repo's branches.
const launchBranchesLoading = ref(false);
let launchBranchesRun = 0;
async function loadLaunchBranches(preferred: string | undefined): Promise<void> {
  const run = ++launchBranchesRun;
  const projectId = launchProjectId.value;
  launchBranches.value = [];
  draftBaseBranch.value = preferred ?? launchProject.value?.defaultBranch ?? '';
  launchBranchesLoading.value = false;
  if (!projectId || !isBound.value) return;
  launchBranchesLoading.value = true;
  try {
    const info = await store.listBranches(projectId);
    if (run !== launchBranchesRun) return;
    launchBranches.value = info.branches;
    if (!draftBaseBranch.value) draftBaseBranch.value = info.default ?? info.current ?? '';
  } catch {
    // Non-fatal: the picker degrades to the preferred/default value only.
  } finally {
    if (run === launchBranchesRun) launchBranchesLoading.value = false;
  }
}

// `deepAnalysis` seeds «Глибокий аналіз» for a NEW card; a card being edited keeps its own.
function openLauncher(card?: Task, deepAnalysis = false): void {
  // Before loadLaunchBranches(), which reads it. A card being edited stays in its own
  // project; a new one lands in the selected project, and the «Нова задача» button is
  // disabled unless there is one.
  launchProjectId.value = card?.projectId ?? store.selectedProjectId;
  editingTaskId.value = card?.id ?? null;
  draftName.value = card?.title ?? '';
  draftTask.value = card?.description ?? '';
  // A NEW card inherits the project's «за замовчуванням» model (Запуск задач settings); a card
  // being EDITED keeps its own. `launchProjectId` is set just above, and the LOCAL row carries
  // the synced default so this works offline like the rest of the launch path.
  const launchDefault = card ? undefined : store.projects.find((p) => p.id === launchProjectId.value);
  draftModel.value = card?.model ?? launchDefault?.defaultModel ?? '';
  draftEffort.value = card?.effort ?? launchDefault?.defaultEffort ?? '';
  // The cloud stores launch params as free text; the local vocabularies are the authority,
  // exactly as createSessionFromTask validates them server-side.
  draftPrefix.value = (BRANCH_PREFIXES as readonly string[]).includes(card?.prefix ?? '')
    ? (card!.prefix as BranchPrefix)
    : 'feature';
  draftPlatform.value = (PLATFORMS as readonly string[]).includes(card?.platform ?? '')
    ? (card!.platform as Platform)
    : undefined;
  draftWorktree.value = card?.worktree ?? true;
  draftHidden.value = card?.hidden ?? false;
  const modes = cardModesFromCard(card, deepAnalysis);
  draftDeep.value = modes.deepAnalysis;
  draftAutoRun.value = modes.autoRun;
  openedAutoRun = modes.autoRun;
  // `tasks.branch` IS the base branch (the board labels it «Базова гілка»).
  void loadLaunchBranches(card?.branch);
  nameEdited.value = !!card;
  launcherError.value = null;
  clearLaunchImages();
  draftMode.value = readLaunchMode();
  launcherOpen.value = true;
  void nextTick(() => taskInput.value?.focus());
}

// Turn a transcript text selection into a new backlog task: prefill the launcher
// with the selection as the task body and a name suggested from its first line,
// defaulting to "save to backlog" so a finding is parked rather than run now.
function openTaskFromText(text: string): void {
  // The finding belongs to the project the transcript came from, which under a workspace
  // scope is not necessarily the selected one.
  launchProjectId.value = selectedSession.value?.projectId ?? store.selectedProjectId;
  editingTaskId.value = null;
  draftName.value = taskNameFromText(text);
  draftTask.value = text;
  // New task from a selection: same project default model as openLauncher's new-task branch.
  const textDefault = store.projects.find((p) => p.id === launchProjectId.value);
  draftModel.value = textDefault?.defaultModel ?? '';
  draftEffort.value = textDefault?.defaultEffort ?? '';
  draftPrefix.value = 'feature';
  draftPlatform.value = undefined;
  draftWorktree.value = true;
  draftHidden.value = false;
  draftDeep.value = false;
  draftAutoRun.value = false;
  void loadLaunchBranches(undefined);
  nameEdited.value = true;
  launcherError.value = null;
  clearLaunchImages();
  draftMode.value = readLaunchMode();
  launcherOpen.value = true;
  void nextTick(() => nameField.value?.focus());
}

// Both buttons write a CLOUD card; «Запустити» then launches it on this machine. Creating
// the card FIRST is what makes the task visible to the team with an assignee, and it also
// means a failed launch loses nothing: the card is saved, assigned to me, and can be retried
// from here or from the board. (It also means from-task's claim rollback never fires on this
// path — the card is already mine, so `claimed` stays false there.)
async function submitLauncher(asTask: boolean): Promise<void> {
  if (launchBusy.value) return;
  const projectId = launchProjectId.value;
  const userId = auth.user?.id;
  if (!projectId || !canLaunch.value) return;
  if (!userId) {
    launcherError.value = t('agents.launcher.loginFirst');
    return;
  }
  // A card may be filed for an unbound project — it is a saved plan. Launching may not, and
  // the api would refuse it with `project not bound` anyway.
  if (!asTask && !isBound.value) {
    launcherError.value = t('agents.hints.bind');
    return;
  }
  // A card needs a project the cloud can check membership against; the publish hatch below
  // is the way out of a local-only project.
  if (projects.listRead && !projects.byId.has(projectId)) {
    launcherError.value = t('agents.hints.publishFirst');
    return;
  }
  const draft = {
    name: draftName.value.trim(),
    task: draftTask.value.trim(),
    model: draftModel.value.trim() || undefined,
    effort: draftEffort.value || undefined,
    prefix: draftPrefix.value,
    platform: draftPlatform.value,
    worktree: draftWorktree.value,
    hidden: draftHidden.value,
    deepAnalysis: draftDeep.value,
    autoRun: draftAutoRun.value,
    baseBranch: draftBaseBranch.value || undefined,
  };
  const images = launchImages.value.map((i) => ({ data: i.data, mimeType: i.mimeType }));
  launcherError.value = null;
  launchBusy.value = asTask ? 'task' : 'launch';
  try {
    let cardId: string;
    if (editingTaskId.value) {
      if (!(await board.updateTaskFields(editingTaskId.value, taskPatchFromDraft(draft, openedAutoRun)))) return;
      cardId = editingTaskId.value;
    } else {
      const created = await board.createTask(taskInsertFromDraft(draft, projectId, userId));
      if (!created) return; // the store has already said why
      cardId = created.id;
      // The card exists now, so a retry after a failed launch must PATCH it, not mint a
      // second one: the modal stays open on that path by design (see below). From here the
      // launcher is in edit mode for this card — its footer offers «Видалити», which is
      // honest, and a retry carries any edit made in between into the same card.
      editingTaskId.value = created.id;
    }
    if (asTask) {
      launcherOpen.value = false;
      clearLaunchImages();
      store.setBucket('tasks');
      return;
    }
    // The launch can still fail (omp down, project unbound, network), and its error belongs
    // in the launcher the operator is looking at — so the modal closes only after from-task
    // resolves. The card is already saved either way.
    const native = nativeRuntimeFor(draftMode.value);
    // Rebuilt before the await and before clearLaunchImages(): these are exactly the images the
    // agent receives (`images` above), and the strip is emptied below.
    const cardFiles = native ? [] : launchImages.value.map(imageToFile);
    const session = await api.createSessionFromTask(cardId, native ? undefined : images, native);
    // The same images go on the card too, so «Сесія» still shows them once the log is only the
    // dormant notice, and teammates can see them. Only after the session exists — uploading
    // earlier would put a retry of a failed launch through a second upload — and best-effort:
    // the agent already has them, so a storage failure is the store's toast, never a failed
    // launch. A native launch sends none, so it uploads none.
    if (cardFiles.length) void board.addTaskImages(cardId, cardFiles);
    launcherOpen.value = false;
    clearLaunchImages();
    store.setBucket('active');
    store.selectSession(session.id);
  } catch (e) {
    // Keep the launcher open so the name and body are not lost. The card, if it was created,
    // is already safe on the board.
    launcherError.value = e instanceof Error ? e.message : String(e);
  } finally {
    launchBusy.value = null;
  }
}

// ── Publish-and-file: the way out of a local-only project ─────────────────
// `listRead` guards the same false positive BoardPage's `unpublished` guards: until the cloud
// project list is an ANSWER, every project looks local-only.
const needsPublish = computed(
  () => !!launchProjectId.value && projects.listRead && !projects.byId.has(launchProjectId.value),
);
const publishInto = ref('');
const publishing = ref(false);
// The launcher is locked (persistent, fields inert, every footer button down) while a submit
// or a publish is writing the card.
const launcherLocked = computed(() => launchBusy.value !== null || publishing.value);
const workspaceOptions = computed(() =>
  projects.workspaces.map((w) => ({ value: w.id, label: w.name })),
);

// A publish is permanent, so it is asked for explicitly rather than guessed from the
// current scope. It reuses the LOCAL project id, so bindings, sessions and worktrees
// survive (stores/projects.ts publish()).
async function publishAndFile(): Promise<void> {
  const row = store.projects.find((p) => p.id === launchProjectId.value);
  if (!row || !publishInto.value || publishing.value) return;
  publishing.value = true;
  launcherError.value = null;
  try {
    await projects.publish(row, publishInto.value);
    await submitLauncher(true);
  } catch (e) {
    launcherError.value = e instanceof Error ? e.message : String(e);
  } finally {
    publishing.value = false;
  }
}

// Deleting a card is a cloud row and nothing else — it owns no branch, no worktree and no
// omp child — so one confirm is the whole guard; tasks_guard refuses an active card anyway.
// Keyed per card: the pressed card spins, the others stay usable. `board.deleteTask` reports
// its own failure (toast) and answers false.
const cardDelete = useKeyedAction(async (id: string) => {
  if (!(await board.deleteTask(id))) return;
  // The editor is this card's only detail view; it must not outlive the row it edits.
  if (editingTaskId.value === id) launcherOpen.value = false;
});
async function onDeleteCard(card: Task): Promise<void> {
  if (cardDelete.busyFor(card.id)) return;
  const ok = await confirmAction({
    title: t('confirmations.deleteCard'),
    message: t('agents.notify.deleteCard', { title: card.title }),
    confirmLabel: t('confirmations.label.delete'),
  });
  if (ok) void cardDelete.run(card.id);
}

// A stranded pre-cutover row: local SQLite and nothing else, so this stays a plain delete.
async function onDeleteStranded(s: Session): Promise<void> {
  if (isSessionPending(s.id) || deleteAction.busyFor(s.id)) return;
  const ok = await confirmAction({
    title: t('confirmations.deleteStranded'),
    message: t('agents.notify.deleteStranded', { name: s.name }),
    confirmLabel: t('confirmations.label.delete'),
  });
  if (ok) void deleteAction.run(s.id);
}

// ── One-time publication of pre-cutover local backlog rows ────────────────
// Spec §Migrating existing local backlog rows: before this change «В беклог» filed a LOCAL
// SQLite session and nothing else, so every machine holds a few tasks the team has never
// seen. The pass runs when the cloud project list is an ANSWER — `listRead` guards the same
// false positive `needsPublish` does, and before that every project looks local-only and
// every row would look stranded.
//
// cloudCreateTask is called DIRECTLY rather than through board.createTask, because that
// wrapper reports failures with a toast and the duplicate-key collision below is an
// expected, silent outcome — not something to greet the user with. The direct function
// wants `createdBy` spelled out.
let publishedPass = false;

async function publishLegacyBacklog(): Promise<void> {
  const userId = auth.user?.id;
  if (publishedPass || !userId || !projects.listRead || projects.offlineError) return;
  publishedPass = true;
  const plan = planBacklogPublication(
    store.sessions,
    new Set(projects.projects.map((p) => p.id)),
    userId,
  );
  // A plan with neither half is not «nothing to do» — it is «the local session list has not
  // arrived yet», because the snapshot ServerEvent is what fills store.sessions and it has
  // no read flag to guard on. Latching here would strand every leftover row for the rest of
  // the run, so the pass un-arms itself and waits for the sessions count to move it again.
  if (!plan.publish.length && !plan.stranded.length) {
    publishedPass = false;
    return;
  }
  for (const { sessionId, insert } of plan.publish) {
    try {
      await cloudCreateTask(auth.client, { ...insert, createdBy: userId });
    } catch (e) {
      // A primary-key collision means an earlier pass already published this row — the card
      // id IS the local session id — so the local row is safe to drop. Anything else is a
      // real failure: leave the row alone and let a later pass retry rather than deleting
      // work nobody else can see yet.
      const message = e instanceof Error ? e.message : String(e);
      if (!/duplicate key|already exists/i.test(message)) {
        publishedPass = false;
        continue;
      }
    }
    // The card is safe now, so the local row is redundant — but this is the local API and it
    // can fail on its own (Electron restarting). Nobody awaits this pass, so a throw here
    // would surface as an unhandled rejection and skip the rows behind it; re-arm instead and
    // let a later run hit the collision branch above.
    try {
      await store.deleteSession(sessionId);
    } catch {
      publishedPass = false;
    }
  }
}

// `plan.stranded` needs no state: a row that cannot move stays a local backlog session, and
// «Задачі» already renders exactly those. The note above that list explains them.
//
// The session COUNT is in the source on purpose, and is not redundant with the three cloud
// values next to it: the local snapshot can land after the cloud list has been read, and
// without it a pass that saw an empty session list would never be retried.
watch(
  () => [auth.user?.id, projects.listRead, projects.offlineError, store.sessions.length] as const,
  () => void publishLegacyBacklog(),
  { immediate: true },
);

function onRowClick(s: Session): void {
  // A stranded backlog row has no chat to open and no cloud card to edit — the note above
  // the list says what to do with it (publish its project).
  if (s.kind === 'task') return;
  // The list always means «go to this agent», even to the one already selected under the map.
  mapOpen.value = false;
  store.selectSession(s.id);
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

// The composer clears on send and the store shows the «надсилаю…» bubble at once; the panel
// ref is how a refused message gets its text and images back.
const panelRef = ref<InstanceType<typeof KPanel> | null>(null);
async function onSend(text: string, images: ImageInput[]): Promise<void> {
  const s = selectedSession.value;
  if (!s) return;
  try {
    await store.sendMessage(s.id, text, nextMode(s), images);
  } catch (e) {
    // A failed send (e.g. the agent's omp child died and could not be respawned) must be
    // visible, not swallowed — otherwise the chat looks silently stuck — and must not cost
    // the operator what they wrote: it goes back into the composer, if still on this session.
    store.notify(errorText(e), 'error');
    if (store.selectedSessionId === s.id) panelRef.value?.restoreDraft(text, images);
  }
}

// Браузер → «Надіслати агенту»: the picks tray as ONE message, through the same send the Лог
// composer uses. A managed session gets the crops as images; a native one their file paths in
// the text (it takes text only — lib/browser-picks.ts). A refusal (`native_busy`, a dead child)
// keeps the tray so nothing the operator wrote is lost.
const sendingPicks = ref(false);
async function onSendPicks(s: Session): Promise<void> {
  const picks = sessionBrowser.picks[s.id];
  if (!picks?.length || sendingPicks.value) return;
  const native = !!s.native;
  sendingPicks.value = true;
  try {
    await store.sendMessage(
      s.id,
      composePicksMessage(picks, { native, comment: sessionBrowser.notes[s.id] }),
      nextMode(s),
      picksImages(picks, { native }),
    );
    sessionBrowser.clearPicks(s.id);
    // Beside the Лог the operator already sees where the message went.
    if (store.selectedSessionId === s.id && !browserSplit.value) detailTab.value = 'log';
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    sendingPicks.value = false;
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
    store.notify(errorText(e), 'error');
  } finally {
    refreshingId.value = null;
  }
}

// Composer ≡ — ask the agent itself to recap, rather than stitching a digest out of the
// transcript locally: it has the whole session in context and can say where the work stands.
// A canned operator message, the same shape as the server-side resolve/PR prompts; the store
// shows it as a «надсилаю…» bubble, and `summaryAction` keeps ≡ down until the POST answers.
async function onSummary(): Promise<void> {
  const s = selectedSession.value;
  if (s) await summaryAction.run(s);
}

async function onBranch(): Promise<void> {
  const s = selectedSession.value;
  if (s && !sessionBlocked(s)) await branchAction.run(s);
}

async function onReview(s: Session): Promise<void> {
  if (!sessionBlocked(s)) await reviewAction.run(s);
}

async function onStop(): Promise<void> {
  const s = selectedSession.value;
  if (s && !sessionBlocked(s)) await stopAction.run(s);
}

async function onRestart(): Promise<void> {
  const s = selectedSession.value;
  if (s && !sessionBlocked(s)) await restartAction.run(s);
}

// The composer's effort chip and model picker, save-on-change: the chip shows the pick (and a
// spinner) at once and holds it until the session row reports it. omp refuses a level or a
// model its provider cannot run, and the api reports that refusal rather than writing the row
// — so a failure rolls the chip back with a toast. The pick belongs to the session it was made
// on (`optimisticFor`): both the source and the overrides follow THAT session, so switching
// sessions mid-save neither paints it onto another one nor compares it with another's row.
const optimisticFor = ref<string | null>(null);
let pickedProvider: string | undefined;
const effortPick = useOptimisticValue<ThinkingLevel | undefined>(
  () => (optimisticFor.value ? findSession(optimisticFor.value)?.effort : undefined),
  async (level) => {
    if (optimisticFor.value && level) await store.setEffort(optimisticFor.value, level);
  },
);
const modelPick = useOptimisticValue<string | undefined>(
  () => (optimisticFor.value ? findSession(optimisticFor.value)?.model : undefined),
  async (model) => {
    if (!optimisticFor.value || !model) return;
    await store.setSessionModel(optimisticFor.value, pickedProvider ? { model, provider: pickedProvider } : { model });
  },
);
const pickOnScreen = computed(() => !!selectedSession.value && optimisticFor.value === selectedSession.value.id);
// One pick at a time: while either save runs, `optimisticFor` must keep naming the session it
// writes to, so a pick made meanwhile (here or on another session) is refused before it can
// re-point it. The saving chip itself is disabled by its `loading`.
const pickSaving = computed(() => effortPick.pending.value || modelPick.pending.value);
async function onEffort(level: ThinkingLevel): Promise<void> {
  const s = selectedSession.value;
  if (!s || pickSaving.value) return;
  optimisticFor.value = s.id;
  await effortPick.set(level);
}
async function onSetModel(patch: { model: string; provider?: string }): Promise<void> {
  const s = selectedSession.value;
  if (!s || pickSaving.value) return;
  optimisticFor.value = s.id;
  pickedProvider = patch.provider;
  await modelPick.set(patch.model);
}

async function onReopen(s: Session): Promise<void> {
  if (!sessionBlocked(s)) await reopenAction.run(s);
}

async function onResumeNative(s: Session): Promise<void> {
  if (!sessionBlocked(s)) await resumeNativeAction.run(s);
}

// «Запустити зараз»: one session past the slot limit.
const runNowAction = useAsyncAction((s: Session) => store.runSessionNow(s.id));
async function onRunNow(s: Session): Promise<void> {
  await runNowAction.run(s);
}

// Physical delete (archive teardown + removal): stops the omp process, removes the
// worktree/branch and the registry row, cascading to child branches. Works on any
// status, unlike archive which refuses active agents.
async function onDeleteAgent(s: Session): Promise<void> {
  if (sessionBlocked(s)) return;
  const ok = await confirmAction({
    title: t('confirmations.deleteAgent'),
    // Says what goes with it (apps/api deleteSession): the worktree and the branch, or — for an
    // agent working in the project folder — the branch, with the project back on its base.
    message: !s.branch
      ? t('agents.notify.deleteAgent', { name: s.name })
      : s.worktree
        ? t('agents.notify.deleteAgentWorktree', { name: s.name, branch: s.branch })
        : t('agents.notify.deleteAgentBranch', { name: s.name, branch: s.branch }),
    confirmLabel: t('confirmations.label.delete'),
  });
  if (ok) await deleteAction.run(s.id);
}

async function onAnswer(res: RpcExtensionUIResponse): Promise<void> {
  const s = selectedSession.value;
  if (s && !answering.value) await answerAction.run(s, res);
}

// Independent review can be requested on a settled (non-active, non-merged) agent that
// owns a branch to audit. The API re-checks (refuses a mid-turn or non-agent session).
function canReview(s: Session): boolean {
  return s.kind === 'agent' && !!s.branch && s.status !== 'merged' && !ACTIVE_STATUSES.includes(s.status);
}

// ── Archive / unarchive ────────────────────────────────────────────────────
// Active agents can't be archived: pre-check and toast (the API also enforces).
async function onArchive(s: Session): Promise<void> {
  if (ACTIVE_STATUSES.includes(s.status)) {
    store.notify(t('agents.notify.cannotArchive'), 'error');
    return;
  }
  if (!sessionBlocked(s)) await archiveAction.run(s);
}

async function onUnarchive(s: Session): Promise<void> {
  if (!sessionBlocked(s)) await unarchiveAction.run(s);
}

// ── Finish (retire the worktree; the branch stays for its PR) ──────────────
const finishOpen = ref(false);
const finishFor = ref<Session | null>(null);
const finishData = ref<Awaited<ReturnType<typeof store.finishInfo>> | null>(null);
const finishError = ref<string | null>(null);
const finishBusy = ref(false);
const prBusy = ref(false);
const resolveBusy = ref(false);
// Documentation policy (project setting): the gate's failures, as the api reported them.
const docsBusy = ref(false);
const docsFailures = computed<DocsGateFailure[]>(() => finishData.value?.docsGate.failures ?? []);
const DOCS_FAILURE_KEYS: Record<DocsGateFailure, string> = {
  'task-spec': 'agents.finish.docsFailure.taskSpec',
  plan: 'agents.finish.docsFailure.plan',
  'docs-impact': 'agents.finish.docsFailure.docsImpact',
  handoff: 'agents.finish.docsFailure.handoff',
  'api-request': 'agents.finish.docsFailure.apiRequest',
};

// Files still to resolve in the worktree: a tree left mid-merge (the agent folded the base
// in) cannot be retired, so the modal shows them instead of the finish summary.
const finishFiles = computed(() => finishData.value?.conflicts ?? []);

// A session whose branch already has an open PR: its secondary finish action is «Закоміти»
// (land follow-up work onto that PR), never «Створити ПР» (which would try to open a second
// one and find nothing to push). Keyed off the DURABLE `prOpened`, not the transient
// `in_review` status — the operator keeps prompting the agent after «Створити ПР», which
// drives the card back through thinking/tool and would otherwise flip the button back.
const finishHasPr = computed(() => finishFor.value?.prOpened === true || finishFor.value?.status === 'in_review');

async function openFinish(s: Session): Promise<void> {
  finishFor.value = s;
  finishData.value = null;
  finishError.value = null;
  finishBusy.value = false;
  docsBusy.value = false;
  finishOpen.value = true;
  try {
    finishData.value = await store.finishInfo(s.id);
  } catch (e) {
    finishError.value = e instanceof Error ? e.message : String(e);
  }
}

// ⧉ / ⌘E. A failure (no editor configured, a worktree gone) is a toast, not a silent no-op.
async function onEditor(): Promise<void> {
  const s = selectedSession.value;
  if (s && !isSessionPending(s.id)) await editorAction.run(s);
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

async function onDiscardRow(s: Session): Promise<void> {
  if (sessionBlocked(s)) return;
  const ok = await confirmAction({
    title: t('confirmations.discard'),
    message: t('agents.notify.discard', { kind: s.kind === 'review' ? t('agents.notify.kindReview') : t('agents.notify.kindBranch'), name: s.name }),
    confirmLabel: t('confirmations.label.discard'),
  });
  if (ok) await deleteAction.run(s.id);
}

async function resolveAuto(): Promise<void> {
  const s = finishFor.value;
  if (!s) return;
  resolveBusy.value = true;
  finishError.value = null;
  try {
    await store.resolveConflict(s.id);
    finishOpen.value = false; // agent resolves in the background — watch it on the card
    store.selectSession(s.id);
  } catch (e) {
    finishError.value = e instanceof Error ? e.message : String(e);
  } finally {
    resolveBusy.value = false;
  }
}

async function submitFinish(): Promise<void> {
  const s = finishFor.value;
  if (!s) return;
  finishBusy.value = true;
  finishError.value = null;
  try {
    await store.finishSession(s.id);
    finishOpen.value = false;
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
    store.notify(t('agents.notify.prCreating', { name: s.name }), 'info');
  } catch (e) {
    finishError.value = e instanceof Error ? e.message : String(e);
  } finally {
    prBusy.value = false;
  }
}

async function submitCommit(): Promise<void> {
  const s = finishFor.value;
  if (!s) return;
  prBusy.value = true;
  finishError.value = null;
  try {
    await store.commitChanges(s.id);
    finishOpen.value = false; // agent commits + pushes to the open PR in the background — watch it in chat
    store.selectSession(s.id);
    store.notify(t('agents.notify.committing', { name: s.name }), 'info');
  } catch (e) {
    finishError.value = e instanceof Error ? e.message : String(e);
  } finally {
    prBusy.value = false;
  }
}

// «Доповнити документацію»: the api sends the agent one prompt listing exactly the missing
// documents (with the project's task-spec / frontend-handoff skills inlined), so the sheet
// closes and the work is watched in the transcript, like «Створити ПР». `sent: false` means the
// gate passed in the meantime — nothing was asked of the agent.
async function submitDocs(): Promise<void> {
  const s = finishFor.value;
  if (!s) return;
  docsBusy.value = true;
  finishError.value = null;
  try {
    const res = await store.completeDocs(s.id);
    finishOpen.value = false;
    store.selectSession(s.id);
    store.notify(t(res.sent ? 'agents.notify.docsCompleting' : 'agents.notify.docsComplete', { name: s.name }), 'info');
  } catch (e) {
    finishError.value = e instanceof Error ? e.message : String(e);
  } finally {
    docsBusy.value = false;
  }
}

// ── Mid-task documents (Документація tab) ─────────────────────────────────
// «Написати запит на API» / «Написати хендоф»: one Kermanych prompt for that document, sent
// whatever the project's rules say.
const DOCS_WRITE_KINDS: readonly DocsWriteKind[] = ['apiRequest', 'handoff'];
const docWriting = ref<DocsWriteKind | null>(null);

async function writeDoc(kind: DocsWriteKind): Promise<void> {
  const s = selectedSession.value;
  if (!s || docWriting.value) return;
  docWriting.value = kind;
  try {
    await store.writeDoc(s.id, kind);
    store.notify(t(`agents.notify.docWriting.${kind}`, { name: s.name }), 'info');
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    docWriting.value = null;
  }
}

// «Задача з документа»: an API request (or a handoff) becomes a card on another project of the
// same workspace, so the other side's agent starts from it while this session keeps working.
// The text is read from the worktree, so an uncommitted document can go too.
const docTaskOpen = ref(false);
const docTaskSession = ref<Session | null>(null);
const docTaskPath = ref('');
const docTaskProject = ref('');
const docTaskTitle = ref('');
const docTaskAssignee = ref('');
const docTaskDescription = ref('');
const docTaskError = ref<string | null>(null);
const docTaskBusy = ref(false);
// The document text and the workspace's members are read after the dialog opens; until they
// answer the title/description are skeletons and the assignee picker spins.
const docTaskReading = ref(false);
const docTaskMembersLoading = ref(false);
const docTaskReadPhase = useLoadPhase(() => docTaskReading.value);
const docTaskWorkspace = computed(() => projects.byId.get(docTaskSession.value?.projectId ?? '')?.workspaceId);
const docTaskProjectOptions = computed<KSelectOption[]>(() =>
  projects.projects
    .filter((p) => p.workspaceId === docTaskWorkspace.value && p.id !== docTaskSession.value?.projectId)
    .map((p) => ({ value: p.id, label: p.name })),
);
const docTaskAssigneeOptions = computed<KSelectOption[]>(() =>
  (projects.members[docTaskWorkspace.value ?? ''] ?? []).map((m) => ({ value: m.userId, label: handleOf(m) })),
);

async function openDocTask(path: string): Promise<void> {
  const s = selectedSession.value;
  const home = projects.byId.get(s?.projectId ?? '');
  if (!s || !home) {
    store.notify(t('agents.docTask.notCloud'), 'error');
    return;
  }
  docTaskSession.value = s;
  docTaskPath.value = path;
  docTaskProject.value = docTaskProjectOptions.value[0]?.value ?? '';
  docTaskTitle.value = '';
  docTaskAssignee.value = '';
  docTaskDescription.value = '';
  docTaskError.value = null;
  docTaskBusy.value = false;
  docTaskOpen.value = true;
  if (!projects.members[home.workspaceId]) {
    docTaskMembersLoading.value = true;
    void projects
      .loadMembers(home.workspaceId)
      .catch(() => undefined)
      .finally(() => { docTaskMembersLoading.value = false; });
  }
  docTaskReading.value = true;
  try {
    const file = await api.sessionFile(s.id, path);
    // The operator may have closed this dialog and opened it on another document meanwhile.
    if (docTaskSession.value?.id !== s.id || docTaskPath.value !== path) return;
    if (file.binary || file.truncated) {
      docTaskError.value = t('agents.docTask.unreadable');
      return;
    }
    // The document's first heading, else its file name without the date prefix.
    docTaskTitle.value =
      /^#\s+(.+)$/m.exec(file.content)?.[1]?.trim() ||
      (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
    docTaskDescription.value = `${t('agents.docTask.origin', { project: home.name, branch: s.branch, path })}\n\n${file.content.trim()}\n`;
  } catch (e) {
    if (docTaskPath.value === path) docTaskError.value = errorText(e);
  } finally {
    if (docTaskSession.value?.id === s.id && docTaskPath.value === path) docTaskReading.value = false;
  }
}

async function copyDocTask(): Promise<void> {
  try {
    await navigator.clipboard.writeText(docTaskDescription.value);
    store.notify(t('agents.docTask.copied'), 'info');
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

// A card like the board's own «Нова задача»: the target project's default model and effort,
// unassigned unless picked. An API request is backend work by definition.
async function submitDocTask(): Promise<void> {
  const target = projects.byId.get(docTaskProject.value);
  const title = docTaskTitle.value.trim();
  if (!target || !title || docTaskBusy.value) return;
  docTaskBusy.value = true;
  docTaskError.value = null;
  try {
    const card = await board.createTask({
      projectId: target.id,
      title,
      description: docTaskDescription.value,
      prefix: 'feature',
      worktree: true,
      ...(docsLayoutKind(docTaskPath.value) === 'api-request' ? { platform: 'backend' } : {}),
      ...(target.defaultModel ? { model: target.defaultModel } : {}),
      ...(target.defaultEffort ? { effort: target.defaultEffort } : {}),
      ...(docTaskAssignee.value ? { assigneeId: docTaskAssignee.value } : {}),
    });
    if (!card) return; // the store has already said why
    docTaskOpen.value = false;
    store.notify(t('agents.docTask.created', { title, project: target.name }), 'info');
  } finally {
    docTaskBusy.value = false;
  }
}

// ── Live preview (per-session worktree app on a free port) ─────────────────
const loadingHtml = computed(
  () => `<p style="font:14px system-ui;padding:24px;color:#888">${t('agents.preview.loadingText')}</p>`,
);
// A fresh worktree carries no dependencies and no build output (`dist` is gitignored), so
// each command installs first and then runs the package script — which builds that
// package's workspace deps itself (see apps/*/package.json). Naming the deps here instead
// is what broke this: the old api command built @kermanych/core only, and the api also
// imports @kermanych/cloud, so `nest build` died with TS2307 before the preview ever
// listened. The web command must stand on its own too — a project may configure no api
// command at all, and the UI needs @kermanych/cloud built to load.
const DEFAULT_WEB_CMD = 'cd kermanych && pnpm install && pnpm --filter @kermanych/ui dev';
const DEFAULT_API_CMD =
  'cd kermanych && pnpm install && pnpm --filter @kermanych/api build && pnpm --filter @kermanych/api start';
const previewCfgOpen = ref(false);
const previewCfgSession = ref<Session | null>(null);
const draftWebCmd = ref('');
const draftApiCmd = ref('');
// The config modal's save error, rendered inside it (the modal stays open on failure).
const previewCfgError = ref<string | null>(null);

// A preview start is long (install + build in a fresh worktree), so its progress lives on the
// session, not in a modal: ▶ spins from the click until `store.previews[id]` is set (the store
// sets it inside `startPreview`), the run guard refuses a second start meanwhile, and in the
// desktop app the browser pane shows «Піднімаю превʼю гілки…» in its place (`starting`).
const previewStartingId = ref<string | null>(null);
const previewStart = useAsyncAction(async (win: Window | null, s: Session) => {
  previewStartingId.value = s.id;
  try {
    await launchInto(win, s);
  } finally {
    previewStartingId.value = null;
  }
});
function previewStarting(id: string): boolean {
  return previewStart.busy.value && previewStartingId.value === id;
}

async function launchInto(win: Window | null, s: Session): Promise<void> {
  // Desktop app: the preview goes to the session's own browser, so that is where the operator
  // should be looking while it starts. Beside the Лог the browser is on screen already.
  if (window.kermanych?.browser && store.selectedSessionId === s.id) {
    detailTab.value = browserSplit.value ? 'log' : 'browser';
  }
  try {
    const res = await store.startPreview(s.id);
    if (res.needsCommand) {
      win?.close();
      openPreviewConfig(s);
      return;
    }
    // Desktop app: the preview opens in the session's own browser (no placeholder window was
    // opened — `win` is null). In a browser the placeholder tab (opened inside the click,
    // before any await, so no popup blocker bites) is pointed at the preview.
    if (!res.url) win?.close();
    else if (window.kermanych?.browser) void sessionBrowser.navigate(s.id, s.projectId, res.url);
    else if (win) win.location.href = res.url;
    else window.open(res.url, '_blank');
  } catch (e) {
    win?.close();
    window.alert(t('agents.preview.launchFailed', { error: errorText(e) }));
    openPreviewConfig(s, true); // reopen prefilled with working defaults so the user can fix it
  }
}

async function togglePreview(s: Session): Promise<void> {
  if (sessionBlocked(s) || previewStart.busy.value) return;
  if (store.previews[s.id]) {
    // The stop call keeps this same bar on screen: the ◼ spins while it runs.
    await previewStopAction.run(s);
    return;
  }
  const p = store.projects.find((x) => x.id === s.projectId);
  if (!p?.previewCommand) {
    openPreviewConfig(s);
    return;
  }
  const win = previewPlaceholder();
  await previewStart.run(win, s);
}

// The browser build's «loading…» tab for a preview, opened synchronously inside the click so
// the popup blocker lets it through. None in the desktop app (`null`): the preview goes to the
// session browser there, and its pane shows the same «Піднімаю превʼю гілки…» while the start
// runs (`previewStarting` → KBrowserPane `starting`).
function previewPlaceholder(): Window | null {
  if (window.kermanych?.browser) return null;
  const win = window.open('', '_blank');
  win?.document.write(loadingHtml.value);
  return win;
}

function openPreviewConfig(s: Session, forceDefaults = false): void {
  previewCfgSession.value = s;
  const p = store.projects.find((x) => x.id === s.projectId);
  draftWebCmd.value = (forceDefaults ? '' : p?.previewCommand ?? '') || DEFAULT_WEB_CMD;
  draftApiCmd.value = (forceDefaults ? '' : p?.apiCommand ?? '') || DEFAULT_API_CMD;
  previewCfgError.value = null;
  previewCfgOpen.value = true;
}

// The save is short, so the modal stays open (persistent) with «Запустити» spinning, shows a
// failure inside itself and closes only once the commands are saved; the start that follows
// is long and reports on the session (`previewStart`).
const previewCfgSave = useAsyncAction(
  async (projectId: string, patch: { previewCommand: string; apiCommand?: string }) => {
    await projects.patch(projectId, patch);
    return true;
  },
  { onError: (e) => { previewCfgError.value = t('agents.preview.saveFailed', { error: errorText(e) }); } },
);

async function submitPreviewConfig(): Promise<void> {
  const s = previewCfgSession.value;
  if (!s || previewCfgSave.busy.value) return;
  // previewCommand/apiCommand are CLOUD config, so the write needs a cloud row — and per
  // the approved role matrix ANY workspace member may make it: `projects_update_member`
  // (20260827100000_workspaces.sql:338) replaced the owner-only policy this gate used to
  // cite. Membership needs no separate check, because the cloud list is RLS-scoped: a
  // project with a row in `projects.byId` is one whose workspace this user belongs to.
  // Same predicate as the settings modal's `isInCloud` (MainLayout.vue:1419).
  //
  // The pre-check itself stays. RLS is the real gate, but a refused UPDATE matches zero
  // rows and postgrest reports it as "Cannot coerce the result to a single JSON object" —
  // unreadable. Refuse here in Ukrainian instead, inside the modal so the entered commands
  // are not lost. The two false states are not the same sentence, for the same reason
  // MainLayout's `noCloudRowHint` splits them: a claim about where a project lives must
  // never outrun what we actually checked.
  if (!projects.byId.has(s.projectId)) {
    previewCfgError.value = projects.listRead
      ? t('agents.preview.notBoundLocal')
      : t('agents.preview.notBoundOffline');
    return;
  }
  previewCfgError.value = null;
  const patch: { previewCommand: string; apiCommand?: string } = {
    previewCommand: draftWebCmd.value.trim(),
  };
  const apiCmd = draftApiCmd.value.trim();
  if (apiCmd) patch.apiCommand = apiCmd;
  // Opened inside the click, before the await, for the popup blocker (see previewPlaceholder).
  const win = previewPlaceholder();
  if (!(await previewCfgSave.run(s.projectId, patch))) {
    win?.close();
    return;
  }
  previewCfgOpen.value = false;
  await previewStart.run(win, s);
}
</script>

<style scoped lang="scss">
// The Агенти screen fills exactly the work area between the header and the footer — less
// the terminal panel when it is open (MainLayout .shell__main).
.agents {
  height: 100%;
  overflow: hidden;
  padding: var(--k-sp-3);
}

// ── Blank / nothing-in-scope state ────────────────────────────────────────
.agents__blank {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 10px;
  padding: 0 40px;
}

.agents__blank-eyebrow {
  font-size: 11px;
  letter-spacing: 0.2em;
  color: var(--k-muted);
}

.agents__blank-text {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: 15px;
  color: var(--k-muted);
}

// ── Board + detail split ──────────────────────────────────────────────────
.agents__content {
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
.agents__content--resizing,
.agents__content--resizing * {
  cursor: col-resize !important;
  user-select: none;
}

// The draggable seam between the board and the chat section. It stands in for
// the detail column's old static left border: a faint line by default, accent
// on hover / focus / active drag.
.agents__resizer {
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

.agents__resizer::before {
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

.agents__resizer:hover::before,
.agents__resizer:focus-visible::before,
.agents__content--resizing .agents__resizer::before {
  background: var(--k-accent);
}

.agents__resizer:focus-visible {
  outline: none;
}

.agents__board {
  flex: none;
  min-width: 0;
  overflow-y: auto;
  padding: var(--k-sp-4);
}

.agents__board-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-3);
  margin-bottom: 20px;
}

.agents__board-controls {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
}

// The search box, pinned to the top of the scrolling column so a query typed over a long
// board stays reachable while the cards move under it. The cards pass BEHIND the bar — hence
// the opaque fill (the same --k-bg the board sits on) and the rule beneath it, which is what
// tells a scrolled card from the box.
//
// The offsets are the column's own padding, twice over, and neither is decoration. A sticky
// element is constrained to its scroller's CONTENT box, so `top: 0` parks the bar 16px below
// the scrollport edge and cards ride visibly through the band above it — measured in
// Chromium at exactly --k-sp-4. The negative side margins are the same story sideways: the
// bar has to reach the padding edges, or a card shows through the strips either side of it.
.agents__search {
  position: sticky;
  top: calc(-1 * var(--k-sp-4));
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--k-sp-2);
  margin: 0 calc(-1 * var(--k-sp-4)) var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-4);
  background: var(--k-bg);
  border-bottom: var(--k-rule-thin) solid var(--k-line);
}

.agents__search-field {
  flex: 1 1 auto;
  min-width: 0;
}

// Wraps under the field in a narrow column rather than squeezing it: the board can be
// dragged down to 300px, where the two side by side leave no room to read either.
.agents__search-count {
  flex: none;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.agents__hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--k-muted);
}

.agents__empty {
  padding: 24px 2px;
  font-size: 13px;
  color: var(--k-muted);
}

// «Карта агентів» — fills the board header beside «Нова задача»: the name on the left, the
// machine-wide active count on the right, pressed (accent frame) while the map is open. In a
// narrow board the name gives way (ellipsis) before the count or the split button do.
.agents__map-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-2);
  flex: 1 1 auto;
  min-width: 0;
  padding: var(--k-sp-2) var(--k-sp-3);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r);
  background: var(--k-surface);
  color: var(--k-text);
  font-size: var(--k-fs-sm);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;

  &:hover {
    border-color: var(--k-line-strong);
    background: var(--k-surface2);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

.agents__map-btn--on {
  border-color: var(--k-accent);
  background: var(--k-surface2);
}

.agents__map-btn-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agents__map-btn-count {
  flex: none;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

// The scope notice — why «Нова задача» cannot act. Muted like every other hint on this
// screen, because it reports a fact the operator may act on rather than a warning. The rule
// and the spacing live on the container so the cards below read as a separate list rather
// than as a continuation of the prose.
.agents__notes {
  margin: 0 0 var(--k-sp-3);
  padding-bottom: var(--k-sp-3);
  border-bottom: var(--k-rule-thin) solid var(--k-line);
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-1);
}

.agents__note {
  margin: 0;
  font-size: var(--k-fs-xs);
  line-height: 1.5;
  color: var(--k-muted);
}

// Standalone, unlike the scope notices: it introduces the card list right below it and gets
// no spacing from .agents__notes, so it carries its own.
.agents__note--stranded {
  margin-bottom: var(--k-sp-2);
}

// Which project a run of cards belongs to; rendered only under a workspace scope. The
// padding goes on TOP so the label sits closer to the cards it introduces than to the ones
// above it — .agents__cards is a flex column with a uniform gap, which on its own would
// leave the label floating equidistant between two groups.
.agents__group-label {
  padding-top: var(--k-sp-2);
  font-size: var(--k-fs-xs);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--k-faint);
}

// The list's very first row — a `:first-child` rule cannot say this any more: each row sits
// in its own wrapper, where every label is a first child, and the leading one is a matter of
// the row model (BoardItem.lead) rather than of the DOM.
.agents__group-label--lead {
  padding-top: 0;
}

// ── Detail column ─────────────────────────────────────────────────────────
// No top padding, unlike the board next to it: the first thing in this column is a title
// bar with its own rule, and 16px of background above it read as slack in the bar rather
// than as a margin — the title and the ✕ then sit low in a 50px strip instead of centred
// in a 34px one. The bar is flush with the column's top edge and centres its own content.
.agents__detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

.agents__detail-blank {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--k-faint);
  font-size: var(--k-fs-sm);
}

// Worktree-gone empty-state for the git-backed Зміни pane: a retired session
// has no directory to read, so the pane invites reopening rather than surfacing the api's
// error. Centred in the pane, mirroring the page-level blank states (mgmt__blank et al.).
.agents__pane-blank {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--k-sp-2);
  padding: 24px 12px;
  text-align: center;
}

.agents__pane-blank-eyebrow {
  font-size: 11px;
  letter-spacing: 0.2em;
  color: var(--k-muted);
}

.agents__pane-blank-text {
  margin: 0;
  max-width: 44ch;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1.55;
  color: var(--k-faint);
}

// THE CHAT COLUMN'S GUTTER. This bar, the tabs under it, both other panes and every floor
// of KPanel below them (header, tools, log, status row, composer) inset their content by
// 12px on each side, and the trailing control sits 6px in — one left edge and one control
// column for the whole stack. They used to disagree by 2px, which is enough to see when
// five rules sit on top of each other in one narrow column.
.agents__detail-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 44px;
  padding: 0 6px 0 12px;
  background: var(--k-bg);
  border-bottom: 2px solid var(--k-line-strong);
  flex: none;
}

// The bar's left half: for a branch, the parent it hangs off; then the status dot, the
// session's own name, and its branch tag.
.agents__detail-id {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  min-width: 0;
}

// The way back up to the agent this branch was forked off. A trailing «/» separates it from
// the session name, so the two read as one path.
.agents__detail-parent {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 1 auto;
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--k-faint);
  font-size: 12px;
  cursor: pointer;

  &:hover { color: var(--k-accent); }
  &:focus-visible { outline: 1px solid var(--k-accent); outline-offset: 2px; }

  &::after {
    content: '/';
    margin-left: 5px;
    color: var(--k-faint);
  }
}

.agents__detail-parent-mark {
  flex: none;
  font-size: 13px;
  line-height: 1;
}

.agents__detail-parent-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// The session's own name — the bar's title, so it carries the UI face at full text colour,
// not the muted mono the old path label wore.
// The name's own box while it is edited: same type, an accent underline for the field.
.agents__detail-rename {
  min-width: 0;
  flex: 0 1 auto;
  padding: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--k-accent);
  outline: none;
}
// Saved but not yet echoed back by the session row.
.agents__detail-name--pending { opacity: 0.6; }
.agents__detail-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
}

// The branch tag ellipsises before the name does: a branch name is recognisable from its
// head, and the name is the thing being labelled. `display: block` is what makes
// `text-overflow` bite on the tag's own text (its inline-flex would wrap it in an item).
.agents__detail-branch {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  display: block;
}

// The bar's right half: the live status word, the primary session glyphs, the overflow menu,
// then the way out. `flex: none` so the cluster keeps its width and the name yields instead.
.agents__detail-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

// Harness · status — «omp · готово». The one place the session's runtime is named now that
// the embedded panel is `bare`.
.agents__detail-status {
  font-size: 11px;
  color: var(--k-muted);
  white-space: nowrap;
}

// The house 28px glyph box (KIconButton's size), so this ✕ centres on the same column as the
// panel controls; borderless, because a title bar is not an actions cluster.
.agents__close {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--k-muted);
  font-size: 13px;
  cursor: pointer;

  &:hover { color: var(--k-text); }
  &:focus-visible { outline: 1px solid var(--k-accent); outline-offset: -1px; }
}

// ── Overflow menu ──────────────────────────────────────────────────────────
.agents__menu {
  position: relative;
  display: flex;
  align-items: center;
}

.agents__menu-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 20;
  min-width: 224px;
  padding: var(--k-sp-1);
  display: flex;
  flex-direction: column;
  background: var(--k-grad-raise), var(--k-surface);
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  box-shadow: var(--k-sheen), var(--k-shadow-pop);
}

.agents__menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 9px;
  border: none;
  border-radius: var(--k-r-sm);
  background: transparent;
  color: var(--k-text);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;

  &:hover:not(:disabled) { background: var(--k-surface2); }
  // The session is pending a result (or another action is out): the row stays, unpressable.
  &:disabled { opacity: 0.45; cursor: default; }
  &:focus-visible { outline: 1px solid var(--k-accent); outline-offset: -1px; }
}

// The destructive rows carry the accent, and take a faint accent wash on hover.
.agents__menu-item--danger {
  color: var(--k-accent);

  &:hover { background: var(--k-accent-weak, var(--k-surface2)); }
}

.agents__menu-mark {
  flex: none;
  width: 16px;
  text-align: center;
  font-size: var(--k-icon-sm);
  line-height: 1;
  color: var(--k-muted);
}

.agents__menu-item--danger .agents__menu-mark { color: inherit; }

.agents__menu-label { flex: 1; }

.agents__menu-kbd { flex: none; }

.agents__menu-sep {
  height: 1px;
  margin: var(--k-sp-1) 6px;
  background: var(--k-line);
}

// The preview-blocked reason, on its own strip below the bar so it is on screen in every tab
// the disabled ▶ is — a disabled control carries no reachable tooltip.
.agents__detail-note {
  flex: none;
  margin: 0;
  padding: 5px 12px 0;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.agents__panel {
  flex: 1;
  min-height: 0;
}

// In the unified session card the panel is not its own box — the outer card owns the
// border, so the transcript flows flat on the card surface instead of a box-in-a-box.
.agents__tabpane .agents__panel {
  border: none;
  border-radius: 0;
  background: transparent;
}

// The virtualised list: a plain block, NOT a flex column with a gap. The gap moves onto each
// row (.agents__vrow) so that the height useVirtualList measures CONTAINS it — a flex gap
// lives between children instead, and the spacers would then be short by one gap per page,
// which reads as a scrollbar drifting as the column is scrolled.
.agents__cards {
  display: block;
}

// One virtualised row: a card, a group label or the stranded note, plus the vertical gap
// below it as PADDING for the reason above.
.agents__vrow {
  padding-bottom: var(--k-sp-3);
}

// ── Detail tabs + panes ────────────────────────────────────────────────────
.agents__detail-tabs {
  flex: none;
  padding: 0 12px;
}

// The log's density switch, moved off the old panel toolbar onto the tab row's right edge.
.agents__log-ctl {
  padding: 0;
  border: none;
  background: transparent;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
  cursor: pointer;
  transition: color 0.12s;

  &:hover { color: var(--k-text); }
  &:focus-visible { outline: 1px solid var(--k-accent); outline-offset: 2px; }
}

.agents__tabpane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

// The Лог's own content (KPanel or the native TUI) sits in this column whether or not the
// browser is beside it, so the split adds a sibling instead of reshaping the log.
.agents__log-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

// «Поруч із логом»: log | seam | browser. The browser keeps its dragged width; the log takes
// the rest (the seam's max keeps it at MIN_SPLIT_LOG or more).
.agents__tabpane--split {
  flex-direction: row;
}

.agents__split-browser {
  flex: none;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

// A native session's TUI fills the Лог pane; KTerminalView sizes itself to 100% of it.
.agents__native-term {
  flex: 1;
  min-height: 0;
}

.agents__changes,
.agents__session,
.agents__docs {
  overflow-y: auto;
  gap: 14px;
  padding: 16px 12px;
}

.agents__changes-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
  color: var(--k-muted);
}
.agents__changes-branch { color: var(--k-text); }
.agents__changes-dirty { color: var(--k-accent); }

.agents__conflict {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--k-accent);
}
.agents__conflict-head { list-style: none; margin-left: -18px; }

.agents__file-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
}
.agents__file-item {
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--k-line);
}
// A row is the control that opens the file's diff, so it is a button — focus and Enter
// come with it — stripped back to the plain list row it looks like.
.agents__file-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 5px 0;
  border: none;
  background: transparent;
  font-size: 12px;
  text-align: left;
  cursor: pointer;

  &:hover .agents__file-path { color: var(--k-accent); }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: -1px;
  }
}
.agents__file-row--open .agents__file-path { color: var(--k-accent); }
// A finished session's document row has nothing to open: same row, no pointer, no hover cue.
.agents__file-row--static {
  cursor: default;

  &:hover .agents__file-path { color: var(--k-text); }
}
.agents__file-diff { margin: 0 0 8px; }
.agents__file-path {
  color: var(--k-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agents__file-stat {
  flex: none;
  display: inline-flex;
  gap: 8px;
}
.agents__diff-add { color: var(--k-diff-add); }
.agents__diff-del { color: var(--k-diff-del); }

// ── Документація tab: read list (transcript) + changed-docs list (shares the changes pane).
.agents__docs-group { display: flex; flex-direction: column; gap: 8px; }
.agents__docs-title {
  margin: 0;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--k-muted);
}
.agents__docs-read { margin: 0; padding: 0; list-style: none; }
// The layout badge (специфікація/план/схема/хендоф) sits right before the +/− stat: the row is
// space-between, so the auto margin keeps it off the middle of a short path.
.agents__docs-kind { flex: none; margin-left: auto; }
// «Написати запит на API» / «Написати хендоф» above the lists.
.agents__docs-actions { display: flex; flex-wrap: wrap; gap: 8px; }
// A changed document's row and its «Задача →» side by side; the row keeps the width.
.agents__docs-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.agents__docs-row .agents__file-row { flex: 1; min-width: 0; }
.agents__docs-handover {
  flex: none;
  padding: 2px 0;
  border: none;
  background: transparent;
  color: var(--k-accent);
  font-size: 12px;
  cursor: pointer;

  &:hover { text-decoration: underline; }
}
.agents__docs-read-item {
  padding: 6px 0;
  border-bottom: 1px solid var(--k-line);
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12.5px;
}
.agents__docs-read-path {
  color: var(--k-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// ── QA tab: checklist off the linked card ──────────────────────────────────
.agents__qa-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.agents__qa-count { font-size: 11.5px; color: var(--k-muted); }
.agents__qa-list { margin: 8px 0 0; padding: 0; list-style: none; display: grid; gap: 8px; }

// ── Task brief (full description + creation images) ────────────────────────
.agents__task {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.agents__task-title {
  margin: 0;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--k-muted);
  font-weight: 600;
}
.agents__task-desc {
  margin: 0;
  font-size: 12.5px;
  color: var(--k-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.agents__task-empty {
  margin: 0;
  font-size: 12.5px;
  color: var(--k-muted);
}
.agents__task-images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.agents__task-img {
  display: block;
  max-width: 220px;
  max-height: 220px;
  border-radius: 4px;
  border: 1px solid var(--k-line);
}
// ── Session metadata + actions ─────────────────────────────────────────────
.agents__meta {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.agents__meta-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.agents__meta-label {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--k-muted);
}
.agents__meta-value {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--k-text);
  text-align: right;
  overflow-wrap: anywhere;
}
// The one value nobody reads and everybody copies: one click takes the whole uuid, so a
// 36-character drag across a wrapped line can't end up short.
.agents__meta-value--id {
  user-select: all;
}
// The provider session id is a click-to-copy target: it reads as the plain mono value the row
// beside it wears (no button chrome), and only the pointer + a hover underline mark it as live.
.agents__meta-copy {
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: right;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.agents__meta-copy:hover {
  text-decoration: underline;
}
// The PR link (the «PR» row and the merged-PR popup): opens in the OS browser, and like
// the copy target it reads as plain text with a hover underline.
.agents__meta-link {
  color: inherit;
  text-decoration: none;
}
.agents__meta-link:hover {
  text-decoration: underline;
}
// No wrapping: the bar is 34px and a second row of glyphs would grow it. At most five fit
// beside an ellipsised name at the detail pane's min width.
.agents__actions {
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
}

.agents__log-empty {
  font-size: 12px;
  color: var(--k-muted);
}

// ── Launcher form ─────────────────────────────────────────────────────────
.agents__form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.agents__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-family: var(--k-font-ui);
}

.agents__field-label {
  text-align: left;
  font-size: 13px;
  color: var(--k-text);
}

.agents__textarea {
  font-family: var(--k-font-mono);
  font-size: 13px;
  line-height: 1.5;
  color: var(--k-text);
  background: var(--k-surface);
  border: 1px solid var(--k-line-strong);
  padding: 9px 11px;
  border-radius: var(--k-r);
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

.agents__error {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--k-accent);
}

.agents__file {
  display: none;
}

// ── New-task launcher (two-column) ────────────────────────────────────────
.agents-launcher__headmeta {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 12px;
}
.agents-launcher__spacer {
  flex: 1;
}
// The workspace name — the single context label in this head, centred by the two flex
// spacers between the «Нова задача» title and «Esc — закрити». Accented and heavy so the
// shared board a task lands on is the line the eye catches.
.agents-launcher__ws {
  font-family: var(--k-font-ui);
  font-size: 13.5px;
  font-weight: 800;
  letter-spacing: -0.01em;
  color: var(--k-accent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.agents-launcher__esc {
  font-size: 11.5px;
  color: var(--k-muted);
}

.agents-launcher {
  display: grid;
  grid-template-columns: 1fr 320px;
}
.agents-launcher__main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 22px 24px;
  border-right: 1px solid var(--k-line);
}
.agents-launcher__side {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 20px;
  padding: 22px 24px;
  background: var(--k-surface);
}

// The flush body supplies no padding of its own, so this strip carries the launcher's own
// gutter and a rule that separates it from the two columns above.
.agents-launcher__publish {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--k-sp-3);
  padding: 16px 24px;
  border-top: 1px solid var(--k-line);
  background: var(--k-surface);
}
// The prose states the situation and the controls answer it, so each explanation takes a
// row of its own instead of squeezing the select and the button off the end.
.agents-launcher__publish > p {
  flex: 1 0 100%;
}

.agents-launcher__label {
  font-family: var(--k-font-ui);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--k-muted);
  margin-bottom: 8px;
}
.agents-launcher__label--strong {
  color: var(--k-text);
}
.agents-launcher__label-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
}
.agents-launcher__label-row .agents-launcher__label {
  margin-bottom: 0;
}
.agents-launcher__label-row--tight {
  justify-content: flex-start;
  gap: 8px;
}
.agents-launcher__hint-inline,
.agents-launcher__optional {
  font-size: 11px;
  color: var(--k-muted);
}
.agents-launcher__optional {
  font-size: 10.5px;
}

.agents-launcher__task {
  width: 100%;
  background: var(--k-surface);
  border: none;
  border-left: 2px solid var(--k-accent);
  border-radius: var(--k-r);
  color: var(--k-text);
  font-family: var(--k-font-mono);
  font-size: 13.5px;
  line-height: 1.7;
  padding: 12px 13px;
  resize: vertical;
  outline: none;
}
.agents-launcher__task::placeholder {
  color: var(--k-muted);
}

.agents-launcher__attach {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.agents-launcher__attach-btn {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  background: transparent;
  border: 1px solid var(--k-line);
  border-radius: var(--k-r);
  color: var(--k-muted);
  font-size: 12px;
  cursor: pointer;
}
.agents-launcher__attach-btn:hover {
  border-color: var(--k-accent);
  color: var(--k-text);
}
.agents-launcher__attach-note {
  font-size: 11.5px;
  color: var(--k-muted);
}

.agents-launcher__name {
  border-top: 1px solid var(--k-line);
  padding-top: 16px;
}
// The launch pair («Модель» / «Рівень роздумів»). A rule off the name field above, then two
// selects side by side: the growing option set stays one row tall instead of two stacked
// blocks that pushed the modal past the viewport.
.agents-launcher__run {
  border-top: 1px solid var(--k-line);
  padding-top: 16px;
}
.agents-launcher__duo {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.agents-launcher__name-input {
  width: 100%;
  background: var(--k-bg);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r);
  color: var(--k-text);
  font-family: var(--k-font-mono);
  font-size: 13px;
  padding: 9px 11px;
  outline: none;
}
.agents-launcher__name-input::placeholder {
  color: var(--k-muted);
}
.agents-launcher__name-input:focus {
  border-color: var(--k-accent);
}
.agents-launcher__hint {
  margin-top: 7px;
  font-family: var(--k-font-mono);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--k-muted);
}

.agents-launcher__branch {
  background: var(--k-bg);
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  padding: 10px 12px;
  font-family: var(--k-font-mono);
  font-weight: 500;
  font-size: 13px;
  color: var(--k-text);
  word-break: break-all;
}

.agents-launcher__seg {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  background: var(--k-line-strong);
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  overflow: hidden;
}
.agents-launcher__seg--grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
}
/* Labels of uneven length (`Керманич` beside `omp`): each button starts at its own width, so
   the long one is not cut to a quarter of the row. */
.agents-launcher__seg--fit .agents-launcher__seg-btn {
  flex: 1 1 auto;
}
.agents-launcher__seg-btn {
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
.agents-launcher__seg-btn:hover {
  color: var(--k-text);
}
.agents-launcher__seg-btn--active {
  background: var(--k-accent);
  color: var(--k-on-accent);
}

.agents-launcher__block {
  border-top: 1px solid var(--k-line);
  padding-top: 16px;
}
.agents-launcher__block--stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.agents-launcher__check-desc {
  margin: 3px 0 0;
  padding-left: 24px;
  font-family: var(--k-font-ui);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--k-muted);
}
.agents-launcher__from {
  display: flex;
  align-items: center;
  gap: 10px;
}
.agents-launcher__from-label {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--k-muted);
}
.agents-launcher__from :deep(.k-select) {
  flex: 1;
  min-width: 0;
}
.agents-launcher__from :deep(.k-select__input) {
  background: var(--k-bg);
  font-size: 12.5px;
  padding: 8px 10px;
  width: 100%;
  min-width: 0;
}

.agents-launcher__foot {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 12px;
}
.agents-launcher__foot-hint {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}
// Spacing only. The chip's size and colour are KKbd's business — this row used to set an
// 11px font-size and `opacity: .7` on top of each other, and the two reductions compounded
// into a shortcut nobody could read on the accent fill.
.agents-launcher__kbd {
  margin-left: var(--k-sp-2);
}
</style>
