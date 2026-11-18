<template>
  <div class="welcome">
    <div class="welcome__eyebrow mono">{{ t('agents.blank.eyebrow') }}</div>

    <div v-if="phase !== 'ready'" class="welcome__inner">
      <KSkeleton v-if="phase === 'skeleton'" variant="card" :rows="2" />
    </div>

    <div v-else-if="state === 'offline'" class="welcome__inner">
      <h2 class="welcome__title">{{ t('onboarding.welcome.offline.title') }}</h2>
      <p class="welcome__lead">{{ t('onboarding.welcome.offline.lead', { error: projects.offlineError ?? '' }) }}</p>
      <div>
        <KBtn variant="primary" :loading="retrying" @click="retry()">{{ t('onboarding.welcome.offline.retry') }}</KBtn>
      </div>
    </div>

    <!-- No workspace: the two ways a newcomer starts — first in a team, or invited into one. -->
    <div v-else-if="state === 'no-workspace'" class="welcome__inner">
      <h2 class="welcome__title">{{ t('onboarding.welcome.start.title') }}</h2>
      <p class="welcome__lead">{{ t('onboarding.welcome.start.lead') }}</p>
      <div class="welcome__paths">
        <section class="welcome__path">
          <h3 class="welcome__path-title">{{ t('onboarding.welcome.start.create.title') }}</h3>
          <p class="welcome__text">{{ t('onboarding.welcome.start.create.body') }}</p>
          <div class="welcome__actions">
            <KBtn variant="primary" @click="onb.askCreateWorkspace()">{{ t('onboarding.welcome.start.create.cta') }}</KBtn>
          </div>
        </section>
        <section class="welcome__path">
          <h3 class="welcome__path-title">{{ t('onboarding.welcome.start.invited.title') }}</h3>
          <p class="welcome__text">{{ t('onboarding.welcome.start.invited.body') }}</p>
          <div class="welcome__email">
            <span class="welcome__email-value mono">{{ email || '—' }}</span>
            <KBtn :disabled="!email" :loading="copying" @click="copyEmail()">
              {{ copied ? t('onboarding.welcome.start.invited.copied') : t('onboarding.welcome.start.invited.copy') }}
            </KBtn>
          </div>
          <p class="welcome__hint">{{ t('onboarding.welcome.start.invited.after') }}</p>
        </section>
      </div>
    </div>

    <div v-else-if="state === 'no-project'" class="welcome__inner">
      <h2 class="welcome__title">{{ t('onboarding.welcome.firstProject.title') }}</h2>
      <p class="welcome__lead">{{ t('onboarding.welcome.firstProject.lead', { workspace: firstWorkspace?.name ?? '' }) }}</p>
      <div class="welcome__actions">
        <KBtn variant="primary" :disabled="!firstWorkspace" @click="createFirst()">{{ t('onboarding.welcome.firstProject.cta') }}</KBtn>
      </div>
    </div>

    <!-- Projects exist, none has a folder on this machine: usually a teammate who was added. -->
    <div v-else-if="state === 'connect'" class="welcome__inner">
      <h2 class="welcome__title">{{ t('onboarding.welcome.connect.title') }}</h2>
      <p class="welcome__lead">{{ t('onboarding.welcome.connect.lead') }}</p>
      <section v-for="g in connectGroups" :key="g.key" class="welcome__group">
        <h3 class="welcome__group-title">{{ g.title }}</h3>
        <ul class="welcome__projects">
          <li v-for="p in g.projects" :key="p.id" class="welcome__project">
            <span class="welcome__dot" :style="p.color ? { background: p.color } : undefined" aria-hidden="true"></span>
            <span class="welcome__project-name">{{ p.name }}</span>
            <span v-if="p.remote" class="welcome__project-remote mono">{{ p.remote }}</span>
            <KBtn @click="onb.openWizard({ mode: 'connect', projectId: p.id })">{{ t('onboarding.welcome.connect.cta') }}</KBtn>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuth } from 'stores/auth';
import { useOnboarding } from 'stores/onboarding';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import { useAsyncAction } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import KBtn from 'components/kit/KBtn.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';

// The centre of «Агенти» while the account has nothing to work with on this machine
// (docs/specs/2026-11-18-first-run-and-project-wizard.md, decision 2). Which of its states shows
// is the onboarding store's `welcomeState`, so the screen moves on by itself the moment an
// invitation, a project or a binding lands in the stores. The acts it offers are the shell's:
// the create-workspace modal and the hosted project wizard.
const { t } = useI18n();
const auth = useAuth();
const onb = useOnboarding();
const store = useOrchestrator();
const projects = useProjects();

const state = computed(() => onb.welcomeState);
const phase = useLoadPhase(() => onb.welcomeState === 'loading');

const email = computed(() => auth.user?.email ?? '');
const copied = ref(false);
const { run: copyEmail, busy: copying } = useAsyncAction(async () => {
  await navigator.clipboard.writeText(email.value);
  copied.value = true;
});

const { run: retry, busy: retrying } = useAsyncAction(() => projects.load());

// The workspace a first project goes into: the one in scope, else the first in the sidebar.
const firstWorkspace = computed(
  () =>
    projects.orderedWorkspaces.find((w) => w.id === store.selectedWorkspaceId) ?? projects.orderedWorkspaces[0],
);

function createFirst(): void {
  const ws = firstWorkspace.value;
  if (ws) onb.openWizard({ mode: 'create', workspaceId: ws.id });
}

// Every project of every workspace, grouped the way the sidebar groups them. A workspace the
// account owns is named plainly; one it was added to says so. Local rows the cloud list does
// not hold (an offline boot) still get a group, so they can be connected too.
type ConnectRow = { id: string; name: string; color: string; remote: string };
const connectGroups = computed(() => {
  const groups: { key: string; title: string; projects: ConnectRow[] }[] = [];
  for (const g of projects.projectsByWorkspace) {
    if (g.projects.length === 0) continue;
    groups.push({
      key: g.workspace.id,
      title: projects.isWorkspaceOwner(g.workspace.id)
        ? t('onboarding.welcome.connect.yours', { workspace: g.workspace.name })
        : t('onboarding.welcome.connect.addedTo', { workspace: g.workspace.name }),
      projects: g.projects.map((p) => ({ id: p.id, name: p.name, color: p.color ?? '', remote: p.gitRemoteUrl ?? '' })),
    });
  }
  const localOnly = store.projects.filter((p) => !projects.byId.has(p.id));
  if (localOnly.length > 0) {
    groups.push({
      key: 'local',
      title: t('onboarding.welcome.connect.localOnly'),
      projects: localOnly.map((p) => ({ id: p.id, name: p.name, color: p.color ?? '', remote: '' })),
    });
  }
  return groups;
});
</script>

<style scoped lang="scss">
.welcome {
  height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  padding: 64px 24px;
  color: var(--k-text);
}

.welcome__eyebrow {
  font-size: var(--k-fs-xs);
  letter-spacing: 0.14em;
  color: var(--k-faint);
}

.welcome__inner {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: min(760px, 100%);
}

.welcome__title {
  margin: 0;
  font-size: 22px;
  font-weight: 800;
  line-height: 1.25;
  text-align: center;
}

.welcome__lead {
  margin: 0 auto;
  max-width: 560px;
  font-size: var(--k-fs-base);
  line-height: 1.55;
  color: var(--k-muted);
  text-align: center;
}

.welcome__paths {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 14px;
  margin-top: 10px;
}

.welcome__path {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px 20px;
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  background: var(--k-surface);
}

.welcome__path-title,
.welcome__group-title {
  margin: 0;
  font-size: var(--k-fs-md);
  font-weight: 800;
}

.welcome__text,
.welcome__hint {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--k-muted);
}

.welcome__actions {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin-top: auto;
}

.welcome__path .welcome__actions {
  justify-content: flex-start;
}

.welcome__email {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.welcome__email-value {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--k-line);
  border-radius: var(--k-r);
  background: var(--k-bg);
  font-size: var(--k-fs-sm);
  overflow-wrap: anywhere;
}

.welcome__group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

.welcome__projects {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--k-line);
  border-radius: var(--k-r);
}

.welcome__project {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--k-line);

  &:last-child {
    border-bottom: 0;
  }
}

.welcome__dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  background: var(--k-line-strong);
}

.welcome__project-name {
  font-weight: 700;
}

.welcome__project-remote {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

// The button sits at the row's end whether or not a remote fills the middle.
.welcome__project > :last-child {
  margin-left: auto;
}
</style>
