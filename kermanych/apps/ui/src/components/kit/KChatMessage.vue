<template>
  <div class="k-chat-message" :class="`k-chat-message--${role}`">
    <div v-if="role === 'user'" class="k-chat-message__bubble">
      <slot />
    </div>
    <div v-else class="k-chat-message__prose k-log__markdown">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
// Chat turn. `user` = right-aligned rounded bubble; `assistant` = full-width
// plain prose that inherits the global `.k-log__markdown` styling.
withDefaults(
  defineProps<{
    role: 'user' | 'assistant';
  }>(),
  {},
);
</script>

<style scoped lang="scss">
.k-chat-message {
  display: flex;
  width: 100%;
}

.k-chat-message--user {
  justify-content: flex-end;
}

.k-chat-message--assistant {
  justify-content: flex-start;
}

.k-chat-message__bubble {
  max-width: 70%;
  padding: var(--k-sp-3);
  background: var(--k-surface2);
  border-radius: var(--k-r-lg);
  color: var(--k-text);
  font-size: var(--k-fs-base);
  line-height: 1.5;
}

.k-chat-message__prose {
  width: 100%;
  color: var(--k-text);
  font-size: var(--k-fs-base);
  line-height: 1.5;
}
</style>
