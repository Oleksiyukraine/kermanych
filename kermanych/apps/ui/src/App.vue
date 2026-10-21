<template>
  <router-view />
</template>

<script setup lang="ts">
import { onMounted } from 'vue';

// The start-up splash (index.html) covers the boot files; the app is mounted after they and the
// first navigation finish, so it fades out here. It is a fixed overlay outside #q-app, so its
// removal moves nothing in the layout.
onMounted(() => {
  const splash = document.getElementById('k-splash');
  if (!splash) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    splash.remove();
    return;
  }
  splash.addEventListener('transitionend', () => splash.remove(), { once: true });
  splash.classList.add('k-splash--out');
});
</script>
