<template>
  <span class="k-spinner" :style="{ width: `${size}px`, height: `${size}px` }" aria-hidden="true" />
</template>

<script setup lang="ts">
// The one busy glyph of the kit: a ring in the current text colour with a gap, turning. Every
// control's `loading` state (KBtn, KIconButton, KSelect, KChipSelect, KCheckbox, KToggle) and
// the pending marks (session / kanban cards, the «надсилаю…» bubble) draw this, so «busy» looks
// the same everywhere. Decorative: the host carries `aria-busy`. Static under reduced motion.
withDefaults(defineProps<{ size?: number }>(), { size: 12 });
</script>

<style scoped lang="scss">
.k-spinner {
  display: inline-block;
  flex: none;
  box-sizing: border-box;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: k-spinner-turn 0.6s linear infinite;
}

@keyframes k-spinner-turn {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .k-spinner {
    animation: none;
  }
}
</style>
