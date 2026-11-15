<template>
  <AuthLoader v-if="busy" />
  <main v-else class="login">
    <section class="login__card">
      <h1 class="login__brand">KERMANYCH</h1>
      <p class="login__hint">
        {{ t('common.login.hint') }}
      </p>
      <KBtn variant="primary" @click="signIn">
        {{ t('common.login.signIn') }}
      </KBtn>
      <p v-if="error" class="login__error" role="alert">{{ error }}</p>
    </section>
  </main>
</template>

<script setup lang="ts">
// The only screen reachable without a Supabase session. GitHub OAuth is the sole
// provider: in the browser this redirects away and comes back signed in; in
// Electron the store routes through the loopback bridge instead.
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuth } from 'stores/auth';
import KBtn from 'components/kit/KBtn.vue';
import AuthLoader from 'components/auth/AuthLoader.vue';

const auth = useAuth();
const busy = ref(false);
const error = ref<string | null>(null);
const { t } = useI18n();

// The whole wait is AuthLoader: in the browser until the page navigates away to GitHub, in
// Electron until the session exists. Success leaves `busy` up — the `auth.user` watcher in
// router/index.ts moves off /login only after the store adopted the session, and dropping
// the loader on the exchange alone flashed this card in between. A failure (the 120 s
// loopback timeout included) brings the card back with the error.
async function signIn(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await auth.signInWithGithub();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    busy.value = false;
  }
}
</script>

<style scoped lang="scss">
.login {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--k-canvas);
  padding: 24px;
}

.login__card {
  width: 100%;
  max-width: 380px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 32px;
  background: var(--k-surface);
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
}

.login__brand {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: 22px;
  font-weight: 800;
  letter-spacing: 0.14em;
  color: var(--k-text);
}

.login__hint {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: 13px;
  line-height: 1.6;
  color: var(--k-muted);
}

.login__error {
  margin: 0;
  font-family: var(--k-font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--k-accent);
}
</style>
