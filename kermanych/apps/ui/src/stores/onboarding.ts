// apps/ui/src/stores/onboarding.ts
import { defineStore } from 'pinia';
import { computed, ref, shallowRef, watch } from 'vue';
import { useAuth } from './auth';
import { useProjects } from './projects';
import { useOrchestrator } from './orchestrator';
import { IS_PREVIEW } from '../lib/preview';

// The first run (docs/specs/2026-11-18-first-run-and-project-wizard.md). Two surfaces share
// this store:
//
// - the welcome screen and the project wizard (components/onboarding/WelcomeScreen.vue,
//   ProjectWizard.vue): workspace → project → folder on this machine. The wizard is hosted once,
//   by MainLayout, and opened from anywhere through `openWizard`;
// - the «Розпочати» checklist (design/onboarding.html), which takes over once a project is
//   bound here and points at the surfaces where the rest lives. Completion is NOT a set of
//   manual toggles: the step that has an objective answer (a session has run) reads it off the
//   store that owns it. Only the steps whose "done" is "I have seen this surface" are
//   acknowledgements, and those are persisted.

export interface OnboardingRoute {
  name: string;
  params?: Record<string, string>;
}

export interface OnboardingCard {
  key: string;
  // `auto` reads done off real state and cannot be toggled by hand; `ack` is a persisted
  // "I've seen it" tick the operator owns.
  kind: 'auto' | 'ack';
  // Where the card's button goes.
  route: OnboardingRoute;
}

export interface OnboardingGroup {
  key: string;
  // «обовʼязково» in the design; the others are «за потреби».
  required: boolean;
  cards: OnboardingCard[];
}

// The checklist itself. i18n keys are derived from these ids at the callsite
// (`onboarding.checklist.groups.<group>.cards.<card>.*`), so adding a step is one row here
// plus its strings in both locales. Connecting the code is the wizard's job, not a group here.
export const ONBOARDING_GROUPS: readonly OnboardingGroup[] = [
  {
    key: 'run',
    required: true,
    cards: [
      { key: 'task', kind: 'auto', route: { name: 'agents' } },
      { key: 'watch', kind: 'ack', route: { name: 'agents' } },
      { key: 'diff', kind: 'ack', route: { name: 'agents' } },
      { key: 'accept', kind: 'ack', route: { name: 'agents' } },
    ],
  },
  {
    key: 'teach',
    required: false,
    cards: [
      { key: 'skill', kind: 'ack', route: { name: 'ai-team', params: { section: 'skills' } } },
      { key: 'trigger', kind: 'ack', route: { name: 'ai-team', params: { section: 'triggers' } } },
      { key: 'helper', kind: 'ack', route: { name: 'ai-team', params: { section: 'helpers' } } },
    ],
  },
  {
    key: 'team',
    required: false,
    cards: [
      { key: 'invite', kind: 'ack', route: { name: 'settings', params: { section: 'workspace-members' } } },
      { key: 'jira', kind: 'ack', route: { name: 'management-integrations' } },
    ],
  },
];

const ALL_CARDS: readonly OnboardingCard[] = ONBOARDING_GROUPS.flatMap((g) => g.cards);
const CARD_KEYS: ReadonlySet<string> = new Set(ALL_CARDS.map((c) => c.key));

// What the hosted project wizard is asked to do. `create` makes a new cloud project in a
// workspace; `connect` brings an existing one onto this machine. `doneLabel` / `onDone` let a
// caller that opened it in the middle of something (the board's «Запустити») name and run its
// own next step instead of the default «Поставити першу задачу».
export type ProjectWizardRequest =
  | { mode: 'create'; workspaceId: string }
  | { mode: 'connect'; projectId: string; doneLabel?: string; onDone?: (projectId: string) => void };

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

  // The localStorage key contract, stamped per account (uid, or 'anon' when signed out) so
  // two accounts on one origin never inherit each other's progress.
  const ackKey = (): string => `kermanych.onboarding.ack.${auth.user?.id ?? 'anon'}`;
  const dismissKey = (): string => `kermanych.onboarding.dismissed.${auth.user?.id ?? 'anon'}`;

  function loadPersisted(): void {
    try {
      const raw = localStorage.getItem(ackKey());
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      // Keys of cards that no longer exist (the old «connect» group's `token`) are dropped, so
      // they neither count nor come back if a card of that name returns with another meaning.
      ack.value = Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === 'string' && CARD_KEYS.has(x))
        : [];
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
    () => loadPersisted(),
    { immediate: true },
  );

  // Objective progress, read off the stores that own it. `hasProject` accepts either source:
  // the cloud list is authoritative online, the local mirror is what survives an offline boot.
  const hasWorkspace = computed(() => projects.workspaces.length > 0);
  const hasProject = computed(() => projects.projects.length > 0 || orch.projects.length > 0);
  const hasFolder = computed(() => orch.projects.some((p) => !!p.localRepoPath));
  const hasSession = computed(() => orch.sessions.length > 0);

  // The honest readiness gate: an agent can only run once there is a workspace, a project and
  // a bound folder.
  const readyToLaunch = computed(() => hasWorkspace.value && hasProject.value && hasFolder.value);

  // What the welcome screen in the centre of «Агенти» shows (decision 2), or null once a
  // project is bound here and there is something to work with. A bound folder settles it at
  // once, from the local snapshot alone; everything else waits for the cloud lists, so a
  // returning account never sees «create a workspace» flash up before its workspaces arrive.
  // `offline`: the cloud did not answer and nothing cached says what the account has.
  const welcomeState = computed<'loading' | 'offline' | 'no-workspace' | 'no-project' | 'connect' | null>(() => {
    if (!orch.snapshotReceived) return 'loading';
    if (hasFolder.value) return null;
    if (!IS_PREVIEW && !projects.loadSettled) return 'loading';
    if (!hasWorkspace.value) return projects.offlineError && !projects.listRead ? 'offline' : 'no-workspace';
    if (!hasProject.value) return 'no-project';
    return 'connect';
  });

  function isDone(card: OnboardingCard): boolean {
    if (card.kind === 'auto' && card.key === 'task') return hasSession.value;
    return ack.value.includes(card.key);
  }

  function groupDone(group: OnboardingGroup): number {
    return group.cards.filter((c) => isDone(c)).length;
  }

  const totalCount = ALL_CARDS.length;
  const doneCount = computed(() => ALL_CARDS.filter((c) => isDone(c)).length);
  // What «обовʼязково» still holds, for the checklist's «ще N обовʼязкових».
  const requiredLeft = computed(
    () => ONBOARDING_GROUPS.filter((g) => g.required).flatMap((g) => g.cards).filter((c) => !isDone(c)).length,
  );

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

  // The sidebar's «Розпочати» appears once a project is bound on this machine — before that
  // the welcome screen is the guide — and stays until the account permanently dismisses it, so
  // a finished-but-not-dismissed account can still reopen it.
  const sidebarVisible = computed(() => !!auth.user && !dismissed.value && hasFolder.value);

  // The hosted project wizard. A shallowRef: the request may carry a callback, which has no
  // business being made deeply reactive. `wizardSeq` keys the host, so every open starts the
  // wizard from its first step with nothing left over from the last one.
  const wizard = shallowRef<ProjectWizardRequest | null>(null);
  const wizardSeq = ref(0);

  function openWizard(req: ProjectWizardRequest): void {
    wizard.value = req;
    wizardSeq.value++;
  }

  function closeWizard(): void {
    wizard.value = null;
  }

  // The welcome screen's «Створити воркспейс»: the create-workspace modal lives in MainLayout,
  // which watches this counter, opens it, and follows a successful create with the wizard.
  const createWorkspaceAsked = ref(0);

  function askCreateWorkspace(): void {
    createWorkspaceAsked.value++;
  }

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
    requiredLeft,
    sidebarVisible,
    isDone,
    groupDone,
    toggleAck,
    markAck,
    show,
    hide,
    dismiss,
    welcomeState,
    wizard,
    wizardSeq,
    openWizard,
    closeWizard,
    createWorkspaceAsked,
    askCreateWorkspace,
  };
});
