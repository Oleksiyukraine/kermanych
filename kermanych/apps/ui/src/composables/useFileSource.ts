// Which folder the file-manager dock (KFileManager) browses, and the footer's path read-out with
// it. A session's work lives in its worktree, so the dock shows that, not the project checkout:
// the selected session's tree; with no session selected, the tree of an agent at work in the
// project (else the checkout). When the project offers more than one tree — the checkout and
// its agents' worktrees — the dock shows a selector over all of them (`options`).
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ACTIVE_STATUSES, type Session } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';

// `session`: read through the session's api (its cwd, its ± against the base); `project`: the
// project's checkout, which has no base.
export type FileSource = { kind: 'session' | 'project'; id: string };
export type FileSourceOption = { key: string; label: string; path: string; source: FileSource };

const CHECKOUT = 'checkout';

export function useFileSource() {
  const store = useOrchestrator();
  const { t } = useI18n();

  const selectedSession = computed(() => store.sessions.find((s) => s.id === store.selectedSessionId));
  const projectId = computed(() => selectedSession.value?.projectId ?? store.selectedProjectId);
  const project = computed(() => store.projects.find((p) => p.id === projectId.value));

  // A retired worktree keeps `worktree: true` but loses its `worktreePath`; there is no
  // directory to read.
  const worktreeGone = computed(() => !!selectedSession.value?.worktree && !selectedSession.value.worktreePath);
  // Without a session the project's checkout is read, which needs a local binding.
  const projectUnbound = computed(() => !selectedSession.value && !!project.value && !project.value.localRepoPath);

  // Every tree of the project, one row per folder: a tester or a review runs in its doer's
  // worktree, so a path shared by several sessions is listed once — under the selected session
  // when it is one of them, so the ± stays its own.
  const options = computed<FileSourceOption[]>(() => {
    const p = project.value;
    if (!p) return [];
    const sel = selectedSession.value;
    const rows: FileSourceOption[] = [];
    if (p.localRepoPath) {
      // An in-place session works in the checkout itself: read it through the session, for its ±.
      const inPlace = sel && !sel.worktree ? sel : undefined;
      rows.push({
        key: CHECKOUT,
        label: t('fileManager.checkout'),
        path: p.localRepoPath,
        source: inPlace ? { kind: 'session', id: inPlace.id } : { kind: 'project', id: p.id },
      });
    }
    const byPath = new Map<string, Session>();
    for (const s of store.sessions) {
      if (s.projectId !== p.id || !s.worktreePath || s.status === 'merged') continue;
      const held = byPath.get(s.worktreePath);
      if (!held || s.id === sel?.id || (held.kind !== 'agent' && s.kind === 'agent' && held.id !== sel?.id)) {
        byPath.set(s.worktreePath, s);
      }
    }
    for (const [path, s] of byPath) {
      rows.push({ key: path, label: s.branch || s.name, path, source: { kind: 'session', id: s.id } });
    }
    return rows;
  });

  // What the selection alone points at, before any pick.
  const defaultKey = computed<string | null>(() => {
    const sel = selectedSession.value;
    if (sel) {
      if (sel.worktreePath) return sel.worktreePath;
      return sel.worktree ? null : CHECKOUT;
    }
    if (!project.value || projectUnbound.value) return null;
    const working = store.sessions.find(
      (s) => s.projectId === project.value?.id && !!s.worktreePath && ACTIVE_STATUSES.includes(s.status),
    );
    return working?.worktreePath ?? CHECKOUT;
  });

  // The pick holds only under the selection it was made in, and only while its tree is listed.
  const scope = computed(() => `${projectId.value ?? ''}:${store.selectedSessionId ?? ''}`);
  const currentKey = computed<string | null>(() => {
    const pick = store.fileSourcePick;
    if (pick && pick.scope === scope.value && options.value.some((o) => o.key === pick.key)) return pick.key;
    return defaultKey.value;
  });
  const current = computed(() => options.value.find((o) => o.key === currentKey.value) ?? null);

  // The selected in-place session reads through its own api even off the options list (a
  // project without a binding has no checkout row, but the session still has a cwd).
  const source = computed<FileSource | null>(() => {
    if (current.value) return current.value.source;
    const sel = selectedSession.value;
    if (sel && !worktreeGone.value) return { kind: 'session', id: sel.id };
    return null;
  });

  function pick(key: string): void {
    store.pickFileSource(scope.value, key);
  }

  return {
    selectedSession,
    project,
    worktreeGone,
    projectUnbound,
    options,
    currentKey,
    current,
    source,
    pick,
  };
}
