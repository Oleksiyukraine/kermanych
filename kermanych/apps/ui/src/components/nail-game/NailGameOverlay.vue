<template>
  <!-- «Гвіздки» (docs/specs/2026-11-18-nail-hammer-minigame.md, decision 2): a full-window layer
       over the app, so the Kermanych screen is the «desktop» the nails pop out of. Mounted once in
       MainLayout; the header's «Кімната відпочинку» button opens it through stores/nail-game.ts. AI opponents share
       the board (docs/specs/2026-11-19-nail-game-ai-opponents.md). -->
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
      <!-- The board. A solo round's is the window itself; a room's is ROOM_FIELD, the same on
           every colleague's window, scaled to fit and centred
           (docs/specs/2026-11-23-lounge-multiplayer.md, decision 3). Driven nails stay on it to
           the end and behind the result; the ones still standing at 0:00 leave with the round. -->
      <div
        v-if="round && (phase === 'playing' || phase === 'over')"
        class="ng__stage"
        :class="{ 'ng__stage--room': mode !== 'solo' }"
        :style="stageStyle"
      >
        <NailSprite
          v-for="n in driven"
          :key="n.id"
          :nail="n"
          :now="0"
          :look="STILL"
          :owner="multi ? colorOf(n.by ?? 0) : undefined"
          :style="{ left: `${n.x}px`, top: `${n.y}px` }"
        />
        <template v-if="phase === 'playing'">
          <NailSprite
            v-for="n in live"
            :key="n.id"
            :nail="n"
            :now="round.now"
            :look="lookFrom(n)"
            :style="{ left: `${n.x}px`, top: `${n.y}px` }"
          />
          <NailHammer
            v-for="s in seats"
            :key="s.who"
            :x="s.pos.x"
            :y="s.pos.y"
            :down="aiDown(s)"
            :color="colorOf(s.who)"
            :label="nameOf(s.model)"
          />
          <!-- Colleagues' hammers show where their last blow landed (decision 4). -->
          <NailHammer
            v-for="[who, h] in hands"
            :key="`hand-${who}`"
            :x="h.x"
            :y="h.y"
            :down="performanceNow() - h.at < HAND_DOWN_MS"
            :color="colorOf(who)"
            :label="names[who]"
          />
        </template>
      </div>

      <header class="ng__hud mono" @pointerdown.stop>
        <span class="ng__stat" :class="{ 'ng__stat--hurry': phase === 'playing' && timeLeft <= 10_000 }">
          <span class="ng__label">{{ t('nailGame.time') }}</span>
          <b>{{ clock }}</b>
        </span>
        <template v-if="multi">
          <span
            v-for="p in standings"
            :key="p.who"
            class="ng__stat"
            :class="{ 'ng__stat--left': p.left }"
            :title="p.error ?? (p.left ? t('nailGame.lounge.left') : undefined)"
          >
            <i class="ng__dot" :style="{ background: p.color }" />
            <span class="ng__name">{{ p.short }}</span>
            <b>{{ p.score }}</b>
            <span v-if="p.error" class="ng__warn">!</span>
          </span>
        </template>
        <template v-else>
          <span class="ng__stat">
            <span class="ng__label">{{ t('nailGame.score') }}</span>
            <b>{{ round?.players[0]?.score ?? 0 }}</b>
          </span>
          <span v-if="game.myBest !== null" class="ng__stat">
            <span class="ng__label">{{ t('nailGame.best') }}</span>
            <b>{{ game.myBest }}</b>
          </span>
        </template>
        <span class="ng__hud-gap" />
        <button type="button" class="ng__hud-btn" :aria-pressed="!muted" @click="muted = !muted">
          {{ muted ? t('nailGame.soundOff') : t('nailGame.soundOn') }}
        </button>
        <button type="button" class="ng__hud-btn" @click="leave">{{ t('nailGame.leave') }} <kbd>Esc</kbd></button>
      </header>

      <div v-if="phase === 'countdown'" class="ng__count mono" aria-live="assertive">{{ countdownLabel }}</div>
      <div v-if="phase === 'playing' && hostAway" class="ng__banner" role="status">
        {{ hostAway === 'paused' ? t('nailGame.lounge.hostPaused') : t('nailGame.lounge.hostSilent') }}
      </div>

      <section v-if="phase === 'intro'" class="ng__panel" @pointerdown.stop>
        <h2 class="ng__title">{{ t('nailGame.title') }}</h2>
        <p class="ng__text">{{ t('nailGame.blurb') }}</p>
        <ul class="ng__rules">
          <li>{{ t('nailGame.ruleStraight') }}</li>
          <li>{{ t('nailGame.ruleBent') }}</li>
          <li>{{ t('nailGame.ruleEscape') }}</li>
        </ul>
        <div class="ng__rivals">
          <KSelect
            :label="t('nailGame.rivals')"
            multiple
            searchable
            :options="modelPick"
            :values="game.opponents"
            :summary="rivalSummary"
            :loading="!game.catalogLoaded"
            :disabled="warming.busy.value"
            @update:values="game.setOpponents"
          />
          <p class="ng__note">
            <template v-if="game.catalogLoaded && !orch.models.length">{{ t('nailGame.rivalsNone') }}</template>
            <template v-else-if="game.opponents.length">{{ t('nailGame.rivalsCost', { max: NAIL_GAME_MAX_OPPONENTS }) }}</template>
            <template v-else>{{ t('nailGame.rivalsHint', { max: NAIL_GAME_MAX_OPPONENTS }) }}</template>
          </p>
          <p v-if="warmError" class="ng__error" role="alert">{{ t('nailGame.rivalsFailed', { error: warmError }) }}</p>
        </div>
        <div class="ng__actions">
          <KBtn ref="startBtn" variant="primary" :loading="warming.busy.value" @click="start">
            {{ startLabel }}
          </KBtn>
          <KBtn variant="ghost" @click="leave">{{ t('nailGame.close') }}</KBtn>
        </div>
        <p class="ng__note">{{ t('nailGame.leaveHint') }}</p>
        <p v-if="roomNotice" class="ng__error" role="status">{{ roomNotice }}</p>
        <LoungeLobby />
        <NailLeaderboard />
      </section>

      <section v-if="phase === 'room' && lounge.room" class="ng__panel" @pointerdown.stop>
        <LoungeRoomPanel :room="lounge.room" :notice="roomNotice" @start="startRoom" @leave="leaveRoom" />
      </section>

      <section v-if="phase === 'over' && final" class="ng__panel" @pointerdown.stop>
        <h2 class="ng__title">{{ t('nailGame.over') }}</h2>
        <template v-if="final.length > 1">
          <p class="ng__verdict" :class="{ 'ng__record': verdict.won }">{{ verdict.text }}</p>
          <ol class="ng__standings">
            <li v-for="p in final" :key="p.who">
              <span class="ng__place mono">{{ p.place }}</span>
              <i class="ng__dot" :style="{ background: p.color }" />
              <span class="ng__who">
                <b>{{ p.name }}</b>
                <span class="ng__sub">
                  {{ t('nailGame.standingLine', { driven: p.driven, accuracy: p.accuracy }) }}
                  <template v-if="p.moves !== undefined">
                    · {{ t('nailGame.aiLine', { moves: p.moves, lag: p.lag, cost: p.cost }) }}
                  </template>
                  <template v-if="p.failures">· {{ t('nailGame.aiFailures', { count: p.failures }) }}</template>
                  <template v-if="p.left">· {{ t('nailGame.lounge.left') }}</template>
                </span>
              </span>
              <b class="ng__pscore mono">{{ p.score }}</b>
            </li>
          </ol>
          <p class="ng__note">{{ mode === 'solo' ? t('nailGame.vsNotSaved') : t('nailGame.lounge.notSaved') }}</p>
        </template>
        <template v-else>
          <div class="ng__final">
            <span class="ng__label mono">{{ t('nailGame.result') }}</span>
            <b class="ng__final-score mono">{{ final[0]!.score }}</b>
          </div>
          <p class="ng__text">{{ t('nailGame.summary', { driven: final[0]!.driven, accuracy: final[0]!.accuracy }) }}</p>
          <p v-if="final[0]!.score === 0" class="ng__text">{{ t('nailGame.zero') }}</p>
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
        </template>
        <p v-if="warmError" class="ng__error" role="alert">{{ t('nailGame.rivalsFailed', { error: warmError }) }}</p>
        <div v-if="mode === 'solo'" class="ng__actions">
          <KBtn ref="againBtn" variant="primary" :loading="warming.busy.value" @click="start">{{ t('nailGame.again') }}</KBtn>
          <KBtn variant="ghost" :disabled="warming.busy.value" @click="toIntro">{{ t('nailGame.changeRivals') }}</KBtn>
          <KBtn variant="ghost" @click="leave">{{ t('nailGame.close') }}</KBtn>
        </div>
        <template v-else>
          <p v-if="mode === 'guest'" class="ng__note">{{ t('nailGame.lounge.waitAgain') }}</p>
          <div class="ng__actions">
            <KBtn
              v-if="mode === 'host'"
              ref="againBtn"
              variant="primary"
              :disabled="(lounge.room?.members?.length ?? 0) < 2"
              @click="startRoom"
            >{{ t('nailGame.again') }}</KBtn>
            <KBtn variant="ghost" @click="leaveRoom">{{ t('nailGame.lounge.leaveRoom') }}</KBtn>
            <KBtn variant="ghost" @click="leave">{{ t('nailGame.close') }}</KBtn>
          </div>
        </template>
        <NailLeaderboard v-if="final.length === 1" />
      </section>

      <!-- The player's hammer: the system cursor is hidden while it shows; its striking face is the pointer. -->
      <NailHammer v-if="phase === 'countdown' || phase === 'playing'" :x="pointer.x" :y="pointer.y" :down="swinging" />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, triggerRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAIL_GAME_AI_STRIKE_MS, NAIL_GAME_MAX_OPPONENTS } from '@kermanych/core';
import KBtn from 'components/kit/KBtn.vue';
import KSelect from 'components/kit/KSelect.vue';
import KSpinner from 'components/kit/KSpinner.vue';
import NailSprite from './NailSprite.vue';
import NailHammer from './NailHammer.vue';
import NailLeaderboard from './NailLeaderboard.vue';
import LoungeLobby from './LoungeLobby.vue';
import LoungeRoomPanel from './LoungeRoomPanel.vue';
import { useAsyncAction, errorText } from '../../composables/useAsyncAction';
import { useNailGame, type NailGameResult } from '../../stores/nail-game';
import { useLounge } from '../../stores/lounge';
import { useOrchestrator } from '../../stores/orchestrator';
import { api } from '../../lib/api';
import { modelOptions } from '../../lib/models';
import {
  COUNTDOWN_MS,
  FRAME_CLAMP_MS,
  NAIL_W,
  accuracy,
  advance,
  createRound,
  hitNail,
  isOver,
  isStanding,
  ROUND_MS,
  nailAt,
  swingMiss,
  timeLeftMs,
  type Field,
  type Nail,
  type Round,
} from '../../lib/nail-game';
import { boardFor, createSeat, stepSeat, takePlan, type AiSeat } from '../../lib/nail-game-ai';
import {
  LOUNGE_MAX_PLAYERS,
  ROOM_FIELD,
  applyHost,
  createHost,
  createMirror,
  hostOutgoing,
  hostSilent,
  hostSnapshot,
  hostSwing,
  readGuestMsg,
  readHostMsg,
  tickMirror,
  type Host,
  type Mirror,
  type Seat,
} from '../../lib/nail-game-net';

/** `room`: waiting in a room with colleagues for its host to start. */
type Phase = 'intro' | 'room' | 'countdown' | 'playing' | 'over';
/** Alone (perhaps with AI), hosting a room's round, or a guest in one (decision 2). */
type Mode = 'solo' | 'host' | 'guest';

/** One line of the result: a player's tally, and for an AI its moves, lag and spend. */
type Standing = {
  who: number;
  place: number;
  name: string;
  color: string;
  score: number;
  driven: number;
  accuracy: number;
  moves?: number;
  lag?: number;
  cost?: string;
  failures?: number;
  /** A colleague whose window left during the round. */
  left?: boolean;
};

// The score bar's height: nails stay below it.
const HUD_H = 64;
const SWING_MS = 90;
// An AI hammer starts down this long before its strike lands, and stays down this long after.
const AI_DOWN_BEFORE_MS = 50;
const AI_DOWN_AFTER_MS = 70;
// A move that failed is not asked again for this long, so a broken child is not hammered.
const AI_RETRY_MS = 1000;
const MUTED_KEY = 'kermanych.nail-game.muted';
// The player (or a room's host), then the opponents or colleagues. Hex for the others: the
// hammer grip is an svg fill.
const COLORS = ['var(--k-accent)', '#4c9aff', '#36b37e', '#c084fc', '#f5a524', '#ff6b8a'];
// A colleague's hammer stays down this long after their blow lands.
const HAND_DOWN_MS = 110;
const STILL = Object.freeze({ x: 0, y: 0 });

const { t } = useI18n();
const game = useNailGame();
const orch = useOrchestrator();
const lounge = useLounge();

const root = ref<HTMLElement | null>(null);
const startBtn = ref<InstanceType<typeof KBtn> | null>(null);
const againBtn = ref<InstanceType<typeof KBtn> | null>(null);
const phase = ref<Phase>('intro');
// The engine mutates the round and the seats in place; triggerRef re-renders once per frame.
const round = shallowRef<Round | null>(null);
const seats = shallowRef<AiSeat[]>([]);
const countdownMs = ref(0);
const pointer = ref({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
const swinging = ref(false);
const final = ref<Standing[] | null>(null);
const result = ref<NailGameResult | null>(null);
const saveError = ref<string | null>(null);
const warmError = ref<string | null>(null);
// The opponents of the round on screen, from its countdown to the next start or leave.
const rivals = ref<string[]>([]);
// The models whose children this window started and has not released yet.
let warmed: string[] = [];
// Bumped whenever a round starts or ends: a move that answers for an older round is dropped.
let generation = 0;

// ── a room with colleagues (docs/specs/2026-11-23-lounge-multiplayer.md) ─────
const mode = ref<Mode>('solo');
const roomSeats = ref<Seat[]>([]);
// This window's seat in the room's round: 0 for the host.
const meWho = ref(0);
let host: Host | null = null;
let mirror: Mirror | null = null;
const roomNotice = ref<string | null>(null);
// A guest's view of the host: paused (its window hidden), silent (nothing heard lately), or there.
const hostAway = ref<'paused' | 'silent' | null>(null);
const leftSeats = ref<number[]>([]);
// Each colleague's last blow, in field px, and when it landed (performance.now()).
const hands = shallowRef(new Map<number, { x: number; y: number; at: number }>());
const performanceNow = () => performance.now();
const viewport = ref({ w: window.innerWidth, h: window.innerHeight });

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

const driven = computed(() => round.value?.nails.filter((n) => n.doneAt !== null) ?? []);
const live = computed(() => round.value?.nails.filter((n) => n.doneAt === null) ?? []);

// ── opponents ───────────────────────────────────────────────────────────────
const modelPick = computed(() => modelOptions(orch.models));
const nameOf = (model: string): string => orch.models.find((m) => m.id === model)?.name ?? model;
const colorOf = (who: number): string => COLORS[who % COLORS.length]!;
const rivalSummary = computed(() =>
  game.opponents.length ? game.opponents.map(nameOf).join(', ') : t('nailGame.rivalsSolo'),
);
const startLabel = computed(() => {
  const n = game.opponents.length;
  if (n === 0) return t('nailGame.start');
  if (n === 1) return t('nailGame.startDuel', { name: nameOf(game.opponents[0]!) });
  return t('nailGame.startArena', { count: n + 1 });
});

// Everyone on the board, in seat order: the player and the AI opponents, or the room's seats.
const names = computed(() =>
  mode.value === 'solo'
    ? [t('nailGame.you'), ...rivals.value.map(nameOf)]
    : roomSeats.value.map((s, who) => (who === meWho.value ? t('nailGame.you') : s.name)),
);
const multi = computed(() => names.value.length > 1);

// The score bar during a round with others: everyone's score, best first.
const standings = computed(() => {
  const r = round.value;
  return names.value
    .map((short, who) => ({
      who,
      short,
      score: r?.players[who]?.score ?? 0,
      color: colorOf(who),
      error: mode.value === 'solo' && who ? (seats.value[who - 1]?.lastError ?? null) : null,
      left: leftSeats.value.includes(who),
    }))
    .sort((a, b) => b.score - a.score || a.who - b.who);
});

const verdict = computed(() => {
  const rows = final.value ?? [];
  const top = rows[0]?.score ?? 0;
  const leaders = rows.filter((p) => p.score === top);
  if (leaders.length > 1 && leaders.some((p) => p.who === meWho.value)) return { won: false, text: t('nailGame.draw') };
  if (leaders[0]?.who === meWho.value) return { won: true, text: t('nailGame.youWon') };
  return { won: false, text: t('nailGame.theyWon', { name: leaders.map((p) => p.name).join(', ') }) };
});

function aiDown(s: AiSeat): boolean {
  const now = round.value?.now ?? 0;
  return (
    (s.target !== null && s.cycleMs >= NAIL_GAME_AI_STRIKE_MS - AI_DOWN_BEFORE_MS) ||
    (s.struckAt !== null && now - s.struckAt < AI_DOWN_AFTER_MS)
  );
}

function field(): Field {
  return { width: window.innerWidth, height: window.innerHeight, top: HUD_H + 12, pad: 24 };
}

// Where the board sits on screen: a room's fixed field scaled to fit the window and centred; a
// solo round's field is the window (scale 1).
const stage = computed(() => {
  const { w, h } = viewport.value;
  if (mode.value === 'solo') return { scale: 1, x: 0, y: 0, w, h };
  const scale = Math.min(w / ROOM_FIELD.width, h / ROOM_FIELD.height);
  return {
    scale,
    x: (w - ROOM_FIELD.width * scale) / 2,
    y: (h - ROOM_FIELD.height * scale) / 2,
    w: ROOM_FIELD.width,
    h: ROOM_FIELD.height,
  };
});
const stageStyle = computed(() => ({
  width: `${stage.value.w}px`,
  height: `${stage.value.h}px`,
  transform: `translate(${stage.value.x}px, ${stage.value.y}px) scale(${stage.value.scale})`,
}));
// A point on screen in field px.
function toField(x: number, y: number): { x: number; y: number } {
  const s = stage.value;
  return { x: (x - s.x) / s.scale, y: (y - s.y) / s.scale };
}

// The opponents' hammers wait along the bottom of the screen until their first move lands.
function seatStart(i: number, of: number): { x: number; y: number } {
  return { x: (window.innerWidth * (i + 1)) / (of + 1), y: window.innerHeight - 60 };
}

// One move for one opponent: the board as it is now, the model's strikes when they land.
function ask(r: Round, s: AiSeat): void {
  const gen = generation;
  const sentAt = performance.now();
  s.asking = true;
  api.nailGameMove(s.model, boardFor(r, s)).then(
    (move) => {
      if (gen !== generation) return;
      s.asking = false;
      s.lagMs = performance.now() - sentAt;
      s.moves += 1;
      s.cost += move.usage?.cost ?? 0;
      s.lastError = null;
      takePlan(s, move.strikes);
    },
    (e: unknown) => {
      if (gen !== generation) return;
      s.asking = false;
      s.failures += 1;
      s.lastError = errorText(e);
      s.askAfter = r.now + AI_RETRY_MS;
    },
  );
}

// Asked while the last strikes of the previous move are still being played, so the next plan
// is on its way before the hammer runs out; nothing is asked of an empty board.
function wantsMove(r: Round, s: AiSeat): boolean {
  return !s.asking && r.now >= s.askAfter && s.queue.length <= 1 && r.nails.some(isStanding);
}

// The children stop with the round; the api's idle sweep stops any whose release is lost (a
// closed window), so a failed release has nothing for the player to act on.
function release(): void {
  if (!warmed.length) return;
  void api.nailGameRelease(warmed).catch(() => undefined);
  warmed = [];
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
      if (mode.value === 'guest') {
        // The host's snapshots start with its round: nothing heard during the countdown is silence.
        if (mirror) mirror.heardAt = ts;
      } else if (mode.value === 'host') {
        round.value = createRound({ ...ROOM_FIELD }, roomSeats.value.length);
        host = createHost();
      } else {
        round.value = createRound(field(), 1 + warmed.length);
        seats.value = warmed.map((model, i) => createSeat(i + 1, model, seatStart(i, warmed.length)));
      }
      phase.value = 'playing';
    }
  } else if (phase.value === 'playing' && round.value) {
    const r = round.value;
    if (mode.value === 'guest' && mirror) {
      tickMirror(mirror, dt, ts);
      hostAway.value = mirror.paused ? 'paused' : hostSilent(mirror, ts) ? 'silent' : null;
      triggerRef(round);
      // The host's «end», or the clock run out and the host gone quiet with its last word lost.
      if (mirror.ended || (r.now >= ROUND_MS && hostSilent(mirror, ts))) {
        finish(r);
        return;
      }
      raf = requestAnimationFrame(frame);
      return;
    }
    advance(r, dt);
    const step = Math.min(dt, FRAME_CLAMP_MS);
    for (const s of seats.value) {
      if (isOver(r)) break;
      const points = stepSeat(r, s, step);
      if (points !== null) knock(points > 0 ? 'drive' : 'hit', 0.45);
      if (wantsMove(r, s)) ask(r, s);
    }
    if (host) for (const msg of hostOutgoing(r, host, ts)) lounge.send(msg);
    triggerRef(round);
    triggerRef(seats);
    if (isOver(r)) {
      if (host) lounge.send(hostSnapshot(r, host, ts, 'end'));
      finish(r);
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

// ── starting and ending ─────────────────────────────────────────────────────
// With opponents, their children start first (a fresh one per model, the contract re-sent), so
// the countdown begins only once every model can answer. The button spins meanwhile.
const warming = useAsyncAction((models: string[]) => api.nailGameWarm(models), {
  onError: (e) => {
    warmError.value = errorText(e);
  },
});

async function start(): Promise<void> {
  stopLoop();
  generation += 1;
  release();
  warmError.value = null;
  const models = [...game.opponents];
  if (models.length) {
    if (!(await warming.run(models))) return;
    // Left while the children were starting: they go again.
    if (!game.open) {
      void api.nailGameRelease(models).catch(() => undefined);
      return;
    }
  }
  warmed = models;
  rivals.value = models;
  mode.value = 'solo';
  resetBoard();
  countdownMs.value = COUNTDOWN_MS;
  phase.value = 'countdown';
  raf = requestAnimationFrame(frame);
}

// A new round on the board: nothing left from the last one.
function resetBoard(): void {
  round.value = null;
  seats.value = [];
  final.value = null;
  result.value = null;
  saveError.value = null;
  host = null;
  mirror = null;
  hands.value = new Map();
  leftSeats.value = [];
  hostAway.value = null;
  roomNotice.value = null;
}

// The host starts the room's round: everyone present is seated, the host first, then by when
// they came, up to LOUNGE_MAX_PLAYERS; the rest wait for the next round (decision 6).
function startRoom(): void {
  const members = lounge.room?.isHost ? (lounge.room.members ?? []) : [];
  if (members.length < 2) return;
  stopLoop();
  generation += 1;
  release();
  const seated: Seat[] = members
    .slice(0, LOUNGE_MAX_PLAYERS)
    .map(({ clientId, userId, name, avatarUrl }) => ({ clientId, userId, name, avatarUrl }));
  lounge.send({ t: 'start', seats: seated });
  lounge.setPlaying(true);
  warmed = [];
  rivals.value = [];
  mode.value = 'host';
  roomSeats.value = seated;
  meWho.value = 0;
  resetBoard();
  countdownMs.value = COUNTDOWN_MS;
  phase.value = 'countdown';
  raf = requestAnimationFrame(frame);
}

// A guest hears the host's «start»: the same countdown, then the host's board as it comes in.
function beginGuest(seated: Seat[]): void {
  const who = seated.findIndex((s) => s.clientId === lounge.clientId);
  if (who < 1) {
    roomNotice.value = t('nailGame.lounge.benched');
    return;
  }
  stopLoop();
  mode.value = 'guest';
  roomSeats.value = seated;
  meWho.value = who;
  resetBoard();
  mirror = createMirror(seated.length, performance.now());
  round.value = mirror.round;
  countdownMs.value = COUNTDOWN_MS;
  phase.value = 'countdown';
  raf = requestAnimationFrame(frame);
}

// A room's message: guests' blows for the host; the round itself for a guest.
function onRoomMessage(raw: Record<string, unknown>): void {
  const now = performance.now();
  if (lounge.room?.isHost) {
    const r = round.value;
    const g = host && r && phase.value === 'playing' ? readGuestMsg(raw, roomSeats.value.length) : null;
    if (!g || !host || !r) return;
    const res = hostSwing(r, host, g);
    showHand(g.who, g.x, g.y, now);
    knock(res.points > 0 ? 'drive' : res.hit ? 'hit' : 'miss', 0.45);
    triggerRef(round);
    return;
  }
  const msg = readHostMsg(raw);
  if (!msg) return;
  if (msg.t === 'start') return beginGuest(msg.seats);
  if (msg.t === 'cancel') return endRoom(t('nailGame.lounge.hostLeft'));
  if (mode.value !== 'guest' || !mirror) return;
  for (const s of applyHost(mirror, msg, now)) {
    if (s.who === meWho.value) continue;
    showHand(s.who, s.x, s.y, now);
    knock(s.drove ? 'drive' : s.hit ? 'hit' : 'miss', 0.45);
  }
  leftSeats.value = [...mirror.left];
  triggerRef(round);
}

function showHand(who: number, x: number, y: number, at: number): void {
  hands.value.set(who, { x, y, at });
  triggerRef(hands);
}

// The room is over for this window (the host left, or this window did): back to the lobby.
function endRoom(notice: string | null): void {
  stopLoop();
  lounge.leaveRoom();
  mode.value = 'solo';
  roomSeats.value = [];
  meWho.value = 0;
  toIntro();
  roomNotice.value = notice;
}

function leaveRoom(): void {
  endRoom(null);
}

function finish(r: Round): void {
  stopLoop();
  generation += 1;
  const rows: Standing[] = r.players.map((p, who) => {
    const s = mode.value === 'solo' ? seats.value[who - 1] : undefined;
    return {
      who,
      place: 0,
      name: names.value[who] ?? '',
      color: colorOf(who),
      left: leftSeats.value.includes(who),
      score: p.score,
      driven: p.driven,
      accuracy: Math.round(accuracy(p) * 100),
      ...(s
        ? {
            moves: s.moves,
            lag: Math.round(s.lagMs),
            cost: s.cost.toFixed(s.cost < 0.1 ? 3 : 2),
            failures: s.failures,
          }
        : {}),
    };
  });
  rows.sort((a, b) => b.score - a.score || a.who - b.who);
  rows.forEach((row, i) => (row.place = i > 0 && row.score === rows[i - 1]!.score ? rows[i - 1]!.place : i + 1));
  final.value = rows;
  phase.value = 'over';
  release();
  if (mode.value === 'host') lounge.setPlaying(false);
  // Only a solo round goes on the leaderboard: opponents and colleagues take nails, so a score
  // against them is not comparable with one played alone.
  if (mode.value === 'solo' && rows.length === 1) void save();
  void nextTick(() => againBtn.value?.$el?.focus?.());
}

// Back to the start screen (or the room's, in a room); the finished round leaves the board.
function toIntro(): void {
  resetBoard();
  rivals.value = [];
  if (!lounge.room) mode.value = 'solo';
  phase.value = lounge.room ? 'room' : 'intro';
}

// A round left before the end is not saved (decision 2); leaving the game leaves its room.
function leave(): void {
  stopLoop();
  generation += 1;
  release();
  if (lounge.room) endRoom(null);
  toIntro();
  game.hide();
}

// ── saving ──────────────────────────────────────────────────────────────────
const saving = useAsyncAction((score: number) => game.submit(score), {
  onError: (e) => {
    saveError.value = errorText(e);
  },
});

async function save(): Promise<void> {
  const score = final.value?.length === 1 ? final.value[0]!.score : 0;
  if (score === 0) return;
  saveError.value = null;
  const saved = await saving.run(score);
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
  const at = toField(e.clientX, e.clientY);
  const n = nailAt(r, at.x, at.y);
  if (mode.value === 'guest') {
    // The host judges the blow; the knock is this window's own guess, so it sounds at once.
    lounge.send({ t: 'swing', who: meWho.value, nailId: n?.id ?? null, x: at.x, y: at.y });
    knock(!n ? 'miss' : n.hits + 1 >= n.needed ? 'drive' : 'hit');
    return;
  }
  if (mode.value === 'host' && host) {
    const res = hostSwing(r, host, { who: 0, nailId: n?.id ?? null, x: at.x, y: at.y });
    knock(res.points > 0 ? 'drive' : res.hit ? 'hit' : 'miss');
  } else if (!n) {
    swingMiss(r);
    knock('miss');
  } else {
    knock(hitNail(r, n.id) > 0 ? 'drive' : 'hit');
  }
  triggerRef(round);
}

// The pupils look at the player's hammer: a unit vector from the nail's middle.
function lookFrom(n: Nail): { x: number; y: number } {
  const p = toField(pointer.value.x, pointer.value.y);
  const dx = p.x - (n.x + NAIL_W / 2);
  const dy = p.y - (n.y + 40);
  const d = Math.hypot(dx, dy);
  return d < 1 ? STILL : { x: dx / d, y: dy / d };
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  // Esc in the opponents' open list closes the list (KSelect), not the game.
  if ((e.target as Element | null)?.closest?.('[aria-expanded="true"]')) return;
  e.preventDefault();
  e.stopPropagation();
  leave();
}

function onResize(): void {
  viewport.value = { w: window.innerWidth, h: window.innerHeight };
  if (round.value && mode.value === 'solo') round.value.field = field();
}

// The host's window hidden pauses its round (the frame loop stops) — and so the room's, at once
// rather than when the guests notice the silence (decision 6).
function onVisibility(): void {
  const r = round.value;
  if (mode.value !== 'host' || !host || !r || phase.value !== 'playing') return;
  host.paused = document.hidden;
  lounge.send(hostSnapshot(r, host, performance.now()));
}

// ── sound (decision 3): a synthesised knock, no files ───────────────────────
let audio: AudioContext | null = null;

// `level` scales the volume: an opponent's knocks are quieter than the player's own.
function knock(kind: 'miss' | 'hit' | 'drive', level = 1): void {
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
    gain.gain.setValueAtTime(vol * level, t0);
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
      document.removeEventListener('visibilitychange', onVisibility);
      return;
    }
    toIntro();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    await nextTick();
    startBtn.value?.$el?.focus?.();
  },
  // Immediate: a remount (hot reload) while open still listens for Esc.
  { immediate: true },
);

// Into a room from the lobby: its waiting screen.
watch(
  () => lounge.room?.id,
  (id, before) => {
    if (id && id !== before && phase.value === 'intro') {
      roomNotice.value = null;
      phase.value = 'room';
    }
  },
);

// The host left, or the server closed this window's channel: the room is over for it.
watch(
  () => lounge.room?.hostGone,
  (gone) => {
    if (gone) endRoom(t('nailGame.lounge.hostLeft'));
  },
);
watch(
  () => lounge.room?.lost,
  (lost) => {
    if (lost) endRoom(t('nailGame.lounge.lost'));
  },
);

// A guest's window left during the round: their score stays, marked (decision 6).
watch(
  () => lounge.room?.members,
  (members) => {
    if (mode.value !== 'host' || !host || !members) return;
    const here = new Set(members.map((m) => m.clientId));
    roomSeats.value.forEach((s, who) => {
      if (who > 0 && !here.has(s.clientId)) host!.left.add(who);
    });
    leftSeats.value = [...host.left];
  },
);

const offRoom = lounge.onGame(onRoomMessage);

onBeforeUnmount(() => {
  stopLoop();
  generation += 1;
  release();
  offRoom();
  if (lounge.room) lounge.leaveRoom();
  clearTimeout(swingTimer);
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', onResize);
  document.removeEventListener('visibilitychange', onVisibility);
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
.ng--room,
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

.ng__stat--left {
  opacity: 0.45;
}

.ng__label {
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--k-muted);
}

.ng__name {
  font-size: 12px;
  color: var(--k-muted);
}

.ng__dot {
  display: inline-block;
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  align-self: center;
}

.ng__warn {
  color: var(--k-accent);
  font-weight: 700;
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

// The board: the nails and the hammers are placed in field px inside it.
.ng__stage {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
}

// A room's board is smaller than the window on most screens: its edge shows where nails can be.
.ng__stage--room {
  border: 1px dashed color-mix(in srgb, var(--k-line-strong) 70%, transparent);
  border-radius: var(--k-r-lg);
}

.ng__banner {
  position: absolute;
  top: 72px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 14px;
  background: color-mix(in srgb, var(--k-surface) 92%, transparent);
  border: 1px solid var(--k-accent);
  border-radius: var(--k-r);
  color: var(--k-text);
  font-size: 13px;
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
  width: 460px;
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

.ng__rivals {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ng__actions {
  display: flex;
  flex-wrap: wrap;
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

.ng__verdict {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}

.ng__standings {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    display: flex;
    align-items: center;
    gap: 10px;
  }
}

.ng__place {
  width: 16px;
  color: var(--k-muted);
  text-align: right;
}

.ng__who {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  font-size: 13px;
}

.ng__sub {
  font-size: 11.5px;
  color: var(--k-muted);
}

.ng__pscore {
  font-size: 22px;
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
</style>
