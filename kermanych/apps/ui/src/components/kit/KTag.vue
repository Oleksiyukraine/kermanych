<template>
  <span class="k-tag" :class="{ 'k-tag--plain': plain }">
    <slot />
  </span>
</template>

<script setup lang="ts">
// Metadata tag: branches, model names, status words. Mono, muted, radius 0.
// `plain` drops the border/background for inline status words (e.g. "done").
withDefaults(defineProps<{ plain?: boolean }>(), { plain: false });
</script>

<style scoped lang="scss">
.k-tag {
  display: inline-flex;
  align-items: center;
  font-family: var(--k-font-mono);
  font-size: 11px;
  font-weight: 400;
  line-height: 1;
  color: var(--k-muted);
  background: var(--k-surface2);
  border: 1px solid var(--k-line);
  padding: 3px 7px;
  border-radius: 0;
  white-space: nowrap;
}

.k-tag--plain {
  background: transparent;
  border-color: transparent;
  padding: 0;
  font-size: 13px;
  font-weight: 500;
}
</style>
