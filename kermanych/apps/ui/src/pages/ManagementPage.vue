<template>
  <main class="mgmt">
    <div class="mgmt__atmo" aria-hidden="true"></div>
    <header class="mgmt__head">
      <div class="mgmt__title">
        <span class="mgmt__eyebrow mono">Менеджмент</span>
        <h1 class="mgmt__heading">{{ sectionLabel }}</h1>
      </div>
      <!-- The scope, stated where the eye lands after the heading: every section
           below reports on this one project. Greyed out and dot-less while nothing
           is chosen, so the chip reads as an empty slot rather than a label. -->
      <span class="mgmt__chip" :class="{ 'mgmt__chip--empty': !projectId }">
        <span
          v-if="projectId"
          class="mgmt__chip-dot"
          :style="{ background: projectColor }"
          aria-hidden="true"
        ></span>
        <span class="mgmt__chip-name">{{ projectName || 'проєкт не вибрано' }}</span>
      </span>
    </header>

    <KSubNav
      :model-value="activeSection"
      :items="tabs"
      aria-label="Розділи менеджменту"
      @update:model-value="goSection"
    />

    <!-- The selection IS the access rule: every section reports on one project, so
         with none chosen there is nothing to report on. Same invitation the
         Агенти view shows, rather than five sections each repeating it. -->
    <div v-if="!projectId" class="mgmt__blank">
      <div class="mgmt__blank-eyebrow mono">КЕРМАНИЧ</div>
      <p class="mgmt__blank-text">
        Виберіть проєкт у лівій панелі, щоб побачити його менеджмент.
      </p>
    </div>
    <template v-else>
      <div class="mgmt__body">
        <router-view :project-id="projectId" :project-name="projectName" />
      </div>

      <!-- WIP composer, docked to the foot of the page like the chat composer:
           the section's content owns the space above it, the input keeps the
           bottom edge whatever the section renders. Page furniture, deliberately
           not a kit component yet — it is inert (readonly field, disabled
           controls) and gets promoted to components/kit once it does something.
           Frosted capsule over the page's glow layer, which is why `.mgmt__atmo`
           exists rather than a flat canvas behind it: glass needs a substrate. -->
      <form class="mgmt__composer" aria-label="Поле введення (у розробці)" @submit.prevent>
        <button class="mgmt__c-icon" type="button" disabled title="У розробці">⊞</button>
        <input
          class="mgmt__c-input"
          type="text"
          readonly
          aria-readonly="true"
          :value="WIP_TEXT"
          title="У розробці — поле поки не працює"
        />
        <button class="mgmt__c-icon" type="button" disabled title="У розробці">⚙</button>
        <button class="mgmt__c-send" type="button" disabled title="У розробці" aria-label="Надіслати">+</button>
      </form>
    </template>
  </main>
</template>

<script setup lang="ts">
// Shell of the Менеджмент tab: the section strip, the «pick a project» gate, and
// the project every section is scoped to. The sections themselves are the child
// routes of /management (lib/management.ts) — this component decides WHETHER one
// renders and WHICH project it renders for; it never renders their content.
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import KSubNav from 'components/kit/KSubNav.vue';
import { MANAGEMENT_SECTIONS } from '../lib/management';

const store = useOrchestrator();
const projects = useProjects();
const route = useRoute();
const router = useRouter();

const tabs = MANAGEMENT_SECTIONS.map((s) => ({ value: s.name, label: s.label }));
// The child route name IS the tab value, so the strip follows deep links and the
// browser's back button with no state of its own.
const activeSection = computed(() => (typeof route.name === 'string' ? route.name : ''));
const sectionLabel = computed(
  () => MANAGEMENT_SECTIONS.find((s) => s.name === activeSection.value)?.label ?? 'Менеджмент',
);
function goSection(name: string): void {
  if (route.name !== name) void router.push({ name });
}

const projectId = computed(() => store.selectedProjectId);

// Prefer the cloud name, fall back to the cached local row — the shell header's
// two-lookup idiom, so a project whose sync failed still reads right here.
const projectName = computed(() => {
  const id = projectId.value;
  if (!id) return '';
  return projects.byId.get(id)?.name ?? store.projects.find((p) => p.id === id)?.name ?? '';
});

// The field is inert on purpose — this is the shape of the thing, not the thing.
const WIP_TEXT = 'I am a dummy that is in WIP';

// Same join the sidebar rail uses for its tile colour; the accent is the fallback
// so an uncoloured project still gets a dot instead of a hole.
const projectColor = computed(() => {
  const id = projectId.value;
  if (!id) return 'var(--k-accent)';
  const local = store.projects.find((p) => p.id === id);
  return projects.byId.get(id)?.color ?? local?.color ?? 'var(--k-accent)';
});
</script>

<style scoped lang="scss">
.mgmt {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-4);
  height: calc(100vh - 82px);
  min-height: 0;
  padding: var(--k-sp-4);
  background: var(--k-canvas);
  overflow: hidden;
}

// Dim pools of light so the frosted capsule has something to bend — a flat canvas
// behind glass renders as plain grey. The first pool sits directly under the
// composer, which is what makes its fill read as frost rather than as paint.
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
      520px 220px at 50% 97%,
      color-mix(in srgb, var(--k-accent) 10%, transparent),
      transparent 72%
    ),
    radial-gradient(
      680px 340px at 44% 112%,
      color-mix(in srgb, var(--k-surface2) 85%, transparent),
      transparent 70%
    ),
    radial-gradient(
      620px 320px at 88% 2%,
      color-mix(in srgb, var(--k-surface2) 70%, transparent),
      transparent 72%
    );
}

// Everything above the glow.
.mgmt__head,
.mgmt__body,
.mgmt__composer {
  position: relative;
  z-index: 1;
}

.mgmt__head {
  display: flex;
  align-items: center;
  gap: var(--k-sp-3);
}

.mgmt__title {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

// Breadcrumb without the slashes: the tab you are in, small and spaced out, over
// the section you are looking at.
.mgmt__eyebrow {
  font-size: 10px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--k-faint);
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

.mgmt__chip {
  display: inline-flex;
  align-items: center;
  gap: var(--k-sp-2);
  margin-left: auto;
  padding: 5px var(--k-sp-3);
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-xs);
  color: var(--k-text);
  background: color-mix(in srgb, var(--k-surface2) 55%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-pill);
  max-width: 320px;
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

.mgmt__chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// The section's own content, centred in whatever space the docked composer leaves.
.mgmt__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--k-sp-5);
}

// ── WIP composer — frosted capsule ──────────────────────────────────────────
.mgmt__composer {
  flex: none;
  // Centred on the page's foot, not stretched across it: a capsule pulled to the
  // full width of a 1400px window reads as a toolbar, and its trailing controls
  // end up a screen away from the text they belong to. Capped at a comfortable
  // measure and centred, it stays a single object.
  align-self: center;
  width: min(680px, 100%);
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  padding: 7px 7px 7px var(--k-sp-3);
  // Frosted, not see-through: a heavy blur under a mostly-opaque surface tint,
  // so text stays readable while the glow behind still bleeds through the edges.
  background: color-mix(in srgb, var(--k-surface) 74%, transparent);
  -webkit-backdrop-filter: blur(22px) saturate(150%);
  backdrop-filter: blur(22px) saturate(150%);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-pill);
  // Cast + the 1px top highlight that sells a glass edge under a light source.
  box-shadow:
    var(--k-shadow-toast),
    inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent);
}

.mgmt__c-input {
  flex: 1;
  min-width: 0;
  appearance: none;
  border: none;
  background: transparent;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  letter-spacing: -0.01em;
  color: var(--k-text);
  // Readonly: it takes focus (so the ring proves it is a real field) but refuses
  // a caret, which is the honest signal that nothing is wired behind it.
  cursor: default;

  &:focus {
    outline: none;
  }

  &::selection {
    background: color-mix(in srgb, var(--k-accent) 28%, transparent);
  }
}

.mgmt__c-icon {
  flex: none;
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  appearance: none;
  border: none;
  border-radius: var(--k-r-pill);
  background: transparent;
  color: var(--k-muted);
  font-size: 17px;
  line-height: 1;
  transition:
    color 0.16s ease,
    background 0.16s ease;

  &:disabled {
    cursor: not-allowed;
    opacity: 0.72;
  }

  &:not(:disabled):hover {
    color: var(--k-text);
    background: color-mix(in srgb, var(--k-surface2) 70%, transparent);
  }
}

// The one loud element, exactly as in the reference: a filled accent disc.
.mgmt__c-send {
  flex: none;
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  appearance: none;
  border: none;
  border-radius: var(--k-r-pill);
  background: var(--k-accent);
  color: var(--k-on-accent);
  font-size: 19px;
  font-weight: var(--k-fw-semibold);
  line-height: 1;
  box-shadow: 0 4px 16px -4px color-mix(in srgb, var(--k-accent) 75%, transparent);

  // Not dimmed: `opacity` on an accent disc washes it to salmon over the light
  // canvas. The cursor, the title and the field's own text carry the WIP state,
  // so the disc keeps the exact hue it will have once it works.
  &:disabled {
    cursor: not-allowed;
  }
}

// ── Blank / no-project state — mirrors AgentsPage's invitation ───────────────
.mgmt__blank {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 10px;
  padding: 0 40px;
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
</style>
