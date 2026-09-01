<template>
  <div v-if="open" class="k-hp">
    <!-- Click-away. `mousedown` rather than `click` so the panel closes before the textarea
         underneath can take the caret, and `.prevent` so focus never leaves on the way out. -->
    <div class="k-hp__scrim" @mousedown.prevent="emit('close')"></div>
    <div class="k-hp__panel" role="dialog" aria-label="Хелпери">
      <input
        ref="filterEl"
        v-model="query"
        class="k-hp__filter mono"
        type="text"
        placeholder="фільтр…"
        aria-label="Фільтр хелперів"
        @keydown="onKeydown"
      />
      <ul v-if="shown.length" class="k-hp__list" role="listbox">
        <li v-for="(h, i) in shown" :key="h.name">
          <button
            type="button"
            class="k-hp__item"
            :class="{ 'k-hp__item--on': i === active }"
            role="option"
            :aria-selected="i === active"
            @mousemove="active = i"
            @click="pick(h.name)"
          >
            <span class="k-hp__head">
              <span class="k-hp__label">{{ h.label }}</span>
              <span class="k-hp__name mono">/{{ h.name }}</span>
            </span>
            <span class="k-hp__hint">{{ h.hint }}</span>
          </button>
        </li>
      </ul>
      <p v-else class="k-hp__empty mono">нічого не знайшлось</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { DEFAULT_HELPERS } from '@kermanych/core';

// The Хелпери panel: an emoji-picker-shaped list of the app's command-instructions, anchored
// above whichever composer opened it. The host owns the draft, so this component only ever
// says WHICH helper was picked — `prependHelper` in core decides where the token lands.
//
// The panel keeps its own filter input and owns the keyboard while open. That is what makes it
// safe to mount inside a composer whose Enter already sends: the keystrokes land here, not on
// the textarea, and Enter never reaches the form.
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ select: [name: string]; close: [] }>();

const query = ref('');
const active = ref(0);
const filterEl = ref<HTMLInputElement | null>(null);

// A leading slash is how the operator thinks of a helper and how the picker opens, so it is
// stripped rather than matched against — otherwise typing `/el` would find nothing.
const shown = computed(() => {
  const q = query.value.trim().replace(/^\/+/, '').toLowerCase();
  if (!q) return DEFAULT_HELPERS;
  return DEFAULT_HELPERS.filter(
    (h) =>
      h.name.includes(q) || h.label.toLowerCase().includes(q) || h.hint.toLowerCase().includes(q),
  );
});

// Opening is the reset: a panel that reopened on last time's filter would hide the list the
// operator came for.
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    query.value = '';
    active.value = 0;
    void nextTick(() => filterEl.value?.focus());
  },
);
// Typing narrows the list under the cursor, so the highlight has to come back into range.
watch(shown, (list) => {
  if (active.value >= list.length) active.value = 0;
});

function pick(name: string): void {
  emit('select', name);
  emit('close');
}

function onKeydown(e: KeyboardEvent): void {
  const last = shown.value.length - 1;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    active.value = active.value >= last ? 0 : active.value + 1;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    active.value = active.value <= 0 ? last : active.value - 1;
  } else if (e.key === 'Enter' && !e.isComposing) {
    // Also the reason this panel lives OUTSIDE the composer's <form>: an un-prevented Enter in
    // a text input submits the form it sits in, which here means sending the message.
    e.preventDefault();
    const hit = shown.value[active.value];
    if (hit) pick(hit.name);
  } else if (e.key === 'Escape' || e.key === 'Tab') {
    e.preventDefault();
    emit('close');
  }
}
</script>

<style scoped lang="scss">
.k-hp {
  position: absolute;
  bottom: calc(100% - var(--k-sp-2));
  left: var(--k-sp-3);
  z-index: 20;
}

.k-hp__scrim {
  position: fixed;
  inset: 0;
}

.k-hp__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 320px;
  max-height: 320px;
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  background: var(--k-surface);
  box-shadow: 0 8px 24px rgb(0 0 0 / 28%);
  overflow: hidden;
}

.k-hp__filter {
  flex: none;
  padding: var(--k-sp-2) var(--k-sp-3);
  border: none;
  border-bottom: 1px solid var(--k-line);
  background: transparent;
  color: var(--k-text);
  font-size: var(--k-fs-sm);
  outline: none;

  &::placeholder {
    color: var(--k-muted);
  }
}

.k-hp__list {
  flex: 1 1 auto;
  margin: 0;
  padding: var(--k-sp-1);
  list-style: none;
  overflow-y: auto;
}

.k-hp__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: var(--k-sp-2);
  border: none;
  border-radius: var(--k-r);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

// Pointer and keyboard share ONE highlight: `@mousemove` moves the same index the arrows do,
// so the list never shows two candidates at once.
.k-hp__item--on {
  background: var(--k-bg);
}

.k-hp__head {
  display: flex;
  align-items: baseline;
  gap: var(--k-sp-2);
}

.k-hp__label {
  color: var(--k-text);
  font-size: var(--k-fs-sm);
}

.k-hp__name {
  color: var(--k-accent);
  font-size: var(--k-fs-xs);
}

.k-hp__hint {
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
  line-height: 1.4;
}

.k-hp__empty {
  padding: var(--k-sp-3);
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
}
</style>
