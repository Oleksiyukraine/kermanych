<template>
  <!-- A hammer of «Гвіздки»: the player's cursor, or an AI opponent's hand
       (docs/specs/2026-11-19-nail-game-ai-opponents.md, decision 6). (x, y) is the striking
       face; the hammer is held by the end of its handle and swings down onto that point. -->
  <div class="nh" :style="{ transform: `translate(${x - HOT_X}px, ${y - HOT_Y}px)` }" aria-hidden="true">
    <svg class="nh__art" :class="{ 'nh__art--down': down }" width="72" height="40" viewBox="0 0 72 40">
      <defs>
        <linearGradient id="nh-head" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#eef1f5" />
          <stop offset="1" stop-color="#7b8592" />
        </linearGradient>
      </defs>
      <rect x="19" y="11" width="52" height="9" rx="4" fill="#a8743f" stroke="#6e4a25" stroke-width="1.2" />
      <rect x="54" y="10.5" width="17" height="10" rx="4.5" :fill="color ?? '#5b3b1d'" />
      <rect x="1" y="1" width="21" height="30" rx="3" fill="url(#nh-head)" stroke="#424a55" stroke-width="1.2" />
      <rect x="1" y="26" width="21" height="5" rx="1.5" fill="#59626e" />
    </svg>
    <span v-if="label" class="nh__tag mono" :style="{ background: color }">{{ label }}</span>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  x: number;
  y: number;
  /** On its way down or just landed: the head is on the striking point. */
  down: boolean;
  /** An opponent's colour (the grip and the name tag). */
  color?: string | undefined;
  label?: string | undefined;
}>();

// The striking face in the 72 × 40 art: the bottom middle of the head. It sits on (x, y) when
// the hammer is down.
const HOT_X = 11;
const HOT_Y = 31;
</script>

<style scoped lang="scss">
.nh {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  will-change: transform;
  filter: drop-shadow(0 4px 6px rgba(0, 0, 0, 0.35));
}

// Held by the end of the handle (66, 15). At rest the head is raised — turned clockwise, so it
// points up and away from the nail — and a swing brings it down flat onto the striking point:
// fast on the way down, slower back up.
.nh__art {
  display: block;
  overflow: visible;
  transform-origin: 66px 15px;
  transform: rotate(34deg);
  transition: transform 0.14s ease-out;
}

.nh__art--down {
  transform: rotate(0deg);
  transition: transform 0.045s ease-in;
}

.nh__tag {
  position: absolute;
  top: 40px;
  left: 30px;
  padding: 1px 6px;
  border-radius: 6px;
  color: #fff;
  font-size: 10.5px;
  line-height: 16px;
  white-space: nowrap;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
}
</style>
