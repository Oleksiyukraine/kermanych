// apps/ui/src/stores/onboarding.ts
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { useAuth } from './auth';
import { useProjects } from './projects';
import { useOrchestrator } from './orchestrator';

// The first-run checklist (design/onboarding.html). It steers a brand-new account through the
// one path that makes any agent work possible — workspace → project → local folder — and then
// points at the surfaces where the rest lives. Completion is NOT a set of manual toggles: the
// steps that have an objective answer (a workspace exists, a project exists, a folder is bound,
// a session has run) read it off the two stores that already own that truth. Only the steps
// whose "done" is "I have seen this surface" are acknowledgements, and those are persisted.
//
// Everything shared between the sidebar entry and the modal — open state, the ack set, the
// permanent dismissal — lives here so the two never disagree about what the account has done.

// What a card's primary button does. The three setup acts reuse MainLayout's own modals (the
// component emits them upward); `nav` routes to a surface the component can reach on its own.
export type OnboardingActionKind = 'create-workspace' | 'create-project' | 'bind-folder' | 'nav';

export interface OnboardingRoute {
  name: string;
  params?: Record<string, string>;
}

export interface OnboardingCard {
  key: string;
  // `auto` reads done off real state and cannot be toggled by hand; `ack` is a persisted
  // "I've seen it" tick the operator owns.
  kind: 'auto' | 'ack';
  action: OnboardingActionKind;
  route?: OnboardingRoute;
}

export interface OnboardingGroup {
  key: string;
  // The first two groups are what the design marks «обовʼязково»; the last two «за потреби».
  required: boolean;
  cards: OnboardingCard[];
}

// The checklist itself. i18n keys are derived from these ids at the callsite
// (`onboarding.checklist.groups.<group>.cards.<card>.*`), so adding a step is one row here
// plus its strings in both locales.
export const ONBOARDING_GROUPS: readonly OnboardingGroup[] = [
  {
    key: 'connect',
    required: true,
    cards: [
      { key: 'ws', kind: 'auto', action: 'create-workspace' },
      { key: 'repo', kind: 'auto', action: 'create-project' },
      { key: 'folder', kind: 'auto', action: 'bind-folder' },
      { key: 'token', kind: 'ack', action: 'nav', route: { name: 'settings', params: { section: 'project-env' } } },
    ],
  },
  {
    key: 'run',
    required: true,
    cards: [
      { key: 'task', kind: 'auto', action: 'nav', route: { name: 'agents' } },
      { key: 'watch', kind: 'ack', action: 'nav', route: { name: 'agents' } },
      { key: 'diff', kind: 'ack', action: 'nav', route: { name: 'agents' } },
      { key: 'accept', kind: 'ack', action: 'nav', route: { name: 'agents' } },
    ],
  },
  {
    key: 'teach',
    required: false,
    cards: [
      { key: 'skill', kind: 'ack', action: 'nav', route: { name: 'ai-team', params: { section: 'skills' } } },
      { key: 'trigger', kind: 'ack', action: 'nav', route: { name: 'ai-team', params: { section: 'triggers' } } },
      { key: 'helper', kind: 'ack', action: 'nav', route: { name: 'ai-team', params: { section: 'helpers' } } },
    ],
  },
  {
    key: 'team',
    required: false,
    cards: [
      { key: 'invite', kind: 'ack', action: 'nav', route: { name: 'settings', params: { section: 'workspace-members' } } },
      { key: 'jira', kind: 'ack', action: 'nav', route: { name: 'management-integrations' } },
    ],
  },
];

const ALL_CARDS: readonly OnboardingCard[] = ONBOARDING_GROUPS.flatMap((g) => g.cards);

export const useOnboarding = defineStore('onboarding', () => {
  const auth = useAuth();
  const projects = useProjects();
  const orch = useOrchestrator();

  // Whether the modal is on screen. The ack set and the permanent dismissal are per ACCOUNT:
  // localStorage is per origin, so two accounts on one machine share the key space and a bare
  // key would carry one account's progress onto another's — the same stamp-by-uid rule the
  // workspace-tree cache follows (stores/projects.ts).
  const open = ref(false);
  const ack = ref<string[]>([]);
  const dismissed = ref(false);
  // Auto-open fires at most once per account load, so closing the modal does not bounce it back.
  let autoShown = false;

  // The localStorage key contract, stamped per account (uid, or 'anon' when signed out) so
  // two accounts on one origin never inherit each other's progress.
  const ackKey = (): string => `kermanych.onboarding.ack.${auth.user?.id ?? 'anon'}`;
  const dismissKey = (): string => `kermanych.onboarding.dismissed.${auth.user?.id ?? 'anon'}`;

  function loadPersisted(): void {
    try {
      const raw = localStorage.getItem(ackKey());
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      ack.value = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      // A corrupt entry is not worth a crash; the next tick overwrites it.
      ack.value = [];
    }
    dismissed.value = localStorage.getItem(dismissKey()) === '1';
  }

  // Re-read on every account change. This store is instantiated once the layout mounts, by
  // which point the router guard has already resolved `auth.user`, so the immediate run reads
  // the signed-in account rather than `anon`.
  watch(
    () => auth.user?.id,
    () => {
      autoShown = false;
      loadPersisted();
    },
    { immediate: true },
  );

  // Objective progress, read off the stores that own it. `hasProject` accepts either source:
  // the cloud list is authoritative online, the local mirror is what survives an offline boot.
  const hasWorkspace = computed(() => projects.workspaces.length > 0);
  const hasProject = computed(() => projects.projects.length > 0 || orch.projects.length > 0);
  const hasFolder = computed(() => orch.projects.some((p) => !!p.localRepoPath));
  const hasSession = computed(() => orch.sessions.length > 0);

  // The honest readiness gate: an agent can only run once there is a workspace, a project and
  // a bound folder. The «run» group's cards are guidance, not part of this — a first task is
  // possible the moment these three are true.
  const readyToLaunch = computed(() => hasWorkspace.value && hasProject.value && hasFolder.value);

  function isDone(card: OnboardingCard): boolean {
    if (card.kind === 'ack') return ack.value.includes(card.key);
    switch (card.key) {
      case 'ws':
        return hasWorkspace.value;
      case 'repo':
        return hasProject.value;
      case 'folder':
        return hasFolder.value;
      case 'task':
        return hasSession.value;
      default:
        return ack.value.includes(card.key);
    }
  }

  function groupDone(group: OnboardingGroup): number {
    return group.cards.filter((c) => isDone(c)).length;
  }

  const totalCount = ALL_CARDS.length;
  const doneCount = computed(() => ALL_CARDS.filter((c) => isDone(c)).length);

  function persistAck(): void {
    try {
      localStorage.setItem(ackKey(), JSON.stringify(ack.value));
    } catch {
      /* storage full or blocked: progress just won't survive a reload */
    }
  }

  function toggleAck(key: string): void {
    ack.value = ack.value.includes(key) ? ack.value.filter((k) => k !== key) : [...ack.value, key];
    persistAck();
  }

  function markAck(key: string): void {
    if (ack.value.includes(key)) return;
    ack.value = [...ack.value, key];
    persistAck();
  }

  function show(): void {
    open.value = true;
  }

  function hide(): void {
    open.value = false;
  }

  function dismiss(): void {
    dismissed.value = true;
    try {
      localStorage.setItem(dismissKey(), '1');
    } catch {
      /* see persistAck */
    }
    open.value = false;
  }

  // Open the checklist on first sight of a fresh account: signed in, not permanently
  // dismissed, and not yet able to launch. The caller gates on `auth.runtime` first so the
  // one-time runtime picker (MainLayout) is answered before this stacks over it.
  function maybeAutoOpen(): void {
    if (autoShown) return;
    autoShown = true;
    if (!auth.user) return;
    if (dismissed.value) return;
    if (readyToLaunch.value) return;
    open.value = true;
  }

  // The sidebar keeps its «Розпочати» entry until the account permanently dismisses the
  // checklist — the design's «лишається в панелі, поки не пройдений», widened to "or hidden",
  // so a finished-but-not-dismissed account can still reopen it.
  const sidebarVisible = computed(() => !!auth.user && !dismissed.value);

  return {
    open,
    ack,
    dismissed,
    hasWorkspace,
    hasProject,
    hasFolder,
    hasSession,
    readyToLaunch,
    totalCount,
    doneCount,
    sidebarVisible,
    isDone,
    groupDone,
    toggleAck,
    markAck,
    show,
    hide,
    dismiss,
    maybeAutoOpen,
  };
});
