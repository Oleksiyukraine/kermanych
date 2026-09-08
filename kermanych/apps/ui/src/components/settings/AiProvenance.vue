<template>
  <p v-if="createdBy || updatedBy" class="prov">
    <span class="prov__part">{{ t('aiTeam.provenance.author') }} {{ label(createdBy) }}<span v-if="createdAt" class="prov__when"> · {{ date(createdAt) }}</span></span>
    <!-- The editor line is only worth its space once the row has actually been edited after
         it was created: same author and same timestamp means nothing changed hands. -->
    <span v-if="edited" class="prov__part">{{ t('aiTeam.provenance.editor') }} {{ label(updatedBy) }}<span v-if="updatedAt" class="prov__when"> · {{ date(updatedAt) }}</span></span>
  </p>
</template>

<script setup lang="ts">
// Who authored a «ШІ-команда» entity and who last edited it, resolved to handles. The ids are
// cloud user uuids; a handle needs the workspace's member list, which this loads on demand for
// the entity's owner. The signed-in operator is named directly from the auth store, so a
// user-scoped entity (with no workspace to read members from) still reads «ви».
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AiOwner } from '@kermanych/cloud';
import { useAuth } from 'stores/auth';
import { useProjects } from 'stores/projects';

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

// Load the roster once per workspace; a failure just leaves ids unresolved rather than blocking
// the pane. `members` is a shared store cache, so a second entity in the same workspace reuses it.
watch(
  workspaceId,
  (id) => {
    if (id && !projects.members[id]) void projects.loadMembers(id).catch(() => undefined);
  },
  { immediate: true },
);

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
</style>
