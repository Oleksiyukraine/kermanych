<template>
  <main class="agents">
    <!-- Nothing in scope — neither a workspace nor a project — so the rail invites a choice. -->
    <div v-if="!store.selectedProjectId && !store.selectedWorkspaceId" class="agents__blank">
      <div class="agents__blank-eyebrow mono">{{ t('agents.blank.eyebrow') }}</div>
      <p class="agents__blank-text">{{ t('agents.blank.text') }}</p>
    </div>

    <div v-else class="agents__content" ref="contentEl" :class="{ 'agents__content--resizing': resizing }">
      <!-- BOARD — one card per session in scope: one project, or every project of a workspace -->
      <section class="agents__board" :style="{ width: detailWidth + 'px' }">
        <header class="agents__board-head">
          <div class="agents__board-title">
            <span class="agents__bucket-label">{{ bucketLabel }}</span>
            <span class="agents__bucket-count mono">{{ boardCount }}</span>
          </div>
          <div class="agents__board-controls">
            <!-- Creating anything needs ONE project (a session row carries a projectId), so
                 under a workspace scope this is the one control that cannot act. Its reason is
                 the visible line below and NOT a `title`: KBtn routes `title` into v-tip,
                 which binds mouseenter/focusin on the element, and Chromium dispatches
                 neither on a disabled button — nor can one take focus. A tooltip on a
                 disabled control is unreachable by construction. -->
            <KBtn variant="primary" :disabled="!store.selectedProjectId" @click="openLauncher()">
              {{ t('agents.board.newTask') }}
            </KBtn>
          </div>
        </header>

        <!-- Muted lines about the SCOPE, above the cards the scope decided. Both state
             something the operator can act on; the rule beneath keeps the cards reading as a
             separate list rather than as their continuation. -->
        <div v-if="!store.selectedProjectId || outsideScopeNote" class="agents__notes mono">
          <p v-if="!store.selectedProjectId" class="agents__note">{{ t('agents.hints.pickProject') }}</p>
          <p v-if="outsideScopeNote" class="agents__note">{{ outsideScopeNote }}</p>
        </div>

        <!-- «Задачі» is my cloud backlog: the cards assigned to me, above whatever stranded
             pre-cutover local rows the session list below still holds. -->
        <div v-if="showTasks && taskCards.length" class="agents__cards">
          <template v-for="g in taskGroups" :key="g.projectId">
            <div v-if="groupByProject" class="agents__group-label mono">{{ g.name }}</div>
            <!-- `branch` is deliberately EMPTY here, and must stay empty: KSessionCard heads
                 the card with `branch || title`, so anything passed wins over the title. A
                 card's `t.branch` is its BASE branch («Базова гілка»), seeded from the
                 project default — passing it made every card in the inbox read «main» and
                 hid the title in the ✕ tooltip. A BACKLOG card has no branch of its own to
                 name; the session cards below do, which is why they pass theirs. -->
            <KSessionCard
              v-for="card in g.rows"
              :key="card.id"
              :branch="''"
              :title="card.title"
              :time="renderTime(t, relativeTime(card.updatedAt, now))"
              :status="card.status"
              :status-line="card.description ?? ''"
              :model="card.model"
              :selected="false"
              removable
              :remove-title="t('agents.board.removeTask', { title: card.title })"
              @click="openLauncher(card)"
              @remove="onDeleteCard(card)"
            />
          </template>
        </div>
        <!-- Whatever survived the publication pass: rows whose project has no cloud row at
             all, so there is nothing for a card to point at. Only under «Задачі» — in every
             other bucket these are ordinary local sessions. -->
        <p v-if="showTasks && boardRows.length" class="agents__note agents__note--stranded mono">
          {{ t('agents.board.stranded') }}
        </p>
        <div v-if="boardRows.length" class="agents__cards">
          <template v-for="g in boardGroups" :key="g.projectId">
            <div v-if="groupByProject" class="agents__group-label mono">{{ g.name }}</div>
            <KSessionCard
              v-for="s in g.rows"
              :key="s.id"
              :branch="s.branch"
              :title="s.name"
              :time="renderTime(t, relativeTime(s.lastActivityAt, now))"
              :status="s.status"
              :status-line="activityOf(s) || statusWord(s)"
              :model="s.model"
              :usage="s.usage"
              :selected="store.selectedSessionId === s.id"
              :removable="s.kind === 'task'"
              :remove-title="t('agents.board.removeStranded', { name: s.name })"
              @click="onRowClick(s)"
              @remove="onDeleteStranded(s)"
            />
          </template>
        </div>
        <div v-else-if="!showTasks || !taskCards.length" class="agents__empty mono">{{ emptyText }}</div>
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
        <template v-if="selectedSession">
        <div class="agents__detail-bar">
          <div class="agents__detail-path">
            <!-- A branch names the agent it was forked off, and opens it. -->
            <template v-if="parentOfSelected">
              <button
                type="button"
                class="agents__detail-parent"
                v-tip="t('agents.detail.openParent')"
                :aria-label="t('agents.detail.openParentAria', { name: parentOfSelected.name })"
                @click="store.selectSession(parentOfSelected.id)"
              >
                <span class="agents__detail-parent-mark" aria-hidden="true">↑</span>
                <span class="agents__detail-parent-name mono">
                  {{ parentOfSelected.branch || parentOfSelected.name }}
                </span>
              </button>
              <span class="agents__detail-sep mono" aria-hidden="true">/</span>
            </template>
            <span class="agents__detail-label mono">{{ selectedSession.name }}</span>
          </div>
          <!-- WHAT CAN BE DONE TO THIS SESSION, and the way out. Moved out of the «Сесія»
               pane's foot so every session-level action — preview above all — is on screen in
               Лог, Зміни and Сесія alike, one control column that outlives the tab choice. -->
          <div class="agents__detail-controls">
            <div class="agents__actions">
              <template v-if="selectedSession.kind === 'discussion' || selectedSession.kind === 'review'">
                <KIconButton
                  v-if="selectedSession.status !== 'merged'"
                  :title="selectedSession.kind === 'review' ? t('agents.merge.reviewTitle') : t('agents.actions.mergeTip')"
                  @click="openMerge(selectedSession)"
                >⤴</KIconButton>
                <KIconButton
                  :title="selectedSession.kind === 'review' ? t('agents.actions.discardReview') : t('agents.actions.discardBranch')"
                  @click="onDiscardRow(selectedSession)"
                >✕</KIconButton>
              </template>
              <template v-else-if="!showArchived">
                <!-- `title` names the action even while disabled, and never explains the
                     disabling: KIconButton feeds it to BOTH v-tip and aria-label, and a
                     disabled button dispatches no mouseenter/focusin and cannot take focus, so
                     a reason parked there is unreachable — while an aria-label holding an
                     instruction gives the control no name at all. The reason is the visible
                     line under this bar. -->
                <KIconButton
                  :active="!!store.previews[selectedSession.id]"
                  :disabled="!isBoundFor(selectedSession.projectId)"
                  :title="store.previews[selectedSession.id] ? t('agents.actions.previewStop') : t('agents.actions.previewStart')"
                  @click="togglePreview(selectedSession)"
                >{{ store.previews[selectedSession.id] ? '◼' : '▶' }}</KIconButton>
                <KIconButton
                  v-if="canReview(selectedSession)"
                  :title="t('agents.actions.review')"
                  @click="onReview(selectedSession)"
                >⚖</KIconButton>
                <KIconButton
                  v-if="selectedSession.status !== 'merged'"
                  :title="t('agents.actions.finish')"
                  @click="openFinish(selectedSession)"
                >✓</KIconButton>
                <KIconButton
                  v-if="selectedSession.status === 'merged'"
                  :title="t('agents.actions.reopen')"
                  @click="onReopen(selectedSession)"
                >↻</KIconButton>
                <KIconButton :title="t('agents.actions.archive')" @click="onArchive(selectedSession)">⤓</KIconButton>
                <KIconButton :title="t('agents.actions.delete')" @click="onDeleteAgent(selectedSession)">✕</KIconButton>
              </template>
              <template v-else>
                <KIconButton :title="t('agents.actions.unarchive')" @click="onUnarchive(selectedSession)">⤒</KIconButton>
                <KIconButton :title="t('agents.actions.delete')" @click="onDeleteAgent(selectedSession)">✕</KIconButton>
              </template>
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
        <KTabs v-model="detailTab" :tabs="detailTabs" class="agents__detail-tabs" />
        <div v-show="detailTab === 'log'" class="agents__tabpane agents__tabpane--log">
          <KPanel
            class="agents__panel"
            :session="selectedSession"
            :refreshing="refreshingId === selectedSession.id"
            :models="store.models"
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
          </KPanel>
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
              <span>{{ t('agents.changes.commits', { n: changesInfo.ahead }) }}</span>
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
                  @close="closeFile"
                />
              </li>
            </ul>
            <p v-else class="agents__log-empty mono">{{ t('agents.changes.noFiles') }}</p>
          </template>
        </div>
        <div v-if="detailTab === 'files'" class="agents__tabpane agents__files">
          <div v-if="worktreeGone" class="agents__pane-blank">
            <span class="agents__pane-blank-eyebrow mono">{{ t('agents.changes.historyEyebrow') }}</span>
            <p class="agents__pane-blank-text">
              {{ t('agents.files.gone') }}
            </p>
          </div>
          <p v-else-if="treeLoading" class="agents__log-empty mono">{{ t('agents.changes.preparing') }}</p>
          <p v-else-if="treeError" class="agents__error" role="alert">{{ treeError }}</p>
          <template v-else>
            <KFileView
              v-if="openTreeFile"
              class="agents__file-view"
              :path="openTreeFile"
              :file="treeFile"
              :loading="treeFileLoading"
              :error="treeFileError"
              @close="closeTreeFile"
            />
            <KFileTree
              v-show="!openTreeFile"
              class="agents__tree"
              :entries="treeRoot"
              base=""
              :selected="openTreeFile"
              :load="loadTreeLevel"
              @open="openTreeFileAt"
            />
          </template>
        </div>
        <div v-if="detailTab === 'session'" class="agents__tabpane agents__session">
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
            <div class="agents__meta-row">
              <dt class="agents__meta-label">{{ t('agents.session.cost') }}</dt>
              <dd class="agents__meta-value mono">{{ costLabel || '—' }}</dd>
            </div>
          </dl>
        </div>
        </template>
        <div v-else class="agents__detail-blank mono">{{ t('agents.detail.blank') }}</div>
      </aside>
    </div>

    <!-- NEW-TASK LAUNCHER — two columns: left = what to do, right = where it lands -->
    <KModal v-model="launcherOpen" :title="launcherTitle" width="880px" flush>
      <template #head-meta>
        <div class="agents-launcher__headmeta">
          <span v-if="launchProject" class="agents-launcher__tag mono">{{ launchProject.name }}</span>
          <span class="agents-launcher__spacer"></span>
          <span class="agents-launcher__esc mono">{{ t('agents.launcher.esc') }}</span>
        </div>
      </template>

      <div class="agents-launcher" @keydown="onLauncherKeydown">
        <!-- LEFT — the task itself -->
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
              @paste="onLaunchPaste"
              @drop.prevent="onLaunchDrop"
              @dragover.prevent
            />
          </div>

          <div class="agents-launcher__attach">
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
          <KAttachStrip v-if="launchImages.length" :images="launchImages" @remove="removeLaunchImage" />
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
            <div class="agents-launcher__hint mono">
              {{ draftName.trim() ? branchPreview : t('agents.launcher.nameHintPending') }}
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
              <KSelect v-model="draftBaseBranch" :options="launchBranches" />
            </div>
          </div>

          <div class="agents-launcher__block">
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

          <div class="agents-launcher__block">
            <div class="agents-launcher__label">{{ t('agents.launcher.effortLabel') }}</div>
            <KSelect v-model="draftEffort" :options="effortPickOptions" :placeholder="t('agents.launcher.defaultOption')" />
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
        <KBtn :disabled="!publishInto || publishing" @click="publishAndFile">
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
          <KBtn v-if="editingTask" variant="ghost" @click="onDeleteCard(editingTask)">
            {{ t('agents.launcher.delete') }}
          </KBtn>
          <span v-if="launcherError" class="agents__error" role="alert">{{ launcherError }}</span>
          <span v-else class="agents-launcher__foot-hint mono">{{ footHint }}</span>
          <span class="agents-launcher__spacer"></span>
          <KBtn variant="ghost" @click="launcherOpen = false">{{ t('agents.launcher.cancel') }}</KBtn>
          <KBtn
            variant="secondary"
            :disabled="!canLaunch"
            @click="submitLauncher(true)"
          >{{ editingTaskId ? t('agents.launcher.save') : t('agents.launcher.backlog') }}</KBtn>
          <!-- No `title` here either, and for the same reason: it only ever had content while
               the button was disabled, so it was never reachable. `footHint` above already
               renders BIND_HINT visibly, which is why the user never lost anything — the dead
               attribute only told the next reader that the reason was covered. -->
          <KBtn
            variant="primary"
            :disabled="!canLaunch || !isBound"
            @click="submitLauncher(false)"
          >
            {{ t('agents.launcher.launch') }}<span class="agents-launcher__kbd mono">⌘⏎</span>
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
        <KBtn variant="primary" :disabled="mergeBusy" @click="submitMerge">{{ mergeIsReview ? t('agents.merge.give') : t('agents.merge.pour') }}</KBtn>
      </template>
    </KModal>

    <!-- PREVIEW CONFIG — how to run this project's app for a live branch preview -->
    <KModal v-model="previewCfgOpen" :title="t('agents.preview.title')">
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
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="previewCfgOpen = false">{{ t('agents.launcher.cancel') }}</KBtn>
        <KBtn variant="primary" :disabled="!draftWebCmd.trim()" @click="submitPreviewConfig">
          {{ t('agents.preview.run') }}
        </KBtn>
      </template>
    </KModal>

    <!-- FINISH — merge the session branch into the project branch, retire the worktree -->
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
            {{ t('agents.finish.pour') }} <code class="mono">{{ finishData.branch }}</code> →
            <code class="mono">{{ finishData.target }}</code>
          </p>
          <p v-if="finishData" class="agents__hint mono">
            {{ t('agents.finish.aheadInfo', { n: finishData.ahead, dirty: finishData.dirty ? t('agents.finish.aheadDirty') : '' }) }}
          </p>
          <p v-else class="agents__hint mono">{{ t('agents.changes.preparing') }}</p>
        </div>
        <p v-if="finishError" class="agents__error" role="alert">{{ finishError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="finishOpen = false">{{ t('agents.finish.close') }}</KBtn>
        <KBtn v-show="finishFiles.length" variant="secondary" @click="resolveAuto">{{ t('agents.finish.resolveAuto') }}</KBtn>
        <KBtn
          v-show="!finishFiles.length"
          variant="secondary"
          :disabled="prBusy || finishBusy || !finishData"
          @click="submitPr"
        >{{ t('agents.finish.createPr') }}</KBtn>
        <KBtn
          variant="primary"
          :disabled="finishBusy || (!finishData && !finishFiles.length)"
          @click="submitFinish"
        >{{ finishFiles.length ? t('agents.finish.tryAgain') : t('agents.finish.pour') }}</KBtn>
      </template>
    </KModal>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  slugify,
  buildChatBlocks,
  branchName,
  taskNameFromText,
  skillsUsed,
  type ImageInput,
  type Session,
  type SessionStatus,
  type TranscriptEntry,
  type ThinkingLevel,
  type RpcExtensionUIResponse,
  type TreeEntry,
  type FileContent,
} from '@kermanych/core';
import { createTask as cloudCreateTask } from '@kermanych/cloud';
import type { Task } from '@kermanych/cloud';
import { useOrchestrator } from 'stores/orchestrator';
import { useRouter } from 'vue-router';
import { useProjects } from 'stores/projects';
import { useBoard } from 'stores/board';
import { useAuth } from 'stores/auth';
import { api, type FileDiff, type MessageMode } from '../lib/api';
import { EXPAND_ALL_NONE, nextExpandAll, type ExpandAllCommand } from '../lib/expand-all';
import { sessionScopedProjectIds } from '../lib/scope';
import { myBacklogTasks, taskInsertFromDraft, taskPatchFromDraft } from '../lib/tasks-view';
import { planBacklogPublication } from '../lib/publish-backlog';
import KPanel from 'components/kit/KPanel.vue';
import KRequestBlock from 'components/kit/KRequestBlock.vue';
import KStatusDot from 'components/kit/KStatusDot.vue';
import KSessionCard from 'components/kit/KSessionCard.vue';
import KTabs from 'components/kit/KTabs.vue';
import KDiffView from 'components/kit/KDiffView.vue';
import KFileTree from 'components/kit/KFileTree.vue';
import KFileView from 'components/kit/KFileView.vue';
import KBtn from 'components/kit/KBtn.vue';
import KIconButton from 'components/kit/KIconButton.vue';
import KModal from 'components/kit/KModal.vue';
import KAttachStrip from 'components/kit/KAttachStrip.vue';
import KCheckbox from 'components/kit/KCheckbox.vue';
import KSelect from 'components/kit/KSelect.vue';
import { BRANCH_PREFIXES, PLATFORMS, type BranchPrefix, type Platform } from '@kermanych/core';
import { useImageAttach } from '../composables/useImageAttach';
import { useNow } from '../composables/useNow';
import { relativeTime, renderTime } from '../lib/time';
import { tokens, usageTokens, usd } from '../lib/format';
import { EFFORT_OPTIONS } from '../lib/effort';
import { modelOptions, effortOptions } from '../lib/models';
import { useResizableWidth } from '../composables/useResizableWidth';

// The Агенти screen (design-system section 07): the board of session cards for whatever is
// in scope — one project, or every project of a workspace — plus the full panel for the
// selected session and the new-agent launcher. All mutations go through the Pinia store.
const store = useOrchestrator();
const { t } = useI18n();
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

// Board buckets mirror the sidebar (MainLayout.bucketCounts): archived wins, then
// backlog → Задачі, then merged/done/stopped → Історія, everything else → Активні
// (error/conflict count as active — they need attention). Driven by store.selectedBucket.
const HISTORY_STATUSES: readonly SessionStatus[] = ['merged', 'done', 'stopped'];
// Active = an agent whose process is alive or is blocked on the operator. Beside
// HISTORY_STATUSES because it is the same shape of question, and shared: archiving refuses
// these (the API re-checks with core's ACTIVE_STATUSES) and the out-of-scope note counts
// exactly them.
const ACTIVE_STATUSES: readonly SessionStatus[] = ['queued', 'thinking', 'tool', 'waiting_input'];
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

const projectSessions = computed(() =>
  store.sessions
    .filter((s) => {
      if (!inScope.value.has(s.projectId)) return false;
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
// Group ORDER is the best STATUS_RANK the group holds, so the project with the most urgent
// agent leads, and it is seeded explicitly rather than taken from first appearance in
// boardRows. First appearance looks equivalent and is not: projectSessions filters by BUCKET
// first, so in Активні a `merged` parent is not in the list at all and its still-running
// child falls through boardRows' orphan sweep to the very END. Its project then sorts below
// a project whose most urgent session is an `error` (rank 1) — the reachable worst case, and
// the shape the browser check built. Only Активні can produce that orphan: in the buckets
// where a rank-2 `done` survives, the parent survives with it and no child is orphaned. An
// agent waiting on a question must not sit under another project's settled work, which is
// the whole reason the list is tiered in the first place.
//
// Ties keep first-appearance order (Array#sort is stable), so within one rank the grouping
// changes nothing about the order the sessions already had.
const groupByProject = computed(() => !store.selectedProjectId);
type BoardGroup = { projectId: string; name: string; rank: number; rows: Session[] };
const boardGroups = computed<BoardGroup[]>(() => {
  const groups = new Map<string, BoardGroup>();
  for (const s of boardRows.value) {
    let group = groups.get(s.projectId);
    if (!group) {
      group = { projectId: s.projectId, name: projectName(s.projectId), rank: Number.MAX_SAFE_INTEGER, rows: [] };
      groups.set(s.projectId, group);
    }
    group.rows.push(s);
    // Accumulated in the same pass rather than recomputed per comparison.
    group.rank = Math.min(group.rank, STATUS_RANK[s.status]);
  }
  return [...groups.values()].sort((a, b) => a.rank - b.rank);
});

// My backlog inbox: the cards I have to work, in the same scope the session list uses, so
// one sidebar click narrows both. Unclaimed team cards live on Дошка by design.
const taskCards = computed(() => myBacklogTasks(board.tasks, auth.user?.id ?? '', scopedIds.value));

type TaskGroup = { projectId: string; name: string; rows: Task[] };
// Cards are all `backlog`, so there is no STATUS_RANK to order groups by: project name is
// the only stable order available, and it matches what the rail shows.
const taskGroups = computed<TaskGroup[]>(() => {
  const groups = new Map<string, TaskGroup>();
  for (const t of taskCards.value) {
    let group = groups.get(t.projectId);
    if (!group) {
      group = { projectId: t.projectId, name: projectName(t.projectId), rows: [] };
      groups.set(t.projectId, group);
    }
    group.rows.push(t);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
});

// The header counts what the column RENDERS, and under «Задачі» that is the cards plus any
// stranded pre-cutover local row — the same sum the rail's badge shows. A header reading 0
// above a list of cards would be the disagreement MainLayout.bucketCounts exists to avoid.
const boardCount = computed(
  () => boardRows.value.length + (showTasks.value ? taskCards.value.length : 0),
);

// Active agents the current scope hides — an agent that is running, or waiting for an answer,
// and left the screen because the operator clicked elsewhere in the rail. The page must not
// do that quietly, and it does not widen the scope by itself either (the rail owns
// selection): it names the projects to click.
//
// Named rather than merely counted, and that is not decoration. A count has to point
// somewhere, and the obvious pointer — the rail's running badges — answers a DIFFERENT
// question: MainLayout's RUNNING is queued|thinking|tool and deliberately omits
// `waiting_input`, which is the case an operator most needs back (the agent asked something
// and the screen moved on). Observed in the browser: an out-of-scope `waiting_input` agent
// leaves no badge at all, so «look at the counters» would have been a false pointer for it.
// A project name is true whatever the badge shows.
const outsideScopeProjects = computed(() => {
  const names = new Map<string, string>();
  for (const s of store.sessions) {
    if (inScope.value.has(s.projectId)) continue;
    if (s.archived || s.kind === 'chat' || !ACTIVE_STATUSES.includes(s.status)) continue;
    if (!names.has(s.projectId)) names.set(s.projectId, projectName(s.projectId));
  }
  return [...names.values()];
});
const outsideScopeNote = computed(() => {
  const names = outsideScopeProjects.value;
  if (!names.length) return '';
  // Capped, and no trailing instruction: this line sits directly above the cards in a 324px
  // column, where the fuller «виберіть проєкт у лівій панелі, щоб їх побачити» measured four
  // lines and pushed the first card most of a card-height down — for a sentence the blank and
  // empty states already teach. The names ARE the affordance: they are the rail's own labels.
  const rest = names.length - 3;
  const shown = names.slice(0, 3).join(', ') + (rest > 0 ? ` ${t('agents.board.outsideMore', { n: rest })}` : '');
  return t('agents.board.outsideScope', { names: shown });
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

// Requirement 3 in the UI: a task can be created, edited and moved without a binding, but
// nothing that touches the repo may run. `BIND_HINT` is the same string MainLayout uses; both
// copies are the operator's next action, not an apology.
// A card lives in the cloud, and `tasks.project_id` is what tasks_insert_member checks
// membership against — so a project that never left this machine has nothing to hang one on.
// The way out is the publish hatch in the launcher, which this line points at.
// A workspace is not a place a session can be created: it holds several projects and a session
// row carries exactly one projectId. Rendered as visible text beside the disabled button, not
// as its tooltip — see the template.
// The one explanatory bubble in the meta list. `v-tip`, not the native `title` it used to
// be: that one drew the OS rectangle after a ~1s delay, the single square bubble left in a
// rounded UI. A <dt> is neither focusable nor disabled, so the directive fires on it.
const skillsHint = computed(() => t('agents.session.skillsHint'));
const isBound = computed(() => !!launchProject.value?.localRepoPath);

// Row-level check: the board can show sessions of an orphan project whose row is still here
// but whose binding was never made, so per-row actions ask about the row's own project.
function isBoundFor(projectId: string): boolean {
  return !!store.projects.find((p) => p.id === projectId)?.localRepoPath;
}
const selectedSession = computed(() =>
  store.sessions.find((s) => s.id === store.selectedSessionId),
);

// A session whose worktree has been retired keeps `worktree: true` but loses its
// `worktreePath` — this is every finished/merged agent sitting in Історія. The two
// git-backed panes (Зміни, Файли) have no directory to read then, so instead of firing a
// request that comes back «session has no worktree» / ENOENT and painting the pane with a
// red error, they show a calm empty-state. Derived, so both panes agree on when it applies.
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
  if (!s || showArchived.value) return false;
  // Matches the branch that renders the preview toggle, so the line cannot appear beside a
  // cluster that has no such button (a discussion, a review, or the archived view).
  if (s.kind === 'discussion' || s.kind === 'review') return false;
  return !isBoundFor(s.projectId);
});
const entries = computed<TranscriptEntry[]>(() =>
  store.selectedSessionId
    ? store.transcripts[store.selectedSessionId] ?? []
    : [],
);

// Which library skills this session took, read straight off the transcript rows the
// reducer already produced — the «Сесія» tab needs no state of its own for it.
const usedSkills = computed(() => skillsUsed(entries.value));

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
  width: detailWidth,
  resizing,
  startResize,
  onKeydown: onResizeKeydown,
  refresh: refreshDetailWidth,
} = useResizableWidth({
  storageKey: 'kermanych.agents.board-width',
  defaultWidth: 340,
  min: MIN_BOARD,
  edge: 'right',
  max: () =>
    contentEl.value ? contentEl.value.clientWidth - MIN_DETAIL : Number.POSITIVE_INFINITY,
});

const bucketLabel = computed(() =>
  store.selectedBucket === 'tasks'
    ? t('agents.bucket.tasks')
    : store.selectedBucket === 'archived'
      ? t('agents.bucket.archived')
      : store.selectedBucket === 'history'
        ? t('agents.bucket.history')
        : t('agents.bucket.active'),
);

// The empty list, per bucket. The two creatable buckets split again on scope, because
// «Нова задача» is disabled under a workspace scope and an invitation to press it would be a
// dead end there. The click that unblocks it is NOT repeated here — PICK_PROJECT_HINT is
// already on screen a few pixels above, and saying it twice reads as two different problems.
const emptyText = computed(() => {
  if (showArchived.value) return t('agents.empty.archived');
  if (showHistory.value) return t('agents.empty.history');
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

// ── Detail tabs (Лог / Зміни / Сесія) ─────────────────────────────────────
// The right panel splits the session into three views. The choice is persisted
// per session (localStorage `kermanych.agents.tab.<id>`) so reopening an agent lands where the
// operator left it; a fresh session defaults to the log.
const detailTabs = computed(() => [
  { value: 'log', label: t('agents.tabs.log') },
  { value: 'changes', label: t('agents.tabs.changes') },
  { value: 'files', label: t('agents.tabs.files') },
  { value: 'session', label: t('agents.tabs.session') },
]);
const detailTab = ref('log');
watch(
  () => store.selectedSessionId,
  (id) => {
    const saved = id ? localStorage.getItem(`kermanych.agents.tab.${id}`) : null;
    detailTab.value =
      saved === 'changes' || saved === 'session' || saved === 'files' ? saved : 'log';
  },
  { immediate: true },
);
watch(detailTab, (t) => {
  const id = store.selectedSessionId;
  if (id) localStorage.setItem(`kermanych.agents.tab.${id}`, t);
});

// ── Зміни tab (finishInfo: ahead/dirty/conflicts + changed files) ──────────
// Loaded when the tab opens for a session, then refreshed while the agent works: the
// listing covers uncommitted work, so it goes stale on every edit the agent makes. A
// non-worktree session or a git error surfaces as a message rather than throwing.
const changesInfo = ref<Awaited<ReturnType<typeof store.finishInfo>> | null>(null);
const changesError = ref<string | null>(null);
const changesLoading = ref(false);
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

// Bumping the run counter is what makes a collapse final: an in-flight reply for the file
// just closed would otherwise land in the pane the operator dismissed.
function closeFile(): void {
  openFile.value = null;
  fileDiffLoading.value = false;
  fileDiffRun++;
}

function toggleFile(path: string): void {
  const id = store.selectedSessionId;
  if (!id || openFile.value === path) {
    closeFile();
    return;
  }
  openFile.value = path;
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

// ── Файли tab: the worktree file tree + a read-only viewer ──────────────────
// The root level loads when the tab opens; deeper levels lazy-load per folder through
// loadTreeLevel, which KFileTree calls on expand. Opening a file fetches its body into the
// viewer, ordered by treeFileRun so a slow read cannot overwrite a newer one.
const treeRoot = ref<TreeEntry[]>([]);
const treeLoading = ref(false);
const treeError = ref<string | null>(null);
const openTreeFile = ref<string | null>(null);
const treeFile = ref<FileContent | null>(null);
const treeFileLoading = ref(false);
const treeFileError = ref<string | null>(null);
let treeFileRun = 0;

function loadTreeLevel(path: string): Promise<TreeEntry[]> {
  const id = store.selectedSessionId;
  return id ? store.sessionTree(id, path) : Promise.resolve([]);
}

async function loadTreeRoot(id: string): Promise<void> {
  treeError.value = null;
  treeLoading.value = true;
  try {
    treeRoot.value = await store.sessionTree(id, '');
  } catch (e) {
    treeError.value = e instanceof Error ? e.message : String(e);
  } finally {
    treeLoading.value = false;
  }
}

async function openTreeFileAt(path: string): Promise<void> {
  const id = store.selectedSessionId;
  if (!id) return;
  const run = ++treeFileRun;
  openTreeFile.value = path;
  treeFile.value = null;
  treeFileError.value = null;
  treeFileLoading.value = true;
  try {
    const f = await store.sessionFile(id, path);
    if (run !== treeFileRun) return;
    treeFile.value = f;
  } catch (e) {
    if (run !== treeFileRun) return;
    treeFileError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (run === treeFileRun) treeFileLoading.value = false;
  }
}

function closeTreeFile(): void {
  openTreeFile.value = null;
  treeFile.value = null;
  treeFileError.value = null;
  treeFileLoading.value = false;
  treeFileRun++;
}

watch(
  [() => store.selectedSessionId, detailTab],
  ([id, tab]) => {
    // Another session (or a trip through another tab) invalidates whatever file was open.
    closeFile();
    closeTreeFile();
    // A retired worktree has nothing to read; the empty-state renders from `worktreeGone`
    // instead, so neither pane issues a request that can only come back as an error.
    if (worktreeGone.value) return;
    if (tab === 'changes' && id) void loadChanges(id, true);
    if (tab === 'files' && id) void loadTreeRoot(id);
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
    if (detailTab.value !== 'changes' || changesTimer || worktreeGone.value) return;
    changesTimer = setTimeout(() => {
      changesTimer = undefined;
      const id = store.selectedSessionId;
      if (detailTab.value === 'changes' && id) void loadChanges(id, false);
    }, CHANGES_REFRESH_MS);
  },
);
onBeforeUnmount(() => clearTimeout(changesTimer));

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
      return t('agents.statusWord.thinking');
    case 'tool':
      return t('agents.statusWord.tool');
    case 'waiting_input':
      return t('agents.statusWord.waiting');
    case 'done':
      return t('agents.statusWord.done');
    case 'error':
      return t('agents.statusWord.error');
    case 'queued':
      return t('agents.statusWord.queued');
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
const nameEdited = ref(false);
const draftBaseBranch = ref('');
const launchBranches = ref<string[]>([]);
const editingTaskId = ref<string | null>(null);
// The card `editingTaskId` points at, resolved from the store rather than snapshotted, so a
// realtime edit to the card being edited is not lost behind the modal.
const editingTask = computed<Task | undefined>(() =>
  editingTaskId.value ? board.tasks.find((t) => t.id === editingTaskId.value) : undefined,
);
const branchPreview = computed(() =>
  draftName.value.trim()
    ? branchName(slugify(draftName.value), draftPrefix.value)
    : `${draftPrefix.value}/…`,
);
// Right-column summary line under the branch box.
const branchHint = computed(() =>
  draftWorktree.value
    ? t('agents.launcher.branchHintWorktree', { base: draftBaseBranch.value || launchProject.value?.defaultBranch || 'HEAD' })
    : t('agents.launcher.branchHintInplace'),
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
  () => !!launchProjectId.value && draftName.value.trim() !== '' && draftTask.value.trim() !== '',
);

const launcherTitle = computed(() => (editingTaskId.value ? t('agents.launcher.editTitle') : t('agents.board.newTask')));
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
async function loadLaunchBranches(preferred: string | undefined): Promise<void> {
  const projectId = launchProjectId.value;
  launchBranches.value = [];
  draftBaseBranch.value = preferred ?? launchProject.value?.defaultBranch ?? '';
  if (!projectId || !isBound.value) return;
  try {
    const info = await store.listBranches(projectId);
    launchBranches.value = info.branches;
    if (!draftBaseBranch.value) draftBaseBranch.value = info.default ?? info.current ?? '';
  } catch {
    // Non-fatal: the picker degrades to the preferred/default value only.
  }
}

function openLauncher(card?: Task): void {
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
  // `tasks.branch` IS the base branch (the board labels it «Базова гілка»).
  void loadLaunchBranches(card?.branch);
  nameEdited.value = !!card;
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
  void loadLaunchBranches(undefined);
  nameEdited.value = true;
  launcherError.value = null;
  clearLaunchImages();
  launcherOpen.value = true;
  void nextTick(() => nameField.value?.focus());
}

// Both buttons write a CLOUD card; «Запустити» then launches it on this machine. Creating
// the card FIRST is what makes the task visible to the team with an assignee, and it also
// means a failed launch loses nothing: the card is saved, assigned to me, and can be retried
// from here or from the board. (It also means from-task's claim rollback never fires on this
// path — the card is already mine, so `claimed` stays false there.)
async function submitLauncher(asTask: boolean): Promise<void> {
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
    baseBranch: draftBaseBranch.value || undefined,
  };
  const images = launchImages.value.map((i) => ({ data: i.data, mimeType: i.mimeType }));
  launcherError.value = null;
  try {
    let cardId: string;
    if (editingTaskId.value) {
      if (!(await board.updateTaskFields(editingTaskId.value, taskPatchFromDraft(draft)))) return;
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
    const session = await api.createSessionFromTask(cardId, images);
    launcherOpen.value = false;
    clearLaunchImages();
    store.setBucket('active');
    store.selectSession(session.id);
  } catch (e) {
    // Keep the launcher open so the name and body are not lost. The card, if it was created,
    // is already safe on the board.
    launcherError.value = e instanceof Error ? e.message : String(e);
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
async function onDeleteCard(card: Task): Promise<void> {
  if (!window.confirm(t('agents.notify.deleteCard', { title: card.title }))) return;
  if (!(await board.deleteTask(card.id))) return;
  // The editor is this card's only detail view; it must not outlive the row it edits.
  if (editingTaskId.value === card.id) launcherOpen.value = false;
}

// A stranded pre-cutover row: local SQLite and nothing else, so this stays a plain delete.
async function onDeleteStranded(s: Session): Promise<void> {
  if (!window.confirm(t('agents.notify.deleteStranded', { name: s.name }))) return;
  try {
    await store.deleteSession(s.id);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
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

async function onSummary(): Promise<void> {
  const s = selectedSession.value;
  if (!s) return;
  try {
    await store.sendMessage(s.id, t('agents.prompt.summary'), nextMode(s));
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

// The composer's effort chip. omp refuses a level its provider cannot run, and the api
// reports that refusal rather than writing the row — so a failure has to be shown, or the
// chip would snap back with no explanation.
async function onEffort(level: ThinkingLevel): Promise<void> {
  const s = selectedSession.value;
  if (!s) return;
  try {
    await store.setEffort(s.id, level);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

// The composer's model picker on a running session — mirror of onEffort. The api's 400
// carries omp's own refusal, so nothing is swallowed.
async function onSetModel(patch: { model: string; provider?: string }): Promise<void> {
  const s = selectedSession.value;
  if (!s) return;
  try {
    await store.setSessionModel(s.id, patch);
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
    store.notify(t('agents.notify.reopened', { name: s.name }));
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

// Physical delete (archive teardown + removal): stops the omp process, removes the
// worktree/branch and the registry row, cascading to child branches. Works on any
// status, unlike archive which refuses active agents.
async function onDeleteAgent(s: Session): Promise<void> {
  if (!window.confirm(t('agents.notify.deleteAgent', { name: s.name }))) return;
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

function onDiscardRow(s: Session): void {
  if (!window.confirm(t('agents.notify.discard', { kind: s.kind === 'review' ? t('agents.notify.kindReview') : t('agents.notify.kindBranch'), name: s.name }))) return;
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
      // Merged, but the push back to origin did not land — say so, because the work is only
      // local until the operator pulls and pushes it.
      if ('pushed' in res && res.pushed === false) {
        store.notify(t('agents.notify.pushBlocked', { name: s.name, reason: res.reason ?? t('agents.notify.pushReasonDefault') }), 'error');
      }
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
    store.notify(t('agents.notify.prCreating', { name: s.name }), 'info');
  } catch (e) {
    finishError.value = e instanceof Error ? e.message : String(e);
  } finally {
    prBusy.value = false;
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
    window.alert(t('agents.preview.launchFailed', { error: e instanceof Error ? e.message : String(e) }));
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
  win?.document.write(loadingHtml.value);
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
  // previewCommand/apiCommand are CLOUD config, so the write needs a cloud row — and per
  // the approved role matrix ANY workspace member may make it: `projects_update_member`
  // (20260827100000_workspaces.sql:338) replaced the owner-only policy this gate used to
  // cite. Membership needs no separate check, because the cloud list is RLS-scoped: a
  // project with a row in `projects.byId` is one whose workspace this user belongs to.
  // Same predicate as the settings modal's `isInCloud` (MainLayout.vue:1419).
  //
  // The pre-check itself stays. RLS is the real gate, but a refused UPDATE matches zero
  // rows and postgrest reports it as "Cannot coerce the result to a single JSON object" —
  // unreadable. Refuse here in Ukrainian instead, and keep the modal open so the entered
  // commands are not lost. The two false states are not the same sentence, for the same
  // reason MainLayout's `noCloudRowHint` splits them: a claim about where a project lives
  // must never outrun what we actually checked.
  if (!projects.byId.has(s.projectId)) {
    store.notify(
      projects.listRead
        ? t('agents.preview.notBoundLocal')
        : t('agents.preview.notBoundOffline'),
      'error',
    );
    return;
  }
  const win = window.open('', '_blank');
  win?.document.write(loadingHtml.value);
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
    window.alert(t('agents.preview.saveFailed', { error: e instanceof Error ? e.message : String(e) }));
    return;
  }
  await launchInto(win, s);
}
</script>

<style scoped lang="scss">
// Fixed header (48px) + footer (30px) are overlaid by the Quasar layout; the
// Агенти screen fills exactly the space between them.
.agents {
  height: calc(100vh - 82px);
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
  gap: 20px;
  margin-bottom: 20px;
}

.agents__board-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.agents__bucket-label {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
}

.agents__bucket-count {
  margin-left: var(--k-sp-2);
  font-size: var(--k-fs-sm);
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

// The scope notices — why «Нова задача» cannot act, and which projects hold active agents
// this scope hides. Muted like every other hint on this screen, because both report a fact
// the operator may act on rather than a warning. The rule and the spacing live on the
// container so that one line or two cost the same frame, and so the cards below read as a
// separate list rather than as a continuation of the prose.
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

  &:first-child {
    padding-top: 0;
  }
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

// Worktree-gone empty-state for the git-backed panes (Зміни, Файли): a retired session
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
  gap: 10px;
  height: 34px;
  // `height` is border-box, so the 2px rule below is taken out of the interior and
  // `align-items: center` then centres the title and the ✕ in the 32px ABOVE the rule —
  // 1px high in a bar the eye reads as its full 34px, which measures as 10.8px of air over
  // the glyphs and 14px under them. The 2px of top padding is that rule's counterweight:
  // the content centres on the strip's own middle, and the ~0.5px that remains is the
  // font's ink bias (a line box centres 5px over the baseline, cap ink 4.5px), which every
  // centred label in the app shares.
  padding: 2px 6px 0 12px;
  background: var(--k-bg);
  border-bottom: 2px solid var(--k-line-strong);
  flex: none;
}

// The bar's left half: for a branch, the parent it hangs off, then this session's own name.
.agents__detail-path {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  min-width: 0;
}

// The way back up to the agent this branch was forked off.
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

  &:hover {
    color: var(--k-accent);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 2px;
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

.agents__detail-sep {
  flex: none;
  font-size: 12px;
  color: var(--k-faint);
}

.agents__detail-label {
  font-size: 12px;
  color: var(--k-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// The house 28px glyph box (KIconButton's size), so this ✕ centres on the same column as
// the panel controls in the bar right below it; borderless, because a title bar is not an
// actions cluster. A 24px box put it 2px off that column.
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

  &:hover {
    color: var(--k-text);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: -1px;
  }
}

// The bar's right half: the session's action glyphs, then the way out. `flex: none` so the
// cluster keeps its width and the ellipsised name yields instead.
.agents__detail-controls {
  display: flex;
  align-items: center;
  // Wider than the 6px INSIDE the cluster, so «Закрити» reads as a separate thing from the
  // action it sits next to — «Видалити агента», the other ✕ in this bar.
  gap: 10px;
  flex: none;
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

.agents__cards {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

// ── Detail tabs + panes ────────────────────────────────────────────────────
.agents__detail-tabs {
  flex: none;
  padding: 0 12px;
}

.agents__tabpane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.agents__changes,
.agents__session {
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

// The Файли pane fills the panel: the tree scrolls on its own, and an open file's viewer
// takes the whole height with its own internal scroll.
.agents__files {
  flex-direction: column;
  overflow: hidden;
  padding: 0;
}
.agents__tree {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 6px;
}
.agents__file-view {
  flex: 1;
  min-height: 0;
}

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
.agents-launcher__tag {
  font-size: 11.5px;
  color: var(--k-muted);
  border: 1px solid var(--k-line);
  padding: 1px 6px;
}
.agents-launcher__spacer {
  flex: 1;
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
  font-size: 11.5px;
  color: var(--k-muted);
}
.agents-launcher__kbd {
  margin-left: 10px;
  font-size: 11px;
  opacity: 0.7;
}
</style>
