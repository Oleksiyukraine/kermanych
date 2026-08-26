<template>
  <main class="callback">
    <section class="callback__card">
      <h1 class="callback__brand">KERMANYCH</h1>
      <p class="callback__status" role="status">Входимо…</p>
      <p class="callback__hint">Завершуємо вхід через GitHub. Це займе мить.</p>
    </section>
  </main>
</template>

<script setup lang="ts">
// Where the OAuth redirect lands. It deliberately does nothing: the Supabase
// client finishes the code exchange on its own (detectSessionInUrl in the
// browser, exchangeCodeForSession in the Electron renderer), and the `auth.user`
// watcher in router/index.ts replaces this route with the workspace the moment
// the session exists. A second sign-in button here would race that exchange.
</script>

<style scoped lang="scss">
.callback {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--k-canvas);
  padding: 24px;
}

.callback__card {
  width: 100%;
  max-width: 380px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 32px;
  background: var(--k-surface);
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
}

.callback__brand {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: 22px;
  font-weight: 800;
  letter-spacing: 0.14em;
  color: var(--k-text);
}

.callback__status {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: 15px;
  font-weight: 600;
  color: var(--k-text);
}

.callback__hint {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: 13px;
  line-height: 1.6;
  color: var(--k-muted);
}
</style>
