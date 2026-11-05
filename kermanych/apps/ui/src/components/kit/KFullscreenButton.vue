<template>
  <KIconButton
    :title="on ? (exitTitle ?? t('kit.fileView.minimize')) : (enterTitle ?? t('kit.fileView.maximize'))"
    :aria-pressed="on"
  >
    <KIcon class="k-fullscreen-btn__icon" :name="on ? 'fullscreenExit' : 'fullscreen'" />
  </KIconButton>
</template>

<script setup lang="ts">
// The one full-screen control: expand while `on` is false, collapse while it is true. A
// KIconButton underneath, so `@click`, `active` and `class` fall through to it unchanged.
// Drawn arrows rather than the ⤢ ⤡ glyphs this replaced: those come from whatever font
// has them and sat off the button's centre line at 16px.
//
// The default tooltips name a viewer («Full screen» / «Collapse to panel»); a caller whose
// surface is not a panel (a dialog, a page) passes its own pair.
import { useI18n } from 'vue-i18n';
import KIcon from './KIcon.vue';
import KIconButton from './KIconButton.vue';

defineProps<{
  on: boolean;
  enterTitle?: string;
  exitTitle?: string;
}>();

const { t } = useI18n();
</script>

<style scoped lang="scss">
.k-fullscreen-btn__icon {
  --k-icon-size: var(--k-icon-md);
}
</style>
