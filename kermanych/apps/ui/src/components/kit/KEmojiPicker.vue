<template>
  <div class="k-emoji">
    <span v-if="label" class="k-emoji__label">{{ label }}</span>

    <!-- The current marker, always in view: the chosen emoji, or the colour dot the
         workspace falls back to when none is set. It doubles as the «clear» control — the
         dot option below is the same affordance, kept here so the selection is legible even
         when the active category does not contain it. -->
    <div class="k-emoji__current">
      <span class="k-emoji__preview" aria-hidden="true">
        <span v-if="modelValue">{{ modelValue }}</span>
        <span v-else class="k-emoji__dot"></span>
      </span>
      <button
        type="button"
        class="k-emoji__clear"
        :class="{ 'k-emoji__clear--active': !modelValue }"
        v-tip="t('kit.emojiPicker.default')"
        :aria-label="t('kit.emojiPicker.default')"
        :aria-pressed="!modelValue"
        @click="emit('update:modelValue', '')"
      >{{ t('kit.emojiPicker.defaultLabel') }}</button>
    </div>

    <!-- iOS-shaped category tabs. The glyph is the tab's own label (aria carries the name),
         so a voice-control user speaks what they see. -->
    <div class="k-emoji__tabs" role="tablist">
      <button
        v-for="(c, i) in EMOJI_CATEGORIES"
        :key="c.key"
        type="button"
        role="tab"
        class="k-emoji__tab"
        :class="{ 'k-emoji__tab--active': i === active }"
        :aria-selected="i === active"
        v-tip="categoryName(c.key)"
        :aria-label="categoryName(c.key)"
        @click="active = i"
      >{{ c.tab }}</button>
    </div>

    <div class="k-emoji__grid" role="listbox" :aria-label="categoryName(current.key)">
      <button
        v-for="e in current.emojis"
        :key="e"
        type="button"
        role="option"
        class="k-emoji__cell"
        :class="{ 'k-emoji__cell--active': e === modelValue }"
        :aria-label="e"
        :aria-selected="e === modelValue"
        @click="emit('update:modelValue', e)"
      >{{ e }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { EMOJI_CATEGORIES } from '../../lib/emoji';

// The workspace icon picker: a curated, iOS-shaped emoji set laid out as category tabs +
// a scrollable grid, plus a «dot» default that clears the value back to the colour dot.
// Stores a single emoji string; '' means «use the colour dot». Inline like KColorPicker
// rather than a popover — one fewer floating layer to trap focus in the settings pane.
defineProps<{ label?: string; modelValue?: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const { t } = useI18n();

const active = ref(0);
const current = computed(() => EMOJI_CATEGORIES[active.value] ?? EMOJI_CATEGORIES[0]!);

// The category label is a translated string keyed by the stable `key`; the raw key is
// never shown.
function categoryName(key: string): string {
  return t(`kit.emojiPicker.category.${key}`);
}
</script>

<style scoped lang="scss">
.k-emoji {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-family: var(--k-font-ui);
}

.k-emoji__label {
  text-align: left;
  font-size: 13px;
  font-weight: 400;
  color: var(--k-text);
}

.k-emoji__current {
  display: flex;
  align-items: center;
  gap: 8px;
}

// Same 26px box the colour swatches use, so this control lines up with KColorPicker above
// it in the settings form.
.k-emoji__preview {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  font-size: 18px;
  line-height: 1;
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r-sm);
}

// The fallback the sidebar draws when no emoji is set — the neutral dot, at the size the
// row shows it.
.k-emoji__dot {
  width: 8px;
  height: 8px;
  border-radius: var(--k-r-pill);
  background: var(--k-line-strong);
}

.k-emoji__clear {
  padding: 4px 10px;
  background: none;
  border: 1px solid var(--k-line-strong);
  color: var(--k-muted);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  border-radius: var(--k-r-sm);
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

.k-emoji__clear--active {
  color: var(--k-text);
  border-color: var(--k-text);
}

.k-emoji__tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}

.k-emoji__tab {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 28px;
  padding: 0;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  border-radius: var(--k-r-sm);
  opacity: 0.55;
  transition: opacity 0.12s, background 0.12s;

  &:hover {
    opacity: 1;
    background: var(--k-surface);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

.k-emoji__tab--active {
  opacity: 1;
  background: var(--k-surface2);
}

// A fixed-height scroller: the curated set is long, and a settings form must not grow by
// two hundred rows. The grid auto-fills 30px cells, so it reflows to the pane's width.
.k-emoji__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, 30px);
  gap: 2px;
  max-height: 180px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-sm);
  background: var(--k-canvas);
}

.k-emoji__cell {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  border-radius: var(--k-r-sm);
  transition: background 0.12s;

  &:hover {
    background: var(--k-surface);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: -1px;
  }
}

.k-emoji__cell--active {
  background: var(--k-surface2);
  box-shadow: inset 0 0 0 1px var(--k-text);
}
</style>
