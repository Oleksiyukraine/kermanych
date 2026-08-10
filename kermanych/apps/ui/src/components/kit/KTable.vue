<script lang="ts">
// Column definition for KTable. `key` names both the data field (for the
// default text cell) and the `#cell-<key>` slot; computed columns (no matching
// data field) just supply a slot and render nothing by default.
export interface KTableColumn {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  width?: string;
  mono?: boolean;
}
</script>

<script setup lang="ts" generic="T">
// Modernist data table (design-system: radius 0, hairline rules, mono header,
// single accent for the selected row). Presentational only — cells are driven
// by `#cell-<key>` scoped slots ({ row, value }); the fallback renders the raw
// field as text. Row state (e.g. "running") rides in via `rowClass`.
const props = withDefaults(
  defineProps<{
    columns: KTableColumn[];
    rows: T[];
    rowKey: (row: T) => string;
    selectedKey?: string | undefined;
    clickable?: boolean;
    rowClass?: (row: T) => string | string[] | Record<string, boolean> | undefined;
  }>(),
  { clickable: false },
);

const emit = defineEmits<{ 'row-click': [row: T] }>();

function cellValue(row: T, key: string): unknown {
  return (row as Record<string, unknown>)[key];
}

function onRowClick(row: T): void {
  if (props.clickable) emit('row-click', row);
}
</script>

<template>
  <table class="k-table">
    <thead>
      <tr>
        <th
          v-for="col in columns"
          :key="col.key"
          scope="col"
          class="k-table__th"
          :class="`k-table__cell--${col.align ?? 'left'}`"
          :style="col.width ? { width: col.width } : undefined"
        >
          {{ col.label }}
        </th>
      </tr>
    </thead>
    <tbody>
      <tr
        v-for="row in rows"
        :key="rowKey(row)"
        class="k-table__row"
        :class="[
          rowClass?.(row),
          {
            'k-table__row--active': selectedKey != null && rowKey(row) === selectedKey,
            'k-table__row--clickable': clickable,
          },
        ]"
        :role="clickable ? 'button' : undefined"
        :tabindex="clickable ? 0 : undefined"
        @click="onRowClick(row)"
        @keydown.enter="onRowClick(row)"
      >
        <td
          v-for="col in columns"
          :key="col.key"
          class="k-table__td"
          :class="[`k-table__cell--${col.align ?? 'left'}`, { mono: col.mono }]"
        >
          <slot :name="`cell-${col.key}`" :row="row" :value="cellValue(row, col.key)">
            {{ cellValue(row, col.key) ?? '—' }}
          </slot>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped lang="scss">
.k-table {
  width: 100%;
  border-collapse: collapse;
  border: 1px solid var(--k-line);
  background: var(--k-surface);
  font-family: var(--k-font-ui);
}

.k-table__th {
  padding: 9px 12px;
  font-family: var(--k-font-mono);
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--k-muted);
  background: var(--k-bg);
  border-bottom: 1px solid var(--k-line-strong);
  white-space: nowrap;
}

.k-table__td {
  padding: 11px 12px;
  font-size: 13px;
  color: var(--k-text);
  border-bottom: 1px solid var(--k-line);
  vertical-align: middle;
}

.k-table__row:last-child .k-table__td {
  border-bottom: none;
}

.k-table__row--clickable {
  cursor: pointer;
  transition: background 0.12s;

  &:hover {
    background: var(--k-surface2);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: -1px;
  }
}

// selected — surface2 fill + a 1px accent frame, matching the session card.
.k-table__row--active {
  background: var(--k-surface2);
  box-shadow: inset 0 0 0 1px var(--k-accent);
}

// alignment — flush-left by default.
.k-table__cell--left {
  text-align: left;
}

.k-table__cell--right {
  text-align: right;
}

.k-table__cell--center {
  text-align: center;
}

.mono {
  font-family: var(--k-font-mono);
}
</style>
