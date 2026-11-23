<template>
  <!-- «Колеги онлайн» on the lounge's start screen (docs/specs/2026-11-23-lounge-multiplayer.md,
       decision 5): who of the workspace in the sidebar's scope has the lounge open, the rooms they
       host, and a room of one's own. -->
  <section class="ll" :aria-label="t('nailGame.lounge.title')">
    <h3 class="ll__title">{{ t('nailGame.lounge.title') }}</h3>
    <p v-if="!lounge.workspaceId" class="ll__note">
      {{ IS_PREVIEW ? t('nailGame.lounge.noCloud') : t('nailGame.lounge.noWorkspace') }}
    </p>
    <template v-else>
      <p v-if="failed" class="ll__error" role="alert">{{ t('nailGame.lounge.lobbyFailed') }}</p>
      <KSkeleton v-else-if="phase === 'skeleton'" variant="rows" :rows="2" />
      <template v-else-if="phase === 'ready'">
        <ul v-if="lounge.colleagues.length" class="ll__people">
          <li v-for="w in lounge.colleagues" :key="w.userId" class="ll__person">
            <img v-if="w.avatarUrl" class="ll__avatar" :src="w.avatarUrl" alt="" />
            <span v-else class="ll__avatar ll__avatar--blank" aria-hidden="true">{{ w.name.slice(0, 1) }}</span>
            {{ w.name }}
          </li>
        </ul>
        <p v-else class="ll__note">{{ t('nailGame.lounge.nobody') }}</p>
        <ul v-if="lounge.rooms.length" class="ll__rooms">
          <li v-for="card in lounge.rooms" :key="card.id" class="ll__room">
            <span class="ll__room-name">
              <b>{{ t('nailGame.lounge.roomOf', { name: card.host.name }) }}</b>
              <span class="ll__note">
                {{ t('nailGame.lounge.players', { count: card.players, max: LOUNGE_MAX_PLAYERS }) }}
                · {{ card.playing ? t('nailGame.lounge.playing') : t('nailGame.lounge.waiting') }}
              </span>
            </span>
            <KBtn
              variant="secondary"
              :loading="joining.busyFor(card.id)"
              :disabled="card.playing || card.players >= LOUNGE_MAX_PLAYERS || joining.anyBusy() || creating.busy.value"
              @click="joining.run(card.id, card)"
            >{{ t('nailGame.lounge.join') }}</KBtn>
          </li>
        </ul>
      </template>
      <div class="ll__actions">
        <KBtn
          variant="secondary"
          :loading="creating.busy.value"
          :disabled="failed || joining.anyBusy()"
          @click="creating.run()"
        >{{ t('nailGame.lounge.create') }}</KBtn>
        <span class="ll__note">{{ t('nailGame.lounge.createHint', { max: LOUNGE_MAX_PLAYERS }) }}</span>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import KBtn from 'components/kit/KBtn.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import { useAsyncAction, useKeyedAction } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import { LOUNGE_MAX_PLAYERS } from '../../lib/nail-game-net';
import { IS_PREVIEW } from '../../lib/preview';
import { useLounge, type LoungeRoomCard } from '../../stores/lounge';

const { t } = useI18n();
const lounge = useLounge();

const failed = computed(() => lounge.lobbyState === 'CHANNEL_ERROR' || lounge.lobbyState === 'TIMED_OUT');
const phase = useLoadPhase(() => lounge.windows === undefined);

const creating = useAsyncAction(() => lounge.createRoom());
const joining = useKeyedAction((_id: string, card: LoungeRoomCard) => lounge.joinRoom(card));
</script>

<style scoped lang="scss">
.ll {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--k-line);
}

.ll__title {
  margin: 0;
  font-size: 14px;
}

.ll__note {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--k-muted);
}

.ll__error {
  margin: 0;
  font-size: 12.5px;
  color: var(--k-accent);
}

.ll__people,
.ll__rooms {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ll__rooms {
  flex-direction: column;
}

.ll__person {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}

.ll__avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
}

.ll__avatar--blank {
  display: inline-grid;
  place-items: center;
  background: var(--k-line-strong);
  font-size: 11px;
  text-transform: uppercase;
}

.ll__room {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--k-line);
  border-radius: var(--k-r);
}

.ll__room-name {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  font-size: 13px;
}

.ll__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
