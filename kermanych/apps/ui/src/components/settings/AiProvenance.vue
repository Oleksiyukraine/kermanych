<template>
  <p v-if="createdBy || updatedBy" class="prov">
    <!-- A name the roster has not answered for yet is a skeleton, not «невідомо»: that word is
         reserved for an id the loaded roster really cannot name. -->
    <span class="prov__part">{{ t('aiTeam.provenance.author') }}
      <KSkeleton v-if="nameState(createdBy) === 'skeleton'" variant="avatar" width="12px" height="12px" class="prov__wait" />
      <template v-else-if="nameState(createdBy) === 'ready'">{{ label(createdBy) }}</template><span v-if="createdAt" class="prov__when"> · {{ date(createdAt) }}</span></span>
    <!-- The editor line is only worth its space once the row has actually been edited after
         it was created: same author and same timestamp means nothing changed hands. -->
    <span v-if="edited" class="prov__part">{{ t('aiTeam.provenance.editor') }}
      <KSkeleton v-if="nameState(updatedBy) === 'skeleton'" variant="avatar" width="12px" height="12px" class="prov__wait" />
      <template v-else-if="nameState(updatedBy) === 'ready'">{{ label(updatedBy) }}</template><span v-if="updatedAt" class="prov__when"> · {{ date(updatedAt) }}</span></span>
  </p>
</template>

<script setup lang="ts">
// Who authored a «ШІ-команда» entity and who last edited it, resolved to handles. The ids are
// cloud user uuids; a handle needs the workspace's member list, which this loads on demand for
// the entity's owner. The signed-in operator is named directly from the auth store, so a
// user-scoped entity (with no workspace to read members from) still reads «ви».
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AiOwner } from '@kermanych/cloud';
import { useAuth } from 'stores/auth';
import { useProjects } from 'stores/projects';
import KSkeleton from 'components/kit/KSkeleton.vue';
import { useLoadPhase, type LoadPhase } from '../../composables/useLoadPhase';

const props = defineProps<{
  owner: AiOwner;
  createdAt?: string | undefined;
  createdBy?: string | undefined;
  updatedAt?: string | undefined;
  updatedBy?: string | undefined;
}>();

const { t, locale } = useI18n();
const auth = useAuth();
const projects = useProjects();

// The workspace whose members can name these ids. A project reads its workspace's roster; a
// workspace names its own; a user-scoped entity has no roster (only its owner can see it, and
// that owner is the signed-in operator).
const workspaceId = computed(() =>
  props.owner.scope === 'workspace'
    ? props.owner.id
    : props.owner.scope === 'project'
      ? projects.byId.get(props.owner.id)?.workspaceId
      : undefined,
);

// The workspace whose roster read failed here: its ids settle on «невідомо» instead of waiting.
const failedFor = ref<string>();

// Load the roster once per workspace; a failure just leaves ids unresolved rather than blocking
// the pane. `members` is a shared store cache, so a second entity in the same workspace reuses it.
watch(
  workspaceId,
  (id) => {
    if (id && !projects.members[id]) {
      projects.loadMembers(id).catch(() => {
        failedFor.value = id;
      });
    }
  },
  { immediate: true },
);

// The roster this entity needs is still on its way (not loaded, not failed).
const rosterLoading = computed(() => {
  const id = workspaceId.value;
  return !!id && projects.members[id] === undefined && failedFor.value !== id;
});
const rosterPhase = useLoadPhase(() => rosterLoading.value);

// The signed-in operator and an absent id never wait on the roster; any other id does.
function nameState(id?: string): LoadPhase {
  if (!id || id === auth.user?.id) return 'ready';
  return rosterPhase.value;
}

const edited = computed(
  () => !!props.updatedBy && (props.updatedBy !== props.createdBy || props.updatedAt !== props.createdAt),
);

function label(id?: string): string {
  if (!id) return t('aiTeam.provenance.unknown');
  if (id === auth.user?.id) {
    return auth.profile?.githubUsername ? `@${auth.profile.githubUsername}` : t('aiTeam.provenance.you');
  }
  const wsId = workspaceId.value;
  const member = wsId ? projects.members[wsId]?.find((m) => m.userId === id) : undefined;
  if (member?.profile?.githubUsername) return `@${member.profile.githubUsername}`;
  if (member?.profile?.displayName) return member.profile.displayName;
  return t('aiTeam.provenance.unknown');
}

function date(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(locale.value);
}
</script>

<style scoped lang="scss">
.prov {
  margin: 6px 0 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 11px;
  color: var(--k-faint);
}
.prov__when {
  color: var(--k-faint);
}
.prov__wait {
  vertical-align: middle;
}
</style>
