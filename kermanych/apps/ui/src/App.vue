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

const upd = useAppUpdate();
onMounted(() => void upd.init());
</script>
