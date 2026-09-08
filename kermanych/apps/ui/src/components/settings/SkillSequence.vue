<template>
  <div class="ss">
    <!-- Numbered, and the number is not decoration: the launcher pastes the assigned bodies in
         exactly this order (SkillsService.assignedFor sorts by position), so the list IS the
         delivery order and the note under it says so. -->
    <ol v-if="items.length" class="ss__list">
      <li
        v-for="(item, i) in items"
        :key="item.name"
        class="ss__item"
        :class="{ 'ss__item--broken': item.broken }"
      >
        <span class="ss__pos mono">{{ i + 1 }}</span>
        <span class="ss__name mono">{{ item.name }}</span>
        <span class="ss__badge" :class="`ss__badge--${item.badge.kind}`">
          {{ t('settings.skillStatus.' + item.badge.kind) }}
        </span>
        <!-- A name that resolves to neither the library nor the checkout: the row is real and
             the launcher still reads it, so it is shown with the one control that fixes it. -->
        <span v-if="item.broken" class="ss__note">{{ t('settings.skillSeq.brokenNote') }}</span>
        <span v-else-if="item.shadowedByRepo" class="ss__shadow mono">{{ item.shadowedByRepo }}</span>

        <span class="ss__ctl">
          <!-- Arrows carry the label in `aria-label`: three words of Ukrainian per row twice
               over would push the name off the line, and the glyph is unambiguous in place. -->
          <button
            type="button"
            class="ss__btn ss__btn--move"
            :disabled="disabled || i === 0"
            :aria-label="t('settings.skillSeq.up')"
            :title="t('settings.skillSeq.up')"
            @click="move(i, -1)"
          >↑</button>
          <button
            type="button"
            class="ss__btn ss__btn--move"
            :disabled="disabled || i === items.length - 1"
            :aria-label="t('settings.skillSeq.down')"
            :title="t('settings.skillSeq.down')"
            @click="move(i, 1)"
          >↓</button>
          <button type="button" class="ss__btn" :disabled="disabled" @click="remove(i)">
            {{ t('settings.skillSeq.remove') }}
          </button>
        </span>
      </li>
    </ol>
    <p v-else class="ss__empty">{{ t('settings.skillSeq.empty') }}</p>

    <div v-if="items.length" class="ss__meta">
      <p class="ss__order">{{ t('settings.skillSeq.orderNote') }}</p>
      <!-- `≥` and not the plain figure when a body's size is unknown: a name the checkout alone
           defines is pasted in full, and this process cannot open that file. A lower bound is
           the honest reading; counting it as zero would understate the block. -->
      <p class="ss__bytes mono" :class="{ 'ss__bytes--warn': cost.bytes > ASSIGNED_BYTES_WARN }">
        {{ cost.unmeasured.length ? '≥ ' : '' }}{{ size(cost.bytes) }}
      </p>
    </div>
    <p v-if="cost.bytes > ASSIGNED_BYTES_WARN" class="ss__warn">{{ t('settings.skillSeq.bigWarn') }}</p>
    <!-- Muted, not danger: an unknown size is a limit of this screen, not something wrong with
         the sequence — every one of these names is delivered either way. -->
    <i18n-t v-if="cost.unmeasured.length" keypath="settings.skillSeq.unmeasured" tag="p" class="ss__unmeasured">
      <template #names><span class="mono">{{ cost.unmeasured.join(', ') }}</span></template>
    </i18n-t>

    <div class="ss__add">
      <KSelect
        :model-value="picked"
        :options="left"
        :placeholder="pickPlaceholder"
        :disabled="disabled || !left.length"
        @update:model-value="picked = $event"
      />
      <button
        type="button"
        class="ss__btn ss__btn--primary"
        :disabled="disabled || !picked"
        @click="add"
      >{{ t('settings.skillSeq.add') }}</button>
    </div>
  </div>
</template>

<script lang="ts">
import { DEFAULT_SKILLS, type SkillView as SkillViewRow } from '@kermanych/core';
import type { AiSkill } from '@kermanych/cloud';

const ENCODER = new TextEncoder();

/**
 * WHAT EACH LIBRARY NAME COSTS whoever is handed it, keyed by name — the `bodyBytes` prop below.
 *
 * Exported from this component and not written twice by its two hosts: the number is only ever
 * shown here, so this is where the rule for producing it belongs. The RESOLVED view carries no
 * body, so the bytes come from the same two sources the resolver reads: the project's own cloud
 * row, or the Kermanych default when no row overrides that name.
 *
 * A repo-shadowed name is an estimate and cannot be anything else: the checkout's file is what
 * the launcher actually pastes, and its size is not visible from this process. The library body
 * is the closest honest figure — and the badge already says the text is the repository's, so the
 * number is not read as authoritative.
 */
export function measureSkillBytes(
  rows: readonly SkillViewRow[],
  stored: readonly AiSkill[],
): Record<string, number> {
  const bodies = new Map(stored.map((s) => [s.name, s.body]));
  const out: Record<string, number> = {};
  for (const v of rows) {
    const body = bodies.get(v.name) ?? DEFAULT_SKILLS.find((d) => d.name === v.name)?.body ?? '';
    out[v.name] = ENCODER.encode(body).length;
  }
  return out;
}
</script>

<script setup lang="ts">
// THE ORDERED SKILL SEQUENCE, shared by the two entities that can carry one: a Kermanych agent
// («Агенти») and a prompt trigger («Тригери»). One component because the thing being edited is
// literally the same — a list of library names whose ORDER is what the launcher pastes — and two
// copies of it would drift the first time either side grew a control.
//
// It NEVER writes. The host owns the persistence (`setAgentSkills` / `setTriggerSkills`, both
// replace-all), because only the host knows whether a change belongs to a row that already
// exists or to a draft that has not been saved yet. Every gesture here emits the whole next
// list, so the host never has to reconstruct positions.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SkillView } from '@kermanych/core';
import KSelect from 'components/kit/KSelect.vue';
import { assignmentBadge, ASSIGNED_BYTES_WARN, type AssignedSkill } from '../../lib/settings';

const props = defineProps<{
  names: string[];
  view: SkillView[];
  // Keyed by skill NAME, not by position: the byte cost is a property of the library entry, and
  // the same skill on two agents is paid for twice, once per launch.
  bodyBytes: Record<string, number>;
  // The names the bound checkout's own skill directories define, keyed to the file that owns
  // each. Not part of the library and never offered below — but a name in here IS delivered, so
  // the merge needs it to tell a dangling name from a repository one.
  repo: Record<string, string>;
  disabled?: boolean;
}>();

const emit = defineEmits<{ 'update:names': [names: string[]] }>();

const { t } = useI18n();

const picked = ref('');

// Each name as the list shows it: where its text comes from, or that it comes from nowhere.
//
// BROKEN MEANS ABSENT FROM BOTH LISTS, never from `view` alone. The library and the checkout are
// different places and the resolver reads either one (SkillsService.assignedForNames), so a name
// the repository alone defines is delivered in full on every launch — calling it «немає навички»
// would tell the operator to remove something that works, and they would.
//
// `Object.hasOwn`, never a bare `repo[name]`: `repo` is a plain JSON-parsed object and
// `constructor` is a LEGAL skill name under SKILL_NAME_RE — lowercase, no separators — so a
// dangling `constructor` would otherwise inherit a truthy `Object.prototype.constructor` and
// render as a live row with a stringified function for a path. Same rule, same reason as
// assignmentRows and renderRuleFile.
const items = computed(() => {
  const byName = new Map(props.view.map((v) => [v.name, v]));
  return props.names.map((name) => {
    const hit = byName.get(name);
    const repoPath = Object.hasOwn(props.repo, name) ? props.repo[name] : undefined;
    const skill: AssignedSkill = !hit
      ? repoPath === undefined
        ? { name, broken: true }
        : // Repository-only: there is no library entry to describe it, and `source` would be a
          // guess. `assignmentBadge` reads `shadowedByRepo` first, so the path alone is enough
          // to label it «перекрито репо» — which is exactly what it is.
          { name, shadowedByRepo: repoPath }
      : {
          name: hit.name,
          source: hit.source,
          // Spread rather than an explicit `undefined`: that would make the key present, and
          // the badge only asks whether it is there.
          ...(hit.shadowedByRepo ? { shadowedByRepo: hit.shadowedByRepo } : {}),
        };
    return { ...skill, badge: assignmentBadge(skill) };
  });
});

// What the sequence COSTS. A broken name contributes no bytes and counts as measured: there is
// no body to pay for, so the total stays an honest figure rather than an open question.
const cost = computed(() => {
  let bytes = 0;
  const unmeasured: string[] = [];
  for (const item of items.value) {
    if (item.broken) continue;
    if (Object.hasOwn(props.bodyBytes, item.name)) bytes += props.bodyBytes[item.name]!;
    else unmeasured.push(item.name);
  }
  return { bytes, unmeasured };
});

// Only names the RESOLVED view carries: a name the library does not hold would reach the
// launcher as `missing`, so offering it would be offering to create a broken row.
const left = computed(() => {
  const taken = new Set(props.names);
  return props.view.map((v) => v.name).filter((name) => !taken.has(name));
});

// The host can replace `names` under us — a project switch, a reload after a save — and a
// selection that survived it would add a name that is already in the sequence or no longer in
// the library. Dropped rather than silently ignored on click, so the picker never shows a
// choice the button refuses to act on.
watch(left, (candidates) => {
  if (picked.value && !candidates.includes(picked.value)) picked.value = '';
});

// Two different reasons the picker can offer nothing, and they are not interchangeable: an empty
// library is a job for the «Навички» pane, while «усе вже призначено» means this sequence already
// holds everything there is. Collapsing them would send the operator looking for a skill to
// remove when there is no library to add from.
const pickPlaceholder = computed(() => {
  if (left.value.length) return t('settings.skillSeq.pickPlaceholder');
  return props.view.length
    ? t('settings.skillSeq.allAssigned')
    : t('settings.skillSeq.libraryEmpty');
});

// Bytes, not tokens: bytes are what this process can actually count, and rounding to KiB past a
// kilobyte keeps the figure readable without implying a precision it does not have.
function size(bytes: number): string {
  if (bytes < 1024) return t('settings.skillSeq.bytes', { n: bytes });
  return t('settings.skillSeq.kib', { n: (bytes / 1024).toFixed(1) });
}

// Appended, never inserted: the operator's existing order is what the launcher pastes, and a new
// skill must not push its way in front of it.
function add(): void {
  const name = picked.value;
  if (!name || props.names.includes(name)) return;
  picked.value = '';
  emit('update:names', [...props.names, name]);
}

function remove(i: number): void {
  emit('update:names', props.names.filter((_, at) => at !== i));
}

// One swap, not a re-sort: the operator moved ONE row, and everything else must stay where it
// was — a stable insert-elsewhere would renumber rows nobody touched.
function move(i: number, delta: number): void {
  const to = i + delta;
  if (to < 0 || to >= props.names.length) return;
  const next = [...props.names];
  [next[i], next[to]] = [next[to]!, next[i]!];
  emit('update:names', next);
}
</script>

<style scoped lang="scss">
.ss__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.ss__item { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
/* The position, in the same column width for every row so a two-digit sequence does not shift
   the names it numbers. */
.ss__pos { min-width: 14px; font-size: 11px; color: var(--k-faint); text-align: right; }
.ss__name { font-size: 12px; }
/* A dangling name is struck through: the row is real, the skill it names is not. */
.ss__item--broken .ss__name { color: var(--k-muted); text-decoration: line-through; }
.ss__badge { font-size: 10.5px; padding: 1px 6px; border: 1px solid var(--k-line-strong); border-radius: var(--k-r); color: var(--k-muted); white-space: nowrap; }
/* Skill sources, matching the library pane's badges for the same three cases. */
.ss__badge--repo { color: var(--k-accent); border-color: var(--k-accent); }
.ss__badge--broken { color: var(--k-danger); border-color: var(--k-danger); border-style: dashed; }
.ss__note { font-size: 11.5px; color: var(--k-danger); }
.ss__shadow { font-size: 11px; color: var(--k-muted); overflow-wrap: anywhere; }
/* Every row's controls against the right edge, so «Прибрати» lines up in one column whatever the
   name and path happened to be wide. */
.ss__ctl { margin-left: auto; display: flex; align-items: center; gap: 4px; }
.ss__empty { margin: 0; font-size: 12px; color: var(--k-muted); }
/* The order note and the byte total share a line: the note explains what the numbers mean, the
   total is the price of the list they number. */
.ss__meta { display: flex; align-items: baseline; gap: 8px; margin-top: 8px; }
.ss__order { margin: 0; font-size: 11.5px; color: var(--k-muted); }
.ss__bytes { margin: 0 0 0 auto; font-size: 11px; color: var(--k-faint); white-space: nowrap; }
.ss__bytes--warn { color: var(--k-danger); }
.ss__warn { margin: 6px 0 0; font-size: 11.5px; color: var(--k-danger); }
.ss__unmeasured { margin: 6px 0 0; font-size: 11.5px; color: var(--k-muted); }
/* The picker is a KSelect with no label, so it has no caption row to align against the button:
   `align-items: end` puts both on the same baseline whatever the select's internal padding. */
.ss__add { display: flex; align-items: end; gap: 6px; margin-top: 10px; }
.ss__add :deep(.k-select) { min-width: 220px; }
.ss__btn { font: inherit; font-size: 12px; padding: 3px 10px; background: transparent; color: var(--k-text); border: 1px solid var(--k-line-strong); border-radius: var(--k-r); cursor: pointer; }
.ss__btn:disabled { opacity: 0.45; cursor: default; }
.ss__btn--primary { border-color: var(--k-accent); color: var(--k-accent); }
/* Square, so the two arrows read as one control pair rather than two short words. */
.ss__btn--move { padding: 3px 7px; line-height: 1.2; }
</style>
