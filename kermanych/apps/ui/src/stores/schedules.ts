// apps/ui/src/stores/schedules.ts
// «Задачі за розкладом» on this machine (docs/specs/2026-11-06-scheduled-tasks.md): the task list,
// each task's run history (read when its view opens) and the slips «Центр сповіщень» shows. All
// of it is the local api's (decision 1: personal and machine-local), mirrored like «Посіпака»'s
// state: read on every socket (re)connect and on sign-in, then kept current by
// `schedules_update` (the whole list), `schedule_slip` (one slip, new or re-fired by a snooze)
// and `schedule_run_update` (one run).
//
// A slip that ARRIVES is news: the listeners registered with `onSlip` raise its toast and
// notification (stores/notification-center.ts). A slip the first read brings is not — it was
// there before the window, and the column marks it new without a toast for each.
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import {
  SCHEDULE_RUNS_KEEP,
  SCHEDULE_SLIPS_KEEP,
  type ScheduleDraft,
  type SchedulePatch,
  type ScheduleRun,
  type ScheduleSlip,
  type ScheduledTask,
} from '@kermanych/core';
import { api } from '../lib/api';
import { useAuth } from './auth';
import { useOrchestrator } from './orchestrator';

function byAtDesc(a: ScheduleSlip, b: ScheduleSlip): number {
  return Date.parse(b.at) - Date.parse(a.at);
}

export const useSchedules = defineStore('schedules', () => {
  const local = useOrchestrator();
  const auth = useAuth();

  // `undefined` until the first read answers: «not loaded» is not «no tasks» (README «Async states»).
  const tasks = ref<ScheduledTask[] | undefined>(undefined);
  const slips = ref<ScheduleSlip[] | undefined>(undefined);
  // Why the last read failed; cleared by the next good one. The «Розклад» tab shows it.
  const loadError = ref('');
  // Run history by task id, newest first; a task is absent until its view asked for it.
  const runs = ref<Record<string, ScheduleRun[]>>({});

  const slipListeners = new Set<(slip: ScheduleSlip) => void>();

  /** Called for every slip that arrives while the app runs (not for those the first read brings). */
  function onSlip(fn: (slip: ScheduleSlip) => void): () => void {
    slipListeners.add(fn);
    return () => slipListeners.delete(fn);
  }

  // Replies can overlap (a reconnect's snapshot during a sign-in); only the newest read paints.
  // Tasks and slips are counted apart: `schedules_update` carries the whole task list, so it
  // outdates a task read in flight — but not the slip read beside it, or the feed would stay blank
  // until the next reconnect. A slip that arrives during the slip read is kept over the reply.
  let tasksRun = 0;
  let slipsRun = 0;
  let arrivedSlips = new Map<string, ScheduleSlip>();
  async function load(): Promise<void> {
    if (!auth.user) return;
    const taskRun = ++tasksRun;
    const slipRun = ++slipsRun;
    arrivedSlips = new Map();
    const [list, feed] = await Promise.allSettled([api.schedules(), api.scheduleSlips()]);
    let failure: unknown;
    if (taskRun === tasksRun) {
      if (list.status === 'fulfilled') tasks.value = list.value.tasks;
      else failure = list.reason;
    }
    if (slipRun === slipsRun) {
      if (feed.status === 'fulfilled') {
        const read = feed.value.slips.filter((s) => !arrivedSlips.has(s.id));
        slips.value = [...arrivedSlips.values(), ...read].sort(byAtDesc).slice(0, SCHEDULE_SLIPS_KEEP);
      } else failure ??= feed.reason;
    }
    if (taskRun !== tasksRun && slipRun !== slipsRun) return;
    loadError.value = failure === undefined ? '' : failure instanceof Error ? failure.message : String(failure);
  }

  function clear(): void {
    tasksRun++;
    slipsRun++;
    arrivedSlips = new Map();
    tasks.value = undefined;
    slips.value = undefined;
    runs.value = {};
    loadError.value = '';
  }

  // A slip by id replaces its old self (a snooze re-fires the same slip with a new `at`).
  function putSlip(slip: ScheduleSlip): void {
    arrivedSlips.set(slip.id, slip);
    const rest = (slips.value ?? []).filter((s) => s.id !== slip.id);
    slips.value = [slip, ...rest].sort(byAtDesc).slice(0, SCHEDULE_SLIPS_KEEP);
  }

  function putRun(run: ScheduleRun): void {
    const known = runs.value[run.scheduleId];
    if (!known) return;
    const rest = known.filter((r) => r.id !== run.id);
    const next = [run, ...rest].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, SCHEDULE_RUNS_KEEP);
    runs.value = { ...runs.value, [run.scheduleId]: next };
  }

  function putTask(task: ScheduledTask): void {
    const list = tasks.value ?? [];
    tasks.value = list.some((t) => t.id === task.id) ? list.map((t) => (t.id === task.id ? task : t)) : [...list, task];
  }

  // Every socket (re)connect starts with a `snapshot`: the api may have fired while the socket
  // was down, so the list and the slips are read again.
  local.onServerEvent((e) => {
    if (e.type === 'snapshot') void load();
    else if (e.type === 'schedules_update') {
      tasksRun++;
      tasks.value = e.tasks;
    } else if (e.type === 'schedule_slip') {
      putSlip(e.slip);
      if (!e.slip.seen) for (const fn of slipListeners) fn(e.slip);
    } else if (e.type === 'schedule_run_update') putRun(e.run);
  });

  let started = false;
  /** Follow the signed-in user for the life of the app. Idempotent. */
  function start(): void {
    if (started) return;
    started = true;
    watch(
      () => auth.user?.id,
      (uid) => {
        clear();
        if (uid) void load();
      },
      { immediate: true },
    );
  }

  /** The task a ЦУК `ref` names: an exact id, or the one task whose id starts with it. */
  function findByRef(ref: string): ScheduledTask | undefined {
    const wanted = ref.trim().toLowerCase();
    if (!wanted) return undefined;
    const list = tasks.value ?? [];
    const exact = list.find((t) => t.id.toLowerCase() === wanted);
    if (exact) return exact;
    const hits = list.filter((t) => t.id.toLowerCase().startsWith(wanted));
    return hits.length === 1 ? hits[0] : undefined;
  }

  // The writes answer with the task; the echo (`schedules_update`) follows and wins.
  async function create(draft: ScheduleDraft): Promise<ScheduledTask> {
    const task = await api.createSchedule(draft);
    putTask(task);
    return task;
  }

  async function update(id: string, patch: SchedulePatch): Promise<ScheduledTask> {
    const task = await api.patchSchedule(id, patch);
    putTask(task);
    return task;
  }

  const setEnabled = (id: string, enabled: boolean): Promise<ScheduledTask> => update(id, { enabled });

  async function remove(id: string): Promise<void> {
    await api.deleteSchedule(id);
    if (tasks.value) tasks.value = tasks.value.filter((t) => t.id !== id);
    const { [id]: _gone, ...rest } = runs.value;
    runs.value = rest;
  }

  async function runNow(id: string): Promise<ScheduleRun> {
    const { run } = await api.runSchedule(id);
    putRun(run);
    return run;
  }

  async function loadRuns(id: string): Promise<ScheduleRun[]> {
    const { runs: list } = await api.scheduleRuns(id);
    runs.value = { ...runs.value, [id]: list };
    return list;
  }

  // Seen is a mark, flipped here at once; a refused write puts the slips back to new.
  async function markSlipsSeen(ids: readonly string[]): Promise<void> {
    const unseen = new Set(ids.filter((id) => slips.value?.some((s) => s.id === id && !s.seen)));
    if (!unseen.size || !slips.value) return;
    slips.value = slips.value.map((s) => (unseen.has(s.id) ? { ...s, seen: true } : s));
    try {
      await api.markScheduleSlipsSeen([...unseen]);
    } catch (e) {
      slips.value = slips.value?.map((s) => (unseen.has(s.id) ? { ...s, seen: false } : s));
      throw e;
    }
  }

  // «Відкласти»: the slip leaves the column until the api re-fires it as a `schedule_slip`.
  async function snooze(id: string, minutes: 10 | 60): Promise<void> {
    await api.snoozeScheduleSlip(id, minutes);
    if (slips.value) slips.value = slips.value.filter((s) => s.id !== id);
  }

  return {
    tasks,
    slips,
    runs,
    loadError,
    start,
    load,
    onSlip,
    findByRef,
    create,
    update,
    setEnabled,
    remove,
    runNow,
    loadRuns,
    markSlipsSeen,
    snooze,
  };
});
