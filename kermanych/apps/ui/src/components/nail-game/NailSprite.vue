<template>
  <!-- One nail of «Гвіздки» (docs/specs/2026-11-18-nail-hammer-minigame.md, decision 2), drawn
       into the engine's NAIL_W × NAIL_H box. It sinks a step per hit, a bent one straightens as
       it goes, and the eyes follow the hammer. -->
  <svg
    class="nail"
    :class="{
      'nail--bent': nail.kind === 'bent',
      'nail--struck': struck,
      'nail--driven': nail.doneAt !== null,
      'nail--escaped': nail.escapedAt !== null,
    }"
    :viewBox="`0 0 ${NAIL_W} ${NAIL_H}`"
    :width="NAIL_W"
    :height="NAIL_H"
    :data-nail="nail.id"
    aria-hidden="true"
  >
    <defs>
      <linearGradient :id="`nail-head-${nail.id}`" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#e3e8ee" />
        <stop offset="1" stop-color="#7e8896" />
      </linearGradient>
    </defs>
    <ellipse class="nail__hole" :cx="MID" :cy="GROUND" rx="13" ry="4" />
    <g class="nail__body">
      <path class="nail__shaft" :d="shaft" />
      <g :transform="`rotate(${tilt} ${headX} ${headY})`">
        <rect
          class="nail__head"
          :x="headX - HEAD_W / 2"
          :y="headY - HEAD_H / 2"
          :width="HEAD_W"
          :height="HEAD_H"
          rx="6"
          :fill="`url(#nail-head-${nail.id})`"
        />
        <template v-if="nail.doneAt !== null">
          <!-- Driven: happy closed eyes. -->
          <path class="nail__lid" :d="`M${headX - 10} ${headY + 1} q3 -4 6 0`" />
          <path class="nail__lid" :d="`M${headX + 4} ${headY + 1} q3 -4 6 0`" />
        </template>
        <template v-else-if="struck">
          <!-- Just hit: squeezed shut, > < -->
          <path class="nail__lid" :d="`M${headX - 10} ${headY - 3} l5 3 l-5 3`" />
          <path class="nail__lid" :d="`M${headX + 10} ${headY - 3} l-5 3 l5 3`" />
        </template>
        <template v-else>
          <circle class="nail__eye" :cx="headX - 7" :cy="headY" r="4.4" />
          <circle class="nail__eye" :cx="headX + 7" :cy="headY" r="4.4" />
          <circle class="nail__pupil" :cx="headX - 7 + look.x * 1.9" :cy="headY + look.y * 1.9" r="2.1" />
          <circle class="nail__pupil" :cx="headX + 7 + look.x * 1.9" :cy="headY + look.y * 1.9" r="2.1" />
        </template>
      </g>
    </g>
    <text v-if="nail.doneAt !== null" class="nail__points" :x="MID" :y="headY - 14">+{{ nail.points }}</text>
    <!-- The target: generous, the whole nail and a margin, so a swing at the head counts. -->
    <rect class="nail__hit" x="4" :y="headY - HEAD_H" :width="NAIL_W - 8" :height="GROUND - headY + HEAD_H + 6" />
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NAIL_H, NAIL_W, type Nail } from '../../lib/nail-game';

const props = defineProps<{
  nail: Nail;
  /** Round time, ms: drives the «just hit» squint. */
  now: number;
  /** Where the hammer is, as a unit vector from the nail's head. */
  look: { x: number; y: number };
}>();

const MID = NAIL_W / 2;
const GROUND = NAIL_H - 6;
const SHAFT_MAX = 58;
const HEAD_W = 34;
const HEAD_H = 15;
const STRUCK_MS = 130;

// 0 standing tall … 1 driven flush.
const sunk = computed(() => props.nail.hits / props.nail.needed);
const shaftLength = computed(() => SHAFT_MAX * (1 - sunk.value));
// A bent nail leans its top this far sideways, less with every hit.
const bend = computed(() => props.nail.lean * 13 * (1 - sunk.value));
const headX = computed(() => MID + bend.value);
const headY = computed(() => GROUND - shaftLength.value - HEAD_H / 2);
const tilt = computed(() => props.nail.lean * 20 * (1 - sunk.value));
const shaft = computed(() => {
  const top = GROUND - shaftLength.value;
  return `M${MID} ${GROUND} L${MID} ${GROUND - shaftLength.value * 0.5} L${headX.value} ${top}`;
});
const struck = computed(
  () => props.nail.doneAt === null && props.nail.lastHitAt !== null && props.now - props.nail.lastHitAt < STRUCK_MS,
);
</script>

<style scoped lang="scss">
.nail {
  position: absolute;
  overflow: visible;
  pointer-events: none;
  animation: nail-pop 0.18s ease-out;
}

.nail__body {
  transform-box: fill-box;
  transform-origin: 50% 100%;
  transition: transform 0.09s ease-out;
}

.nail--struck .nail__body {
  transform: scaleY(0.9);
}

.nail__hole {
  // A faint rim, so the hole reads on the dark theme too.
  stroke: rgba(255, 255, 255, 0.12);
  stroke-width: 1;
  fill: rgba(0, 0, 0, 0.45);
}

.nail__shaft {
  fill: none;
  stroke: #9aa4b1;
  stroke-width: 6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.nail--bent .nail__shaft {
  stroke: #b0835e;
}

.nail__head {
  stroke: #4c5561;
  stroke-width: 1.2;
}

.nail__eye {
  fill: #fff;
  stroke: #2a2f36;
  stroke-width: 0.8;
}

.nail__pupil {
  fill: #1b1f24;
}

.nail__lid {
  fill: none;
  stroke: #1b1f24;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.nail__points {
  fill: var(--k-accent, #f5a524);
  font: 700 16px/1 var(--k-font-mono, monospace);
  text-anchor: middle;
  animation: nail-points 0.45s ease-out forwards;
}

.nail__hit {
  fill: transparent;
  pointer-events: all;
}

.nail--driven,
.nail--escaped {
  .nail__hit {
    pointer-events: none;
  }
}

.nail--driven .nail__body {
  animation: nail-fade 0.45s ease-in forwards;
}

// An escaped nail ducks back into its hole.
.nail--escaped {
  animation: nail-hide 0.3s ease-in forwards;
}

@keyframes nail-pop {
  from {
    transform: translateY(14px) scaleY(0.6);
    opacity: 0;
  }
}

@keyframes nail-hide {
  to {
    transform: translateY(18px) scaleY(0.4);
    opacity: 0;
  }
}

@keyframes nail-fade {
  60% {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}

@keyframes nail-points {
  to {
    transform: translateY(-16px);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .nail,
  .nail--escaped,
  .nail__points {
    animation-duration: 0.01s;
  }
}
</style>
