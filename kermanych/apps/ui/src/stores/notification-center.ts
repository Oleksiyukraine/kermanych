// apps/ui/src/stores/notification-center.ts
// ЦУК's «Центр сповіщень» (docs/specs/2026-11-04-skill-self-improvement.md, decision 6): what the
// operator should hear about, in the avatar window's left column. Two sources, one feed by time
// (docs/specs/2026-11-06-scheduled-tasks.md, decision 6):
// - a skill an agent improved in the operator's personal layer, read from the cloud
//   (`skill_improvements`) once after sign-in and kept current by a Realtime binding on the
//   operator's own rows. A change an agent made on another machine (a «Посіпака» box) therefore
//   arrives here too, with its toast;
// - this machine's schedule slips (stores/schedules.ts): a reminder fired, an agent run ended, a
//   run skipped or failed. Each that arrives gets a toast, a Dock bounce and, while the window is
//   unfocused, a system notification.
// The column's head also switches to «Розклад», the task list; what the column opens over the
// console (an improvement, a slip's full answer, a task) is held here, one at a time.
//
// Egress is the hosted project's scarce resource (docs/specs/2026-11-03-board-egress-and-lag.md):
// the list and the binding carry light columns; a record's text is read only when its entry is
// opened, a rollback is planned or a share made.
//
// Rollback and sharing run here, in the browser, under the operator's JWT — like every other
// library write from the UI. RLS is the gate: a share to a scope the caller does not own fails.

import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import {
  deleteAiSkill,
  getAiSkill,
  getSkillImprovement,
  listAppliedSkillImprovements,
  listSkillImprovementEntries,
  markSkillImprovementsSeen,
  setSkillImprovementState,
  subscribeSkillImprovements,
  upsertAiSkill,
  type AiOwner,
  type SkillImprovementChange,
} from '@kermanych/cloud';
import {
  DEFAULT_SKILLS,
  SKILL_IMPROVEMENTS_KEEP,
  copyOrigin,
  rollbackPlan,
  shareTarget,
  type ScheduleSlip,
  type SkillImprovement,
  type SkillImprovementEntry,
  type SkillImprovementState,
  type SkillRollbackPlan,
  type SkillShareTarget,
} from '@kermanych/core';
import { useAuth } from './auth';
import { useOrchestrator } from './orchestrator';
import { useAssistantOverlay } from './assistant-overlay';
import { useSchedules } from './schedules';
import { IS_PREVIEW } from '../lib/preview';
import { globalTr } from '../boot/i18n';
import { bounceDock } from '../lib/dock';
import { reasonText } from '../lib/schedules';
import { isUnseen, mergeFeed, type NotificationItem } from '../lib/notification-feed';
import { useAppUpdate } from './app-update';

export type { NotificationItem };

/** One cloud row of the column. */
export type SkillImprovementItem = Extract<NotificationItem, { kind: 'skill-improvement' }>;

/** The column's two tabs: the feed, and the scheduled tasks. */
export type NotificationTab = 'feed' | 'schedule';

export type NotificationPhase = 'idle' | 'loading' | 'ready' | 'error';

/** What the entry view shows: the whole record, and whether the team text moved under the copy. */
export type SkillImprovementDetail = { record: SkillImprovement; teamChanged: boolean };

/** A rollback the operator is about to confirm, with the personal copy's description to keep. */
export type PlannedRollback = { plan: SkillRollbackPlan; description: string };

/** A share the operator is about to confirm. `teamChanged`: sharing would overwrite a newer team text. */
export type PlannedShare = {
  target: SkillShareTarget;
  chain: SkillImprovement[];
  text: string;
  description: string;
  teamChanged: boolean;
};

// Long enough to read a skill name and a summary and reach for «Переглянути».
const TOAST_MS = 10_000;

export const useNotificationCenter = defineStore('notification-center', () => {
  const auth = useAuth();
  const ui = useOrchestrator();
  const overlay = useAssistantOverlay();
  const schedules = useSchedules();
  const appUpdate = useAppUpdate();

  // The cloud rows. Newest first, at most SKILL_IMPROVEMENTS_KEEP: the cloud keeps no more, so
  // neither does the column.
  const items = ref<SkillImprovementItem[]>([]);
  const phase = ref<NotificationPhase>('idle');
  const error = ref('');
  // The improvement the view over the console shows; undefined while it is closed.
  const openId = ref<string | undefined>(undefined);
  // A slip's full answer (a run without a project, decision 9), or a scheduled task, shown over
  // the console instead. At most one of the three views is open.
  const openSlipId = ref<string | undefined>(undefined);
  const openTaskId = ref<string | undefined>(undefined);
  const viewOpen = computed(() => !!(openId.value || openSlipId.value || openTaskId.value));
  // Which tab the column's head shows.
  const tab = ref<NotificationTab>('feed');
  // Opened entries, by id. A record's text never changes; its state is patched from Realtime.
  const details = ref<Record<string, SkillImprovementDetail>>({});

  // The one feed: cloud improvements, local slips and local app updates by time (lib/notification-feed.ts).
  const feed = computed(() => mergeFeed(items.value.map((i) => i.entry), schedules.slips ?? [], appUpdate.updates));
  const unread = computed(() => feed.value.filter(isUnseen).length);

  let started = false;
  // Bumped by every (re)bind, so a read that lands after a sign-out or a user switch is dropped.
  let generation = 0;
  let stopChannel: (() => void) | undefined;

  function owner(): AiOwner {
    const id = auth.user?.id;
    if (!id) throw new Error(globalTr.t('common.notify.signInFirst'));
    return { scope: 'user', id };
  }

  function patch(ids: readonly string[], change: Partial<SkillImprovementEntry>): void {
    const set = new Set(ids);
    items.value = items.value.map((i) => (set.has(i.entry.id) ? { ...i, entry: { ...i.entry, ...change } } : i));
    for (const id of ids) {
      const d = details.value[id];
      if (d) details.value = { ...details.value, [id]: { ...d, record: { ...d.record, ...change } } };
    }
  }

  function toast(entry: SkillImprovementEntry): void {
    ui.notify(
      globalTr.t('cuk.notifications.toast', { skill: entry.skillName, summary: entry.summary }),
      'info',
      TOAST_MS,
      { label: globalTr.t('cuk.notifications.view'), run: () => open(entry.id) },
    );
  }

  // A slip that arrived (spec «Defaults → Notifications»): the toast with «Переглянути», a Dock
  // bounce, and a system notification while the window is unfocused or hidden — the pair the
  // watchdog and «Посіпака» use. An unsigned build, where macOS refuses the notification, keeps
  // the rest.
  function announceSlip(slip: ScheduleSlip): void {
    const t = globalTr.t.bind(globalTr);
    const failed = slip.status === 'skipped' || slip.status === 'failed';
    const body = failed ? reasonText(t, slip.reason, slip.text) : slip.text;
    const message =
      slip.kind === 'reminder'
        ? t('cuk.notifications.slip.toastReminder', { text: body })
        : t(failed ? 'cuk.notifications.slip.toastFailed' : 'cuk.notifications.slip.toastRun', { name: slip.scheduleName, text: body });
    ui.notify(message, failed ? 'error' : 'info', TOAST_MS, { label: t('cuk.notifications.view'), run: () => viewSlip(slip) });
    bounceDock();
    if (typeof document !== 'undefined' && (!document.hasFocus() || document.hidden) && typeof Notification !== 'undefined') {
      const title = slip.kind === 'reminder' ? t('cuk.schedule.kind.reminder') : slip.scheduleName;
      const n = new Notification(title, { body });
      n.onclick = () => {
        window.kermanych?.focus();
        viewSlip(slip);
      };
    }
  }

  // «Переглянути» on a slip: a run without a project opens its full answer; any other slip opens
  // the window on the feed, where it sits on top.
  function viewSlip(slip: ScheduleSlip): void {
    if (slip.body && !slip.sessionId) {
      openSlip(slip.id);
      return;
    }
    close();
    tab.value = 'feed';
    overlay.show();
  }

  // A Realtime change. An INSERT is news: it joins the column and raises the toast. An UPDATE is
  // a state or seen change made elsewhere (another machine, or this window's own write echoing).
  function onChange(change: SkillImprovementChange): void {
    const { entry } = change;
    if (items.value.some((i) => i.entry.id === entry.id)) {
      patch([entry.id], entry);
      return;
    }
    if (change.kind !== 'insert') return;
    items.value = [{ kind: 'skill-improvement' as const, entry }, ...items.value].slice(0, SKILL_IMPROVEMENTS_KEEP);
    toast(entry);
  }

  async function bind(uid: string | undefined): Promise<void> {
    const mine = ++generation;
    stopChannel?.();
    stopChannel = undefined;
    items.value = [];
    details.value = {};
    close();
    error.value = '';
    // A preview signs itself in against a cloudless api: there is nothing to read, and the empty
    // column is the answer, not a pending one.
    if (!uid || IS_PREVIEW) {
      phase.value = IS_PREVIEW ? 'ready' : 'idle';
      return;
    }
    phase.value = 'loading';
    // Bound before the read, so a change landing during it is not lost; the read then fills in
    // behind whatever already arrived.
    stopChannel = subscribeSkillImprovements(auth.client, uid, onChange);
    try {
      const rows = await listSkillImprovementEntries(auth.client);
      if (mine !== generation) return;
      const arrived = new Set(items.value.map((i) => i.entry.id));
      items.value = [
        ...items.value,
        ...rows.filter((r) => !arrived.has(r.id)).map((entry) => ({ kind: 'skill-improvement' as const, entry })),
      ].slice(0, SKILL_IMPROVEMENTS_KEEP);
      phase.value = 'ready';
    } catch (e) {
      if (mine !== generation) return;
      error.value = e instanceof Error ? e.message : String(e);
      phase.value = 'error';
    }
  }

  /** Follow the signed-in user for the life of the app. Idempotent; the shell calls it once. */
  function start(): void {
    if (started) return;
    started = true;
    watch(
      () => auth.user?.id,
      (uid) => void bind(uid),
      { immediate: true },
    );
    schedules.start();
    schedules.onSlip(announceSlip);
  }

  /** Read the list again after a failed read («Спробувати ще»). */
  function reload(): Promise<void> {
    return bind(auth.user?.id);
  }

  async function markSeen(ids: readonly string[]): Promise<void> {
    const unseen = ids.filter((id) => items.value.some((i) => i.entry.id === id && !i.entry.seenAt));
    if (!unseen.length) return;
    patch(unseen, { seenAt: new Date().toISOString() });
    try {
      await markSkillImprovementsSeen(auth.client, unseen);
    } catch (e) {
      // Back to new: the mark never reached the cloud, so the next read would bring it back anyway.
      const back = new Set(unseen);
      items.value = items.value.map((i) => {
        if (!back.has(i.entry.id)) return i;
        const { seenAt: _dropped, ...entry } = i.entry;
        return { ...i, entry };
      });
      throw e;
    }
  }

  // Every source at once; a refusal is the action's error, and its rows stay new. The updates
  // are this machine's own and cannot fail.
  async function markAllSeen(): Promise<void> {
    appUpdate.markUpdatesSeen(appUpdate.updates.map((u) => u.id));
    const slips = (schedules.slips ?? []).filter((s) => !s.seen).map((s) => s.id);
    await Promise.all([markSeen(items.value.map((i) => i.entry.id)), schedules.markSlipsSeen(slips)]);
  }

  /** Open the window on one entry — the toast's «Переглянути» and a click in the column. */
  function open(id: string): void {
    close();
    openId.value = id;
    overlay.show();
    // Seen is a mark, not an action the operator waits for: a failed write leaves it new.
    void markSeen([id]).catch(() => undefined);
  }

  /** Open a run's full answer over the console (a run without a project, decision 9). */
  function openSlip(id: string): void {
    close();
    openSlipId.value = id;
    overlay.show();
    void schedules.markSlipsSeen([id]).catch(() => undefined);
  }

  /** Open one scheduled task over the console: its prompt, history and actions. */
  function openTask(id: string): void {
    close();
    openTaskId.value = id;
    overlay.show();
  }

  function close(): void {
    openId.value = undefined;
    openSlipId.value = undefined;
    openTaskId.value = undefined;
  }

  // The text the skill resolves to without the personal layer, where the record says it came
  // from. Undefined when there is none to compare (a personal-only skill, a scope row gone).
  async function teamText(r: SkillImprovement): Promise<string | undefined> {
    if (r.teamScope === 'default') return DEFAULT_SKILLS.find((d) => d.name === r.skillName)?.body;
    if ((r.teamScope === 'project' || r.teamScope === 'workspace') && r.teamOwnerId)
      return (await getAiSkill(auth.client, { scope: r.teamScope, id: r.teamOwnerId }, r.skillName))?.body;
    return undefined;
  }

  // Whether the team text moved since the personal copy was made: the copy then hides it.
  function changedUnder(chain: readonly SkillImprovement[], skillName: string, team: string | undefined): boolean {
    const origin = copyOrigin(chain, skillName);
    return !!origin && team !== undefined && team !== origin.beforeBody;
  }

  /** The entry view's data: the whole record, and for an applied one whether the team text moved. */
  async function inspect(id: string): Promise<SkillImprovementDetail> {
    const known = details.value[id];
    if (known) return known;
    const record = await getSkillImprovement(auth.client, id);
    if (!record) throw new Error(globalTr.t('cuk.notifications.gone'));
    let teamChanged = false;
    if (record.state === 'applied') {
      const [chain, team] = await Promise.all([listAppliedSkillImprovements(auth.client, record.skillName), teamText(record)]);
      teamChanged = changedUnder(chain, record.skillName, team);
    }
    const detail = { record, teamChanged };
    details.value = { ...details.value, [id]: detail };
    return detail;
  }

  async function planRollback(id: string): Promise<PlannedRollback> {
    const { record } = await inspect(id);
    const [chain, personal] = await Promise.all([
      listAppliedSkillImprovements(auth.client, record.skillName),
      getAiSkill(auth.client, owner(), record.skillName),
    ]);
    const plan = rollbackPlan(chain, id, personal?.body);
    if (!plan) throw new Error(globalTr.t('cuk.notifications.settled'));
    return { plan, description: personal?.description ?? '' };
  }

  async function applyRollback({ plan, description }: PlannedRollback): Promise<void> {
    const name = plan.records[0]!.skillName;
    if (plan.action.kind === 'delete-copy') await deleteAiSkill(auth.client, owner(), name);
    else if (plan.action.kind === 'restore')
      await upsertAiSkill(auth.client, { owner: owner(), name, description, body: plan.action.text, enabled: true });
    const ids = plan.records.map((r) => r.id);
    await setSkillImprovementState(auth.client, ids, 'rolled_back');
    settle(ids, 'rolled_back');
  }

  async function planShare(id: string): Promise<PlannedShare> {
    const { record } = await inspect(id);
    const target = shareTarget(record);
    if (!target) throw new Error(globalTr.t('cuk.notifications.shareNoWorkspace'));
    const [chain, personal, team] = await Promise.all([
      listAppliedSkillImprovements(auth.client, record.skillName),
      getAiSkill(auth.client, owner(), record.skillName),
      teamText(record),
    ]);
    if (!personal) throw new Error(globalTr.t('cuk.notifications.shareNoCopy'));
    return {
      target,
      chain,
      text: personal.body,
      description: personal.description,
      teamChanged: changedUnder(chain, record.skillName, team),
    };
  }

  async function applyShare(share: PlannedShare): Promise<void> {
    const name = share.chain[0]?.skillName;
    if (!name) throw new Error(globalTr.t('cuk.notifications.settled'));
    await upsertAiSkill(auth.client, { owner: share.target, name, description: share.description, body: share.text, enabled: true });
    await deleteAiSkill(auth.client, owner(), name);
    const ids = share.chain.map((r) => r.id);
    await setSkillImprovementState(auth.client, ids, 'promoted');
    settle(ids, 'promoted');
  }

  // A settled chain: its records leave `applied`, and a cached «team text moved» no longer applies.
  function settle(ids: readonly string[], state: SkillImprovementState): void {
    patch(ids, { state });
    for (const id of ids) {
      const d = details.value[id];
      if (d) details.value = { ...details.value, [id]: { ...d, teamChanged: false } };
    }
  }

  return {
    items,
    feed,
    phase,
    error,
    tab,
    openId,
    openSlipId,
    openTaskId,
    viewOpen,
    details,
    unread,
    start,
    reload,
    markSeen,
    markAllSeen,
    open,
    openSlip,
    openTask,
    viewSlip,
    close,
    inspect,
    planRollback,
    applyRollback,
    planShare,
    applyShare,
  };
});
