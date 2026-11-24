<script setup lang="ts">
// «Пульт»'s shell: pairing without a key (or on a `#pair=` link), else the list or one session.
import { watch } from "vue";
import ListScreen from "./components/ListScreen.vue";
import PairScreen from "./components/PairScreen.vue";
import SessionScreen from "./components/SessionScreen.vue";
import { checkPush } from "./lib/push";
import { route } from "./lib/route";
import { state } from "./lib/store";

// Every time the phone has a key — at launch and right after pairing — its push subscription,
// if any, is handed to the computer again (lib/push.ts → checkPush).
watch(
  () => state.key,
  (key) => {
    if (key) void checkPush();
  },
  { immediate: true },
);
</script>

<template>
  <PairScreen
    v-if="route.name === 'pair' || !state.key"
    :key="route.name === 'pair' ? route.code : ''"
    :code="route.name === 'pair' ? route.code : undefined"
  />
  <SessionScreen v-else-if="route.name === 'session'" :id="route.id" :key="route.id" />
  <ListScreen v-else />
</template>
