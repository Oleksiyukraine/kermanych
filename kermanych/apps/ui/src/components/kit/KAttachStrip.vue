<template>
  <div v-if="images.length" class="k-attach">
    <div v-for="(img, i) in images" :key="i" class="k-attach__item">
      <img :src="img.url" :alt="img.name" class="k-attach__thumb" />
      <button
        type="button"
        class="k-attach__remove"
        v-tip="'Прибрати'"
        aria-label="Прибрати"
        @click="emit('remove', i)"
      >✕</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { AttachedImage } from '../../lib/images';

// Thumbnail strip for pending image attachments (composer + launcher). Each tile
// shows the image with a corner ✕ to drop it before sending.
defineProps<{ images: AttachedImage[] }>();
const emit = defineEmits<{ remove: [index: number] }>();
</script>

<style scoped lang="scss">
.k-attach {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.k-attach__item {
  position: relative;
  width: 56px;
  height: 56px;
  border: 1px solid var(--k-line-strong);
  background: var(--k-surface);
}

.k-attach__thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.k-attach__remove {
  position: absolute;
  top: -7px;
  right: -7px;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--k-line-strong);
  background: var(--k-bg);
  color: var(--k-text);
  font-size: 9px;
  line-height: 1;
  cursor: pointer;
  border-radius: 0;

  &:hover {
    border-color: var(--k-accent);
    color: var(--k-accent);
  }
}
</style>
