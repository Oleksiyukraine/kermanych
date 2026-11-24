<script setup lang="ts">
// Push notifications for this phone (spec decision 4): on, off, or why they cannot be.
import { computed } from "vue";
import { useAction } from "../lib/async";
import { t } from "../lib/i18n";
import { disablePush, enablePush, pushState, pushSupport } from "../lib/push";
import { state } from "../lib/store";
import KButton from "./KButton.vue";

const support = pushSupport();
const { run: enable, busy: enabling, error: enableError } = useAction(enablePush);
const { run: disable, busy: disabling, error: disableError } = useAction(disablePush);
const error = computed(() => enableError.value ?? disableError.value);
</script>

<template>
  <section class="push">
    <h2 class="push__title">{{ t("push.title") }}</h2>
    <p v-if="support === 'ios_install'" class="muted">{{ t("push.iosInstall") }}</p>
    <p v-else-if="support === 'unsupported'" class="muted">{{ t("push.unsupported") }}</p>
    <template v-else-if="pushState.subscribed">
      <p class="muted">{{ t("push.on") }}</p>
      <KButton block :loading="disabling" @click="disable()">{{ t("push.disable") }}</KButton>
    </template>
    <p v-else-if="pushState.permission === 'denied'" class="muted">{{ t("push.denied") }}</p>
    <template v-else>
      <p class="muted">{{ t("push.hint") }}</p>
      <KButton variant="primary" block :loading="enabling" :disabled="!state.me" @click="enable()">{{ t("push.enable") }}</KButton>
    </template>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.push {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-4);
  border-radius: var(--k-r-lg);
  background: var(--k-surface);
  background-image: var(--k-grad-raise);
  border: var(--k-rule-thin) solid var(--k-line);
}
.push__title {
  margin: 0;
  font-size: var(--k-fs-md);
  font-weight: var(--k-fw-semibold);
}
.push p {
  margin: 0;
  font-size: var(--k-fs-base);
}
</style>
