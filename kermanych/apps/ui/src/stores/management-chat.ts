// apps/ui/src/stores/management-chat.ts
// The Менеджмент assistant, browser side: one transcript per scoped project, one turn
// through the local api, and the executor that applies the model's validated actions.
//
// Three properties of this file are the product, not implementation detail:
//
//   1. it runs through `omp` (api.managementChat → apps/api/src/management), so a turn here
//      is debited to the same provider plan every agent is debited to — the composer says so
//      out loud, and this store is why that sentence is true;
//   2. a refusal states the reason recorded in the section table (@kermanych/core
//      `MANAGEMENT_SECTIONS.limitation`) and NEVER a sentence the model supplied. A model
//      that would rather be agreeable invents a plausible limitation, and an invented reason
//      is worse than no answer at all;
//   3. when a WRITING action kind is added, it executes HERE, in the browser, under the
//      user's own Supabase JWT — so RLS, not trust in the model, decides what a given member
//      may change. The api deliberately holds no write path of its own.
//
// Every section is currently `capability: "none" | "read"`, so the only action the protocol
// carries is `unsupported`. The Risk Registry that can take a write lives on its own branch;
// the comment on that row in @kermanych/core's `MANAGEMENT_SECTIONS` names the three edits
// that connect the two.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { managementSection } from '@kermanych/core';
import type { ManagementAction, ManagementChatAsk, ManagementWorkspaceProject, Usage } from '@kermanych/core';
import { api } from '../lib/api';
import { useOrchestrator } from './orchestrator';
import { useProjects } from './projects';

// One line of the conversation. `result` is neither the user's words nor the model's: it is
// what the APP did (or refused to do) about them, which is why it is a third kind with its
// own level rather than an assistant turn with a prefix — the operator must be able to tell
// «я створив ризик» from «ризик створено» at a glance.
export type MgmtChatEntry =
  | { kind: 'user'; id: string; at: number; text: string }
  | { kind: 'assistant'; id: string; at: number; text: string; model?: string; usage?: Usage; ms: number }
  | { kind: 'result'; id: string; at: number; level: 'info' | 'warn' | 'error'; text: string };

export type MgmtResultLevel = Extract<MgmtChatEntry, { kind: 'result' }>['level'];

// Same shape the api keys its omp children by: one conversation per scoped project.
function conversationId(projectId: string): string {
  return `management:${projectId}`;
}

// The toast store's id idiom — monotonic enough for a `:key` and unique enough for two
// entries appended in the same millisecond.
function entryId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const useManagementChat = defineStore('management-chat', () => {
  const store = useOrchestrator();
  const projects = useProjects();

  // Keyed by project id, because the conversation id is `management:<projectId>`: picking
  // another project in the sidebar switches the conversation the api talks to, so it has to
  // switch the conversation on screen too. Keeping one flat list would show the operator a
  // transcript the model no longer has.
  const byProject = ref<Record<string, MgmtChatEntry[]>>({});
  const busy = ref(false);

  const entries = computed<MgmtChatEntry[]>(() => {
    const id = store.selectedProjectId;
    return (id ? byProject.value[id] : undefined) ?? [];
  });

  const hasConversation = computed(() => entries.value.length > 0);

  function push(projectId: string, entry: MgmtChatEntry): void {
    const list = byProject.value[projectId];
    if (list) list.push(entry);
    else byProject.value[projectId] = [entry];
  }

  function result(projectId: string, level: MgmtResultLevel, text: string): void {
    push(projectId, { kind: 'result', id: entryId(), at: Date.now(), level, text });
  }

  // Requirement 3: the assistant carries every repository of the scoped workspace, not just
  // the screen in front of the operator. Only the id and the cloud row's git remote travel —
  // the api joins them against its own local registry for the on-disk path, so the prompt
  // cannot be talked into naming a directory nobody bound.
  //
  // A local-only project has no workspace row. Then the scope is honestly this one project:
  // the alternative, sending every known id, would leak another workspace's repositories into
  // the prompt.
  function workspaceProjects(projectId: string): ManagementWorkspaceProject[] {
    const workspaceId = store.selectedWorkspaceId;
    const scoped = workspaceId
      ? projects.projects.filter((p) => p.workspaceId === workspaceId)
      : [];
    const entries = scoped.map((p) => ({
      id: p.id,
      ...(p.gitRemoteUrl ? { gitRemoteUrl: p.gitRemoteUrl } : {}),
    }));
    if (!entries.length) return [{ id: projectId }];
    return entries.some((e) => e.id === projectId) ? entries : [...entries, { id: projectId }];
  }

  // One validated action -> one result line. Never throws: an action that fails must not
  // swallow the actions after it, and a batch where the second is refused still has to
  // report the others.
  //
  // `unsupported` is the only kind the protocol carries, so this is a single branch rather
  // than a switch. It stays a function because a writing kind lands beside it, not inside
  // it — and because the refusal it renders must never be inlined into the send path where
  // the model's own words are in scope.
  function run(projectId: string, action: ManagementAction): void {
    const section = managementSection(action.section);
    // `action.request` is the model's echo of what was asked and is never used as the
    // explanation — the explanation comes from the table. When the section does not
    // resolve at all, say exactly that and name what was claimed, so the operator can see
    // the assistant is confused rather than the product broken.
    result(
      projectId,
      'warn',
      section
        ? `Не можу змінити розділ «${section.label}»: ${section.limitation ?? 'розділ доступний лише для читання'}`
        : `Асистент назвав розділ «${action.section}», якого не існує в Менеджменті.`,
    );
  }

  // `section` is passed in rather than read from the router: Quasar builds the router in a
  // factory (`defineRouter`), so there is no module-level instance to import, and `useRouter()`
  // inside a store's setup depends on a component injection context this setup does not have.
  // ManagementPage already knows the active section from its own `useRoute()`, so it hands it
  // over — one source of truth, no second router lookup that could disagree with the strip.
  async function send(text: string, section: string): Promise<void> {
    const projectId = store.selectedProjectId;
    const body = text.trim();
    // Nothing to say, nothing to say it about, or a turn already in flight. Silent because
    // the composer disables its own send disc in exactly these three states.
    if (busy.value || !body || !projectId) return;

    // Appended before the request, so the operator's words are on screen while the model
    // thinks — a turn that takes twenty seconds must not look like a dropped keystroke.
    push(projectId, { kind: 'user', id: entryId(), at: Date.now(), text: body });
    busy.value = true;
    try {
      const ask: ManagementChatAsk = {
        conversationId: conversationId(projectId),
        projectId,
        workspaceProjects: workspaceProjects(projectId),
        text: body,
        context: {
          workspaceName: store.selectedWorkspaceId
            ? (projects.workspaceById.get(store.selectedWorkspaceId)?.name ?? '')
            : '',
          // The cloud name first, the cached local row second — the shell header's two-lookup
          // idiom, so a project whose sync failed is still named in the prompt.
          projectName:
            projects.byId.get(projectId)?.name ??
            store.projects.find((p) => p.id === projectId)?.name ??
            '',
          section,
        },
      };

      const reply = await api.managementChat(ask);
      push(projectId, {
        kind: 'assistant',
        id: entryId(),
        at: Date.now(),
        text: reply.text,
        ms: reply.ms,
        ...(reply.model ? { model: reply.model } : {}),
        ...(reply.usage ? { usage: reply.usage } : {}),
      });

      // Rejections first, then notices: a block that did not validate is the closest thing
      // to a lost instruction, and an operator who believes something was recorded when it
      // was not is exactly how that ends. Notices are omp's own asides and rank below it.
      for (const line of reply.rejected) result(projectId, 'warn', line);
      for (const line of reply.notices) result(projectId, 'info', line);
      // In order: the model may refuse two sections in one turn, and the operator reads
      // those refusals in the order they were asked for.
      for (const action of reply.actions) run(projectId, action);
    } catch (e) {
      // The api failing is news, and news belongs in the transcript. A chat that swallows a
      // dead api looks exactly like a model with nothing to say.
      result(projectId, 'error', errorText(e));
    } finally {
      busy.value = false;
    }
  }

  // «Новий чат»: clears what is on screen AND drops the omp child behind the conversation,
  // because a cleared transcript in front of a model that still remembers the last twenty
  // turns is the opposite of a new chat.
  async function reset(): Promise<void> {
    const projectId = store.selectedProjectId;
    if (busy.value || !projectId) return;
    byProject.value[projectId] = [];
    try {
      await api.resetManagementChat(conversationId(projectId));
    } catch (e) {
      // Reported, never thrown: the screen is already clear, and the operator needs to know
      // that the model's memory is not — otherwise the next answer refers to a conversation
      // that visibly never happened.
      result(projectId, 'error', `Не вдалося скинути розмову: ${errorText(e)}`);
    }
  }

  return { entries, busy, hasConversation, send, reset };
});
