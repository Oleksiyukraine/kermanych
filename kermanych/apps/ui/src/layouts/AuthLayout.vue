<template>
  <div class="auth-layout">
    <LoginPage />
    <!-- KToast lives in MainLayout for the app shell; /login sits outside it and
         needs its own surface so sign-in failures are visible. -->
    <KToast :toasts="store.toasts" @dismiss="store.dismissToast" />
  </div>
</template>

<script setup lang="ts">
import { useOrchestrator } from 'stores/orchestrator';
import KToast from 'components/kit/KToast.vue';
import LoginPage from 'pages/LoginPage.vue';

// Reads the toast queue only; unlike MainLayout it never calls store.connect(),
// so no socket is opened before sign-in.
const store = useOrchestrator();
</script>

<style scoped lang="scss">
.auth-layout {
  min-height: 100vh;
  background: var(--k-canvas);
}
</style>
