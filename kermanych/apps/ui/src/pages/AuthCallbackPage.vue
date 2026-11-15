<template>
  <AuthLoader />
</template>

<script setup lang="ts">
// Where the OAuth redirect lands. It deliberately does nothing but show the sign-in loader: the
// Supabase client finishes the code exchange on its own (detectSessionInUrl in the browser,
// exchangeCodeForSession in the Electron renderer), and the `auth.user` watcher in
// router/index.ts replaces this route with the Агенти view the moment the session exists. A
// second sign-in button here would race that exchange.
import AuthLoader from 'components/auth/AuthLoader.vue';
</script>
