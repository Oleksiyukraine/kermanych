// apps/ui/src/stores/cuk-chat.ts
// ЦУК — «Центр управління Керманича», browser side (docs/specs/2026-11-04-cuk-control-console.md):
// one global transcript, one turn through the local api, and the executor of the model's
// validated `cuk.*` actions.
//
// Three properties of this file are the product:
//
//   1. the conversation is ONE for the whole app (decision 5): it sees every workspace,
//      project and session on this machine, and the header's selection is only its default
//      target — switching workspace does not switch the conversation;
//   2. what spends the plan or touches an agent never runs on the model's word: such an action
//      lands in the transcript as a CARD, and only the operator's «Виконати» runs it
//      (decision 4, `cukNeedsConfirm` in core). Navigation and the notepad run at once;
//   3. every line that says something HAPPENED is written here, after the store call answered —
//      never by the model.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { RouteLocationRaw, Router } from 'vue-router';
import {
  CUK_SESSION_VERBS,
  MANAGEMENT_DEFAULT_SECTION,
  MANAGEMENT_SECTIONS,
  cukNeedsConfirm,
  taskNameFromText,
  type CukAction,
  type CukChatAsk,
  type CukPlace,
  type CukSessionVerb,
  type CukTaskAction,
  type Session,
  type Usage,
} from '@kermanych/core';
import type { Task } from '@kermanych/cloud';
import type { AttachedFile } from '../lib/files';
import { globalTr } from '../boot/i18n';
import { localizeNotice, localizeRejection } from '../lib/i18n-coded';
import { locale } from '../lib/locale';
import { api } from '../lib/api';
import { handleOf } from '../lib/members';
import { todoPlainText } from '../lib/home-todo';
import { SETTINGS_CATEGORIES } from '../lib/settings';
import { bucketOf } from '../lib/buckets';
import { nextMode } from '../lib/message-mode';
import { defaultLaunchMode, nativeRuntimeFor } from '../lib/native-session';
import { taskInsertFromDraft } from '../lib/tasks-view';
import { cukBoardRows, cukSessionRows, findSessionByRef } from '../lib/cuk-digest';
import { findProjectByName } from './management-actions';
import { useAssistantOverlay } from './assistant-overlay';
import { useAuth } from './auth';
import { useBoard } from './board';
import { useHomeTodo } from './home-todo';
import { useOrchestrator } from './orchestrator';
import { useProjects } from './projects';

export type CukCardState = 'pending' | 'running' | 'done' | 'cancelled';

export type CukEntry =
  | { kind: 'user'; id: string; at: number; text: string; files?: { name: string; url?: string }[] }
  | { kind: 'assistant'; id: string; at: number; text: string; model?: string; usage?: Usage; ms: number }
  // What the APP did. `session` makes the line carry «Відкрити сесію» — the launch's result.
  | { kind: 'result'; id: string; at: number; level: 'info' | 'warn' | 'error'; text: string; session?: string }
  // An action that waits for «Виконати». The action is the card's own copy: the operator may
  // edit its text before running it.
  | { kind: 'card'; id: string; at: number; action: CukAction; state: CukCardState };

type Level = Extract<CukEntry, { kind: 'result' }>['level'];
type SessionAction = Extract<CukAction, { kind: CukSessionVerb | 'session.message' }>;

function isSessionAction(a: CukAction): a is SessionAction {
  return a.kind === 'session.message' || (CUK_SESSION_VERBS as readonly string[]).includes(a.kind);
}

// A place `navigate` may go to, with where it goes. The prompt is shown `id — label`; the
// executor resolves the id against this same list, so the model cannot route anywhere else.
type Place = CukPlace & { to: RouteLocationRaw };

function entryId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const useCukChat = defineStore('cuk-chat', () => {
  const store = useOrchestrator();
  const projects = useProjects();
  const board = useBoard();
  const homeTodo = useHomeTodo();
  const auth = useAuth();
  const overlay = useAssistantOverlay();

  const entries = ref<CukEntry[]>([]);
  const busy = ref(false);
  const resetting = ref(false);
  const hasConversation = computed(() => entries.value.length > 0);

  // The store has no router of its own: Quasar builds one per app in a factory, and a store
  // setup has no injection context to reach it. The shell's launcher hands it over once.
  let router: Router | undefined;
  function bindRouter(r: Router): void {
    router = r;
  }

  function push(entry: CukEntry): void {
    entries.value.push(entry);
  }

  function result(level: Level, text: string, session?: string): void {
    push({ kind: 'result', id: entryId(), at: Date.now(), level, text, ...(session ? { session } : {}) });
  }

  // ── Places ──────────────────────────────────────────────────────────────────
  // The tabs, the Менеджмент sections the operator may open, every settings pane.
  function places(): Place[] {
    const t = globalTr.t.bind(globalTr);
    const ws = store.selectedWorkspaceId;
    const manager = ws ? projects.canManageWorkspace(ws) : false;
    const tabs: Place[] = [
      { id: 'agents', label: t('common.nav.viewAgents'), to: { name: 'agents' } },
      { id: 'board', label: t('common.nav.viewBoard'), to: { name: 'board' } },
      { id: 'chat', label: t('common.nav.viewChat'), to: { name: 'chat' } },
      { id: 'design', label: t('common.nav.viewDesign'), to: { name: 'design' } },
      { id: 'synergy', label: t('common.nav.viewSynergy'), to: { name: 'synergy' } },
      { id: 'ai-team', label: t('common.nav.viewAiTeam'), to: { name: 'ai-team' } },
      { id: 'management', label: t('common.nav.viewManagement'), to: { name: MANAGEMENT_DEFAULT_SECTION } },
    ];
    const sections: Place[] = MANAGEMENT_SECTIONS.filter((s) => !s.managersOnly || manager).map((s) => ({
      id: s.name,
      label: `${t('common.nav.viewManagement')} › ${s.label}`,
      to: { name: s.name },
    }));
    const settings: Place[] = SETTINGS_CATEGORIES.map((c) => ({
      id: `settings:${c.key}`,
      label: `${t('cuk.places.settings')} › ${t(`settings.scope.${c.scope}`)} › ${t(`settings.categories.${c.key}.label`)}`,
      to: { name: 'settings', params: { section: c.key } },
    }));
    return [...tabs, ...sections, ...settings];
  }

  // ── Context ─────────────────────────────────────────────────────────────────
  function projectName(id: string): string {
    return projects.byId.get(id)?.name ?? store.projects.find((p) => p.id === id)?.name ?? '';
  }

  function assigneeName(task: Task): string {
    if (!task.assigneeId) return '';
    if (task.assigneeId === auth.user?.id) return globalTr.t('cuk.me');
    const ws = projects.byId.get(task.projectId)?.workspaceId;
    const member = ws ? projects.members[ws]?.find((m) => m.userId === task.assigneeId) : undefined;
    return member ? handleOf(member) : '';
  }

  async function context(list: Place[]): Promise<CukChatAsk['context']> {
    // The board is read once per app run by whoever opens it first; a console asked «що на
    // дошці» before anybody did reads it here.
    if (!board.loaded) await board.load();
    const ws = store.selectedWorkspaceId;
    const pid = store.selectedProjectId;
    const sessions = cukSessionRows(store.sessions, projectName, (id) => {
      const phase = store.previews[id]?.phase;
      return phase === 'starting' || phase === 'running';
    });
    const scoped = ws ? board.tasks.filter((t) => projects.byId.get(t.projectId)?.workspaceId === ws) : board.tasks;
    const cards = cukBoardRows(scoped, projectName, assigneeName);
    const local = new Map(store.projects.map((p) => [p.id, p]));
    return {
      view: String(router?.currentRoute.value.name ?? ''),
      ...(ws ? { workspace: projects.workspaceById.get(ws)?.name ?? '' } : {}),
      ...(pid ? { project: projectName(pid) } : {}),
      workspaces: projects.workspaces.map((w) => ({ name: w.name, role: projects.myRole(w.id) ?? '', selected: w.id === ws })),
      projects: projects.projects.map((p) => ({
        name: p.name,
        workspace: projects.workspaceById.get(p.workspaceId)?.name ?? '',
        bound: !!local.get(p.id)?.localRepoPath,
        selected: p.id === pid,
      })),
      sessions: sessions.rows,
      sessionsOmitted: sessions.omitted,
      board: cards.rows,
      boardOmitted: cards.omitted,
      places: list.map(({ id, label }) => ({ id, label })),
      ...(ws
        ? {
            notes: homeTodo.listFor(ws).map((i) => ({ text: todoPlainText(i.html), kind: i.kind, done: i.done })),
          }
        : {}),
    };
  }

  // ── Executor ────────────────────────────────────────────────────────────────
  function sessionFor(ref: string): Session | undefined {
    const s = findSessionByRef(store.sessions, ref);
    if (!s) result('warn', globalTr.t('cuk.result.sessionMissing', { session: ref }));
    return s;
  }

  async function go(to: RouteLocationRaw): Promise<void> {
    await router?.push(to);
    // The operator asked to SEE the place: the window stepped aside for it. ⌘K brings it back.
    overlay.close();
  }

  function runTodo(action: Extract<CukAction, { kind: 'todo.create' | 'todo.update' | 'todo.delete' }>): void {
    const ws = store.selectedWorkspaceId;
    if (!ws) {
      result('warn', globalTr.t('cuk.result.notesNoWorkspace'));
      return;
    }
    if (action.kind === 'todo.create') {
      const made = homeTodo.append(ws, action.items);
      result(
        'info',
        globalTr.t(
          'management.chat.todoAdded',
          { n: made.length, items: action.items.map((i) => `«${i.text}»`).join(', ') },
          made.length,
        ),
      );
      return;
    }
    if (action.kind === 'todo.update') {
      const item = homeTodo.updateAt(ws, action.index, action.patch);
      result(
        item ? 'info' : 'warn',
        item
          ? globalTr.t('management.chat.todoUpdated', { index: action.index, text: todoPlainText(item.html) })
          : globalTr.t('management.chat.todoIndexMissing', { index: action.index }),
      );
      return;
    }
    const removed = homeTodo.removeAt(ws, action.index);
    result(
      removed ? 'info' : 'warn',
      removed
        ? globalTr.t('management.chat.todoDeleted', { index: action.index, text: todoPlainText(removed.html) })
        : globalTr.t('management.chat.todoIndexMissing', { index: action.index }),
    );
  }

  // The actions that run at once (decision 4). Never throws.
  async function runNow(action: CukAction, list: Place[]): Promise<void> {
    if (action.kind === 'navigate') {
      const place = list.find((p) => p.id === action.place);
      if (!place) {
        result('warn', globalTr.t('cuk.result.placeMissing', { place: action.place }));
        return;
      }
      await go(place.to);
      result('info', globalTr.t('cuk.result.navigated', { place: place.label }));
      return;
    }
    if (action.kind === 'scope.select') {
      if (action.project) {
        const p = findProjectByName(projects.projects, action.project);
        if (!p) {
          result('warn', globalTr.t('cuk.result.projectMissing', { project: action.project }));
          return;
        }
        store.selectProject(p.id);
        result('info', globalTr.t('cuk.result.selectedProject', { project: p.name }));
        return;
      }
      const w = action.workspace ? findProjectByName(projects.workspaces, action.workspace) : undefined;
      if (!w) {
        result('warn', globalTr.t('cuk.result.workspaceMissing', { workspace: action.workspace ?? '' }));
        return;
      }
      store.selectWorkspace(w.id);
      result('info', globalTr.t('cuk.result.selectedWorkspace', { workspace: w.name }));
      return;
    }
    if (action.kind === 'session.open') {
      const s = sessionFor(action.session);
      if (!s) return;
      await openSession(s.id);
      result('info', globalTr.t('cuk.result.opened', { session: s.name }));
      return;
    }
    if (action.kind === 'todo.create' || action.kind === 'todo.update' || action.kind === 'todo.delete') runTodo(action);
  }

  // Show one session where it lives: a design in «Дизайн», a Синергія session in «Синергія»
  // (opened by the page's `session` query), every other one in «Агенти» on its own tab. Also
  // what a result line's «Відкрити сесію» does.
  async function openSession(id: string): Promise<void> {
    const s = store.sessions.find((x) => x.id === id);
    if (!s) return;
    if (s.designDir) {
      await go({ name: 'design' });
      return;
    }
    if (s.synergy) {
      await go({ name: 'synergy', query: { session: s.id } });
      return;
    }
    store.setBucket(bucketOf(s, (pid) => store.sessions.find((x) => x.id === pid)));
    store.selectSession(s.id);
    await go({ name: 'agents' });
  }

  // «Нова задача» from words: the card first, as the launcher does, so a failed launch loses
  // nothing — the card is on the board and can be run from there.
  async function runTask(action: CukTaskAction): Promise<void> {
    const project = findProjectByName(projects.projects, action.project);
    if (!project) {
      result('warn', globalTr.t('cuk.result.projectMissing', { project: action.project }));
      return;
    }
    const userId = auth.user?.id;
    if (!userId) {
      result('error', globalTr.t('agents.launcher.loginFirst'));
      return;
    }
    const local = store.projects.find((p) => p.id === project.id);
    if (action.kind === 'agent.start' && !local?.localRepoPath) {
      result('warn', globalTr.t('cuk.result.projectUnbound', { project: project.name }));
      return;
    }
    const created = await board.createTask(
      taskInsertFromDraft(
        {
          name: action.title ?? taskNameFromText(action.task),
          task: action.task,
          model: local?.defaultModel,
          effort: local?.defaultEffort,
          prefix: 'feature',
          worktree: true,
          hidden: false,
          deepAnalysis: !!action.deepAnalysis,
          autoRun: false,
        },
        project.id,
        userId,
      ),
    );
    // `createTask` reports its own failure in a toast and answers undefined; the transcript
    // still has to say the card did not land, because it was asked for here.
    if (!created) {
      result('error', globalTr.t('cuk.result.cardFailed', { title: action.title ?? taskNameFromText(action.task) }));
      return;
    }
    if (action.kind === 'task.create') {
      result('info', globalTr.t('cuk.result.cardCreated', { title: created.title, project: project.name }));
      return;
    }
    const native = nativeRuntimeFor(defaultLaunchMode(auth.provider, { design: created.design }));
    const session = await api.createSessionFromTask(created.id, undefined, native);
    result('info', globalTr.t('cuk.result.agentStarted', { title: created.title, project: project.name }), session.id);
  }

  async function runSession(action: SessionAction): Promise<void> {
    const s = sessionFor(action.session);
    if (!s) return;
    if (action.kind === 'session.message') {
      // The message mode depends on the conversation so far, which a session nobody opened
      // has not loaded yet.
      if (!store.transcripts[s.id]) await store.loadTranscript(s.id);
      await store.sendMessage(s.id, action.text, nextMode(s, store.transcripts[s.id] ?? []));
      result('info', globalTr.t('cuk.result.messageSent', { session: s.name }), s.id);
      return;
    }
    const calls: Record<CukSessionVerb, (id: string) => Promise<unknown>> = {
      'session.stop': store.stopSession,
      'session.resume': store.resumeSession,
      'session.restart': store.restartSession,
      'session.archive': store.archiveSession,
      'session.unarchive': store.unarchiveSession,
      'preview.start': (id) => store.startPreview(id),
      'preview.stop': store.stopPreview,
    };
    await calls[action.kind](s.id);
    result('info', globalTr.t(`cuk.result.done.${action.kind.replace('.', '_')}`, { session: s.name }), s.id);
  }

  // «Виконати» on a card. The card's own (possibly edited) action is what runs.
  async function confirm(id: string, action?: CukAction): Promise<void> {
    const card = entries.value.find((e): e is Extract<CukEntry, { kind: 'card' }> => e.kind === 'card' && e.id === id);
    if (!card || card.state !== 'pending') return;
    if (action) card.action = action;
    card.state = 'running';
    try {
      const a = card.action;
      if (a.kind === 'task.create' || a.kind === 'agent.start') await runTask(a);
      else if (isSessionAction(a)) await runSession(a);
      card.state = 'done';
    } catch (e) {
      // The store call refused: the reason, verbatim — and the card may be tried again.
      result('error', errorText(e));
      card.state = 'pending';
    }
  }

  function cancel(id: string): void {
    const card = entries.value.find((e) => e.kind === 'card' && e.id === id);
    if (card?.kind === 'card' && card.state === 'pending') card.state = 'cancelled';
  }

  async function send(text: string, attachments: AttachedFile[] = []): Promise<void> {
    const body = text.trim();
    if (busy.value || resetting.value || (!body && !attachments.length)) return;
    push({
      kind: 'user',
      id: entryId(),
      at: Date.now(),
      text: body,
      ...(attachments.length ? { files: attachments.map((f) => ({ name: f.name, ...(f.url ? { url: f.url } : {}) })) } : {}),
    });
    busy.value = true;
    try {
      const list = places();
      const ask: CukChatAsk = {
        text: body,
        context: await context(list),
        locale: locale.value,
        ...(attachments.length
          ? { attachments: attachments.map((f) => ({ name: f.name, mimeType: f.mimeType, data: f.data })) }
          : {}),
      };
      const reply = await api.cukChat(ask);
      push({
        kind: 'assistant',
        id: entryId(),
        at: Date.now(),
        text: reply.text,
        ms: reply.ms,
        ...(reply.model ? { model: reply.model } : {}),
        ...(reply.usage ? { usage: reply.usage } : {}),
      });
      for (const line of reply.rejected) result('warn', localizeRejection(globalTr, line));
      for (const line of reply.notices) result('info', localizeNotice(globalTr, line));
      // In order: «відкрий проєкт X і запусти там агента» is two actions that only make sense
      // one after the other.
      for (const action of reply.actions) {
        if (cukNeedsConfirm(action)) push({ kind: 'card', id: entryId(), at: Date.now(), action, state: 'pending' });
        else await runNow(action, list);
      }
    } catch (e) {
      result('error', errorText(e));
    } finally {
      busy.value = false;
    }
  }

  // «Новий чат»: the transcript AND the model's memory of it; pending cards go with them.
  async function reset(): Promise<void> {
    if (busy.value || resetting.value) return;
    entries.value = [];
    resetting.value = true;
    try {
      await api.resetCukChat();
    } catch (e) {
      result('error', globalTr.t('management.chat.resetFailed', { error: errorText(e) }));
    } finally {
      resetting.value = false;
    }
  }

  return { entries, busy, resetting, hasConversation, bindRouter, send, reset, confirm, cancel, openSession };
});
