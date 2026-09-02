<template>
  <section class="as">
    <p class="as__lead">
      Проєкт
      <span class="as__lead-project mono">{{ projectName }}</span>
      — склад команди зашитий у застосунок, а призначення належать цьому проєкту й живуть у
      хмарі.
    </p>

    <!-- Verbatim from the spec: the four sentences that separate «є в бібліотеці» from
         «призначено». Without them the two panes look like the same list twice. -->
    <ol class="as__how">
      <li>
        Скіл у бібліотеці — агент бере його сам, коли вважає за потрібне; у чаті це видно
        окремим рядком <span class="mono">skill</span>.
      </li>
      <li>Скіл, призначений ролі, вклеюється в інструкцію запуску — агент не може його не побачити.</li>
      <li>
        Той самий скіл може бути і в бібліотеці, і призначеним: у блоці призначення він
        наведений повністю, і агенту сказано не читати його вдруге з бібліотеки.
      </li>
      <li>Призначений текст оплачується контекстом на кожному ході — тримай його коротким.</li>
    </ol>

    <!-- The literal header the agent receives, so sentence 3 is verifiable rather than a
         claim about text the operator cannot see. Imported, never retyped: this string is
         also what the launcher pastes (core/skills.ts, assignedBlock). -->
    <p class="as__caption">Роль отримує призначене під цим заголовком, дослівно:</p>
    <pre class="as__header mono">{{ ASSIGNED_BLOCK_HEADER }}</pre>

    <p v-if="error" class="as__error mono">{{ error }}</p>

    <!-- Gated on the read having SUCCEEDED, not on the list being non-empty and not on the
         absence of an error: the board has a row per agent whatever the data says, so after
         a failed read it would render four agents with nothing assigned — a confident claim
         about a project it could not read. A refused WRITE, by contrast, must leave the list
         up: the error line above says what was refused, and the board is still true. -->
    <ul v-if="loaded" class="as__list">
      <li v-for="row in board" :key="row.agent.id" class="as__row">
        <div class="as__head">
          <span class="as__name">{{ t(row.agent.labelKey) }}</span>
          <span class="as__id mono">{{ row.agent.id }}</span>
          <span class="as__badge" :class="`as__badge--${row.agent.kind}`">
            {{ t('settings.agentKind.' + row.agent.kind) }}
          </span>
          <!-- `≥` and not the plain figure when a body's size is unknown: a name the
               repository alone defines is pasted in full, and this process cannot open that
               file. A lower bound is the honest reading; counting it as zero would tell the
               operator the block is smaller than it is. -->
          <span
            class="as__bytes mono"
            :class="{ 'as__bytes--warn': row.bytes > ASSIGNED_BYTES_WARN }"
          >{{ row.unmeasured.length ? '≥ ' : '' }}{{ size(row.bytes) }}</span>
        </div>

        <p v-if="row.bytes > ASSIGNED_BYTES_WARN" class="as__warn">
          Блок великий: ці байти йдуть у кожен хід цієї ролі, не лише в перший.
        </p>
        <p v-if="row.unmeasured.length" class="as__unmeasured">
          Розмір не порахований для
          <span class="mono">{{ row.unmeasured.join(', ') }}</span>
          — цей текст лежить у репозиторії, і Керманич його не читає з цього екрана.
        </p>

        <ul v-if="row.skills.length" class="as__skills">
          <li
            v-for="s in row.skills"
            :key="s.name"
            class="as__skill"
            :class="{ 'as__skill--broken': s.broken }"
          >
            <span class="as__skill-name mono">{{ s.name }}</span>
            <span class="as__badge" :class="`as__badge--${s.badge.kind}`">{{ s.badge.label }}</span>
            <!-- A dangling assignment: the row exists in the cloud and the launcher still
                 reads it, so it is shown with the one action that fixes it. -->
            <span v-if="s.broken" class="as__skill-note">
              Скіла з таким імʼям немає ні в бібліотеці, ні в репозиторії — роль не отримає нічого.
            </span>
            <span v-else-if="s.shadowedByRepo" class="as__shadow mono">{{ s.shadowedByRepo }}</span>
            <button
              type="button"
              class="as__btn"
              :disabled="!canWrite || busy"
              @click="unassign(row.agent.id, s.name)"
            >Прибрати</button>
          </li>
        </ul>
        <p v-else class="as__none">Нічого не призначено — роль отримає лише свою інструкцію.</p>

        <div class="as__add">
          <select
            class="as__pick mono"
            :value="picked[row.agent.id] ?? ''"
            :disabled="!canWrite || busy || !row.left.length"
            :aria-label="`Призначити скіл ролі ${t(row.agent.labelKey)}`"
            @change="onPick(row.agent.id, $event)"
          >
            <option value="">{{ pickLabel(row.left) }}</option>
            <option v-for="name in row.left" :key="name" :value="name">{{ name }}</option>
          </select>
          <button
            type="button"
            class="as__btn as__btn--primary"
            :disabled="!canWrite || busy || !picked[row.agent.id]"
            @click="assign(row.agent.id)"
          >Призначити</button>
        </div>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
// The assignment board: which library skills each of Kermanych's agents is handed. Same
// split as the library panel next door — the RESOLVED view comes from the local API (only
// it can see whether the bound checkout shadows a name), while the assignments themselves
// are cloud rows written straight to Supabase, where RLS makes them owner-only.
//
// The merge the list renders is `assignmentRows`, a pure function in lib/settings.ts: this
// component adds a badge and a byte format to it and nothing else.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { AGENTS, ASSIGNED_BLOCK_HEADER, DEFAULT_SKILLS, type SkillView } from '@kermanych/core';
import {
  deleteAgentSkill,
  listAgentSkills,
  listProjectSkills,
  setAgentSkill,
  type AgentSkill,
  type ProjectSkill,
} from '@kermanych/cloud';
import { api } from '../../lib/api';
import { useAuth } from 'stores/auth';
import { useProjects } from 'stores/projects';
import { assignmentBadge, assignmentRows, ASSIGNED_BYTES_WARN } from '../../lib/settings';

const props = defineProps<{ projectId: string; projectName: string }>();

const auth = useAuth();
const projects = useProjects();
const { t } = useI18n();

const view = ref<SkillView[]>([]);
const assignments = ref<AgentSkill[]>([]);
const bodyBytes = ref<Record<string, number>>({});
// The names the bound checkout's own skill directories define, keyed to the file that owns
// each. NOT part of the library and never offered in the select — but a name in here is
// deliverable, so the merge needs it to tell a dangling assignment from a repository one.
const repo = ref<Record<string, string>>({});
// `error` carries BOTH failures — a refused read and a refused write — because both are one
// line of the same postgrest message to the operator. `loaded` is what separates them for
// the list: a failed READ has nothing trustworthy to show, while a refused WRITE leaves the
// board it was refused on exactly as valid as it was a second ago.
const error = ref('');
const loaded = ref(false);
// One flag for every write on the pane. A second click while an upsert is in flight would
// race the reload that follows it, and the position it computes would be read from a list
// that is about to be replaced.
const busy = ref(false);
// The pending choice per agent, keyed by agent id: each row has its own select, and picking
// in one must not move another's.
const picked = ref<Record<string, string>>({});

const canWrite = computed(() => projects.isOwner(props.projectId));

// Everything the list needs, derived once: the pure merge, plus the badge and the remaining
// candidates, which are presentation over it rather than part of it. Computed here and not
// in the template — a helper called from three attributes of the same row would rebuild the
// candidate list three times on every render.
//
// `left` is only names the RESOLVED view carries: a name the library does not hold would
// reach the launcher as `missing`, so offering it would be offering to create a broken row.
const board = computed(() => {
  const names = view.value.map((v) => v.name);
  return assignmentRows(AGENTS, assignments.value, view.value, bodyBytes.value, repo.value).map((row) => {
    const taken = new Set(row.skills.map((s) => s.name));
    return {
      ...row,
      skills: row.skills.map((s) => ({ ...s, badge: assignmentBadge(s) })),
      left: names.filter((name) => !taken.has(name)),
    };
  });
});

// Two different reasons the select can offer nothing, and they are not interchangeable: an
// empty library is a job for the Бібліотека скілів pane, while «усе призначено» means this
// agent already has everything there is. Collapsing them would send the operator looking
// for a skill to unassign when there is no library to assign from.
function pickLabel(left: readonly string[]): string {
  if (left.length) return 'вибрати скіл…';
  return view.value.length ? 'усе з бібліотеки вже призначено' : 'бібліотека проєкту порожня';
}

const ENCODER = new TextEncoder();

// What each library name COSTS an agent that is handed it. The resolved view carries no
// body, so the bytes come from the same two sources the resolver reads: the project's own
// cloud row, or the Kermanych default when no row overrides that name.
//
// A repo-shadowed name is an estimate and cannot be anything else: the repository's file is
// what the launcher actually pastes, and its size is not visible from this process. The
// library body is the closest honest figure — and the badge already says the text is the
// repository's, so the number is not read as authoritative.
function measure(rows: readonly SkillView[], stored: readonly ProjectSkill[]): Record<string, number> {
  const bodies = new Map(stored.map((s) => [s.name, s.body]));
  const out: Record<string, number> = {};
  for (const v of rows) {
    const body = bodies.get(v.name) ?? DEFAULT_SKILLS.find((d) => d.name === v.name)?.body ?? '';
    out[v.name] = ENCODER.encode(body).length;
  }
  return out;
}

// Bytes, not tokens: bytes are what this process can actually count, and rounding to KiB
// past a kilobyte keeps the figure readable without implying a precision it does not have.
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  return `${(bytes / 1024).toFixed(1)} КБ`;
}

async function load(): Promise<void> {
  // Pinned for the whole read: the prop is live (see the watcher), so two loads can overlap
  // and a late one must not paint another project's board.
  const projectId = props.projectId;
  error.value = '';
  try {
    const [library, stored, rows] = await Promise.all([
      api.projectSkills(projectId),
      listProjectSkills(auth.client, [projectId]),
      listAgentSkills(auth.client, [projectId]),
    ]);
    if (projectId !== props.projectId) return;
    view.value = library.view;
    repo.value = library.repo;
    assignments.value = rows;
    bodyBytes.value = measure(library.view, stored);
    loaded.value = true;
  } catch (e) {
    if (projectId !== props.projectId) return;
    // Everything, not just the failed half: a board built from two of three reads would
    // mark every assignment broken, which is a lie about the library rather than a report
    // about the failure. `loaded` goes back to false with it — that, and not the emptiness
    // of the data, is what takes the list off screen.
    view.value = [];
    repo.value = {};
    assignments.value = [];
    bodyBytes.value = {};
    loaded.value = false;
    error.value = e instanceof Error ? e.message : String(e);
  }
}

// `projectId` is a LIVE prop: SettingsPage renders its panes with no `:key` and the sidebar
// only moves the selection, so picking another project swaps the prop under a component
// that stays mounted. Same reasoning — and the same consequence if it were missed — as the
// watcher in SkillsLibraryPanel: every write pins the live prop, so leaving the previous
// project's board on screen would let a click write into the project now selected.
watch(
  () => props.projectId,
  () => {
    picked.value = {};
    view.value = [];
    assignments.value = [];
    bodyBytes.value = {};
    repo.value = {};
    loaded.value = false;
    void load();
  },
  { immediate: true },
);

async function assign(agentId: string): Promise<void> {
  const skillName = picked.value[agentId];
  if (!skillName) return;
  const projectId = props.projectId;
  // Appended, not inserted: the operator's existing order is what the launcher pastes in,
  // and a new skill must not push its way in front of it. `+ 1` off the highest position
  // this agent already uses, so it lands last even after removals left gaps.
  const mine = assignments.value.filter((r) => r.agentId === agentId);
  const position = mine.reduce((max, r) => Math.max(max, r.position + 1), 0);
  error.value = '';
  // Held across the reload as well as the write: until the re-read lands, the list this
  // function computes a position from does not yet contain the row just written, so a
  // second assignment made in that window would be handed the same position.
  busy.value = true;
  try {
    await setAgentSkill(auth.client, { projectId, agentId, skillName, position });
    if (projectId !== props.projectId) return;
    picked.value = { ...picked.value, [agentId]: '' };
    await load();
  } catch (e) {
    if (projectId !== props.projectId) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

// Also the fix for a broken row: the assignment is a cloud row whether or not a skill of
// that name still exists, so the same delete removes it. `deleteAgentSkill` throws when it
// matched nothing — an RLS refusal reads identically to success on a DELETE otherwise — and
// nothing is dropped from the list locally: the reload is what the screen reflects.
async function unassign(agentId: string, skillName: string): Promise<void> {
  const projectId = props.projectId;
  error.value = '';
  busy.value = true;
  try {
    await deleteAgentSkill(auth.client, projectId, agentId, skillName);
    if (projectId !== props.projectId) return;
    await load();
  } catch (e) {
    if (projectId !== props.projectId) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

function onPick(agentId: string, e: Event): void {
  picked.value = { ...picked.value, [agentId]: (e.target as HTMLSelectElement).value };
}
</script>

<style scoped lang="scss">
.as__lead { font-size: 13px; color: var(--k-muted); margin-bottom: 12px; }
.as__lead-project { color: var(--k-text); }
/* The four sentences are the pane's only explanation of what «призначено» means, so they
   read as a numbered procedure rather than a paragraph of small print. */
.as__how { margin: 0 0 12px; padding-left: 20px; font-size: 12.5px; line-height: 1.6; color: var(--k-muted); }
.as__caption { margin: 0 0 4px; font-size: 11.5px; color: var(--k-muted); }
/* `pre-wrap` and `--k-surface2`, the same treatment the catalogue gives an instruction
   template: this is text a model receives, shown verbatim. */
.as__header {
  margin: 0 0 16px;
  padding: 8px 10px;
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--k-surface2);
  border-radius: var(--k-r);
}
.as__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.as__row { padding: 10px 12px; background: var(--k-surface); border: 1px solid var(--k-line); border-radius: var(--k-r); }
.as__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.as__name { font-size: 12.5px; }
.as__id { font-size: 11px; color: var(--k-faint); }
.as__badge { font-size: 10.5px; padding: 1px 6px; border: 1px solid var(--k-line-strong); border-radius: var(--k-r); color: var(--k-muted); white-space: nowrap; }
/* Agent kinds, matching the catalogue's vocabulary exactly — an operator moving between
   the two panes must not have to relearn the badges. `automation` is absent on purpose:
   an agent with no instruction has no row here. */
.as__badge--session { color: var(--k-accent); border-color: var(--k-accent); }
.as__badge--procedure { color: var(--k-text); }
/* Skill sources, matching the library panel's badges for the same three cases. */
.as__badge--repo { color: var(--k-accent); border-color: var(--k-accent); }
.as__badge--broken { color: var(--k-danger); border-color: var(--k-danger); border-style: dashed; }
/* The byte total sits at the end of the head line; it only draws attention past the
   threshold, because on a normal row it is a fact and not a problem. */
.as__bytes { margin-left: auto; font-size: 11px; color: var(--k-faint); }
.as__bytes--warn { color: var(--k-danger); }
.as__warn { margin: 6px 0 0; font-size: 11.5px; color: var(--k-danger); }
/* Muted, not danger: an unknown size is a limit of this screen, not something wrong with
   the assignment — the skill is delivered either way. */
.as__unmeasured { margin: 6px 0 0; font-size: 11.5px; color: var(--k-muted); }
.as__skills { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 6px; }
.as__skill { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
/* The remove button is pushed to the right edge, so every «Прибрати» in an agent's list
   lines up in one column instead of trailing whatever the row's name and path happened to
   be wide. Same edge the byte total in the head line sits against. */
.as__skill .as__btn { margin-left: auto; }
.as__skill-name { font-size: 12px; }
/* A dangling name is struck through: the row is real, the skill it names is not. */
.as__skill--broken .as__skill-name { color: var(--k-muted); text-decoration: line-through; }
.as__skill-note { font-size: 11.5px; color: var(--k-danger); }
.as__shadow { font-size: 11px; color: var(--k-muted); overflow-wrap: anywhere; }
.as__none { margin: 8px 0 0; font-size: 12px; color: var(--k-muted); }
.as__add { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
/* Deliberately not KSelect: that component is a labelled form field with its own column
   layout, and this is one inline control on an action row. Same surface and focus ring. */
.as__pick {
  font: inherit;
  font-family: var(--k-font-mono);
  font-size: 12px;
  padding: 3px 8px;
  color: var(--k-text);
  background: var(--k-surface);
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  outline: none;
  cursor: pointer;
  &:focus { border-color: var(--k-accent); box-shadow: inset 0 0 0 1px var(--k-accent); }
  &:disabled { opacity: 0.45; cursor: default; }
}
.as__btn { font: inherit; font-size: 12px; padding: 3px 10px; background: transparent; color: var(--k-text); border: 1px solid var(--k-line-strong); border-radius: var(--k-r); cursor: pointer; }
.as__btn:disabled { opacity: 0.45; cursor: default; }
.as__btn--primary { border-color: var(--k-accent); color: var(--k-accent); }
.as__error { font-size: 11.5px; color: var(--k-accent); }
</style>
