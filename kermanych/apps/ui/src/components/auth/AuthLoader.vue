<template>
  <main class="auth-loader" aria-busy="true">
    <!-- The word gathers from a scatter, holds, and flies apart again for as long as the sign-in
         runs. Reduced motion shows it assembled and still. -->
    <svg
      class="auth-loader__word"
      :viewBox="`0 0 ${word.width} ${word.height}`"
      aria-hidden="true"
    >
      <rect
        v-for="(p, i) in word.pixels"
        :key="i"
        :class="['auth-loader__px', `auth-loader__px--${p.kind}`]"
        :x="p.x + 1"
        :y="p.y + 1"
        :width="PIXEL_CELL - 2"
        :height="PIXEL_CELL - 2"
        rx="1.5"
        :style="{ '--dx': p.dx, '--dy': p.dy, '--r': p.r }"
      />
    </svg>
    <figure class="auth-loader__quote">
      <blockquote>{{ t(`common.login.quotes.${quote}.text`) }}</blockquote>
      <figcaption>— {{ t(`common.login.quotes.${quote}.author`) }}</figcaption>
    </figure>
    <p class="auth-loader__status" role="status">{{ t('common.login.signingIn') }}</p>
  </main>
</template>

<script setup lang="ts">
// The sign-in wait: from the «Увійти через GitHub» press until the session exists (LoginPage),
// and the OAuth redirect landing on /auth/callback (AuthCallbackPage). The word is the landing
// page's coda, КЕРМАНИЧ gathered from pixels (lib/pixel-word.ts). It stays at least
// SIGN_IN_LOADER_MIN_MS (lib/sign-in-loader.ts): the router holds the redirect until then.
import { onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { PIXEL_CELL, pixelWord } from '../../lib/pixel-word';
import { SIGN_IN_QUOTES, markSignInLoader } from '../../lib/sign-in-loader';

const { t } = useI18n();
const word = pixelWord('КЕРМАНИЧ');
// One quote per showing: it does not change while the loader is on screen.
const quote = SIGN_IN_QUOTES[Math.floor(Math.random() * SIGN_IN_QUOTES.length)];

onMounted(() => markSignInLoader(performance.now()));
onUnmounted(() => markSignInLoader(null));
</script>

<style scoped lang="scss">
.auth-loader {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 40px;
  padding: 24px;
  background: var(--k-canvas);
}

.auth-loader__word {
  display: block;
  width: min(560px, 100%);
  height: auto;
  overflow: visible;
}

// One cycle: scattered → gathered (40%) → held → scattered again. Each rect flies from its own
// --dx/--dy/--r, so one keyframe list moves the whole picture.
.auth-loader__px {
  fill: var(--k-text);
  transform-box: fill-box;
  transform-origin: center;
  animation: auth-loader-gather 3.6s cubic-bezier(0.22, 1, 0.36, 1) infinite;
}

.auth-loader__px--accent {
  fill: var(--k-accent);
}

.auth-loader__px--noise {
  fill: var(--k-faint);
  opacity: 0;
  animation-name: auth-loader-noise;
}

@keyframes auth-loader-gather {
  0%,
  100% {
    transform: translate(calc(var(--dx) * 1px), calc(var(--dy) * 1px)) rotate(calc(var(--r) * 1deg));
    opacity: 0.3;
  }
  40%,
  78% {
    transform: none;
    opacity: 1;
  }
}

@keyframes auth-loader-noise {
  0%,
  100% {
    transform: translate(calc(var(--dx) * 1px), calc(var(--dy) * 1px)) rotate(calc(var(--r) * 1deg));
    opacity: 0.7;
  }
  40%,
  78% {
    transform: none;
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .auth-loader__px {
    animation: none;
  }
}

.auth-loader__quote {
  width: min(560px, 100%);
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;

  blockquote {
    margin: 0;
    font-family: var(--k-font-ui);
    font-size: 20px;
    font-weight: 500;
    line-height: 1.4;
    color: var(--k-text);
  }

  figcaption {
    align-self: flex-end;
    font-family: var(--k-font-mono);
    font-size: 12px;
    color: var(--k-muted);
  }
}

// The animation is the visible feedback; the status line is for screen readers.
.auth-loader__status {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
