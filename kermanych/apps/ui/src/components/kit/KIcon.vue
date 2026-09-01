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
//
// The second group (home…integrations) marks the Менеджмент section rail, where the label
// IS visible: there the mark is not the meaning but the anchor — six two-line rows of the
// same weight are scanned by shape, and «Release Notes» vs «Risk Registry» at a glance is
// exactly what the eye was failing at.
export type KIconName =
  | 'activity'
  | 'tasks'
  | 'archive'
  | 'history'
  | 'home'
  | 'storage'
  | 'risks'
  | 'releases'
  | 'capacity'
  | 'integrations';
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

  // Home — a house. The section is the workspace's front page, and the roof/door pair is
  // the one mark no other row in this rail could be mistaken for.
  home: ['M3 10.5 12 3l9 7.5', 'M5 9.75V20.25h14V9.75', 'M9.75 20.25V14h4.5v6.25'],
  // Storage — stacked cylinders. A folder would have collided with the file-shaped Release
  // Notes mark below; the drum stack says «where things are kept», not «a document».
  storage: [
    'M3 5.5a9 3 0 1 0 18 0a9 3 0 1 0-18 0',
    'M3 5.5v13c0 1.66 4.03 3 9 3s9-1.34 9-3v-13',
    'M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3',
  ],
  // Risk Registry — the warning triangle. The only mark here that carries urgency, which is
  // the register's whole subject; the bar and dot survive at 18px where a thinner ! would not.
  risks: [
    'M10.29 4.36 2.4 18.05A2 2 0 0 0 4.13 21h15.74a2 2 0 0 0 1.73-2.95L13.71 4.36a2 2 0 0 0-3.42 0z',
    'M12 9.5v4.5',
    'M12 17.5h.01',
  ],
  // Release Notes — a written page. Read as «notes» rather than as a version tag on purpose:
  // a tag glyph at this size reads as «label», and labels are not what the section holds.
  releases: ['M14.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5z', 'M14.5 3v4.5H19', 'M9 13.5h6', 'M9 17h4'],
  // Team Capacity — a gauge. The hint is «навантаження команди»: a load, i.e. a reading
  // against a limit, which a group-of-people mark would have said nothing about.
  capacity: ['M3.34 19a10 10 0 1 1 17.32 0', 'm12 14 4.5-4.5'],
  // Integrations — a plug. The section is nothing but connections to Linear, Jira and Slack,
  // and «plug it in» is the one action every tile on that screen offers. The two prongs are
  // what keep it from reading as the page-shaped Release Notes mark two rows above.
  // Wider and shorter than Lucide's stock plug (which is 12×20 in this box): beside five
  // marks that are 14–20 wide it read as the one undersized glyph in the column.
  integrations: [
    'M12 21.5v-4',
    'M8.75 8.5V3',
    'M15.25 8.5V3',
    'M18.5 8.5v4.5a4.5 4.5 0 0 1-4.5 4.5h-4a4.5 4.5 0 0 1-4.5-4.5V8.5z',
  ],
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
