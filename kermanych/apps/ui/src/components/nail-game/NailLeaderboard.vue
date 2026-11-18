<template>
  <!-- «Гвіздки» leaderboard (docs/specs/2026-11-18-nail-hammer-minigame.md, decisions 5, 6, 8):
       the top 10 of the scope, the player's own row kept even when it is further down. -->
  <div class="nlb">
    <div class="nlb__head">
      <span class="nlb__title mono">{{ t('nailGame.leaderboard') }}</span>
      <KToggle
        v-if="game.workspace"
        :options="scopeLabels"
        :model-value="scopeLabel"
        @update:model-value="pickScope"
      />
    </div>
    <div v-if="game.boardError" class="nlb__error" role="alert">
      {{ t('nailGame.boardFailed', { error: game.boardError }) }}
      <KBtn variant="ghost" :loading="retry.busy.value" @click="retry.run()">{{ t('nailGame.retry') }}</KBtn>
    </div>
    <KSkeleton v-else-if="phase === 'skeleton'" variant="rows" :rows="5" />
    <template v-else-if="phase === 'ready' && game.board">
      <p v-if="!game.board.length" class="nlb__empty">{{ t('nailGame.nobodyYet') }}</p>
      <ol v-else class="nlb__rows">
        <template v-for="(row, i) in game.board" :key="row.userId">
          <!-- The player's own row, appended below the top 10 by the function: a gap when it is not the 11th. -->
          <li v-if="i === NAIL_GAME_BOARD_LIMIT && row.place > (game.board[i - 1]?.place ?? 0) + 1" class="nlb__gap" aria-hidden="true">…</li>
          <li class="nlb__row" :class="{ 'nlb__row--me': row.userId === auth.user?.id }">
            <span class="nlb__place mono">{{ row.place }}</span>
            <KAvatar :name="row.githubUsername ?? row.displayName ?? '?'" :avatar-url="row.avatarUrl ?? undefined" :size="22" />
            <span class="nlb__name">{{ row.githubUsername ? `@${row.githubUsername}` : (row.displayName ?? '—') }}</span>
            <span class="nlb__score mono">{{ row.bestScore }}</span>
          </li>
        </template>
      </ol>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import KAvatar from 'components/kit/KAvatar.vue';
import KBtn from 'components/kit/KBtn.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import KToggle from 'components/kit/KToggle.vue';
import { useAsyncAction } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import { useAuth } from '../../stores/auth';
import { NAIL_GAME_BOARD_LIMIT, useNailGame, type NailGameScope } from '../../stores/nail-game';

const { t } = useI18n();
const game = useNailGame();
const auth = useAuth();

const phase = useLoadPhase(() => game.board === undefined && !game.boardError);
const retry = useAsyncAction(() => game.loadBoard());

// KToggle speaks in labels; the store in scopes.
const scopeLabels = computed(() => [t('nailGame.scopeAll'), game.workspace?.name ?? '']);
const scopeLabel = computed(() => (game.scope === 'workspace' ? (game.workspace?.name ?? '') : t('nailGame.scopeAll')));
function pickScope(label: string): void {
  const next: NailGameScope = label === t('nailGame.scopeAll') ? 'all' : 'workspace';
  if (next !== game.scope) game.setScope(next);
}
</script>

<style scoped lang="scss">
.nlb {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.nlb__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.nlb__title {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--k-muted);
}

.nlb__rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.nlb__row {
  display: grid;
  grid-template-columns: 26px 22px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 5px 8px;
  border-radius: var(--k-r);
  font-size: 13px;
}

.nlb__row--me {
  background: color-mix(in srgb, var(--k-accent) 14%, transparent);
}

.nlb__place {
  color: var(--k-muted);
  text-align: right;
}

.nlb__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nlb__score {
  font-weight: 700;
}

.nlb__gap {
  padding: 0 8px 0 44px;
  color: var(--k-muted);
  line-height: 1;
}

.nlb__empty,
.nlb__error {
  margin: 0;
  font-size: 13px;
  color: var(--k-muted);
}

.nlb__error {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  color: var(--k-accent);
}
</style>
