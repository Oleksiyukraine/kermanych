<template>
  <main class="not-found">
    <div class="code mono">404</div>
    <p>{{ t('common.notFound.message') }}</p>
    <router-link to="/">{{ t('common.notFound.home') }}</router-link>
  </main>
</template>

<script setup lang="ts">
// Placeholder 404 page.
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
</script>

<style scoped lang="scss">
.not-found {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;

  .code {
    font-size: 20vh;
    color: var(--k-accent);
  }

  a {
    color: var(--k-accent);
  }
}
</style>
