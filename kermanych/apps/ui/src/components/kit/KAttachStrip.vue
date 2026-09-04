<template>
  <div v-if="images.length" class="k-attach">
    <div v-for="(img, i) in images" :key="i" class="k-attach__item">
      <img :src="img.url" :alt="img.name" class="k-attach__thumb" />
      <button
        type="button"
        class="k-attach__remove"
        v-tip="t('kit.attachStrip.remove')"
        :aria-label="t('kit.attachStrip.remove')"
        @click="emit('remove', i)"
      >✕</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { AttachedImage } from '../../lib/images';

// Thumbnail strip for pending image attachments (composer + launcher). Each tile
// shows the image with a corner ✕ to drop it before sending.
defineProps<{ images: AttachedImage[] }>();
const emit = defineEmits<{ remove: [index: number] }>();

const { t } = useI18n();
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
  // Was 9px — the smallest mark in the app, on a control whose whole job is «remove this
  // attachment». `xs` is the scale's floor and this is what the floor is for: a 16px box,
  // too tight for `sm`, but a ✕ under 12px stops reading as a cross at all.
  font-size: var(--k-icon-xs);
  line-height: 1;
  cursor: pointer;
  border-radius: var(--k-r-sm);

  &:hover {
    border-color: var(--k-accent);
    color: var(--k-accent);
  }
}
</style>
