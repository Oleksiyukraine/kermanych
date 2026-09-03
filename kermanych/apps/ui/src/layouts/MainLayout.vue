<template>
  <q-layout view="hHh Lpr fFf" class="shell">
    <!-- LEFT SIDEBAR — bucket nav + projects + folder binding + account (v3 section 07) -->
    <q-drawer model-value side="left" :width="collapsed ? 76 : 264" :breakpoint="0" class="shell__sidebar">
      <div class="shell__side-inner" :class="{ 'shell--min': minified }">
        <nav class="shell__buckets">
          <KNavItem
            v-for="b in buckets"
            :key="b.key"
            :label="t(b.label)"
            :icon="b.icon"
            :count="bucketCounts[b.key]"
            :tip="minified ? t(b.label) : undefined"
            :active="store.selectedBucket === b.key"
            @click="onBucket(b.key)"
          />
        </nav>
        <div class="shell__divider"></div>
        <div class="shell__side-label shell__side-label--row">
          <span>{{ t('common.nav.workspaces') }}</span>
          <button
            class="shell__label-add"
            v-tip="t('common.nav.newWorkspace')"
            :aria-label="t('common.nav.newWorkspace')"
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
          <!-- The drop target is the whole GROUP, not just its header row. Groups are
               expanded by default, so an open workspace's projects occupy most of what the
               user reads as «that workspace» and the thin header is the smaller part of it;
               a release onto the obvious half must not silently do nothing. Bound on the
               <li> rather than on KWorkspaceRow so the header and the list are ONE target
               and one `relatedTarget` boundary — crossing from the row into its own project
               list is then not a leave at all, which is the same child-boundary problem the
               guard already solves for the row's chevron. The highlight cannot smear: only
               KWorkspaceRow styles `dropTarget`, so it renders on the header alone. -->
          <li
            v-for="group in tree"
            :key="group.workspace.id"
            class="shell__group"
            @dragover="onDragOver($event, group.workspace.id)"
            @dragleave="onDragLeave($event, group.workspace.id)"
            @drop.prevent="onDrop(group.workspace.id)"
          >
            <KWorkspaceRow
              :workspace="group.workspace"
              :active="store.selectedWorkspaceId === group.workspace.id && !store.selectedProjectId"
              :expanded="isExpanded(group.workspace.id)"
              :count="workspaceRunningCount(group.workspace.id)"
              :drop-target="dropTargetId === group.workspace.id"
              @select="selectWorkspace(group.workspace.id)"
              @toggle="toggleWorkspace(group.workspace.id)"
              @add-project="openCreateProject(group.workspace.id)"
            />
            <ul
              v-if="isExpanded(group.workspace.id)"
              class="shell__group-items"
              :aria-label="t('common.nav.workspaceProjects', { name: group.workspace.name })"
            >
              <li v-for="p in sidebarProjects.byWorkspace.get(group.workspace.id) ?? []" :key="p.id">
                <KRailItem
                  :project="p"
                  indent
                  :active="p.id === store.selectedProjectId"
                  :count="runningCount(p.id)"
                  :draggable="hasCloudList"
                  @click="selectProject(p.id)"
                  @dragstart="draggingProjectId = $event"
                  @dragend="onDragEnd"
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
            @click="goSettings('app-account')"
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
            v-tip="collapsed ? t('common.nav.expandPanel') : t('common.nav.collapsePanel')"
            :aria-label="collapsed ? t('common.nav.expandPanel') : t('common.nav.collapsePanel')"
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
        <span class="shell__logo">{{ t('common.nav.logo') }}</span>
        <span class="shell__ver mono">v0.1</span>
      </div>
      <KTopNav
        class="shell__nav"
        :model-value="topView"
        :options="topOptions"
        @update:model-value="goView"
      />
      <div class="shell__actions">
        <!-- ONE gear, into pages/SettingsPage.vue. It used to be three controls —
             a workspace ⚙, a project ⚙ and a `$` for the `.env` — each opening its
             own modal; the settings screen holds all three behind a scope switcher,
             so the cluster no longer has to grow a button per scope. The target
             follows the sidebar selection, which is the scope the operator is
             already looking at. -->
        <KIconButton
          :active="route.name === 'settings'"
          :title="settingsHint"
          @click="openSettings"
        >⚙</KIconButton>
        <!-- Theme toggle. Stays in the shell rather than moving into the settings
             screen with the rest of the app scope: it is a one-click answer to
             glare, and «Загальне» carries the same control for whoever looks for it
             where settings live. The glyph names the theme the click moves TO. -->
        <KIconButton
          :title="theme === 'light' ? t('common.nav.themeDark') : t('common.nav.themeLight')"
          @click="onThemeToggle"
        >{{ theme === 'light' ? '☾' : '☀' }}</KIconButton>
      </div>
    </q-header>

    <!-- PAGE -->
    <q-page-container>
      <router-view />
    </q-page-container>

    <!-- STATUS BAR — a VS Code-style footer; for now just git pull for the selected repo.
         There is deliberately no Push: work leaves the machine through «Влити» (merge) and
         the PR flow, never as a blind push of whatever branch the project repo sits on. -->
    <q-footer class="shell__footer">
      <button
        type="button"
        class="shell__foot-btn"
        :disabled="!isBound || syncing"
        v-tip="isBound ? t('common.nav.pullTip') : BIND_HINT"
        aria-label="Pull"
        @click="gitPull"
      >↓ Pull</button>
      <span class="shell__foot-spacer"></span>
      <!-- The path is a STATUS read-out that doubles as the way to change it. It
           used to open the directory picker straight from here, which put the
           binding in two places once the settings screen grew its own; the picker
           lives with the rest of the project's «Основне» now, and this jumps
           there. -->
      <button
        v-if="store.selectedProjectId"
        type="button"
        class="shell__foot-btn shell__foot-folder"
        v-tip="isBound ? t('common.nav.changeInSettings', { label: contextLabel }) : BIND_HINT"
        :aria-label="isBound ? t('common.nav.changeFolder') : t('common.nav.bindFolder')"
        @click="goSettings('project-basics')"
      >
        <span class="shell__foot-folder-path mono">{{ contextLabel }}</span>
      </button>
    </q-footer>


    <!-- CREATE-WORKSPACE MODAL — the sidebar's two «+» buttons create different things, so
         they get two modals. A workspace is the group AND the team: membership hangs off it,
         which is what the hint below says out loud. -->
    <KModal v-model="createWorkspaceOpen" :title="t('common.nav.newWorkspace')">
      <div class="shell__form">
        <KField v-model="createWorkspaceName" :label="t('common.nav.nameLabel')" placeholder="AAA" />
        <p class="shell__hint">
          {{ t('common.nav.workspaceFormHint') }}
        </p>
        <p v-if="createError" class="shell__error" role="alert">{{ createError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="createWorkspaceOpen = false">{{ t('common.nav.cancel') }}</KBtn>
        <KBtn
          variant="primary"
          :disabled="!canCreateWorkspace || createBusy"
          @click="submitCreateWorkspace"
        >
          {{ createBusy ? t('common.nav.creating') : t('common.nav.create') }}
        </KBtn>
      </template>
    </KModal>

    <!-- CREATE-PROJECT MODAL — a project is born in the CLOUD (Requirement 2: any signed-in
         user may create one and becomes its owner) INSIDE a known workspace, which is why the
         open state is that workspace's id rather than a boolean. The local row arrives through
         POST /api/projects/sync and starts out UNBOUND — no directory picker here. -->
    <KModal
      :model-value="createProjectFor !== undefined"
      :title="t('common.nav.newProjectIn', { name: projects.workspaceById.get(createProjectFor ?? '')?.name ?? '' })"
      @update:model-value="createProjectFor = undefined"
    >
      <div class="shell__form">
        <KField v-model="createName" :label="t('common.nav.nameLabel')" placeholder="my-project" />
        <KField
          v-model="createRemote"
          :label="t('common.nav.gitRemoteLabel')"
          placeholder="git@github.com:org/repo.git"
        />
        <p class="shell__hint">
          {{ t('common.nav.projectFormHint') }}
        </p>
        <p v-if="createError" class="shell__error" role="alert">{{ createError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="createProjectFor = undefined">{{ t('common.nav.cancel') }}</KBtn>
        <KBtn variant="primary" :disabled="!canCreate || createBusy" @click="submitCreate">
          {{ createBusy ? t('common.nav.creating') : t('common.nav.create') }}
        </KBtn>
      </template>
    </KModal>

    <!-- TOAST STACK — transient notifications (errors etc.) -->
    <KToast :toasts="store.toasts" @dismiss="store.dismissToast" />

    <!-- JIRA MERGE PROMPT — global on purpose: a shadow task reaches `merged` wherever
         the user happens to be, and the «куди перенести тікет?» question must not depend
         on the board page being open. Renders nothing until such a merge happens. -->
    <JiraMergePrompt />
  </q-layout>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { Session, SessionStatus } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import { useAuth } from 'stores/auth';
import { useBoard } from 'stores/board';
import { IS_PREVIEW } from '../lib/preview';
import { MANAGEMENT_DEFAULT_SECTION } from '@kermanych/core';
import { canDropProject, sessionScopedProjectIds } from '../lib/scope';
import { myBacklogTasks } from '../lib/tasks-view';
import { bucketOf, type Bucket } from '../lib/buckets';
import { theme, toggleTheme } from '../lib/theme';
import { isMoveRefusal, moveRefusalText } from '../lib/cloud-errors';
import { percent, planWindow, renderWindow } from '../lib/format';
import { until, renderTime } from '../lib/time';
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
import KIconButton from 'components/kit/KIconButton.vue';
import KUserButton from 'components/kit/KUserButton.vue';
import JiraMergePrompt from 'components/jira/JiraMergePrompt.vue';

// The Kermanych app shell (design-system section 07): project rail, brand header, page
// container, fleet status bar. Two stores back it — `store` (useOrchestrator) owns the LOCAL
// rows and sessions streamed over the socket, `projects` (useProjects) owns the CLOUD project
// list and membership. The rail is the join of the two.
const store = useOrchestrator();
const projects = useProjects();
const auth = useAuth();
const board = useBoard();
const route = useRoute();
const router = useRouter();
const { t } = useI18n();

// The left sidebar collapses to give the board full width; the choice persists so a reload
// keeps the operator's layout. breakpoint:0 means the drawer never self-closes, so this
// model-value is the only thing that shows/hides it.
const collapsed = ref(localStorage.getItem('kermanych.sidebar-collapsed') === '1');
watch(collapsed, (v) => localStorage.setItem('kermanych.sidebar-collapsed', v ? '1' : '0'));

// The rail's WIDTH tweens (css/app.scss transitions the drawer's inline width), but the
// content swap between labels and icons is a `display` switch that no transition can carry,
// so the two are deliberately out of phase. `minified` LEADS a collapse — the labels leave
// before the box narrows, or they would be clipped and reflowed inside a 76px column on the
// way down — and LAGS an expansion, returning once there is room for them and fading in
// (see the shell-reveal animation). One timer, cleared on re-entry, because a second click
// mid-flight must not later minify a sidebar the operator has re-opened.
const REVEAL_MS = 160;
const minified = ref(collapsed.value);
let revealTimer: ReturnType<typeof setTimeout> | undefined;
watch(collapsed, (v) => {
  clearTimeout(revealTimer);
  if (v) {
    minified.value = true;
    return;
  }
  revealTimer = setTimeout(() => {
    minified.value = false;
  }, REVEAL_MS);
});
onBeforeUnmount(() => clearTimeout(revealTimer));

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
//
// Keyed on `minified`, not `collapsed`: this decides which ROWS render, and rows must appear
// and disappear in step with the styling that shapes them, not one animation frame apart.
function isExpanded(id: string): boolean {
  return minified.value || !isFolded(id);
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
// resolves later — `remove()` re-reads at :1007 and a refused move re-reads at :1540 —
// leaving an authoritative list in hand and unusable.
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
      t('common.nav.notifyOffline', { error: projects.offlineError }),
      'error',
      6000,
    );
  }
});

// The board store is app-wide now: Агенти renders my backlog cards from it and the sidebar
// counts them, so it must be live on every route, not only on /#/board. subscribe() is
// idempotent — BoardPage no longer owns this.
onMounted(() => void board.subscribe());
onUnmounted(() => board.unsubscribe());

// 0 → n only, and it has to live here for the same reason the mount call does: the store
// rebuilds a channel on every project-set change but SKIPS a set that never had one
// (stores/board.ts:287, `!unsubscribeChannel`), so a user whose first cloud project
// appears mid-session would otherwise get no channel until a reload.
watch(
  () => projects.projects.length,
  (count, prev) => {
    if (count && !prev) void board.subscribe();
  },
);

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
  { value: 'agents', label: 'common.nav.viewAgents', route: 'agents', section: 'agents' },
  { value: 'board', label: 'common.nav.viewBoard', route: 'board', section: 'board' },
  { value: 'chat', label: 'common.nav.viewChat', route: 'chat', section: 'chat' },
  {
    value: 'management',
    label: 'common.nav.viewManagement',
    route: MANAGEMENT_DEFAULT_SECTION,
    section: 'management',
  },
] as const;
const topOptions = computed(() => VIEWS.map((v) => ({ value: v.value, label: t(v.label) })));
// Anything outside the table — /kit, /settings — selects NO segment. It used to
// fall back to «Агенти», which put a highlight on a view the operator was not
// looking at: on Налаштування that reads as «you are on Агенти», and the one
// control that could correct it is the highlight itself. KTopNav renders an
// unmatched value by hiding its thumb and parking the tab stop on the first
// segment, so the strip stays usable while claiming nothing.
const topView = computed(
  () => VIEWS.find((v) => route.matched.some((r) => r.name === v.section))?.value ?? '',
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

// The marks are drawn (KIcon), not typed. They only ever show while the rail is minified,
// which is precisely where the label is gone and the mark alone has to say which bucket it
// opens — a job the text glyphs this replaced could not do: ◉ read as a radio button, ☰ as a
// menu, ⤓ as a download and ↺ as a reload.
const buckets = [
  { key: 'active', label: 'common.nav.bucketActive', icon: 'activity' },
  { key: 'waiting', label: 'common.nav.bucketWaiting', icon: 'waiting' },
  { key: 'completed', label: 'common.nav.bucketCompleted', icon: 'done' },
  { key: 'errors', label: 'common.nav.bucketErrors', icon: 'alert' },
  { key: 'tasks', label: 'common.nav.bucketTasks', icon: 'tasks' },
] as const;
function onBucket(key: Bucket): void {
  store.setBucket(key);
  if (route.name !== 'agents') void router.push({ name: 'agents' });
}
// Fleet tally per sidebar bucket (replaces the old footer KStatusBar). Uses bucketOf so the
// rail count and the Агенти list can never disagree about which bucket a session lands in.
//
// Scoped by ASKING the Агенти page's predicate, not by re-deriving it. It used to test
// `s.projectId !== store.selectedProjectId`, which was true while a workspace-only selection
// rendered a blank page and became a falsehood the moment that page started listing a whole
// workspace: every session was skipped and the rail printed «Активні 0 / Задачі 0» two
// columns from a header counting real cards. «Задачі 0» is the costly one — an operator
// scanning the rail concludes the workspace has no backlog and never opens it. One answer in
// one place is the only version of this that stays true.
const bucketCounts = computed(() => {
  const inScope = new Set(
    sessionScopedProjectIds(
      { workspaceId: store.selectedWorkspaceId, projectId: store.selectedProjectId },
      { projects: projects.projects, listRead: projects.listRead },
      store.projectWorkspace,
    ),
  );
  const byId = new Map(store.sessions.map((s) => [s.id, s]));
  const parent = (id: string): Session | undefined => byId.get(id);
  const c: Record<Bucket, number> = { active: 0, waiting: 0, completed: 0, errors: 0, tasks: 0 };
  for (const s of store.sessions) {
    if (!inScope.has(s.projectId)) continue;
    if (s.kind === 'chat') continue;
    c[bucketOf(s, parent)]++;
  }
  // «Задачі» shows two things now: my cloud backlog cards, and any stranded pre-cutover
  // local row. The badge counts both, because a count that disagrees with the list it counts
  // is worse than no count (lib/buckets.ts:2-4). myBacklogTasks applies the same scope, so
  // the set is passed to it rather than re-tested here.
  c.tasks += myBacklogTasks(board.tasks, auth.user?.id ?? '', [...inScope]).length;
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
  hasCloudList.value ? t('common.nav.localOnly') : t('common.nav.workspaceUnknown'),
);

// The group header's badge: what is running anywhere inside it, so a folded workspace still
// says whether it needs attention. Off the rail tiles rather than the cloud group, or the
// badge would read zero for every offline group whose tiles came from the cached map.
function workspaceRunningCount(workspaceId: string): number {
  let n = 0;
  for (const p of sidebarProjects.value.byWorkspace.get(workspaceId) ?? []) n += runningCount(p.id);
  return n;
}

// DRAG A PROJECT INTO ANOTHER WORKSPACE — hand-rolled HTML5 DnD. It is one gesture, and a
// drag-and-drop library would bring its own reactivity model along for it.
//
// The dragged id lives HERE, not in dataTransfer: getData() is unreadable during
// `dragover` (under the protected-mode rules the event exposes only the TYPES), so a
// drop-validity decision taken from dataTransfer would always read an empty payload and
// light up every row. KRailItem still calls setData — that is what makes this a
// standards-conformant drag — and emits the id for this pair of refs.
const draggingProjectId = ref<string | undefined>(undefined);
const dropTargetId = ref<string | undefined>(undefined);

// preventDefault ONLY for a valid destination. That one call is both what permits the drop
// and what turns the cursor from «no» into «move», so cancelling unconditionally would
// accept a release onto the project's OWN workspace and then quietly do nothing — a
// gesture that looks like it worked. An invalid row keeps the browser's refusal cursor.
function onDragOver(e: DragEvent, workspaceId: string): void {
  if (!canDropProject(draggingProjectId.value, workspaceId, projects.projects)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  dropTargetId.value = workspaceId;
}

// `dragleave` BUBBLES, and the row has three children: crossing from its chevron into its
// body arrives here as a leave of the row ITSELF and would clear the border until the next
// `dragover` repainted it — a flicker directly under the cursor. relatedTarget is the
// element being ENTERED, so one still inside the row means the pointer never left.
//
// Chosen over a dragenter/dragleave counter because a counter is state that has to be
// zeroed by hand on drop and on dragend, and any missed reset leaves a row that can no
// longer clear its own border for the rest of the session. This check holds no state.
// relatedTarget is null when the drag leaves the window entirely, which correctly clears.
function onDragLeave(e: DragEvent, workspaceId: string): void {
  const row = e.currentTarget;
  const entering = e.relatedTarget;
  if (row instanceof Node && entering instanceof Node && row.contains(entering)) return;
  if (dropTargetId.value === workspaceId) dropTargetId.value = undefined;
}

function onDragEnd(): void {
  draggingProjectId.value = undefined;
  dropTargetId.value = undefined;
}

async function onDrop(workspaceId: string): Promise<void> {
  const projectId = draggingProjectId.value;
  // Cleared before the validity check and before the await, not after: once a drop has
  // been handled the source's `dragend` is not something to rely on, and the accent
  // border must not outlive the gesture that drew it.
  onDragEnd();
  if (!projectId || !canDropProject(projectId, workspaceId, projects.projects)) return;
  const name = projects.byId.get(projectId)?.name ?? projectId;
  const target = projects.workspaceById.get(workspaceId)?.name ?? '';
  try {
    await projects.moveProject(projectId, workspaceId);
    store.notify(t('common.nav.notifyMoved', { name, target }));
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // 6000 like every other full-sentence refusal here (the bind error, both member
    // errors): moveRefusalText() is a full sentence, and it is the one message a user
    // reads mid-gesture, with their attention on the pointer rather than on the corner of
    // the screen. notify's 4000 default is for confirmations, which are short.
    store.notify(isMoveRefusal(raw) ? moveRefusalText() : raw, 'error', 6000);
    // Nothing optimistic to undo — patch() throws before it touches projects.value. The
    // refetch is about the other direction: a refusal means the server's idea of this
    // tree differs from ours, and re-reading is how the tree stops lying. load() degrades
    // into offlineError rather than throwing, so this cannot reject.
    await projects.load();
  }
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
const BIND_HINT = computed(() => t('common.nav.bindHint'));

// The picker, its three refusals and the write itself moved to
// pages/SettingsPage.vue with the rest of the project's «Основне»: the footer
// path below is a read-out that links there.

const contextLabel = computed(() => {
  if (!store.selectedProjectId) return t('common.nav.noProjectSelected');
  return `${selectedName.value} · ${selectedProject.value?.localRepoPath || t('common.nav.notBound')}`;
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
    store.notify(t('common.nav.notifyWorkspaceCreated', { name: created.name }));
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
    store.notify(t('common.nav.notifyProjectCreated', { name: created.name }));
  } catch (e) {
    // Keep the modal open. The two real refusals are `not signed in` (the session expired
    // between the router guard and this click) and an RLS refusal on a workspace this user
    // has just lost access to; both are fixable without retyping the name.
    createError.value = e instanceof Error ? e.message : String(e);
  } finally {
    createBusy.value = false;
  }
}

// SETTINGS ENTRY. Five modals used to live in this layout — the workspace's name,
// colour and team, the project's config, its `.env`, the project delete and the
// sign-out. They are one screen now (pages/SettingsPage.vue), so the shell keeps
// only the ways IN: the header gear, the footer's folder path and the account
// tile.
//
// The workspace in SCOPE, which the gear falls back to. Set both by a
// workspace-row click and by selecting a project (orchestrator.selectProject
// resolves the group), so it is there whenever anything in the tree is selected.
// Undefined for a workspace the cloud list no longer holds — access revoked
// mid-session — and the gear then lands on the app scope rather than on a group
// we cannot name.
const scopedWorkspace = computed(() =>
  store.selectedWorkspaceId ? projects.workspaceById.get(store.selectedWorkspaceId) : undefined,
);

// Guarded so a second click on the gear — or on the folder path while already on
// «Основне» — is not a fresh navigation onto the same record, which would remount
// the pane and drop an unsaved draft.
function goSettings(section: string): void {
  if (route.name === 'settings' && route.params.section === section) return;
  void router.push({ name: 'settings', params: { section } });
}

// The gear opens the scope the operator is ALREADY looking at: a project if one is
// selected, otherwise its group, otherwise the machine. The scope switcher inside
// the screen covers the rest, which is why the header needs one gear where it used
// to carry two plus a `$`.
function openSettings(): void {
  goSettings(
    store.selectedProjectId
      ? 'project-basics'
      : scopedWorkspace.value
        ? 'workspace-basics'
        : 'app-general',
  );
}

// The gear's tooltip AND its accessible name, one string so they cannot drift:
// KIconButton routes `title` into both `v-tip` and `aria-label`, so this is the
// whole accessible name of an otherwise wordless ⚙. It names the scope it opens,
// which keeps that name inside the accessible name (WCAG 2.5.3, Label in Name) —
// what a voice-control user needs to ask for it.
const settingsHint = computed(() => {
  if (store.selectedProjectId) return t('common.nav.settingsProject', { name: selectedName.value });
  const ws = scopedWorkspace.value;
  return ws ? t('common.nav.settingsWorkspace', { name: ws.name }) : t('common.nav.settingsApp');
});

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
      short: renderWindow(t, planWindow(w.id)),
      percent: percent(w.usedPercent),
      used: w.usedPercent,
    })),
    // The detail the compact row drops: the provider's own window names, the countdown to
    // each reset, and — when omp balances across several accounts — that the figure is their
    // mean rather than one account's.
    hint: [
      p.provider[0]!.toUpperCase() + p.provider.slice(1),
      ...(p.accounts > 1 ? [t('common.nav.accountsAvg', { count: p.accounts })] : []),
      ...p.windows.map(
        (w) =>
          `${w.label}: ${percent(w.usedPercent)}` +
          (w.resetsAt ? t('common.nav.resetsIn', { time: renderTime(t, until(w.resetsAt, planNow.value)) }) : ''),
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
  return [accountName.value, ...(spend ? [spend] : []), t('common.nav.accountSettings')].join(' · ');
});

// Footer git pull for the selected project's bound repo. `syncing` gates the button so a
// double-click cannot fire two operations; git's own output (or refusal) surfaces as a toast.
const syncing = ref(false);
async function gitPull(): Promise<void> {
  const id = store.selectedProjectId;
  if (!id || !isBound.value || syncing.value) return;
  syncing.value = true;
  try {
    const r = await store.pullProject(id);
    if (r.ok) store.notify(`Pull: ${r.out.trim() || t('common.nav.pullDone')}`);
    else store.notify(`Pull: ${r.out.trim() || t('common.nav.pullFailed')}`, 'error', 7000);
  } catch (e) {
    store.notify(`Pull: ${e instanceof Error ? e.message : String(e)}`, 'error', 7000);
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
// Expanded stays label-only, so the leading mark is hidden until the rail is minified.
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
// The whole text column, not just the label inside it: the column is `flex: 1`, so leaving
// it in place would stretch an empty box across the rail and push the mark off centre.
.shell--min :deep(.k-nav-item__text),
.shell--min :deep(.k-count) {
  display: none;
}
// In the rail the mark IS the control — nothing else is left of the row — so it takes the
// largest step of KIcon's scale rather than the 18px default it would use beside a label.
.shell--min :deep(.k-nav-item__icon) {
  --k-icon-size: 20px;
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
// its colour dot as the group's marker and drops the name, the chevron and the end slot
// that carries the count and the «+» — a 76px column has no room for three controls, and
// the group cannot be folded or added to from a strip that cannot show which group it is.
// Because the chevron goes, isExpanded() ignores the folded set while `shell--min` is on:
// hiding the only control that unfolds a group while still honouring the fold would leave
// its projects unreachable.
.shell--min :deep(.k-ws__name),
.shell--min :deep(.k-ws__end),
.shell--min :deep(.k-ws__chevron) {
  display: none;
}
.shell--min :deep(.k-ws__body) {
  justify-content: center;
}
.shell--min :deep(.k-rail--indent) {
  margin-left: 0;
  width: 100%;
}

// The return of the labels. Everything the rail hides is hidden with `display: none`, which
// no transition can tween, so the way back is an ENTRANCE animation: it plays the frame the
// `shell--min` class is dropped — 160ms into the width tween, when the column is already
// wide enough to hold a label — and never again while the sidebar sits open. The collapse
// needs no counterpart: `minified` flips first there, so the labels are gone before the box
// starts narrowing and there is nothing left to fade.
@keyframes shell-reveal {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.shell__side-inner:not(.shell--min) {
  .shell__side-label,
  .shell__account-meta,
  :deep(.k-nav-item__text),
  :deep(.k-count),
  :deep(.k-rail__name),
  :deep(.k-rail__agents),
  :deep(.k-ws__name),
  :deep(.k-ws__end),
  :deep(.k-ws__chevron) {
    animation: shell-reveal 0.14s ease-out;
  }
}
// The row chrome itself does tween: padding and the indent are real lengths, so the marks
// glide to their centred rail positions instead of jumping there a frame before the box does.
:deep(.k-nav-item),
:deep(.k-rail) {
  transition: padding 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}
:deep(.k-rail--indent) {
  transition:
    padding 0.25s cubic-bezier(0.4, 0, 0.2, 1),
    margin-left 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}
@media (prefers-reduced-motion: reduce) {
  .shell__side-inner:not(.shell--min) :deep(*) {
    animation: none;
  }
  :deep(.k-nav-item),
  :deep(.k-rail),
  :deep(.k-rail--indent) {
    transition: none;
  }
}

.shell__buckets {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

// The right margin is 1px, not the 4px on the other three sides: the rows below carry a
// 1px transparent border and this heading does not, so that pixel is what puts this row's
// «+» in the same column as the one on KWorkspaceRow.
.shell__side-label {
  margin: var(--k-sp-3) 1px var(--k-sp-1) var(--k-sp-1);
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

// A 28px-wide glyph box like the row controls, so its «+» centres on the same column as
// KWorkspaceRow's — but only as tall as the heading's own line, which keeps this band the
// height of a caption instead of the height of a row.
.shell__label-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  padding: 0;
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
