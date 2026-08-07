<template>
  <q-layout view="lHh Lpr lFf" class="shell">
    <!-- LEFT RAIL — one tile per project group + add-group affordance (07) -->
    <q-drawer
      model-value
      side="left"
      :width="60"
      :breakpoint="0"
      bordered
      class="shell__rail"
    >
      <div class="shell__rail-inner">
        <div class="shell__rail-items">
          <KRailItem
            v-for="g in store.groups"
            :key="g.id"
            :group="g"
            :active="g.id === store.selectedGroupId"
            :count="runningCount(g.id)"
            @click="store.selectGroup(g.id)"
          />
        </div>
        <KBtn
          variant="icon"
          class="shell__add"
          title="Новий проєкт"
          @click="openAddGroup"
        >
          +
        </KBtn>
      </div>
    </q-drawer>

    <!-- TOP HEADER — logo + selected-group context + new-agent action (07) -->
    <q-header class="shell__header">
      <div class="shell__brand">
        <span class="shell__logo">КЕРМАНИЧ</span>
        <span class="shell__ver mono">v0.1</span>
      </div>
      <div class="shell__context mono">{{ contextLabel }}</div>
      <div class="shell__actions">
        <KBtn variant="primary" @click="newAgent">+ Новий агент</KBtn>
      </div>
    </q-header>

    <!-- PAGE -->
    <q-page-container>
      <router-view />
    </q-page-container>

    <!-- BOTTOM STATUS BAR — fleet aggregate for the selected group (07) -->
    <q-footer class="shell__footer">
      <KStatusBar :counts="counts" />
    </q-footer>

    <!-- ADD-GROUP MODAL -->
    <KModal v-model="addOpen" title="Новий проєкт">
      <div class="shell__form">
        <KField v-model="groupName" label="Назва" placeholder="my-project" />
        <KField
          v-model="groupDir"
          label="Директорія проєкту"
          placeholder="/path/to/project"
        />
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="addOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="!canCreate" @click="submitGroup">
          Створити
        </KBtn>
      </template>
    </KModal>
  </q-layout>
</template>

<script setup lang="ts">
import { computed, onMounted, provide, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { Ref } from 'vue';
import type { SessionStatus } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import KRailItem from 'components/kit/KRailItem.vue';
import KStatusBar from 'components/kit/KStatusBar.vue';
import KModal from 'components/kit/KModal.vue';
import KField from 'components/kit/KField.vue';
import KBtn from 'components/kit/KBtn.vue';

// The Kermanych app shell (design-system section 07): project rail, brand
// header, page container, and the fleet status bar. Live groups/sessions come
// from the Pinia store; the socket is opened once on mount.
const store = useOrchestrator();
const router = useRouter();

onMounted(() => store.connect());

// A session is "running" while it is queued or actively working; waiting means
// it is blocking on an interactive UI request; done is terminal-success.
const RUNNING: readonly SessionStatus[] = ['queued', 'thinking', 'tool'];

function sessionsOf(groupId: string | undefined) {
  return store.sessions.filter((s) => s.groupId === groupId);
}

function runningCount(groupId: string): number {
  return sessionsOf(groupId).filter((s) => RUNNING.includes(s.status)).length;
}

const counts = computed(() => {
  let running = 0;
  let waiting = 0;
  let done = 0;
  for (const s of sessionsOf(store.selectedGroupId)) {
    if (RUNNING.includes(s.status)) running++;
    else if (s.status === 'waiting_input') waiting++;
    else if (s.status === 'done') done++;
  }
  return { running, waiting, done };
});

const selectedGroup = computed(() =>
  store.groups.find((g) => g.id === store.selectedGroupId),
);

const contextLabel = computed(() =>
  selectedGroup.value
    ? `${selectedGroup.value.name} · ${selectedGroup.value.projectDir}`
    : 'Проєкт не вибрано',
);

// New-agent launcher trigger: the workspace (E3) injects this signal and opens
// its session launcher whenever it increments. Header navigates to the
// workspace first so the launcher is on screen.
const newAgentSignal = ref(0);
provide<Ref<number>>('kermanych.newAgentSignal', newAgentSignal);

function newAgent(): void {
  if (router.currentRoute.value.path !== '/') void router.push('/');
  newAgentSignal.value++;
}

// Add-group modal state, wired to the store's createGroup action.
const addOpen = ref(false);
const groupName = ref('');
const groupDir = ref('');
const canCreate = computed(
  () => groupName.value.trim() !== '' && groupDir.value.trim() !== '',
);

function openAddGroup(): void {
  groupName.value = '';
  groupDir.value = '';
  addOpen.value = true;
}

async function submitGroup(): Promise<void> {
  if (!canCreate.value) return;
  await store.createGroup(groupName.value.trim(), groupDir.value.trim());
  addOpen.value = false;
}
</script>

<style scoped lang="scss">
.shell__rail {
  background: var(--k-bg);
}

.shell__rail-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 10px 0;
  height: 100%;
}

.shell__rail-items {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.shell__add {
  margin-top: 4px;
}

// header — 2px rule below (zone separator), surface fill, flush-left brand.
.shell__header {
  display: flex;
  align-items: center;
  gap: 20px;
  height: 48px;
  padding: 0 16px;
  background: var(--k-surface);
  color: var(--k-text);
  border-bottom: 2px solid var(--k-line-strong);
}

.shell__brand {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.shell__logo {
  font-family: var(--k-font-ui);
  font-size: 15px;
  font-weight: 800;
  letter-spacing: 0.06em;
  color: var(--k-text);
}

.shell__ver {
  font-size: 11px;
  color: var(--k-muted);
}

.shell__context {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--k-muted);
}

.shell__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.shell__footer {
  background: transparent;
}

.shell__form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
</style>
