<template>
  <KModal
    :model-value="true"
    :title="title"
    :persistent="locked"
    width="min(620px, 94vw)"
    @update:model-value="(v: boolean) => { if (!v) close(); }"
  >
    <template #head-meta>
      <span class="wiz__count mono">{{ t('onboarding.wizard.stepOf', { n: stepIndex + 1, total: STEPS.length }) }}</span>
    </template>

    <div class="wiz">
      <ol class="wiz__steps">
        <li
          v-for="(s, i) in STEPS"
          :key="s"
          class="wiz__step"
          :class="{ 'wiz__step--on': s === step, 'wiz__step--past': i < stepIndex }"
        >
          <span class="wiz__step-num mono">{{ i < stepIndex ? '✓' : i + 1 }}</span>
          <span>{{ t(`onboarding.wizard.steps.${s}`) }}</span>
        </li>
      </ol>

      <!-- ── 1 · ДОСТУП ДО GIT ────────────────────────────────────────────── -->
      <section v-if="step === 'token'" class="wiz__body">
        <p class="wiz__lead">{{ t('onboarding.wizard.token.lead') }}</p>
        <KField
          v-model="token"
          type="password"
          :label="t('onboarding.wizard.token.label')"
          placeholder="github_pat_…"
        />
        <div class="wiz__row">
          <KBtn :loading="checkingToken" :disabled="!tokenValue" @click="checkToken()">{{ t('onboarding.wizard.token.check') }}</KBtn>
          <a class="wiz__link" :href="TOKEN_URL" target="_blank" rel="noopener">{{ t('onboarding.wizard.token.create') }}</a>
        </div>
        <p class="wiz__hint">{{ t('onboarding.wizard.token.rights') }}</p>
        <p v-if="tokenLogin" class="wiz__ok">{{ t('onboarding.wizard.token.belongs', { login: tokenLogin }) }}</p>
        <p v-else-if="tokenError" class="wiz__error" role="alert">{{ tokenError }}</p>

        <!-- Another project on this machine already has a token: offer it instead of a new one. -->
        <KSkeleton v-if="sourcesPhase === 'skeleton'" variant="line" width="60%" />
        <div v-else-if="sourcesPhase === 'ready' && tokenSources && tokenSources.length > 0" class="wiz__sources">
          <KBtn
            v-for="s in tokenSources"
            :key="s.id"
            variant="ghost"
            @click="takeSource(s.token)"
          >{{ t('onboarding.wizard.token.reuse', { name: s.name }) }}</KBtn>
        </div>

        <p class="wiz__warn">{{ t('onboarding.wizard.token.skipWarn') }}</p>
        <button v-if="mode === 'create'" type="button" class="wiz__quick" @click="emit('quick')">
          {{ t('onboarding.wizard.quick') }}
        </button>
      </section>

      <!-- ── 2 · РЕПОЗИТОРІЙ ──────────────────────────────────────────────── -->
      <section v-else-if="step === 'repo'" class="wiz__body">
        <KTabs :model-value="source" :tabs="sourceTabs" @update:model-value="pickSource" />

        <template v-if="source === 'github'">
          <div v-if="!tokenValue" class="wiz__empty">
            <p class="wiz__hint">{{ t('onboarding.wizard.repo.githubNeedsToken') }}</p>
            <KBtn @click="step = 'token'">{{ t('onboarding.wizard.repo.toToken') }}</KBtn>
          </div>
          <template v-else>
            <KField v-model="repoQuery" :placeholder="t('onboarding.wizard.repo.search')" />
            <p v-if="reposError" class="wiz__error" role="alert">{{ reposError }}</p>
            <KSkeleton v-else-if="reposPhase === 'skeleton'" variant="rows" :rows="4" />
            <template v-else-if="reposPhase === 'ready' && repos">
              <p v-if="filteredRepos.length === 0" class="wiz__hint">
                {{ repos.length === 0 ? t('onboarding.wizard.repo.noRepos') : t('onboarding.wizard.repo.noMatch') }}
              </p>
              <div v-else class="wiz__repos" role="listbox">
                <button
                  v-for="r in filteredRepos"
                  :key="r.fullName"
                  type="button"
                  role="option"
                  class="wiz__repo"
                  :class="{ 'wiz__repo--on': selectedRepo?.fullName === r.fullName }"
                  :aria-selected="selectedRepo?.fullName === r.fullName"
                  @click="selectedRepo = r"
                >
                  <span class="wiz__repo-name mono">{{ r.fullName }}</span>
                  <KTag v-if="r.private" plain>{{ t('onboarding.wizard.repo.private') }}</KTag>
                  <span v-if="r.description" class="wiz__repo-desc">{{ r.description }}</span>
                </button>
              </div>
            </template>
          </template>
        </template>

        <template v-else-if="source === 'url'">
          <KField
            v-model="urlInput"
            :label="t('onboarding.wizard.repo.urlLabel')"
            placeholder="https://github.com/org/repo.git"
          />
          <p class="wiz__hint">{{ t('onboarding.wizard.repo.urlHint') }}</p>
          <p v-if="mode === 'connect'" class="wiz__hint">{{ t('onboarding.wizard.repo.urlSaved') }}</p>
        </template>

        <template v-else-if="source === 'remote'">
          <p class="wiz__lead">{{ t('onboarding.wizard.repo.remoteLead') }}</p>
          <p class="wiz__path mono">{{ projectRemote }}</p>
        </template>

        <template v-else>
          <p class="wiz__lead">{{ t('onboarding.wizard.repo.localLead') }}</p>
          <div class="wiz__row">
            <span class="wiz__path mono" :class="{ 'wiz__path--empty': !localPath }">{{ localPath || t('onboarding.wizard.repo.noFolder') }}</span>
            <KBtn :loading="inspecting" @click="pickerFor = 'local'">{{ t('onboarding.wizard.pick') }}</KBtn>
          </div>
          <template v-if="inspected">
            <p v-if="!inspected.isRepo" class="wiz__error" role="alert">{{ t('onboarding.wizard.repo.notRepo') }}</p>
            <template v-else>
              <p class="wiz__hint">
                {{ t('onboarding.wizard.repo.inspected', { origin: inspected.origin || t('onboarding.wizard.repo.noOrigin'), branch: inspected.branch || '—' }) }}
              </p>
              <p v-if="remoteMismatch" class="wiz__warn">{{ t('onboarding.wizard.repo.mismatch', { remote: projectRemote }) }}</p>
            </template>
          </template>
          <p v-else-if="inspectError" class="wiz__error" role="alert">{{ inspectError }}</p>
        </template>

        <p v-if="repoError" class="wiz__error" role="alert">{{ repoError }}</p>
      </section>

      <!-- ── 3 · КУДИ І ЯК ────────────────────────────────────────────────── -->
      <section v-else-if="step === 'place'" class="wiz__body">
        <template v-if="cloning">
          <span class="wiz__label">{{ t('onboarding.wizard.place.parent') }}</span>
          <div class="wiz__row">
            <span class="wiz__path mono" :class="{ 'wiz__path--empty': !parentDir }">{{ parentDir || t('onboarding.wizard.repo.noFolder') }}</span>
            <KBtn @click="pickerFor = 'parent'">{{ t('onboarding.wizard.pick') }}</KBtn>
          </div>
          <KField v-model="dirName" :label="t('onboarding.wizard.place.dirName')" />
          <p class="wiz__hint">
            {{ t('onboarding.wizard.place.result') }} <span class="mono">{{ targetPath || '—' }}</span>
          </p>
        </template>
        <p v-else class="wiz__hint">
          {{ t('onboarding.wizard.place.localFolder') }} <span class="mono">{{ inspected?.path }}</span>
        </p>

        <template v-if="mode === 'create'">
          <KField v-model="name" :label="t('onboarding.wizard.place.name')" />
          <KColorPicker v-model="color" :label="t('settings.project.color')" />
          <KSelect v-model="platform" :label="t('settings.project.platform')" :options="platformOptions" />
          <KField v-model="branch" :label="t('onboarding.wizard.place.branch')" placeholder="main" />
        </template>
        <dl v-else class="wiz__facts">
          <dt>{{ t('onboarding.wizard.place.name') }}</dt>
          <dd>
            <span v-if="connectColor" class="wiz__swatch" :style="{ background: connectColor }" aria-hidden="true"></span>
            {{ connectName }}
          </dd>
          <dt>{{ t('settings.project.platform') }}</dt>
          <dd>{{ connectPlatform }}</dd>
        </dl>
        <p v-if="placeError" class="wiz__error" role="alert">{{ placeError }}</p>
      </section>

      <!-- ── 4 · СТВОРЕННЯ ────────────────────────────────────────────────── -->
      <section v-else class="wiz__body">
        <ul class="wiz__stages">
          <li v-for="key in stageKeys" :key="key" class="wiz__stage" :class="`wiz__stage--${stages[key]}`">
            <span class="wiz__stage-mark" aria-hidden="true">
              <KSpinner v-if="stages[key] === 'running'" />
              <template v-else>{{ STAGE_MARK[stages[key]] }}</template>
            </span>
            <span class="wiz__stage-label">{{ t(`onboarding.wizard.stages.${key}`) }}</span>
            <span v-if="key === 'clone' && stages.clone === 'running' && cloneState" class="wiz__stage-meta mono">
              {{ cloneState.stage ?? t('onboarding.wizard.create.starting') }}{{ cloneState.percent != null ? ` · ${cloneState.percent}%` : '' }}
            </span>
          </li>
        </ul>
        <div v-if="stages.clone === 'running' && cloneState?.percent != null" class="wiz__bar">
          <div class="wiz__bar-fill" :style="{ width: `${cloneState.percent}%` }"></div>
        </div>

        <template v-if="failure">
          <p class="wiz__error" role="alert">{{ failure.message }}</p>
          <pre v-if="failure.output" class="wiz__output mono">{{ failure.output }}</pre>
        </template>

        <template v-if="finished">
          <p class="wiz__ok">{{ t('onboarding.wizard.done.title') }}</p>
          <p class="wiz__hint">
            {{ t('onboarding.wizard.done.path') }} <span class="mono">{{ repoPath }}</span>
          </p>
        </template>
      </section>
    </div>

    <template #controls>
      <template v-if="step === 'token'">
        <KBtn variant="ghost" @click="close()">{{ t('common.nav.cancel') }}</KBtn>
        <KBtn variant="ghost" @click="skipToken()">{{ t('onboarding.wizard.token.skip') }}</KBtn>
        <KBtn variant="primary" :disabled="!tokenValue || checkingToken" @click="toRepo()">{{ t('onboarding.wizard.next') }}</KBtn>
      </template>
      <template v-else-if="step === 'repo'">
        <KBtn variant="ghost" :disabled="leavingRepo" @click="step = 'token'">{{ t('onboarding.wizard.back') }}</KBtn>
        <KBtn variant="primary" :disabled="!canLeaveRepo" :loading="leavingRepo" @click="leaveRepo()">{{ t('onboarding.wizard.next') }}</KBtn>
      </template>
      <template v-else-if="step === 'place'">
        <KBtn variant="ghost" @click="step = 'repo'">{{ t('onboarding.wizard.back') }}</KBtn>
        <KBtn variant="primary" :disabled="!canStart" @click="start()">
          {{ mode === 'create' ? t('onboarding.wizard.place.create') : t('onboarding.wizard.place.connect') }}
        </KBtn>
      </template>
      <template v-else-if="stages.clone === 'running'">
        <!-- While git runs, cancelling is the only way out: it stops the clone and removes the
             folder it was writing. -->
        <KBtn variant="ghost" :loading="cancelling" @click="cancelClone()">{{ t('onboarding.wizard.create.cancel') }}</KBtn>
      </template>
      <template v-else-if="failure">
        <KBtn variant="ghost" @click="close()">{{ t('onboarding.wizard.close') }}</KBtn>
        <KBtn v-if="failure.stage === 'clone'" variant="ghost" @click="step = 'place'">{{ t('onboarding.wizard.back') }}</KBtn>
        <KBtn v-if="failure.authFailed" variant="primary" @click="step = 'token'">{{ t('onboarding.wizard.create.toToken') }}</KBtn>
        <KBtn v-else variant="primary" :loading="creating" @click="runCreation()">{{ t('onboarding.wizard.create.retry') }}</KBtn>
      </template>
      <template v-else-if="finished">
        <KBtn variant="ghost" @click="close()">{{ t('onboarding.wizard.close') }}</KBtn>
        <KBtn variant="primary" @click="emit('done', resultProjectId)">{{ doneLabel || t('onboarding.wizard.done.firstTask') }}</KBtn>
      </template>
    </template>
  </KModal>

  <KDirPicker
    :model-value="pickerFor !== null"
    :start="pickerFor === 'local' ? localPath || parentDir : parentDir"
    @update:model-value="(v: boolean) => { if (!v) pickerFor = null; }"
    @select="onPicked"
  />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { isPlatform, repoDirName, sameRemote } from '@kermanych/core';
import type { GitCloneState, GitInspect, GithubRepo } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import { api, ApiError } from '../../lib/api';
import { PLATFORM_CHOICES } from '../../lib/settings';
import { useAsyncAction, errorText } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import KModal from 'components/kit/KModal.vue';
import KBtn from 'components/kit/KBtn.vue';
import KField from 'components/kit/KField.vue';
import KSelect from 'components/kit/KSelect.vue';
import KTabs from 'components/kit/KTabs.vue';
import KTag from 'components/kit/KTag.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import KSpinner from 'components/kit/KSpinner.vue';
import KColorPicker from 'components/kit/KColorPicker.vue';
import KDirPicker from 'components/kit/KDirPicker.vue';

// The project wizard (docs/specs/2026-11-18-first-run-and-project-wizard.md, decisions 3, 6, 7):
// git access → repository → where and how → creation. `create` makes a new cloud project in
// `workspaceId`; `connect` brings the existing `projectId` onto this machine and never touches
// its name, colour or platform. The host mounts it fresh for every open (v-if + key), so no
// state survives from one run to the next.
const props = defineProps<{
  mode: 'create' | 'connect';
  workspaceId?: string | undefined;
  projectId?: string | undefined;
  // The final button's label when the host continues with something of its own.
  doneLabel?: string | undefined;
}>();
const emit = defineEmits<{ close: []; done: [projectId: string]; quick: [] }>();

const { t } = useI18n();
const store = useOrchestrator();
const projects = useProjects();

// Fine-grained tokens: the page lets the operator pick the repository and the three rights
// the hint below names.
const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

type Step = 'token' | 'repo' | 'place' | 'create';
const STEPS: readonly Step[] = ['token', 'repo', 'place', 'create'];
const step = ref<Step>('token');
const stepIndex = computed(() => STEPS.indexOf(step.value));

// ── The project being connected ─────────────────────────────────────────────
const cloudProject = computed(() => (props.projectId ? projects.byId.get(props.projectId) : undefined));
const localProject = computed(() => (props.projectId ? store.projects.find((p) => p.id === props.projectId) : undefined));
const projectRemote = computed(() => cloudProject.value?.gitRemoteUrl ?? '');
const connectName = computed(() => cloudProject.value?.name ?? localProject.value?.name ?? '');
const connectColor = computed(() => cloudProject.value?.color ?? localProject.value?.color ?? '');
const connectPlatform = computed(() => {
  const p = cloudProject.value?.platform ?? localProject.value?.platform ?? '';
  return t(PLATFORM_CHOICES.find((c) => c.value === p)?.labelKey ?? 'settings.project.platformChoice.none');
});

const title = computed(() =>
  props.mode === 'create'
    ? t('onboarding.wizard.titleCreate', { workspace: projects.workspaceById.get(props.workspaceId ?? '')?.name ?? '' })
    : t('onboarding.wizard.titleConnect', { name: connectName.value }),
);

// The api's refusals that have a plainer sentence here; anything else shows as it came.
// `token_invalid` and friends arrive as the error's message (the api throws them as words).
const REFUSALS: Record<string, string> = {
  token_invalid: 'onboarding.wizard.errors.tokenInvalid',
  github_rate_limited: 'onboarding.wizard.errors.rateLimited',
  target_not_empty: 'onboarding.wizard.errors.targetNotEmpty',
  invalid_clone_request: 'onboarding.wizard.errors.invalidClone',
  'local repo path cannot be empty': 'settings.binding.emptyPath',
  'local repo path is not a git repo': 'settings.binding.notGitRepo',
  'project not found': 'settings.binding.projectNotFound',
};

function refusal(e: unknown): string {
  // `fetch` rejects with a TypeError when the local api is not answering at all.
  if (e instanceof TypeError) return t('onboarding.wizard.errors.unreachable');
  const raw = e instanceof ApiError ? (e.code ?? e.serverMessage) : errorText(e);
  const key = REFUSALS[raw];
  return key ? t(key) : errorText(e);
}

// ── 1 · Git access ──────────────────────────────────────────────────────────
const token = ref('');
const tokenValue = computed(() => token.value.trim());
// Remembered with the token it was checked for, so editing the field drops the «@login» line.
const checked = ref<{ token: string; login: string } | null>(null);
const tokenLogin = computed(() => (checked.value?.token === tokenValue.value ? checked.value.login : ''));
const tokenError = ref('');
watch(tokenValue, () => (tokenError.value = ''));

const { run: checkToken, busy: checkingToken } = useAsyncAction(
  async () => {
    const value = tokenValue.value;
    if (!value) return;
    tokenError.value = '';
    const { login } = await api.githubTokenCheck(value);
    checked.value = { token: value, login };
  },
  { onError: (e) => (tokenError.value = refusal(e)) },
);

// «Використати токен з проєкту X»: every other project bound here whose `.env` has GIT_TOKEN.
// Undefined until read; a project whose `.env` cannot be read is simply not offered.
type TokenSource = { id: string; name: string; token: string };
const tokenSources = ref<TokenSource[] | undefined>(undefined);
const sourcesPhase = useLoadPhase(() => tokenSources.value === undefined);

async function readTokenSources(): Promise<void> {
  const bound = store.projects.filter((p) => p.localRepoPath && p.id !== props.projectId);
  const read = await Promise.allSettled(
    bound.map(async (p): Promise<TokenSource | null> => {
      const env = await api.getEnv(p.id);
      const value = env.entries.find((e) => e.key === 'GIT_TOKEN')?.value.trim();
      return value ? { id: p.id, name: projects.byId.get(p.id)?.name ?? p.name, token: value } : null;
    }),
  );
  tokenSources.value = read.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
}

function takeSource(value: string): void {
  token.value = value;
  void checkToken();
}

function skipToken(): void {
  token.value = '';
  toRepo();
}

// The first arrival at step 2 picks its tab; later arrivals (back from a refused clone) keep
// the one the operator chose.
let sourceChosen = false;
function toRepo(): void {
  // The GitHub list needs a token; without one the URL tab is the sensible first view.
  if (props.mode === 'create' && !sourceChosen) source.value = tokenValue.value ? 'github' : 'url';
  sourceChosen = true;
  step.value = 'repo';
}

// ── 2 · Repository ──────────────────────────────────────────────────────────
type Source = 'github' | 'url' | 'remote' | 'local';
const source = ref<Source>(props.mode === 'create' ? 'github' : projectRemote.value ? 'remote' : 'url');
const sourceTabs = computed(() => {
  const keys: Source[] =
    props.mode === 'create' ? ['github', 'url', 'local'] : projectRemote.value ? ['remote', 'local'] : ['url', 'local'];
  return keys.map((value) => ({ value, label: t(`onboarding.wizard.repo.tabs.${value}`) }));
});
// KTabs speaks plain strings; only a tab this mode offers is taken.
function pickSource(value: string): void {
  const tab = sourceTabs.value.find((s) => s.value === value);
  if (tab) source.value = tab.value;
}
const repoError = ref('');
watch(source, () => (repoError.value = ''));

// GitHub: the repositories the token can read, read once per token.
const repos = ref<GithubRepo[] | undefined>(undefined);
const reposFor = ref('');
const reposError = ref('');
const repoQuery = ref('');
const selectedRepo = ref<GithubRepo | null>(null);
const reposPhase = useLoadPhase(() => repos.value === undefined && !reposError.value);
const filteredRepos = computed(() => {
  const q = repoQuery.value.trim().toLowerCase();
  const list = repos.value ?? [];
  return q ? list.filter((r) => r.fullName.toLowerCase().includes(q)) : list;
});

const { run: loadRepos } = useAsyncAction(
  async (value: string) => {
    reposFor.value = value;
    reposError.value = '';
    repos.value = undefined;
    selectedRepo.value = null;
    const list = await api.githubRepos(value);
    // A token edited while the read ran: its own read replaces this one.
    if (reposFor.value === value) repos.value = list;
  },
  { onError: (e) => (reposError.value = refusal(e)) },
);

watch(
  [step, source, tokenValue],
  ([s, src, value]) => {
    if (s === 'repo' && src === 'github' && value && reposFor.value !== value) void loadRepos(value);
  },
);

// URL, typed.
const urlInput = ref('');

// A folder already on this machine.
const localPath = ref('');
const inspected = ref<GitInspect | null>(null);
const inspectError = ref('');
const { run: inspect, busy: inspecting } = useAsyncAction(
  async (path: string) => {
    localPath.value = path;
    inspected.value = null;
    inspectError.value = '';
    const result = await api.gitInspect(path);
    if (localPath.value === path) inspected.value = result;
  },
  { onError: (e) => (inspectError.value = refusal(e)) },
);
// Connecting a project that names its repository: a folder whose origin is another one is
// allowed (a fork, a mirror) but said out loud.
const remoteMismatch = computed(
  () =>
    props.mode === 'connect' &&
    !!projectRemote.value &&
    !!inspected.value?.isRepo &&
    !sameRemote(inspected.value.origin ?? '', projectRemote.value),
);

const cloning = computed(() => source.value !== 'local');
const cloneUrl = computed(() => {
  if (source.value === 'github') return selectedRepo.value?.cloneUrl ?? '';
  if (source.value === 'url') return urlInput.value.trim();
  if (source.value === 'remote') return projectRemote.value;
  return '';
});

const canLeaveRepo = computed(() =>
  source.value === 'local' ? !!inspected.value?.isRepo : !!cloneUrl.value,
);

// What step 3 proposes is derived from the repository; re-derived only when the repository
// changes, so stepping back and forth keeps what the operator typed there.
let prefilledFor = '';
const { run: leaveRepo, busy: leavingRepo } = useAsyncAction(
  async () => {
    if (!canLeaveRepo.value) return;
    repoError.value = '';
    const identity = source.value === 'local' ? `local:${localPath.value}` : `clone:${cloneUrl.value}`;
    if (identity !== prefilledFor) {
      if (source.value === 'local') {
        name.value = inspected.value?.name ?? '';
        branch.value = inspected.value?.branch ?? '';
      } else {
        dirName.value = repoDirName(cloneUrl.value);
        name.value = dirName.value;
        if (source.value === 'github') branch.value = selectedRepo.value?.defaultBranch ?? '';
        // Connecting asks nothing about the branch (the project already has its own), so
        // only a new project reads the remote's HEAD. It doubles as an early access check:
        // a private repository the token cannot read fails here, before anything is cloned.
        else if (props.mode === 'create') {
          const head = await api.gitRemoteHead(cloneUrl.value, tokenValue.value || undefined);
          branch.value = head.defaultBranch ?? '';
        }
      }
      prefilledFor = identity;
    }
    step.value = 'place';
  },
  { onError: (e) => (repoError.value = refusal(e)) },
);

// ── 3 · Where and how ───────────────────────────────────────────────────────
const parentDir = ref('');
const dirName = ref('');
const name = ref('');
const color = ref('');
// '' is «Не визначено». KSelect speaks plain strings, so the value is narrowed at submit.
const platform = ref('');
const branch = ref('');
const placeError = ref('');
const platformOptions = computed(() => PLATFORM_CHOICES.map((p) => ({ value: p.value, label: t(p.labelKey) })));

// The separator the machine's own paths use, so a Windows home does not get a `/` spliced in.
const sep = computed(() => (parentDir.value.includes('\\') && !parentDir.value.includes('/') ? '\\' : '/'));
const targetPath = computed(() =>
  parentDir.value && dirName.value.trim() ? `${parentDir.value.replace(/[\\/]+$/, '')}${sep.value}${dirName.value.trim()}` : '',
);

function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut > 0 ? trimmed.slice(0, cut) : trimmed;
}

// The parent folder a clone lands in: where the last project bound here lives (the selected
// one when it is bound, else the newest bound row), else `<home>/Projects`. The registry keeps
// no binding time, so «newest» is the row's own creation time.
async function readDefaultParent(): Promise<void> {
  const selected = store.projects.find((p) => p.id === store.selectedProjectId && p.localRepoPath);
  const newest = [...store.projects]
    .filter((p) => p.localRepoPath)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const bound = selected ?? newest;
  if (bound) {
    parentDir.value = parentOf(bound.localRepoPath);
    return;
  }
  try {
    const home = (await api.listDirs()).path.replace(/[\\/]+$/, '');
    const s = home.includes('\\') && !home.includes('/') ? '\\' : '/';
    // Not overwriting a folder the operator already picked while this was in flight.
    if (!parentDir.value) parentDir.value = `${home}${s}Projects`;
  } catch {
    // The api could not list the home folder: the operator picks the parent by hand.
  }
}

const isAbsolute = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);

const canStart = computed(() => {
  if (cloning.value && !(isAbsolute(parentDir.value) && dirName.value.trim() && !/[\\/]/.test(dirName.value.trim()))) {
    return false;
  }
  return props.mode === 'connect' || !!name.value.trim();
});

function start(): void {
  if (!canStart.value) return;
  placeError.value = '';
  // A clone that failed or was cancelled starts over; the stages after it never ran.
  if (stages.clone !== 'done') stages.clone = 'pending';
  step.value = 'create';
  void runCreation();
}

// ── 4 · Creation ────────────────────────────────────────────────────────────
// Clone → cloud → binding → `.env` (decision 6). Each stage that finished stays finished, so
// «Спробувати ще раз» resumes at the stage that failed: a cloud failure never clones twice.
type StageKey = 'clone' | 'cloud' | 'remote' | 'bind' | 'env';
type StageStatus = 'pending' | 'running' | 'done' | 'failed';
const STAGE_MARK: Record<StageStatus, string> = { pending: '·', running: '', done: '✓', failed: '✕' };
const stages = reactive<Record<StageKey, StageStatus>>({
  clone: 'pending',
  cloud: 'pending',
  remote: 'pending',
  bind: 'pending',
  env: 'pending',
});
// Connecting a project that had no remote, from a typed URL: the URL becomes the project's.
const saveRemote = computed(
  () => props.mode === 'connect' && !!cloudProject.value && !projectRemote.value && source.value === 'url',
);
const stageKeys = computed<StageKey[]>(() => [
  ...(cloning.value ? (['clone'] as const) : []),
  ...(props.mode === 'create' ? (['cloud'] as const) : saveRemote.value ? (['remote'] as const) : []),
  'bind',
  ...(tokenValue.value ? (['env'] as const) : []),
]);

const cloneState = ref<GitCloneState | null>(null);
const clonedPath = ref('');
const createdId = ref('');
const cloudPatched = ref(false);
const finished = ref(false);
let current: StageKey | null = null;
const failure = ref<{ stage: StageKey; message: string; output: string; authFailed: boolean } | null>(null);

const repoPath = computed(() => (cloning.value ? clonedPath.value : inspected.value?.path ?? ''));
const resultProjectId = computed(() => (props.mode === 'create' ? createdId.value : props.projectId ?? ''));

// Every state a clone job reports, kept per job: an event may land before `POST /git/clone`
// has answered with the job's id.
const seenClones = new Map<string, GitCloneState>();
const offEvents = store.onServerEvent((e) => {
  if (e.type === 'git_clone') {
    seenClones.set(e.state.jobId, e.state);
    if (cloneState.value?.jobId === e.state.jobId) cloneState.value = e.state;
  } else if (e.type === 'snapshot' && cloneState.value?.phase === 'cloning') {
    // The socket reconnected: events sent while it was down are gone, so ask for the state.
    const jobId = cloneState.value.jobId;
    api.gitCloneState(jobId).then(
      (s) => {
        if (cloneState.value?.jobId === jobId) cloneState.value = s;
      },
      () => {
        /* the next event or reconnect brings it */
      },
    );
  }
});
onBeforeUnmount(offEvents);

// A clone that ended other than `done`, with git's own words for the operator.
class CloneEnded extends Error {
  readonly state: GitCloneState;
  constructor(state: GitCloneState) {
    super(state.phase);
    this.state = state;
  }
}

function untilFinal(jobId: string): Promise<GitCloneState> {
  return new Promise((resolve) => {
    const stop = watch(cloneState, (s) => {
      if (s?.jobId === jobId && s.phase !== 'cloning') {
        stop();
        resolve(s);
      }
    });
  });
}

async function runClone(): Promise<void> {
  const started = await api.gitClone({
    url: cloneUrl.value,
    parentDir: parentDir.value.trim(),
    dirName: dirName.value.trim(),
    ...(tokenValue.value ? { token: tokenValue.value } : {}),
  });
  const final = untilFinal(started.jobId);
  cloneState.value = seenClones.get(started.jobId) ?? started;
  const state = await final;
  if (state.phase !== 'done') throw new CloneEnded(state);
  clonedPath.value = state.path;
}

async function runCloud(): Promise<void> {
  const workspaceId = props.workspaceId;
  if (!workspaceId) throw new Error('workspace missing');
  if (!createdId.value) {
    const remote = source.value === 'local' ? inspected.value?.origin ?? '' : cloneUrl.value;
    const created = await projects.create(workspaceId, name.value.trim(), {
      gitRemoteUrl: remote || undefined,
      platform: isPlatform(platform.value) ? platform.value : undefined,
    });
    createdId.value = created.id;
  }
  if (cloudPatched.value) return;
  // create() takes only the remote and the platform; the rest is the ordinary project patch.
  const patch = {
    ...(color.value ? { color: color.value } : {}),
    ...(branch.value.trim() ? { defaultBranch: branch.value.trim() } : {}),
  };
  if (Object.keys(patch).length > 0) await projects.patch(createdId.value, patch);
  cloudPatched.value = true;
}

async function runStage(key: StageKey): Promise<void> {
  const projectId = resultProjectId.value;
  if (key === 'clone') return runClone();
  if (key === 'cloud') return runCloud();
  if (key === 'remote') {
    await projects.patch(projectId, { gitRemoteUrl: cloneUrl.value });
    return;
  }
  if (key === 'bind') {
    await store.setProjectBinding(projectId, repoPath.value);
    return;
  }
  // The api also keeps the file out of git (`.git/info/exclude`) when git does not ignore it,
  // so the token never lands in the first commit.
  await store.saveEnv(projectId, { set: { GIT_TOKEN: tokenValue.value } });
}

const { run: runCreation, busy: creating } = useAsyncAction(
  async () => {
    failure.value = null;
    for (const key of stageKeys.value) {
      if (stages[key] === 'done') continue;
      current = key;
      stages[key] = 'running';
      await runStage(key);
      stages[key] = 'done';
    }
    current = null;
    finished.value = true;
  },
  {
    onError: (e) => {
      const stage = current ?? 'bind';
      current = null;
      stages[stage] = 'failed';
      if (e instanceof CloneEnded) {
        const s = e.state;
        failure.value = {
          stage,
          message:
            s.phase === 'cancelled'
              ? t('onboarding.wizard.create.cancelled')
              : s.authFailed
                ? t('onboarding.wizard.create.authFailed')
                : t('onboarding.wizard.create.cloneFailed'),
          output: s.phase === 'failed' ? s.error ?? '' : '',
          authFailed: s.authFailed,
        };
        return;
      }
      failure.value = { stage, message: refusal(e), output: '', authFailed: false };
    },
  },
);

const { run: cancelClone, busy: cancelling } = useAsyncAction(async () => {
  const jobId = cloneState.value?.jobId;
  if (!jobId) return;
  // The answer is the final state; it resolves the waiting clone stage like the event would.
  cloneState.value = await api.gitCloneCancel(jobId);
});

// Going back to the token after a refused clone: the clone runs again with the new token.
watch(step, (s) => {
  if (s !== 'create' && failure.value?.stage === 'clone') {
    failure.value = null;
    stages.clone = 'pending';
  }
});

// ── Shared ──────────────────────────────────────────────────────────────────
// Nothing closes it while something is running; during the clone «Скасувати» is the way out.
const locked = computed(() => creating.value || leavingRepo.value || checkingToken.value || cancelling.value);

function close(): void {
  if (locked.value) return;
  emit('close');
}

const pickerFor = ref<'local' | 'parent' | null>(null);
function onPicked(path: string): void {
  if (pickerFor.value === 'local') void inspect(path);
  else parentDir.value = path;
  pickerFor.value = null;
}

onMounted(() => {
  void readTokenSources();
  void readDefaultParent();
});
</script>

<style scoped lang="scss">
.wiz {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.wiz__count {
  font-size: var(--k-fs-sm);
  color: var(--k-faint);
}

.wiz__steps {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--k-fs-sm);
  color: var(--k-faint);
}

.wiz__step {
  display: flex;
  align-items: center;
  gap: 6px;
}

.wiz__step--on {
  color: var(--k-text);
  font-weight: 700;
}

.wiz__step--past {
  color: var(--k-muted);
}

.wiz__step-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  font-size: var(--k-fs-xs);
}

.wiz__step--on .wiz__step-num {
  border-color: var(--k-accent);
  color: var(--k-accent);
}

.wiz__body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.wiz__row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.wiz__lead,
.wiz__hint,
.wiz__warn,
.wiz__error,
.wiz__ok {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
}

.wiz__lead {
  color: var(--k-text);
}

.wiz__hint {
  color: var(--k-muted);
}

.wiz__warn {
  color: var(--k-warning);
}

.wiz__error {
  color: var(--k-accent);
}

.wiz__ok {
  color: var(--k-success);
}

.wiz__label {
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.wiz__link {
  font-size: var(--k-fs-sm);
  color: var(--k-accent);
}

.wiz__sources {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.wiz__quick {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
  text-decoration: underline;
  cursor: pointer;

  &:hover {
    color: var(--k-text);
  }
}

.wiz__empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}

.wiz__repos {
  display: flex;
  flex-direction: column;
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--k-line);
  border-radius: var(--k-r);
}

.wiz__repo {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 8px 12px;
  border: 0;
  border-bottom: 1px solid var(--k-line);
  background: none;
  color: var(--k-text);
  font: inherit;
  text-align: left;
  cursor: pointer;

  &:last-child {
    border-bottom: 0;
  }

  &:hover {
    background: var(--k-surface);
  }
}

.wiz__repo--on {
  background: var(--k-surface2);
  box-shadow: inset 2px 0 0 var(--k-accent);
}

.wiz__repo-name {
  font-size: var(--k-fs-sm);
}

.wiz__repo-desc {
  flex-basis: 100%;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.wiz__path {
  flex: 1;
  min-width: 0;
  font-size: var(--k-fs-sm);
  overflow-wrap: anywhere;
}

.wiz__path--empty {
  color: var(--k-faint);
}

.wiz__facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 16px;
  margin: 0;
  font-size: var(--k-fs-sm);

  dt {
    color: var(--k-muted);
  }

  dd {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
  }
}

.wiz__swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
}

.wiz__stages {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.wiz__stage {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: var(--k-fs-base);
  color: var(--k-faint);
}

.wiz__stage--running,
.wiz__stage--done {
  color: var(--k-text);
}

.wiz__stage--done .wiz__stage-mark {
  color: var(--k-success);
}

.wiz__stage--failed {
  color: var(--k-accent);
}

.wiz__stage-mark {
  display: inline-flex;
  justify-content: center;
  width: 16px;
}

.wiz__stage-meta {
  margin-left: auto;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.wiz__bar {
  height: 3px;
  background: var(--k-line);
}

.wiz__bar-fill {
  height: 100%;
  background: var(--k-accent);
  transition: width 0.2s;
}

.wiz__output {
  max-height: 180px;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  border: 1px solid var(--k-line);
  border-radius: var(--k-r);
  background: var(--k-surface);
  font-size: var(--k-fs-xs);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
