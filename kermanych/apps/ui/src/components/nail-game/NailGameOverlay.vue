<template>
  <!-- «Гвіздки» (docs/specs/2026-11-18-nail-hammer-minigame.md, decision 2): a full-window layer
       over the app, so the Kermanych screen is the «desktop» the nails pop out of. Mounted once in
       MainLayout; the header's hammer opens it through stores/nail-game.ts. -->
  <Teleport to="body">
    <div
      v-if="game.open"
      ref="root"
      class="ng"
      :class="`ng--${phase}`"
      role="dialog"
      aria-modal="true"
      :aria-label="t('nailGame.title')"
      tabindex="-1"
      @pointermove="onMove"
      @pointerdown="onDown"
    >
      <!-- Only while playing: the nails left standing at 0:00 leave with the round. -->
      <template v-if="round && phase === 'playing'">
        <NailSprite
          v-for="n in round.nails"
          :key="n.id"
          :nail="n"
          :now="round.now"
          :look="lookFrom(n)"
          :style="{ left: `${n.x}px`, top: `${n.y}px` }"
        />
      </template>

      <header class="ng__hud mono" @pointerdown.stop>
        <span class="ng__stat" :class="{ 'ng__stat--hurry': phase === 'playing' && timeLeft <= 10_000 }">
          <span class="ng__label">{{ t('nailGame.time') }}</span>
          <b>{{ clock }}</b>
        </span>
        <span class="ng__stat">
          <span class="ng__label">{{ t('nailGame.score') }}</span>
          <b>{{ round?.score ?? 0 }}</b>
        </span>
        <span v-if="game.myBest !== null" class="ng__stat">
          <span class="ng__label">{{ t('nailGame.best') }}</span>
          <b>{{ game.myBest }}</b>
        </span>
        <span class="ng__hud-gap" />
        <button type="button" class="ng__hud-btn" :aria-pressed="!muted" @click="muted = !muted">
          {{ muted ? t('nailGame.soundOff') : t('nailGame.soundOn') }}
        </button>
        <button type="button" class="ng__hud-btn" @click="leave">{{ t('nailGame.leave') }} <kbd>Esc</kbd></button>
      </header>

      <div v-if="phase === 'countdown'" class="ng__count mono" aria-live="assertive">{{ countdownLabel }}</div>

      <section v-if="phase === 'intro'" class="ng__panel" @pointerdown.stop>
        <h2 class="ng__title">{{ t('nailGame.title') }}</h2>
        <p class="ng__text">{{ t('nailGame.blurb') }}</p>
        <ul class="ng__rules">
          <li>{{ t('nailGame.ruleStraight') }}</li>
          <li>{{ t('nailGame.ruleBent') }}</li>
          <li>{{ t('nailGame.ruleEscape') }}</li>
        </ul>
        <div class="ng__actions">
          <KBtn ref="startBtn" variant="primary" @click="start">{{ t('nailGame.start') }}</KBtn>
          <KBtn variant="ghost" @click="leave">{{ t('nailGame.close') }}</KBtn>
        </div>
        <p class="ng__note">{{ t('nailGame.leaveHint') }}</p>
        <NailLeaderboard />
      </section>

      <section v-if="phase === 'over' && final" class="ng__panel" @pointerdown.stop>
        <h2 class="ng__title">{{ t('nailGame.over') }}</h2>
        <div class="ng__final">
          <span class="ng__label mono">{{ t('nailGame.result') }}</span>
          <b class="ng__final-score mono">{{ final.score }}</b>
        </div>
        <p class="ng__text">{{ t('nailGame.summary', { driven: final.driven, accuracy: final.accuracy }) }}</p>
        <p v-if="final.score === 0" class="ng__text">{{ t('nailGame.zero') }}</p>
        <p v-else-if="saving.busy.value" class="ng__text ng__saving"><KSpinner /> {{ t('nailGame.saving') }}</p>
        <p v-else-if="saveError" class="ng__error" role="alert">
          {{ t('nailGame.saveFailed', { error: saveError }) }}
          <KBtn variant="ghost" :loading="saving.busy.value" @click="save">{{ t('nailGame.saveRetry') }}</KBtn>
        </p>
        <p v-else-if="result" class="ng__text">
          <b v-if="result.record" class="ng__record">{{ t('nailGame.record') }}</b>
          <template v-else-if="game.myBest !== null">{{ t('nailGame.yourBest', { best: game.myBest }) }}</template>
          <template v-if="result.place !== null && result.players !== null">
            {{ t('nailGame.place', { place: result.place, players: result.players }) }}
          </template>
        </p>
        <div class="ng__actions">
          <KBtn ref="againBtn" variant="primary" @click="start">{{ t('nailGame.again') }}</KBtn>
          <KBtn variant="ghost" @click="leave">{{ t('nailGame.close') }}</KBtn>
        </div>
        <NailLeaderboard />
      </section>

      <!-- The hammer: the system cursor is hidden while it shows; its striking face is the pointer. -->
      <div
        v-if="phase === 'countdown' || phase === 'playing'"
        class="ng__hammer"
        :style="{ transform: `translate(${pointer.x - HOT_X}px, ${pointer.y - HOT_Y}px)` }"
        aria-hidden="true"
      >
        <svg class="ng__hammer-art" :class="{ 'ng__hammer-art--swing': swinging }" width="72" height="40" viewBox="0 0 72 40">
          <defs>
            <linearGradient id="ng-hammer-head" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stop-color="#eef1f5" />
              <stop offset="1" stop-color="#7b8592" />
            </linearGradient>
          </defs>
          <rect x="19" y="11" width="52" height="9" rx="4" fill="#a8743f" stroke="#6e4a25" stroke-width="1.2" />
          <rect x="54" y="10.5" width="17" height="10" rx="4.5" fill="#5b3b1d" />
          <rect x="1" y="1" width="21" height="30" rx="3" fill="url(#ng-hammer-head)" stroke="#424a55" stroke-width="1.2" />
          <rect x="1" y="26" width="21" height="5" rx="1.5" fill="#59626e" />
        </svg>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, triggerRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import KBtn from 'components/kit/KBtn.vue';
import KSpinner from 'components/kit/KSpinner.vue';
import NailSprite from './NailSprite.vue';
import NailLeaderboard from './NailLeaderboard.vue';
import { useAsyncAction, errorText } from '../../composables/useAsyncAction';
import { useNailGame, type NailGameResult } from '../../stores/nail-game';
import {
  COUNTDOWN_MS,
  FRAME_CLAMP_MS,
  NAIL_W,
  accuracy,
  advance,
  createRound,
  hitNail,
  isOver,
  swingMiss,
  timeLeftMs,
  type Field,
  type Nail,
  type Round,
} from '../../lib/nail-game';

type Phase = 'intro' | 'countdown' | 'playing' | 'over';

// The hammer's striking face, in its 72 × 40 art: this point sits on the pointer.
const HOT_X = 11;
const HOT_Y = 31;
// The score bar's height: nails stay below it.
const HUD_H = 64;
const SWING_MS = 90;
const MUTED_KEY = 'kermanych.nail-game.muted';

const { t } = useI18n();
const game = useNailGame();

const root = ref<HTMLElement | null>(null);
const startBtn = ref<InstanceType<typeof KBtn> | null>(null);
const againBtn = ref<InstanceType<typeof KBtn> | null>(null);
const phase = ref<Phase>('intro');
// The engine mutates the round in place; triggerRef re-renders once per frame.
const round = shallowRef<Round | null>(null);
const countdownMs = ref(0);
const pointer = ref({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
const swinging = ref(false);
const final = ref<{ score: number; driven: number; accuracy: number } | null>(null);
const result = ref<NailGameResult | null>(null);
const saveError = ref<string | null>(null);

const muted = ref(readMuted());
watch(muted, (v) => {
  try {
    localStorage.setItem(MUTED_KEY, v ? '1' : '0');
  } catch {
    // Refused storage: the choice lasts for this window only.
  }
});
function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

const timeLeft = computed(() => (round.value ? timeLeftMs(round.value) : 60_000));
const clock = computed(() => {
  const s = Math.ceil(timeLeft.value / 1000);
  return s >= 60 ? '1:00' : `0:${String(s).padStart(2, '0')}`;
});
const countdownLabel = computed(() => Math.max(1, Math.ceil(countdownMs.value / 1000)));

function field(): Field {
  return { width: window.innerWidth, height: window.innerHeight, top: HUD_H + 12, pad: 24 };
}

// ── the loop ────────────────────────────────────────────────────────────────
let raf = 0;
let last = 0;

function frame(ts: number): void {
  const dt = last ? ts - last : 0;
  last = ts;
  if (phase.value === 'countdown') {
    countdownMs.value -= Math.min(dt, FRAME_CLAMP_MS);
    if (countdownMs.value <= 0) {
      round.value = createRound(field());
      phase.value = 'playing';
    }
  } else if (phase.value === 'playing' && round.value) {
    advance(round.value, dt);
    triggerRef(round);
    if (isOver(round.value)) {
      finish(round.value);
      return;
    }
  }
  raf = requestAnimationFrame(frame);
}

function stopLoop(): void {
  cancelAnimationFrame(raf);
  raf = 0;
  last = 0;
}

function start(): void {
  stopLoop();
  round.value = null;
  final.value = null;
  result.value = null;
  saveError.value = null;
  countdownMs.value = COUNTDOWN_MS;
  phase.value = 'countdown';
  raf = requestAnimationFrame(frame);
}

function finish(r: Round): void {
  stopLoop();
  final.value = { score: r.score, driven: r.driven, accuracy: Math.round(accuracy(r) * 100) };
  phase.value = 'over';
  void save();
  void nextTick(() => againBtn.value?.$el?.focus?.());
}

// A round left before the end is not saved (decision 2).
function leave(): void {
  stopLoop();
  round.value = null;
  phase.value = 'intro';
  game.hide();
}

// ── saving ──────────────────────────────────────────────────────────────────
const saving = useAsyncAction((score: number) => game.submit(score), {
  onError: (e) => {
    saveError.value = errorText(e);
  },
});

async function save(): Promise<void> {
  if (!final.value || final.value.score === 0) return;
  saveError.value = null;
  const saved = await saving.run(final.value.score);
  if (saved) result.value = saved;
}

// ── input ───────────────────────────────────────────────────────────────────
let swingTimer: ReturnType<typeof setTimeout> | undefined;

function onMove(e: PointerEvent): void {
  pointer.value = { x: e.clientX, y: e.clientY };
}

function onDown(e: PointerEvent): void {
  if (phase.value !== 'countdown' && phase.value !== 'playing') return;
  e.preventDefault();
  pointer.value = { x: e.clientX, y: e.clientY };
  swinging.value = true;
  clearTimeout(swingTimer);
  swingTimer = setTimeout(() => (swinging.value = false), SWING_MS);
  const r = round.value;
  if (phase.value !== 'playing' || !r) return;
  const id = Number((e.target as Element | null)?.closest('[data-nail]')?.getAttribute('data-nail'));
  if (!id) {
    swingMiss(r);
    knock('miss');
  } else {
    const hits = r.hits;
    const points = hitNail(r, id);
    knock(points > 0 ? 'drive' : r.hits > hits ? 'hit' : 'miss');
  }
  triggerRef(round);
}

// The pupils look at the hammer: a unit vector from the nail's middle.
function lookFrom(n: Nail): { x: number; y: number } {
  const dx = pointer.value.x - (n.x + NAIL_W / 2);
  const dy = pointer.value.y - (n.y + 40);
  const d = Math.hypot(dx, dy);
  return d < 1 ? { x: 0, y: 0 } : { x: dx / d, y: dy / d };
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  leave();
}

function onResize(): void {
  if (round.value) round.value.field = field();
}

// ── sound (decision 3): a synthesised knock, no files ───────────────────────
let audio: AudioContext | null = null;

function knock(kind: 'miss' | 'hit' | 'drive'): void {
  if (muted.value) return;
  try {
    audio ??= new AudioContext();
    const t0 = audio.currentTime;
    const [from, to, dur, vol, wave] =
      kind === 'drive'
        ? ([1500, 900, 0.2, 0.18, 'triangle'] as const)
        : kind === 'hit'
          ? ([520, 160, 0.08, 0.22, 'square'] as const)
          : ([150, 60, 0.06, 0.12, 'square'] as const);
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(from, t0);
    osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(gain).connect(audio.destination);
    osc.start(t0);
    osc.stop(t0 + dur);
  } catch {
    // No audio device or a refused context: the game plays silent.
  }
}

watch(
  () => game.open,
  async (open) => {
    if (!open) {
      stopLoop();
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      return;
    }
    phase.value = 'intro';
    round.value = null;
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    await nextTick();
    startBtn.value?.$el?.focus?.();
  },
  // Immediate: a remount (hot reload) while open still listens for Esc.
  { immediate: true },
);

onBeforeUnmount(() => {
  stopLoop();
  clearTimeout(swingTimer);
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', onResize);
  void audio?.close();
});
</script>

<style scoped lang="scss">
.ng {
  position: fixed;
  inset: 0;
  // Above QDialog (6000), below the toasts (7000): a failed save still shows its toast.
  z-index: 6500;
  overflow: hidden;
  background: rgba(8, 10, 14, 0.18);
  user-select: none;
  touch-action: none;
  outline: none;
}

.ng--intro,
.ng--over {
  background: rgba(8, 10, 14, 0.55);
  backdrop-filter: blur(2px);
}

.ng--countdown,
.ng--playing {
  cursor: none;

  * {
    cursor: none;
  }
}

.ng__hud {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 18px;
  height: 44px;
  padding: 0 8px 0 18px;
  background: color-mix(in srgb, var(--k-surface) 92%, transparent);
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  box-shadow: var(--k-shadow-modal);
  color: var(--k-text);
  font-size: 13px;
  white-space: nowrap;
}

.ng__stat {
  display: flex;
  align-items: baseline;
  gap: 6px;

  b {
    font-size: 18px;
    font-variant-numeric: tabular-nums;
  }
}

.ng__stat--hurry b {
  color: var(--k-accent);
}

.ng__label {
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--k-muted);
}

.ng__hud-gap {
  width: 6px;
}

.ng__hud-btn {
  padding: 5px 9px;
  background: transparent;
  border: 1px solid var(--k-line);
  border-radius: var(--k-r);
  color: var(--k-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;

  &:hover {
    border-color: var(--k-accent);
    color: var(--k-text);
  }

  kbd {
    margin-left: 4px;
    font: inherit;
    opacity: 0.7;
  }
}

.ng__count {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 120px;
  font-weight: 700;
  color: var(--k-text);
  text-shadow: 0 6px 30px rgba(0, 0, 0, 0.5);
  pointer-events: none;
}

.ng__panel {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 440px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 120px);
  overflow-y: auto;
  padding: 22px 24px;
  background: var(--k-grad-raise), var(--k-bg);
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  box-shadow: var(--k-sheen), var(--k-shadow-modal);
  color: var(--k-text);
  user-select: text;
}

.ng__title {
  margin: 0;
  font-size: 22px;
  line-height: 1.2;
}

.ng__text,
.ng__note {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--k-muted);
}

.ng__note {
  font-size: 11.5px;
}

.ng__rules {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.6;
}

.ng__actions {
  display: flex;
  gap: 8px;
}

.ng__final {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.ng__final-score {
  font-size: 48px;
  line-height: 1;
}

.ng__record {
  color: var(--k-accent);
}

.ng__saving {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ng__error {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  font-size: 12.5px;
  color: var(--k-accent);
}

.ng__hammer {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  will-change: transform;
  filter: drop-shadow(0 4px 6px rgba(0, 0, 0, 0.35));
}

// Pivots on the end of the handle: raised at rest, flat on the strike.
.ng__hammer-art {
  display: block;
  overflow: visible;
  transform-origin: 66px 15px;
  transform: rotate(-26deg);
  transition: transform 0.12s ease-out;
}

.ng__hammer-art--swing {
  transform: rotate(2deg);
  transition-duration: 0.05s;
}
</style>
