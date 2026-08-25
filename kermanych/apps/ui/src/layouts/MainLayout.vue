<template>
  <q-layout view="hHh Lpr lFf" class="shell">
    <!-- LEFT SIDEBAR — bucket nav + projects + folder binding + account (v3 section 07) -->
    <q-drawer :model-value="!collapsed" side="left" :width="264" :breakpoint="0" class="shell__sidebar">
      <div class="shell__side-inner">
        <nav class="shell__buckets">
          <KNavItem
            v-for="b in buckets"
            :key="b.key"
            :label="b.label"
            :count="bucketCounts[b.key]"
            :active="store.selectedBucket === b.key"
            @click="onBucket(b.key)"
          />
        </nav>
        <div class="shell__divider"></div>
        <div class="shell__side-label shell__side-label--row">
          <span>Проєкти</span>
          <button
            class="shell__label-add"
            v-tip="'Новий проєкт у хмарі'"
            aria-label="Новий проєкт у хмарі"
            @click="openCreate"
          >+</button>
        </div>
        <div class="shell__projects">
          <KRailItem
            v-for="p in railProjects"
            :key="p.id"
            :project="p"
            :active="p.id === store.selectedProjectId"
            :count="runningCount(p.id)"
            @click="selectProject(p.id)"
          />
        </div>
        <div v-if="store.selectedProjectId" class="shell__divider"></div>
        <div v-if="store.selectedProjectId" class="shell__folder">
          <div class="shell__side-label">Тека проєкту</div>
          <div class="shell__folder-path mono">{{ contextLabel }}</div>
          <KBtn
            variant="secondary"
            :title="isBound ? 'Змінити локальну теку цього проєкту' : BIND_HINT"
            @click="openBinding"
          >{{ isBound ? 'Змінити теку' : 'Прив’язати теку' }}</KBtn>
        </div>
        <div class="shell__user">
          <KUserButton
            class="shell__account"
            :label="accountLabel"
            :avatar-url="auth.profile?.avatarUrl"
            :title="accountHint"
            @click="accountOpen = true"
          />
          <span class="shell__account-name">{{ accountName }}</span>
          <button
            class="shell__collapse"
            v-tip="'Згорнути панель'"
            aria-label="Згорнути панель"
            @click="collapsed = true"
          >◫</button>
        </div>
      </div>
    </q-drawer>

    <!-- TOP BAR — brand + segmented view nav + project actions (v3) -->
    <q-header class="shell__header">
      <div class="shell__brand">
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
        <KBtn
          variant="icon"
          :title="collapsed ? 'Показати панель' : 'Сховати панель'"
          @click="collapsed = !collapsed"
        >◫</KBtn>
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
      </div>
    </q-header>

    <!-- PAGE -->
    <q-page-container>
      <router-view />
    </q-page-container>


    <!-- CREATE-PROJECT MODAL — a project is born in the CLOUD (Requirement 2: any signed-in
         user may create one and becomes its owner). The local row arrives through
         POST /api/projects/sync and starts out UNBOUND — no directory picker here. -->
    <KModal v-model="createOpen" title="Новий проєкт у хмарі">
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
        <KBtn variant="ghost" @click="createOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="!canCreate || createBusy" @click="submitCreate">
          Створити
        </KBtn>
      </template>
    </KModal>

    <!-- PROJECT-SETTINGS MODAL — CLOUD config (name, colour, conventions, commands, carry
         files) plus this machine's read-only binding. Config writes go to Supabase and are
         mirrored into the local row; they are owner-only (design D1, Requirement 2). -->
    <KModal v-model="settingsOpen" :title="`Редагувати проєкт · ${selectedName}`">
      <div class="shell__form">
        <KField
          v-model="nameEdit"
          label="Назва проєкту"
          placeholder="my-project"
          :disabled="!isOwnerOfSelected"
        />
        <KColorPicker
          v-model="colorEdit"
          label="Колір проєкту"
          :class="{ 'shell__readonly': !isOwnerOfSelected }"
        />
        <KSelect
          v-model="defaultBranchEdit"
          label="Гілка за замовчуванням"
          :options="settingsBranches"
          :disabled="!isBound || !isOwnerOfSelected"
          placeholder="— поточна гілка репозиторію —"
        />
        <KField
          v-model="conventionsEdit"
          label="Конвенції PR/комітів (фолбек, якщо в репо немає)"
          placeholder="Порожнє — Керманич підставить власні дефолти"
          multiline
          :rows="6"
          :disabled="!isOwnerOfSelected"
        />
        <KField
          v-model="previewCommandEdit"
          label="Команда превʼю (веб)"
          placeholder="pnpm dev --port $PORT"
          :disabled="!isOwnerOfSelected"
        />
        <KField
          v-model="apiCommandEdit"
          label="Команда превʼю (API, необовʼязково)"
          placeholder="pnpm dev:api"
          :disabled="!isOwnerOfSelected"
        />
        <KField
          v-model="carryFilesText"
          label="Файли для сесії (через кому)"
          placeholder=".env"
          :disabled="!isOwnerOfSelected"
        />
        <p v-if="!isOwnerOfSelected" class="shell__hint">
          Налаштування проєкту спільні для команди — змінювати їх може лише власник.
          Прив’язка теки й «Змінні середовища» — ваші, для цієї машини, і залишаються доступними.
        </p>
        <KField
          :model-value="selectedProject?.localRepoPath || 'не прив’язано'"
          label="Локальна тека цієї машини"
          disabled
        />
        <!-- MEMBERS — cloud membership. Any member invites by email (invite_project_member);
             removal stays owner-only. RLS and the rpc enforce both; this is UX. -->
        <div class="shell__members">
          <span class="shell__members-label">Учасники</span>
          <div v-if="membersLoading" class="shell__hint mono">Завантаження…</div>
          <div v-for="m in members" :key="m.userId" class="shell__member">
            <img
              v-if="m.profile?.avatarUrl"
              class="shell__member-avatar"
              :src="m.profile.avatarUrl"
              :alt="m.profile.githubUsername ?? ''"
            />
            <span v-else class="shell__member-avatar shell__member-avatar--blank mono">?</span>
            <span class="shell__member-name mono">
              @{{ m.profile?.githubUsername ?? m.userId.slice(0, 8) }}
            </span>
            <KTag>{{ m.role === 'owner' ? 'власник' : 'учасник' }}</KTag>
            <KBtn
              v-if="isOwnerOfSelected && m.role !== 'owner'"
              variant="ghost"
              title="Вилучити з проєкту"
              @click="removeMemberOf(m)"
            >✕</KBtn>
          </div>
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
            >Запросити</KBtn>
          </div>
          <p class="shell__hint">
            Запросити може будь-який учасник — за адресою, якою колега входить у Керманич.
            Вилучати учасників може лише власник.
          </p>
        </div>
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
        <KBtn variant="primary" :disabled="!isOwnerOfSelected" @click="saveSettings">Зберегти</KBtn>
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
          v-if="isOwnerOfSelected"
          v-model="envKeysText"
          label="Обовʼязкові ключі — лише ІМЕНА (через кому або з нового рядка)"
          placeholder="GITHUB_TOKEN, DATABASE_URL"
          multiline
          :rows="3"
        />
        <p class="shell__hint">
          У хмарі зберігаються лише імена ключів. Значення живуть у `.env` цієї машини й нікуди
          не передаються.
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
import type { ProjectMember } from '@kermanych/cloud';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import { useAuth } from 'stores/auth';
import { IS_PREVIEW } from '../lib/preview';
import KRailItem, { type RailProject } from 'components/kit/KRailItem.vue';
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

// A rail tile means «show me this project», and the only page that shows one is the
// workspace. Clicked from the team board it used to change the selection behind a screen
// that never reflects it — the tile went active, nothing else moved, and the board had no
// exit of its own. Selecting is still the primary act; the navigation only follows when the
// current page is not the one that answers it.
function selectProject(id: string): void {
  store.selectProject(id);
  if (route.name !== 'workspace') void router.push({ name: 'workspace' });
}

// True only once a cloud read has actually succeeded on this run. Until then a local row
// absent from the (still empty) cloud list is an unread cache, not an orphan — labelling
// every project «поза хмарою» on a cold or offline boot would be a lie.
const cloudSynced = ref(false);

onMounted(async () => {
  // Socket first: the snapshot, and the project_update events the sync inside load() emits,
  // are how LOCAL rows reach the rail. Connecting afterwards would race those events.
  store.connect();
  // The router guard already keeps this layout signed-in-only, but on a cold start `ready`
  // may still be pending, and useProjects() needs the session for RLS to return any row.
  await auth.ready;
  // A preview has no cloud (lib/preview.ts): skip the read entirely. Leaving `cloudSynced`
  // false is the point — a successful-looking sync would label every seeded local row
  // «поза хмарою», and load()'s prune would run against an empty project list.
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
    return;
  }
  cloudSynced.value = true;
});

// A session is "running" while it is queued or actively working; waiting means it is blocking
// on an interactive UI request; done is terminal-success.
const RUNNING: readonly SessionStatus[] = ['queued', 'thinking', 'tool'];

function sessionsOf(projectId: string | undefined) {
  return store.sessions.filter((s) => s.projectId === projectId && !s.archived);
}

function runningCount(projectId: string): number {
  return sessionsOf(projectId).filter((s) => s.kind !== 'chat' && RUNNING.includes(s.status)).length;
}

const topOptions = [
  { value: 'agents', label: 'Агенти' },
  { value: 'board', label: 'Дошка' },
  { value: 'chat', label: 'Чат' },
];
const topView = computed(() =>
  route.name === 'board' ? 'board' : route.name === 'chat' ? 'chat' : 'agents',
);
function goView(v: string): void {
  const name = v === 'board' ? 'board' : v === 'chat' ? 'chat' : 'workspace';
  if (route.name !== name) void router.push({ name });
}

const buckets = [
  { key: 'active', label: 'Активні' },
  { key: 'tasks', label: 'Задачі' },
  { key: 'archived', label: 'Відкладені' },
  { key: 'history', label: 'Історія' },
] as const;
function onBucket(key: 'active' | 'tasks' | 'archived' | 'history'): void {
  store.setBucket(key);
  if (route.name !== 'workspace') void router.push({ name: 'workspace' });
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

// The rail: the CLOUD list (what exists, for everyone) in cloud order, then every LOCAL row
// the cloud list does not contain. Those trailing rows matter — sync's prune deliberately
// keeps a row that still owns sessions, and agents you cannot select are agents you cannot
// stop. A cloud project with no local row at all (the mount-time sync failed) shows as
// unbound, which is exactly what it is: nothing on this machine can run it yet.
const railProjects = computed<RailProject[]>(() => {
  const local = new Map(store.projects.map((p) => [p.id, p]));
  const out: RailProject[] = [];
  for (const c of projects.projects) {
    const row = local.get(c.id);
    local.delete(c.id);
    out.push({
      id: c.id,
      name: c.name,
      color: c.color ?? row?.color,
      state: row?.localRepoPath ? 'bound' : 'unbound',
    });
  }
  for (const row of local.values()) {
    out.push({
      id: row.id,
      name: row.name,
      color: row.color,
      state: cloudSynced.value ? 'orphan' : row.localRepoPath ? 'bound' : 'unbound',
    });
  }
  return out;
});

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

// Create-in-the-cloud modal. No directory field: creating a project and binding a repo are
// different acts on different machines (Requirement 3).
const createOpen = ref(false);
const createName = ref('');
const createRemote = ref('');
const createError = ref<string | null>(null);
const createBusy = ref(false);
const canCreate = computed(() => createName.value.trim() !== '');

function openCreate(): void {
  createName.value = '';
  createRemote.value = '';
  createError.value = null;
  createBusy.value = false;
  createOpen.value = true;
}

async function submitCreate(): Promise<void> {
  if (!canCreate.value) return;
  createError.value = null;
  createBusy.value = true;
  try {
    const remote = createRemote.value.trim();
    // create() inserts under the user's JWT (handle_new_project adds the owner membership)
    // and mirrors the one new project into the local registry, so its tile appears without a
    // second full sync.
    const created = await projects.create(createName.value.trim(), remote || undefined);
    createOpen.value = false;
    store.selectProject(created.id);
    store.notify(`Проєкт «${created.name}» створено у хмарі`);
  } catch (e) {
    // Keep the modal open. The two real refusals are `not signed in` (the session expired
    // between the router guard and this click) and a postgrest/RLS or network failure; both
    // are fixable without retyping the name.
    createError.value = e instanceof Error ? e.message : String(e);
  } finally {
    createBusy.value = false;
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

const membersLoading = ref(false);
const memberEmail = ref('');
const memberBusy = ref(false);

// `members` is keyed by project id and may be missing entirely before the first read, so the
// `?? []` is load-bearing (noUncheckedIndexedAccess is on).
const members = computed<ProjectMember[]>(() =>
  store.selectedProjectId ? projects.members[store.selectedProjectId] ?? [] : [],
);

// UX only. Every owner-only path (project config, env-key names, removing a member) is
// enforced by the owner-scoped RLS policies; this just keeps the UI from offering a write
// that Postgres will refuse. Inviting is NOT owner-only — any member may.
const isOwnerOfSelected = computed(
  () => !!store.selectedProjectId && projects.isOwner(store.selectedProjectId),
);

// Both separators are accepted, but only the multiline env-keys textarea can actually receive
// a newline; the single-line carry-files input strips them, so its label promises commas only.
function parseList(text: string): string[] {
  return text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

// The refusals a membership write really produces. The first three come from
// invite_project_member / the cloud client, the fourth from the owner-only DELETE policy.
// Everything else is shown verbatim.
function memberErrorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (raw.includes('no Kermanych account for')) {
    return 'Немає акаунта Керманича з такою адресою — попросіть колегу спершу увійти через GitHub';
  }
  if (raw.includes('not a valid email address')) {
    return 'Це не схоже на імейл — запрошуємо за адресою, якою колега входить у Керманич';
  }
  if (raw.includes('only a project member can invite')) {
    return 'Хмара відмовила: запрошувати може лише учасник проєкту';
  }
  if (raw.includes('violates row-level security policy')) {
    return 'Хмара відмовила: вилучати учасників може лише власник проєкту';
  }
  return raw;
}

async function submitMember(): Promise<void> {
  const id = store.selectedProjectId;
  const email = memberEmail.value.trim();
  if (!id || !email) return;
  memberBusy.value = true;
  try {
    const invited = await projects.inviteMember(id, email);
    memberEmail.value = '';
    // Name WHO the address resolved to: the panel lists github handles, so this is the
    // caller's confirmation that the invite landed on the person they meant.
    store.notify(`@${invited.profile?.githubUsername ?? email} у проєкті`);
  } catch (e) {
    store.notify(memberErrorText(e), 'error', 6000);
  } finally {
    memberBusy.value = false;
  }
}

async function removeMemberOf(m: ProjectMember): Promise<void> {
  const id = store.selectedProjectId;
  if (!id) return;
  const who = m.profile?.githubUsername ?? m.userId;
  if (!window.confirm(`Вилучити @${who} з проєкту «${selectedName.value}»?`)) return;
  try {
    await projects.removeMember(id, m.userId);
    // A DELETE the owner-only policy refuses does NOT error — it matches zero rows, while the
    // store has already dropped the row locally. Re-read so the panel cannot show a removal
    // that never happened.
    const after = await projects.loadMembers(id);
    if (after.some((x) => x.userId === m.userId)) {
      store.notify('Хмара відмовила: керувати складом учасників може лише власник проєкту', 'error', 6000);
      return;
    }
    store.notify(`@${who} вилучено з проєкту`);
  } catch (e) {
    store.notify(memberErrorText(e), 'error', 6000);
  }
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
  memberEmail.value = '';
  membersLoading.value = true;
  try {
    await projects.loadMembers(id);
  } catch (e) {
    // Non-fatal: the panel stays empty and says why. Config editing still works.
    store.notify(`Не вдалось прочитати учасників: ${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    membersLoading.value = false;
  }
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
  if (!isOwnerOfSelected.value) {
    settingsError.value = 'Змінювати налаштування проєкту може лише власник';
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
    // We believed this write was allowed, so the raw message is the useful part: an expired
    // session, an unreachable cloud, or ownership that changed under us.
    settingsError.value = `Хмара відмовила у записі: ${e instanceof Error ? e.message : String(e)}`;
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
    // NAMES: the cloud checklist, owner-only. Sent only when the owner actually changed it, so
    // a member saving values never attempts a project write it cannot make.
    if (isOwnerOfSelected.value) {
      const next = parseList(envKeysText.value);
      const current = selectedCloud.value?.envKeys ?? [];
      if (next.join('\n') !== current.join('\n')) await projects.patch(id, { envKeys: next });
    }
    envOpen.value = false;
  } catch (e) {
    envError.value = e instanceof Error ? e.message : String(e);
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

// The tile is a bare picture, so its tooltip carries the action as well as the identity.
const accountHint = computed(() => `${accountName.value} · вийти`);

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

.shell__projects {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-1);
}

.shell__add {
  align-self: flex-start;
  margin-top: var(--k-sp-1);
}

.shell__folder {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}

.shell__folder-path {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
  overflow-wrap: anywhere;
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

.shell__folder :deep(.k-btn) {
  width: 100%;
  justify-content: center;
}

// account chip — pinned to the foot of the sidebar: avatar, name, collapse toggle.
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

.shell__account-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-medium);
  color: var(--k-text);
}

.shell__collapse {
  flex: none;
  padding: var(--k-sp-1);
  background: none;
  border: none;
  color: var(--k-faint);
  font-size: var(--k-fs-md);
  line-height: 1;
  cursor: pointer;
}

.shell__collapse:hover {
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
  align-items: baseline;
  gap: var(--k-sp-2);
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
</style>
