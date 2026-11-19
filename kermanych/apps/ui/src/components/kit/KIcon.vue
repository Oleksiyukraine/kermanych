<script lang="ts">
// A line icon, drawn rather than typed. The app writes its dense action clusters as text
// glyphs (KIconButton) because those sit BESIDE a label or a tooltip that says what they
// mean. This component exists for the places where a mark stands alone and must carry the
// meaning by itself: the minified sidebar rail, the header's focus toggle, the «Агенти» search.
//
// Drawn paths hold their weight at 18px, where a font-rendered triangle or arrow thins out,
// and they never fall back to a font that lacks the glyph.
//
// Geometry follows Lucide (ISC) so the marks are the ones users already know from other
// tools, inlined as bare path data — a handful of icons does not justify a dependency, and
// the same choice is already made for the brand mark and the integration logos.
//
// The second group (home…integrations) marks the Менеджмент section rail, where the label
// IS visible: there the mark is not the meaning but the anchor — seven two-line rows of the
// same weight are scanned by shape, and «Release Notes» vs «Risk Registry» at a glance is
// exactly what the eye was failing at.
//
// `worktree` is a third case and the reason to reach here rather than for a glyph in future:
// the label is right beside it, but Unicode's nearest mark (⑂) exists in no font this app
// loads, so it came out as a half-weight smudge off the row's centre line.
export type KIconName =
  | 'search'
  | 'focus'
  | 'home'
  | 'storage'
  | 'docs'
  | 'risks'
  | 'releases'
  | 'capacity'
  | 'integrations'
  | 'worktree'
  | 'plus'
  | 'analysis'
  | 'start'
  | 'minion'
  | 'decision'
  | 'notNeeded'
  | 'synergy'
  | 'viewSource'
  | 'viewSplit'
  | 'viewPreview'
  | 'viewDiff'
  | 'fullscreen'
  | 'fullscreenExit'
  | 'chevronDown'
  | 'chevronRight'
  | 'copy'
  | 'coins'
  | 'mic'
  | 'micOff'
  | 'agentPromote'
  | 'agentSynergyImplement'
  | 'agentReview'
  | 'agentPullRequest'
  | 'agentCommit'
  | 'agentResolveConflict'
  | 'agentFinish'
  | 'agentSummary'
  | 'agentTester'
  | 'clock'
  | 'feedback';
</script>

<script setup lang="ts">
// Stroke, never fill: `currentColor` then inherits the row's muted/active colour for free,
// and a 1.75 stroke matches the weight of the UI text beside it.
const ICONS: Record<KIconName, readonly string[]> = {
  // «Агенти» search — a magnifier (Lucide's search). The operator asked for exactly this mark;
  // it is the shape `analysis` borrows, and the two never share a control.
  search: ['M3 11a8 8 0 1 0 16 0a8 8 0 1 0-16 0', 'm21 21-4.3-4.3'],
  // Focus mode — four corners round a point (Lucide's focus): «frame the work», not a panel
  // glyph, which ◧ / ◨ already mean in the footer (the file-manager docks), and not the
  // arrows `fullscreen` uses for a viewer.
  focus: [
    'M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
    'M3 7V5a2 2 0 0 1 2-2h2',
    'M17 3h2a2 2 0 0 1 2 2v2',
    'M21 17v2a2 2 0 0 1-2 2h-2',
    'M7 21H5a2 2 0 0 1-2-2v-2',
  ],

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
  // Project Documentation — an open book. The two neighbouring marks are already a drum
  // stack and a single page, so the section needed a third «paper» silhouette that is
  // neither: a spread book reads as «something you read through», not as one file you open
  // or a place files are kept.
  docs: [
    'M12 7.5v13',
    'M3 18.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4a4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3a3 3 0 0 0-3-3z',
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
  // Integrations — a plug. The section is nothing but connections to Linear, Jira, Plane and Slack,
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

  // Worktree — git's branch mark: a trunk, a node budding off it, and the arc between them.
  // The composer's isolation chip had this as `⑂` (U+2442, OCR FORK), and no font in the UI
  // stack carries it — it arrived from a fallback at roughly half the ink of the mono
  // «worktree» beside it and sat off the row's centre line. This is the third KIcon case:
  // the mark is not standing alone, it is standing next to type it has to match in weight.
  worktree: [
    'M6 3v12',
    'M15 6a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
    'M3 18a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
    'M18 9a9 9 0 0 1-9 9',
  ],

  // The «Нова задача» split button's menu, where each way of starting a task is a row with a
  // mark in a disc. `plus` is the plain «create» the main button already says in words.
  plus: ['M12 5v14', 'M5 12h14'],
  // «Глибокий аналіз» — a magnifier: «look closely first». Also the mark a deep-analysis card
  // carries (KAnalysisMark), so the menu row and the card it produces share one shape.
  analysis: ['M3 11a8 8 0 1 0 16 0a8 8 0 1 0-16 0', 'm21 21-4.3-4.3'],
  // «Розпочати» / Get started — a rocket (Lucide's): the first-run checklist's row in the
  // minified rail, where the mark alone has to say what it opens. Launch is what the
  // checklist walks toward («ready to run»).
  start: [
    'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z',
    'm12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z',
    'M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0',
    'M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5',
  ],
  // «Посіпака» — a bot (Lucide's): the agent that takes cards by itself. KMinionMark carries it
  // on the cards it may take and on the sessions it runs.
  minion: [
    'M12 8V4H8',
    'M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z',
    'M2 14h2',
    'M20 14h2',
    'M15 13v2',
    'M9 13v2',
  ],
  // «Потрібне рішення» — a question in a disc (Lucide's circle-help): the run stopped on a choice
  // that is the operator's to make (KDecisionMark).
  decision: ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0', 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', 'M12 17h.01'],
  // «Не потрібно» — a slashed disc (Lucide's ban): the run found nothing to change and closed
  // the card (KNotNeededMark).
  notNeeded: ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0', 'm4.9 4.9 14.2 14.2'],
  // «Синергія» — a lightning bolt (Lucide's zap): fast prototyping on the live app
  // (docs/specs/2026-11-06-synergy.md), the «ШІ-команда» mark of its instruction.
  synergy: [
    'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z',
  ],

  // The file viewer's three modes (KViewModeToggle): source lines, source beside a page, the
  // rendered page alone. The same trio an IDE's Markdown editor shows, so it reads at a glance.
  viewSource: ['M4 6h16', 'M4 10h16', 'M4 14h16', 'M4 18h16'],
  viewSplit: [
    'M3 6h6',
    'M3 10h6',
    'M3 14h6',
    'M3 18h6',
    'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
  ],
  viewPreview: [
    'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
    'M7 9a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
    'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21',
  ],
  // KDiffView's diff on/off: Lucide's «diff», a plus over a minus.
  viewDiff: ['M12 3v14', 'M5 10h14', 'M5 21h14'],
  // KFullscreenButton: Lucide's maximize-2 / minimize-2 — arrows out to the corners, and back.
  fullscreen: ['M15 3h6v6', 'M9 21H3v-6', 'm21 3-7 7', 'm3 21 7-7'],
  fullscreenExit: ['m14 10 7-7', 'M20 10h-6V4', 'm3 21 7-7', 'M4 14h6v6'],
  // KCodeView's fold gutter: an open block points down, a folded one points at its summary.
  chevronDown: ['m6 9 6 6 6-6'],
  chevronRight: ['m9 18 6-6-6-6'],
  // «Скопіювати шлях» beside a path in the session's «Документація» tab: Lucide's copy, two
  // overlapping sheets.
  copy: ['M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z', 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
  // A session card's spend (KSessionCard): Lucide's coins. The model, tokens and cost live in
  // its tooltip; the mark has to say «what it cost is in here» before anyone hovers it.
  coins: ['M2 8a6 6 0 1 0 12 0a6 6 0 1 0-12 0', 'M18.09 10.37A6 6 0 1 1 10.34 18', 'M7 6h1v4', 'm16.71 13.88.7.71-2.82 2.82'],
  // The voice conversation (KComposer's start button, KVoiceBar, the top-bar pill): Lucide's mic
  // and mic-off. 🎤 would render as a colour emoji beside line marks.
  mic: ['M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v3'],
  micOff: ['m2 2 20 20', 'M18.89 13.23A7.12 7.12 0 0 0 19 12v-2', 'M5 10v2a7 7 0 0 0 12 5', 'M15 9.34V5a3 3 0 0 0-5.68-1.33', 'M9 9v3a3 3 0 0 0 5.12 2.12', 'M12 19v3'],

  // «ШІ-команда → Агенти» (docs/specs/2026-11-03-ai-team-agent-pages.md, decision 6): one mark per
  // built-in agent, in a disc on its list row and its page. «Посіпака» is `minion` above; the rest are Lucide's. Not the magnifier or the rocket: those already mean
  // «Глибокий аналіз» and «Розпочати».
  // Промоутер — a hammer (Lucide's): from talking it over to building it.
  agentPromote: [
    'm15 12-8.373 8.373a1 1 0 1 1-3-3L12 9',
    'm18 15 4-4',
    'm21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5',
  ],
  // Імплементувати Синергію — a wrench (Lucide's): the prototype rebuilt properly.
  agentSynergyImplement: [
    'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  ],
  // Ревізор — a shield with a tick (Lucide's shield-check): an independent audit.
  agentReview: [
    'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
    'm9 12 2 2 4-4',
  ],
  // Провізор — Lucide's git-pull-request.
  agentPullRequest: [
    'M15 18a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
    'M3 6a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
    'M13 6h3a2 2 0 0 1 2 2v7',
    'M6 9v12',
  ],
  // Комітер — Lucide's git-commit-horizontal.
  agentCommit: ['M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0', 'M3 12h6', 'M15 12h6'],
  // Вирішувач конфліктів — Lucide's git-merge: two lines meeting.
  agentResolveConflict: [
    'M15 18a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
    'M3 6a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
    'M6 21V9a9 9 0 0 0 9 9',
  ],
  // Завершити — a flag (Lucide's): the finish line.
  agentFinish: ['M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z', 'M4 22v-7'],
  // Саммарі — a written scroll (Lucide's scroll-text).
  agentSummary: [
    'M15 12h-5',
    'M15 8h-5',
    'M19 17V5a2 2 0 0 0-2-2H4',
    'M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3',
  ],
  // Тестувальник — a lab flask (Lucide's flask-conical): checks the change by trying it.
  agentTester: [
    'M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2',
    'M6.453 15h11.094',
    'M8.5 2h7',
  ],
  // «Розклад» — a clock (Lucide's): a scheduled task's row and the mark on the session its run
  // became (KScheduleMark, docs/specs/2026-11-06-scheduled-tasks.md, decision 5).
  clock: ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0', 'M12 6v6l4 2'],
  // «Надіслати відгук» in the header (docs/specs/2026-11-13-feedback-form.md): Lucide's
  // message-square-text. A glyph would need a font that has a speech balloon.
  feedback: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z', 'M13 8H7', 'M17 12H7'],
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
// Sized by a token rather than by `1em`: these marks sit next to 13px UI text where a
// font-relative icon would come out at 13px and read as a smudge. `--k-icon-lg` is the
// default because these are standalone marks — in the minified rail they carry the meaning
// with no label at all. Callers that need another step set `--k-icon-size` on the host, and
// should set it to one of `--k-icon-xs…xl` rather than to a literal.
.k-icon {
  display: block;
  flex: none;
  width: var(--k-icon-size, var(--k-icon-lg));
  height: var(--k-icon-size, var(--k-icon-lg));
}
</style>
