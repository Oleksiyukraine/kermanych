// apps/ui/src/stores/management-chat.ts
// The Менеджмент assistant, browser side: one transcript per scoped workspace, one turn
// through the local api, and the executor that applies the model's validated actions.
//
// The transcript is keyed by WORKSPACE and not by project because every subject of this
// conversation already is: the register the assistant talks about (`workspace_risks`), the
// membership that decides who may read it (`workspace_members`), and the repositories it
// greps (every project of the workspace) all belong to the group. A per-project transcript
// was narrower than every subject in it — the operator had to re-ask one team's question
// once per project to hear about the team.
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
//   3. the WRITING actions execute in the BROWSER, under the user's own Supabase JWT — so
//      RLS, not trust in the model, decides what a given member may change. The Risk
//      Registry branch in `run()` below calls `useRisks().create(workspaceId, …)`; the
//      Release Notes branch hands `useReleaseNotes().generate(…)` a job and that store does
//      the writing. The api deliberately holds no write path of its own and no cloud
//      credentials for either table.
//
// Two sections say `read_write` in @kermanych/core, so four actions reach something:
// `risk.create` / `risk.update` write a row, and `release.notes` STARTS a generation — the
// local api writes the document from git history (it is the only party that can: the commits
// and omp are on THIS machine) and stores/release-notes.ts lands it in the workspace. That
// run is a job of that store, not of this turn: it outlives the chat, reports its own
// outcome and can be retried, so this store only records that it started one. Every other
// section can only be answered with `unsupported`, and its refusal quotes the section table.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { findProjectByName, findRiskByCode, refusalText } from './management-actions';
import type {
  ManagementAction,
  ManagementChatAsk,
  ManagementReleaseNotes,
  ManagementRiskRow,
  ManagementWorkspaceProject,
  Usage,
} from '@kermanych/core';
import { globalTr } from '../boot/i18n';
import { localizeNotice, localizeRejection } from '../lib/i18n-coded';
import { locale } from '../lib/locale';
import { api } from '../lib/api';
import { useOrchestrator } from './orchestrator';
import { useProjects } from './projects';
import { useReleaseNotes } from './release-notes';
import { useRisks } from './risks';

// One line of the conversation. `result` is neither the user's words nor the model's: it is
// what the APP did (or refused to do) about them, which is why it is a third kind with its
// own level rather than an assistant turn with a prefix — the operator must be able to tell
// «я створив ризик» from «ризик створено» at a glance.
export type MgmtChatEntry =
  | { kind: 'user'; id: string; at: number; text: string }
  | { kind: 'assistant'; id: string; at: number; text: string; model?: string; usage?: Usage; ms: number }
  | { kind: 'result'; id: string; at: number; level: 'info' | 'warn' | 'error'; text: string };

export type MgmtResultLevel = Extract<MgmtChatEntry, { kind: 'result' }>['level'];

// Same shape the api keys its omp children by: one conversation per scoped workspace.
function conversationId(workspaceId: string): string {
  return `management:${workspaceId}`;
}

// The toast store's id idiom — monotonic enough for a `:key` and unique enough for two
// entries appended in the same millisecond.
function entryId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// This store runs outside a component, so it localizes a reply's notices through the global
// i18n adapter (`globalTr`) rather than `useI18n()`. Notices become static `result` lines
// the moment they land — like every other line this transcript keeps — so they render in the
// locale that was active when the turn answered, which is the locale the operator asked in.

export const useManagementChat = defineStore('management-chat', () => {
  const store = useOrchestrator();
  const projects = useProjects();
  // The register the write actions land in — and the same store the Risk Registry screen
  // renders, so a risk the assistant files appears on that screen without a refetch.
  const risks = useRisks();
  // The note store the release action lands in — and the same store the Release Notes screen
  // renders, so a note the assistant generated is in that list without a refetch.
  const releaseNotes = useReleaseNotes();

  // Keyed by workspace id, because the conversation id is `management:<workspaceId>`: picking
  // another workspace in the sidebar switches the conversation the api talks to, so it has to
  // switch the conversation on screen too. Keeping one flat list would show the operator a
  // transcript the model no longer has.
  const byWorkspace = ref<Record<string, MgmtChatEntry[]>>({});
  const busy = ref(false);

  const entries = computed<MgmtChatEntry[]>(() => {
    const id = store.selectedWorkspaceId;
    return (id ? byWorkspace.value[id] : undefined) ?? [];
  });

  const hasConversation = computed(() => entries.value.length > 0);

  function push(workspaceId: string, entry: MgmtChatEntry): void {
    const list = byWorkspace.value[workspaceId];
    if (list) list.push(entry);
    else byWorkspace.value[workspaceId] = [entry];
  }

  function result(workspaceId: string, level: MgmtResultLevel, text: string): void {
    push(workspaceId, { kind: 'result', id: entryId(), at: Date.now(), level, text });
  }

  // Requirement 3: the assistant carries every repository of the scoped workspace, not just
  // the screen in front of the operator. Only the id and the cloud row's git remote travel —
  // the api joins them against its own local registry for the on-disk path, so the prompt
  // cannot be talked into naming a directory nobody bound.
  //
  // There is no single-project fallback, because at workspace scope that case cannot arrive:
  // a local-only project resolves to NO workspace, and the shell then refuses to render the
  // chat at all. An empty array is a legitimate answer — a workspace that owns no projects
  // yet — and the api handles it.
  function workspaceProjects(workspaceId: string): ManagementWorkspaceProject[] {
    return projects.projects
      .filter((p) => p.workspaceId === workspaceId)
      .map((p) => ({ id: p.id, ...(p.gitRemoteUrl ? { gitRemoteUrl: p.gitRemoteUrl } : {}) }));
  }

  // The register as the assistant is shown it. Read from the SAME store the Risk Registry
  // screen renders, so the list in the prompt is the list on screen — including the row the
  // assistant filed one turn ago, which is how it learns the code Postgres minted.
  function riskDigest(workspaceId: string): ManagementRiskRow[] {
    return (risks.byWorkspace[workspaceId] ?? []).map((r) => ({
      code: r.code,
      kind: r.kind,
      category: r.category,
      event: r.event,
      probability: r.probability,
      impact: r.impact,
      response: r.response,
      status: r.status,
    }));
  }

  // The one action that is not a database write. A release note is GENERATED by the local
  // api — git history of the bound repo plus its own one-shot omp child, neither of which
  // exists in the browser — and only then stored in the workspace under the operator's own
  // JWT. Neither half is done here: ./release-notes.ts owns the run as a JOB, and this is
  // the second way to start one — the form on ManagementReleasesPage is the first, and it
  // hands `generate` exactly the same job.
  //
  // Deliberately NOT awaited. That store's whole point is that a generation outlives the
  // screen that asked for it: it keeps the in-flight row, announces its own outcome with a
  // toast that finds the operator wherever they walked to, and keeps a retryable row with
  // the reason if it failed. Awaiting here would hold the chat busy for a minute and put the
  // operator back in front of a surface they no longer need to watch — the exact wait that
  // design removed. So the line below is the app's account of what it DID, which is start a
  // generation; the outcome is the job's to report.
  function startReleaseNotes(workspaceId: string, action: ManagementReleaseNotes): void {
    const rows = projects.projects.filter((p) => p.workspaceId === workspaceId);
    const project = findProjectByName(rows, action.project);
    if (!project) {
      // The names it could have meant, so the operator answers in one message instead of
      // guessing which list the assistant was reading.
      const known = rows.map((p) => p.name).join(', ');
      result(
        workspaceId,
        'warn',
        globalTr.t('management.chat.releaseNotesNoProject', { project: action.project }) +
          (known ? globalTr.t('management.chat.releaseNotesKnownProjects', { known }) : ''),
      );
      return;
    }
    void releaseNotes.generate({
      workspaceId,
      // What only the cloud knows travels from here; the api resolves the project id against
      // its own registry for the path. Paths never leave a client.
      workspaceName: projects.workspaceById.get(workspaceId)?.name ?? '',
      projectId: project.id,
      projectName: project.name,
      branch: action.branch,
      rangeFrom: action.rangeFrom,
      rangeTo: action.rangeTo,
    });
    result(
      workspaceId,
      'info',
      globalTr.t('management.chat.releaseNotesStarted', {
        project: project.name,
        branch: action.branch,
        from: action.rangeFrom,
        to: action.rangeTo,
      }),
    );
  }

  // One validated action -> one result line. Never throws: an action that fails must not
  // swallow the actions after it, and a batch where the second is refused still has to
  // report the others.
  //
  // Every line it writes is the APP's account of what happened, never the model's. The model
  // is told (rule (а) of the prompt) not to claim a write succeeded — this is the only place
  // «Ризик R-004 занесено» or «Реліз-ноти готові» may be said, because this is the only place
  // that knows it.
  async function run(workspaceId: string, action: ManagementAction): Promise<void> {
    if (action.kind === 'risk.create') {
      try {
        // No cast and no mapping: `ManagementRiskFields` is deliberately the subset of
        // `WorkspaceRiskInsert` a model may state, field for field. The day the two disagree,
        // this line is the compile error that says so.
        const created = await risks.create(workspaceId, action.risk);
        result(
          workspaceId,
          'info',
          globalTr.t('management.chat.riskCreated', {
            code: created.code,
            event: created.event,
            probability: created.probability,
            impact: created.impact,
          }),
        );
      } catch (e) {
        // The reason, verbatim: an RLS refusal, a CHECK constraint and an unreachable
        // Supabase are three different problems with three different fixes.
        result(workspaceId, 'error', globalTr.t('management.chat.riskCreateFailed', { error: errorText(e) }));
      }
      return;
    }
    if (action.kind === 'risk.update') {
      const row = findRiskByCode(risks.byWorkspace[workspaceId] ?? [], action.code);
      if (!row) {
        result(workspaceId, 'warn', globalTr.t('management.chat.riskNotFound', { code: action.code }));
        return;
      }
      try {
        const saved = await risks.save(workspaceId, row.id, action.patch);
        result(workspaceId, 'info', globalTr.t('management.chat.riskUpdated', { code: saved.code, fields: Object.keys(action.patch).join(', ') }));
      } catch (e) {
        result(workspaceId, 'error', globalTr.t('management.chat.riskUpdateFailed', { code: row.code, error: errorText(e) }));
      }
      return;
    }
    if (action.kind === 'release.notes') {
      startReleaseNotes(workspaceId, action);
      return;
    }
    result(workspaceId, 'warn', refusalText(action));
  }

  // `section` is passed in rather than read from the router: Quasar builds the router in a
  // factory (`defineRouter`), so there is no module-level instance to import, and `useRouter()`
  // inside a store's setup depends on a component injection context this setup does not have.
  // ManagementPage already knows the active section from its own `useRoute()`, so it hands it
  // over — one source of truth, no second router lookup that could disagree with the strip.
  async function send(text: string, section: string): Promise<void> {
    const workspaceId = store.selectedWorkspaceId;
    const body = text.trim();
    // Nothing to say, nothing to say it about, or a turn already in flight. Silent because
    // the composer disables its own send disc in exactly these three states.
    if (busy.value || !body || !workspaceId) return;

    // Appended before the request, so the operator's words are on screen while the model
    // thinks — a turn that takes twenty seconds must not look like a dropped keystroke.
    push(workspaceId, { kind: 'user', id: entryId(), at: Date.now(), text: body });
    busy.value = true;
    try {
      // The register travels with the question, so the assistant can see what is already
      // filed before it files another one. Fetched once per workspace: after that this store
      // IS the local copy — `useRisks().create/save` upsert into it — and refetching every
      // turn would flash the Risk Registry screen's loading state on each message.
      if (!risks.byWorkspace[workspaceId]) await risks.load(workspaceId);
      const ask: ManagementChatAsk = {
        conversationId: conversationId(workspaceId),
        workspaceId,
        workspaceProjects: workspaceProjects(workspaceId),
        text: body,
        context: {
          workspaceName: projects.workspaceById.get(workspaceId)?.name ?? '',
          section,
          risks: riskDigest(workspaceId),
        },
        // The model is told to answer in the operator's active locale (api rule ґ); the
        // prompt body stays Ukrainian.
        locale: locale.value,
      };

      const reply = await api.managementChat(ask);
      push(workspaceId, {
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
      for (const line of reply.rejected) result(workspaceId, 'warn', localizeRejection(globalTr, line));
      for (const line of reply.notices) result(workspaceId, 'info', localizeNotice(globalTr, line));
      // In order and one at a time: the model may file two risks in one turn, and the codes
      // Postgres mints depend on the order they arrive in. Awaited, so the transcript's
      // result lines follow the actions rather than racing them.
      for (const action of reply.actions) await run(workspaceId, action);
    } catch (e) {
      // The api failing is news, and news belongs in the transcript. A chat that swallows a
      // dead api looks exactly like a model with nothing to say.
      result(workspaceId, 'error', errorText(e));
    } finally {
      busy.value = false;
    }
  }

  // «Новий чат»: clears what is on screen AND drops the omp child behind the conversation,
  // because a cleared transcript in front of a model that still remembers the last twenty
  // turns is the opposite of a new chat.
  async function reset(): Promise<void> {
    const workspaceId = store.selectedWorkspaceId;
    if (busy.value || !workspaceId) return;
    byWorkspace.value[workspaceId] = [];
    try {
      await api.resetManagementChat(conversationId(workspaceId));
    } catch (e) {
      // Reported, never thrown: the screen is already clear, and the operator needs to know
      // that the model's memory is not — otherwise the next answer refers to a conversation
      // that visibly never happened.
      result(workspaceId, 'error', globalTr.t('management.chat.resetFailed', { error: errorText(e) }));
    }
  }

  return { entries, busy, hasConversation, send, reset };
});
