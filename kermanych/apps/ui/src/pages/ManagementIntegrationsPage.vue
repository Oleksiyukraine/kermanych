<template>
  <section class="int">
    <p class="int__lead">
      Підключіть зовнішні сервіси до воркспейсу
      <span class="int__lead-workspace mono">{{ workspaceName }}</span>
    </p>

    <div class="int__grid">
      <article
        v-for="brand in BRANDS"
        :key="brand.id"
        class="int__tile"
        :style="{ '--brand': brand.color }"
      >
        <span class="int__mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path :d="brand.path" fill="currentColor" />
          </svg>
        </span>
        <h3 class="int__name">{{ brand.name }}</h3>
        <p class="int__blurb">{{ brand.blurb }}</p>
        <!-- The bubble hangs on the ROW, not on the button: `v-tip` binds mouseenter/focusin,
             and Chromium dispatches neither on a disabled control — the same dead-tooltip
             constraint AgentsPage and MainLayout document. The row is the cursor's target on
             the way to «Підключити» and reads correctly for the state chip beside it too.
             It replaces a native `title`, which drew the OS rectangle in a rounded UI. -->
        <div v-tip="'У розробці'" class="int__foot">
          <span class="int__state mono">
            <i class="int__state-dot" aria-hidden="true"></i>не підключено
          </span>
          <button class="int__cta" type="button" disabled>Підключити</button>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
// Integrations — the first Менеджмент section with a screen of its own rather than
// the shared placeholder. Presentation ONLY: nothing here talks to Linear, Jira or
// Slack, every «Підключити» is disabled, and no state is stored. The tiles exist
// so the shape of the feature can be judged before it is built.
//
// It takes the same props every section gets from ManagementPage, so the workspace
// it would connect to is already named for it.
defineProps<{ workspaceId: string; workspaceName: string }>();

type Brand = {
  id: string;
  name: string;
  blurb: string;
  // Display colour, NOT the raw brand hex. Each is mixed toward `--k-text` in the
  // stylesheet, which is what keeps one value legible in both palettes: on the dark
  // set it lightens, on the light set it darkens. A raw #4A154B (Slack aubergine)
  // is invisible on near-black; a raw #36C5F0 washes out on white.
  color: string;
  // Official marks, single path, 24×24 — simple-icons (CC0). Kept as data rather
  // than five inline <svg> blocks so a fourth service is one row.
  path: string;
};

const BRANDS: readonly Brand[] = [
  {
    id: 'linear',
    name: 'Linear',
    blurb: 'Задачі та цикли команди',
    color: '#5E6AD2',
    path: 'M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z',
  },
  {
    id: 'jira',
    name: 'Jira',
    blurb: 'Тікети, спринти, беклог',
    color: '#0052CC',
    path: 'M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z',
  },
  {
    id: 'slack',
    name: 'Slack',
    blurb: 'Сповіщення в канал',
    color: '#36C5F0',
    path: 'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z',
  },
];
</script>

<style scoped lang="scss">
.int {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-4);
  // Same measure as the docked composer, so the column and the input share an edge.
  width: min(680px, 100%);
  padding: var(--k-sp-4) 0;
}

.int__lead {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  color: var(--k-muted);
}

.int__lead-workspace {
  color: var(--k-text);
}

.int__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: var(--k-sp-3);
}

.int__tile {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-4);
  background: color-mix(in srgb, var(--k-surface2) 40%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-lg);
  transition:
    border-color 0.16s ease,
    background 0.16s ease,
    transform 0.16s ease;

  // The surface answers the pointer even though the action does not: the disabled
  // button is what states «not yet», not a dead tile.
  &:hover {
    transform: translateY(-1px);
    border-color: color-mix(in srgb, var(--brand) 45%, var(--k-line));
    background: color-mix(in srgb, var(--k-surface2) 62%, transparent);
  }
}

.int__mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: var(--k-r);
  // Brand hue, legibility borrowed from the text token — see the `color` note above.
  color: color-mix(in srgb, var(--brand) 76%, var(--k-text));
  background: color-mix(in srgb, var(--brand) 14%, transparent);
  border: var(--k-rule-thin) solid color-mix(in srgb, var(--brand) 28%, transparent);

  svg {
    width: 18px;
    height: 18px;
    display: block;
  }
}

.int__name {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  font-weight: var(--k-fw-semibold);
  letter-spacing: -0.01em;
  color: var(--k-text);
}

.int__blurb {
  margin: 0;
  flex: 1;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1.4;
  color: var(--k-muted);
}

.int__foot {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--k-sp-2);
  margin-top: var(--k-sp-1);
}

.int__state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  letter-spacing: 0.04em;
  white-space: nowrap;
  color: var(--k-faint);
}

// Hollow, not filled: nothing is live behind it, and a solid dot in this app means
// a running session.
.int__state-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--k-r-pill);
  border: var(--k-rule-thin) solid var(--k-faint);
}

.int__cta {
  appearance: none;
  // Full width, on its own row: side by side with the status line it overflowed a
  // three-up tile and broke «не підключено» across two lines.
  width: 100%;
  padding: 6px var(--k-sp-3);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-medium);
  color: var(--k-text);
  background: transparent;
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-pill);

  &:disabled {
    cursor: not-allowed;
    color: var(--k-faint);
    border-color: var(--k-line);
  }
}

@media (prefers-reduced-motion: reduce) {
  .int__tile:hover {
    transform: none;
  }
}
</style>
