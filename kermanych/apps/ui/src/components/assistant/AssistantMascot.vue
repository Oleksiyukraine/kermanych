<template>
  <!-- The assistant's character (docs/specs/2026-11-03-assistant-overlay.md, decision 1), one of
       ten the operator picks in Settings → «Загальне» (docs/specs/2026-11-03-assistant-mascot-
       choice.md). Every face sits in the right half and looks right, into the app, because the
       launcher hides the left 46 %. Drawn, not assets, so they scale without files. Gradient and
       clip ids come from useId(): the picker renders all ten beside the launcher's. -->
  <svg
    class="mascot"
    :class="{ 'mascot--busy': busy }"
    viewBox="0 0 100 100"
    aria-hidden="true"
  >
    <!-- «Бот із шевронами»: the terminal bot wearing the drop's eyes and the logo's bar. -->
    <template v-if="variant === 'bot-eyes'">
      <defs>
        <radialGradient :id="`${uid}-eye`" cx="40%" cy="30%" r="80%">
          <stop offset="0" stop-color="#fff" />
          <stop offset=".7" stop-color="#f1efec" />
          <stop offset="1" stop-color="#cfcac4" />
        </radialGradient>
      </defs>
      <g class="mascot__body">
        <line x1="70" y1="17" x2="70" y2="7" stroke="#3a3834" stroke-width="3" stroke-linecap="round" />
        <circle class="mascot__signal" cx="70" cy="6" r="4.2" fill="#ff563c" />
        <rect x="9" y="16" width="83" height="76" rx="18" fill="#34322e" />
        <rect x="9" y="16" width="83" height="76" rx="18" fill="none" stroke="#fff" stroke-opacity=".12" stroke-width="1.2" />
        <rect x="16.5" y="23.5" width="68" height="61" rx="11" fill="#0b0a09" />
        <g class="mascot__eyes">
          <ellipse cx="57" cy="46" rx="8.6" ry="11.2" :fill="`url(#${uid}-eye)`" />
          <ellipse cx="75" cy="46" rx="7.4" ry="10" :fill="`url(#${uid}-eye)`" />
          <g class="mascot__pupils mascot__chevrons">
            <path d="M56 41.2 L60.6 46 L56 50.8" stroke-width="3.6" />
            <path d="M74.4 41.8 L78.6 46 L74.4 50.2" stroke-width="3.3" />
          </g>
        </g>
        <rect class="mascot__mouth" x="60" y="65" width="14" height="4.4" rx="1" fill="#f3f2f2" />
      </g>
    </template>

    <!-- «Термінал-бот»: monitor head, block-cursor eyes, an accent mouth, a light on the antenna. -->
    <template v-else-if="variant === 'bot'">
      <g class="mascot__body">
        <line x1="70" y1="17" x2="70" y2="7" stroke="#3a3834" stroke-width="3" stroke-linecap="round" />
        <circle class="mascot__signal" cx="70" cy="6" r="4.2" fill="#ff563c" />
        <rect x="9" y="16" width="83" height="76" rx="18" fill="#34322e" />
        <rect x="9" y="16" width="83" height="76" rx="18" fill="none" stroke="#fff" stroke-opacity=".12" stroke-width="1.2" />
        <rect x="16.5" y="23.5" width="68" height="61" rx="11" fill="#0b0a09" />
        <g class="mascot__eyes">
          <g class="mascot__pupils">
            <rect x="56" y="38" width="8" height="13" rx="1.6" fill="#f3f2f2" />
            <rect x="71" y="38" width="8" height="13" rx="1.6" fill="#f3f2f2" />
          </g>
        </g>
        <rect class="mascot__mouth" x="58" y="63" width="18" height="5" rx="1" fill="#ff563c" />
      </g>
    </template>

    <!-- «Логотип»: the logo tile come alive — its chevron a winking eye, its bar the mouth. -->
    <template v-else-if="variant === 'tile'">
      <g class="mascot__body">
        <rect x="9" y="9" width="82" height="82" rx="17" fill="#12110f" stroke="#fff" stroke-opacity=".14" stroke-width="1.2" />
        <g class="mascot__nudge">
          <path :d="LOGO_CHEVRON" fill="#ff563c" transform="translate(45.5 29) scale(.034) translate(-244 -214)" />
        </g>
        <circle class="mascot__eyes" cx="76" cy="39" r="6.2" fill="#f3f2f2" />
        <rect class="mascot__mouth" x="58" y="61" width="23" height="6.5" fill="#f3f2f2" />
      </g>
    </template>

    <!-- «Великі очі»: a flat squircle, big eyes, an accent cursor for a mouth. -->
    <template v-else-if="variant === 'eyes'">
      <defs>
        <clipPath :id="`${uid}-clip`"><path :d="SQUIRCLE" /></clipPath>
      </defs>
      <g class="mascot__body">
        <path :d="SQUIRCLE" fill="#151412" />
        <g :clip-path="`url(#${uid}-clip)`"><circle cx="60" cy="38" r="52" fill="#23211f" /></g>
        <path :d="SQUIRCLE" fill="none" stroke="#fff" stroke-opacity=".14" stroke-width="1.2" />
        <g class="mascot__eyes">
          <circle cx="57" cy="44" r="9.4" fill="#f3f2f2" />
          <circle cx="78" cy="44" r="8.6" fill="#f3f2f2" />
          <g class="mascot__pupils">
            <circle cx="60.4" cy="45" r="4.8" fill="#12110f" />
            <circle cx="81.2" cy="45" r="4.4" fill="#12110f" />
            <circle cx="62" cy="43" r="1.5" fill="#fff" />
            <circle cx="82.7" cy="43" r="1.4" fill="#fff" />
          </g>
        </g>
        <rect class="mascot__mouth" x="61" y="63" width="15" height="4.8" rx="1" fill="#ff563c" />
      </g>
    </template>

    <!-- «Капітан»: a керманич holds the helm — a peaked cap, the chevron as its badge. -->
    <template v-else-if="variant === 'captain'">
      <g class="mascot__body">
        <circle cx="50" cy="56" r="36" fill="#1c1b19" stroke="#fff" stroke-opacity=".14" stroke-width="1.2" />
        <g class="mascot__eyes">
          <ellipse cx="60" cy="53" rx="6.4" ry="7.6" fill="#f3f2f2" />
          <ellipse cx="78" cy="53" rx="5.6" ry="7" fill="#f3f2f2" />
          <g class="mascot__pupils">
            <circle cx="62.2" cy="54" r="3.2" fill="#12110f" />
            <circle cx="80" cy="54" r="2.9" fill="#12110f" />
          </g>
        </g>
        <rect class="mascot__mouth" x="63" y="70" width="14" height="4.6" rx="1" fill="#f3f2f2" />
        <!-- The crown is outlined so it does not melt into the light theme's canvas. -->
        <path d="M22 30 C19 17 33 8 53 8 C73 8 85 15 82 30 Z" fill="#f3f2f2" stroke="#12110f" stroke-opacity=".35" stroke-width="1.2" />
        <rect x="22" y="25" width="60" height="7" fill="#ff563c" />
        <path d="M50 31 L85 31 C92 31 95 34 92 36.5 C82 39.5 62 39 50 35.5 Z" fill="#0b0a09" stroke="#fff" stroke-opacity=".18" stroke-width="1" />
        <path :d="LOGO_CHEVRON" fill="#12110f" transform="translate(61.5 12) scale(.017) translate(-244 -214)" />
      </g>
    </template>

    <!-- «Іскра»: the character in the accent, a dark face, flat two-tone shading. -->
    <template v-else-if="variant === 'spark'">
      <defs>
        <clipPath :id="`${uid}-clip`"><path :d="SPARK" /></clipPath>
      </defs>
      <g class="mascot__body">
        <path :d="SPARK" fill="#d9432b" />
        <g :clip-path="`url(#${uid}-clip)`"><circle cx="64" cy="46" r="45" fill="#ff563c" /></g>
        <ellipse cx="57" cy="62.5" rx="4" ry="2.2" fill="#ff9a86" opacity=".8" />
        <ellipse cx="85" cy="62.5" rx="3.4" ry="2" fill="#ff9a86" opacity=".8" />
        <g class="mascot__eyes">
          <g class="mascot__pupils">
            <ellipse cx="64" cy="50" rx="4.8" ry="6.2" fill="#12110f" />
            <ellipse cx="80" cy="50" rx="4.4" ry="5.8" fill="#12110f" />
            <circle cx="65.7" cy="47.4" r="1.6" fill="#fff" />
            <circle cx="81.6" cy="47.6" r="1.5" fill="#fff" />
          </g>
        </g>
        <rect class="mascot__mouth" x="65" y="63" width="13" height="4.4" rx="1" fill="#12110f" />
      </g>
    </template>

    <!-- «Ковбой»: a round head under a wide-brimmed hat, a neckerchief in the accent. -->
    <template v-else-if="variant === 'cowboy'">
      <g class="mascot__body">
        <circle cx="50" cy="60" r="32" fill="#1c1b19" stroke="#fff" stroke-opacity=".14" stroke-width="1.2" />
        <g class="mascot__eyes">
          <ellipse cx="60" cy="58" rx="6" ry="7.2" fill="#f3f2f2" />
          <ellipse cx="77" cy="58" rx="5.3" ry="6.6" fill="#f3f2f2" />
          <g class="mascot__pupils">
            <circle cx="62.2" cy="59" r="3" fill="#12110f" />
            <circle cx="79" cy="59" r="2.7" fill="#12110f" />
          </g>
        </g>
        <rect class="mascot__mouth" x="62" y="73" width="13" height="4.4" rx="1" fill="#f3f2f2" />
        <path d="M30 84 Q52 95 76 83 L60 99 Z" fill="#ff563c" />
        <!-- The hat is outlined so it does not melt into the light theme's canvas. -->
        <path
          d="M28 38 C26 24 30 11 40 11 C45 11 47 16 50 16 C53 16 55 11 60 11 C70 11 74 24 72 38 Z"
          fill="#7a5232"
          stroke="#12110f"
          stroke-opacity=".35"
          stroke-width="1.2"
        />
        <path d="M27.6 31 C42 28.5 58 28.5 72.4 31 L72.3 36 C58 33.5 42 33.5 27.7 36 Z" fill="#3a2616" />
        <path
          d="M3 28 C9 36 28 39 50 39 C72 39 91 36 97 28 C95 40 76 46 50 46 C24 46 5 40 3 28 Z"
          fill="#8f6440"
          stroke="#12110f"
          stroke-opacity=".35"
          stroke-width="1.2"
        />
      </g>
    </template>

    <!-- «Козак»: a shaven head with an оселедець in the accent and a drooping moustache. -->
    <template v-else-if="variant === 'cossack'">
      <g class="mascot__body">
        <circle cx="50" cy="56" r="34" fill="#1c1b19" stroke="#fff" stroke-opacity=".14" stroke-width="1.2" />
        <path d="M46 24 C44 12 58 6 70 9 C81 12 89 23 86 40 C83 28 77 20 68 19 C60 18 55 20 54 24 Z" fill="#ff563c" />
        <g class="mascot__eyes">
          <ellipse cx="59" cy="48" rx="6" ry="7.2" fill="#f3f2f2" />
          <ellipse cx="77" cy="48" rx="5.3" ry="6.6" fill="#f3f2f2" />
          <g class="mascot__pupils">
            <circle cx="61.2" cy="49" r="3" fill="#12110f" />
            <circle cx="79" cy="49" r="2.7" fill="#12110f" />
          </g>
        </g>
        <path
          d="M68 60 C61 58 54 61 52 68 C51 72 51 76 53 81 C55 74 59 67 68 65 C77 67 81 74 83 81 C85 76 85 72 84 68 C82 61 75 58 68 60 Z"
          fill="#f3f2f2"
          stroke="#12110f"
          stroke-opacity=".35"
          stroke-width="1"
        />
        <rect class="mascot__mouth" x="63.5" y="70" width="9" height="3.8" rx="1" fill="#ff563c" />
      </g>
    </template>

    <!-- «Дарт Вейдер»: a glossy black helmet turned to the right, dark lenses, an accent grille. -->
    <template v-else-if="variant === 'vader'">
      <defs>
        <radialGradient :id="`${uid}-helmet`" cx="38%" cy="22%" r="85%">
          <stop offset="0" stop-color="#4a4642" />
          <stop offset=".4" stop-color="#1c1a18" />
          <stop offset="1" stop-color="#050404" />
        </radialGradient>
      </defs>
      <g class="mascot__body">
        <path
          d="M12 52 C12 26 30 9 52 9 C74 9 91 26 91 52 L91 62 L97 85 C90 91 80 92 72 90 L36 90 C24 92 12 91 5 85 L12 62 Z"
          :fill="`url(#${uid}-helmet)`"
          stroke="#fff"
          stroke-opacity=".14"
          stroke-width="1.2"
        />
        <ellipse cx="40" cy="21" rx="15" ry="5.5" fill="#fff" opacity=".18" />
        <path d="M47 41 C58 37 80 37 91 41 L89 72 L80 89 L58 89 L49 72 Z" fill="#3a3834" />
        <g class="mascot__eyes">
          <path d="M52 44 L66 46.5 L65 55 L55 54 Z" fill="#0b0a09" />
          <path d="M72 46.5 L87 44 L84 54 L73.5 55 Z" fill="#0b0a09" />
          <g class="mascot__pupils">
            <circle cx="62" cy="48.5" r="1.5" fill="#fff" opacity=".7" />
            <circle cx="82.5" cy="48" r="1.4" fill="#fff" opacity=".7" />
          </g>
        </g>
        <path d="M69.5 54 L69.5 65 M60 62 L54 72 M79 62 L85 72" stroke="#12110f" stroke-width="1.6" stroke-linecap="round" />
        <g class="mascot__mouth">
          <path d="M60 68 L79 68 L69.5 84 Z" fill="#0b0a09" />
          <path d="M65 71 L65 76 M69.5 71 L69.5 80 M74 71 L74 76" stroke="#ff563c" stroke-width="1.6" stroke-linecap="round" />
        </g>
      </g>
    </template>

    <!-- «Крапля», the first character: a glossy graphite drop lit warm from below by the accent. -->
    <template v-else>
      <defs>
        <radialGradient :id="`${uid}-body`" cx="36%" cy="26%" r="82%">
          <stop offset="0" stop-color="#55504b" />
          <stop offset=".38" stop-color="#26231f" />
          <stop offset=".8" stop-color="#0d0c0b" />
          <stop offset="1" stop-color="#050404" />
        </radialGradient>
        <radialGradient :id="`${uid}-bounce`" cx="62%" cy="96%" r="55%">
          <stop offset="0" stop-color="#ff563c" stop-opacity=".45" />
          <stop offset=".6" stop-color="#ff563c" stop-opacity=".07" />
          <stop offset="1" stop-color="#ff563c" stop-opacity="0" />
        </radialGradient>
        <linearGradient :id="`${uid}-shine`" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#fff" stop-opacity=".55" />
          <stop offset="1" stop-color="#fff" stop-opacity="0" />
        </linearGradient>
        <radialGradient :id="`${uid}-glow`" cx="50%" cy="50%" r="50%">
          <stop offset=".55" stop-color="#ff563c" stop-opacity=".3" />
          <stop offset="1" stop-color="#ff563c" stop-opacity="0" />
        </radialGradient>
        <radialGradient :id="`${uid}-eye`" cx="40%" cy="30%" r="80%">
          <stop offset="0" stop-color="#fff" />
          <stop offset=".7" stop-color="#f1efec" />
          <stop offset="1" stop-color="#cfcac4" />
        </radialGradient>
        <clipPath :id="`${uid}-clip`"><path :d="DROP" /></clipPath>
      </defs>
      <circle cx="50" cy="50" r="50" :fill="`url(#${uid}-glow)`" />
      <g class="mascot__body">
        <path :d="DROP" :fill="`url(#${uid}-body)`" />
        <g :clip-path="`url(#${uid}-clip)`">
          <path :d="DROP" :fill="`url(#${uid}-bounce)`" />
          <path :d="DROP" fill="none" stroke="#fff" stroke-opacity=".1" stroke-width="1.2" />
        </g>
        <ellipse cx="38" cy="23" rx="18" ry="7" :fill="`url(#${uid}-shine)`" />
        <ellipse cx="29" cy="30" rx="3" ry="2" fill="#fff" opacity=".5" />
        <g class="mascot__eyes">
          <ellipse cx="57" cy="45" rx="8.6" ry="11.2" :fill="`url(#${uid}-eye)`" />
          <ellipse cx="75" cy="45" rx="7.4" ry="10" :fill="`url(#${uid}-eye)`" />
          <g class="mascot__pupils mascot__chevrons">
            <path d="M56 40.2 L60.6 45 L56 49.8" stroke-width="3.6" />
            <path d="M74.4 40.8 L78.6 45 L74.4 49.2" stroke-width="3.3" />
          </g>
        </g>
        <rect class="mascot__mouth" x="61" y="62" width="13" height="4" rx="2" fill="#f3f2f2" />
      </g>
    </template>
  </svg>
</template>

<script setup lang="ts">
import { useId } from 'vue';
import type { AssistantMascotId } from 'stores/assistant-overlay';

defineProps<{ busy: boolean; variant: AssistantMascotId }>();

const uid = `k-mascot-${useId()}`;

// The logo's chevron verbatim (MainLayout.vue, a 1024 box); each use places it with
// translate(x y) scale(s) translate(-244 -214), so (x, y) is its top-left corner.
const LOGO_CHEVRON = 'M244 214 L344 214 L642 512 L344 810 L244 810 L244 730 L462 512 L244 294 Z';
// A slightly squared drop: rounder than the logo's tile, less perfect than a circle.
const DROP = 'M50 9 C74 9 91 25 91 50 C91 75 74 92 50 92 C26 92 9 75 9 50 C9 25 26 9 50 9 Z';
const SQUIRCLE = 'M50 8 C79 8 92 21 92 50 C92 79 79 92 50 92 C21 92 8 79 8 50 C8 21 21 8 50 8 Z';
// A drop leaning forward, its tip trailing back to the top left.
const SPARK = 'M20 10 C46 13 92 26 92 58 C92 79 76 92 56 92 C35 92 17 78 17 57 C17 40 21 26 20 10 Z';
</script>

<style scoped lang="scss">
.mascot {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.mascot__chevrons {
  fill: none;
  stroke: #ff563c;
  stroke-linecap: round;
  stroke-linejoin: round;
}

// Transforms on SVG parts scale around their own box, not the viewBox origin. A part placed by
// a transform attribute (the logo chevron) is wrapped in a group instead: a CSS transform would
// replace the attribute.
.mascot__eyes,
.mascot__pupils,
.mascot__mouth,
.mascot__body,
.mascot__nudge,
.mascot__signal {
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

// Thinking: the body breathes, the pupils read up-and-back, the mouth blinks like a cursor, the
// bots' antenna light flickers and the tile's chevron nudges forward like a prompt.
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

  .mascot__signal {
    animation: mascot-cursor 0.7s steps(1, end) infinite;
  }

  .mascot__nudge {
    animation: mascot-nudge 0.9s ease-in-out infinite;
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

@keyframes mascot-nudge {
  0%,
  100% {
    transform: translateX(0);
  }
  50% {
    transform: translateX(2.5px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .mascot__eyes,
  .mascot--busy .mascot__body,
  .mascot--busy .mascot__pupils,
  .mascot--busy .mascot__mouth,
  .mascot--busy .mascot__signal,
  .mascot--busy .mascot__nudge {
    animation: none;
  }
}
</style>
