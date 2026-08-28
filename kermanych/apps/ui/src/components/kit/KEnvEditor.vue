<template>
  <div class="k-env">
    <!-- The reveal switch sits above the table rather than in it: masking is a
         property of the whole column, and a per-row eye multiplied the control by
         the number of secrets. The caller states WHERE these values live (the
         pane's own blurb does it here), so this bar carries no prose. -->
    <div class="k-env__bar">
      <KBtn variant="secondary" @click="revealed = !revealed">
        {{ revealed ? 'Приховати значення' : 'Показати значення' }}
      </KBtn>
    </div>

    <p v-if="!ignored" class="k-env__warn" role="alert">
      ⚠ <span class="mono">.env</span> не в <span class="mono">.gitignore</span> — його можуть
      закомітити. Додайте <span class="mono">.env</span> до <span class="mono">.gitignore</span>.
    </p>

    <div class="k-env__table">
      <div class="k-env__head">
        <span>Ключ</span>
        <span>Значення</span>
        <!-- Header for a column of toggles, so the pill below it does not have to
             explain itself in every row. -->
        <span class="k-env__head-flag">Обов’язковий</span>
        <span></span>
      </div>

      <div v-for="(row, i) in modelValue" :key="i" class="k-env__row">
        <input
          class="k-env__cell mono"
          :value="row.key"
          placeholder="NEW_KEY"
          aria-label="Ключ"
          @input="patch(i, { key: ($event.target as HTMLInputElement).value })"
        />
        <input
          class="k-env__cell mono"
          :value="row.value"
          :type="revealed ? 'text' : 'password'"
          :placeholder="row.required && !row.value ? 'значення ще немає' : 'значення'"
          :class="{ 'k-env__cell--missing': row.required && !row.value }"
          aria-label="Значення"
          @input="patch(i, { value: ($event.target as HTMLInputElement).value })"
        />
        <!-- A TOGGLE, not a read-out. The names list is cloud config any workspace
             member may edit, and the row already names the key — so declaring it
             required belongs here rather than in a second textarea of names that
             has to be kept in step by hand.

             `flagsLocked` is the one state where it degrades to a label: a project
             with no cloud row has no shared list to declare anything in, and a
             toggle whose value can never be stored would snap back on the next
             read. Values stay editable — those are this machine's file. -->
        <button
          type="button"
          class="k-env__flag"
          :class="{ 'k-env__flag--on': row.required, 'k-env__flag--locked': flagsLocked }"
          :aria-disabled="flagsLocked"
          :aria-pressed="row.required"
          v-tip="
            flagsLocked
              ? 'Перелік обов’язкових ключів живе у хмарі'
              : row.required
                ? 'Прибрати з обов’язкових (хмара)'
                : 'Позначити обов’язковим (хмара)'
          "
          @click="flagsLocked || patch(i, { required: !row.required })"
        >{{ row.required ? '● потрібен' : '○ ні' }}</button>
        <KIconButton title="Видалити рядок" @click="remove(i)">✕</KIconButton>
      </div>

      <div v-if="!modelValue.length" class="k-env__empty">Порожньо — жодної змінної.</div>
    </div>

    <KBtn variant="secondary" @click="emit('update:modelValue', [...modelValue, BLANK])">
      Додати змінну
    </KBtn>
  </div>
</template>

<script lang="ts">
export type { EnvRow } from '../../lib/settings';
</script>

<script setup lang="ts">
import { ref } from 'vue';
import type { EnvRow } from '../../lib/settings';
import KBtn from './KBtn.vue';
import KIconButton from './KIconButton.vue';

// The bound repo's `.env`, as a table. FULLY CONTROLLED: the rows are the
// caller's state, and every edit emits a fresh array. It used to keep its own
// draft and hand it back through an imperative `collect()`, which worked for a
// modal with its own Save but cannot answer the one question the settings screen
// asks on every keystroke — «is anything unsaved?». The caller diffs the array it
// already owns instead.
//
// `required` is CLOUD config (`projects.env_keys`, names only); `value` never
// leaves this machine. The component draws both and knows about neither: the
// caller decides where each half goes.
const props = defineProps<{ modelValue: EnvRow[]; ignored: boolean; flagsLocked?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [rows: EnvRow[]] }>();

const BLANK: EnvRow = { key: '', value: '', required: false };

// Values are masked by default because this table is on a screen an operator
// leaves open, and a shoulder is cheaper than a leak. One switch for the whole
// table rather than per row: reading a `.env` is a scan down the column.
const revealed = ref(false);

function patch(i: number, change: Partial<EnvRow>): void {
  emit(
    'update:modelValue',
    props.modelValue.map((r, j) => (j === i ? { ...r, ...change } : r)),
  );
}

function remove(i: number): void {
  emit(
    'update:modelValue',
    props.modelValue.filter((_, j) => j !== i),
  );
}
</script>

<style scoped lang="scss">
.k-env {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
  align-items: flex-start;
}

// Right-aligned: the reveal switch is a view control, and parking it opposite the
// table's «Ключ» heading keeps the reading order key → value → controls.
.k-env__bar {
  display: flex;
  justify-content: flex-end;
  width: 100%;
}

.k-env__warn {
  margin: 0;
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-accent);
}

.k-env__table {
  width: 100%;
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r);
  overflow: hidden;
}

// Both the head and the rows use one grid template, so the columns line up
// without a <table> and its layout rules.
.k-env__head,
.k-env__row {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(140px, 1.6fr) auto 28px;
  align-items: center;
  gap: var(--k-sp-2);
  padding: 7px var(--k-sp-3);
}

.k-env__head {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
  background: var(--k-surface2);
  border-bottom: var(--k-rule-thin) solid var(--k-line);
}

.k-env__head-flag {
  text-align: center;
}

.k-env__row + .k-env__row {
  border-top: var(--k-rule-thin) solid var(--k-line);
}

// Borderless cells: a grid of framed inputs reads as a form, and this is a file.
// The frame appears on focus, where it says which cell is live.
.k-env__cell {
  min-width: 0;
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: transparent;
  border: var(--k-rule-thin) solid transparent;
  border-radius: var(--k-r-sm);
  padding: 5px 7px;

  &::placeholder {
    color: var(--k-faint);
  }

  &:focus {
    border-color: var(--k-accent);
    background: var(--k-surface);
  }
}

// A required key with nothing behind it is the one state that costs a failed
// launch, so it is the one state the table colours.
.k-env__cell--missing::placeholder {
  color: var(--k-accent);
}

.k-env__flag {
  justify-self: center;
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
  background: transparent;
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-pill);
  padding: 3px 9px;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.12s, border-color 0.12s;

  &:hover {
    color: var(--k-text);
    border-color: var(--k-text);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

.k-env__flag--on {
  color: var(--k-accent);
  border-color: color-mix(in srgb, var(--k-accent) 55%, transparent);
}

// Locked: still legible, no longer an affordance. `pointer-events` stays on so the
// tooltip explaining WHY can still be read — a disabled <button> dispatches no
// mouseenter, which is why the cursor is neutralised instead.
.k-env__flag--locked {
  cursor: default;
  opacity: 0.6;

  &:hover {
    color: var(--k-faint);
    border-color: var(--k-line);
  }
}

.k-env__empty {
  padding: var(--k-sp-3);
  font-size: var(--k-fs-sm);
  color: var(--k-faint);
}
</style>
