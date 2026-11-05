<template>
  <main class="mgmt">
    <div class="mgmt__atmo" aria-hidden="true"></div>

    <!-- SECTION RAIL — the tab's own nav, in the app's one nav idiom: a column of
         rows on a panel, exactly like the shell's bucket rail one column to the
         left. It used to be a horizontal strip of seven labels, which is the one
         nav shape this app uses nowhere else and which has no room for the second
         line that says what a section holds. -->
    <aside class="mgmt__rail">
      <div class="mgmt__rail-head">
        <span class="mgmt__eyebrow mono">{{ t('management.nav.eyebrow') }}</span>
        <!-- The scope, stated above the rows it applies to: every section below
             reports on this one workspace. Greyed out and dot-less while nothing is
             chosen, so the chip reads as an empty slot rather than a label. -->
        <span class="mgmt__chip" :class="{ 'mgmt__chip--empty': !workspaceId }">
          <span
            v-if="workspaceId && workspaceIcon"
            class="mgmt__chip-emoji"
            aria-hidden="true"
          >{{ workspaceIcon }}</span>
          <span
            v-else-if="workspaceId"
            class="mgmt__chip-dot"
            :style="{ background: workspaceColor }"
            aria-hidden="true"
          ></span>
          <KSkeleton v-if="chipPhase === 'skeleton'" variant="line" width="8em" />
          <span v-else-if="chipPhase === 'ready'" class="mgmt__chip-name">{{ workspaceName || t('management.nav.workspaceEmpty') }}</span>
        </span>
        <p class="mgmt__rail-note">{{ t('management.nav.scopeNote') }}</p>
      </div>

      <nav class="mgmt__rail-list" :aria-label="t('management.nav.railLabel')">
        <KNavItem
          v-for="s in railSections"
          :key="s.name"
          :label="s.label"
          :icon="SECTION_ICONS[s.name]"
          :hint="t('management.section.' + s.name + '.hint')"
          :active="s.name === activeSection"
          :aria-current="s.name === activeSection ? 'page' : undefined"
          @click="goSection(s.name)"
        />
      </nav>
    </aside>

    <section class="mgmt__pane">
      <header class="mgmt__head">
        <h1 class="mgmt__heading">{{ sectionLabel }}</h1>
      </header>

      <!-- The selection IS the access rule: every section reports on one workspace, so
           with none chosen there is nothing to report on. Same invitation the
           Агенти view shows, rather than seven sections each repeating it. A project
           that lives only on this machine has no workspace at all, and that case gets
           named on its own line — otherwise the gate looks like the app forgot the
           selection the sidebar is visibly holding. -->
      <div v-if="!workspaceId" class="mgmt__blank">
        <div class="mgmt__blank-eyebrow mono">{{ t('management.blank.eyebrow') }}</div>
        <p class="mgmt__blank-text">
          {{ t('management.blank.text') }}
        </p>
        <p v-if="store.selectedProjectId" class="mgmt__blank-text mgmt__blank-note">
          {{ t('management.blank.note') }}
        </p>
      </div>
      <template v-else>
        <div class="mgmt__body">
          <!-- A manager-only section (core `managersOnly`) renders only once the caller's role
               says they may open it: a developer is sent Home by the watcher below, and the
               moment before the roster answers is a skeleton rather than a flash of the
               register. -->
          <router-view v-if="sectionAllowed" :workspace-id="workspaceId" :workspace-name="workspaceName" />
          <KSkeleton v-else-if="!roleSettled" variant="rows" :rows="4" />
        </div>

        <!-- The Менеджмент assistant, FLOATING over the section pane rather than sitting in
             its column: the dock is absolutely positioned at the pane's foot, so section
             content passes BEHIND the frosted pill instead of stopping above it — which is
             also what finally makes the frost mean something, since it now blurs the register
             underneath. `.mgmt__body` keeps a bottom pad so the last row of a section can
             still be read clear of the pill. Frosted over the page's glow layer, which is why
             `.mgmt__atmo` exists rather than a flat canvas — glass needs a substrate to bend.
             The same component is the shell's overlay (components/assistant/AssistantLauncher.vue). -->
        <ManagementAssistant variant="dock" :section="activeSection" />
      </template>
    </section>
  </main>
</template>

<script setup lang="ts">
// Shell of the Менеджмент tab: the section rail, the «pick a workspace» gate, the workspace
// every section is scoped to, and the assistant docked at the section pane's foot. The
// sections themselves are the child routes of /management (the table lives in
// @kermanych/core, shared with the api and the action executor) — this component decides
// WHETHER one renders and WHICH WORKSPACE it renders for; it never renders their content.
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { MANAGEMENT_DEFAULT_SECTION, MANAGEMENT_SECTIONS } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
// The rail's row component, shared with the shell's bucket rail — it is what renders the
// `hint` second line. KSubNav is gone from this page with the horizontal strip it drove.
import KNavItem from 'components/kit/KNavItem.vue';
import { type KIconName } from 'components/kit/KIcon.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import ManagementAssistant from 'components/management/ManagementAssistant.vue';
import { useLoadPhase } from '../composables/useLoadPhase';

const store = useOrchestrator();
const projects = useProjects();
const route = useRoute();
const router = useRouter();

const { t } = useI18n();

// The child route name IS the rail's selection, so the rail follows deep links and
// the browser's back button with no state of its own.
const activeSection = computed(() => (typeof route.name === 'string' ? route.name : ''));
const sectionLabel = computed(
  () => MANAGEMENT_SECTIONS.find((s) => s.name === activeSection.value)?.label ?? t('management.nav.title'),
);
function goSection(name: string): void {
  if (route.name !== name) void router.push({ name });
}

// The rail's marks, keyed by route name. They live HERE and not in @kermanych/core's section
// table for the same reason the section's component does not live there either
// (router/routes.ts `SECTION_PAGES`): the table is shared with the api, which builds the
// assistant's prompt from it and has no business knowing what a row looks like. A section
// missing from this map still renders — `icon` is optional on KNavItem — it just renders
// without a mark, which is the correct failure: a new section appears in the rail the moment
// core lists it, and picking its mark is a separate, deliberate edit.
const SECTION_ICONS: Record<string, KIconName> = {
  'management-home': 'home',
  'management-storage': 'storage',
  'management-docs': 'docs',
  'management-risks': 'risks',
  'management-releases': 'releases',
  'management-capacity': 'capacity',
  'management-integrations': 'integrations',
};

const workspaceId = computed(() => store.selectedWorkspaceId);

// One lookup, unlike the shell header's project name: workspaces exist only in the cloud,
// so there is no cached local row to fall back to — an id we hold without a row is a list
// that has not loaded yet, and the chip stays an empty slot until it does.
const workspaceName = computed(() => {
  const id = workspaceId.value;
  if (!id) return '';
  return projects.workspaceById.get(id)?.name ?? '';
});

// A workspace id held before the cloud list has the row is «not loaded yet», not «none
// chosen»: skeleton in the chip instead of claiming «воркспейс не вибрано».
const chipPhase = useLoadPhase(() => {
  const id = workspaceId.value;
  return !!id && !projects.workspaceById.has(id) && (!projects.loadSettled || projects.loading);
});

// ── Who may open what ────────────────────────────────────────────────────────
// A manager-only section is the owner's and managers' (projects.canManageWorkspace). The
// roster that answers the question is read here, once per workspace, because the shell is
// the one place that knows a workspace is open — the sections and the Home tiles below only
// read the answer. A failed read settles on the developer view (projects.roleSettled).
watch(
  workspaceId,
  (id) => {
    if (id && !projects.members[id]) projects.loadMembers(id).catch(() => undefined);
  },
  { immediate: true },
);

const roleSettled = computed(() => !!workspaceId.value && projects.roleSettled(workspaceId.value));
const canManage = computed(() => !!workspaceId.value && projects.canManageWorkspace(workspaceId.value));

// The rail drops a manager-only row once the role is KNOWN to forbid it, not while it is
// pending: a manager's rail must not lose a row for the length of a roster read, and a
// developer who clicks it in that moment meets the skeleton and then Home, never the screen.
const railSections = computed(() =>
  MANAGEMENT_SECTIONS.filter((s) => !s.managersOnly || !roleSettled.value || canManage.value),
);

const sectionAllowed = computed(
  () => !MANAGEMENT_SECTIONS.find((s) => s.name === activeSection.value)?.managersOnly || canManage.value,
);

// A deep link or a stale tab lands a developer on a manager-only route: replace it with
// Home, so Back does not walk them into it again.
watch(
  [sectionAllowed, roleSettled],
  ([allowed, settled]) => {
    if (!allowed && settled) void router.replace({ name: MANAGEMENT_DEFAULT_SECTION });
  },
  { immediate: true },
);

// Same join the sidebar rail uses for its tile colour; the accent is the fallback
// so an uncoloured workspace still gets a dot instead of a hole.
const workspaceColor = computed(() => {
  const id = workspaceId.value;
  if (!id) return 'var(--k-accent)';
  return projects.workspaceById.get(id)?.color ?? 'var(--k-accent)';
});

// The workspace's emoji marker, mirroring the sidebar row: when set it stands in for the
// colour dot, so the scope chip shows the same glyph the sidebar does.
const workspaceIcon = computed(() => {
  const id = workspaceId.value;
  return id ? projects.workspaceById.get(id)?.icon : undefined;
});
</script>

<style scoped lang="scss">
// Two columns: the rail keeps its width, the section pane takes the rest. The
// `minmax(0, 1fr)` is load-bearing — a plain `1fr` floors at the pane's content
// width, and one wide row inside a section (a skill body, a diff) would then push
// the rail off screen instead of scrolling inside the pane.
.mgmt {
  position: relative;
  display: grid;
  grid-template-columns: 244px minmax(0, 1fr);
  gap: var(--k-sp-4);
  height: 100%; // the work area (MainLayout .shell__workarea), which the terminal panel shares
  min-height: 0;
  padding: var(--k-sp-4);
  background: var(--k-canvas);
  overflow: hidden;
}

// Dim pools of light so the frosted capsule has something to bend — a flat canvas
// behind glass renders as plain grey. Both pools sit under the composer, which is
// what makes its fill read as frost rather than as paint; the rest of the canvas,
// the top corner included, stays the flat `--k-canvas` the rail and pane rest on.
//
// Carried mostly by `--k-surface2`, not the accent: surface2 is defined as
// «distance from the canvas» in BOTH palettes (lighter on dark, a shade darker on
// light), so these pools stay depth in either theme. A brand-tinted pool wide
// enough to matter on the dark canvas turns the light one pink, so the accent is
// held to a thin wash under the capsule.
.mgmt__atmo {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background:
    radial-gradient(
      520px 220px at 62% 97%,
      color-mix(in srgb, var(--k-accent) 10%, transparent),
      transparent 72%
    ),
    radial-gradient(
      680px 340px at 56% 112%,
      color-mix(in srgb, var(--k-surface2) 85%, transparent),
      transparent 70%
    );
}

// Everything above the glow.
.mgmt__rail,
.mgmt__pane {
  position: relative;
  z-index: 1;
}

// ── Section rail ────────────────────────────────────────────────────────────
.mgmt__rail {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
  min-height: 0;
  padding: var(--k-sp-2);
  background: color-mix(in srgb, var(--k-surface) 70%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-lg);
  overflow-y: auto;
}

.mgmt__rail-head {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-3) 0;
}

// Which tab you are in, small and spaced out, over the scope it applies to.
.mgmt__eyebrow {
  font-size: 10px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--k-faint);
}

.mgmt__chip {
  display: inline-flex;
  align-items: center;
  gap: var(--k-sp-2);
  max-width: 100%;
  padding: 5px var(--k-sp-3);
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-xs);
  color: var(--k-text);
  background: color-mix(in srgb, var(--k-surface2) 55%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-pill);
}

.mgmt__chip--empty {
  color: var(--k-faint);
  border-style: dashed;
  background: transparent;
}

.mgmt__chip-dot {
  width: 7px;
  height: 7px;
  border-radius: var(--k-r-pill);
  flex: none;
}

// Stands in the dot's place when the workspace has an emoji: a box the dot's width so the
// name keeps its x, the glyph overflowing symmetrically. line-height:1 holds the centre line.
.mgmt__chip-emoji {
  flex: none;
  width: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  line-height: 1;
}

.mgmt__chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mgmt__rail-note {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-xs);
  line-height: 1.35;
  color: var(--k-faint);
}

.mgmt__rail-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

// ── Section pane ────────────────────────────────────────────────────────────
.mgmt__pane {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-4);
  min-height: 0;
  padding: var(--k-sp-5) var(--k-sp-5) var(--k-sp-4);
  background: color-mix(in srgb, var(--k-surface) 45%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-lg);
}

.mgmt__head {
  flex: none;
  padding-bottom: var(--k-sp-3);
  border-bottom: var(--k-rule-thin) solid var(--k-line);
}

.mgmt__heading {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1;
  color: var(--k-text);
}

// The section's own content. Top-aligned and scrolling: the pane is a document
// column now, not a stage with one card centred in it.
//
// That also settles what `safe center` was here for: a section taller than the frame — Risk
// Registry with a full register — is centred INTO its own overflow by plain centering, and
// the part above the top edge cannot be scrolled back to, because scrollTop 0 is already
// past it. Flex-start has no such state; it overflows downward only, so the whole register
// stays reachable.
.mgmt__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  // Room for the floating pill at the foot: content scrolls BEHIND it, but the last row of
  // a section must still be readable once scrolled to the end. 52px of pill + its 16px
  // offset, less the 16px of pane padding the body already ends above, plus 8px of air.
  padding-bottom: 60px;
}

// ── Blank / no-workspace state — mirrors AgentsPage's invitation ─────────────
.mgmt__blank {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 10px;
}

.mgmt__blank-eyebrow {
  font-size: var(--k-fs-xs);
  letter-spacing: 0.2em;
  color: var(--k-muted);
}

.mgmt__blank-text {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  color: var(--k-muted);
}

// The local-only-project line: same invitation stack, one step quieter and one step
// smaller, because it explains the state the line above it just announced rather than
// competing with it. Measured so the sentence wraps at a readable line rather than
// running the pane's full width.
.mgmt__blank-note {
  margin-top: var(--k-sp-2);
  max-width: 52ch;
  font-size: var(--k-fs-sm);
  color: var(--k-faint);
}

// The shell's own drawer already owns 264px; below this the two rails plus a
// section body stop fitting side by side at a readable measure, so the section
// rail gives up its second line's comfort first.
@media (max-width: 1180px) {
  .mgmt {
    grid-template-columns: 196px minmax(0, 1fr);
  }
}
</style>
