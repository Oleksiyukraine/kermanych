<template>
  <KModal
    :model-value="!!req"
    :title="req?.title ?? ''"
    @update:model-value="(open: boolean) => { if (!open) answer(false); }"
  >
    <p class="k-confirm__message">{{ req?.message }}</p>
    <template #controls>
      <KBtn ref="cancelBtn" variant="ghost" @click="answer(false)">{{ t('kit.confirm.cancel') }}</KBtn>
      <KBtn variant="primary" class="k-confirm__go" @click="answer(true)">{{ req?.confirmLabel }}</KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// The dialog behind lib/confirm.ts `confirmAction` — mounted once, in MainLayout. A KModal, so
// Esc and a click outside answer «no», and (being role="dialog") it parks the session
// browser's native view while it is open. Focus lands on «Скасувати»: an Enter pressed out of
// habit must not destroy anything; the destructive button is the one you reach for.
import { nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { confirmOpen } from '../../lib/confirm';
import KBtn from './KBtn.vue';
import KModal from './KModal.vue';

const { t } = useI18n();

const req = confirmOpen;
const cancelBtn = ref<{ $el: HTMLElement } | null>(null);

function answer(ok: boolean): void {
  req.value?.resolve(ok);
}

watch(req, (r) => {
  if (r) void nextTick(() => cancelBtn.value?.$el.focus());
});
</script>

<style scoped lang="scss">
.k-confirm__message {
  margin: 0;
  white-space: pre-line;
}
// The primary button in the danger colour: this one destroys something.
.k-confirm__go {
  background: var(--k-danger);
  border-color: var(--k-danger);
  color: #fff;
}
</style>
