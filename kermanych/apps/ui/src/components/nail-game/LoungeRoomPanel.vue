<template>
  <!-- A room waiting for its round (docs/specs/2026-11-23-lounge-multiplayer.md, decisions 5–6):
       who is in it with their ping, «Почати» for the host, the wait for everyone else. -->
  <div class="lr">
    <h2 class="lr__title">{{ title }}</h2>
    <KSkeleton v-if="phase === 'skeleton'" variant="rows" :rows="2" />
    <ol v-else-if="room.members" class="lr__members">
      <li v-for="(m, i) in room.members" :key="m.clientId" class="lr__member" :class="{ 'lr__member--bench': i >= LOUNGE_MAX_PLAYERS }">
        <img v-if="m.avatarUrl" class="lr__avatar" :src="m.avatarUrl" alt="" />
        <span v-else class="lr__avatar lr__avatar--blank" aria-hidden="true">{{ m.name.slice(0, 1) }}</span>
        <span class="lr__name">
          {{ m.name }}
          <template v-if="m.clientId === lounge.clientId"> ({{ t('nailGame.you') }})</template>
        </span>
        <span class="lr__meta mono">
          <template v-if="m.host">{{ t('nailGame.lounge.host') }}</template>
          <template v-else-if="lounge.pings[m.clientId] !== undefined">{{ t('nailGame.lounge.ping', { ms: lounge.pings[m.clientId] }) }}</template>
        </span>
      </li>
    </ol>
    <p v-if="notice" class="lr__notice" role="status">{{ notice }}</p>
    <p v-if="benched" class="lr__note">{{ t('nailGame.lounge.full', { max: LOUNGE_MAX_PLAYERS }) }}</p>
    <p v-if="!room.isHost" class="lr__note">
      {{ lounge.roomPlaying ? t('nailGame.lounge.roundOn') : t('nailGame.lounge.waitHost', { name: hostName }) }}
    </p>
    <p v-else-if="(room.members?.length ?? 1) < 2" class="lr__note">{{ t('nailGame.lounge.waitGuests') }}</p>
    <div class="lr__actions">
      <KBtn v-if="room.isHost" variant="primary" :disabled="(room.members?.length ?? 1) < 2" @click="emit('start')">
        {{ t('nailGame.lounge.startRound') }}
      </KBtn>
      <KBtn variant="ghost" @click="emit('leave')">{{ t('nailGame.lounge.leaveRoom') }}</KBtn>
    </div>
    <p class="lr__note">{{ t('nailGame.lounge.notSaved') }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import KBtn from 'components/kit/KBtn.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import { useLoadPhase } from '../../composables/useLoadPhase';
import { LOUNGE_MAX_PLAYERS } from '../../lib/nail-game-net';
import { useLounge, type LoungeRoomView } from '../../stores/lounge';

const props = defineProps<{ room: LoungeRoomView; notice?: string | null | undefined }>();
const emit = defineEmits<{ start: []; leave: [] }>();

const { t } = useI18n();
const lounge = useLounge();

const phase = useLoadPhase(() => props.room.members === undefined);
const hostName = computed(() => props.room.members?.find((m) => m.host)?.name ?? '');
const title = computed(() =>
  props.room.isHost ? t('nailGame.lounge.yourRoom') : t('nailGame.lounge.roomOf', { name: hostName.value }),
);
const benched = computed(() => (props.room.members?.length ?? 0) > LOUNGE_MAX_PLAYERS);
</script>

<style scoped lang="scss">
.lr {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.lr__title {
  margin: 0;
  font-size: 22px;
  line-height: 1.2;
}

.lr__members {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lr__member {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.lr__member--bench {
  opacity: 0.5;
}

.lr__avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
}

.lr__avatar--blank {
  display: inline-grid;
  place-items: center;
  background: var(--k-line-strong);
  font-size: 12px;
  text-transform: uppercase;
}

.lr__name {
  flex: 1;
  min-width: 0;
}

.lr__meta {
  font-size: 11.5px;
  color: var(--k-muted);
}

.lr__note {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--k-muted);
}

.lr__notice {
  margin: 0;
  font-size: 13px;
  color: var(--k-accent);
}

.lr__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
