<template>
  <section class="agent-map" :aria-label="t('agents.map.title')">
    <!-- Before the socket snapshot there is no machine to draw: a skeleton, not «нікого». -->
    <KSkeleton v-if="!store.snapshotReceived" variant="card" :rows="3" class="agent-map__skeleton" />
    <template v-else>
      <VueFlow
        class="agent-map__flow"
        :class="{ 'agent-map__flow--unfitted': !fitted }"
        :nodes="flowNodes"
        :edges="flowEdges"
        :nodes-draggable="false"
        :nodes-connectable="false"
        :elements-selectable="false"
        :zoom-on-double-click="false"
        :pan-on-scroll="true"
        :min-zoom="0.15"
        :max-zoom="1.6"
      >
        <Background :gap="22" :size="1.2" class="agent-map__grid" />
        <MiniMap
          class="agent-map__minimap"
          pannable
          zoomable
          :node-class-name="miniClass"
          :node-border-radius="4"
          :aria-label="t('agents.map.minimap')"
        />

        <template #node-workspace="{ data }">
          <Handle type="source" :position="Position.Bottom" :connectable="false" class="agent-map__handle" />
          <button type="button" class="agent-map__card agent-map__card--group" @click="toggle(data.node.id)">
            <span v-if="data.node.workspace?.icon" class="agent-map__ws-icon" aria-hidden="true">{{ data.node.workspace.icon }}</span>
            <span v-else class="agent-map__ws-dot" :style="{ background: data.node.workspace?.color ?? 'var(--k-faint)' }" aria-hidden="true"></span>
            <span class="agent-map__group-name">{{ data.node.workspace?.name ?? t('agents.map.noWorkspace') }}</span>
            <span v-if="data.node.active" class="agent-map__group-count mono">{{ t('agents.map.activeCount', data.node.active) }}</span>
          </button>
          <FoldToggle :placed="data" @toggle="toggle(data.node.id)" />
        </template>

        <template #node-project="{ data }">
          <Handle type="target" :position="Position.Top" :connectable="false" class="agent-map__handle" />
          <Handle type="source" :position="Position.Bottom" :connectable="false" class="agent-map__handle" />
          <button type="button" class="agent-map__card agent-map__card--group agent-map__card--project" @click="toggle(data.node.id)">
            <span class="agent-map__ws-dot agent-map__ws-dot--project" :style="{ borderColor: data.node.color ?? 'var(--k-faint)' }" aria-hidden="true"></span>
            <span class="agent-map__group-name">{{ data.node.name }}</span>
            <span v-if="data.node.active" class="agent-map__group-count mono">{{ t('agents.map.activeCount', data.node.active) }}</span>
          </button>
          <FoldToggle :placed="data" @toggle="toggle(data.node.id)" />
        </template>

        <template #node-session="{ data }">
          <Handle type="target" :position="Position.Top" :connectable="false" class="agent-map__handle" />
          <Handle type="source" :position="Position.Bottom" :connectable="false" class="agent-map__handle" />
          <button
            type="button"
            class="agent-map__card agent-map__card--agent"
            :class="{
              'agent-map__card--live': data.live,
              'agent-map__card--selected': data.node.session.id === selectedSessionId,
            }"
            :aria-label="t('agents.map.openSession', { name: data.node.session.name })"
            @click="emit('open-session', data.node.session.id)"
          >
            <span class="agent-map__row">
              <KStatusDot :status="data.node.session.status" />
              <span class="agent-map__title">{{ data.node.session.name }}</span>
              <span v-if="data.node.session.openFindings" class="agent-map__findings mono">⚑ {{ data.node.session.openFindings }}</span>
            </span>
            <span class="agent-map__line">{{ sessionLine(data.node.session) }}</span>
            <span class="agent-map__meta mono">
              <KHarnessMark v-if="data.node.session.kind !== 'task'" :harness="sessionLaunchMode(data.node.session)" />
              <KAnalysisMark v-if="data.node.session.deepAnalysis" />
              <KDesignMark v-if="data.node.session.designDir" />
              <KMinionMark v-if="data.node.session.minion" kind="running" />
              <KDecisionMark v-if="sessionDecisionReason(t, data.node.session)" :reason="sessionDecisionReason(t, data.node.session)!" />
              <KNotNeededMark v-else-if="sessionNotNeededReason(t, data.node.session)" :reason="sessionNotNeededReason(t, data.node.session)!" />
              <span v-if="data.node.session.model" class="agent-map__model">{{ data.node.session.model }}</span>
              <span v-if="spendOf(data.node.session)" class="agent-map__spend">{{ spendOf(data.node.session) }}</span>
            </span>
          </button>
          <FoldToggle :placed="data" @toggle="toggle(data.node.id)" />
        </template>

        <template #node-subagent="{ data }">
          <Handle type="target" :position="Position.Top" :connectable="false" class="agent-map__handle" />
          <Handle type="source" :position="Position.Bottom" :connectable="false" class="agent-map__handle" />
          <button
            type="button"
            class="agent-map__card agent-map__card--agent agent-map__card--sub"
            :class="{
              'agent-map__card--live': data.live,
              'agent-map__card--selected': drawer?.nodeId === data.node.id,
            }"
            @click="openDrawer(data.node)"
          >
            <span class="agent-map__row">
              <KStatusDot :status="subagentDot(data.node.subagent.status)" />
              <span class="agent-map__title agent-map__title--sub">{{ data.node.subagent.description || data.node.subagent.id }}</span>
            </span>
            <span class="agent-map__meta mono">{{ subagentMeta(data.node.subagent) }}</span>
          </button>
          <FoldToggle :placed="data" @toggle="toggle(data.node.id)" />
        </template>
      </VueFlow>

      <div class="agent-map__overlay">
        <!-- The chips: which buckets are on the map. Same words as the «Агенти» tabs. -->
        <div class="agent-map__chips" role="group" :aria-label="t('agents.map.filter')">
          <button
            v-for="b in MAP_BUCKETS"
            :key="b"
            type="button"
            class="agent-map__chip mono"
            :class="{ 'agent-map__chip--on': buckets.includes(b) }"
            :aria-pressed="buckets.includes(b)"
            @click="toggleBucket(b)"
          >{{ t(`agents.bucket.${b}`) }} <span class="agent-map__chip-count">{{ bucketCounts[b] }}</span></button>
        </div>
        <!-- «Посіпака» on this machine: working (N of the cap, the queue, the projects) or paused
             with the reason, with ⏸ / ▶. Hidden while no project is active here — nothing to say. -->
        <div v-if="minionStrip" class="agent-map__minion mono" :class="{ 'agent-map__minion--paused': minion.state?.pause }">
          <span class="agent-map__minion-text">{{ minionStrip }}</span>
          <KIconButton
            :title="minion.state?.pause ? t('minion.strip.resume') : t('minion.strip.pause')"
            :loading="minionToggling"
            @click="toggleMinion(!minion.state?.pause)"
          >{{ minion.state?.pause ? '▶' : '⏸' }}</KIconButton>
        </div>
      </div>

      <div class="agent-map__tools">
        <KIconButton :title="t('agents.map.zoomIn')" @click="zoomIn({ duration: 150 })">+</KIconButton>
        <KIconButton :title="t('agents.map.zoomOut')" @click="zoomOut({ duration: 150 })">−</KIconButton>
        <KIconButton :title="t('agents.map.fit')" @click="fitAll()">⤢</KIconButton>
      </div>

      <p v-if="!tree.length" class="agent-map__empty mono">{{ t('agents.map.empty') }}</p>

      <!-- A subagent has no chat of its own: its transcript opens here, over the map's edge. -->
      <aside v-if="drawer" class="agent-map__drawer" :aria-label="drawerTitle">
        <header class="agent-map__drawer-head">
          <div class="agent-map__drawer-id">
            <KStatusDot :status="subagentDot(drawerNode?.status)" />
            <span class="agent-map__drawer-title">{{ drawerTitle }}</span>
          </div>
          <KIconButton :title="t('agents.map.closeDrawer')" @click="drawer = undefined">✕</KIconButton>
        </header>
        <p v-if="drawerNode" class="agent-map__drawer-meta mono">{{ subagentMeta(drawerNode, true) }}</p>
        <div class="agent-map__drawer-body">
          <KSkeleton v-if="drawerPhase === 'skeleton'" variant="lines" :rows="6" />
          <template v-else-if="drawerPhase === 'blank'"></template>
          <template v-else-if="drawerEntries?.length">
            <KLogBlock
              v-for="(entry, i) in drawerEntries"
              :key="i"
              :entry="entry"
              :session-id="drawer.sessionId"
              :expand-all="EXPAND_ALL_NONE"
            />
          </template>
          <p v-else class="agent-map__empty-line mono">{{ t('agents.map.transcriptEmpty') }}</p>
        </div>
      </aside>
    </template>
  </section>
</template>

<script lang="ts">
// The operator's own folds outlive closing and reopening the map, for as long as this window
// lives (spec decision 9) — module state, not localStorage: a fold names a node of a session
// that may be gone tomorrow.
import { reactive } from 'vue';
const collapseOverrides = reactive(new Map<string, boolean>());
</script>

<script setup lang="ts">
import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import { VueFlow, Handle, Position, useVueFlow, type Node, type Edge, type GraphNode } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { MiniMap } from '@vue-flow/minimap';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/minimap/dist/style.css';
import type { Session, SessionStatus, SubagentNode, TranscriptEntry } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import { useMinion } from 'stores/minion';
import { api } from '../../lib/api';
import { bucketOf } from '../../lib/buckets';
import { EXPAND_ALL_NONE } from '../../lib/expand-all';
import { tokens, usageTokens, usd } from '../../lib/format';
import { sessionLaunchMode } from '../../lib/native-session';
import { minionStripText, sessionDecisionReason, sessionNotNeededReason } from '../../lib/minion';
import { useAsyncAction } from '../../composables/useAsyncAction';
import {
  MAP_BUCKETS,
  NODE_SIZE,
  ancestorIds,
  buildAgentTree,
  layoutAgentTree,
  parseMapBuckets,
  visibleSubtreeIds,
  type MapBucket,
  type PlacedNode,
  type SubagentTreeNode,
} from '../../lib/agentMap';
import { useLoadPhase } from '../../composables/useLoadPhase';
import KStatusDot from 'components/kit/KStatusDot.vue';
import KHarnessMark from 'components/kit/KHarnessMark.vue';
import KAnalysisMark from 'components/kit/KAnalysisMark.vue';
import KDesignMark from 'components/kit/KDesignMark.vue';
import KMinionMark from 'components/kit/KMinionMark.vue';
import KDecisionMark from 'components/kit/KDecisionMark.vue';
import KNotNeededMark from 'components/kit/KNotNeededMark.vue';
import KIconButton from 'components/kit/KIconButton.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import KLogBlock from 'components/kit/KLogBlock.vue';

// «Карта агентів» (spec docs/specs/2026-10-22-agent-map.md): every agent on this machine as a
// top-down tree, in place of the chat pane. What is on it, what is folded and where each card
// sits is lib/agentMap.ts; this file draws that with Vue Flow and owns the interaction.
const props = defineProps<{
  // What to fit into view when the map opens: a map node id (absent: everything), and whether
  // to unfold it too — ◈ wants the session's subagents on screen.
  focusId: string | undefined;
  unfoldFocus: boolean;
  selectedSessionId: string | undefined;
  // The status line a session card shows on the board, so the map words it identically.
  sessionLine: (s: Session) => string;
}>();
const emit = defineEmits<{ 'open-session': [id: string]; close: [] }>();

const { t } = useI18n();
const store = useOrchestrator();
const projects = useProjects();
// No id: a fresh flow store per mount, provided to the <VueFlow> below and dropped with it.
const { fitView, zoomIn, zoomOut, onNodesInitialized } = useVueFlow();

// ── Chips ────────────────────────────────────────────────────────────────
const BUCKETS_KEY = 'kermanych.agents.map.buckets';
const buckets = ref<MapBucket[]>(parseMapBuckets(localStorage.getItem(BUCKETS_KEY)));
function toggleBucket(b: MapBucket): void {
  const on = new Set(buckets.value);
  if (on.has(b)) on.delete(b);
  else on.add(b);
  buckets.value = MAP_BUCKETS.filter((x) => on.has(x));
  localStorage.setItem(BUCKETS_KEY, JSON.stringify(buckets.value));
}

// ── «Посіпака» strip ─────────────────────────────────────────────────────
const minion = useMinion();
const minionStrip = computed(() =>
  minion.state
    ? minionStripText(t, minion.state, (id) => projects.byId.get(id)?.name ?? store.projects.find((p) => p.id === id)?.name)
    : undefined,
);
// ⏸ pauses as the operator, ▶ resumes (and clears the failure count); the echo is the new state.
const { run: toggleMinion, busy: minionToggling } = useAsyncAction((paused: boolean) => minion.setPaused(paused));
const bucketCounts = computed(() => {
  const counts: Record<MapBucket, number> = { agents: 0, completed: 0 };
  const byId = new Map(store.sessions.map((s) => [s.id, s]));
  for (const s of store.sessions) {
    if (s.kind === 'chat' || s.status === 'backlog') continue;
    const b = bucketOf(s, (id) => byId.get(id));
    if (b !== 'tasks') counts[b]++;
  }
  return counts;
});

// ── Tree and layout ──────────────────────────────────────────────────────
const tree = computed(() =>
  buildAgentTree({
    sessions: store.sessions,
    subagents: store.subagents,
    projects: store.projects,
    projectWorkspace: store.projectWorkspace,
    workspaces: projects.orderedWorkspaces,
    buckets: buckets.value,
    unknownProject: t('agents.board.unknownProject'),
  }),
);
const layout = computed(() => layoutAgentTree(tree.value, collapseOverrides));

const flowNodes = computed<Node<PlacedNode>[]>(() =>
  layout.value.nodes.map((p) => {
    const size = NODE_SIZE[p.node.kind];
    return {
      id: p.node.id,
      type: p.node.kind,
      position: { x: p.x, y: p.y },
      data: p,
      width: size.w,
      height: size.h,
      focusable: false,
      // Vue Flow turns pointer events off on a node that is neither selectable, draggable nor
      // listened to; ours are none of those, yet every card is a button.
      style: { pointerEvents: 'all' },
    };
  }),
);
const flowEdges = computed<Edge[]>(() =>
  layout.value.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: 'default',
    animated: e.live,
    class: `agent-map__edge agent-map__edge--${e.kind}${e.live ? ' agent-map__edge--live' : ''}`,
  })),
);

function miniClass(n: GraphNode<PlacedNode>): string {
  const p = n.data;
  if (!p) return 'agent-map__mini';
  return `agent-map__mini agent-map__mini--${p.node.kind}${p.live ? ' agent-map__mini--live' : ''}`;
}

function toggle(id: string): void {
  const p = layout.value.nodes.find((n) => n.node.id === id);
  if (!p || !p.node.children.length) return;
  collapseOverrides.set(id, !p.collapsed);
}

// ── Focus ────────────────────────────────────────────────────────────────
// Fit once, when the first cards are measured — never on a live update, so the operator's own
// pan and zoom survive every agent event. Until then the canvas stays hidden: Vue Flow first
// paints at its default viewport, and the jump from there to the focus read as a glitch.
const FIT = { padding: 0.18, maxZoom: 1 } as const;
const fitted = ref(false);
function fitAll(): void {
  void fitView({ ...FIT, duration: 250 });
}
// Two frames: one for Vue to render the unfolded cards, one for Vue Flow to measure them.
function afterPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
async function applyFocus(): Promise<void> {
  const id = props.focusId;
  const path = id ? ancestorIds(tree.value, id) : undefined;
  if (id && path) {
    for (const a of path) collapseOverrides.set(a, false);
    if (props.unfoldFocus) collapseOverrides.set(id, false);
  }
  await nextTick();
  await afterPaint();
  // Never smaller than readable: a project with a dozen agents side by side would otherwise open
  // as a strip of specks. Past this zoom the focus is centred and the rest is a pan away (and on
  // the minimap); «Вписати все» still shows everything at whatever size it takes.
  if (id && path) await fitView({ ...FIT, minZoom: 0.7, nodes: visibleSubtreeIds(layout.value, id) });
  else await fitView(FIT);
  fitted.value = true;
}
onNodesInitialized(() => {
  if (!fitted.value) void applyFocus();
});

// ── Session cards ────────────────────────────────────────────────────────
function spendOf(s: Session): string {
  const u = s.usage;
  if (!u) return '';
  return [t('kit.sessionCard.tokens', { count: tokens(usageTokens(u)) }), usd(u.cost)].filter(Boolean).join(' · ');
}

// ── Subagent cards ───────────────────────────────────────────────────────
// A subagent's registry status as the kit's status dot reads a session's.
const SUBAGENT_DOT: Record<string, SessionStatus> = {
  running: 'thinking',
  idle: 'stopped',
  parked: 'stopped',
  aborted: 'stopped',
  done: 'done',
  error: 'error',
};
function subagentDot(status: string | undefined): SessionStatus {
  return (status && SUBAGENT_DOT[status]) || 'queued';
}

// ms as a compact wall-clock: `42s`, `21m 35s`, `1h 04m`.
function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// The `·`-joined subtitle: (status ·) agent · model · duration · tokens, each dropped while
// the node has not learned it (a running subagent has a status long before a token count).
// The card's dot already says the status; the drawer spells it out.
function subagentMeta(s: SubagentNode, withStatus = false): string {
  const parts: string[] = [];
  if (withStatus && s.status) {
    const key = `agents.map.status.${s.status}`;
    parts.push(s.status in SUBAGENT_DOT ? t(key) : s.status);
  }
  if (s.agent) parts.push(s.agent);
  if (s.model) parts.push(s.model);
  if (typeof s.durationMs === 'number') parts.push(fmtDuration(s.durationMs));
  if (typeof s.tokens === 'number') parts.push(t('agents.map.tokens', { n: tokens(s.tokens) }));
  return parts.join(' · ');
}

// ── Drawer ───────────────────────────────────────────────────────────────
const drawer = ref<{ nodeId: string; sessionId: string; subagentId: string } | undefined>(undefined);
// `undefined` while the transcript is being read — a skeleton, not «порожній».
const drawerEntries = ref<TranscriptEntry[] | undefined>([]);
const drawerPhase = useLoadPhase(() => drawerEntries.value === undefined);
// The live node, so its metrics keep moving while the drawer is open.
const drawerNode = computed(() => {
  const d = drawer.value;
  return d ? store.subagents[d.sessionId]?.find((n) => n.id === d.subagentId) : undefined;
});
const drawerTitle = computed(() => drawerNode.value?.description || drawer.value?.subagentId || '');

async function openDrawer(n: SubagentTreeNode): Promise<void> {
  const target = { nodeId: n.id, sessionId: n.sessionId, subagentId: n.subagent.id };
  drawer.value = target;
  drawerEntries.value = undefined;
  let entries: TranscriptEntry[] = [];
  try {
    entries = await api.getSubagentTranscript(target.sessionId, target.subagentId);
  } catch {
    // Unreadable (the session went dormant: 410) reads as the empty state, which already
    // says «порожній або недоступний».
  }
  // Another card may have been opened meanwhile.
  if (drawer.value?.nodeId === target.nodeId) drawerEntries.value = entries;
}

// Esc folds the drawer first, then the map. Not while typing, and not when something above
// the map (a modal, a menu) already took the key.
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
  if (document.querySelector('.k-modal')) return;
  e.preventDefault();
  if (drawer.value) drawer.value = undefined;
  else emit('close');
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

// The ▾/▸ under a card with children: what a fold hides is counted on it, so a folded branch
// never reads as a leaf. A sibling of the card's button — a button cannot nest one.
const FoldToggle = defineComponent({
  props: { placed: { type: Object as PropType<PlacedNode>, required: true } },
  emits: ['toggle'],
  setup(p, { emit: emitToggle }) {
    return () => {
      if (!p.placed.node.children.length) return null;
      const label = p.placed.collapsed ? t('agents.map.unfold', { n: p.placed.hidden }) : t('agents.map.fold');
      return h(
        'button',
        {
          type: 'button',
          class: ['agent-map__fold', 'mono', { 'agent-map__fold--closed': p.placed.collapsed }],
          'aria-label': label,
          'aria-expanded': !p.placed.collapsed,
          title: label,
          onClick: (ev: MouseEvent) => {
            ev.stopPropagation();
            emitToggle('toggle');
          },
        },
        p.placed.collapsed ? `▸ +${p.placed.hidden}` : '▾',
      );
    };
  },
});
</script>

<style scoped lang="scss">
.agent-map {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  background: var(--k-canvas);
}

.agent-map__skeleton {
  padding: var(--k-sp-5);
}

.agent-map__flow {
  width: 100%;
  height: 100%;
}

.agent-map__flow--unfitted {
  visibility: hidden;
}

// ── Canvas chrome ───────────────────────────────────────────────────────
// Vue Flow paints its pattern, minimap and edges through SVG attributes; CSS beats those, so
// the theme tokens decide every colour here and the light and matrix themes follow for free.
.agent-map :deep(.agent-map__grid pattern circle) {
  fill: var(--k-line-strong);
}

.agent-map :deep(.agent-map__minimap) {
  background: var(--k-surface);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r);
  overflow: hidden;
}

.agent-map :deep(.vue-flow__minimap-mask) {
  fill: var(--k-canvas);
  fill-opacity: 0.7;
}

.agent-map :deep(.agent-map__mini) {
  fill: var(--k-surface2);
  stroke: var(--k-line-strong);
}

.agent-map :deep(.agent-map__mini--live) {
  fill: var(--k-accent);
  stroke: var(--k-accent);
}

.agent-map :deep(.agent-map__edge .vue-flow__edge-path) {
  stroke: var(--k-line-strong);
  stroke-width: 1.5;
}

// «Belongs to»: thin and dashed — structure, not lineage.
.agent-map :deep(.agent-map__edge--belongs .vue-flow__edge-path) {
  stroke-width: 1;
  stroke-dasharray: 3 4;
}

// The path down to a working agent: accent, and Vue Flow's `animated` moves its dashes. Never
// hairline — a vertical 1px dash at a zoomed-out scale antialiases into grey.
.agent-map :deep(.agent-map__edge--live .vue-flow__edge-path) {
  stroke: var(--k-accent);
  stroke-width: 1.5;
  stroke-dasharray: 6 5;
}

.agent-map :deep(.agent-map__handle) {
  opacity: 0;
  pointer-events: none;
  min-width: 1px;
  min-height: 1px;
  width: 1px;
  height: 1px;
  border: none;
}

// ── Cards ───────────────────────────────────────────────────────────────
.agent-map__card {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  text-align: left;
  color: var(--k-text);
  background: var(--k-surface);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-lg);
  box-shadow: var(--k-shadow-pop);
  cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease;

  &:hover {
    border-color: var(--k-line-strong);
    background: var(--k-surface2);
  }

  &:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--k-accent);
  }
}

.agent-map__card--group {
  align-items: center;
  gap: var(--k-sp-2);
  padding: 0 var(--k-sp-3);
}

.agent-map__card--project {
  background: var(--k-bg);
}

.agent-map__ws-dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.agent-map__ws-dot--project {
  background: transparent;
  border: 2px solid;
}

.agent-map__ws-icon {
  flex: none;
  font-size: var(--k-fs-md);
  line-height: 1;
}

.agent-map__group-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-medium);
}

.agent-map__group-count {
  flex: none;
  font-size: var(--k-fs-xs);
  color: var(--k-accent);
}

.agent-map__card--agent {
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  padding: var(--k-sp-2) var(--k-sp-3);
}

// A working agent: an accent frame that breathes, like the status dot inside it.
.agent-map__card--live {
  border-color: var(--k-accent);
  animation: agent-map-breathe 1.8s ease-in-out infinite;
}

.agent-map__card--selected {
  background: var(--k-surface2);
  border-color: var(--k-text);
}

@keyframes agent-map-breathe {
  0%,
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
  50% {
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--k-accent) 22%, transparent);
  }
}

.agent-map__row {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  min-width: 0;
}

.agent-map__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-base);
}

.agent-map__title--sub {
  font-size: var(--k-fs-sm);
}

.agent-map__findings {
  flex: none;
  font-size: var(--k-fs-xs);
  color: var(--k-accent);
}

.agent-map__line {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.agent-map__meta {
  display: flex;
  align-items: center;
  gap: var(--k-sp-1);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.agent-map__model {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agent-map__model + .agent-map__spend::before {
  content: '· ';
}

.agent-map__spend {
  flex: none;
}

// ── Fold toggle ─────────────────────────────────────────────────────────
.agent-map :deep(.agent-map__fold) {
  position: absolute;
  left: 50%;
  bottom: -10px;
  transform: translateX(-50%);
  z-index: 1;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r-pill);
  background: var(--k-bg);
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
  line-height: 1;
  cursor: pointer;

  &:hover {
    color: var(--k-text);
    border-color: var(--k-text);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

.agent-map :deep(.agent-map__fold--closed) {
  color: var(--k-text);
}

// ── Overlays ────────────────────────────────────────────────────────────
// The chips and, under them, the «Посіпака» strip: one column in the top-left corner.
.agent-map__overlay {
  position: absolute;
  top: var(--k-sp-3);
  left: var(--k-sp-3);
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--k-sp-2);
}

.agent-map__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k-sp-1);
}

.agent-map__minion {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  padding: 2px 2px 2px 8px;
  border: 1px solid var(--k-line);
  border-radius: var(--k-r);
  background: var(--k-surface);
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
}

// A pause stops the queue: the strip says so in the accent until the operator resumes it.
.agent-map__minion--paused {
  border-color: var(--k-accent);
  color: var(--k-accent);
}

.agent-map__minion-text {
  white-space: nowrap;
}

.agent-map__chip {
  padding: 4px 10px;
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-pill);
  background: var(--k-surface);
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s;

  &:hover {
    color: var(--k-text);
    border-color: var(--k-line-strong);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

.agent-map__chip--on {
  border-color: var(--k-accent);
  color: var(--k-text);
}

.agent-map__chip-count {
  color: var(--k-faint);
}

.agent-map__tools {
  position: absolute;
  top: var(--k-sp-3);
  right: var(--k-sp-3);
  z-index: 5;
  display: flex;
  gap: var(--k-sp-1);
  background: var(--k-surface);
  border-radius: var(--k-r);
}

.agent-map__empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-faint);
  pointer-events: none;
}

.agent-map__drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 6;
  display: flex;
  flex-direction: column;
  width: min(480px, 85%);
  background: var(--k-bg);
  border-left: 1px solid var(--k-line);
  box-shadow: var(--k-shadow-modal);
}

.agent-map__drawer-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-3);
  border-bottom: var(--k-rule-thin) solid var(--k-line);
}

.agent-map__drawer-id {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  min-width: 0;
}

.agent-map__drawer-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: var(--k-fw-medium);
}

.agent-map__drawer-meta {
  flex: none;
  margin: 0;
  padding: var(--k-sp-2) var(--k-sp-3) 0;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.agent-map__drawer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--k-sp-3);
}

.agent-map__empty-line {
  margin: 0;
  padding: var(--k-sp-4);
  text-align: center;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}
</style>
