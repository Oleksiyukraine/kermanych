<template>
  <q-layout view="hHh Lpr fFf" class="shell">
    <!-- LEFT SIDEBAR — bucket nav + projects + folder binding + account (v3 section 07) -->
    <q-drawer model-value side="left" :width="collapsed ? 76 : 264" :breakpoint="0" class="shell__sidebar">
      <div class="shell__side-inner" :class="{ 'shell--min': collapsed }">
        <nav class="shell__buckets">
          <KNavItem
            v-for="b in buckets"
            :key="b.key"
            :label="b.label"
            :icon="b.icon"
            :count="bucketCounts[b.key]"
            :active="store.selectedBucket === b.key"
            @click="onBucket(b.key)"
          />
        </nav>
        <div class="shell__divider"></div>
        <div class="shell__side-label shell__side-label--row">
          <span>Воркспейси</span>
          <button
            class="shell__label-add"
            v-tip="'Новий воркспейс'"
            aria-label="Новий воркспейс"
            @click="openCreateWorkspace"
          >+</button>
        </div>
        <!-- The tree. Real nested lists rather than a flat run of rows plus role="tree":
             a tree role promises arrow-key navigation this sidebar does not implement,
             while a <ul> inside a <li> states the one fact a screen reader is missing —
             that these projects BELONG to the workspace announced just before them.
             The inner list is named after its workspace, because a bare «list, 3 items»
             does not say whose. KWorkspaceRow's chevron cannot carry aria-controls
             (fallthrough attributes land on the row's root element, not on the button),
             so the containment is what supplies the relationship. -->
        <ul class="shell__projects">
          <li v-for="group in tree" :key="group.workspace.id" class="shell__group">
            <KWorkspaceRow
              :workspace="group.workspace"
              :active="store.selectedWorkspaceId === group.workspace.id && !store.selectedProjectId"
              :expanded="isExpanded(group.workspace.id)"
              :count="workspaceRunningCount(group.workspace.id)"
              @select="selectWorkspace(group.workspace.id)"
              @toggle="toggleWorkspace(group.workspace.id)"
              @add-project="openCreateProject(group.workspace.id)"
            />
            <ul
              v-if="isExpanded(group.workspace.id)"
              class="shell__group-items"
              :aria-label="`Проєкти воркспейсу «${group.workspace.name}»`"
            >
              <li v-for="p in sidebarProjects.byWorkspace.get(group.workspace.id) ?? []" :key="p.id">
                <KRailItem
                  :project="p"
                  indent
                  :active="p.id === store.selectedProjectId"
                  :count="runningCount(p.id)"
                  @click="selectProject(p.id)"
                />
              </li>
            </ul>
          </li>
          <li v-if="sidebarProjects.ungrouped.length" class="shell__group">
            <div id="shell-local-only" class="shell__side-label shell__side-label--sub">
              <span>{{ localOnlyLabel }}</span>
            </div>
            <ul class="shell__group-items" aria-labelledby="shell-local-only">
              <li v-for="p in sidebarProjects.ungrouped" :key="p.id">
                <KRailItem
                  :project="p"
                  indent
                  :active="p.id === store.selectedProjectId"
                  :count="runningCount(p.id)"
                  @click="selectProject(p.id)"
                />
              </li>
            </ul>
          </li>
        </ul>
        <div class="shell__user">
          <KUserButton
            class="shell__account"
            :label="accountLabel"
            :avatar-url="auth.profile?.avatarUrl"
            :title="accountHint"
            @click="accountOpen = true"
          />
          <!-- Name and plan spend stack, so the name rides up and the windows sit under it.
               One row per authenticated provider (in practice one), each window a percent of
               its rolling quota — the only unit providers meter plans in. -->
          <div class="shell__account-meta">
            <span class="shell__account-name">{{ accountName }}</span>
            <div
              v-for="p in planLines"
              :key="p.provider"
              v-tip="p.hint"
              class="shell__account-plan mono"
            >
              <span v-if="planLines.length > 1" class="shell__plan-provider">{{ p.provider }}</span>
              <span
                v-for="w in p.windows"
                :key="w.id"
                class="shell__plan-window"
                :class="{
                  'shell__plan-window--warn': w.used >= 80 && w.used < 95,
                  'shell__plan-window--hot': w.used >= 95,
                }"
              >{{ w.short }} {{ w.percent }}</span>
            </div>
          </div>
          <button
            class="shell__toggle"
            v-tip="collapsed ? 'Розгорнути панель' : 'Згорнути панель'"
            :aria-label="collapsed ? 'Розгорнути панель' : 'Згорнути панель'"
            @click="collapsed = !collapsed"
          >{{ collapsed ? '»' : '«' }}</button>
        </div>
      </div>
    </q-drawer>

    <!-- TOP BAR — brand + segmented view nav + project actions (v3) -->
    <q-header class="shell__header">
      <div class="shell__brand">
        <svg class="shell__mark" viewBox="0 0 1024 1024" aria-hidden="true">
          <rect width="1024" height="1024" rx="200" fill="#12110f" />
          <path d="M244 214 L344 214 L642 512 L344 810 L244 810 L244 730 L462 512 L244 294 Z" fill="#ff563c" />
          <rect x="636" y="726" width="300" height="84" fill="#f3f2f2" />
        </svg>
        <span class="shell__logo">КЕРМАНИЧ</span>
        <span class="shell__ver mono">v0.1</span>
      </div>
      <KTopNav
        class="shell__nav"
        :model-value="topView"
        :options="topOptions"
        @update:model-value="goView"
      />
      <div class="shell__actions">
        <!-- CURRENT WORKSPACE, and the way into its settings. A named chip rather than a
             second ⚙ beside the project's: two identical gears in one cluster name
             neither, and this one also supplies what the header never said — which group
             the screen is scoped to. The sidebar's workspace row takes no fourth control
             by design, so this is where the group's own settings live.

             The chip's one cost over the brief's icon gear is the accessible name, which
             `workspaceChipLabel` pays explicitly — see its comment. -->
        <KBtn
          v-if="scopedWorkspace"
          variant="ghost"
          :title="workspaceChipLabel"
          :aria-label="workspaceChipLabel"
          @click="openWorkspaceSettings(scopedWorkspace.id)"
        >
          <span class="shell__ws-name">{{ scopedWorkspace.name }}</span>
        </KBtn>
        <template v-if="store.selectedProjectId">
        <KBtn
          variant="icon"
          :disabled="!isBound"
          :title="isBound ? 'Змінні середовища (.env)' : BIND_HINT"
          @click="openEnv"
        >$</KBtn>
        <KBtn
          variant="icon"
          class="shell__settings"
          title="Редагувати проєкт"
          @click="openSettings"
        >⚙</KBtn>
        </template>
        <!-- Theme toggle. Outside the project-scoped block above — the theme is a
             property of this screen, not of a project — and last in the cluster, so
             it keeps its place against the right edge when $ and ⚙ come and go. The
             glyph names the theme the click moves TO, like the sidebar's «/». -->
        <KBtn
          variant="icon"
          :title="theme === 'light' ? 'Темна тема' : 'Світла тема'"
          @click="onThemeToggle"
        >{{ theme === 'light' ? '☾' : '☀' }}</KBtn>
      </div>
    </q-header>

    <!-- PAGE -->
    <q-page-container>
      <router-view />
    </q-page-container>

    <!-- STATUS BAR — a VS Code-style footer; for now just git sync for the selected repo. -->
    <q-footer class="shell__footer">
      <button
        type="button"
        class="shell__foot-btn"
        :disabled="!isBound || syncing"
        v-tip="isBound ? 'git pull (--ff-only) поточної гілки репозиторію проєкту' : BIND_HINT"
        aria-label="Pull"
        @click="gitSync('pull')"
      >↓ Pull</button>
      <button
        type="button"
        class="shell__foot-btn"
        :disabled="!isBound || syncing"
        v-tip="isBound ? 'git push поточної гілки' : BIND_HINT"
        aria-label="Push"
        @click="gitSync('push')"
      >↑ Push</button>
      <span class="shell__foot-spacer"></span>
      <button
        v-if="store.selectedProjectId"
        type="button"
        class="shell__foot-btn shell__foot-folder"
        v-tip="isBound ? contextLabel : BIND_HINT"
        :aria-label="isBound ? 'Змінити теку' : 'Прив’язати теку'"
        @click="openBinding"
      >
        <span class="shell__foot-folder-path mono">{{ contextLabel }}</span>
      </button>
    </q-footer>


    <!-- CREATE-WORKSPACE MODAL — the sidebar's two «+» buttons create different things, so
         they get two modals. A workspace is the group AND the team: membership hangs off it,
         which is what the hint below says out loud. -->
    <KModal v-model="createWorkspaceOpen" title="Новий воркспейс">
      <div class="shell__form">
        <KField v-model="createWorkspaceName" label="Назва" placeholder="AAA" />
        <p class="shell__hint">
          Воркспейс групує проєкти й тримає склад команди: одне запрошення відкриває
          доступ до всіх його проєктів.
        </p>
        <p v-if="createError" class="shell__error" role="alert">{{ createError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="createWorkspaceOpen = false">Скасувати</KBtn>
        <KBtn
          variant="primary"
          :disabled="!canCreateWorkspace || createBusy"
          @click="submitCreateWorkspace"
        >
          {{ createBusy ? 'Створюємо…' : 'Створити' }}
        </KBtn>
      </template>
    </KModal>

    <!-- WORKSPACE-SETTINGS MODAL — the group's name, its colour and its TEAM. Membership
         lives here and not on the project because one invitation now opens EVERY project
         in the group; that is also why inviting and removing are owner-only while the
         project config below is open to any member (the approved role matrix). A plain
         member therefore gets the roster read-only rather than a button the rpc refuses.

         Every affordance here is decided by `workspaces.owner_id`, never by
         `workspace_members.role` — see isWorkspaceOwnerSeat() for why that column cannot
         be trusted to decide anything. -->
    <KModal v-model="workspaceSettingsOpen" :title="`Воркспейс · ${workspaceSettingsName}`">
      <div class="shell__form">
        <KField
          v-model="wsNameEdit"
          label="Назва воркспейсу"
          placeholder="AAA"
          :disabled="!isOwnerOfWorkspace"
        />
        <KColorPicker
          v-model="wsColorEdit"
          label="Колір воркспейсу"
          :class="{ 'shell__readonly': !isOwnerOfWorkspace }"
        />
        <div class="shell__members">
          <span class="shell__members-label">Учасники</span>
          <div v-if="membersLoading" class="shell__hint mono">Завантаження…</div>
          <div v-for="m in workspaceMembers" :key="m.userId" class="shell__member">
            <img
              v-if="m.profile?.avatarUrl"
              class="shell__member-avatar"
              :src="m.profile.avatarUrl"
              :alt="m.profile.githubUsername ?? ''"
            />
            <span v-else class="shell__member-avatar shell__member-avatar--blank mono">?</span>
            <span class="shell__member-name mono">
              @{{ m.profile?.githubUsername ?? m.profile?.displayName ?? m.userId.slice(0, 8) }}
            </span>
            <KTag>{{ isWorkspaceOwnerSeat(m.userId) ? 'власник' : 'учасник' }}</KTag>
            <KBtn
              v-if="isOwnerOfWorkspace && !isWorkspaceOwnerSeat(m.userId)"
              variant="ghost"
              title="Вилучити з воркспейсу"
              @click="removeMemberOf(m)"
            >✕</KBtn>
          </div>
          <template v-if="isOwnerOfWorkspace">
            <div class="shell__member-add">
              <KField
                v-model="memberEmail"
                label="Запросити за імейлом"
                placeholder="colleague@example.com"
                type="email"
              />
              <KBtn
                variant="secondary"
                :disabled="memberEmail.trim() === '' || memberBusy"
                @click="submitMember"
              >{{ memberBusy ? 'Запрошуємо…' : 'Запросити' }}</KBtn>
            </div>
            <p class="shell__hint">
              Запрошуємо за адресою, якою колега входить у Керманич. Він одразу бачить усі
              проєкти цього воркспейсу — окремо запрошувати в кожен не потрібно.
            </p>
          </template>
          <p v-else class="shell__hint">
            Склад воркспейсу змінює його власник. Одне запрошення відкриває доступ до всіх
            проєктів воркспейсу, тому воно й належить власнику.
          </p>
        </div>
        <!-- Why the refusal is VISIBLE text and not the delete button's tooltip: a
             disabled <button> dispatches no mouseenter and takes no focus, so v-tip on it
             never shows — the reason has to live where it can be read. -->
        <p v-if="isOwnerOfWorkspace && workspaceHasProjects" class="shell__hint">
          Видалити воркспейс можна лише порожнім: спершу перенесіть або видаліть його
          проєкти.
        </p>
        <p v-if="wsError" class="shell__error" role="alert">{{ wsError }}</p>
      </div>
      <template #controls>
        <KBtn
          v-if="isOwnerOfWorkspace"
          variant="ghost"
          class="shell__danger"
          :disabled="workspaceHasProjects"
          title="Видалити воркспейс — назавжди й для всієї команди"
          @click="deleteWorkspace"
        >Видалити воркспейс</KBtn>
        <KBtn variant="ghost" @click="workspaceSettingsOpen = false">Скасувати</KBtn>
        <KBtn
          variant="primary"
          :disabled="!isOwnerOfWorkspace"
          @click="saveWorkspace"
        >Зберегти</KBtn>
      </template>
    </KModal>

    <!-- CREATE-PROJECT MODAL — a project is born in the CLOUD (Requirement 2: any signed-in
         user may create one and becomes its owner) INSIDE a known workspace, which is why the
         open state is that workspace's id rather than a boolean. The local row arrives through
         POST /api/projects/sync and starts out UNBOUND — no directory picker here. -->
    <KModal
      :model-value="createProjectFor !== undefined"
      :title="`Новий проєкт у «${projects.workspaceById.get(createProjectFor ?? '')?.name ?? ''}»`"
      @update:model-value="createProjectFor = undefined"
    >
      <div class="shell__form">
        <KField v-model="createName" label="Назва" placeholder="my-project" />
        <KField
          v-model="createRemote"
          label="Git remote (необовʼязково, лише довідково)"
          placeholder="git@github.com:org/repo.git"
        />
        <p class="shell__hint">
          Проєкт створюється у хмарі й одразу видимий команді. Керманич нічого не клонує —
          локальну теку цієї машини приєднаєте окремо.
        </p>
        <p v-if="createError" class="shell__error" role="alert">{{ createError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="createProjectFor = undefined">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="!canCreate || createBusy" @click="submitCreate">
          {{ createBusy ? 'Створюємо…' : 'Створити' }}
        </KBtn>
      </template>
    </KModal>

    <!-- PROJECT-SETTINGS MODAL — CLOUD config (name, colour, conventions, commands, carry
         files) plus this machine's read-only binding. Config writes go to Supabase and are
         mirrored into the local row, and ANY workspace member may make them: per the role
         matrix config is shared work, not administration, and projects_update_member is
         what allows it. Exactly one control here stays owner-only — «Видалити проєкт».
         Membership is no longer on this modal; it moved up to the workspace. -->
    <KModal v-model="settingsOpen" :title="`Редагувати проєкт · ${selectedName}`">
      <div class="shell__form">
        <KField v-model="nameEdit" label="Назва проєкту" placeholder="my-project" />
        <KColorPicker v-model="colorEdit" label="Колір проєкту" />
        <KSelect
          v-model="defaultBranchEdit"
          label="Гілка за замовчуванням"
          :options="settingsBranches"
          :disabled="!isBound"
          placeholder="— поточна гілка репозиторію —"
        />
        <KField
          v-model="conventionsEdit"
          label="Конвенції PR/комітів (фолбек, якщо в репо немає)"
          placeholder="Порожнє — Керманич підставить власні дефолти"
          multiline
          :rows="6"
        />
        <KField
          v-model="previewCommandEdit"
          label="Команда превʼю (веб)"
          placeholder="pnpm dev --port $PORT"
        />
        <KField
          v-model="apiCommandEdit"
          label="Команда превʼю (API, необовʼязково)"
          placeholder="pnpm dev:api"
        />
        <KField
          v-model="carryFilesText"
          label="Файли для сесії (через кому)"
          placeholder=".env"
        />
        <KField
          :model-value="selectedProject?.localRepoPath || 'не прив’язано'"
          label="Локальна тека цієї машини"
          disabled
        />
        <!-- CLOUD config needs a cloud row, and a «поза хмарою» local one has none. Save
             used to be inert for such a project BY ACCIDENT, through the owner gate that
             is now gone (see `isInCloud`), so the state gets its own gate and its own way
             out. The binding above and the `.env` VALUES stay available: those are this
             machine's business, and they always worked for an unpublished project. -->
        <p v-if="!isInCloud" class="shell__hint">
          Цей проєкт існує лише на цій машині, тому спільні налаштування нікуди зберігати.
          Опублікуйте його в хмарі на дошці — прив’язка теки й «Змінні середовища»
          доступні й без цього.
        </p>
        <p v-if="settingsError" class="shell__error" role="alert">{{ settingsError }}</p>
      </div>
      <template #controls>
        <KBtn
          v-if="isOwnerOfSelected"
          variant="ghost"
          class="shell__danger"
          @click="openDelete"
        >Видалити проєкт</KBtn>
        <KBtn variant="ghost" @click="settingsOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="!isInCloud" @click="saveSettings">Зберегти</KBtn>
      </template>
    </KModal>

    <!-- DELETE-PROJECT MODAL — owner only. The project dies in the CLOUD; each machine's local
         row follows through the next sync's prune, except where it still owns sessions. -->
    <KModal v-model="deleteOpen" :title="`Видалити проєкт · ${selectedName}`">
      <div class="shell__form">
        <p class="shell__error" role="alert">
          Проєкт «{{ selectedName }}» буде видалено у хмарі для ВСІХ учасників, разом з усіма
          його задачами на дошці. Це не відкотити.
        </p>
        <p class="shell__hint">
          Локальні сесії й робочі дерева на цій машині нікуди не зникнуть: якщо в проєкта є
          сесії, його локальний рядок залишиться як «поза хмарою», і агентів можна довести до
          кінця. Порожній локальний рядок буде прибрано синхронізацією.
        </p>
        <p v-if="deleteError" class="shell__error" role="alert">{{ deleteError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="deleteOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="deleteBusy" @click="confirmDelete">Видалити</KBtn>
      </template>
    </KModal>

    <!-- ENV MODAL — the BOUND repo's .env. VALUES never leave this machine (Requirement 9);
         the cloud carries the required key NAMES only, as the checklist below. -->
    <KModal v-model="envOpen" :title="`Змінні середовища · ${selectedName}`">
      <div class="shell__form">
        <KEnvEditor
          ref="envEditor"
          :entries="envView.entries"
          :ignored="envView.ignored"
        />
        <div v-if="envKeyState.length" class="shell__keys">
          <span class="shell__keys-label">Обовʼязкові ключі (перелік імен із хмари)</span>
          <div class="shell__keys-list">
            <KTag v-for="k in envKeyState" :key="k.key">
              {{ k.present ? '✓' : '✕' }} {{ k.key }}
            </KTag>
          </div>
          <p v-if="missingEnvKeys.length" class="shell__error" role="alert">
            Немає значень для: {{ missingEnvKeys.join(', ') }}
          </p>
        </div>
        <KField
          v-if="isInCloud"
          v-model="envKeysText"
          label="Обовʼязкові ключі — лише ІМЕНА (через кому або з нового рядка)"
          placeholder="GITHUB_TOKEN, DATABASE_URL"
          multiline
          :rows="3"
        />
        <!-- No cloud row, no list of names to keep in it. The VALUES editor above is
             untouched: it writes this machine's file and never needed the cloud. -->
        <p v-else class="shell__hint">
          Перелік обовʼязкових ключів живе у хмарі, а цей проєкт існує лише на цій машині.
        </p>
        <p class="shell__hint">
          Значення живуть у `.env` цієї машини й нікуди не передаються: у хмарі Керманич
          тримає лише ІМЕНА ключів.
        </p>
        <p v-if="envError" class="shell__error" role="alert">{{ envError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="envOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" @click="saveEnv">Зберегти</KBtn>
      </template>
    </KModal>

    <!-- DIRECTORY PICKER — server-side browser (GET /api/fs/list, still the LOCAL api). Its
         choice becomes THIS machine's binding for the selected project. -->
    <KDirPicker
      v-model="pickerOpen"
      :start="selectedProject?.localRepoPath ?? ''"
      @select="bindTo"
    />

    <!-- ACCOUNT MODAL — the app's only sign-out. auth.signOut() ends the Supabase session
         and clears the local api's token; the router's watcher on `auth.user` then replaces
         the route with /login, so nothing here navigates. -->
    <KModal v-model="accountOpen" title="Вийти з акаунта?">
      <div class="shell__form">
        <p class="shell__hint">
          Ви увійшли як <span class="mono">{{ accountName }}</span>. Вихід закриє сеанс на цій
          машині й поверне вас на екран входу.
        </p>
        <p class="shell__hint">
          Агенти, що вже працюють, і їхні робочі дерева не зупиняються. Статуси, які не
          встигли піти в хмару, чекають у черзі й відправляться після наступного входу.
        </p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="accountOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="accountBusy" @click="confirmSignOut">Вийти</KBtn>
      </template>
    </KModal>

    <!-- TOAST STACK — transient notifications (errors etc.) -->
    <KToast :toasts="store.toasts" @dismiss="store.dismissToast" />
  </q-layout>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { SessionStatus, EnvFileView } from '@kermanych/core';
import type { WorkspaceMember } from '@kermanych/cloud';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import { useAuth } from 'stores/auth';
import { IS_PREVIEW } from '../lib/preview';
import { MANAGEMENT_DEFAULT_SECTION } from '../lib/management';
import { theme, toggleTheme } from '../lib/theme';
import { percent, planWindow } from '../lib/format';
import { until } from '../lib/time';
import { useNow } from '../composables/useNow';
import { useSubscriptionUsage } from '../composables/useSubscriptionUsage';
import KRailItem, { type RailProject } from 'components/kit/KRailItem.vue';
import KWorkspaceRow from 'components/kit/KWorkspaceRow.vue';
import KTopNav from 'components/kit/KTopNav.vue';
import KNavItem from 'components/kit/KNavItem.vue';
import KModal from 'components/kit/KModal.vue';
import KField from 'components/kit/KField.vue';
import KBtn from 'components/kit/KBtn.vue';
import KToast from 'components/kit/KToast.vue';
import KEnvEditor from 'components/kit/KEnvEditor.vue';
import KColorPicker from 'components/kit/KColorPicker.vue';
import KSelect from 'components/kit/KSelect.vue';
import KDirPicker from 'components/kit/KDirPicker.vue';
import KTag from 'components/kit/KTag.vue';
import KUserButton from 'components/kit/KUserButton.vue';

// The Kermanych app shell (design-system section 07): project rail, brand header, page
// container, fleet status bar. Two stores back it — `store` (useOrchestrator) owns the LOCAL
// rows and sessions streamed over the socket, `projects` (useProjects) owns the CLOUD project
// list and membership. The rail is the join of the two.
const store = useOrchestrator();
const projects = useProjects();
const auth = useAuth();
const route = useRoute();
const router = useRouter();

// The left sidebar collapses to give the board full width; the choice persists so a reload
// keeps the operator's layout. breakpoint:0 means the drawer never self-closes, so this
// model-value is the only thing that shows/hides it.
const collapsed = ref(localStorage.getItem('kermanych.sidebar-collapsed') === '1');
watch(collapsed, (v) => localStorage.setItem('kermanych.sidebar-collapsed', v ? '1' : '0'));

// Which workspace groups are FOLDED. Stored as a list of ids because a Set does not
// survive JSON, and stored at all because a fold the reload undoes is not a fold. Absent
// from the list means expanded, so a workspace created on another machine — or one this
// user has just been invited to — arrives open rather than silently hidden.
//
// The payload is VALIDATED, not cast. `raw ? JSON.parse(raw) : []` catches a throw but not
// valid JSON of the wrong shape: the literal string `null` is truthy and parses to `null`,
// as do `true`, `42` and `{}`, and `.includes()` on any of them throws a TypeError inside
// the render function of the layout that wraps every authenticated route — a whiteout no
// in-app action can clear. stores/projects.ts:52-79 validates its sibling key the same way.
const COLLAPSED_KEY = 'kermanych.workspace-collapsed';
const collapsedWorkspaces = ref<string[]>(
  (() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      // A corrupt entry is not worth a blank sidebar; the next toggle overwrites it.
      return [];
    }
  })(),
);

function isFolded(id: string): boolean {
  return collapsedWorkspaces.value.includes(id);
}

// The 76px rail ignores the folds. It hides the chevron — there is no room for three
// controls in that column — so a group folded at full width would sit there with no
// affordance to open it and its projects would be unreachable until the sidebar is widened.
// The rail's job is a dense list of everything, not a navigable tree.
function isExpanded(id: string): boolean {
  return collapsed.value || !isFolded(id);
}

// The ONE place the folded set is written, so the toggle and the selection watcher below
// cannot drift into two persistence paths. The no-op guard matters: the watcher fires on
// every project selection, and without it each one would rewrite localStorage.
function setExpanded(id: string, expanded: boolean): void {
  if (expanded === !isFolded(id)) return;
  collapsedWorkspaces.value = expanded
    ? collapsedWorkspaces.value.filter((x) => x !== id)
    : [...collapsedWorkspaces.value, id];
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsedWorkspaces.value));
}

function toggleWorkspace(id: string): void {
  setExpanded(id, isFolded(id));
}

// WHICH GROUP OWNS A PROJECT — the one resolver, used by the watcher below and by the tree's
// offline placement. Two lookups with different sources is how the bug beneath this comment
// comes back: the watcher used to read `projects.byId` alone, which is empty whenever the
// cloud read failed. That was harmless while offline rows sat in a fold-less bucket, and
// became a live failure the moment they moved into real, foldable, persisted groups.
//
// Cloud list first, because it is authoritative when present; the cached map second, because
// it is what remains when the read failed and it is what the offline tree renders from. The
// online tree agrees with the first branch by construction, not by convention:
// groupProjectsByWorkspace places a project by the same `workspaceId` field this reads off
// the same object.
function workspaceOf(projectId: string): string | undefined {
  return projects.byId.get(projectId)?.workspaceId ?? store.projectWorkspace[projectId];
}

// A project can be selected from OUTSIDE the sidebar — the create-project flow below, or the
// notification jump in stores/orchestrator.ts:99, which fires when a local agent finishes and
// keeps firing with Supabase down, because local work never blocks on the cloud. A selection
// landing inside a folded group renders nowhere: the highlight moves to a row the operator
// cannot see, and the workspace row loses its own highlight at the same time, since `:active`
// requires no project to be selected. That is exactly the "selection moves behind the
// operator's back" failure the navigation removal was meant to end, so any selection unfolds
// its own group, whoever caused it. The lookup still misses for a project with no group on
// either side — a local-only row — which has no group to unfold.
watch(
  () => store.selectedProjectId,
  (id) => {
    const workspaceId = id ? workspaceOf(id) : undefined;
    if (workspaceId) setExpanded(workspaceId, true);
  },
);

// A sidebar click changes SCOPE and never navigates (Requirement 5). It used to push
// /agents from any non-project-scoped view, which meant the team board threw the operator
// out the moment they touched the tree; both the board and Агенти read the scope, so there
// is nothing left for a navigation to fix.
function selectProject(id: string): void {
  store.selectProject(id);
}
function selectWorkspace(id: string): void {
  store.selectWorkspace(id);
}

// DO WE HOLD AN AUTHORITATIVE CLOUD PROJECT LIST? Everything in the sidebar that could state
// a falsehood about where a project lives asks this, and only this: which source the tree is
// built from, whether a missing local row is an orphan, and what the bucket's heading claims.
// One signal for all three, because three answers to one question is how they drift apart.
//
// The signal belongs to the STORE (`listRead`, stores/projects.ts) because it is a fact about
// what the cloud answered, and every local approximation of it was wrong in a real state.
// `projects.projects.length > 0` is satisfied by create()/publish() appending, so one create
// while Supabase recovered would have claimed a one-project cloud list and called seven
// unchecked projects «поза хмарою». A local flag set in onMounted is false for a read that
// resolves later — stores/board.ts retries load() on every Агенти entry, and remove()
// re-reads — leaving an authoritative list in hand and unusable.
const hasCloudList = computed(() => projects.listRead);

onMounted(async () => {
  // Socket first: the snapshot, and the project_update events the sync inside load() emits,
  // are how LOCAL rows reach the rail. Connecting afterwards would race those events.
  store.connect();
  // The router guard already keeps this layout signed-in-only, but on a cold start `ready`
  // may still be pending, and useProjects() needs the session for RLS to return any row.
  await auth.ready;
  // A preview has no cloud (lib/preview.ts): skip the read entirely. Never calling load() is
  // the point — it leaves `listRead` false, so no seeded local row is labelled «поза хмарою»
  // on the strength of a list nobody read, and load()'s prune never runs against one.
  if (IS_PREVIEW) return;
  // load() reads the cloud list and mirrors it into the local registry itself
  // (api.syncProjects(list, true), see stores/projects.ts) — that mirror is what keeps
  // launching possible with Supabase unreachable (Requirement 7). Do not sync again here.
  // It never throws: an unreachable cloud degrades into `offlineError` and the cached list,
  // so the failure has to be read off the store rather than caught.
  await projects.load();
  if (projects.offlineError) {
    store.notify(
      `Хмара недоступна — працюємо з локальним кешем: ${projects.offlineError}`,
      'error',
      6000,
    );
  }
});

// A session is "running" while it is queued or actively working; waiting means it is blocking
// on an interactive UI request; done is terminal-success.
const RUNNING: readonly SessionStatus[] = ['queued', 'thinking', 'tool'];

// Running agents per project, in ONE pass over the sessions. Both the project tiles and the
// group badges read it, and it has to be a computed rather than a function because the tree
// asks for a count per project on EVERY MainLayout render — every socket session event, plus
// the 30-second useNow tick behind the account plan lines — and a filter-per-project there
// is O(projects × sessions) against a registry that already carries 69 sessions on one
// project. `sessionsOf` is gone with it: this was its only caller.
const runningCountById = computed(() => {
  const counts = new Map<string, number>();
  for (const s of store.sessions) {
    if (s.archived || s.kind === 'chat' || !RUNNING.includes(s.status)) continue;
    counts.set(s.projectId, (counts.get(s.projectId) ?? 0) + 1);
  }
  return counts;
});

function runningCount(projectId: string): number {
  return runningCountById.value.get(projectId) ?? 0;
}

// Segmented view nav. One table drives the labels, the active segment and the
// push target, so a new view is one row here plus its route record. `section` is
// the record the URL must match — for the nested Менеджмент tab that is the
// PARENT, so all five of its sections light the same segment; `route` is the name
// the click pushes, which for Менеджмент is its default section (a named parent
// with children would render the shell with an empty body).
const VIEWS = [
  { value: 'agents', label: 'Агенти', route: 'agents', section: 'agents' },
  { value: 'board', label: 'Дошка', route: 'board', section: 'board' },
  { value: 'chat', label: 'Чат', route: 'chat', section: 'chat' },
  {
    value: 'management',
    label: 'Менеджмент',
    route: MANAGEMENT_DEFAULT_SECTION,
    section: 'management',
  },
] as const;
const topOptions = VIEWS.map((v) => ({ value: v.value, label: v.label }));
// Anything outside the table (e.g. /kit) reads as the default view.
const topView = computed(
  () =>
    VIEWS.find((v) => route.matched.some((r) => r.name === v.section))?.value ?? 'agents',
);
function goView(v: string): void {
  const name = VIEWS.find((x) => x.value === v)?.route ?? 'agents';
  if (route.name !== name) void router.push({ name });
}

// The theme reveal grows from the control that was activated, so the handler
// hands its rect to `toggleTheme`. The rect — not `event.clientX` — because
// keyboard activation reports a pointer at (0, 0), which would start the wipe
// in the far corner instead of under the button.
function onThemeToggle(e: MouseEvent): void {
  const el = e.currentTarget;
  toggleTheme(el instanceof HTMLElement ? el.getBoundingClientRect() : null);
}

const buckets = [
  { key: 'active', label: 'Активні', icon: '◉' },
  { key: 'tasks', label: 'Задачі', icon: '☰' },
  { key: 'archived', label: 'Відкладені', icon: '⤓' },
  { key: 'history', label: 'Історія', icon: '↺' },
] as const;
function onBucket(key: 'active' | 'tasks' | 'archived' | 'history'): void {
  store.setBucket(key);
  if (route.name !== 'agents') void router.push({ name: 'agents' });
}
// Fleet tally per sidebar bucket (replaces the old footer KStatusBar). error/conflict
// count as Активні (needs attention) so no session falls outside a bucket.
const bucketCounts = computed(() => {
  const c = { active: 0, tasks: 0, archived: 0, history: 0 };
  for (const s of store.sessions) {
    if (s.projectId !== store.selectedProjectId) continue;
    if (s.kind === 'chat') continue;
    if (s.archived) c.archived++;
    else if (s.status === 'backlog') c.tasks++;
    else if (s.status === 'merged' || s.status === 'done' || s.status === 'stopped') c.history++;
    else c.active++;
  }
  return c;
});

// The tree: cloud workspaces, each with its own cloud projects, in cloud order.
// `groupProjectsByWorkspace` DROPS a project whose workspace is not in the list — RLS
// decides which workspaces this user can read, and inventing a group for one they cannot
// would render a name that does not exist. Such a project is simply not shown.
const tree = computed(() => projects.projectsByWorkspace);

const localById = computed(() => new Map(store.projects.map((p) => [p.id, p])));

// The tree's CONTENTS, both halves from one pass: which rail tiles hang under which
// workspace, and which have no group at all. One computed rather than two, because the two
// halves partition the same set — a project in a group AND in the bucket would render
// twice, a project in neither would be an agent nobody can select.
//
// ONLINE the cloud list is the truth about what exists and where it lives, joined with THIS
// machine's local row for the binding. A cloud project with no local row at all — the
// mount-time sync failed — reads as unbound, which is exactly what it is: nothing here can
// run it yet. The complement, a local row absent from the cloud list, is an orphan.
//
// OFFLINE — a cold start still loading, a read degraded into offlineError, or a preview with
// no cloud at all — the tree is rebuilt from the LOCAL rows placed through the cached
// projectId → workspaceId map (stores/projects.ts writes it beside the cached workspaces for
// exactly this). Without that placement the sidebar collapsed to a flat bucket under four
// empty groups, which is the offline collapse the cache exists to prevent. A row the map has
// no entry for goes to the bucket, NOT into a guessed group: same rule
// groupProjectsByWorkspace follows for a workspace RLS did not return — a group we cannot
// name is a group we must not draw. `has` rather than a bare lookup for the same reason;
// the store already drops map entries pointing outside the cached list, and this keeps that
// true if it ever stops.
//
// A computed, not a function: built per render it would mint fresh RailProject objects every
// time and every KRailItem would see a new prop identity on each socket session event.
const sidebarProjects = computed(() => {
  const byWorkspace = new Map<string, RailProject[]>();
  for (const group of tree.value) byWorkspace.set(group.workspace.id, []);
  const ungrouped: RailProject[] = [];

  if (hasCloudList.value) {
    for (const group of tree.value) {
      const tiles = byWorkspace.get(group.workspace.id);
      for (const c of group.projects) {
        const row = localById.value.get(c.id);
        tiles?.push({
          id: c.id,
          name: c.name,
          color: c.color ?? row?.color,
          state: row?.localRepoPath ? 'bound' : 'unbound',
        });
      }
    }
    const cloudIds = new Set(projects.projects.map((p) => p.id));
    for (const row of store.projects) {
      if (cloudIds.has(row.id)) continue;
      ungrouped.push({ id: row.id, name: row.name, color: row.color, state: 'orphan' });
    }
  } else {
    for (const row of store.projects) {
      // Name and colour come off the local row, which the last successful sync mirrored
      // from the cloud — the same values the online tree would show.
      const tile: RailProject = {
        id: row.id,
        name: row.name,
        color: row.color,
        state: row.localRepoPath ? 'bound' : 'unbound',
      };
      const workspaceId = workspaceOf(row.id);
      if (workspaceId !== undefined && byWorkspace.has(workspaceId)) {
        byWorkspace.get(workspaceId)?.push(tile);
      } else {
        ungrouped.push(tile);
      }
    }
  }

  return { byWorkspace, ungrouped };
});

// The bucket's heading is a CLAIM, and the claim is not the same one in both states. It turns
// on `hasCloudList`, the same signal the branch above does — the two must agree or the
// heading describes a bucket that was filled by different rules.
//
// WITH a cloud list it is precise: these rows are absent from a list we actually read, so
// this machine really is the only place they exist — made before the team cloud, or while
// Supabase was unreachable. The board's «Опублікувати в хмарі» is how such a row gets a
// workspace. They are kept rather than hidden because sync's prune deliberately keeps a row
// that still owns sessions, and agents you cannot select are agents you cannot stop.
//
// WITHOUT one it must be weaker. We have read no cloud list, so the only true statement about
// these rows is that we do not know their group: the cached map has no entry for them.
// «Лише на цій машині» there asserts something unchecked — on a cold offline start it used to
// say it about the team's entire project list.
const localOnlyLabel = computed(() =>
  hasCloudList.value ? 'Лише на цій машині' : 'Воркспейс невідомий',
);

// The group header's badge: what is running anywhere inside it, so a folded workspace still
// says whether it needs attention. Off the rail tiles rather than the cloud group, or the
// badge would read zero for every offline group whose tiles came from the cached map.
function workspaceRunningCount(workspaceId: string): number {
  let n = 0;
  for (const p of sidebarProjects.value.byWorkspace.get(workspaceId) ?? []) n += runningCount(p.id);
  return n;
}

// The LOCAL row carries this machine's binding and the offline config cache; the CLOUD
// project is the source of truth for config. Same id, two lookups.
const selectedProject = computed(() =>
  store.projects.find((p) => p.id === store.selectedProjectId),
);

const selectedCloud = computed(() =>
  store.selectedProjectId ? projects.byId.get(store.selectedProjectId) : undefined,
);

// Prefer the cloud name, fall back to the cached row, so a project whose sync failed still
// shows a name rather than a UUID.
const selectedName = computed(
  () => selectedCloud.value?.name ?? selectedProject.value?.name ?? '',
);

// Requirement 3: only a bound project can touch the repo. Task 12 hangs every disabled
// affordance off this one computed.
const isBound = computed(() => !!selectedProject.value?.localRepoPath);

// Requirement 3: the binding is manual and per machine. Kermanych never clones — the path
// must already be a git repo, and each teammate binds their own checkout. One string for
// every disabled affordance, so the copy cannot drift.
const BIND_HINT = 'Прив’яжіть локальну теку репозиторію';

// The three refusals PUT /api/projects/:id/binding actually returns — the first two thrown by
// bindProject (supervisor.service.ts:130-131), the third by registry.patchProject when this
// machine has no row for the project at all. Anything else is shown verbatim: the api's own
// message beats a guess.
const BIND_ERRORS: Record<string, string> = {
  'local repo path cannot be empty': 'Шлях до теки не може бути порожнім',
  'local repo path is not a git repo':
    'Обрана тека не є git-репозиторієм — виберіть корінь репозиторію (той, що містить .git)',
  'project not found':
    'Цього проєкту немає в локальному реєстрі — перезапустіть Керманич, щоб синхронізувати список із хмари',
};

const pickerOpen = ref(false);

function openBinding(): void {
  pickerOpen.value = true;
}

async function bindTo(path: string): Promise<void> {
  const id = store.selectedProjectId;
  if (!id) return;
  try {
    const bound = await store.setProjectBinding(id, path);
    // project_update streams back over the socket, so the rail tile drops its dashed frame and
    // the header picks up the path on their own — nothing to refresh here.
    store.notify(`Проєкт прив’язано до ${bound.localRepoPath}`);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    store.notify(BIND_ERRORS[raw] ?? raw, 'error', 6000);
  }
}

const contextLabel = computed(() => {
  if (!store.selectedProjectId) return 'Проєкт не вибрано';
  return `${selectedName.value} · ${selectedProject.value?.localRepoPath || 'не прив’язано'}`;
});

// Two create modals, because the sidebar's two «+» buttons create different things. The
// project one is keyed by the workspace it will create INSIDE — an id rather than a
// boolean, since «new project» is not a question that can be asked without a group — and
// `createError` / `createBusy` are shared: only one of the two can be open at a time.
//
// Neither has a directory field: creating a project and binding a repo are different acts
// on different machines (Requirement 3).
const createWorkspaceOpen = ref(false);
const createWorkspaceName = ref('');
const createProjectFor = ref<string | undefined>(undefined);
const createName = ref('');
const createRemote = ref('');
const createError = ref<string | null>(null);
const createBusy = ref(false);

const canCreateWorkspace = computed(() => createWorkspaceName.value.trim() !== '');
const canCreate = computed(() => createName.value.trim() !== '');

function openCreateWorkspace(): void {
  createWorkspaceName.value = '';
  createError.value = null;
  createBusy.value = false;
  createWorkspaceOpen.value = true;
}

function openCreateProject(workspaceId: string): void {
  createName.value = '';
  createRemote.value = '';
  createError.value = null;
  createBusy.value = false;
  createProjectFor.value = workspaceId;
}

async function submitCreateWorkspace(): Promise<void> {
  if (!canCreateWorkspace.value) return;
  createError.value = null;
  createBusy.value = true;
  try {
    const created = await projects.createWorkspace(createWorkspaceName.value.trim());
    createWorkspaceOpen.value = false;
    // Scope moves to the new group, so the next «+» on its row is the obvious next step.
    store.selectWorkspace(created.id);
    store.notify(`Воркспейс «${created.name}» створено`);
  } catch (e) {
    createError.value = e instanceof Error ? e.message : String(e);
  } finally {
    createBusy.value = false;
  }
}

async function submitCreate(): Promise<void> {
  const workspaceId = createProjectFor.value;
  if (!workspaceId || !canCreate.value) return;
  createError.value = null;
  createBusy.value = true;
  try {
    const remote = createRemote.value.trim();
    // create() inserts under the user's JWT (projects_insert_member checks membership of
    // the destination workspace) and mirrors the one new project into the local registry,
    // so its tile appears under this group without a second full sync.
    const created = await projects.create(workspaceId, createName.value.trim(), remote || undefined);
    createProjectFor.value = undefined;
    store.selectProject(created.id);
    store.notify(`Проєкт «${created.name}» створено у хмарі`);
  } catch (e) {
    // Keep the modal open. The two real refusals are `not signed in` (the session expired
    // between the router guard and this click) and an RLS refusal on a workspace this user
    // has just lost access to; both are fixable without retyping the name.
    createError.value = e instanceof Error ? e.message : String(e);
  } finally {
    createBusy.value = false;
  }
}

// PostgREST's "zero rows through .single()" refusal, in BOTH of its spellings. Every
// owner-only policy in this schema refuses a write by matching zero rows rather than by
// raising, and the cloud client throws `new Error(error.message)` and drops `error.code`,
// so the TEXT is all a caller gets. PostgREST ≤11 said «JSON object requested, multiple (or
// no) rows returned»; this server says «Cannot coerce the result to a single JSON object» —
// AgentsPage.vue:1470-1473 records that first-hand, and packages/cloud/test/rls.spec.ts:246
// asserts the CODE precisely because the message is version-dependent. Testing one spelling
// leaves the branch dead against the other server and puts raw English in a Ukrainian
// modal, so this MUST keep both. Every place that maps this refusal uses it.
const NO_ROWS = /rows returned|coerce the result/;

// WORKSPACE SETTINGS — the group's name, colour and TEAM, reached from the header chip.
// Membership hangs off the workspace rather than the project because one invitation opens
// every project in the group; that is also why inviting and removing are OWNER-only here
// while project config is open to any member (the approved role matrix). All of this is
// UX: invite_workspace_member refuses a non-owner in its first statement, and
// workspace_members_delete_owner refuses one by matching zero rows.
const workspaceSettingsOpen = ref(false);
const workspaceSettingsId = ref<string | undefined>(undefined);
const wsNameEdit = ref('');
const wsColorEdit = ref('');
const wsError = ref<string | null>(null);
const membersLoading = ref(false);
const memberEmail = ref('');
const memberBusy = ref(false);

// Off the same map the sidebar renders from, so a rename here and the row there cannot
// disagree — and so an offline open still shows a name, since that map is cache-backed.
const workspaceSettings = computed(() =>
  workspaceSettingsId.value ? projects.workspaceById.get(workspaceSettingsId.value) : undefined,
);
const workspaceSettingsName = computed(() => workspaceSettings.value?.name ?? '');

// Keyed by WORKSPACE id, and missing entirely before the first read — the `?? []` is
// load-bearing (noUncheckedIndexedAccess is on).
const workspaceMembers = computed<WorkspaceMember[]>(() =>
  workspaceSettingsId.value ? projects.members[workspaceSettingsId.value] ?? [] : [],
);

const isOwnerOfWorkspace = computed(
  () => !!workspaceSettingsId.value && projects.isWorkspaceOwner(workspaceSettingsId.value),
);

// WHICH SEAT IS THE OWNER'S — read off `workspaces.owner_id`, never off
// `workspace_members.role`. No policy and no security-definer function consults that
// column: it is descriptive metadata, and the workspaces migration copied across whatever
// project_members SAID (`set role = excluded.role`), so a backfilled owner whose project
// role had been rewritten arrives here as 'member'. Deciding from it would badge the owner
// «учасник» and offer a remove button that workspace_members_delete_owner refuses by
// matching zero rows — a control that silently does nothing.
function isWorkspaceOwnerSeat(userId: string): boolean {
  return !!workspaceSettings.value && workspaceSettings.value.ownerId === userId;
}

// The FK from projects.workspace_id is `on delete restrict`, so a group still holding
// projects cannot go. Read off the same array useProjects.removeWorkspace pre-checks, so
// the button and the store agree about when the delete is possible at all.
const workspaceHasProjects = computed(() =>
  projects.projects.some((p) => p.workspaceId === workspaceSettingsId.value),
);

// The workspace in SCOPE, which is what the header chip opens. Set both by a workspace row
// click and by selecting a project (orchestrator.selectProject resolves the group), so the
// chip is there whenever anything in the tree is selected. Undefined for a workspace the
// cloud list no longer holds — access revoked mid-session — and the chip then disappears
// rather than opening a modal about a group we cannot name.
const scopedWorkspace = computed(() =>
  store.selectedWorkspaceId ? projects.workspaceById.get(store.selectedWorkspaceId) : undefined,
);

// The chip's tooltip AND its accessible name, one string so they cannot drift. KBtn sets
// `aria-label` only for `variant="icon"`, and `title` feeds `v-tip`, which lib/tip.ts
// states is purely presentational and never referenced by the accessibility tree — so a
// ghost chip's accessible name is its slot text alone, a button called «Бета» that never
// says it opens anything. The leading «Воркспейс «Бета»» also keeps the visible label
// inside the accessible name (WCAG 2.5.3 Label in Name), which a voice-control user needs.
// The VISIBLE text stays the bare name; that is the point of the chip.
const workspaceChipLabel = computed(
  () => `Воркспейс «${scopedWorkspace.value?.name ?? ''}»: склад команди й налаштування`,
);

async function openWorkspaceSettings(id: string): Promise<void> {
  workspaceSettingsId.value = id;
  const ws = projects.workspaceById.get(id);
  wsNameEdit.value = ws?.name ?? '';
  wsColorEdit.value = ws?.color ?? '';
  wsError.value = null;
  memberEmail.value = '';
  workspaceSettingsOpen.value = true;
  membersLoading.value = true;
  try {
    await projects.loadMembers(id);
  } catch (e) {
    // Non-fatal: the roster stays empty and says why, and the name and colour still save.
    wsError.value = `Не вдалось прочитати учасників: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    membersLoading.value = false;
  }
}

async function saveWorkspace(): Promise<void> {
  const id = workspaceSettingsId.value;
  if (!id) return;
  wsError.value = null;
  const name = wsNameEdit.value.trim();
  if (!name) {
    wsError.value = 'Назва воркспейсу не може бути порожньою';
    return;
  }
  try {
    // patchWorkspace replaces the row in the store list and rewrites the tree cache, so
    // the sidebar row picks the new name and colour up on its own.
    await projects.patchWorkspace(id, { name, color: wsColorEdit.value });
    workspaceSettingsOpen.value = false;
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // workspaces_update_owner refuses a non-owner by matching zero rows, which surfaces as
    // NO_ROWS rather than as anything mentioning RLS — so name the real reason. Reachable
    // despite the disabled Save: ownership can change between the load that drew this
    // modal and the click.
    wsError.value = NO_ROWS.test(raw)
      ? 'Хмара відмовила: змінювати воркспейс може лише його власник'
      : raw;
  }
}

async function deleteWorkspace(): Promise<void> {
  const id = workspaceSettingsId.value;
  if (!id) return;
  const name = workspaceSettingsName.value;
  if (!window.confirm(`Видалити воркспейс «${name}»? Це не відкотити.`)) return;
  wsError.value = null;
  try {
    // removeWorkspace confirms the delete with a re-read and clears the scope when it was
    // this group's, so nothing here navigates.
    await projects.removeWorkspace(id);
    workspaceSettingsOpen.value = false;
    store.notify(`Воркспейс «${name}» видалено`);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // ONE of the two refusals arrives already translated: the non-owner delete, which
    // removeWorkspace detects by re-reading. The other is a courtesy at best —
    // removeWorkspace's «спершу перенесіть…» pre-check and `workspaceHasProjects` both read
    // the last cloud list THIS session read, so a project a teammate added since then is
    // invisible to both: the button renders enabled, the explanatory hint is absent, the
    // owner is walked through the irreversible confirm, and the `on delete restrict` FK is
    // what says no — in English. Translate it here. The database is the authority; the
    // pre-check only saves a round trip when it happens to know.
    wsError.value = raw.includes('violates foreign key constraint')
      ? 'Хмара відмовила: у цьому воркспейсі ще є проєкти — спершу перенесіть або видаліть їх'
      : raw;
  }
}

// The refusals a workspace membership write really produces. The first two come from
// inviteMember / the cloud client, the third from invite_workspace_member's own owner
// check. Removal needs no branch: a DELETE the policy refuses matches zero rows WITHOUT
// an error, which removeMemberOf catches by re-reading instead.
function memberErrorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (raw.includes('no Kermanych account for')) {
    return 'Немає акаунта Керманича з такою адресою — попросіть колегу спершу увійти через GitHub';
  }
  if (raw.includes('not a valid email address')) {
    return 'Це не схоже на імейл — запрошуємо за адресою, якою колега входить у Керманич';
  }
  if (raw.includes('only the workspace owner can invite')) {
    return 'Хмара відмовила: запрошувати до воркспейсу може лише його власник';
  }
  return raw;
}

async function submitMember(): Promise<void> {
  const id = workspaceSettingsId.value;
  const email = memberEmail.value.trim();
  if (!id || !email) return;
  memberBusy.value = true;
  try {
    const invited = await projects.inviteMember(id, email);
    memberEmail.value = '';
    // Name WHO the address resolved to: the roster lists github handles, so this is the
    // caller's confirmation that the invite landed on the person they meant.
    store.notify(
      `@${invited.profile?.githubUsername ?? email} у воркспейсі «${workspaceSettingsName.value}»`,
    );
  } catch (e) {
    store.notify(memberErrorText(e), 'error', 6000);
  } finally {
    memberBusy.value = false;
  }
}

async function removeMemberOf(m: WorkspaceMember): Promise<void> {
  const id = workspaceSettingsId.value;
  if (!id) return;
  const who = m.profile?.githubUsername ?? m.userId;
  if (!window.confirm(`Вилучити @${who} з воркспейсу «${workspaceSettingsName.value}»?`)) return;
  try {
    await projects.removeMember(id, m.userId);
    // A DELETE the owner-only policy refuses does NOT error — it matches zero rows, while
    // the store has already dropped the row locally. Re-read so the roster cannot show a
    // removal that never happened.
    const after = await projects.loadMembers(id);
    if (after.some((x) => x.userId === m.userId)) {
      store.notify(
        'Хмара відмовила: керувати складом воркспейсу може лише його власник',
        'error',
        6000,
      );
      return;
    }
    store.notify(`@${who} вилучено з воркспейсу — разом з усіма його проєктами`);
  } catch (e) {
    store.notify(memberErrorText(e), 'error', 6000);
  }
}

const settingsOpen = ref(false);
const settingsError = ref<string | null>(null);
const nameEdit = ref('');
const colorEdit = ref('');
const defaultBranchEdit = ref('');
const conventionsEdit = ref('');
const previewCommandEdit = ref('');
const apiCommandEdit = ref('');
const settingsBranches = ref<string[]>([]);

const deleteOpen = ref(false);
const deleteError = ref<string | null>(null);
const deleteBusy = ref(false);

// UX only, and now for exactly ONE control: «Видалити проєкт». Per the approved role
// matrix any workspace member edits project config — name, colour, default branch,
// conventions, both preview commands, carry files and the env key NAMES — and
// projects_update_member is what permits it. Deleting stays owner-only
// (projects_delete_owner), and the answer resolves through the project's WORKSPACE:
// ownership lives there now, not on the project row.
const isOwnerOfSelected = computed(
  () => !!store.selectedProjectId && projects.isOwner(store.selectedProjectId),
);

// IS THE SELECTED PROJECT IN THE CLOUD AT ALL? A «поза хмарою» local row — created before
// the team cloud existed, or while Supabase was unreachable — is selectable: the sidebar
// renders it in the local-only bucket and the header gear opens this modal for it.
// `isOwnerOfSelected` used to make Save inert for such a row BY ACCIDENT, since it resolves
// through `byId`, which is built from the cloud list and holds no entry for one. Dropping
// the owner gate dropped that accident with it, so the state needs a gate of its own —
// otherwise Save fires a patch whose `.eq('id', id) … single()` matches no row, and the
// operator reads a Postgres coercion string. Only the CLOUD-writing controls are gated:
// «Опублікувати в хмарі» on the board is the way out, and the folder binding and the `.env`
// VALUES are this machine's business and have always worked without a cloud row.
const isInCloud = computed(
  () => !!store.selectedProjectId && projects.byId.has(store.selectedProjectId),
);

// Both separators are accepted, but only the multiline env-keys textarea can actually receive
// a newline; the single-line carry-files input strips them, so its label promises commas only.
function parseList(text: string): string[] {
  return text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

const envOpen = ref(false);
const envError = ref<string | null>(null);
const envView = ref<EnvFileView>({ entries: [], ignored: true });
const carryFilesText = ref('.env');
const envEditor = ref<{ collect: () => { set: Record<string, string>; remove: string[] } } | null>(null);
const envKeysText = ref('');

// Requirement 9: the cloud holds key NAMES only. This is the checklist — which required names
// the BOUND repo's .env actually carries a value for. It reflects the file as loaded, so save
// and reopen to re-check after editing.
const envKeyState = computed(() => {
  const present = new Set(envView.value.entries.map((e) => e.key));
  return (selectedCloud.value?.envKeys ?? []).map((key) => ({ key, present: present.has(key) }));
});

const missingEnvKeys = computed(() =>
  envKeyState.value.filter((k) => !k.present).map((k) => k.key),
);

// Settings modal. Seeded from the cloud project when we have it, from the cached row when we
// do not, so the form is never blank just because Supabase is down.
async function openSettings(): Promise<void> {
  const id = store.selectedProjectId;
  if (!id) return;
  const cloud = selectedCloud.value;
  const row = selectedProject.value;
  settingsError.value = null;
  nameEdit.value = cloud?.name ?? row?.name ?? '';
  colorEdit.value = cloud?.color ?? row?.color ?? '';
  defaultBranchEdit.value = cloud?.defaultBranch ?? row?.defaultBranch ?? '';
  conventionsEdit.value = cloud?.conventions ?? row?.conventions ?? '';
  previewCommandEdit.value = cloud?.previewCommand ?? row?.previewCommand ?? '';
  apiCommandEdit.value = cloud?.apiCommand ?? row?.apiCommand ?? '';
  // Comma-joined, not newline-joined: this is a single-line <input>, which silently strips
  // newlines — a '\n'-seeded two-entry list would render (and re-save) as one glued name.
  carryFilesText.value = (cloud?.carryFiles ?? row?.carryFiles ?? ['.env']).join(', ');
  settingsBranches.value = [];
  settingsOpen.value = true;
  // GET /projects/:id/branches answers `project not bound` without a binding, so do not ask.
  if (!isBound.value) return;
  try {
    settingsBranches.value = (await store.listBranches(id)).branches;
  } catch {
    // Non-fatal: the picker degrades to the value already selected.
  }
}

async function saveSettings(): Promise<void> {
  const id = store.selectedProjectId;
  if (!id) return;
  settingsError.value = null;
  const name = nameEdit.value.trim();
  if (!name) {
    settingsError.value = 'Назва проєкту не може бути порожньою';
    return;
  }
  const carryFiles = parseList(carryFilesText.value);
  try {
    // CLOUD first (design D1: it is the source of truth for config), and patch() then mirrors
    // the returned row into the local registry via api.syncProjects([updated], false) — so the
    // offline cache the launch path reads matches what the team sees. Empty strings are turned
    // into NULLs by toProjectRow(), which is how a field gets cleared.
    await projects.patch(id, {
      name,
      color: colorEdit.value,
      defaultBranch: defaultBranchEdit.value,
      conventions: conventionsEdit.value,
      previewCommand: previewCommandEdit.value,
      apiCommand: apiCommandEdit.value,
      // Never store an empty carry list: the launch path would copy nothing into the worktree.
      carryFiles: carryFiles.length ? carryFiles : ['.env'],
    });
    settingsOpen.value = false;
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // We believed this write was allowed, so the raw message is usually the useful part: an
    // expired session, or an unreachable cloud. The one exception is membership lost under
    // us, which projects_update_member refuses by matching zero rows — postgrest's wording,
    // not RLS's, and nothing an operator can act on.
    settingsError.value = NO_ROWS.test(raw)
      ? 'Хмара відмовила: ви більше не учасник воркспейсу цього проєкту'
      : `Хмара відмовила у записі: ${raw}`;
  }
}

function openDelete(): void {
  deleteError.value = null;
  deleteBusy.value = false;
  deleteOpen.value = true;
}

async function confirmDelete(): Promise<void> {
  const id = store.selectedProjectId;
  if (!id) return;
  deleteError.value = null;
  deleteBusy.value = true;
  try {
    await projects.remove(id);
    deleteOpen.value = false;
    settingsOpen.value = false;
    // The prune emits project_removed over the socket, which clears the selection and the
    // session list; a row that still owns sessions survives instead and its tile turns into
    // the «поза хмарою» state.
    store.notify('Проєкт видалено у хмарі');
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    if (raw.startsWith('cloud delete unconfirmed')) {
      // The delete itself did not error; only the confirming re-read did. Do not accuse the
      // user of a refusal for something that most likely landed.
      deleteError.value =
        'Видалення надіслано, але підтвердити його не вдалося: хмара недоступна. Список оновиться, коли зв’язок відновиться';
    } else if (raw.startsWith('cloud refused the delete')) {
      deleteError.value = 'Хмара відмовила: видалити проєкт може лише власник';
    } else {
      deleteError.value = raw;
    }
  } finally {
    deleteBusy.value = false;
  }
}

// Env modal: the BOUND repo's .env (values never leave this machine) plus the cloud's
// names-only checklist.
async function openEnv(): Promise<void> {
  const id = store.selectedProjectId;
  if (!id) return;
  envError.value = null;
  envKeysText.value = (selectedCloud.value?.envKeys ?? []).join('\n');
  envView.value = { entries: [], ignored: true };
  envOpen.value = true;
  try {
    envView.value = await store.getEnv(id);
  } catch (e) {
    envError.value = e instanceof Error ? e.message : String(e);
  }
}

async function saveEnv(): Promise<void> {
  const id = store.selectedProjectId;
  if (!id) return;
  envError.value = null;
  try {
    // VALUES: local file only, through the api's path-confined atomic writer.
    const edits = envEditor.value?.collect();
    if (edits && (Object.keys(edits.set).length || edits.remove.length)) {
      await store.saveEnv(id, edits);
    }
    // NAMES: cloud config, and any workspace member may edit it now (the role matrix).
    // Skipped entirely for a project that is not in the cloud — there is no row to patch,
    // and attempting one would throw AFTER the local values above had landed, leaving a
    // half-applied save behind a modal that will not close. The field is hidden in that
    // state for the same reason. Otherwise sent only when the list actually changed: an
    // unchanged list is a project write worth not making.
    if (isInCloud.value) {
      const next = parseList(envKeysText.value);
      const current = selectedCloud.value?.envKeys ?? [];
      if (next.join('\n') !== current.join('\n')) await projects.patch(id, { envKeys: next });
    }
    envOpen.value = false;
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // The local VALUES are written first, so a refusal from the key-names patch leaves them
    // saved while the modal stays open. Say which half landed rather than let the operator
    // guess — that ambiguity is the whole cost of the ordering.
    envError.value = NO_ROWS.test(raw)
      ? 'Значення збережено на цій машині, але перелік ключів у хмарі — ні: ви більше не учасник воркспейсу цього проєкту'
      : raw;
  }
}

// ACCOUNT — the rail tile and the sign-out modal name the same person: the GitHub handle
// first (that is what the board prints beside a task), the display name next, and a short
// user id as a last resort, so a profile GitHub sent no metadata for is still identifiable.
const accountLabel = computed(() => {
  const p = auth.profile;
  return p?.githubUsername ?? p?.displayName ?? auth.user?.id.slice(0, 8) ?? '';
});

// The handle gets its `@` for display only — the tile derives its initials from the bare
// name, so the sigil never becomes one of the two letters.
const accountName = computed(() =>
  auth.profile?.githubUsername ? `@${accountLabel.value}` : accountLabel.value,
);

// PLAN SPEND — what the provider subscription behind this machine's agents has left. The
// figure is a percent of a rolling window (`5h`, `7d`), because that is the only unit
// providers meter a plan in; there is no token count to show and none is invented.
const planUsage = useSubscriptionUsage();
const planNow = useNow(30_000);

const planLines = computed(() =>
  (planUsage.value?.providers ?? []).map((p) => ({
    provider: p.provider,
    windows: p.windows.map((w) => ({
      id: w.id,
      short: planWindow(w.id),
      percent: percent(w.usedPercent),
      used: w.usedPercent,
    })),
    // The detail the compact row drops: the provider's own window names, the countdown to
    // each reset, and — when omp balances across several accounts — that the figure is their
    // mean rather than one account's.
    hint: [
      p.provider[0]!.toUpperCase() + p.provider.slice(1),
      ...(p.accounts > 1 ? [`${p.accounts} акаунти, у середньому`] : []),
      ...p.windows.map(
        (w) =>
          `${w.label}: ${percent(w.usedPercent)}` +
          (w.resetsAt ? ` — оновиться за ${until(w.resetsAt, planNow.value)}` : ''),
      ),
    ].join(' · '),
  })),
);

// The collapsed rail hides the row, and the tile is a bare picture either way — so its
// tooltip carries the identity, the same figures in short form, and the action.
const accountHint = computed(() => {
  const spend = planLines.value
    .flatMap((p) => p.windows.map((w) => `${w.short} ${w.percent}`))
    .join(' · ');
  return [accountName.value, ...(spend ? [spend] : []), 'вийти'].join(' · ');
});

const accountOpen = ref(false);
const accountBusy = ref(false);

// signOut() ends the Supabase session and, through apply(null), drops the local api's
// token; the router's watcher on `auth.user` performs the navigation to /login. It only
// rejects on an unexpected fault (the sign-out's own network failure is swallowed by
// supabase-js), and then the modal must stay open with the reason visible.
async function confirmSignOut(): Promise<void> {
  accountBusy.value = true;
  try {
    await auth.signOut();
    accountOpen.value = false;
  } catch (e) {
    store.notify(`Не вдалося вийти: ${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    accountBusy.value = false;
  }
}

// Footer git sync for the selected project's bound repo. `syncing` gates both buttons so a
// double-click cannot fire two operations; git's own output (or refusal) surfaces as a toast.
const syncing = ref(false);
async function gitSync(kind: 'pull' | 'push'): Promise<void> {
  const id = store.selectedProjectId;
  if (!id || !isBound.value || syncing.value) return;
  syncing.value = true;
  const label = kind === 'pull' ? 'Pull' : 'Push';
  try {
    const r = kind === 'pull' ? await store.pullProject(id) : await store.pushProject(id);
    if (r.ok) store.notify(`${label}: ${r.out.trim() || 'готово'}`);
    else store.notify(`${label}: ${r.out.trim() || 'не вдалося'}`, 'error', 7000);
  } catch (e) {
    store.notify(`${label}: ${e instanceof Error ? e.message : String(e)}`, 'error', 7000);
  } finally {
    syncing.value = false;
  }
}
</script>

<style scoped lang="scss">

.shell__side-inner {
  background: var(--k-bg);
  border-radius: var(--k-r-lg);
  border: 1px solid var(--k-line);
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-3) var(--k-sp-2);
  height: 100%;
}

// ── Minified (Slack-style) rail — icons only, ~64px wide ─────────────────────
// Expanded stays label-only, so the leading glyph is hidden until the rail is minified.
.shell__side-inner:not(.shell--min) :deep(.k-nav-item__icon) {
  display: none;
}
// A 76px rail has room for the tile and nothing else; the account tooltip carries the name
// and the plan figures while the sidebar is minified.
.shell--min .shell__side-label,
.shell--min .shell__account-meta {
  display: none;
}
.shell--min .shell__user {
  justify-content: center;
  flex-direction: column;
}
.shell--min :deep(.k-nav-item) {
  justify-content: center;
  gap: 0;
  padding: var(--k-sp-2);
}
.shell--min :deep(.k-nav-item__label),
.shell--min :deep(.k-count) {
  display: none;
}
.shell--min :deep(.k-nav-item__icon) {
  font-size: var(--k-fs-md);
}
.shell--min :deep(.k-rail) {
  justify-content: center;
  padding: var(--k-sp-1);
}
.shell--min :deep(.k-rail__name),
.shell--min :deep(.k-rail__agents) {
  display: none;
}
.shell--min :deep(.k-rail__initials) {
  display: flex;
}
// The tree collapses to the icon strip like the rail always did: the workspace row keeps
// its colour dot as the group's marker and drops the name, the chevron and the «+» — a
// 76px column has no room for three controls, and the group cannot be folded or added to
// from a strip that cannot show which group it is. Because the chevron goes, isExpanded()
// ignores the folded set while `shell--min` is on: hiding the only control that unfolds a
// group while still honouring the fold would leave its projects unreachable.
.shell--min :deep(.k-ws__name),
.shell--min :deep(.k-ws__count),
.shell--min :deep(.k-ws__chevron),
.shell--min :deep(.k-ws__add) {
  display: none;
}
.shell--min :deep(.k-ws__body) {
  justify-content: center;
}
.shell--min :deep(.k-rail--indent) {
  margin-left: 0;
  width: 100%;
}

.shell__buckets {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.shell__side-label {
  margin: var(--k-sp-3) var(--k-sp-1) var(--k-sp-1);
  font-size: var(--k-fs-xs);
  font-weight: var(--k-fw-medium);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--k-faint);
}

// Both levels are real <ul>s now (the grouping semantics), so both need the list chrome
// reset — markers, indent, margins — before the flex column that actually lays them out.
.shell__projects,
.shell__group-items {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

// A group is the header plus its children; the gap between GROUPS is the parent list's.
.shell__group {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-1);
}

.shell__add {
  align-self: flex-start;
  margin-top: var(--k-sp-1);
}

.shell__divider {
  height: 1px;
  background: var(--k-line);
  margin: var(--k-sp-2) 0;
}

.shell__side-label--row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

// The local-only bucket's heading. It sits INSIDE the tree rather than above it, so it is
// quieter than «Воркспейси» and closer to what it labels.
.shell__side-label--sub {
  margin-top: 10px;
  opacity: 0.75;
}

.shell__label-add {
  padding: 0 var(--k-sp-1);
  background: none;
  border: none;
  color: var(--k-faint);
  font-size: var(--k-fs-md);
  line-height: 1;
  cursor: pointer;

  &:hover { color: var(--k-text); }
}

// account chip — pinned to the foot of the sidebar: avatar, name over plan spend, toggle.
.shell__user {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  padding-top: var(--k-sp-3);
  border-top: 1px solid var(--k-line);
}

.shell__account {
  flex: none;
}

// The name-over-spend column. It owns the row's free width, so the name keeps its ellipsis
// while the plan figures below it stay on one line.
.shell__account-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-1);
}

.shell__account-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-medium);
  color: var(--k-text);
}

.shell__account-plan {
  display: flex;
  align-items: center;
  gap: var(--k-sp-1);
  font-size: var(--k-fs-xs);
  line-height: 1;
  color: var(--k-muted);
  cursor: default;
}

// A `·` between windows, from CSS so the markup carries figures only.
.shell__plan-window + .shell__plan-window::before {
  content: '·';
  margin-right: var(--k-sp-1);
  color: var(--k-faint);
}

// A nearly-spent window is the difference between "agents run tonight" and "they don't",
// so it leaves the muted register — status tokens, never the single accent.
.shell__plan-window--warn {
  color: var(--k-warning);
}

.shell__plan-window--hot {
  color: var(--k-danger);
}

.shell__plan-provider {
  color: var(--k-faint);
}

.shell__toggle {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--k-sp-2);
  background: none;
  border: none;
  border-radius: var(--k-r);
  color: var(--k-faint);
  font-size: var(--k-fs-md);
  line-height: 1;
  cursor: pointer;
}

.shell__toggle:hover {
  background: var(--k-surface2);
  color: var(--k-text);
}

// top bar — 2px rule below (zone separator), surface fill.
.shell__header {
  display: flex;
  align-items: center;
  gap: var(--k-sp-4);
  height: 56px;
  padding: 0 var(--k-sp-3);
  background: transparent;
  color: var(--k-text);
  box-shadow: none;
}

.shell__brand {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.shell__mark {
  width: 20px;
  height: 20px;
  flex: none;
}

.shell__logo {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  font-weight: 800;
  letter-spacing: 0.06em;
  color: var(--k-text);
}

.shell__ver {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.shell__nav {
  margin: 0 auto;
}

.shell__actions {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

// The header cluster is fixed in practice; an arbitrary workspace name is not. The
// ellipsis sits on a span rather than on the button because KBtn is an inline-flex
// container and text-overflow does not apply to an anonymous flex item.
.shell__ws-name {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shell__form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.shell__error {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--k-accent);
}

.shell__hint {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--k-muted);
}

// A non-owner sees the value, cannot change it, and gets the same greyed-out signal as a
// disabled KField (which is why the opacity matches KField's :disabled rule).
.shell__readonly {
  opacity: 0.45;
  pointer-events: none;
}

.shell__members {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 16px;
  border-top: 1px solid var(--k-line);
}

.shell__members-label {
  text-align: left;
  font-size: 13px;
  color: var(--k-text);
}

.shell__member {
  display: flex;
  align-items: center;
  gap: 8px;
}

.shell__member-avatar {
  flex: none;
  width: 22px;
  height: 22px;
  border: 1px solid var(--k-line);
  border-radius: 0; // no circles anywhere in this system
  object-fit: cover;
}

.shell__member-avatar--blank {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--k-muted);
  background: var(--k-surface2);
}

.shell__member-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--k-text);
}

.shell__member-add {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.shell__keys {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.shell__keys-label {
  text-align: left;
  font-size: 13px;
  color: var(--k-text);
}

.shell__keys-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.shell__dir {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.shell__browse {
  align-self: flex-start;
}

.shell__danger {
  margin-right: auto; // destructive action sits apart, on the left of the footer
}

// STATUS BAR — VS Code-style footer. Full-width via the layout view "…lFf"; a thin top rule
// and compact ghost buttons, disabled until a bound project gives git a target.
.shell__footer {
  display: flex;
  align-items: center;
  gap: var(--k-sp-1);
  height: 26px;
  padding: 0 var(--k-sp-2);
  background: var(--k-bg);
  border-top: 1px solid var(--k-line-strong);
}

.shell__foot-btn {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 var(--k-sp-2);
  background: none;
  border: none;
  border-radius: var(--k-r);
  color: var(--k-muted);
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-xs);
  cursor: pointer;
}

.shell__foot-btn:hover:not(:disabled) {
  background: var(--k-surface2);
  color: var(--k-text);
}

.shell__foot-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.shell__foot-spacer {
  flex: 1;
}

// The project folder, VS Code-style on the right edge: click to (re)bind. min-width:0 lets
// the path ellipsise instead of pushing the footer wider than the window.
.shell__foot-folder {
  max-width: 46%;
  min-width: 0;
  overflow: hidden;
}

.shell__foot-folder-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--k-faint);
}
</style>
