<template>
  <main class="set">
    <!-- CATEGORY RAIL — scope switcher on top, its categories below. The rail is
         addressed by the URL (`/settings/<key>`), so a deep link, the browser's
         Back button and the header gear all arrive at the same pane with no state
         of their own. -->
    <aside class="set__rail">
      <div class="set__rail-head">
        <KTopNav
          dense
          :model-value="section.scope"
          :options="scopeOptions"
          @update:model-value="goScope"
        />
        <p class="set__hint">{{ scopeHint }}</p>
      </div>
      <nav class="set__cats" :aria-label="t('settings.rail.categoriesAria', { scope: scopeLabel })">
        <button
          v-for="c in scopeCategories"
          :key="c.key"
          type="button"
          class="set__cat"
          :class="{ 'set__cat--on': c.key === section.key, 'set__cat--danger': c.danger }"
          :aria-current="c.key === section.key ? 'page' : undefined"
          @click="goSection(c.key)"
        >
          <span class="set__cat-text">
            <span class="set__cat-label">{{ t('settings.categories.' + c.key + '.label') }}</span>
            <span class="set__cat-sub">{{ t('settings.categories.' + c.key + '.sub') }}</span>
          </span>
          <KCount v-if="badges[c.key] !== undefined" :value="badges[c.key]!" />
        </button>
      </nav>
    </aside>

    <!-- CONTENT PANE — heading, the section itself, and the save bar docked to the
         foot. The bar is the ONLY way a draft reaches the server, so it lives
         outside the scroll area: a change made at the top of a long section must
         not need scrolling to be saved. -->
    <section class="set__pane">
      <header class="set__head">
        <div class="set__head-text">
          <h1 class="set__title">{{ t('settings.categories.' + section.key + '.label') }}</h1>
          <p class="set__blurb">{{ t('settings.categories.' + section.key + '.blurb') }}</p>
        </div>
        <span
          v-if="section.scope !== 'app'"
          class="set__saved"
          :class="{ 'set__saved--dirty': dirtyCount > 0 }"
        >{{ dirtyCount > 0 ? t('settings.head.unsaved') : t('settings.head.saved') }}</span>
      </header>

      <div class="set__body">
        <!-- The selection IS the access rule for the two team scopes: with nothing
             chosen in the sidebar there is no row to configure. Same invitation the
             Менеджмент tab shows, once per scope rather than once per section. -->
        <div v-if="section.scope === 'project' && !projectId" class="set__blank">
          <span class="set__blank-eyebrow mono">{{ t('settings.blank.eyebrow') }}</span>
          <p>{{ t('settings.blank.project') }}</p>
        </div>
        <div v-else-if="section.scope === 'workspace' && !workspace" class="set__blank">
          <span class="set__blank-eyebrow mono">{{ t('settings.blank.eyebrow') }}</span>
          <p>{{ t('settings.blank.workspace') }}</p>
        </div>

        <!-- ── PROJECT · ОСНОВНЕ ────────────────────────────────────────────── -->
        <div v-else-if="section.key === 'project-basics' && draft" class="set__form">
          <KField
            v-model="draft.name"
            :label="t('settings.project.name')"
            placeholder="my-project"
            :disabled="cloudLocked"
          />
          <KColorPicker
            v-model="draft.color"
            :label="t('settings.project.color')"
            :class="{ 'set__locked': cloudLocked }"
          />
          <!-- The non-mouse path to a move, and the only path to a COLLAPSED
               destination — a folded workspace renders no sidebar row, so it has no
               drop target at all. Same write as the drag: a patch of workspace_id. -->
          <KSelect
            v-model="draft.workspaceId"
            :label="t('settings.project.workspace')"
            :options="workspaceOptions"
            :disabled="cloudLocked"
          />
          <KField
            v-model="draft.gitRemoteUrl"
            :label="t('settings.project.gitRemote')"
            placeholder="git@github.com:org/repo.git"
            :disabled="cloudLocked"
          />

          <div class="set__rule"></div>

          <!-- The binding is per machine and manual (Requirement 3): the path must
               already be a git repo, and each teammate binds their own checkout.
               Hence a picker rather than a text field, and hence this block sitting
               outside the cloud-locked group above — it works for a project the
               cloud has never heard of. -->
          <div class="set__group">
            <span class="set__label">{{ t('settings.project.localFolder') }}</span>
            <div class="set__row">
              <span class="set__path mono" :class="{ 'set__path--empty': !boundPath }">
                {{ boundPath || t('settings.project.notBound') }}
              </span>
              <KBtn variant="secondary" @click="pickerOpen = true">{{ t('settings.project.choose') }}</KBtn>
            </div>
            <p class="set__note">{{ t('settings.project.folderNote') }}</p>
          </div>

          <p v-if="cloudLocked" class="set__note">{{ noCloudRowHint }}</p>
        </div>

        <!-- ── PROJECT · ГІЛКИ Й КОНВЕНЦІЇ ──────────────────────────────────── -->
        <div v-else-if="section.key === 'project-git' && draft" class="set__form">
          <KSelect
            v-model="draft.defaultBranch"
            :label="t('settings.git.defaultBranch')"
            :options="branches"
            :disabled="cloudLocked || !isBound"
            :placeholder="t('settings.git.branchPlaceholder')"
          />
          <p v-if="!isBound" class="set__note">{{ t('settings.git.branchBindHint') }}</p>
          <KField
            v-model="draft.conventions"
            :label="t('settings.git.conventions')"
            :placeholder="t('settings.git.conventionsPlaceholder')"
            multiline
            :rows="8"
            :disabled="cloudLocked"
          />
          <p v-if="cloudLocked" class="set__note">{{ noCloudRowHint }}</p>
        </div>

        <!-- ── PROJECT · КОМАНДИ ────────────────────────────────────────────── -->
        <div v-else-if="section.key === 'project-commands' && draft" class="set__form">
          <KField
            v-model="draft.previewCommand"
            :label="t('settings.commands.preview')"
            placeholder="pnpm dev --port $PORT"
            :disabled="cloudLocked"
          />
          <KField
            v-model="draft.apiCommand"
            :label="t('settings.commands.api')"
            placeholder="pnpm dev:api"
            :disabled="cloudLocked"
          />

          <div class="set__rule"></div>

          <div class="set__group">
            <span class="set__label">{{ t('settings.commands.carryFiles') }}</span>
            <!-- Chips, not a comma-joined line: these are PATHS, and a list of
                 paths in one input is a string nobody can read back. The input
                 commits on Enter and on blur, so a typed path is never lost to a
                 click somewhere else. -->
            <div class="set__chips">
              <span v-for="(f, i) in draft.carryFiles" :key="`${f}-${i}`" class="set__chip mono">
                {{ f }}
                <button
                  type="button"
                  class="set__chip-x"
                  :aria-label="t('settings.commands.removeFile', { file: f })"
                  :disabled="cloudLocked"
                  @click="draft.carryFiles.splice(i, 1)"
                >✕</button>
              </span>
              <input
                v-model="carryInput"
                class="set__chip-input mono"
                :placeholder="t('settings.commands.addPathPlaceholder')"
                :disabled="cloudLocked"
                @keydown.enter.prevent="addCarryFile"
                @blur="addCarryFile"
              />
            </div>
            <i18n-t keypath="settings.commands.carryNote" tag="p" class="set__note">
              <template #env><span class="mono">.env</span></template>
            </i18n-t>
          </div>

          <p v-if="cloudLocked" class="set__note">{{ noCloudRowHint }}</p>
        </div>

        <!-- ── PROJECT · ЗАПУСК ЗАДАЧ ───────────────────────────────────────── -->
        <div v-else-if="section.key === 'project-defaults' && draft" class="set__form">
          <KSelect
            v-model="draft.defaultModel"
            :label="t('settings.defaults.model')"
            :options="defaultModelPickOptions"
            :placeholder="t('settings.defaults.placeholder')"
            :disabled="cloudLocked"
            searchable
          />
          <KSelect
            v-model="draft.defaultEffort"
            :label="t('settings.defaults.effort')"
            :options="defaultEffortPickOptions"
            :placeholder="t('settings.defaults.placeholder')"
            :disabled="cloudLocked"
          />
          <p class="set__note">{{ t('settings.defaults.note') }}</p>
          <p v-if="cloudLocked" class="set__note">{{ noCloudRowHint }}</p>
        </div>

        <!-- ── PROJECT · БІБЛІОТЕКА СКІЛІВ ──────────────────────────────────── -->
        <!-- Mounted, not inlined: the library is a screen's worth of list, modal and
             cloud writes of its own, and it moved here whole from Менеджмент. Same
             arrangement as KEnvEditor below. The `v-if` is the type guard the outer
             chain cannot give: reaching this branch already means a project is
             selected, but only the narrowing here turns the id into a string. -->
        <div v-else-if="section.key === 'project-skills'" class="set__form set__form--wide">
          <SkillsLibraryPanel v-if="projectId" :project-id="projectId" :project-name="projectName" />
        </div>

        <!-- ── PROJECT · ПРИЗНАЧЕННЯ ────────────────────────────────────────── -->
        <!-- Directly after the library, because it is the library it assigns from. Same
             `v-if` type guard as the pane above, for the same reason. -->
        <div v-else-if="section.key === 'project-agents'" class="set__form set__form--wide">
          <AgentSkillsPanel v-if="projectId" :project-id="projectId" :project-name="projectName" />
        </div>

        <!-- ── PROJECT · ТРИГЕРИ ────────────────────────────────────────────── -->
        <!-- The last pane of «ШІ команда» and the last arm of this chain. It follows the two
             above because a trigger names a skill from the same library: the library says what
             exists, «Призначення» hands it over unconditionally, and a trigger fires it on a
             pattern. Same `v-if` type guard as both, for the same reason. -->
        <div v-else-if="section.key === 'project-triggers'" class="set__form set__form--wide">
          <TriggersPanel v-if="projectId" :project-id="projectId" :project-name="projectName" />
        </div>

        <!-- ── PROJECT · ЗМІННІ СЕРЕДОВИЩА ──────────────────────────────────── -->
        <div v-else-if="section.key === 'project-env'" class="set__form set__form--wide">
          <p v-if="!isBound" class="set__note">
            <i18n-t keypath="settings.env.bindHint" tag="span">
              <template #env><span class="mono">.env</span></template>
            </i18n-t>
          </p>
          <template v-else>
            <KEnvEditor v-model="envRows" :ignored="envFile.ignored" :flags-locked="cloudLocked" />
            <p v-if="missingRequired.length" class="set__error" role="alert">
              {{ t('settings.env.missingRequired', { keys: missingRequired.join(', ') }) }}
            </p>
            <p v-if="cloudLocked" class="set__note">
              {{ t('settings.env.requiredLocked', { hint: noCloudRowHint }) }}
            </p>
          </template>
        </div>

        <!-- ── PROJECT · НЕБЕЗПЕЧНА ЗОНА ────────────────────────────────────── -->
        <div v-else-if="section.key === 'project-danger'" class="set__form">
          <div class="set__danger">
            <span class="set__danger-text">
              <span class="set__danger-title">{{ t('settings.danger.projectTitle') }}</span>
              <span class="set__note">{{ t('settings.danger.projectNote') }}</span>
            </span>
            <KBtn
              variant="ghost"
              class="set__danger-btn"
              :disabled="!isOwnerOfProject"
              @click="deleteProjectOpen = true"
            >{{ t('settings.danger.delete') }}</KBtn>
          </div>
          <p v-if="!isOwnerOfProject" class="set__note">{{ t('settings.danger.projectOwnerOnly') }}</p>
        </div>

        <!-- ── WORKSPACE · ОСНОВНЕ ──────────────────────────────────────────── -->
        <div v-else-if="section.key === 'workspace-basics'" class="set__form">
          <KField
            v-model="wsDraft.name"
            :label="t('settings.workspace.name')"
            placeholder="AAA"
            :disabled="!isOwnerOfWorkspace"
          />
          <KColorPicker
            v-model="wsDraft.color"
            :label="t('settings.workspace.color')"
            :class="{ 'set__locked': !isOwnerOfWorkspace }"
          />
          <p v-if="!isOwnerOfWorkspace" class="set__note">{{ t('settings.workspace.ownerOnly') }}</p>
        </div>

        <!-- ── WORKSPACE · УЧАСНИКИ ─────────────────────────────────────────── -->
        <div v-else-if="section.key === 'workspace-members'" class="set__form set__form--wide">
          <!-- Invite and remove take effect IMMEDIATELY — they are server calls with
               their own confirmation, not a draft. Only name and colour queue up in
               the save bar, which is why this section shows no dirty state of its
               own. -->
          <div v-if="isOwnerOfWorkspace" class="set__row">
            <KField
              v-model="memberEmail"
              class="set__grow"
              :label="t('settings.members.inviteLabel')"
              placeholder="colleague@example.com"
              type="email"
            />
            <KBtn
              variant="primary"
              :disabled="memberEmail.trim() === '' || memberBusy"
              @click="invite"
            >{{ memberBusy ? t('settings.members.inviting') : t('settings.members.invite') }}</KBtn>
          </div>

          <div class="set__table">
            <div v-if="membersLoading" class="set__empty">{{ t('settings.members.loading') }}</div>
            <div v-for="m in members" :key="m.userId" class="set__member">
              <img
                v-if="m.profile?.avatarUrl"
                class="set__avatar"
                :src="m.profile.avatarUrl"
                :alt="m.profile.githubUsername ?? ''"
              />
              <span v-else class="set__avatar set__avatar--blank mono">?</span>
              <span class="set__member-name mono">
                @{{ m.profile?.githubUsername ?? m.profile?.displayName ?? m.userId.slice(0, 8) }}
              </span>
              <KTag v-if="isOwnerSeat(m.userId)">{{ t('settings.roles.owner') }}</KTag>
              <KSelect
                v-else-if="isOwnerOfWorkspace"
                class="set__role"
                :model-value="m.role"
                :options="ROLE_OPTIONS"
                :disabled="roleBusy === m.userId"
                @update:model-value="(role: string) => changeRole(m, role as AssignableRole)"
              />
              <KTag v-else>{{ ROLE_LABELS[m.role] }}</KTag>
              <KIconButton
                v-if="isOwnerOfWorkspace && !isOwnerSeat(m.userId)"
                :title="t('settings.members.remove')"
                @click="removeMember(m)"
              >✕</KIconButton>
            </div>
            <div v-if="!membersLoading && !members.length" class="set__empty">
              {{ t('settings.members.empty') }}
            </div>
          </div>

          <p class="set__note">{{ t('settings.members.note') }}</p>
          <p v-if="!isOwnerOfWorkspace" class="set__note">{{ t('settings.members.ownerOnly') }}</p>
        </div>

        <!-- ── WORKSPACE · НЕБЕЗПЕЧНА ЗОНА ──────────────────────────────────── -->
        <div v-else-if="section.key === 'workspace-danger'" class="set__form">
          <div class="set__danger">
            <span class="set__danger-text">
              <span class="set__danger-title">{{ t('settings.danger.workspaceTitle') }}</span>
              <span class="set__note">{{ t('settings.danger.workspaceNote') }}</span>
            </span>
            <KBtn
              variant="ghost"
              class="set__danger-btn"
              :disabled="!isOwnerOfWorkspace || workspaceHasProjects"
              @click="deleteWorkspaceOpen = true"
            >{{ t('settings.danger.delete') }}</KBtn>
          </div>
          <!-- Why this is VISIBLE text and not the button's tooltip: a disabled
               <button> dispatches no mouseenter and takes no focus, so v-tip on it
               never shows — the reason has to live where it can be read. -->
          <p v-if="isOwnerOfWorkspace && workspaceHasProjects" class="set__note">{{ t('settings.danger.workspaceHasProjects') }}</p>
          <p v-if="!isOwnerOfWorkspace" class="set__note">{{ t('settings.danger.workspaceOwnerOnly') }}</p>
        </div>

        <!-- ── APP · ЗАГАЛЬНЕ ───────────────────────────────────────────────── -->
        <div v-else-if="section.key === 'app-general'" class="set__form">
          <div class="set__group">
            <span class="set__label">{{ t('settings.app.theme') }}</span>
            <!-- Applies on click, with no save bar: the theme is what you are
                 looking at, so a queued theme would be a preview of a preview.
                 `toggleTheme` gets the button's rect so its reveal grows from the
                 control that was pressed. -->
            <div class="set__seg">
              <button
                v-for="th in THEMES"
                :key="th.value"
                type="button"
                class="set__seg-btn"
                :class="{ 'set__seg-btn--on': theme === th.value }"
                :aria-pressed="theme === th.value"
                @click="pickTheme(th.value, $event)"
              >{{ th.label }}</button>
            </div>
            <p class="set__note">{{ t('settings.app.themeNote') }}</p>
          </div>
          <div class="set__group">
            <span class="set__label">{{ t('settings.appGeneral.language') }}</span>
            <!-- Beside the theme: both are device-local screen preferences, not
                 account settings, and both apply on click with no save bar. -->
            <KLangToggle />
          </div>
        </div>

        <!-- ── APP · ГАРЯЧІ КЛАВІШІ ─────────────────────────────────────────── -->
        <div v-else-if="section.key === 'app-keymap'" class="set__form set__form--wide">
          <div class="set__table">
            <div v-for="k in KEYMAP" :key="k.act" class="set__keyrow">
              <span class="set__keyrow-act">{{ t(k.act) }}</span>
              <KTag>{{ k.keys }}</KTag>
              <span class="set__keyrow-where mono">{{ t(k.where) }}</span>
            </div>
          </div>
          <p class="set__note">{{ t('settings.keymap.note') }}</p>
        </div>

        <!-- ── APP · ШІ КОМАНДА ─────────────────────────────────────────────── -->
        <!-- Mounted, not inlined, for the same reason the library is: it is a list of its
             own, and its content — six agents and four English templates — belongs beside
             the registry it reads, not in this sheet. No props: `AGENTS` is a compile-time
             constant, so the panel has nothing to be told and nothing to load. -->
        <div v-else-if="section.key === 'app-agents'" class="set__form set__form--wide">
          <AgentCatalogPanel />
        </div>

        <!-- ── APP · ХЕЛПЕРИ ────────────────────────────────────────────────── -->
        <!-- Beside the agent catalogue and for the same reason: `DEFAULT_HELPERS` is a
             compile-time constant, so the pane has nothing to be told and nothing to load. -->
        <div v-else-if="section.key === 'app-helpers'" class="set__form set__form--wide">
          <HelpersCatalogPanel />
        </div>

        <!-- ── APP · АКАУНТ ─────────────────────────────────────────────────── -->
        <div v-else-if="section.key === 'app-account'" class="set__form">
          <div class="set__group">
            <span class="set__label">{{ t('settings.account.loggedInAs') }}</span>
            <div class="set__row">
              <img
                v-if="auth.profile?.avatarUrl"
                class="set__avatar set__avatar--lg"
                :src="auth.profile.avatarUrl"
                :alt="accountName"
              />
              <span v-else class="set__avatar set__avatar--lg set__avatar--blank mono">?</span>
              <span class="set__account">
                <span class="set__account-name mono">{{ accountName }}</span>
                <span v-if="auth.profile?.displayName" class="set__note">
                  {{ auth.profile.displayName }}
                </span>
              </span>
            </div>
          </div>

          <div class="set__rule"></div>

          <div class="set__group">
            <span class="set__label">{{ t('settings.account.providerPlan') }}</span>
            <!-- Percent of a rolling window, because that is the only unit a
                 provider meters a plan in. There is no token figure to show here
                 and none is invented; the cap itself lives with the provider, not
                 with Керманич, so nothing on this screen can change it. -->
            <div v-if="!planLines.length" class="set__note">
              {{ t('settings.plan.noWindows') }}
            </div>
            <div v-for="p in planLines" :key="p.provider" class="set__plan">
              <span class="set__plan-prov">{{ p.provider }}</span>
              <span v-for="w in p.windows" :key="w.id" class="set__plan-win mono">
                {{ w.label }} · {{ w.percent }}<template v-if="w.resets"> · {{ w.resets }}</template>
              </span>
            </div>
          </div>

          <div class="set__group">
            <span class="set__label">{{ t('settings.account.outboxLabel') }}</span>
            <p class="set__note">
              {{
                outbox === null
                  ? t('settings.account.outboxNoService')
                  : outbox === 0
                    ? t('settings.account.outboxEmpty')
                    : t('settings.account.outboxPending', { count: outbox })
              }}
            </p>
          </div>

          <div class="set__rule"></div>

          <div class="set__danger">
            <span class="set__danger-text">
              <span class="set__danger-title">{{ t('settings.account.signOutTitle') }}</span>
              <span class="set__note">{{ t('settings.account.signOutNote') }}</span>
            </span>
            <KBtn variant="ghost" class="set__danger-btn" @click="signOutOpen = true">{{ t('settings.account.signOut') }}</KBtn>
          </div>
        </div>

        <p v-if="paneError" class="set__error" role="alert">{{ paneError }}</p>
      </div>

      <!-- SAVE BAR — appears only with something to save, so it is never furniture. -->
      <div v-if="dirtyCount > 0" class="set__bar">
        <span class="set__bar-dot" aria-hidden="true"></span>
        <span class="set__bar-text">
          {{ dirtyCount === 1 ? t('settings.bar.oneField') : t('settings.bar.manyFields', { count: dirtyCount }) }}
        </span>
        <KBtn variant="ghost" :disabled="saving" @click="discard">{{ t('settings.bar.discard') }}</KBtn>
        <KBtn variant="primary" :disabled="saving" @click="save">
          {{ saving ? t('settings.bar.saving') : t('settings.bar.save') }}
        </KBtn>
      </div>
    </section>

    <!-- Server-side directory browser (GET /api/fs/list). Its choice becomes THIS
         machine's binding for the selected project. -->
    <KDirPicker v-model="pickerOpen" :start="boundPath" @select="bindTo" />

    <KModal v-model="deleteProjectOpen" :title="t('settings.deleteProject.title', { name: projectName })">
      <div class="set__modal">
        <p class="set__error" role="alert">{{ t('settings.deleteProject.warn', { name: projectName }) }}</p>
        <p class="set__note">{{ t('settings.deleteProject.note') }}</p>
        <p v-if="deleteError" class="set__error" role="alert">{{ deleteError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="deleteProjectOpen = false">{{ t('settings.modal.cancel') }}</KBtn>
        <KBtn variant="primary" :disabled="deleteBusy" @click="confirmDeleteProject">{{ t('settings.danger.delete') }}</KBtn>
      </template>
    </KModal>

    <KModal v-model="deleteWorkspaceOpen" :title="t('settings.deleteWorkspace.title', { name: workspaceName })">
      <div class="set__modal">
        <p class="set__error" role="alert">{{ t('settings.deleteWorkspace.warn', { name: workspaceName }) }}</p>
        <p v-if="deleteError" class="set__error" role="alert">{{ deleteError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="deleteWorkspaceOpen = false">{{ t('settings.modal.cancel') }}</KBtn>
        <KBtn variant="primary" :disabled="deleteBusy" @click="confirmDeleteWorkspace">
          {{ t('settings.danger.delete') }}
        </KBtn>
      </template>
    </KModal>

    <KModal v-model="signOutOpen" :title="t('settings.signOutModal.title')">
      <div class="set__modal">
        <i18n-t keypath="settings.signOutModal.body" tag="p" class="set__note">
          <template #name><span class="mono">{{ accountName }}</span></template>
        </i18n-t>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="signOutOpen = false">{{ t('settings.modal.cancel') }}</KBtn>
        <KBtn variant="primary" :disabled="signOutBusy" @click="confirmSignOut">{{ t('settings.account.signOut') }}</KBtn>
      </template>
    </KModal>
  </main>
</template>

<script setup lang="ts">
// The Налаштування screen. Three scopes, one surface:
//
//   Проєкт     — CLOUD config any workspace member may edit (projects_update_member),
//                plus THIS machine's repo binding and its `.env`.
//   Воркспейс  — the group's name/colour and its TEAM. Owner-only, because one
//                invitation opens every project in the group.
//   Застосунок — what belongs to this screen and this session: the theme, the
//                keys the app listens to, the account.
//
// It replaces five modals that used to hang off layouts/MainLayout.vue. The reason
// it is a ROUTE and not a bigger modal: settings are read as often as they are
// written (which command runs the preview? which branch does the agent leave from?),
// and a dialog cannot be left open beside the work it describes, cannot be deep
// linked, and has no Back button.
// WHAT IS DELIBERATELY ABSENT. Everything drawn here is backed by a real read and
// a real write. Provider API keys, spend caps, a parallel-agent limit, a
// context-warning threshold, harness paths and remappable keys
// have no storage, no endpoint and no column anywhere in this repo — see
// lib/settings.ts. A panel for them would be a control that silently forgets.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { EnvFileView, ThinkingLevel } from '@kermanych/core';
import type { AssignableRole, WorkspaceMember, WorkspaceRole } from '@kermanych/cloud';
import type { KTheme } from '@kermanych/tokens';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import { modelOptions, effortOptions } from '../lib/models';
import { EFFORT_OPTIONS } from '../lib/effort';
import { useAuth } from 'stores/auth';
import { api } from '../lib/api';
import { theme, toggleTheme } from '../lib/theme';
import { percent, planWindow } from '../lib/format';
import { until } from '../lib/time';
import { useNow } from '../composables/useNow';
import { useSubscriptionUsage } from '../composables/useSubscriptionUsage';
import { isMoveRefusal, memberErrorText, MOVE_REFUSAL, NO_ROWS } from '../lib/cloud-errors';
import {
  buildEnvRows,
  changedFields,
  envEdits,
  envRequiredKeys,
  settingsScopeEntry,
  settingsSection,
  SETTINGS_CATEGORIES,
  SETTINGS_SCOPES,
  type EnvRow,
  type SettingsScope,
} from '../lib/settings';
import KTopNav from 'components/kit/KTopNav.vue';
import KCount from 'components/kit/KCount.vue';
import KField from 'components/kit/KField.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import KColorPicker from 'components/kit/KColorPicker.vue';
import KEnvEditor from 'components/kit/KEnvEditor.vue';
import KDirPicker from 'components/kit/KDirPicker.vue';
import KBtn from 'components/kit/KBtn.vue';
import KIconButton from 'components/kit/KIconButton.vue';
import KModal from 'components/kit/KModal.vue';
import KTag from 'components/kit/KTag.vue';
import SkillsLibraryPanel from 'components/settings/SkillsLibraryPanel.vue';
import AgentSkillsPanel from 'components/settings/AgentSkillsPanel.vue';
import TriggersPanel from 'components/settings/TriggersPanel.vue';
import AgentCatalogPanel from 'components/settings/AgentCatalogPanel.vue';
import HelpersCatalogPanel from 'components/settings/HelpersCatalogPanel.vue';
import KLangToggle from 'components/kit/KLangToggle.vue';

const store = useOrchestrator();
const projects = useProjects();
const { t } = useI18n();
const auth = useAuth();
const route = useRoute();
const router = useRouter();

const section = computed(() => settingsSection(route.params.section));
const scopeCategories = computed(() =>
  SETTINGS_CATEGORIES.filter((c) => c.scope === section.value.scope),
);
const scopeOptions = computed(() =>
  SETTINGS_SCOPES.map((s) => ({ value: s, label: t('settings.scope.' + s) })),
);
const scopeLabel = computed(() => t('settings.scope.' + section.value.scope));

const paneError = ref<string | null>(null);
const saving = ref(false);

function goSection(key: string): void {
  paneError.value = null;
  if (key !== section.value.key) void router.push({ name: 'settings', params: { section: key } });
}

function goScope(scope: string): void {
  goSection(settingsScopeEntry(scope as SettingsScope).key);
}

// ── SCOPE SUBJECTS ──────────────────────────────────────────────────────────
// The LOCAL row carries this machine's binding; the CLOUD project is the source
// of truth for config. Same id, two lookups — the shell's idiom.
const projectId = computed(() => store.selectedProjectId);
const localRow = computed(() => store.projects.find((p) => p.id === projectId.value));
const cloudRow = computed(() => (projectId.value ? projects.byId.get(projectId.value) : undefined));
const projectName = computed(() => cloudRow.value?.name ?? localRow.value?.name ?? '');
const boundPath = computed(() => localRow.value?.localRepoPath ?? '');
const isBound = computed(() => !!localRow.value?.localRepoPath);

// The workspace in SCOPE. Set both by a workspace-row click and by selecting a
// project (selectProject resolves the group), so it is there whenever anything in
// the tree is selected. Undefined for a workspace the cloud list no longer holds —
// access revoked mid-session — and the pane then says so rather than naming a
// group we cannot resolve.
const workspace = computed(() =>
  store.selectedWorkspaceId ? projects.workspaceById.get(store.selectedWorkspaceId) : undefined,
);
const workspaceName = computed(() => workspace.value?.name ?? '');

// Every affordance in the workspace scope is decided by `workspaces.owner_id`,
// never by `workspace_members.role`: no policy and no security-definer function
// consults that column, and the workspaces migration copied across whatever
// project_members SAID — so a backfilled row can claim a role the database will
// not honour.
const isOwnerOfWorkspace = computed(
  () => !!workspace.value && projects.isWorkspaceOwner(workspace.value.id),
);

function isOwnerSeat(userId: string): boolean {
  return workspace.value?.ownerId === userId;
}

// Role labels for the roster, and the two roles the owner may hand out. 'owner' is
// the creator's seat — shown but never offered, since transfer is out of scope.
const ROLE_LABELS = computed<Record<WorkspaceRole, string>>(() => ({
  owner: t('settings.roles.owner'),
  manager: t('settings.roles.manager'),
  developer: t('settings.roles.developer'),
}));
const ROLE_OPTIONS = computed<KSelectOption[]>(() => [
  { value: 'developer', label: t('settings.roles.developer') },
  { value: 'manager', label: t('settings.roles.manager') },
]);
// The user id whose role change is in flight, so its select disables without freezing
// the whole roster.
const roleBusy = ref<string | null>(null);

// The FK from projects.workspace_id is `on delete restrict`, so a group still
// holding projects cannot go. Read off the same array useProjects.removeWorkspace
// pre-checks, so the button and the store agree about when a delete is possible.
const workspaceHasProjects = computed(() =>
  projects.projects.some((p) => p.workspaceId === workspace.value?.id),
);

// Deleting a project stays owner-only; everything else about it is shared work per
// the approved role matrix. Ownership resolves through the project's WORKSPACE —
// projects.owner_id was dropped.
const isOwnerOfProject = computed(() => !!projectId.value && projects.isOwner(projectId.value));

// IS THE SELECTED PROJECT IN THE CLOUD AT ALL? A «поза хмарою» local row — made
// before the team cloud existed, or while Supabase was unreachable — is
// selectable, and shared config has nowhere to go for it. Its inputs are locked
// rather than merely unsaveable: a field that accepts text and drops it is worse
// than one that refuses it. The binding and the `.env` VALUES stay live; those are
// this machine's business and always worked without a cloud row.
const isInCloud = computed(() => !!projectId.value && projects.byId.has(projectId.value));
const cloudLocked = computed(() => !isInCloud.value);

// The refusal behind those locked fields has to name the RIGHT reason, because
// `isInCloud` is false in TWO states that are not the same sentence: a project we
// KNOW is local-only (a cloud list was read and it is not in it), and a cloud list
// we have not read yet or failed to read. Only the first has a way out to offer.
const noCloudRowHint = computed(() =>
  projects.listRead
    ? t('settings.project.noCloudRowLocal')
    : t('settings.project.noCloudRowPending'),
);

const workspaceOptions = computed(() =>
  // {value,label}, never bare names: two workspaces may legitimately share one,
  // and a name-keyed select would move the project into whichever matched first.
  projects.workspaces.map((w) => ({ value: w.id, label: w.name })),
);

// ── PROJECT DRAFT ───────────────────────────────────────────────────────────
interface ProjectDraft {
  name: string;
  color: string;
  workspaceId: string;
  gitRemoteUrl: string;
  defaultBranch: string;
  defaultModel: string;
  defaultEffort: ThinkingLevel | '';
  conventions: string;
  previewCommand: string;
  apiCommand: string;
  carryFiles: string[];
}

const draft = ref<ProjectDraft | null>(null);
const base = ref<ProjectDraft | null>(null);
const carryInput = ref('');
const branches = ref<string[]>([]);

function seedProject(): void {
  const c = cloudRow.value;
  const row = localRow.value;
  if (!c && !row) {
    draft.value = null;
    base.value = null;
    return;
  }
  const next: ProjectDraft = {
    name: c?.name ?? row?.name ?? '',
    color: c?.color ?? row?.color ?? '',
    workspaceId: c?.workspaceId ?? '',
    gitRemoteUrl: c?.gitRemoteUrl ?? '',
    defaultBranch: c?.defaultBranch ?? row?.defaultBranch ?? '',
    defaultModel: c?.defaultModel ?? row?.defaultModel ?? '',
    defaultEffort: c?.defaultEffort ?? row?.defaultEffort ?? '',
    conventions: c?.conventions ?? row?.conventions ?? '',
    previewCommand: c?.previewCommand ?? row?.previewCommand ?? '',
    apiCommand: c?.apiCommand ?? row?.apiCommand ?? '',
    carryFiles: [...(c?.carryFiles ?? row?.carryFiles ?? ['.env'])],
  };
  draft.value = { ...next, carryFiles: [...next.carryFiles] };
  base.value = next;
}

const configDirty = computed(() =>
  draft.value && base.value ? changedFields(draft.value, base.value) : [],
);

// Re-seed on a NEW project, and on a cloud row arriving for the current one —
// load() resolves after this page mounts, so a form seeded at mount from an empty
// store would sit blank for good. Never while the operator has unsaved edits: a
// socket project_update from a teammate must not eat what is being typed.
watch(
  [projectId, cloudRow, localRow],
  ([id], [prevId]) => {
    if (id !== prevId || configDirty.value.length === 0) seedProject();
  },
  { immediate: true },
);

// GET /projects/:id/branches answers `project not bound` without a binding, so do
// not ask. Non-fatal either way: the picker degrades to the value already chosen.
watch(
  [() => section.value.key, projectId, isBound],
  async ([key, id, bound]) => {
    if (key !== 'project-git' || !id || !bound) return;
    try {
      branches.value = (await store.listBranches(id)).branches;
    } catch {
      branches.value = [];
    }
  },
  { immediate: true },
);

function addCarryFile(): void {
  const path = carryInput.value.trim();
  carryInput.value = '';
  if (!path || !draft.value || draft.value.carryFiles.includes(path)) return;
  draft.value.carryFiles.push(path);
}

// The «Запуск задач» pane's model and effort pickers, from the same omp catalog the launcher
// and the board editor read; «за замовчуванням» (the placeholder) leaves the choice to omp.
// The effort ladder narrows to the chosen model's own, exactly as the launcher's does.
const defaultModelPickOptions = computed(() => modelOptions(store.models));
const defaultEffortPickOptions = computed(() => {
  const allowed = effortOptions(store.models, draft.value?.defaultModel || undefined);
  return EFFORT_OPTIONS.filter((o) => allowed.includes(o.value));
});

// ── ENV ─────────────────────────────────────────────────────────────────────
// `entries` is the file as loaded — the baseline every edit is diffed against and
// the input `envEdits` derives its removals from. `ignored: true` until proven
// otherwise, so a load that never happened does not accuse the repo of committing
// its secrets.
const envFile = ref<EnvFileView>({ entries: [], ignored: true });
const envRows = ref<EnvRow[]>([]);
const envBase = ref<EnvRow[]>([]);

function seedEnvRows(): void {
  const rows = buildEnvRows(envFile.value.entries, cloudRow.value?.envKeys ?? []);
  envRows.value = rows.map((r) => ({ ...r }));
  envBase.value = rows;
}

const envDirty = computed(() => {
  const a = envRows.value;
  const b = envBase.value;
  if (a.length !== b.length) return true;
  return a.some((r, i) => {
    const o = b[i];
    return !o || o.key !== r.key || o.value !== r.value || o.required !== r.required;
  });
});

const missingRequired = computed(() =>
  envRows.value.filter((r) => r.required && r.key.trim() && !r.value).map((r) => r.key.trim()),
);

// Lazily, and only for the section that shows it: reading a `.env` is a disk hit
// the other four project sections have no use for. Skipped while the table is
// dirty — a refetch there would silently replace typed secrets.
watch(
  [() => section.value.key, projectId, isBound],
  async ([key, id, bound]) => {
    if (key !== 'project-env' || !id || !bound || envDirty.value) return;
    try {
      envFile.value = await store.getEnv(id);
      paneError.value = null;
    } catch (e) {
      envFile.value = { entries: [], ignored: true };
      paneError.value = e instanceof Error ? e.message : String(e);
    }
    seedEnvRows();
  },
  { immediate: true },
);

// A project switch invalidates the loaded file immediately, so the table cannot
// show one project's secrets under another's name while the fetch above is in
// flight.
watch(projectId, () => {
  envFile.value = { entries: [], ignored: true };
  seedEnvRows();
});

// ── WORKSPACE DRAFT ─────────────────────────────────────────────────────────
const wsDraft = ref({ name: '', color: '' });
const wsBase = ref({ name: '', color: '' });
const wsDirty = computed(() => changedFields(wsDraft.value, wsBase.value));

watch(
  workspace,
  (ws, prev) => {
    if (ws?.id !== prev?.id || wsDirty.value.length === 0) {
      wsBase.value = { name: ws?.name ?? '', color: ws?.color ?? '' };
      wsDraft.value = { ...wsBase.value };
    }
  },
  { immediate: true },
);

const members = computed<WorkspaceMember[]>(() =>
  // Keyed by WORKSPACE id and missing entirely before the first read — the `?? []`
  // is load-bearing (noUncheckedIndexedAccess is on).
  workspace.value ? projects.members[workspace.value.id] ?? [] : [],
);
const membersLoading = ref(false);
const memberEmail = ref('');
const memberBusy = ref(false);

watch(
  [() => section.value.key, workspace],
  async ([key, ws]) => {
    if (key !== 'workspace-members' || !ws) return;
    membersLoading.value = true;
    try {
      await projects.loadMembers(ws.id);
    } catch (e) {
      paneError.value = t('settings.members.loadError', { error: e instanceof Error ? e.message : String(e) });
    } finally {
      membersLoading.value = false;
    }
  },
  { immediate: true },
);

async function invite(): Promise<void> {
  const ws = workspace.value;
  const email = memberEmail.value.trim();
  if (!ws || !email) return;
  memberBusy.value = true;
  try {
    const invited = await projects.inviteMember(ws.id, email);
    memberEmail.value = '';
    // Name WHO the address resolved to: the roster lists github handles, so this
    // is the caller's confirmation that the invite landed on the person they meant.
    store.notify(t('settings.members.invited', { handle: invited.profile?.githubUsername ?? email, workspace: ws.name }));
  } catch (e) {
    store.notify(memberErrorText(e), 'error', 6000);
  } finally {
    memberBusy.value = false;
  }
}

async function removeMember(m: WorkspaceMember): Promise<void> {
  const ws = workspace.value;
  if (!ws) return;
  const who = m.profile?.githubUsername ?? m.userId;
  try {
    await projects.removeMember(ws.id, m.userId);
    // A DELETE the owner-only policy refuses does NOT error — it matches zero rows,
    // while the store has already dropped the row locally. Re-read so the roster
    // cannot show a removal that never happened.
    const after = await projects.loadMembers(ws.id);
    if (after.some((x) => x.userId === m.userId)) {
      store.notify(t('settings.members.removeRefused'), 'error', 6000);
      return;
    }
    store.notify(t('settings.members.removed', { handle: who }));
  } catch (e) {
    store.notify(memberErrorText(e), 'error', 6000);
  }
}

async function changeRole(m: WorkspaceMember, role: AssignableRole): Promise<void> {
  const ws = workspace.value;
  if (!ws || m.role === role) return;
  const who = m.profile?.githubUsername ?? m.userId;
  roleBusy.value = m.userId;
  try {
    // The rpc RAISES on refusal (unlike the silent zero-rows delete), and the store
    // updates the roster only on success — so a failure leaves the select showing the
    // old role with nothing to roll back.
    await projects.setMemberRole(ws.id, m.userId, role);
    store.notify(t('settings.members.roleChanged', { handle: who, role: ROLE_LABELS.value[role] }));
  } catch (e) {
    store.notify(memberErrorText(e), 'error', 6000);
  } finally {
    roleBusy.value = null;
  }
}

// ── DIRTY / SAVE ────────────────────────────────────────────────────────────
// App-scope controls apply on click and queue nothing, so the bar belongs to the
// two scopes that write to Supabase.
const dirtyCount = computed(() => {
  if (section.value.scope === 'project') return configDirty.value.length + (envDirty.value ? 1 : 0);
  if (section.value.scope === 'workspace') return wsDirty.value.length;
  return 0;
});

function discard(): void {
  paneError.value = null;
  if (section.value.scope === 'project') {
    seedProject();
    envRows.value = envBase.value.map((r) => ({ ...r }));
    return;
  }
  wsDraft.value = { ...wsBase.value };
}

async function saveProject(): Promise<void> {
  const id = projectId.value;
  const d = draft.value;
  if (!id || !d) return;
  const name = d.name.trim();
  if (!name) {
    paneError.value = t('settings.project.nameRequired');
    return;
  }
  // LOCAL VALUES FIRST, then cloud config — the same order the env modal used, and
  // the reason the catch below can say which half landed. The local write is the
  // one that cannot be refused for a permissions reason.
  if (envDirty.value && isBound.value) {
    const edits = envEdits(envRows.value, envFile.value.entries);
    if (Object.keys(edits.set).length || edits.remove.length) {
      envFile.value = await store.saveEnv(id, edits);
    }
  }
  const required = envRequiredKeys(envRows.value);
  const keysChanged = required.join('\n') !== (cloudRow.value?.envKeys ?? []).join('\n');
  // `workspaceId` is sent only when it CHANGED. Re-sending the current one would
  // pass WITH CHECK anyway, but it would make every unrelated config save depend
  // on the move policy — and it is what tells the catch which refusal to expect.
  const moved = !!d.workspaceId && d.workspaceId !== cloudRow.value?.workspaceId;
  if (isInCloud.value && (configDirty.value.length > 0 || keysChanged)) {
    // CLOUD first for config (design D1: it is the source of truth), and patch()
    // then mirrors the returned row into the local registry — so the offline cache
    // the launch path reads matches what the team sees. Empty strings become NULLs
    // in toProjectRow(), which is how a field gets cleared.
    await projects.patch(id, {
      name,
      color: d.color,
      gitRemoteUrl: d.gitRemoteUrl,
      defaultBranch: d.defaultBranch,
      defaultModel: d.defaultModel,
      defaultEffort: d.defaultEffort,
      conventions: d.conventions,
      previewCommand: d.previewCommand,
      apiCommand: d.apiCommand,
      // Never store an empty carry list: the launch path would copy nothing into
      // the worktree.
      carryFiles: d.carryFiles.length ? d.carryFiles : ['.env'],
      ...(keysChanged ? { envKeys: required } : {}),
      ...(moved ? { workspaceId: d.workspaceId } : {}),
    });
  }
  seedProject();
  seedEnvRows();
}

async function save(): Promise<void> {
  if (dirtyCount.value === 0 || saving.value) return;
  paneError.value = null;
  saving.value = true;
  const scope = section.value.scope;
  try {
    if (scope === 'project') {
      await saveProject();
    } else if (scope === 'workspace') {
      const ws = workspace.value;
      const name = wsDraft.value.name.trim();
      if (!ws) return;
      if (!name) {
        paneError.value = t('settings.workspace.nameRequired');
        return;
      }
      // patchWorkspace replaces the row in the store list and rewrites the tree
      // cache, so the sidebar picks the new name and colour up on its own.
      await projects.patchWorkspace(ws.id, { name, color: wsDraft.value.color });
      wsBase.value = { name, color: wsDraft.value.color };
      wsDraft.value = { ...wsBase.value };
    }
    store.notify(t('settings.save.saved'));
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    if (scope === 'workspace') {
      // workspaces_update_owner refuses a non-owner by matching zero rows, which
      // surfaces as NO_ROWS rather than as anything mentioning RLS. Reachable
      // despite the locked fields: ownership can change under an open pane.
      paneError.value = NO_ROWS.test(raw)
        ? t('settings.workspace.saveRefused')
        : raw;
    } else if (draft.value && draft.value.workspaceId !== cloudRow.value?.workspaceId && isMoveRefusal(raw)) {
      paneError.value = MOVE_REFUSAL;
      // The write was refused, so nothing moved; re-read so the tree cannot keep
      // showing a membership the server has already taken away. That refetch also
      // removes the destination from `workspaceOptions` while the draft still
      // holds its uuid — KSelect deliberately keeps a value it was never offered,
      // which here would put a bare uuid beside a Ukrainian refusal and let a
      // second Save re-attempt the same doomed move.
      await projects.load();
      if (draft.value) draft.value.workspaceId = cloudRow.value?.workspaceId ?? '';
    } else if (NO_ROWS.test(raw)) {
      paneError.value = envDirty.value
        ? t('settings.save.envSavedNotCloud')
        : t('settings.save.notMember');
    } else {
      paneError.value = raw;
    }
  } finally {
    saving.value = false;
  }
}

// ⌘S / Ctrl+S. On `window` because the bar is at the foot of the pane and the
// focus is wherever the operator was typing; `preventDefault` keeps the browser's
// own «save page» dialog out of an Electron window.
function onSaveKey(e: KeyboardEvent): void {
  if (e.key !== 's' || !(e.metaKey || e.ctrlKey)) return;
  if (dirtyCount.value === 0) return;
  e.preventDefault();
  void save();
}

onMounted(() => window.addEventListener('keydown', onSaveKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onSaveKey));

// Section and scope switches keep the drafts — they are the same page — so this
// only fires on the way OUT of Налаштування, where the drafts really are lost.
// A native confirm rather than a KModal: the router wants a synchronous verdict,
// and a promise-based dialog here would mean parking the navigation in state.
onBeforeRouteLeave(() => {
  if (dirtyCount.value === 0) return true;
  return window.confirm(t('settings.save.unsavedConfirm'));
});

// ── BINDING ─────────────────────────────────────────────────────────────────
const pickerOpen = ref(false);

// The three refusals PUT /api/projects/:id/binding actually returns — the first
// two from bindProject, the third from registry.patchProject when this machine has
// no row for the project at all. Anything else shows verbatim: the api's own
// message beats a guess.
const BIND_ERRORS = computed<Record<string, string>>(() => ({
  'local repo path cannot be empty': t('settings.binding.emptyPath'),
  'local repo path is not a git repo': t('settings.binding.notGitRepo'),
  'project not found': t('settings.binding.projectNotFound'),
}));

async function bindTo(path: string): Promise<void> {
  const id = projectId.value;
  if (!id) return;
  try {
    const bound = await store.setProjectBinding(id, path);
    // project_update streams back over the socket, so the path above and the
    // sidebar tile refresh themselves.
    store.notify(t('settings.binding.bound', { path: bound.localRepoPath }));
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    store.notify(BIND_ERRORS.value[raw] ?? raw, 'error', 6000);
  }
}

// ── DANGER ──────────────────────────────────────────────────────────────────
const deleteProjectOpen = ref(false);
const deleteWorkspaceOpen = ref(false);
const deleteError = ref<string | null>(null);
const deleteBusy = ref(false);

async function confirmDeleteProject(): Promise<void> {
  const id = projectId.value;
  if (!id) return;
  deleteError.value = null;
  deleteBusy.value = true;
  try {
    await projects.remove(id);
    deleteProjectOpen.value = false;
    // The prune emits project_removed over the socket, which clears the selection;
    // this pane then falls back to its «виберіть проєкт» state on its own.
    store.notify(t('settings.deleteProject.done'));
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    if (raw.startsWith('cloud delete unconfirmed')) {
      // The delete itself did not error; only the confirming re-read did. Do not
      // accuse the user of a refusal for something that most likely landed.
      deleteError.value = t('settings.deleteProject.unconfirmed');
    } else if (raw.startsWith('cloud refused the delete')) {
      deleteError.value = t('settings.deleteProject.refused');
    } else {
      deleteError.value = raw;
    }
  } finally {
    deleteBusy.value = false;
  }
}

async function confirmDeleteWorkspace(): Promise<void> {
  const ws = workspace.value;
  if (!ws) return;
  deleteError.value = null;
  deleteBusy.value = true;
  try {
    // removeWorkspace confirms the delete with a re-read and clears the scope when
    // it was this group's, so nothing here navigates.
    await projects.removeWorkspace(ws.id);
    deleteWorkspaceOpen.value = false;
    store.notify(t('settings.deleteWorkspace.done', { name: ws.name }));
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // The pre-check above and `workspaceHasProjects` both read the last cloud list
    // THIS session read, so a project a teammate added since then is invisible to
    // both: the button renders enabled and the `on delete restrict` FK is what
    // says no — in English. The database is the authority; translate it.
    deleteError.value = raw.includes('violates foreign key constraint')
      ? t('settings.deleteWorkspace.hasProjects')
      : raw;
  } finally {
    deleteBusy.value = false;
  }
}

// ── APP SCOPE ───────────────────────────────────────────────────────────────
const THEMES = computed<readonly { value: KTheme; label: string }[]>(() => [
  { value: 'dark', label: t('settings.app.themeDark') },
  { value: 'light', label: t('settings.app.themeLight') },
]);

function pickTheme(next: KTheme, e: MouseEvent): void {
  if (theme.value === next) return;
  // The rect — not `event.clientX` — because keyboard activation reports a pointer
  // at (0, 0), which would start the wipe in the far corner instead of under the
  // control.
  const el = e.currentTarget;
  toggleTheme(el instanceof HTMLElement ? el.getBoundingClientRect() : null);
}

// Every binding the app actually listens to, and the file that owns it. A
// read-only sheet is the honest shape: none of these is stored anywhere, so there
// is nothing a remap could write to.
const KEYMAP: readonly { act: string; keys: string; where: string }[] = [
  { act: 'settings.keymap.acts.sendMsg', keys: '⏎', where: 'settings.keymap.where.composer' },
  { act: 'settings.keymap.acts.newLine', keys: '⇧⏎', where: 'settings.keymap.where.composer' },
  { act: 'settings.keymap.acts.runTask', keys: '⌘⏎', where: 'settings.keymap.where.agentLauncher' },
  { act: 'settings.keymap.acts.prevNextMsg', keys: '⌥↑ ⌥↓', where: 'settings.keymap.where.sessionLog' },
  { act: 'settings.keymap.acts.resizePane', keys: '← →', where: 'settings.keymap.where.divider' },
  { act: 'settings.keymap.acts.switchNav', keys: '← → ⇱ ⇲', where: 'settings.keymap.where.navBars' },
  { act: 'settings.keymap.acts.openRow', keys: '⏎', where: 'settings.keymap.where.tables' },
  { act: 'settings.keymap.acts.saveSettings', keys: '⌘S', where: 'settings.keymap.where.thisScreen' },
  { act: 'settings.keymap.acts.closeWindow', keys: '⎋', where: 'settings.keymap.where.everywhere' },
];

const accountName = computed(() => {
  const p = auth.profile;
  const handle = p?.githubUsername;
  return handle ? `@${handle}` : (p?.displayName ?? auth.user?.id.slice(0, 8) ?? '');
});

const planUsage = useSubscriptionUsage();
const planNow = useNow(30_000);

const planLines = computed(() =>
  (planUsage.value?.providers ?? []).map((p) => ({
    provider:
      p.provider[0]!.toUpperCase() +
      p.provider.slice(1) +
      (p.accounts > 1 ? t('settings.plan.accountsAvg', { count: p.accounts }) : ''),
    windows: p.windows.map((w) => ({
      id: w.id,
      label: `${w.label} (${planWindow(w.id)})`,
      percent: percent(w.usedPercent),
      resets: w.resetsAt ? t('settings.plan.resetsIn', { time: until(w.resetsAt, planNow.value) }) : '',
    })),
  })),
);

// How many status pushes THIS machine still owes the cloud. Only the local process
// can see that, so it is a fetch rather than a store field. `null` means the local
// api did not answer, which is a different statement from «нічого не чекає».
const outbox = ref<number | null>(null);

watch(
  () => section.value.key,
  async (key) => {
    if (key !== 'app-account') return;
    try {
      outbox.value = (await api.cloudOutbox()).pending;
    } catch {
      outbox.value = null;
    }
  },
  { immediate: true },
);

const signOutOpen = ref(false);
const signOutBusy = ref(false);

async function confirmSignOut(): Promise<void> {
  signOutBusy.value = true;
  try {
    // signOut() ends the Supabase session and, through apply(null), drops the local
    // api's token; the router's watcher on `auth.user` performs the navigation to
    // /login. It only rejects on an unexpected fault (the sign-out's own network
    // failure is swallowed by supabase-js), and then the modal must stay open.
    await auth.signOut();
    signOutOpen.value = false;
  } catch (e) {
    store.notify(t('settings.account.signOutError', { error: e instanceof Error ? e.message : String(e) }), 'error');
  } finally {
    signOutBusy.value = false;
  }
}

// ── RAIL FURNITURE ──────────────────────────────────────────────────────────
const scopeHint = computed(() => {
  if (section.value.scope === 'project') {
    return projectName.value ? t('settings.rail.projectScope', { name: projectName.value }) : t('settings.rail.noProject');
  }
  if (section.value.scope === 'workspace') {
    return workspaceName.value
      ? t('settings.rail.workspaceScope', { name: workspaceName.value })
      : t('settings.rail.noWorkspace');
  }
  return t('settings.rail.appScope');
});

// Counts the rail can state without lying. Env is the file as LOADED, so it stays
// absent until the section has been opened — a zero there would read as «no
// variables» rather than «not read yet».
const badges = computed<Record<string, number | undefined>>(() => ({
  'workspace-members': members.value.length || undefined,
  'project-env': envRows.value.length || undefined,
}));
</script>

<style scoped lang="scss">
.set {
  display: flex;
  gap: var(--k-sp-3);
  height: calc(100vh - 82px);
  min-height: 0;
  padding: var(--k-sp-4);
  background: var(--k-canvas);
  overflow: hidden;
}

// ── RAIL ────────────────────────────────────────────────────────────────────
.set__rail {
  flex: none;
  // 280 rather than the 264 the sidebar uses: three Ukrainian scope words need
  // it, even on a dense strip, and a switcher that clips its last segment hides
  // a whole scope.
  width: 280px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--k-bg);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-lg);
  overflow: hidden;
}

.set__rail-head {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-3);
  border-bottom: var(--k-rule-thin) solid var(--k-line);
}

.set__hint {
  margin: 0;
  font-size: var(--k-fs-sm);
  line-height: 1.45;
  color: var(--k-faint);
}

.set__cats {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--k-sp-2);
}

// Two lines per row: the category and what is inside it. The sub-line is what
// makes the rail navigable without opening every pane — «Гілки й конвенції» alone
// does not say whether the preview command is in there.
.set__cat {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  width: 100%;
  padding: var(--k-sp-2) 10px;
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: var(--k-r);
  cursor: pointer;
  transition: background 0.12s;

  &:hover {
    background: color-mix(in srgb, var(--k-surface2) 60%, transparent);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

.set__cat--on {
  background: var(--k-surface2);
}

.set__cat-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.set__cat-label {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-medium);
  color: var(--k-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  .set__cat--on & {
    font-weight: var(--k-fw-semibold);
    color: var(--k-text);
  }

  .set__cat--danger & {
    color: var(--k-accent);
  }
}

.set__cat-sub {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// ── PANE ────────────────────────────────────────────────────────────────────
.set__pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--k-bg);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-lg);
  overflow: hidden;
}

.set__head {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: var(--k-sp-3);
  padding: var(--k-sp-4) var(--k-sp-6) var(--k-sp-3);
  border-bottom: var(--k-rule-thin) solid var(--k-line);
}

.set__head-text {
  flex: 1;
  min-width: 0;
}

.set__title {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-lg);
  font-weight: var(--k-fw-semibold);
  letter-spacing: -0.01em;
  color: var(--k-text);
}

.set__blurb {
  margin: 4px 0 0;
  font-size: var(--k-fs-base);
  line-height: 1.5;
  color: var(--k-faint);
}

.set__saved {
  flex: none;
  font-size: var(--k-fs-sm);
  color: var(--k-faint);
  background: color-mix(in srgb, var(--k-surface2) 55%, transparent);
  border-radius: var(--k-r-pill);
  padding: 4px 11px;
  white-space: nowrap;
}

// Unsaved work is a WARNING, not an error: nothing is broken, something is
// pending. Same colour the agent board uses for «waiting on you».
.set__saved--dirty {
  color: var(--k-warning);
}

.set__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--k-sp-6);
}

// One measure for every form on this screen. Wider for the two sections that are
// tables (env, members) — a key/value grid squeezed into a reading measure wraps
// its values.
.set__form {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-5);
  max-width: 620px;
}

.set__form--wide {
  max-width: 860px;
}

.set__group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

// Matches KField's own label, so a hand-built group and a kit control read as one
// column of fields.
.set__label {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  color: var(--k-text);
}

.set__note {
  margin: 0;
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-faint);
}

.set__error {
  margin: 0;
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-accent);
}

.set__rule {
  height: var(--k-rule-thin);
  background: var(--k-line);
}

.set__row {
  display: flex;
  align-items: flex-end;
  gap: var(--k-sp-2);
}

.set__grow {
  flex: 1;
  min-width: 0;
}

// A locked KColorPicker: it has no `disabled` prop, and this greys it out and
// takes its clicks the same way a disabled KField reads (hence the matching
// opacity).
.set__locked {
  opacity: 0.45;
  pointer-events: none;
}

.set__path {
  flex: 1;
  min-width: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
  background: var(--k-surface);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r);
  padding: 9px 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.set__path--empty {
  color: var(--k-faint);
  border-style: dashed;
}

// ── CARRY-FILE CHIPS ────────────────────────────────────────────────────────
.set__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  background: var(--k-surface);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r);
  padding: 8px 9px;

  &:focus-within {
    border-color: var(--k-accent);
  }
}

.set__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: var(--k-surface2);
  border-radius: var(--k-r-sm);
  padding: 4px 8px;
}

.set__chip-x {
  background: transparent;
  border: 0;
  padding: 0;
  font-size: var(--k-fs-xs);
  line-height: 1;
  color: var(--k-faint);
  cursor: pointer;

  &:hover:not(:disabled) {
    color: var(--k-accent);
  }

  &:disabled {
    cursor: not-allowed;
  }
}

.set__chip-input {
  flex: 1;
  min-width: 130px;
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: transparent;
  border: 0;
  padding: 4px 2px;

  &::placeholder {
    color: var(--k-faint);
  }
}

// ── TABLES (members, keymap) ────────────────────────────────────────────────
.set__table {
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r);
  overflow: hidden;
}

.set__member,
.set__keyrow {
  display: flex;
  align-items: center;
  gap: var(--k-sp-3);
  padding: 10px var(--k-sp-3);

  & + & {
    border-top: var(--k-rule-thin) solid var(--k-line);
  }
}

// The role picker sits where the «власник/учасник» tag used to — kept narrow so the
// member name keeps the row's stretch, not the control.
.set__role {
  flex: none;
  width: 140px;
}

.set__avatar {
  flex: none;
  width: 22px;
  height: 22px;
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-sm);
  object-fit: cover;
}

.set__avatar--lg {
  width: 34px;
  height: 34px;
}

.set__avatar--blank {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
  background: var(--k-surface);
}

.set__member-name {
  flex: 1;
  min-width: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.set__keyrow-act {
  flex: 1;
  min-width: 0;
  font-size: var(--k-fs-base);
  color: var(--k-text);
}

.set__keyrow-where {
  flex: none;
  width: 150px;
  text-align: right;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.set__empty {
  padding: var(--k-sp-3);
  font-size: var(--k-fs-sm);
  color: var(--k-faint);
}

// ── ACCOUNT ─────────────────────────────────────────────────────────────────
.set__account {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.set__account-name {
  font-size: var(--k-fs-md);
  color: var(--k-text);
}

.set__plan {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--k-sp-2) var(--k-sp-3);
  padding: var(--k-sp-2) 0;
}

.set__plan-prov {
  font-size: var(--k-fs-base);
  color: var(--k-text);
}

.set__plan-win {
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

// ── SEGMENTED (theme) ───────────────────────────────────────────────────────
.set__seg {
  display: flex;
  gap: 2px;
  width: max-content;
  padding: 3px;
  background: var(--k-surface);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r);
}

.set__seg-btn {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-medium);
  color: var(--k-muted);
  background: transparent;
  border: 0;
  border-radius: var(--k-r-sm);
  padding: 6px 14px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;

  &:hover {
    color: var(--k-text);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

.set__seg-btn--on {
  color: var(--k-text);
  background: var(--k-surface2);
  font-weight: var(--k-fw-semibold);
}

// ── DANGER ROWS ─────────────────────────────────────────────────────────────
.set__danger {
  display: flex;
  align-items: center;
  gap: var(--k-sp-4);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r);
  padding: var(--k-sp-3) var(--k-sp-4);
}

.set__danger-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.set__danger-title {
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-medium);
  color: var(--k-text);
}

// The accent frame is the warning. A filled accent button here would compete with
// the save bar's primary, which is the one action on this screen that is safe.
.set__danger-btn {
  flex: none;
  color: var(--k-accent);
  border: var(--k-rule-thin) solid color-mix(in srgb, var(--k-accent) 45%, transparent);
}

// ── SAVE BAR ────────────────────────────────────────────────────────────────
.set__bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--k-sp-3);
  padding: 10px var(--k-sp-6);
  background: var(--k-surface);
  border-top: var(--k-rule-strong) solid var(--k-line-strong);
}

.set__bar-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: var(--k-r-pill);
  background: var(--k-warning);
}

.set__bar-text {
  flex: 1;
  min-width: 0;
  font-size: var(--k-fs-base);
  color: var(--k-text);
}

// ── BLANK STATE ─────────────────────────────────────────────────────────────
.set__blank {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--k-sp-3);
  height: 100%;
  color: var(--k-faint);
  font-size: var(--k-fs-base);
}

.set__blank-eyebrow {
  font-size: 10px;
  letter-spacing: 0.22em;
  color: var(--k-faint);
}

.set__modal {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}
</style>
