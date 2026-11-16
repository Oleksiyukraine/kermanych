// «Дослідження» (docs/specs/2026-11-16-research-mode.md): which research the avatar window's
// panel shows, the list it picks from, and the signals the mascot reads. The sessions
// themselves are the orchestrator's (`kind: 'chat'`); this store only scopes and points.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useOrchestrator } from './orchestrator';
import { useProjects } from './projects';
import { useAssistantOverlay } from './assistant-overlay';
import { researchesIn, researchRunning, researchScopeIds } from '../lib/research';

export const useResearch = defineStore('research', () => {
  const store = useOrchestrator();
  const projects = useProjects();
  const overlay = useAssistantOverlay();

  // The research on screen. Survives the window closing (the panel stays mounted) and a
  // workspace switch picks another one (ResearchAssistant.vue).
  const selectedId = ref<string | undefined>(undefined);

  const scopeIds = computed(() =>
    researchScopeIds(
      { workspaceId: store.selectedWorkspaceId, projectId: store.selectedProjectId },
      { projects: projects.projects, listRead: projects.listRead },
      store.projectWorkspace,
    ),
  );
  const list = computed(() => researchesIn(store.sessions, scopeIds.value));
  const selected = computed(() => store.sessions.find((s) => s.id === selectedId.value && s.kind === 'chat'));

  // Any research answering, in any workspace: the mascot «thinks» and, when it ends with the
  // window closed, wears the unread dot (decision 8).
  const busy = computed(() => store.sessions.some((s) => s.kind === 'chat' && !s.archived && researchRunning(s)));

  // Open the window on this research — the voice pill's way back to the conversation it talks to.
  function open(id: string): void {
    selectedId.value = id;
    overlay.panel = 'research';
    overlay.show();
  }

  return { selectedId, scopeIds, list, selected, busy, open };
});
