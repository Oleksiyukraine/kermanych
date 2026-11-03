// apps/ui/src/composables/useAiAgentRows.ts
// The agent override rows and skill assignments of one or more owners, read together — what
// «ШІ-команда → Агенти» resolves the list marks and a project's read-only agent page from
// (docs/specs/2026-11-03-ai-team-agent-pages.md, decision 1). The rows of every owner land in one
// pair of arrays; lib/ai-team.ts resolveAgent picks the winning scope per agent, as a launch does.
import { ref, watch } from 'vue';
import { listAiAgentSkills, listAiAgents, type AiAgent, type AiAgentSkill, type AiOwner } from '@kermanych/cloud';
import { useAuth } from 'stores/auth';
import { errorText } from './useAsyncAction';

/**
 * The owners a page about one subject reads: a project sees its own rows over its workspace's,
 * a workspace only its own. A project with no workspace has only its own rows (and the defaults).
 */
export function agentOwners(owner: AiOwner, workspaceId: string | undefined): AiOwner[] {
  return owner.scope === 'project' && workspaceId ? [owner, { scope: 'workspace', id: workspaceId }] : [owner];
}

export function useAiAgentRows(owners: () => readonly AiOwner[]) {
  const auth = useAuth();
  const agents = ref<AiAgent[]>([]);
  const skills = ref<AiAgentSkill[]>([]);
  const loaded = ref(false);
  const error = ref('');

  const keyOf = (): string => owners().map((o) => `${o.scope}:${o.id}`).join(',');

  // Bumped per read: only the newest may paint, so a late reply for owners the operator has since
  // left never lands on the new ones.
  let run = 0;
  async function load(): Promise<void> {
    const mine = ++run;
    error.value = '';
    try {
      const parts = await Promise.all(
        owners().map((o) => Promise.all([listAiAgents(auth.client, o), listAiAgentSkills(auth.client, o)])),
      );
      if (mine !== run) return;
      agents.value = parts.flatMap((p) => p[0]);
      skills.value = parts.flatMap((p) => p[1]);
      loaded.value = true;
    } catch (e) {
      if (mine !== run) return;
      // All or nothing: half the scopes would resolve to a wrong winner.
      agents.value = [];
      skills.value = [];
      loaded.value = false;
      error.value = errorText(e);
    }
  }

  watch(
    keyOf,
    () => {
      agents.value = [];
      skills.value = [];
      loaded.value = false;
      void load();
    },
    { immediate: true },
  );

  return { agents, skills, loaded, error, reload: load };
}
