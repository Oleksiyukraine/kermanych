<script setup lang="ts">
// The session list (spec decision 3 and «Which sessions the phone lists»): every listed session
// of every project, grouped by project, «needs you» first (lib/list.ts). Live through the socket;
// a skeleton while the first list is on its way, the empty state only once it arrived empty.
import { computed } from "vue";
import { useLoadPhase, useNow } from "../lib/async";
import { thisDeviceName } from "../lib/device";
import { relativeTime, statusText, t } from "../lib/i18n";
import { groupSessions, needsAttention } from "../lib/list";
import { pushState, pushSupport } from "../lib/push";
import { openSession } from "../lib/route";
import { state } from "../lib/store";
import ConnectionBanner from "./ConnectionBanner.vue";
import PushPanel from "./PushPanel.vue";
import StatusDot from "./StatusDot.vue";

const now = useNow();
const phase = useLoadPhase(() => state.sessions === undefined);
const groups = computed(() => groupSessions([...(state.sessions?.values() ?? [])], state.projects));

// Push is offered above the list until it is on (it matters most on the first launch after
// pairing, and a long list would hide it); once on, or when it cannot be, it sits at the bottom.
const support = pushSupport();
const pushOnTop = computed(
  () => support === "ios_install" || (support === "supported" && pushState.subscribed === false && pushState.permission !== "denied"),
);
</script>

<template>
  <div class="screen">
    <header class="topbar">
      <h1 class="topbar__title">{{ t("list.title") }}</h1>
      <span v-if="state.me" class="list__host muted">{{ state.me.host }}</span>
    </header>
    <ConnectionBanner />

    <main class="list pad-x">
      <PushPanel v-if="pushOnTop" />

      <div v-if="phase === 'skeleton'" class="list__skeleton" aria-hidden="true">
        <div v-for="i in 5" :key="i" class="skeleton list__skeleton-row" />
      </div>

      <template v-else-if="phase === 'ready'">
        <div v-if="groups.length === 0" class="list__empty">
          <strong>{{ t("list.empty") }}</strong>
          <span class="muted">{{ t("list.emptyHint") }}</span>
        </div>

        <section v-for="g in groups" :key="g.id" class="group">
          <h2 class="group__title">
            <span class="group__swatch" :style="g.color ? { background: g.color } : undefined" />
            {{ g.name ?? t("list.otherProject") }}
          </h2>
          <ul class="group__rows">
            <li v-for="s in g.sessions" :key="s.id">
              <button type="button" class="row" :class="{ 'row--attention': needsAttention(s.status) }" @click="openSession(s.id)">
                <StatusDot :status="s.status" class="row__dot" />
                <span class="row__body">
                  <span class="row__name">{{ s.name }}</span>
                  <span class="row__meta">
                    <span class="row__status">{{ statusText(s.status) }}</span>
                    <span v-if="s.native" class="row__tag">{{ t("session.native") }}</span>
                    · {{ g.name ?? t("list.otherProject") }} · {{ relativeTime(s.lastActivityAt, now) }}
                  </span>
                </span>
                <span v-if="needsAttention(s.status)" class="row__mark">{{ t("list.attention") }}</span>
              </button>
            </li>
          </ul>
        </section>
      </template>

      <footer v-if="phase === 'ready'" class="list__footer">
        <PushPanel v-if="!pushOnTop" />
        <p class="list__device muted">
          {{ t("device.this") }}: {{ state.me?.name ?? thisDeviceName() }}
        </p>
      </footer>
    </main>
  </div>
</template>

<style scoped>
.list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-4);
  padding-top: var(--k-sp-4);
  padding-bottom: calc(var(--k-sp-6) + env(safe-area-inset-bottom));
}
.list__host {
  font-size: var(--k-fs-sm);
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.list__skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}
.list__skeleton-row {
  height: 60px;
  border-radius: var(--k-r);
}
.list__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--k-sp-1);
  padding: var(--k-sp-7) 0;
  text-align: center;
}
.group__title {
  position: sticky;
  top: calc(52px + env(safe-area-inset-top));
  z-index: 1;
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  margin: 0;
  padding: var(--k-sp-2) 0;
  background: var(--k-bg);
  color: var(--k-muted);
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.group__swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: var(--k-faint);
}
.group__rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}
.row {
  display: flex;
  align-items: center;
  gap: var(--k-sp-3);
  width: 100%;
  min-height: 60px;
  padding: var(--k-sp-2) var(--k-sp-3);
  border-radius: var(--k-r);
  border: var(--k-rule-thin) solid var(--k-line);
  background: var(--k-surface);
  background-image: var(--k-grad-raise);
  box-shadow: var(--k-shadow-card);
  text-align: left;
  cursor: pointer;
  touch-action: manipulation;
}
.row:active {
  background-color: var(--k-surface2);
}
.row--attention {
  border-color: color-mix(in srgb, var(--k-accent) 45%, var(--k-line));
}
.row__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.row__name {
  font-weight: var(--k-fw-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row__meta {
  color: var(--k-muted);
  font-size: var(--k-fs-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row__status {
  color: var(--k-text);
}
.row__tag {
  margin-left: var(--k-sp-1);
  padding: 0 var(--k-sp-1);
  border-radius: var(--k-r-sm);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  font-size: var(--k-fs-xs);
}
.row__mark {
  flex: none;
  padding: 2px var(--k-sp-2);
  border-radius: var(--k-r-pill);
  background: var(--k-accent);
  color: var(--k-on-accent);
  font-size: var(--k-fs-xs);
  font-weight: var(--k-fw-semibold);
}
.list__footer {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
  padding-top: var(--k-sp-4);
}
.list__device {
  margin: 0;
  font-size: var(--k-fs-sm);
  text-align: center;
}
</style>
