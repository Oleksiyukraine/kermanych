<template>
  <section class="mcp">
    <p v-if="!bound" class="mcp__empty-line">{{ t('aiTeam.mcp.notBound') }}</p>
    <template v-else>
      <p v-if="error" class="mcp__notice mcp__notice--warn mono" role="alert">{{ error }}</p>

      <KSkeleton v-if="phase === 'skeleton'" variant="card" :rows="3" />
      <template v-else-if="phase === 'ready' && view">
        <!-- Where the files are, and the one action that does not belong to a server. -->
        <header class="mcp__bar">
          <div class="mcp__bar-text">
            <p class="mcp__repo">
              <span class="mcp__repo-label">{{ t('aiTeam.mcp.repo') }}</span>
              <span class="mcp__repo-path mono">{{ view.root }}</span>
            </p>
            <p class="mcp__hint">{{ t('aiTeam.mcp.repoNote') }}</p>
          </div>
          <KBtn variant="primary" class="mcp__add" @click="openEditor(undefined)">{{ t('aiTeam.mcp.add') }}</KBtn>
        </header>

        <!-- Kermanych never commits: the change reaches new sessions through the base branch. -->
        <div v-if="view.uncommitted.length" class="mcp__notice mcp__notice--info">
          <KTag>{{ t('aiTeam.mcp.uncommitted') }}</KTag>
          <p>{{ t('aiTeam.mcp.uncommittedNote', { files: view.uncommitted.join(', ') }) }}</p>
        </div>
        <p v-for="e in view.errors" :key="e.file" class="mcp__notice mcp__notice--warn" role="alert">
          {{ t('aiTeam.mcp.fileError', { file: e.file, error: e.error }) }}
        </p>

        <!-- Two groups: what sessions get, and what sits in a bound subfolder where no session
             starts. Why the second group is not connected is said once, in its header. -->
        <div v-for="g in groups" :key="g.key" class="mcp__group">
          <div class="mcp__group-head">
            <h3 class="mcp__group-title">
              {{ t('aiTeam.mcp.groups.' + g.key) }}
              <span class="mcp__count mono">{{ g.rows.length }}</span>
            </h3>
            <p v-if="g.key === 'disconnected'" class="mcp__hint">
              {{ t('aiTeam.mcp.groups.disconnectedNote', { subdir: view.subdir }) }}
            </p>
          </div>

          <div v-if="!g.rows.length" class="mcp__empty">
            <p class="mcp__empty-title">{{ t('aiTeam.mcp.empty') }}</p>
            <p class="mcp__hint">{{ t('aiTeam.mcp.emptyHint') }}</p>
            <KBtn class="mcp__empty-act" @click="openEditor(undefined)">{{ t('aiTeam.mcp.openCatalog') }}</KBtn>
          </div>

          <ul v-else class="mcp__list">
            <li
              v-for="s in g.rows"
              :key="rowKey(s)"
              class="mcp__row"
              :class="{ 'mcp__row--off': s.location === 'subdir' }"
              :aria-busy="act.busyFor(rowKey(s)) || act.busyFor('check:' + rowKey(s)) || undefined"
            >
              <div class="mcp__head">
                <span class="mcp__name mono">{{ s.name }}</span>
                <KTag>{{ s.def.kind === 'stdio' ? t('aiTeam.mcp.kind.stdio') : s.def.sse ? 'SSE' : t('aiTeam.mcp.kind.http') }}</KTag>
                <div class="mcp__actions">
                  <KBtn
                    class="mcp__act"
                    :loading="act.busyFor('check:' + rowKey(s))"
                    @click="act.run('check:' + rowKey(s), () => check(s))"
                  >{{ t('aiTeam.mcp.check') }}</KBtn>
                  <KBtn
                    v-if="s.editable"
                    class="mcp__act"
                    variant="ghost"
                    :disabled="act.busyFor(rowKey(s))"
                    @click="openEditor(s)"
                  >{{ t('aiTeam.mcp.edit') }}</KBtn>
                  <KBtn
                    v-if="s.location === 'subdir' && !duplicate(s)"
                    class="mcp__act"
                    variant="ghost"
                    :disabled="act.busyFor(rowKey(s))"
                    @click="act.run(rowKey(s), () => write(s.name, (replace) => api.mcpMoveToRoot(projectId, s.name, replace)))"
                  >{{ t('aiTeam.mcp.moveToRoot') }}</KBtn>
                  <KBtn
                    v-if="s.editable || (s.location === 'subdir' && !duplicate(s))"
                    class="mcp__act"
                    variant="ghost"
                    :loading="act.busyFor('remove:' + rowKey(s))"
                    :disabled="act.busyFor(rowKey(s))"
                    @click="act.run('remove:' + rowKey(s), () => remove(s))"
                  >{{ t('aiTeam.mcp.remove') }}</KBtn>
                </div>
              </div>

              <code class="mcp__line mono">{{ mcpDefLine(s.def) }}</code>

              <dl class="mcp__meta">
                <template v-if="s.location === 'root'">
                  <dt>{{ t('aiTeam.mcp.agents') }}</dt>
                  <dd class="mcp__chips">
                    <span
                      v-for="h in MCP_HARNESSES"
                      :key="h"
                      v-tip="harnessTip(s, h)"
                      class="mcp__chip"
                      :class="{ 'mcp__chip--off': !s.seenBy.includes(h) }"
                      :aria-label="harnessTip(s, h)"
                    >
                      <KHarnessMark :harness="h" class="mcp__chip-mark" />
                      <span>{{ h }}</span>
                    </span>
                  </dd>
                </template>
                <dt>{{ t('aiTeam.mcp.files') }}</dt>
                <dd class="mcp__files mono">{{ filesOf(s).join(' · ') }}</dd>
                <template v-if="s.vars.length">
                  <dt>{{ t('aiTeam.mcp.vars') }}</dt>
                  <dd>
                    <!-- What the server needs from the environment, and where each value is. An
                         unset one can be filled in here; it goes to the project's `.env`. -->
                    <ul class="mcp__vars">
                      <li v-for="v in s.vars" :key="v.name" class="mcp__var" :class="'mcp__var--' + varTone(v)">
                        <span class="mono">{{ v.name }}</span>
                        <span class="mcp__var-state">{{ t('aiTeam.mcp.varState.' + (v.state === 'unset' && v.optional ? 'default' : v.state)) }}</span>
                        <template v-if="v.state === 'unset'">
                          <span v-if="filling === fillKey(s, v.name)" class="mcp__fill">
                            <input
                              ref="fillInput"
                              v-model="fillValue"
                              class="mcp__fill-input mono"
                              type="password"
                              :aria-label="v.name"
                              @keydown.enter="fill.run(v.name)"
                              @keydown.esc="filling = ''"
                            />
                            <KBtn class="mcp__act" variant="primary" :loading="fill.busy.value" @click="fill.run(v.name)">{{ t('aiTeam.mcp.fillSave') }}</KBtn>
                            <KBtn class="mcp__act" variant="ghost" :disabled="fill.busy.value" @click="filling = ''">{{ t('settings.modal.cancel') }}</KBtn>
                          </span>
                          <KBtn v-else class="mcp__act" variant="ghost" @click="startFill(s, v.name)">{{ t('aiTeam.mcp.fill') }}</KBtn>
                        </template>
                      </li>
                    </ul>
                  </dd>
                </template>
              </dl>
              <p v-if="!view.envIgnored && s.vars.length" class="mcp__notice mcp__notice--warn">{{ t('aiTeam.mcp.editor.envNotIgnored') }}</p>

              <!-- Every problem with the row, each with the action that fixes it next to it. -->
              <div v-for="n in notices(s)" :key="n.key" class="mcp__notice" :class="'mcp__notice--' + n.tone">
                <p>{{ n.text }}</p>
                <KBtn v-if="n.action" class="mcp__act" :loading="act.busyFor(rowKey(s))" @click="act.run(rowKey(s), n.action.run)">
                  {{ n.action.label }}
                </KBtn>
              </div>

              <div v-if="checks[rowKey(s)]" class="mcp__check" :class="checks[rowKey(s)]!.ok ? 'mcp__check--ok' : 'mcp__check--fail'">
                <template v-if="checks[rowKey(s)]!.ok">
                  <p class="mcp__check-status">✓ {{ t('aiTeam.mcp.checkOk', { n: okTools(s).length, ms: checks[rowKey(s)]!.ms }, okTools(s).length) }}</p>
                  <details v-if="okTools(s).length" class="mcp__fold">
                    <summary>{{ t('aiTeam.mcp.checkTools') }}</summary>
                    <ul class="mcp__tools">
                      <li v-for="tool in okTools(s)" :key="tool.name">
                        <span class="mono">{{ tool.name }}</span><span v-if="tool.description" class="mcp__tool-desc"> — {{ tool.description }}</span>
                      </li>
                    </ul>
                  </details>
                </template>
                <template v-else>
                  <p class="mcp__check-status">✕ {{ t('aiTeam.mcp.checkFail', { ms: checks[rowKey(s)]!.ms }) }}</p>
                  <p class="mcp__check-error mono">{{ failed(s).error }}</p>
                  <p v-if="failed(s).auth" class="mcp__hint">{{ t('aiTeam.mcp.checkAuth') }}</p>
                  <details v-if="failed(s).stderr.length" class="mcp__fold">
                    <summary>{{ t('aiTeam.mcp.checkStderr') }}</summary>
                    <pre class="mcp__stderr mono">{{ failed(s).stderr.join('\n') }}</pre>
                  </details>
                </template>
              </div>
            </li>
          </ul>
        </div>
      </template>
    </template>

    <McpServerEditor
      v-model="editorOpen"
      :project-id="projectId"
      :server="editing"
      :env-ignored="view?.envIgnored ?? true"
      :existing="existingNames"
      @saved="changed"
    />

    <!-- «Скопіювати», «Перенести» or «Додати в codex» stopped at a codex table written by hand. -->
    <KModal v-model="conflictOpen" :title="t('aiTeam.mcp.conflict.title')" :persistent="replace.busy.value" width="640px">
      <McpCodexConflict v-if="pending" :conflict="pending.conflict" :name="pending.name" />
      <template #controls>
        <KBtn :disabled="replace.busy.value" @click="conflictOpen = false">{{ t('settings.modal.cancel') }}</KBtn>
        <KBtn variant="primary" :loading="replace.busy.value" @click="replace.run()">{{ t('aiTeam.mcp.replaceCodex') }}</KBtn>
      </template>
    </KModal>
  </section>
</template>

<script setup lang="ts">
// «ШІ-команда → MCP-сервери» (docs/specs/2026-11-14-project-mcp-servers.md; layout:
// docs/specs/2026-11-16-mcp-servers-ux-redesign.md). The repository's own MCP files are the
// only copy; the local api reads them at the checkout's git root and writes `.mcp.json` with its
// codex mirror. Nothing here goes to the cloud.
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  MCP_HARNESSES,
  type McpCheckResult,
  type McpCodexConflict as Conflict,
  type McpHarness,
  type McpProjectView,
  type McpServerRow,
  type McpVar,
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

// «Не підключені» exists only when the project is bound to a subfolder that holds servers.
const groups = computed(() => {
  const servers = view.value?.servers ?? [];
  const out: { key: 'connected' | 'disconnected'; rows: McpServerRow[] }[] = [
    { key: 'connected', rows: servers.filter((s) => s.location === 'root') },
  ];
  const sub = servers.filter((s) => s.location === 'subdir');
  if (sub.length) out.push({ key: 'disconnected', rows: sub });
  return out;
});

// The names a create would refuse (the root `.mcp.json` has them): the catalog marks them added.
const existingNames = computed(() => (view.value?.servers ?? []).filter((s) => s.editable).map((s) => s.name));

/** A subfolder copy of a server the root `.mcp.json` already has: the api refuses to move it. */
function duplicate(s: McpServerRow): boolean {
  return s.location === 'subdir' && !!view.value?.servers.some((r) => r.location === 'root' && r.name === s.name && r.files.includes('.mcp.json'));
}

function filesOf(s: McpServerRow): string[] {
  return s.location === 'subdir' ? s.files.map((f) => `${view.value!.subdir}/${f}`) : s.files;
}

function harnessTip(s: McpServerRow, h: McpHarness): string {
  return s.seenBy.includes(h) ? t('aiTeam.mcp.harnessOn', { harness: h }) : t('aiTeam.mcp.harnessOff', { harness: h, files: s.files.join(', ') });
}

function varTone(v: McpVar): 'set' | 'unset' | 'default' {
  if (v.state !== 'unset') return 'set';
  return v.optional ? 'default' : 'unset';
}

type Notice = { key: string; tone: 'warn' | 'info'; text: string; action?: { label: string; run: () => Promise<void> } };

// A save of the definition already on screen writes only what is missing: the codex table. A
// hand-written table that differs comes back as a conflict, and the modal compares both.
const syncCodex = (s: McpServerRow) => () => write(s.name, (replace) => api.mcpUpdate(props.projectId, s.name, { def: s.def, ...(replace ? { replaceCodex: true } : {}) }));

function notices(s: McpServerRow): Notice[] {
  const out: Notice[] = [];
  if (duplicate(s)) {
    out.push({ key: 'dup', tone: 'warn', text: t('aiTeam.mcp.duplicate', { name: s.name }), action: { label: t('aiTeam.mcp.removeCopy'), run: () => remove(s) } });
  }
  if (s.location === 'root' && !s.editable) {
    out.push({
      key: 'copy',
      tone: 'warn',
      text: t('aiTeam.mcp.notInMcpJson', { files: s.files.join(', ') }),
      action: { label: t('aiTeam.mcp.copy'), run: () => write(s.name, (replace) => api.mcpCopy(props.projectId, s.name, replace)) },
    });
  }
  const c = s.codex;
  if (c?.state === 'missing') out.push({ key: 'codex', tone: 'warn', text: t('aiTeam.mcp.codexState.missing'), action: { label: t('aiTeam.mcp.codexAdd'), run: syncCodex(s) } });
  if (c?.state === 'differs') out.push({ key: 'codex', tone: 'warn', text: t('aiTeam.mcp.codexState.differs'), action: { label: t('aiTeam.mcp.codexCompare'), run: syncCodex(s) } });
  if (c?.state === 'gap') out.push({ key: 'codex', tone: 'info', text: t('aiTeam.mcp.codexGap.' + c.gap) });
  return out;
}

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
  const subdir = s.location === 'subdir';
  const ok = await confirmAction({
    title: t('aiTeam.mcp.removeTitle', { name: s.name }),
    message: subdir
      ? t('aiTeam.mcp.removeSubdirMessage', { name: s.name, files: filesOf(s).join(', ') })
      : t('aiTeam.mcp.removeMessage', { name: s.name }),
    confirmLabel: duplicate(s) ? t('aiTeam.mcp.removeCopy') : t('aiTeam.mcp.remove'),
  });
  if (ok) changed(await api.mcpRemove(props.projectId, s.name, s.location));
}

// Copy, move and the codex sync: a codex table someone wrote by hand stops the write and asks.
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
// Keyed by row too: two servers may need the same variable, and only one field opens.
const filling = ref('');
const fillValue = ref('');
const fillInput = ref<HTMLInputElement[]>([]);
const fillKey = (s: McpServerRow, name: string) => `${rowKey(s)}:${name}`;
async function startFill(s: McpServerRow, name: string): Promise<void> {
  filling.value = fillKey(s, name);
  fillValue.value = '';
  await nextTick();
  fillInput.value[0]?.focus();
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
    filling.value = '';
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
  gap: var(--k-sp-4);
}

.mcp__bar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--k-sp-4);
}

.mcp__bar .mcp__add {
  flex: none;
  white-space: nowrap;
}

.mcp__bar-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.mcp__repo {
  display: flex;
  align-items: baseline;
  gap: var(--k-sp-2);
  margin: 0;
  min-width: 0;
}

.mcp__repo-label {
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
  white-space: nowrap;
}

.mcp__repo-path {
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  overflow-wrap: anywhere;
}

.mcp__hint {
  margin: 0;
  font-size: var(--k-fs-xs);
  line-height: 1.5;
  color: var(--k-muted);
}

// A problem or a fact the operator acts on: a rule on the left in the tone's colour, the text,
// and the action that fixes it at the right.
.mcp__notice {
  display: flex;
  align-items: center;
  gap: var(--k-sp-3);
  margin: 0;
  padding: var(--k-sp-2) var(--k-sp-3);
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-text);
  border-left: 3px solid var(--k-line-strong);
  border-radius: var(--k-r-sm);
  background: var(--k-surface2);

  p {
    flex: 1;
    margin: 0;
  }

  &--warn {
    border-left-color: var(--k-warning);
    background: color-mix(in srgb, var(--k-warning) 8%, transparent);
  }

  &--info {
    color: var(--k-muted);
  }
}

.mcp__group {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}

.mcp__group-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mcp__group-title {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  margin: 0;
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
}

.mcp__count {
  font-size: var(--k-fs-xs);
  font-weight: var(--k-fw-regular);
  color: var(--k-faint);
}

.mcp__empty {
  padding: var(--k-sp-4);
  border: var(--k-rule-thin) dashed var(--k-line-strong);
  border-radius: var(--k-r);
}

.mcp__empty-title {
  margin: 0 0 4px;
  font-size: var(--k-fs-sm);
  color: var(--k-text);
}

.mcp__empty-act {
  margin-top: var(--k-sp-3);
}

.mcp__empty-line {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
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
  gap: var(--k-sp-2);
  padding: var(--k-sp-3);
  background: var(--k-bg);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r);

  &--off {
    border-style: dashed;

    .mcp__name,
    .mcp__line {
      color: var(--k-muted);
    }
  }
}

.mcp__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--k-sp-2);
}

.mcp__name {
  font-size: var(--k-fs-md, 14px);
  color: var(--k-text);
}

.mcp__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-left: auto;
}

// The kit's button is sized for a form's footer; a row of them on every card outweighs the
// card's content, so the row's actions are a step smaller.
.mcp__row .mcp__act,
.mcp__notice .mcp__act,
.mcp__fill .mcp__act {
  padding: 6px 10px;
  font-size: var(--k-fs-xs);
  white-space: nowrap;
}

.mcp__line {
  display: block;
  padding: var(--k-sp-2);
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-text);
  background: var(--k-surface2);
  border-radius: var(--k-r-sm);
  overflow-wrap: anywhere;
}

.mcp__meta {
  display: grid;
  grid-template-columns: max-content 1fr;
  align-items: baseline;
  gap: 6px var(--k-sp-3);
  margin: 0;

  dt {
    font-size: var(--k-fs-xs);
    color: var(--k-faint);
  }

  dd {
    margin: 0;
    min-width: 0;
  }
}

.mcp__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.mcp__chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px 2px 6px;
  font-size: var(--k-fs-xs);
  color: var(--k-text);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-pill);

  &--off {
    color: var(--k-faint);
    border-style: dashed;
    border-color: var(--k-line);

    .mcp__chip-mark {
      opacity: 0.3;
      filter: grayscale(1);
    }

    span {
      text-decoration: line-through;
    }
  }
}

// The chip's tooltip says why; the mark's own («omp») would replace it under the pointer.
.mcp__chip-mark {
  width: 12px;
  height: 12px;
  pointer-events: none;
}

.mcp__files {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
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
  flex-wrap: wrap;
  gap: var(--k-sp-2);
  min-height: 26px;
  font-size: var(--k-fs-sm);
  color: var(--k-text);

  &-state {
    font-size: var(--k-fs-xs);
    color: var(--k-muted);
  }

  &--set &-state::before {
    content: '✓ ';
    color: var(--k-success);
  }

  &--unset &-state {
    color: var(--k-warning);
  }

  &--unset &-state::before {
    content: '! ';
  }
}

.mcp__fill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.mcp__fill-input {
  width: 220px;
  min-width: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: var(--k-surface);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-sm);
  padding: 4px 7px;

  &:focus {
    outline: none;
    border-color: var(--k-accent);
  }
}

.mcp__check {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: var(--k-sp-2);
  border-top: var(--k-rule-thin) solid var(--k-line);
}

.mcp__check-status {
  margin: 0;
  font-size: var(--k-fs-sm);

  .mcp__check--ok & {
    color: var(--k-success);
  }

  .mcp__check--fail & {
    color: var(--k-danger);
  }
}

.mcp__check-error {
  margin: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-text);
  overflow-wrap: anywhere;
}

.mcp__fold summary {
  cursor: pointer;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);

  &:hover {
    color: var(--k-text);
  }
}

.mcp__tools {
  margin: 4px 0 0;
  padding-left: 16px;
  max-height: 220px;
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
</style>
