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
      <KBtn
        v-if="selectedGroup"
        variant="icon"
        class="shell__settings"
        title="Налаштування проєкту"
        @click="openSettings"
      >⚙</KBtn>
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
        <div class="shell__dir">
          <KField
            v-model="groupDir"
            label="Директорія проєкту"
            placeholder="/path/to/project"
          />
          <KBtn variant="secondary" class="shell__browse" @click="pickerOpen = true">
            Обрати теку…
          </KBtn>
        </div>
        <p v-if="groupError" class="shell__error" role="alert">{{ groupError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="addOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="!canCreate" @click="submitGroup">
          Створити
        </KBtn>
      </template>
    </KModal>

    <!-- PROJECT SETTINGS MODAL -->
    <KModal v-model="settingsOpen" :title="`Налаштування · ${selectedGroup?.name ?? ''}`">
      <div class="shell__form">
        <KEnvEditor
          ref="envEditor"
          :entries="envView.entries"
          :ignored="envView.ignored"
        />
        <KField
          v-model="carryFilesText"
          label="Файли для сесії (по одному на рядок)"
          placeholder=".env"
        />
        <p v-if="settingsError" class="shell__error" role="alert">{{ settingsError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="settingsOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" @click="saveSettings">Зберегти</KBtn>
      </template>
    </KModal>

    <!-- DIRECTORY PICKER — server-side browser; fills the project dir field -->
    <KDirPicker v-model="pickerOpen" :start="groupDir" @select="groupDir = $event" />

    <!-- TOAST STACK — transient notifications (errors etc.) -->
    <KToast :toasts="store.toasts" @dismiss="store.dismissToast" />
  </q-layout>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { SessionStatus, EnvFileView } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import KRailItem from 'components/kit/KRailItem.vue';
import KStatusBar from 'components/kit/KStatusBar.vue';
import KModal from 'components/kit/KModal.vue';
import KField from 'components/kit/KField.vue';
import KBtn from 'components/kit/KBtn.vue';
import KDirPicker from 'components/kit/KDirPicker.vue';
import KToast from 'components/kit/KToast.vue';
import KEnvEditor from 'components/kit/KEnvEditor.vue';

// The Kermanych app shell (design-system section 07): project rail, brand
// header, page container, and the fleet status bar. Live groups/sessions come
// from the Pinia store; the socket is opened once on mount.
const store = useOrchestrator();

onMounted(() => store.connect());

// A session is "running" while it is queued or actively working; waiting means
// it is blocking on an interactive UI request; done is terminal-success.
const RUNNING: readonly SessionStatus[] = ['queued', 'thinking', 'tool'];

function sessionsOf(groupId: string | undefined) {
  return store.sessions.filter((s) => s.groupId === groupId && !s.archived);
}

function runningCount(groupId: string): number {
  return sessionsOf(groupId).filter((s) => RUNNING.includes(s.status)).length;
}

const counts = computed(() => {
  let running = 0;
  let waiting = 0;
  let done = 0;
  let error = 0;
  for (const s of sessionsOf(store.selectedGroupId)) {
    if (RUNNING.includes(s.status)) running++;
    else if (s.status === 'waiting_input') waiting++;
    else if (s.status === 'done') done++;
    else if (s.status === 'error') error++;
  }
  return { running, waiting, done, error };
});

const selectedGroup = computed(() =>
  store.groups.find((g) => g.id === store.selectedGroupId),
);

const contextLabel = computed(() =>
  selectedGroup.value
    ? `${selectedGroup.value.name} · ${selectedGroup.value.projectDir}`
    : 'Проєкт не вибрано',
);

// Add-group modal state, wired to the store's createGroup action.
const addOpen = ref(false);
const groupName = ref('');
const groupDir = ref('');
const groupError = ref<string | null>(null);
const pickerOpen = ref(false);
const canCreate = computed(
  () => groupName.value.trim() !== '' && groupDir.value.trim() !== '',
);

function openAddGroup(): void {
  groupName.value = '';
  groupDir.value = '';
  groupError.value = null;
  addOpen.value = true;
}

async function submitGroup(): Promise<void> {
  if (!canCreate.value) return;
  groupError.value = null;
  try {
    await store.createGroup(groupName.value.trim(), groupDir.value.trim());
    addOpen.value = false;
  } catch (e) {
    // Keep the modal open so the user can correct the input; surface why.
    groupError.value = e instanceof Error ? e.message : String(e);
  }
}

const settingsOpen = ref(false);
const settingsError = ref<string | null>(null);
const envView = ref<EnvFileView>({ entries: [], ignored: true });
const carryFilesText = ref('.env');
const envEditor = ref<{ collect: () => { set: Record<string, string>; remove: string[] } } | null>(null);

async function openSettings(): Promise<void> {
  const g = selectedGroup.value;
  if (!g) return;
  settingsError.value = null;
  carryFilesText.value = (g.carryFiles ?? ['.env']).join('\n');
  envView.value = { entries: [], ignored: true };
  settingsOpen.value = true;
  try {
    envView.value = await store.getEnv(g.id);
  } catch (e) {
    settingsError.value = e instanceof Error ? e.message : String(e);
  }
}

async function saveSettings(): Promise<void> {
  const g = selectedGroup.value;
  if (!g) return;
  settingsError.value = null;
  try {
    const carryFiles = carryFilesText.value.split('\n').map((s) => s.trim()).filter(Boolean);
    await store.updateGroup(g.id, { carryFiles: carryFiles.length ? carryFiles : ['.env'] });
    const edits = envEditor.value?.collect();
    if (edits && (Object.keys(edits.set).length || edits.remove.length)) {
      await store.saveEnv(g.id, edits);
    }
    settingsOpen.value = false;
  } catch (e) {
    settingsError.value = e instanceof Error ? e.message : String(e);
  }
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

.shell__footer {
  background: transparent;
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

.shell__dir {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.shell__browse {
  align-self: flex-start;
}
</style>
