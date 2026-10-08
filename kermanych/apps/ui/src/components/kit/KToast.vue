<template>
  <div class="k-toasts" :style="placement" aria-live="polite">
    <div
      v-for="t in toasts"
      :key="t.id"
      class="k-toast"
      :class="`k-toast--${t.kind}`"
      :role="t.kind === 'error' ? 'alert' : 'status'"
      @click="emit('dismiss', t.id)"
    >
      {{ t.message }}
    </div>
  </div>
</template>

<script setup lang="ts">
// Transient notification stack (bottom-right). Presentational for the queue: the store owns
// it and the auto-dismiss; here we render it and emit a dismiss on click.
//
// The one thing it reads on its own is where the session browser's view is shown
// (stores/browser.ts `shownRect`): that view is a native layer painted above the whole DOM, so
// a toast under it would be invisible. With a view on screen the stack moves beside it — to
// its right when the strip there holds a toast, else to its left, else above it — instead of
// parking the page for every message (composables/useOverlayOpen.ts).
import { computed, onBeforeUnmount, onMounted, ref, type CSSProperties } from 'vue';
import type { Toast } from 'stores/orchestrator';
import { useSessionBrowser } from 'stores/browser';

defineProps<{ toasts: Toast[] }>();
const emit = defineEmits<{ dismiss: [id: string] }>();

// The stack's own geometry (see the styles): 20px from the window edge, toasts 240–360px wide.
const EDGE = 20;
const TOAST_MIN = 240;
const TOAST_MAX = 360;
// The least room above the view a stack of one or two toasts needs.
const ABOVE_MIN = 120;

const browser = useSessionBrowser();
const win = ref({ width: window.innerWidth, height: window.innerHeight });
function onResize(): void {
  win.value = { width: window.innerWidth, height: window.innerHeight };
}
onMounted(() => window.addEventListener('resize', onResize));
onBeforeUnmount(() => window.removeEventListener('resize', onResize));

const placement = computed<CSSProperties | undefined>(() => {
  const r = browser.shownRect;
  if (!r) return undefined;
  const { width, height } = win.value;
  if (width - (r.x + r.width) >= TOAST_MAX + 2 * EDGE) return undefined;
  if (r.x >= TOAST_MIN + 2 * EDGE) return { right: `${width - r.x + EDGE}px`, maxWidth: `${r.x - 2 * EDGE}px` };
  if (r.y >= ABOVE_MIN) return { bottom: `${height - r.y + EDGE}px` };
  return undefined;
});
</script>

<style scoped lang="scss">
.k-toasts {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 7000; // above QDialog overlays
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}

.k-toast {
  pointer-events: auto;
  min-width: 240px; // TOAST_MIN
  max-width: 360px; // TOAST_MAX
  padding: 12px 14px;
  background: var(--k-surface2);
  border: 1px solid var(--k-line-strong);
  border-left-width: 3px;
  border-radius: var(--k-r-lg);
  color: var(--k-text);
  font-family: var(--k-font-ui);
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
  box-shadow: var(--k-shadow-toast);
}

// error — accent rail; info — neutral rail.
.k-toast--error {
  border-left-color: var(--k-accent);
}

.k-toast--info {
  border-left-color: var(--k-line-strong);
}
</style>
