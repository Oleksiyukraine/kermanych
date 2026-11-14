<template>
  <section class="mcp">
    <p class="mcp__lead">{{ t('aiTeam.mcp.lead') }}</p>

    <p v-if="!bound" class="mcp__empty mono">{{ t('aiTeam.mcp.notBound') }}</p>
    <template v-else>
      <p v-if="error" class="mcp__error mono">{{ error }}</p>

      <KSkeleton v-if="phase === 'skeleton'" variant="card" :rows="3" />
      <template v-else-if="phase === 'ready' && view">
        <p class="mcp__root mono">{{ view.root }}</p>
        <!-- Kermanych never commits: the change reaches new sessions through the base branch. -->
        <p v-if="view.uncommitted.length" class="mcp__note">
          <KTag>{{ t('aiTeam.mcp.uncommitted') }}</KTag>
          {{ t('aiTeam.mcp.uncommittedNote', { files: view.uncommitted.join(', ') }) }}
        </p>
        <p v-for="e in view.errors" :key="e.file" class="mcp__error mono">{{ e.file }}: {{ e.error }}</p>

        <ul v-if="view.servers.length" class="mcp__list">
          <li
            v-for="s in view.servers"
            :key="s.location + ':' + s.name"
            class="mcp__row"
            :aria-busy="act.busyFor(rowKey(s)) || undefined"
          >
            <div class="mcp__head">
              <span class="mcp__name mono">{{ s.name }}</span>
              <KTag>{{ s.def.kind === 'stdio' ? t('aiTeam.mcp.kind.stdio') : s.def.sse ? 'SSE' : t('aiTeam.mcp.kind.http') }}</KTag>
              <span class="mcp__marks">
                <KHarnessMark
                  v-for="h in MCP_HARNESSES"
                  :key="h"
                  :harness="h"
                  class="mcp__mark"
                  :class="{ 'mcp__mark--off': !s.seenBy.includes(h) }"
                />
              </span>
            </div>
            <p class="mcp__line mono">{{ mcpDefLine(s.def) }}</p>
            <p class="mcp__files">
              <KTag v-for="f in s.files" :key="f">{{ s.location === 'subdir' ? `${view.subdir}/${f}` : f }}</KTag>
            </p>
            <p v-if="s.location === 'subdir'" class="mcp__warn">{{ t('aiTeam.mcp.subdirNote') }}</p>
            <p v-else-if="codexText(s)" class="mcp__hint">{{ codexText(s) }}</p>

            <!-- What the server needs from the environment, and where each value is. An unset
                 one can be filled in here; it goes to the project's `.env`. -->
            <ul v-if="s.vars.length" class="mcp__vars">
              <li v-for="v in s.vars" :key="v.name" class="mcp__var" :class="{ 'mcp__var--unset': v.state === 'unset' && !v.optional }">
                <span class="mono">{{ v.name }}</span>
                <span>{{ t('aiTeam.mcp.varState.' + (v.state === 'unset' && v.optional ? 'default' : v.state)) }}</span>
                <template v-if="v.state === 'unset'">
                  <template v-if="filling === v.name">
                    <input
                      v-model="fillValue"
                      class="mcp__fill mono"
                      type="password"
                      :aria-label="v.name"
                      @keydown.enter="fill.run(v.name)"
                    />
                    <KBtn variant="primary" :loading="fill.busy.value" @click="fill.run(v.name)">{{ t('aiTeam.mcp.fillSave') }}</KBtn>
                  </template>
                  <KBtn v-else variant="ghost" @click="startFill(v.name)">{{ t('aiTeam.mcp.fill') }}</KBtn>
                </template>
              </li>
            </ul>
            <p v-if="!view.envIgnored && s.vars.length" class="mcp__warn">{{ t('aiTeam.mcp.editor.envNotIgnored') }}</p>

            <div class="mcp__actions">
              <KBtn :loading="act.busyFor('check:' + rowKey(s))" @click="act.run('check:' + rowKey(s), () => check(s))">
                {{ t('aiTeam.mcp.check') }}
              </KBtn>
              <template v-if="s.editable">
                <KBtn :disabled="act.busyFor(rowKey(s))" @click="openEditor(s)">{{ t('aiTeam.mcp.edit') }}</KBtn>
                <KBtn :loading="act.busyFor(rowKey(s))" @click="act.run(rowKey(s), () => remove(s))">{{ t('aiTeam.mcp.remove') }}</KBtn>
              </template>
              <KBtn
                v-else-if="s.location === 'root'"
                :loading="act.busyFor(rowKey(s))"
                @click="act.run(rowKey(s), () => write(s.name, (replace) => api.mcpCopy(projectId, s.name, replace)))"
              >{{ t('aiTeam.mcp.copy') }}</KBtn>
              <KBtn
                v-else
                :loading="act.busyFor(rowKey(s))"
                @click="act.run(rowKey(s), () => write(s.name, (replace) => api.mcpMoveToRoot(projectId, s.name, replace)))"
              >{{ t('aiTeam.mcp.moveToRoot') }}</KBtn>
            </div>

            <div v-if="checks[rowKey(s)]" class="mcp__check">
              <template v-if="checks[rowKey(s)]!.ok">
                <p class="mcp__ok">{{ t('aiTeam.mcp.checkOk', { n: okTools(s).length, ms: checks[rowKey(s)]!.ms }, okTools(s).length) }}</p>
                <ul class="mcp__tools">
                  <li v-for="tool in okTools(s)" :key="tool.name">
                    <span class="mono">{{ tool.name }}</span><span v-if="tool.description" class="mcp__tool-desc"> — {{ tool.description }}</span>
                  </li>
                </ul>
              </template>
              <template v-else>
                <p class="mcp__error mono">{{ failed(s).error }}</p>
                <p v-if="failed(s).auth" class="mcp__hint">{{ t('aiTeam.mcp.checkAuth') }}</p>
                <pre v-if="failed(s).stderr.length" class="mcp__stderr mono">{{ failed(s).stderr.join('\n') }}</pre>
              </template>
            </div>
          </li>
        </ul>
        <p v-else class="mcp__empty mono">{{ t('aiTeam.mcp.empty') }}</p>

        <div class="mcp__add">
          <KBtn variant="primary" @click="openEditor(undefined)">{{ t('aiTeam.mcp.add') }}</KBtn>
        </div>
        <p class="mcp__hint">{{ t('aiTeam.mcp.restartNote') }}</p>
      </template>
    </template>

    <McpServerEditor
      v-model="editorOpen"
      :project-id="projectId"
      :server="editing"
      :env-ignored="view?.envIgnored ?? true"
      @saved="changed"
    />

    <!-- «Скопіювати» / «Перенести» stopped at a codex table written by hand. -->
    <KModal v-model="conflictOpen" :title="t('aiTeam.mcp.conflict.title')" :persistent="replace.busy.value" width="600px">
      <McpCodexConflict v-if="pending" :conflict="pending.conflict" :name="pending.name" />
      <template #controls>
        <KBtn :disabled="replace.busy.value" @click="conflictOpen = false">{{ t('settings.modal.cancel') }}</KBtn>
        <KBtn variant="primary" :loading="replace.busy.value" @click="replace.run()">{{ t('aiTeam.mcp.replaceCodex') }}</KBtn>
      </template>
    </KModal>
  </section>
</template>

<script setup lang="ts">
// «ШІ-команда → MCP-сервери» (docs/specs/2026-11-14-project-mcp-servers.md). The repository's
// own MCP files are the only copy; the local api reads them at the checkout's git root and
// writes `.mcp.json` with its codex mirror. Nothing here goes to the cloud.
import { reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  MCP_HARNESSES,
  type McpCheckResult,
  type McpCodexConflict as Conflict,
  type McpProjectView,
  type McpServerRow,
  type McpWriteResult,
} from '@kermanych/core';
import { api } from '../../lib/api';
import { confirmAction } from '../../lib/confirm';
import { mcpDefLine } from '../../lib/mcp';
import { errorText, useAsyncAction, useKeyedAction } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import KBtn from 'components/kit/KBtn.vue';
import KTag from 'components/kit/KTag.vue';
import KModal from 'components/kit/KModal.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import KHarnessMark from 'components/kit/KHarnessMark.vue';
import McpServerEditor from './McpServerEditor.vue';
import McpCodexConflict from './McpCodexConflict.vue';

const props = defineProps<{ projectId: string; bound: boolean }>();
const { t } = useI18n();

const view = ref<McpProjectView>();
const error = ref('');
// The project whose read last finished, either way: anything else is «not loaded» for the
// project on screen, which is the skeleton, never the empty line.
const loadedFor = ref('');
const phase = useLoadPhase(() => loadedFor.value !== props.projectId);
const checks = reactive<Record<string, McpCheckResult>>({});

const rowKey = (s: McpServerRow) => `${s.location}:${s.name}`;

// A result belongs to the files it ran against: after a write of ours they changed, so it goes.
function changed(next: McpProjectView): void {
  view.value = next;
  for (const k of Object.keys(checks)) delete checks[k];
}

let loadRun = 0;
async function load(): Promise<void> {
  const projectId = props.projectId;
  const run = ++loadRun;
  try {
    const next = await api.mcpView(projectId);
    if (run !== loadRun) return;
    view.value = next;
    error.value = '';
  } catch (e) {
    if (run !== loadRun) return;
    view.value = undefined;
    error.value = errorText(e);
  } finally {
    if (run === loadRun) loadedFor.value = projectId;
  }
}

const act = useKeyedAction(async (_key: string, fn: () => Promise<void>) => fn());

function codexText(s: McpServerRow): string {
  const c = s.codex;
  if (!c || c.state === 'mirrored') return '';
  return c.state === 'gap' ? t('aiTeam.mcp.codexGap.' + c.gap) : t('aiTeam.mcp.codexState.' + c.state);
}

async function check(s: McpServerRow): Promise<void> {
  checks[rowKey(s)] = await api.mcpCheck(props.projectId, s.name, s.location);
}
function okTools(s: McpServerRow) {
  const c = checks[rowKey(s)];
  return c?.ok ? c.tools : [];
}
function failed(s: McpServerRow) {
  const c = checks[rowKey(s)];
  return c && !c.ok ? c : { error: '', stderr: [], auth: undefined };
}

async function remove(s: McpServerRow): Promise<void> {
  const ok = await confirmAction({
    title: t('aiTeam.mcp.removeTitle', { name: s.name }),
    message: t('aiTeam.mcp.removeMessage', { name: s.name }),
    confirmLabel: t('aiTeam.mcp.remove'),
  });
  if (ok) changed(await api.mcpRemove(props.projectId, s.name));
}

// Copy and move: a codex table someone wrote by hand stops the write and asks.
const conflictOpen = ref(false);
const pending = ref<{ name: string; conflict: Conflict; retry: () => Promise<McpWriteResult> }>();
async function write(name: string, call: (replaceCodex: boolean) => Promise<McpWriteResult>): Promise<void> {
  const res = await call(false);
  if ('view' in res) {
    changed(res.view);
    return;
  }
  pending.value = { name, conflict: res.conflict, retry: () => call(true) };
  conflictOpen.value = true;
}
const replace = useAsyncAction(async () => {
  const res = await pending.value!.retry();
  if ('view' in res) changed(res.view);
  conflictOpen.value = false;
});

const editorOpen = ref(false);
const editing = ref<McpServerRow>();
function openEditor(s: McpServerRow | undefined): void {
  editing.value = s;
  editorOpen.value = true;
}

// An unset variable filled in from the list: written to the project's `.env`, then re-read.
const filling = ref('');
const fillValue = ref('');
function startFill(name: string): void {
  filling.value = name;
  fillValue.value = '';
}
const fill = useAsyncAction(async (name: string) => {
  if (!fillValue.value) return;
  await api.saveEnv(props.projectId, { set: { [name]: fillValue.value } });
  filling.value = '';
  fillValue.value = '';
  changed(await api.mcpView(props.projectId));
});

// Another project in the sidebar swaps the prop under a mounted pane: the old project's list
// goes at once, and its late reply is dropped.
watch(
  () => [props.projectId, props.bound] as const,
  () => {
    view.value = undefined;
    error.value = '';
    editorOpen.value = false;
    conflictOpen.value = false;
    for (const k of Object.keys(checks)) delete checks[k];
    if (props.bound) void load();
    else loadedFor.value = props.projectId;
  },
  { immediate: true },
);
</script>

<style scoped lang="scss">
.mcp {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

.mcp__lead,
.mcp__note {
  margin: 0;
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-muted);
}

.mcp__root {
  margin: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.mcp__list {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.mcp__row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--k-sp-3);
  background: var(--k-bg);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r);
}

.mcp__head {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.mcp__name {
  font-size: var(--k-fs-md, 14px);
  color: var(--k-text);
}

.mcp__marks {
  display: inline-flex;
  gap: 6px;
  margin-left: auto;
}

.mcp__mark {
  width: 14px;
  height: 14px;
}

.mcp__mark--off {
  opacity: 0.2;
  filter: grayscale(1);
}

.mcp__line {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mcp__files {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0;
}

.mcp__vars {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.mcp__var {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  font-size: var(--k-fs-sm);
  color: var(--k-muted);

  &--unset {
    color: var(--k-accent);
  }
}

.mcp__fill {
  min-width: 0;
  width: 220px;
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: var(--k-surface);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-sm);
  padding: 4px 7px;

  &:focus {
    outline: none;
    border-color: var(--k-accent);
  }
}

.mcp__actions,
.mcp__add {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k-sp-2);
}

.mcp__check {
  padding-top: var(--k-sp-2);
  border-top: var(--k-rule-thin) solid var(--k-line);
}

.mcp__tools {
  margin: 4px 0 0;
  padding-left: 16px;
  max-height: 180px;
  overflow: auto;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.mcp__tool-desc {
  color: var(--k-faint);
}

.mcp__stderr {
  margin: 4px 0 0;
  padding: var(--k-sp-2);
  max-height: 180px;
  overflow: auto;
  font-size: var(--k-fs-xs);
  white-space: pre-wrap;
  background: var(--k-surface2);
  border-radius: var(--k-r-sm);
}

.mcp__ok,
.mcp__hint {
  margin: 0;
  font-size: var(--k-fs-xs);
  line-height: 1.5;
  color: var(--k-muted);
}

.mcp__warn,
.mcp__error {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-accent);
}

.mcp__empty {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}
</style>
