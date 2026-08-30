<script lang="ts">
// A line icon, drawn rather than typed. The app writes its dense action clusters as text
// glyphs (KIconButton) because those sit BESIDE a label or a tooltip that says what they
// mean. This component exists for the one place where a mark stands alone and must carry
// the meaning by itself: the minified sidebar rail, where the bucket labels are gone.
//
// Unicode has no legible mark for «Задачі» or «Історія» — the nearest glyphs (☰, ↺) read as
// «menu» and «reload», which is exactly the misreading this replaces. Drawn paths also hold
// their weight at 18px, where a font-rendered triangle or arrow thins out.
//
// Geometry follows Lucide (ISC) so the marks are the ones users already know from other
// tools, inlined as bare path data — a handful of icons does not justify a dependency, and
// the same choice is already made for the brand mark and the integration logos.
export type KIconName = 'activity' | 'tasks' | 'archive' | 'history';
</script>

<script setup lang="ts">
// Stroke, never fill: `currentColor` then inherits the row's muted/active colour for free,
// and a 1.75 stroke matches the weight of the UI text beside it.
const ICONS: Record<KIconName, readonly string[]> = {
  // Активні — a live pulse. Says «something is running», which is what the bucket holds:
  // working agents plus the ones that stopped to ask.
  activity: ['M3 12h3.5l2.5-6.5 4.5 13L16 12h5'],
  // Задачі — a checklist: queued work, not yet started. Two ticks and two lines read as a
  // list at 18px, where three rows would smear.
  tasks: ['M3 7.5l2 2 4-4', 'M13 8h8', 'M3 16.5l2 2 4-4', 'M13 17h8'],
  // Відкладені — an archive box with its lid. Deliberately the only rectangular mark of the
  // four, so «put aside» cannot be confused with the round clock-like one.
  archive: ['M3 4h18v5H3z', 'M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9', 'M10 13.5h4'],
  // Історія — a clock wound backwards. The standard mark for «what already happened»; the
  // hands are what separate it from a plain reload arrow.
  history: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5', 'M12 7.5v5l4 2'],
};

const props = defineProps<{ name: KIconName }>();
</script>

<template>
  <svg
    class="k-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="d in ICONS[props.name]" :key="d" :d="d" />
  </svg>
</template>

<style scoped lang="scss">
// Sized by a token with a fallback rather than by `1em`: these marks sit next to 13px UI
// text where a font-relative icon would come out at 13px and read as a smudge. Callers that
// need another size set `--k-icon-size` on the host.
.k-icon {
  display: block;
  flex: none;
  width: var(--k-icon-size, 18px);
  height: var(--k-icon-size, 18px);
}
</style>
