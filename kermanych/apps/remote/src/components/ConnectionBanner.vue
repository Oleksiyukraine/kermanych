<script setup lang="ts">
// The computer's reachability under the screen's top bar (spec → Risks: «the phone shows
// «Комп'ютер недоступний»»; settled: signed out on the computer → refused, phone stays paired).
// «Недоступний» waits a moment before it shows: a socket blip that heals in a second is not news.
import { computed } from "vue";
import { useAction, useDelayedTrue } from "../lib/async";
import { t } from "../lib/i18n";
import { retry, state } from "../lib/store";
import KButton from "./KButton.vue";

const offline = useDelayedTrue(() => state.link === "offline", 1_500);
const { run: retryNow, busy: retrying } = useAction(retry);

const banner = computed(() => {
  if (state.link === "signed_out") return { title: t("banner.signedOut"), hint: t("banner.signedOutHint"), retry: false };
  if (state.link === "foreign_login") return { title: t("banner.foreignLogin"), hint: t("banner.foreignLoginHint"), retry: true };
  if (offline.value) return { title: t("banner.offline"), hint: t("banner.offlineHint"), retry: true };
  return null;
});
</script>

<template>
  <div v-if="banner" class="banner pad-x" role="status">
    <div class="banner__text">
      <strong>{{ banner.title }}</strong>
      <span class="banner__hint">{{ banner.hint }}</span>
    </div>
    <KButton v-if="banner.retry" :loading="retrying" @click="retryNow()">{{ t("banner.retry") }}</KButton>
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  align-items: center;
  gap: var(--k-sp-3);
  padding-top: var(--k-sp-3);
  padding-bottom: var(--k-sp-3);
  background: color-mix(in srgb, var(--k-warning) 14%, var(--k-bg));
  border-bottom: var(--k-rule-thin) solid var(--k-line);
}
.banner__text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.banner__hint {
  color: var(--k-muted);
  font-size: var(--k-fs-base);
}
</style>
