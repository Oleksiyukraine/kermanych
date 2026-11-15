<template>
  <router-view />
  <!-- Root-level, not in MainLayout: the version gate must also cover the sign-in screen. -->
  <AppUnsupported />
  <AppWhatsNew />
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import AppUnsupported from 'components/AppUnsupported.vue';
import AppWhatsNew from 'components/AppWhatsNew.vue';
import { useAppUpdate } from 'stores/app-update';
import { closeSplash } from 'boot/splash';

const upd = useAppUpdate();
onMounted(() => void upd.init());

// The start-up splash (boot/splash.ts) covers the boot files; the app is mounted after they and
// the first navigation finish, so the splash leaves from here.
onMounted(() => void closeSplash());
</script>
