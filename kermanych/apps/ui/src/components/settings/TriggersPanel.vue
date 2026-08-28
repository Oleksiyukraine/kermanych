<template>
  <section class="tg">
    <!-- Deliberately NOT a restatement of the pane blurb sixty pixels above it: that line
         already says «без рішення моделі», so this one earns its place by drawing the
         distinction the operator actually has to hold — library versus trigger. -->
    <p class="tg__lead">
      Тригери проєкту
      <span class="tg__lead-project mono">{{ projectName }}</span>.
      Скіл із бібліотеки агент бере сам, коли вважає за потрібне; тригер вкидає свій текст тоді,
      коли збігся патерн — хоче того модель чи ні.
    </p>

    <!-- The two halves are not interchangeable and the operator picks between them in the
         source field, so the difference is stated before they get there. -->
    <ol class="tg__how">
      <li>
        <span class="mono">слова оператора</span> — матчить сам Керманич, ще до того як
        повідомлення піде в сесію. Тільки цей тригер може запустити агента.
      </li>
      <li>
        решта — правило всередині сесії: воно дивиться на відповідь моделі, її розмірковування
        або аргументи інструмента. Звідти покликати агента нема як, тож там лише скіл.
      </li>
    </ol>

    <p v-if="error" class="tg__error mono">{{ error }}</p>

    <!-- Gated on the read having SUCCEEDED, not on the list being empty: «тригерів немає» after
         a failed read is a claim about the project this pane could not read, and it is the
         claim that would keep an operator from looking for the trigger that did fire. A refused
         WRITE leaves the list up — the error line says what was refused, and every row on
         screen is still true. -->
    <template v-if="loaded">
      <ul v-if="triggers.length" class="tg__list">
        <li
          v-for="t in triggers"
          :key="t.id"
          class="tg__row"
          :class="{ 'tg__row--off': !t.enabled }"
        >
          <div class="tg__head">
            <span class="tg__name">{{ t.label }}</span>
            <span class="tg__id mono">{{ t.id }}</span>
            <span class="tg__badge">{{ triggerSourceLabel(t.source) }}</span>
            <!-- Only the deliberate choices are badged. The defaults — soft, once — are the
                 ordinary case and a badge on every row would say nothing. -->
            <span v-if="t.mode === 'interrupt'" class="tg__badge tg__badge--hard">обриває хід</span>
            <span v-if="t.repeat === 'after-gap'" class="tg__badge">може повторюватись</span>
          </div>

          <p class="tg__pattern mono">{{ t.pattern }}</p>
          <p v-if="t.pathGlobs.length" class="tg__globs mono">{{ t.pathGlobs.join(', ') }}</p>

          <p class="tg__does">
            <template v-if="t.action === 'agent'">
              запускає <span class="mono">{{ agentLabel(t.target) }}</span>
            </template>
            <template v-else>
              вкидає скіл <span class="mono">{{ t.target }}</span>
            </template>
          </p>
          <!-- The same dangling reference the runtime reports as a warn notice mid-session,
               shown here where it can actually be fixed. Only once the library read landed:
               without it this pane knows nothing about which names resolve. -->
          <p v-if="danglingNote(t)" class="tg__warn">{{ danglingNote(t) }}</p>

          <div class="tg__actions">
            <KCheckbox
              :model-value="t.enabled"
              label="Увімкнено"
              :disabled="!canWrite || busy"
              @update:model-value="toggle(t)"
            />
            <button type="button" class="tg__btn" :disabled="!canWrite || busy" @click="edit(t)">
              Редагувати
            </button>
            <button type="button" class="tg__btn" :disabled="!canWrite || busy" @click="drop(t.id)">
              Видалити
            </button>
          </div>
        </li>
      </ul>
      <p v-else class="tg__empty mono">Тригерів немає — нічого не спрацьовує саме.</p>

      <!-- Only with the list on screen: a trigger is saved with an upsert on (проєкт, id), so
           creating one against a list that failed to load could silently overwrite a trigger
           the operator cannot see. -->
      <button type="button" class="tg__btn tg__btn--primary" :disabled="!canWrite || busy" @click="create">
        Додати тригер
      </button>
    </template>

    <KModal
      v-model="editorOpen"
      :title="editing ? `Тригер · ${draft.id}` : 'Новий тригер'"
      width="560px"
    >
      <div class="tg__form">
        <!-- The id names the rule file the session loads (`rules/<id>.md`), so it is fixed
             once the row exists: renaming would leave the old rule behind and write a second. -->
        <KField
          v-model="draft.id"
          label="Ідентифікатор (латиниця, цифри, дефіс)"
          :disabled="editing"
          placeholder="env-guard"
        />
        <KField v-model="draft.label" label="Назва" placeholder="Просить нову змінну середовища" />
        <p class="tg__note">
          Назву видно в стрічці сесії, коли тригер спрацював, і вона ж іде в правило як опис.
        </p>

        <KSelect v-model="draft.source" label="Дивитися на" :options="TRIGGER_SOURCE_OPTIONS" />

        <KField v-model="draft.pattern" label="Патерн (регулярний вираз)" placeholder="нов\w* env" />
        <p class="tg__note">
          Короткий патерн ловить більше, ніж здається: <span class="mono">env</span> збігається
          і з <span class="mono">.env</span>, і з <span class="mono">environment</span>, і з
          <span class="mono">Envoy</span>. Кожен збіг коштує окремого ходу.
        </p>

        <!-- The test field. An unparseable pattern is invisible at launch — Керманич skips past
             it and omp simply never fires the rule — so this line is the only place it is ever
             seen. It renders as soon as there is a pattern, with or without a sample. -->
        <KField
          v-model="sample"
          label="Перевірка: встав шматок тексту"
          multiline
          :rows="2"
          placeholder="нам потрібна нова env для API"
        />
        <p v-if="patternError" class="tg__error mono">Патерн не компілюється: {{ patternError }}</p>
        <p v-else-if="matched === true" class="tg__hit">Збігається — тригер спрацював би.</p>
        <p v-else-if="matched === false" class="tg__miss">Не збігається.</p>
        <p class="tg__note">
          <template v-if="draft.source === 'operator'">
            Керманич звіряє цей патерн нечутливо до регістру: текст оператора — жива проза, і
            велика літера на початку речення нічого не означає.
          </template>
          <template v-else>
            Цю умову компілює сам omp усередині сесії — Керманич не додає жодних прапорців, тож
            регістр тут значить рівно те, що написано в патерні.
          </template>
        </p>

        <!-- Globs scope a rule to the files a tool touched, so they have nothing to scope on any
             other source. Cleared on the way out (see the source watcher) rather than merely
             hidden: a value the operator can no longer see must not keep being written. -->
        <template v-if="draft.source === 'tool'">
          <KField
            v-model="globs"
            label="Тільки для шляхів (через кому; порожньо — для будь-яких)"
            placeholder="apps/api/**, packages/**"
          />
        </template>

        <KSelect v-model="draft.action" label="Що зробити" :options="actionOptions" />
        <KSelect
          v-if="draft.action === 'agent'"
          v-model="draft.target"
          label="Якого агента запустити"
          :options="agentOptions"
          placeholder="вибрати агента…"
        />
        <template v-else>
          <KSelect
            v-model="draft.target"
            label="Який скіл вкинути"
            :options="skillOptions"
            :placeholder="skillPlaceholder"
            :disabled="!!libraryError"
          />
          <p v-if="libraryError" class="tg__error mono">{{ libraryError }}</p>
        </template>
        <p class="tg__note">
          Текст цілі має бути прямою вказівкою до дії. Розпливчастий опис лише змушує модель піти
          розбиратися, замість того щоб зробити.
        </p>

        <KSelect v-model="draft.mode" label="Режим" :options="MODE_OPTIONS" />
        <p v-if="draft.mode === 'interrupt'" class="tg__warn">
          Жорсткий режим обриває хід і викидає недописану відповідь — і однаково не гарантує
          послуху: у прогоні модель повторила заборонене слово одразу після переривання.
        </p>
        <KSelect v-model="draft.repeat" label="Повтор" :options="REPEAT_OPTIONS" />

        <p v-if="formError" class="tg__error mono">{{ formError }}</p>
      </div>
      <template #controls>
        <button type="button" class="tg__btn" @click="editorOpen = false">Скасувати</button>
        <!-- `canWrite` here as well as on every list action: the modal must not be the one
             surface where a non-owner's write reaches postgrest only to be refused there. -->
        <button
          type="button"
          class="tg__btn tg__btn--primary"
          :disabled="saving || !canWrite"
          @click="save"
        >Зберегти</button>
      </template>
    </KModal>
  </section>
</template>

<script setup lang="ts">
// The trigger list: the content that fires without the model choosing to. Same split as the
// two panes before it — the rows are cloud rows written straight to Supabase, where RLS makes
// them owner-only, while the RESOLVED skill view comes from the local API, which is the only
// party that can see whether the bound checkout shadows a name.
//
// The two reads are NOT merged, and that is the difference from the assignment board next
// door. There a row was a merge of every read, so one failure invalidated the board. Here the
// list is the cloud rows alone; the library is only what fills the skill picker, so losing it
// costs the picker and leaves every trigger on screen exactly as true as it was.
import { computed, reactive, ref, watch } from 'vue';
import { AGENTS, SKILL_NAME_RE, type SkillView } from '@kermanych/core';
import { deleteTrigger, listTriggers, upsertTrigger, type ProjectTrigger } from '@kermanych/cloud';
import { api } from '../../lib/api';
import { useAuth } from 'stores/auth';
import { useProjects } from 'stores/projects';
import KModal from 'components/kit/KModal.vue';
import KField from 'components/kit/KField.vue';
import KSelect from 'components/kit/KSelect.vue';
import KCheckbox from 'components/kit/KCheckbox.vue';
import {
  triggerActionOptions,
  triggerAgentOptions,
  triggerMatches,
  triggerSourceLabel,
  TRIGGER_SOURCE_OPTIONS,
} from '../../lib/settings';

const props = defineProps<{ projectId: string; projectName: string }>();

const auth = useAuth();
const projects = useProjects();

// `remind` first and `once` first: the defaults a new trigger opens on, and the ones a native
// select would land on anyway. The hard mode discards a partial answer, so it is a choice the
// operator has to reach for rather than one they can fall into.
const MODE_OPTIONS = [
  { value: 'remind', label: 'мʼякий — дочекатись ходу й дописати' },
  { value: 'interrupt', label: 'жорсткий — обірвати хід' },
];
const REPEAT_OPTIONS = [
  { value: 'once', label: 'один раз за сесію' },
  { value: 'after-gap', label: 'знову, якщо минув час' },
];

const triggers = ref<ProjectTrigger[]>([]);
const view = ref<SkillView[]>([]);
// The names the bound checkout's own skill directories define, keyed to the file that owns
// each. Never offered in the picker — they are not this project's library — but a target in
// here resolves at launch, so the list needs it to tell a dangling trigger from a repo one.
const repo = ref<Record<string, string>>({});
// `error` carries the trigger read AND every refused write: both are one line of the same
// postgrest message. `loaded` is what separates them for the list — a failed read has nothing
// trustworthy to show, a refused write leaves the rows it was refused on standing.
const error = ref('');
const loaded = ref(false);
// The library read fails on its own terms (the local api is down, the project is unbound) and
// costs only the skill picker, so it gets its own line inside the editor.
const libraryError = ref('');
const busy = ref(false);
const editorOpen = ref(false);
const editing = ref(false);
const saving = ref(false);
const formError = ref('');
// Editor-only, never stored: the sample the operator pastes to see whether the pattern bites.
const sample = ref('');
// The globs field is a plain line the operator types; `path_globs` is an array. Kept as text
// while editing so a half-typed «apps/, » is not repeatedly re-split under the cursor.
const globs = ref('');

const canWrite = computed(() => projects.isOwner(props.projectId));

// `mode` → remind and `repeat` → once are the defaults in three places at once — here, the
// column defaults in the migration, and renderRuleFile's mapping to interruptMode/repeatMode.
// A new trigger is a soft reminder until someone says otherwise.
function blankDraft(): Omit<ProjectTrigger, 'projectId' | 'pathGlobs'> {
  return {
    id: '',
    label: '',
    enabled: true,
    source: 'operator',
    pattern: '',
    action: 'skill',
    target: '',
    mode: 'remind',
    repeat: 'once',
  };
}
const draft = reactive(blankDraft());

const actionOptions = computed(() => triggerActionOptions(draft.source));
const agentOptions = computed(() => triggerAgentOptions(AGENTS));
const skillOptions = computed(() => view.value.map((v) => v.name));
const skillPlaceholder = computed(() =>
  view.value.length ? 'вибрати скіл…' : 'бібліотека проєкту порожня',
);

// One evaluation for both lines below: an uncompilable pattern reports its message, anything
// else reports the match. The sample is only consulted for the match — the compile error must
// show the moment the pattern is broken, whether or not there is anything to test it against.
const tested = computed<boolean | string | undefined>(() =>
  draft.pattern ? triggerMatches(draft.pattern, sample.value, draft.source) : undefined,
);
const patternError = computed(() => (typeof tested.value === 'string' ? tested.value : ''));
const matched = computed(() =>
  typeof tested.value === 'boolean' && sample.value.trim() ? tested.value : undefined,
);

// Resolved against the RUNNABLE agents, not the whole registry. `finish` and `summary` are in
// `AGENTS` and have labels, so the full registry would render «запускає Завершити» directly
// above the line saying Kermanych cannot start it — two claims about one row, the friendlier
// of them false. An unrunnable target keeps its raw id, which is what the warning names too.
function agentLabel(id: string): string {
  return triggerAgentOptions(AGENTS).find((o) => o.value === id)?.label ?? id;
}

// What a trigger will actually do when it fires, or the reason it will do nothing. Both cases
// are ones the runtime already reports mid-session — a warn notice for a skill that resolved
// to nothing, an error notice for an agent it cannot start — and this is the surface where
// either can be fixed instead of merely observed.
function danglingNote(t: ProjectTrigger): string {
  if (t.action === 'agent') {
    if (triggerAgentOptions(AGENTS).some((o) => o.value === t.target)) return '';
    return `Агента «${t.target}» Керманич запустити не може — тригер лише додасть помилку в стрічку.`;
  }
  // Silent while the library is unknown: «немає в бібліотеці» from a pane that could not read
  // the library is a claim about the project rather than about this row.
  if (libraryError.value) return '';
  if (view.value.some((v) => v.name === t.target)) return '';
  // A name only the bound checkout defines is NOT offered in the picker — it is not this
  // project's library — but it does resolve at launch, through the very same resolver the
  // trigger uses. Calling such a target dangling would be the false alarm.
  //
  // `Object.hasOwn`, never a bare `repo.value[target]`: `repo` is a plain JSON-parsed object
  // and `constructor` is a legal skill name — lowercase, no separators — so it passes both
  // SKILL_NAME_RE and the DB's identical check on `target`. A trigger aimed at a `constructor`
  // that exists nowhere would otherwise inherit a truthy `Object.prototype.constructor` and
  // pass for a live target. Same rule, same reason as assignmentRows and renderRuleFile.
  if (Object.hasOwn(repo.value, t.target)) return '';
  return `Скіла «${t.target}» немає в бібліотеці — тригер спрацює й нічого не вкине.`;
}

async function load(): Promise<void> {
  // Pinned for the whole read: the prop is live (see the watcher), so two loads can overlap and
  // a late one must not paint another project's triggers.
  const projectId = props.projectId;
  error.value = '';
  libraryError.value = '';
  const [rows, library] = await Promise.allSettled([
    listTriggers(auth.client, [projectId]),
    api.projectSkills(projectId),
  ]);
  if (projectId !== props.projectId) return;
  if (rows.status === 'fulfilled') {
    triggers.value = rows.value;
    loaded.value = true;
  } else {
    triggers.value = [];
    loaded.value = false;
    error.value = rows.reason instanceof Error ? rows.reason.message : String(rows.reason);
  }
  if (library.status === 'fulfilled') {
    view.value = library.value.view;
    repo.value = library.value.repo;
  } else {
    view.value = [];
    repo.value = {};
    libraryError.value =
      library.reason instanceof Error ? library.reason.message : String(library.reason);
  }
}

// `projectId` is a LIVE prop: SettingsPage renders its panes with no `:key` and the sidebar
// only moves the selection, so picking another project swaps the prop under a component that
// stays mounted. The editor is shut synchronously with it — a draft left open across the
// switch would save into a project it was never opened for.
watch(
  () => props.projectId,
  () => {
    editorOpen.value = false;
    resetDraft();
    triggers.value = [];
    view.value = [];
    repo.value = {};
    loaded.value = false;
    void load();
  },
  { immediate: true },
);

// `agent` is only reachable from `operator` (the DB says so too), so a source change has to
// take the action with it — otherwise the select would keep showing a choice its own option
// list no longer contains, and the save would be refused by a check constraint. Globs go the
// same way: they scope a tool call, and nothing else has a path to scope on.
watch(
  () => draft.source,
  (source) => {
    if (source !== 'operator' && draft.action === 'agent') {
      draft.action = 'skill';
      draft.target = '';
    }
    if (source !== 'tool') globs.value = '';
  },
);

// A skill name and an agent id are different namespaces: keeping the old value would leave the
// picker showing a target the new action cannot resolve.
watch(
  () => draft.action,
  () => {
    draft.target = '';
  },
);

function resetDraft(): void {
  Object.assign(draft, blankDraft());
  editing.value = false;
  formError.value = '';
  sample.value = '';
  globs.value = '';
}
watch(editorOpen, (open) => {
  if (!open) resetDraft();
});

function create(): void {
  resetDraft();
  editorOpen.value = true;
}

// Everything the editor needs is already in the row this pane read, so opening one is
// synchronous — there is no second fetch that could land in someone else's draft.
function edit(t: ProjectTrigger): void {
  resetDraft();
  editing.value = true;
  Object.assign(draft, {
    id: t.id,
    label: t.label,
    enabled: t.enabled,
    source: t.source,
    pattern: t.pattern,
    action: t.action,
    target: t.target,
    mode: t.mode,
    repeat: t.repeat,
  });
  globs.value = t.pathGlobs.join(', ');
  editorOpen.value = true;
}

async function save(): Promise<void> {
  // Pinned like every write on this pane: the row belongs to the project the operator was
  // looking at when the button went down.
  const projectId = props.projectId;
  formError.value = '';
  if (!SKILL_NAME_RE.test(draft.id)) {
    formError.value = 'Ідентифікатор: лише малі латинські літери, цифри та дефіс (до 64 символів).';
    return;
  }
  if (!draft.label.trim()) {
    formError.value = 'Без назви тригер нічим не назветься ні в стрічці, ні в правилі.';
    return;
  }
  if (!draft.pattern.trim()) {
    formError.value = 'Патерн порожній — такий тригер не спрацює ніколи.';
    return;
  }
  // The one check the runtime cannot make for the operator: a pattern that does not compile is
  // skipped in silence at launch, so it must not be savable from here.
  if (patternError.value) {
    // Points at the line that already carries the message rather than repeating it: the two
    // sit two hundred pixels apart in the same modal, and the same sentence twice reads as two
    // separate problems.
    formError.value = 'Патерн не компілюється — під полем перевірки написано, чому.';
    return;
  }
  if (!SKILL_NAME_RE.test(draft.target)) {
    formError.value = draft.action === 'agent' ? 'Вибери агента.' : 'Вибери скіл.';
    return;
  }
  saving.value = true;
  try {
    await upsertTrigger(auth.client, {
      projectId,
      id: draft.id,
      label: draft.label,
      // Carried through the editor rather than defaulted: `upsertTrigger` applies
      // `enabled ?? true`, so omitting it would silently switch a disabled trigger back on
      // the first time someone fixed a typo in its pattern.
      enabled: draft.enabled,
      source: draft.source,
      pattern: draft.pattern,
      pathGlobs: draft.source === 'tool' ? parseGlobs(globs.value) : [],
      action: draft.action,
      target: draft.target,
      mode: draft.mode,
      repeat: draft.repeat,
    });
    if (projectId !== props.projectId) return;
    editorOpen.value = false;
    await load();
  } catch (e) {
    if (projectId !== props.projectId) return;
    formError.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

function parseGlobs(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((g) => g.trim())
    .filter(Boolean);
}

// The switch on the row. A disabled trigger keeps its row — it is still the operator's rule,
// and materializeTriggers simply stops writing a file for it — so this is an upsert of the
// same row with one bit flipped, never a delete.
async function toggle(t: ProjectTrigger): Promise<void> {
  const projectId = props.projectId;
  error.value = '';
  busy.value = true;
  try {
    await upsertTrigger(auth.client, { ...t, enabled: !t.enabled });
    if (projectId !== props.projectId) return;
    await load();
  } catch (e) {
    if (projectId !== props.projectId) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

// `deleteTrigger` throws when it removed nothing — an RLS refusal on a DELETE reports no error
// otherwise. Nothing is dropped locally: the reload is what the screen reflects.
async function drop(id: string): Promise<void> {
  const projectId = props.projectId;
  error.value = '';
  busy.value = true;
  try {
    await deleteTrigger(auth.client, projectId, id);
    if (projectId !== props.projectId) return;
    await load();
  } catch (e) {
    if (projectId !== props.projectId) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped lang="scss">
.tg__lead { font-size: 13px; color: var(--k-muted); margin-bottom: 12px; }
.tg__lead-project { color: var(--k-text); }
/* Same treatment as the assignment board's four sentences: a short numbered procedure, not a
   paragraph of small print, because the operator has to act on the distinction it draws. */
.tg__how { margin: 0 0 12px; padding-left: 20px; font-size: 12.5px; line-height: 1.6; color: var(--k-muted); }
.tg__list { list-style: none; margin: 0 0 12px; padding: 0; display: grid; gap: 8px; }
.tg__row { padding: 10px 12px; background: var(--k-surface); border: 1px solid var(--k-line); border-radius: var(--k-r); }
/* A switched-off trigger: dashed and dimmed, the same vocabulary the library pane uses for a
   default a project turned off. The row is still the operator's rule — it just fires nothing. */
.tg__row--off { border-style: dashed; background: transparent; }
.tg__row--off .tg__name, .tg__row--off .tg__pattern, .tg__row--off .tg__does { color: var(--k-muted); }
.tg__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tg__name { font-size: 12.5px; }
.tg__id { font-size: 11px; color: var(--k-faint); }
.tg__badge { font-size: 10.5px; padding: 1px 6px; border: 1px solid var(--k-line-strong); border-radius: var(--k-r); color: var(--k-muted); white-space: nowrap; }
/* The one badge that is a warning: this mode throws away a partial answer. */
.tg__badge--hard { color: var(--k-danger); border-color: var(--k-danger); }
/* The pattern gets the verbatim treatment an instruction template gets in the catalogue: it is
   matched character for character, so it is shown character for character. */
.tg__pattern {
  margin: 6px 0 0;
  padding: 4px 8px;
  font-size: 11.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--k-surface2);
  border-radius: var(--k-r);
}
.tg__globs { margin: 4px 0 0; font-size: 11px; color: var(--k-muted); overflow-wrap: anywhere; }
.tg__does { margin: 6px 0 0; font-size: 12px; }
.tg__warn { margin: 6px 0 0; font-size: 11.5px; color: var(--k-danger); }
.tg__actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.tg__btn { font: inherit; font-size: 12px; padding: 3px 10px; background: transparent; color: var(--k-text); border: 1px solid var(--k-line-strong); border-radius: var(--k-r); cursor: pointer; }
.tg__btn:disabled { opacity: 0.45; cursor: default; }
.tg__btn--primary { border-color: var(--k-accent); color: var(--k-accent); }
/* «Видалити» and «Редагувати» sit against the right edge so they line up in one column
   whatever the checkbox label did, mirroring the board's «Прибрати». */
.tg__actions .tg__btn:nth-last-child(2) { margin-left: auto; }
.tg__empty { font-size: 12px; color: var(--k-muted); margin-bottom: 12px; }
.tg__error { font-size: 11.5px; color: var(--k-accent); overflow-wrap: anywhere; }
.tg__form { display: grid; gap: 12px; text-align: left; }
.tg__note { margin: -6px 0 0; font-size: 11.5px; line-height: 1.5; color: var(--k-muted); }
/* A hit and a miss are both ordinary answers, so only the hit takes the accent — it is the one
   that says «this would fire». Neither is an error; the error line above is. */
.tg__hit { margin: -6px 0 0; font-size: 11.5px; color: var(--k-accent); }
.tg__miss { margin: -6px 0 0; font-size: 11.5px; color: var(--k-muted); }
</style>
