<template>
  <main class="ait">
    <!-- SECTION RAIL — the same two-column idiom Налаштування uses: a rail addressed by the
         URL (`/ai-team/<key>`) so a deep link, Back and the top-nav segment all arrive at the
         same pane with no state of their own. The rows are grouped under two captions, and the
         caption carries the noun (Автоматизація / Навички) so the rows themselves say only what
         is inside each — the sub-line's real job. -->
    <aside class="ait__rail">
      <div class="ait__rail-head">
        <!-- The owner axis, top of the rail like the scope switcher in Налаштування: which of
             the three the operator is editing. `user` is their private overlay, `project` this
             project's specifics, `workspace` the group's shared defaults. -->
        <KTopNav dense :model-value="scope" :options="scopeOptions" @update:model-value="setScope" />
        <!-- The subject in scope, stated above the rows it applies to. Greyed and dot-less
             while nothing is chosen, so the chip reads as an empty slot rather than a label. -->
        <span class="ait__chip" :class="{ 'ait__chip--empty': !owner }">
          <span
            v-if="owner && ownerColor"
            class="ait__chip-dot"
            :style="{ background: ownerColor }"
            aria-hidden="true"
          ></span>
          <span class="ait__chip-name">{{ ownerName || t('aiTeam.rail.none.' + scope) }}</span>
        </span>
        <p class="ait__hint">{{ t('aiTeam.rail.note.' + scope) }}</p>
      </div>
      <nav class="ait__sections" :aria-label="t('aiTeam.rail.sectionsAria')">
        <template v-for="(s, i) in AI_TEAM_SECTIONS" :key="s.key">
          <!-- The group caption prints once, above the first row of its run. -->
          <p v-if="AI_TEAM_SECTIONS[i - 1]?.group !== s.group" class="ait__cap">
            {{ t('aiTeam.groups.' + s.group) }}
          </p>
          <button
            type="button"
            class="ait__section"
            :class="{ 'ait__section--on': s.key === section.key }"
            :aria-current="s.key === section.key ? 'page' : undefined"
            @click="goSection(s.key)"
          >
            <span class="ait__section-text">
              <span class="ait__section-label">{{ t('aiTeam.sections.' + s.key + '.label') }}</span>
              <span class="ait__section-sub">{{ t('aiTeam.sections.' + s.key + '.sub') }}</span>
            </span>
          </button>
        </template>
      </nav>
    </aside>

    <!-- CONTENT PANE — heading and the section's editor. The panels own their own writes and
         their own «збережено/не збережено» state, so there is no save bar here: unlike
         Налаштування, nothing on this screen queues into one shared draft. -->
    <section class="ait__pane">
      <header class="ait__head">
        <div class="ait__head-text">
          <h1 class="ait__title">{{ t('aiTeam.sections.' + section.key + '.label') }}</h1>
          <p class="ait__blurb">{{ t('aiTeam.sections.' + section.key + '.blurb') }}</p>
        </div>
      </header>

      <div class="ait__body">
        <!-- Хелпери: a read-only reference of the app's chat commands. `DEFAULT_HELPERS` is a
             compile-time constant, so there is no owner to configure and nothing to edit or
             delete — the pane renders the same catalogue for every subject. It is a
             workspace-and-project-level reference; the private user overlay has no place for
             it, so that scope says so rather than repeating a global list. This branch sits
             ABOVE the `!owner` guard on purpose: the catalogue needs no subject selected. -->
        <div v-if="section.key === 'helpers'" class="ait__form ait__form--wide">
          <HelpersCatalogPanel v-if="scope !== 'user'" />
          <div v-else class="ait__blank">
            <span class="ait__blank-eyebrow mono">{{ t('aiTeam.blank.eyebrow') }}</span>
            <p>{{ t('aiTeam.helpersUserScope') }}</p>
          </div>
        </div>
        <!-- The subject IS the access rule: every editor configures ONE owner, so with none
             chosen there is nothing to configure. The message names the scope's own subject. -->
        <div v-else-if="!owner" class="ait__blank">
          <span class="ait__blank-eyebrow mono">{{ t('aiTeam.blank.eyebrow') }}</span>
          <p>{{ t('aiTeam.blank.' + scope) }}</p>
        </div>

        <!-- The `v-if` on owner is the type guard: the panels take a concrete owner, and only
             the narrowing here turns the possibly-undefined subject into one. Not keyed — the
             panels watch the owner and reload in place, dropping any unsaved draft with it. -->
        <!-- Агенти кастомізуються лише на рівні воркспейсу (override інструкції + призначені
             навички діють на всю команду). Проєкт і користувач поки не мають власного шару
             агентів — заглушка, а не порожній редактор, який нічого не збереже. -->
        <div v-else-if="section.key === 'agents'" class="ait__form ait__form--wide">
          <AiAgentsPanel v-if="owner.scope === 'workspace'" :owner="owner" :owner-name="ownerName" />
          <div v-else class="ait__blank">
            <span class="ait__blank-eyebrow mono">{{ t('aiTeam.blank.eyebrow') }}</span>
            <p>{{ t('aiTeam.agentsUnavailable') }}</p>
          </div>
        </div>
        <!-- The read-only «успадковано з воркспейсу» block hangs BELOW the editable list and
             only on the project tab: a project's session also gets its workspace's skills and
             triggers at launch, and hiding that entirely leaves the operator debugging blind
             (triggers fire as a union). The workspace tab inherits nothing; the user tab has no
             single workspace to inherit from. -->
        <div v-else-if="section.key === 'triggers'" class="ait__form ait__form--wide">
          <TriggersPanel :owner="owner" :owner-name="ownerName" />
          <AiInherited v-if="inheritedWorkspace" kind="triggers" :workspace="inheritedWorkspace" />
        </div>
        <div v-else-if="section.key === 'skills'" class="ait__form ait__form--wide">
          <SkillsLibraryPanel :owner="owner" :owner-name="ownerName" />
          <AiInherited v-if="inheritedWorkspace" kind="skills" :workspace="inheritedWorkspace" />
        </div>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
// The «ШІ-команда» screen. What Kermanych's own agents are told, the rules that fire without
// the model choosing to, and the skill library both of them draw from — one workbench, three
// editors, addressed by the URL like Налаштування so it is deep-linkable and Back-able.
//
// It used to be three rows under Налаштування → Проєкт. It is a top-nav view of its own now:
// the operator reads and edits it as a unit, not as a setting flipped once, and it wanted the
// room a rail-plus-pane gives that a settings sub-section could not.
//
// It used to be three rows under Налаштування → Проєкт, project-scoped only. It is a top-nav
// view of its own now, and it carries the SCOPE axis the manager needed: the same three
// editors at `project` (this project), `workspace` (the group's shared defaults, so a manager
// who works at the workspace level can arm the team once for every project) or `user` (the
// signed-in operator's private overlay). The owner is what the panels read and write; the
// launch resolver merges the three by precedence (user > project > workspace).
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { AiOwner, AiScope } from '@kermanych/cloud';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import { useAuth } from 'stores/auth';
import { AI_TEAM_SCOPES, AI_TEAM_SECTIONS, aiTeamSection } from '../lib/ai-team';
import KTopNav from 'components/kit/KTopNav.vue';
import AiAgentsPanel from 'components/settings/AiAgentsPanel.vue';
import TriggersPanel from 'components/settings/TriggersPanel.vue';
import SkillsLibraryPanel from 'components/settings/SkillsLibraryPanel.vue';
import HelpersCatalogPanel from 'components/settings/HelpersCatalogPanel.vue';
import AiInherited from 'components/settings/AiInherited.vue';

const store = useOrchestrator();
const projects = useProjects();
const auth = useAuth();
const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const section = computed(() => aiTeamSection(route.params.section));

// The owner axis. Local state, not a URL segment: the section is the deep-linkable thing, and
// the scope follows whatever the operator is looking at in the sidebar (a project, its group).
const scope = ref<AiScope>('project');
const scopeOptions = computed(() => AI_TEAM_SCOPES.map((s) => ({ value: s, label: t('aiTeam.scope.' + s) })));
function setScope(s: string): void {
  scope.value = s as AiScope;
}

// The three subjects, each from the sidebar selection or the session. The LOCAL project row
// carries this machine's name for an unpublished project; the CLOUD row is the source of truth.
const projectId = computed(() => store.selectedProjectId);
const cloudRow = computed(() => (projectId.value ? projects.byId.get(projectId.value) : undefined));
const localRow = computed(() => store.projects.find((p) => p.id === projectId.value));
const workspace = computed(() =>
  store.selectedWorkspaceId ? projects.workspaceById.get(store.selectedWorkspaceId) : undefined,
);
const userId = computed(() => auth.user?.id);

// The owner the panels edit, or undefined when the current scope's subject is not selected —
// which is the blank-invite state.
const owner = computed<AiOwner | undefined>(() => {
  if (scope.value === 'project') return projectId.value ? { scope: 'project', id: projectId.value } : undefined;
  if (scope.value === 'workspace') return workspace.value ? { scope: 'workspace', id: workspace.value.id } : undefined;
  return userId.value ? { scope: 'user', id: userId.value } : undefined;
});
const ownerName = computed(() => {
  if (scope.value === 'project') return cloudRow.value?.name ?? localRow.value?.name ?? '';
  if (scope.value === 'workspace') return workspace.value?.name ?? '';
  const handle = auth.profile?.githubUsername;
  return handle ? `@${handle}` : userId.value ? t('aiTeam.rail.you') : '';
});
const ownerColor = computed(() => {
  if (scope.value === 'project') return cloudRow.value?.color;
  if (scope.value === 'workspace') return workspace.value?.color;
  return undefined;
});

// The workspace a PROJECT inherits its skills and triggers from, for the read-only block. Only
// meaningful at the project scope: the workspace tab is the base of the precedence chain, and a
// user-scoped view has no single workspace behind it.
const inheritedWorkspace = computed<AiOwner | undefined>(() =>
  scope.value === 'project' && cloudRow.value?.workspaceId
    ? { scope: 'workspace', id: cloudRow.value.workspaceId }
    : undefined,
);

function goSection(key: string): void {
  if (key !== section.value.key) void router.push({ name: 'ai-team', params: { section: key } });
}
</script>

<style scoped lang="scss">
.ait {
  display: flex;
  gap: var(--k-sp-3);
  height: calc(100vh - 82px);
  min-height: 0;
  padding: var(--k-sp-4);
  background: var(--k-canvas);
  overflow: hidden;
}

// ── RAIL ────────────────────────────────────────────────────────────────────
.ait__rail {
  flex: none;
  width: 280px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--k-bg);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-lg);
  overflow: hidden;
}

.ait__rail-head {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-3);
  border-bottom: var(--k-rule-thin) solid var(--k-line);
}

.ait__eyebrow {
  font-size: 10px;
  letter-spacing: 0.22em;
  color: var(--k-faint);
}

.ait__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  max-width: 100%;
  padding: 3px 10px;
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: var(--k-surface2);
  border-radius: var(--k-r-pill);

  &--empty {
    color: var(--k-faint);
    background: color-mix(in srgb, var(--k-surface2) 45%, transparent);
  }
}

.ait__chip-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.ait__chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ait__hint {
  margin: 0;
  font-size: var(--k-fs-sm);
  line-height: 1.45;
  color: var(--k-faint);
}

.ait__sections {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--k-sp-2);
}

.ait__cap {
  margin: var(--k-sp-3) 0 2px;
  padding: 0 10px;
  font-size: 10px;
  letter-spacing: 0.22em;
  color: var(--k-faint);

  &:first-child {
    margin-top: 0;
  }
}

.ait__section {
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

.ait__section--on {
  background: var(--k-surface2);
}

.ait__section-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.ait__section-label {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-medium);
  color: var(--k-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  .ait__section--on & {
    font-weight: var(--k-fw-semibold);
    color: var(--k-text);
  }
}

.ait__section-sub {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// ── PANE ────────────────────────────────────────────────────────────────────
.ait__pane {
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

.ait__head {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: var(--k-sp-3);
  padding: var(--k-sp-4) var(--k-sp-6) var(--k-sp-3);
  border-bottom: var(--k-rule-thin) solid var(--k-line);
}

.ait__head-text {
  flex: 1;
  min-width: 0;
}

.ait__title {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-lg);
  font-weight: var(--k-fw-semibold);
  letter-spacing: -0.01em;
  color: var(--k-text);
}

.ait__blurb {
  margin: 4px 0 0;
  font-size: var(--k-fs-base);
  line-height: 1.5;
  color: var(--k-faint);
}

.ait__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--k-sp-5) var(--k-sp-6);
}

.ait__form--wide {
  max-width: 860px;
}

.ait__blank {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  align-items: flex-start;
  color: var(--k-faint);
}

.ait__blank-eyebrow {
  font-size: 10px;
  letter-spacing: 0.22em;
}
</style>
