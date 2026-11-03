<template>
  <!-- The assistant's character (docs/specs/2026-11-03-assistant-overlay.md, decision 1): the
       logo's `›_` turned into a face — the chevrons are the pupils, the bar is the mouth — on a
       glossy graphite drop lit warm from below by the brand accent. Drawn, not an asset, so it
       scales and themes without a file. One instance in the app, so the gradient ids are fixed. -->
  <svg
    class="mascot"
    :class="{ 'mascot--busy': busy }"
    viewBox="0 0 100 100"
    aria-hidden="true"
  >
    <defs>
      <radialGradient id="k-mascot-body" cx="36%" cy="26%" r="82%">
        <stop offset="0" stop-color="#55504b" />
        <stop offset=".38" stop-color="#26231f" />
        <stop offset=".8" stop-color="#0d0c0b" />
        <stop offset="1" stop-color="#050404" />
      </radialGradient>
      <radialGradient id="k-mascot-bounce" cx="62%" cy="96%" r="55%">
        <stop offset="0" stop-color="#ff563c" stop-opacity=".45" />
        <stop offset=".6" stop-color="#ff563c" stop-opacity=".07" />
        <stop offset="1" stop-color="#ff563c" stop-opacity="0" />
      </radialGradient>
      <linearGradient id="k-mascot-shine" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fff" stop-opacity=".55" />
        <stop offset="1" stop-color="#fff" stop-opacity="0" />
      </linearGradient>
      <radialGradient id="k-mascot-glow" cx="50%" cy="50%" r="50%">
        <stop offset=".55" stop-color="#ff563c" stop-opacity=".3" />
        <stop offset="1" stop-color="#ff563c" stop-opacity="0" />
      </radialGradient>
      <radialGradient id="k-mascot-eye" cx="40%" cy="30%" r="80%">
        <stop offset="0" stop-color="#fff" />
        <stop offset=".7" stop-color="#f1efec" />
        <stop offset="1" stop-color="#cfcac4" />
      </radialGradient>
      <clipPath id="k-mascot-clip"><path :d="BODY" /></clipPath>
    </defs>

    <circle class="mascot__glow" cx="50" cy="50" r="50" fill="url(#k-mascot-glow)" />
    <g class="mascot__body">
      <path :d="BODY" fill="url(#k-mascot-body)" />
      <g clip-path="url(#k-mascot-clip)">
        <path :d="BODY" fill="url(#k-mascot-bounce)" />
        <path :d="BODY" fill="none" stroke="#fff" stroke-opacity=".1" stroke-width="1.2" />
      </g>
      <ellipse cx="38" cy="23" rx="18" ry="7" fill="url(#k-mascot-shine)" />
      <ellipse cx="29" cy="30" rx="3" ry="2" fill="#fff" opacity=".5" />

      <!-- Eyes look right, into the app: the nearer one larger. They blink now and then, and
           while a turn is in flight the pupils glance up-and-back as if reading. -->
      <g class="mascot__eyes">
        <ellipse cx="57" cy="45" rx="8.6" ry="11.2" fill="url(#k-mascot-eye)" />
        <ellipse cx="75" cy="45" rx="7.4" ry="10" fill="url(#k-mascot-eye)" />
        <g class="mascot__pupils">
          <path d="M56 40.2 L60.6 45 L56 49.8" class="mascot__pupil" stroke-width="3.6" />
          <path d="M74.4 40.8 L78.6 45 L74.4 49.2" class="mascot__pupil" stroke-width="3.3" />
        </g>
      </g>
      <!-- The logo's bar as the mouth — and, while the assistant thinks, a blinking cursor. -->
      <rect class="mascot__mouth" x="61" y="62" width="13" height="4" rx="2" fill="#f3f2f2" />
    </g>
  </svg>
</template>

<script setup lang="ts">
defineProps<{ busy: boolean }>();

// A slightly squared drop: rounder than the logo's tile, less perfect than a circle.
const BODY = 'M50 9 C74 9 91 25 91 50 C91 75 74 92 50 92 C26 92 9 75 9 50 C9 25 26 9 50 9 Z';
</script>

<style scoped lang="scss">
.mascot {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.mascot__pupil {
  fill: none;
  stroke: #ff563c;
  stroke-linecap: round;
  stroke-linejoin: round;
}

// Transforms on SVG parts scale around their own box, not the viewBox origin.
.mascot__eyes,
.mascot__pupils,
.mascot__mouth,
.mascot__body {
  transform-box: fill-box;
  transform-origin: center;
}

// A blink every few seconds: long open, a quick close. Off-beat from any other loop so it
// never syncs into a twitch.
.mascot__eyes {
  animation: mascot-blink 5.3s ease-in-out infinite;
}

@keyframes mascot-blink {
  0%,
  94%,
  100% {
    transform: scaleY(1);
  }
  96.5% {
    transform: scaleY(0.12);
  }
}

// Thinking: the body breathes, the pupils read up-and-back, the mouth blinks like a cursor.
.mascot--busy {
  .mascot__body {
    animation: mascot-breathe 1.8s ease-in-out infinite;
  }

  .mascot__pupils {
    animation: mascot-read 2.4s ease-in-out infinite;
  }

  .mascot__mouth {
    animation: mascot-cursor 1s steps(1, end) infinite;
  }
}

@keyframes mascot-breathe {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.035, 0.975);
  }
}

@keyframes mascot-read {
  0%,
  100% {
    transform: translate(0, 0);
  }
  30% {
    transform: translate(-1.6px, -2.2px);
  }
  60% {
    transform: translate(0.8px, -2.2px);
  }
}

@keyframes mascot-cursor {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .mascot__eyes,
  .mascot--busy .mascot__body,
  .mascot--busy .mascot__pupils,
  .mascot--busy .mascot__mouth {
    animation: none;
  }
}
</style>
