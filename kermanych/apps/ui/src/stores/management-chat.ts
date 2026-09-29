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
import { findMemberByName, findProjectByName, findRiskByCode, refusalText } from './management-actions';
import { renderTicketDescription } from '@kermanych/core';
import type {
  ManagementAction,
  ManagementCapacity,
  ManagementChatAsk,
  ManagementHome,
  ManagementJiraBoard,
  ManagementJiraIssueRow,
  ManagementJiraTicketCreate,
  ManagementJiraTicketUpdate,
  ManagementMember,
  ManagementDocs,
  ManagementReleaseNotes,
  ManagementAttachment,
  ManagementRiskExport,
  ManagementRiskRow,
  ManagementTicketCreate,
  ManagementWorkspaceProject,
  Usage,
} from '@kermanych/core';
import type { AttachedFile } from '../lib/files';
import { globalTr } from '../boot/i18n';
import { localizeNotice, localizeRejection } from '../lib/i18n-coded';
import { locale } from '../lib/locale';
import { api } from '../lib/api';
import type { JiraIssueDraftWire, JiraTransitionWire } from '../lib/api';
import { handleOf } from '../lib/members';
import { capacityDigest, capacityReport, digestRange, todayIso } from '../lib/capacity';
import { readCapacityPrefs } from '../lib/capacity-prefs';
import { readLayout } from '../lib/dashboard';
import { useHomeTodo } from './home-todo';
import { homeDigest, todayTaskGroups } from '../lib/home-digest';
import { todoPlainText } from '../lib/home-todo';
import { useBoard } from './board';
import { useJira } from './jira';
import { useOrchestrator } from './orchestrator';
import { useProjects } from './projects';
import { useReleaseNotes } from './release-notes';
import { useRisks } from './risks';
import { useProjectDocs } from './project-docs';
import { useAuth } from './auth';
import { sortRisks } from '../lib/risk';
import type { RiskExportContext } from '../lib/risk-export';
import { saveRiskRegister } from '../lib/export-file';
import type { JiraIntegration, JiraIssue, WorkspaceRisk } from '@kermanych/cloud';
import { getDocIndexState, listJiraIssues, searchProjectDocs } from '@kermanych/cloud';

// One line of the conversation. `result` is neither the user's words nor the model's: it is
// what the APP did (or refused to do) about them, which is why it is a third kind with its
// own level rather than an assistant turn with a prefix — the operator must be able to tell
// «я створив ризик» from «ризик створено» at a glance.
export type MgmtChatEntry =
  // `files` is what travelled with the words — name always, data URL for images so the
  // bubble can echo the thumbnail. The payloads themselves are not kept on the entry: a
  // transcript holding megabytes of base64 per turn would bloat every deep watch of it.
  | { kind: 'user'; id: string; at: number; text: string; files?: MgmtEntryFile[] }
  | { kind: 'assistant'; id: string; at: number; text: string; model?: string; usage?: Usage; ms: number }
  | { kind: 'result'; id: string; at: number; level: 'info' | 'warn' | 'error'; text: string };

export type MgmtEntryFile = { name: string; url?: string };

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
  // The board the native ticket lands on — and the same store «Дошка» renders, so a card the
  // assistant filed is on that screen without a refetch.
  const board = useBoard();
  // The Jira mirror: read for whether the second board exists and may be written, and
  // upserted with the issue the api creates so the Jira view shows it before the next sync.
  const jira = useJira();
  // The Action List tile's list — the same reactive copy HomeTodoWidget renders, so a change
  // the assistant makes is on the dashboard before its notice prints.
  const homeTodo = useHomeTodo();
  // The Проєктна документація screen's selection: which project a docs question is about,
  // and the openFile() a citation click routes through.
  const docsStore = useProjectDocs();
  // The browser Supabase client for documentation retrieval (index state + the docs-rag
  // Edge Function). Retrieval runs under the operator's own JWT, so RLS scopes it.
  const auth = useAuth();

  // Keyed by workspace id, because the conversation id is `management:<workspaceId>`: picking
  // another workspace in the sidebar switches the conversation the api talks to, so it has to
  // switch the conversation on screen too. Keeping one flat list would show the operator a
  // transcript the model no longer has.
  const byWorkspace = ref<Record<string, MgmtChatEntry[]>>({});
  const busy = ref(false);
  // The payloads behind every attachment sent this conversation, keyed workspace → file
  // name (latest attach of a name wins, matching the file the api's copy on disk holds).
  // The key is the TRIMMED name, because that is the only name the model can ever quote
  // back: the api trims a name before it prints it into the turn (management.controller.ts
  // attachmentRows) and `validateManagementAction` trims every entry of `attachments`.
  // Keyed by the raw name, a file the browser called « звіт.pdf » was unresolvable — the
  // ticket was created and the file silently refused as one nobody had attached.
  // A plain Map outside Vue reactivity on purpose: it is read imperatively by the
  // `jira.ticket.create` executor and never rendered — the transcript entries carry only
  // names and thumbnails.
  const sentFiles = new Map<string, Map<string, ManagementAttachment>>();

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

  // The register as a file — the Risk Registry's Export dialog, asked for in words. Built from
  // the register this store already holds (the rows the screen renders) by the same
  // `saveRiskRegister` the dialog calls, so the chat's file is the button's file. Rows come in
  // the screen's default order, by exposure: the chat has no table sort of its own to follow.
  //
  // A named code the register does not hold refuses the WHOLE export — the rule an unknown
  // assignee follows for a ticket. A file quietly missing a row the operator asked for gets
  // forwarded as if it were complete, and nobody reads a file back against the request.
  async function exportRegister(workspaceId: string, action: ManagementRiskExport): Promise<void> {
    const register = sortRisks(risks.byWorkspace[workspaceId] ?? [], 'exposure');
    let rows: WorkspaceRisk[] = register;
    if (action.codes) {
      const picked = new Set<string>();
      const missing: string[] = [];
      for (const code of action.codes) {
        const row = findRiskByCode(register, code);
        if (row) picked.add(row.id);
        else missing.push(code);
      }
      if (missing.length) {
        result(workspaceId, 'warn', globalTr.t('management.chat.riskExportNotFound', { codes: missing.join(', ') }));
        return;
      }
      rows = register.filter((r) => picked.has(r.id));
    }
    if (!rows.length) {
      result(workspaceId, 'warn', globalTr.t('management.chat.riskExportEmpty'));
      return;
    }
    const roster = projects.members[workspaceId] ?? [];
    const ctx: RiskExportContext = {
      t: (key, named) => globalTr.t(key, named),
      // The Risk Registry screen's own owner label (ManagementRisksPage `memberOptions`), so
      // an owner reads the same in this file as in the one the button makes.
      memberName: (id) => {
        const m = roster.find((x) => x.userId === id);
        return m?.profile?.displayName ?? m?.profile?.githubUsername ?? id;
      },
      workspaceName: projects.workspaceById.get(workspaceId)?.name ?? '',
      scope: action.codes ? 'selected' : 'all',
      nowMs: Date.now(),
    };
    try {
      const saved = await saveRiskRegister(rows, ctx, action.format);
      result(
        workspaceId,
        'info',
        saved.via === 'print'
          ? globalTr.t('management.chat.riskExportPrinting', { n: rows.length }, rows.length)
          : globalTr.t('management.chat.riskExportSaved', { n: rows.length, file: saved.fileName }, rows.length),
      );
    } catch (e) {
      result(workspaceId, 'error', globalTr.t('management.risks.export.failed', { error: errorText(e) }));
    }
  }

  // The roster as the assistant is shown it, and the list `findMemberByName` resolves an
  // assignee against one moment later. Read from the SAME store the Risk Registry screen
  // renders its owner pickers from, so the names in the prompt are the names on screen.
  function memberDigest(workspaceId: string): ManagementMember[] {
    return (projects.members[workspaceId] ?? []).map((m) => ({ name: handleOf(m), role: m.role }));
  }

  // The workspace's Jira board, or nothing — the only thing that tells the model the second
  // board exists. `canWrite` is the token on THIS machine: a member who can SEE the mirror
  // but has no personal token cannot create anything in Jira, because every Jira write is
  // signed with the acting user's own credentials, and an assistant that offered a ticket
  // there would be promising something the api refuses one round trip later.
  //
  // `assignees` is Jira's OWN list and is what makes a Jira ticket assignable at all. Without
  // it the only names in the prompt were the workspace roster, so the assistant refused every
  // Jira assignee who has no Kermanych account — which is most of them, and exactly the
  // people the operator sees in Jira's own picker when they file the same ticket by hand.
  // Fetched by `loadAssignable`, which degrades to an empty list; `jiraLines` in the prompt
  // says so rather than reading empty as «nobody».
  async function jiraDigest(): Promise<ManagementJiraBoard[]> {
    const boards = jira.integrations;
    if (!boards.length) return [];
    // canWrite = «does this machine hold a token for the board's site». The ACTIVE board's is
    // the store's own flag (already probed); the OTHER boards need a local registry read per
    // unique site — cheap, and usually one call because boards often share a site. Both
    // degrade to false on failure.
    const others = boards.filter((b) => b.id !== jira.activeId);
    const present: Record<string, boolean> = {};
    await Promise.all(
      [...new Set(others.map((b) => b.siteUrl))].map(async (s) => {
        try {
          present[s] = (await api.jiraTokenStatus(s)).present;
        } catch {
          present[s] = false;
        }
      }),
    );
    // Assignees only for the ACTIVE board, whose roster the store already holds; the executor
    // re-queries Jira live against whichever board a ticket actually targets, so a name off
    // another board's picker is still resolved at create time.
    const activeAssignees = jira.tokenPresent ? (await jira.loadAssignable()).map((u) => u.displayName) : [];
    const tickets = await Promise.all(boards.map(boardTickets));
    return boards.map((b, i) => {
      const issues = tickets[i];
      return {
        projectKey: b.projectKey,
        boardName: b.boardName,
        canWrite: b.id === jira.activeId ? jira.tokenPresent : (present[b.siteUrl] ?? false),
        assignees: b.id === jira.activeId ? activeAssignees : [],
        ...(issues ? { issues } : {}),
      };
    });
  }

  // One board's tickets for the api's snapshot file — the assistant's way to find a key the
  // operator only described and to read an issue before `jira.ticket.update` rewrites it. The
  // active board's list is the one the Jira view renders (kept fresh by realtime, loaded once
  // per turn by `send` if nobody has opened it yet); any other board is read from the mirror under the
  // operator's own JWT, so the assistant sees exactly the tickets the operator could open.
  // `undefined` on failure — the prompt then says the snapshot is unavailable instead of
  // presenting an empty board.
  async function boardTickets(b: JiraIntegration): Promise<ManagementJiraIssueRow[] | undefined> {
    let rows: JiraIssue[];
    if (b.id === jira.activeId) {
      if (jira.loadError) return undefined;
      rows = jira.issues;
    } else {
      try {
        rows = await listJiraIssues(auth.client, b.id);
      } catch {
        return undefined;
      }
    }
    return rows.map((i) => ({
      key: i.key,
      summary: i.summary,
      type: i.typeName,
      status: i.statusName,
      priority: i.priorityName,
      assignee: i.assigneeName ?? '',
      ...(i.parentKey ? { parentKey: i.parentKey } : {}),
      labels: i.labels,
      startDate: i.startDate,
      dueDate: i.dueDate,
      originalEstimate: i.originalEstimate,
      description: i.descriptionHtml,
    }));
  }

  // The Home overview as the assistant is shown it: the SAME data the dashboard tiles render
  // (lib/home-digest.ts) — the operator's tile layout, their Action List, today's tasks and
  // the recent release notes. The capacity and risks tiles are not repeated here; their data
  // already travels in `capacity` and `risks`. Always present: a workspace with no Jira and
  // no notes still has a layout and an Action List to describe. The notes read is spent only
  // when the store is cold and degrades to an empty list — an unreachable cloud costs the
  // assistant one tile, not the answer.
  async function homeDigestFor(workspaceId: string): Promise<ManagementHome> {
    if (!releaseNotes.byWorkspace[workspaceId])
      try {
        await releaseNotes.load(workspaceId);
      } catch {
        /* no notes this turn */
      }
    return homeDigest({
      layout: readLayout(workspaceId),
      todo: homeTodo.listFor(workspaceId),
      groups: jira.integration ? todayTaskGroups(jira.issues, todayIso(Date.now())) : [],
      notes: releaseNotes.byWorkspace[workspaceId] ?? [],
    });
  }

  // Team Capacity as the assistant is shown it: the same `capacityReport` the screen renders,
  // over the fixed digest window, by week. The operator's own view of the team travels with
  // it — the inactive marks (`excluded`) and the configured hours — so the assistant reasons
  // about the people who actually count and quotes the same capacity the screen does, not a
  // roster padded with muted or non-participating accounts. Only with a Jira board — the
  // native board has no estimates — and never fatal: a failed read costs the assistant this
  // one block, and the prompt then says capacity is unavailable rather than inventing it.
  async function capacityDigestFor(workspaceId: string): Promise<ManagementCapacity | undefined> {
    if (!jira.integration) return undefined;
    try {
      const today = todayIso(Date.now());
      const range = digestRange(today);
      const worklogs = await jira.fetchWorklogs(range);
      const prefs = readCapacityPrefs(workspaceId);
      const excluded = Array.isArray(prefs?.excluded) ? prefs.excluded : [];
      const hoursPerDay = typeof prefs?.teamHoursPerDay === 'number' ? prefs.teamHoursPerDay : undefined;
      const hoursPerDayByPerson = prefs?.capacityMode === 'member' && prefs.memberHours ? prefs.memberHours : undefined;
      return capacityDigest(
        capacityReport(jira.issues, worklogs, {
          range,
          today,
          granularity: 'week',
          excluded,
          ...(hoursPerDay !== undefined ? { hoursPerDay } : {}),
          ...(hoursPerDayByPerson ? { hoursPerDayByPerson } : {}),
        }),
      );
    } catch {
      return undefined;
    }
  }

  // The documentation retrieval block for a turn, or undefined when it does not apply. Only
  // the Проєктна документація section with a project selected retrieves; every other section
  // omits the block entirely. When a project has no index the block is "not-indexed" (the
  // prompt then makes the assistant say so plainly instead of grepping); otherwise one Edge
  // Function call embeds the question and searches, degrading to full-text if Voyage is down.
  async function docsDigest(section: string, query: string): Promise<ManagementDocs | undefined> {
    if (section !== 'management-docs') return undefined;
    const projectId = docsStore.activeProjectId;
    if (!projectId) return undefined;
    const projectName = projects.projects.find((p) => p.id === projectId)?.name ?? '';
    try {
      const state = await getDocIndexState(auth.client, projectId);
      if (state.fileCount === 0) return { status: 'not-indexed', projectName, fragments: [] };
      const res = await searchProjectDocs(auth.client, { projectId, query });
      return { status: res.status, projectName, fragments: res.fragments };
    } catch {
      // Retrieval unreachable this turn (network). Omit the block rather than block the
      // question; the model answers from the rest of the context.
      return undefined;
    }
  }

  // The assignee a ticket named, resolved to the uuid the row carries — or a refusal.
  //
  // A named-but-unresolvable assignee refuses the whole ticket rather than filing it
  // unassigned, and that is the deliberate half: «створи тікет на Олю» has exactly one right
  // outcome, and a card that silently lands in nobody's queue is the one failure the operator
  // would not notice. Not naming an assignee is different and perfectly fine — an unassigned
  // card is the board's normal state.
  function resolveAssignee(workspaceId: string, name: string | undefined): string | undefined | { error: string } {
    if (name === undefined) return undefined;
    const roster = projects.members[workspaceId] ?? [];
    const member = findMemberByName(roster, name);
    if (member) return member.userId;
    const known = roster.map(handleOf).join(', ');
    return {
      error:
        globalTr.t('management.chat.ticketMemberMissing', { name }) +
        (known ? globalTr.t('management.chat.releaseNotesKnownProjects', { known }) : ''),
    };
  }

  // One card on the workspace's own board — the DEFAULT board, and a plain `tasks` insert
  // under the operator's own JWT, exactly like the board's own «Нова задача» form. `board`
  // is the same store BoardPage renders, so a ticket filed here is on «Дошка» without a
  // refetch.
  //
  // The description is NOT the model's prose: `renderTicketDescription` builds it from the
  // five validated slots, so every ticket from this chat has the same headings in the same
  // order whichever turn produced it.
  async function createBoardTicket(workspaceId: string, action: ManagementTicketCreate): Promise<void> {
    const rows = projects.projects.filter((p) => p.workspaceId === workspaceId);
    const project = findProjectByName(rows, action.project);
    if (!project) {
      const known = rows.map((p) => p.name).join(', ');
      result(
        workspaceId,
        'warn',
        globalTr.t('management.chat.ticketProjectMissing', { project: action.project }) +
          (known ? globalTr.t('management.chat.releaseNotesKnownProjects', { known }) : ''),
      );
      return;
    }
    const assignee = resolveAssignee(workspaceId, action.assignee);
    if (assignee !== undefined && typeof assignee !== 'string') {
      result(workspaceId, 'warn', assignee.error);
      return;
    }
    // `createTask` reports its own failures through a toast and answers `undefined`; it never
    // throws. The transcript still has to say the ticket did not land, because the operator
    // asked for it here.
    const created = await board.createTask({
      projectId: project.id,
      title: action.ticket.title,
      description: renderTicketDescription(action.ticket),
      ...(assignee ? { assigneeId: assignee } : {}),
      ...(action.prefix ? { prefix: action.prefix } : {}),
      ...(action.platform ? { platform: action.platform } : {}),
    });
    if (!created) {
      result(workspaceId, 'error', globalTr.t('management.chat.ticketCreateFailed', { title: action.ticket.title }));
      return;
    }
    result(
      workspaceId,
      'info',
      assignee
        ? globalTr.t('management.chat.ticketCreatedAssigned', {
            title: created.title,
            project: project.name,
            assignee: action.assignee,
          })
        : globalTr.t('management.chat.ticketCreatedUnassigned', { title: created.title, project: project.name }),
    );
    // `tasks` has no attachment storage, so a card on this board cannot carry a file at all.
    // The prompt says so and tells the assistant to say it in prose — this line is the belt
    // and braces, in the app's own voice: a ticket filed silently without the file the
    // operator asked for is indistinguishable from an upload that failed.
    if (action.attachments?.length)
      result(
        workspaceId,
        'warn',
        globalTr.t('management.chat.boardAttachUnsupported', {
          names: action.attachments.map((n) => `«${n}»`).join(', '),
          count: action.attachments.length,
        }),
      );
  }

  // One issue on the mirrored Jira board. Unlike every other action here this does NOT write
  // through Supabase: the Jira token lives in this machine's registry and never reaches the
  // browser, so the write goes out through the local api — the same route
  // `JiraIssueEditor.vue` takes, followed by the same `jira.upsert` so the card is on the
  // Jira view without waiting for the next 30-second sync.
  //
  // Both prerequisites are checked here rather than trusted from the prompt. The model is
  // TOLD whether the board exists and whether it is writable (contextBlock prints both), but
  // a turn can be answered from a conversation that started before the integration was
  // removed, and «I created it» must never be said about a call that could not be signed.
  //
  // `created` is the reply's ledger of `ref` → minted key: a sequence (an epic and its
  // stories) is one reply whose children name their parent by a label, because the key Jira
  // gives the parent does not exist when the model writes the batch. A child whose parent
  // did not land is refused rather than filed parentless — a story outside its epic is the
  // quiet misfiling this chat's refusals exist to prevent.
  async function createJiraTicket(
    workspaceId: string,
    action: ManagementJiraTicketCreate,
    created: Map<string, string>,
  ): Promise<void> {
    const boards = jira.integrations;
    if (!boards.length) {
      result(workspaceId, 'warn', globalTr.t('jira.notify.noBoardForTicket'));
      return;
    }
    // Which board the ticket lands on. Named by board name when the workspace has several;
    // the sole board is the answer when only one is connected and none was named.
    const target = action.board
      ? boards.find((b) => b.boardName.toLowerCase() === action.board!.toLowerCase())
      : boards.length === 1
        ? boards[0]
        : undefined;
    if (!target) {
      result(
        workspaceId,
        'warn',
        action.board
          ? globalTr.t('jira.notify.unknownBoard', { board: action.board, boards: boards.map((b) => b.boardName).join(', ') })
          : globalTr.t('jira.notify.boardNotNamed', { boards: boards.map((b) => b.boardName).join(', ') }),
      );
      return;
    }
    const parentKey = action.parentRef !== undefined ? created.get(action.parentRef) : action.parentKey;
    if (action.parentRef !== undefined && parentKey === undefined) {
      result(workspaceId, 'warn', globalTr.t('jira.notify.parentRefMissing', { title: action.ticket.title, ref: action.parentRef }));
      return;
    }
    // Make it the active board so its site token and assignable roster are the ones every
    // call below signs and resolves against.
    if (jira.activeId !== target.id) await jira.setActive(target.id);
    if (!jira.tokenPresent) {
      result(workspaceId, 'warn', globalTr.t('jira.notify.noTokenForTicket'));
      return;
    }
    try {
      const draft: JiraIssueDraftWire = {
        summary: action.ticket.title,
        description: renderTicketDescription(action.ticket),
        ...(action.labels ? { labels: action.labels } : {}),
        ...(parentKey ? { parentKey } : {}),
      };
      const ids = await jiraOptionIds(target.id, action.issueType, action.priority);
      if ('missing' in ids) {
        result(
          workspaceId,
          'warn',
          ids.missing === 'type'
            ? globalTr.t('jira.notify.unknownType', { type: ids.value, options: ids.options })
            : globalTr.t('jira.notify.unknownPriority', { priority: ids.value, options: ids.options }),
        );
        return;
      }
      Object.assign(draft, ids);
      if (action.assignee !== undefined) {
        const user = await jiraAssignee(target.id, action.assignee);
        if (typeof user !== 'string') {
          result(
            workspaceId,
            'warn',
            globalTr.t('jira.notify.unknownAssignee', { assignee: action.assignee }) +
              (user.known ? globalTr.t('jira.notify.assigneeHint', { known: user.known }) : ''),
          );
          return;
        }
        draft.assigneeAccountId = user;
      }
      const issue = await api.jiraCreateIssue(target.id, draft);
      jira.upsert(issue);
      if (action.ref !== undefined) created.set(action.ref, issue.key);
      result(
        workspaceId,
        'info',
        globalTr.t('jira.notify.ticketCreated', { key: issue.key, summary: issue.summary, board: target.boardName }),
      );
      await uploadJiraFiles(workspaceId, target.id, issue.key, action.attachments ?? []);
    } catch (e) {
      // Verbatim: a dead token, a field the Jira project made mandatory and an unreachable
      // site are three different problems with three different fixes.
      result(workspaceId, 'error', globalTr.t('jira.notify.ticketCreateFailed', { error: errorText(e) }));
    }
  }

  // One change to an EXISTING issue, through the same local-api route the ticket dialog's
  // «Редагувати» takes. The board is found by the key's project prefix — the key is the one
  // thing the operator and the model both have — and everything the patch names is resolved
  // (type, priority, assignee, the workflow transition) BEFORE anything is written, so a
  // refusal really does mean «nothing was changed», which is what its line says.
  //
  // `status` is not a field Jira lets anyone set: an issue moves through the workflow's
  // transitions, so the executor picks the transition that lands in the named status and
  // names the reachable ones when there is none.
  async function updateJiraTicket(workspaceId: string, action: ManagementJiraTicketUpdate): Promise<void> {
    const { key, patch } = action;
    const boards = jira.integrations;
    const project = key.slice(0, key.lastIndexOf('-'));
    const matching = boards.filter((b) => b.projectKey.toUpperCase() === project);
    // Two boards over one project are two views of the same issues; the one on screen wins.
    const target = matching.find((b) => b.id === jira.activeId) ?? matching[0];
    if (!target) {
      result(
        workspaceId,
        'warn',
        globalTr.t('jira.notify.updateNoBoard', { project, key, boards: boards.map((b) => b.boardName).join(', ') || '—' }),
      );
      return;
    }
    if (jira.activeId !== target.id) await jira.setActive(target.id);
    if (!jira.tokenPresent) {
      result(workspaceId, 'warn', globalTr.t('jira.notify.noTokenForUpdate', { key }));
      return;
    }
    try {
      const draft: JiraIssueDraftWire = {};
      if (patch.ticket) {
        draft.summary = patch.ticket.title;
        draft.description = renderTicketDescription(patch.ticket);
      }
      if (patch.title !== undefined) draft.summary = patch.title;
      if (patch.labels !== undefined) draft.labels = patch.labels;
      if (patch.dueDate !== undefined) draft.dueDate = patch.dueDate;
      if (patch.startDate !== undefined) draft.startDate = patch.startDate;
      if (patch.originalEstimate !== undefined) draft.originalEstimate = patch.originalEstimate;
      if (patch.parentKey !== undefined) draft.parentKey = patch.parentKey;
      if (patch.unassign) draft.assigneeAccountId = null;
      const ids = await jiraOptionIds(target.id, patch.issueType, patch.priority);
      if ('missing' in ids) {
        result(
          workspaceId,
          'warn',
          ids.missing === 'type'
            ? globalTr.t('jira.notify.updateUnknownType', { type: ids.value, key, options: ids.options })
            : globalTr.t('jira.notify.updateUnknownPriority', { priority: ids.value, key, options: ids.options }),
        );
        return;
      }
      Object.assign(draft, ids);
      if (patch.assignee !== undefined) {
        const user = await jiraAssignee(target.id, patch.assignee);
        if (typeof user !== 'string') {
          result(
            workspaceId,
            'warn',
            globalTr.t('jira.notify.updateUnknownAssignee', { assignee: patch.assignee, key }) +
              (user.known ? globalTr.t('jira.notify.assigneeHint', { known: user.known }) : ''),
          );
          return;
        }
        draft.assigneeAccountId = user;
      }
      let move: JiraTransitionWire | undefined;
      if (patch.status !== undefined) {
        const wanted = patch.status.toLowerCase();
        const transitions = await api.jiraTransitions(target.id, key);
        move =
          transitions.find((t) => t.to.name.toLowerCase() === wanted) ??
          transitions.find((t) => t.name.toLowerCase() === wanted);
        if (!move) {
          result(
            workspaceId,
            'warn',
            globalTr.t('jira.notify.updateUnknownStatus', {
              key,
              status: patch.status,
              options: [...new Set(transitions.map((t) => t.to.name))].join(', ') || '—',
            }),
          );
          return;
        }
      }
      let issue: JiraIssue | undefined;
      if (Object.keys(draft).length) {
        issue = await api.jiraEditIssue(target.id, key, draft);
        jira.upsert(issue);
      }
      if (move) {
        issue = await api.jiraTransition(target.id, key, move.id);
        jira.upsert(issue);
      }
      // A patch of files alone writes no field, and its lines below are the whole account.
      if (issue) {
        const fields = Object.keys(patch)
          .filter((f) => f !== 'attachments')
          .map((f) =>
            f === 'ticket'
              ? 'summary, description'
              : f === 'title'
                ? 'summary'
                : f === 'unassign'
                  ? 'assignee'
                  : f === 'status'
                    ? `status → ${move?.to.name ?? patch.status}`
                    : f,
          )
          .join(', ');
        result(
          workspaceId,
          'info',
          globalTr.t('jira.notify.ticketUpdated', { key, summary: issue.summary, board: target.boardName, fields }),
        );
      }
      await uploadJiraFiles(workspaceId, target.id, key, patch.attachments ?? []);
    } catch (e) {
      result(workspaceId, 'error', globalTr.t('jira.notify.ticketUpdateFailed', { key, error: errorText(e) }));
    }
  }

  // The names the model was allowed to state, turned into the ids Jira's own API wants.
  // `jira_issues` mirrors only the display name of a type and a priority, so the ids come
  // from the live editor options — fetched only when the model actually named one, because
  // this is two Jira calls and an unnamed type simply lets the project's default apply.
  // A name the board does not have comes back as `missing`, with the names it does have.
  async function jiraOptionIds(
    integrationId: string,
    issueType: string | undefined,
    priority: string | undefined,
  ): Promise<{ issueTypeId?: string; priorityId?: string } | { missing: 'type' | 'priority'; value: string; options: string }> {
    if (issueType === undefined && priority === undefined) return {};
    const options = await api.jiraEditorOptions(integrationId);
    const out: { issueTypeId?: string; priorityId?: string } = {};
    if (issueType !== undefined) {
      const type = options.issueTypes.find((t) => t.name.toLowerCase() === issueType.toLowerCase());
      if (!type) return { missing: 'type', value: issueType, options: options.issueTypes.map((t) => t.name).join(', ') };
      out.issueTypeId = type.id;
    }
    if (priority !== undefined) {
      const p = options.priorities.find((x) => x.name.toLowerCase() === priority.toLowerCase());
      if (!p) return { missing: 'priority', value: priority, options: options.priorities.map((x) => x.name).join(', ') };
      out.priorityId = p.id;
    }
    return out;
  }

  // A Jira assignee is an ATLASSIAN account, not a Kermanych member, so the workspace roster
  // has no say here at all: Jira itself is asked who may be assigned on this project, which is
  // the same list the ticket dialog's picker shows. A Jira seat with no Kermanych account is a
  // perfectly ordinary assignee and must resolve.
  //
  // The live query rather than `jira.assignable`: the cached list is capped by Jira's page
  // size, so a large site can hold assignable people the prompt never printed, and a name the
  // operator gave explicitly must still be resolvable. A name Jira itself does not know comes
  // back with who IS assignable, so the refusal leaves the operator a next move.
  async function jiraAssignee(integrationId: string, name: string): Promise<string | { known: string }> {
    const candidates = await api.jiraAssignableUsers(integrationId, name);
    const wanted = name.toLowerCase();
    const user =
      candidates.find((u) => u.displayName.toLowerCase() === wanted) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    if (user) return user.accountId;
    // Jira's search matched nothing, so the near-misses are no help: name who IS assignable
    // instead, from the list already in hand.
    const near = candidates.map((u) => u.displayName);
    return { known: (near.length ? near : jira.assignable.map((u) => u.displayName)).join(', ') };
  }

  // The files the model asked to put on an issue — resolved by NAME against what the operator
  // actually attached this conversation, never from the model's own bytes. In order and
  // awaited, so the transcript reports each upload beside the write it belongs to; a name
  // nobody attached is refused per file rather than sinking the issue that already exists.
  async function uploadJiraFiles(workspaceId: string, integrationId: string, key: string, names: string[]): Promise<void> {
    for (const name of names) {
      const file = sentFiles.get(workspaceId)?.get(name);
      if (!file) {
        result(workspaceId, 'warn', globalTr.t('management.chat.jiraAttachUnknown', { name, key }));
        continue;
      }
      try {
        // The api answers an upload with the REFRESHED issue (jira.service.ts
        // uploadAttachment → refreshIssue), so the card carries the file at once. Dropping
        // that answer left «Файл прикріплено» beside a ticket whose «Вкладення» tab stayed
        // empty until the next 30-second poll — which reads exactly like the failure this
        // whole path is about.
        jira.upsert(await api.jiraUploadAttachment(integrationId, key, name, file.data, file.mimeType));
        result(workspaceId, 'info', globalTr.t('management.chat.jiraAttachUploaded', { name, key }));
      } catch (e) {
        result(workspaceId, 'error', globalTr.t('management.chat.jiraAttachFailed', { name, key, error: errorText(e) }));
      }
    }
  }

  // One validated action -> one result line. Never throws: an action that fails must not
  // swallow the actions after it, and a batch where the second is refused still has to
  // report the others.
  //
  // Every line it writes is the APP's account of what happened, never the model's. The model
  // is told (rule (а) of the prompt) not to claim a write succeeded — this is the only place
  // «Ризик R-004 занесено» or «Реліз-ноти готові» may be said, because this is the only place
  // that knows it.
  //
  // `created` lives for one reply: the `ref` → key ledger a sequence of Jira tickets resolves
  // its `parentRef`s against.
  async function run(workspaceId: string, action: ManagementAction, created: Map<string, string>): Promise<void> {
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
    if (action.kind === 'risk.delete') {
      // Resolved against the register the browser already holds, exactly as `risk.update`
      // resolves it — and for a sharper reason here. A delete sends only an id, and postgrest
      // answers a delete that matched no row the same way it answers one that matched, so
      // «R-999» would otherwise be reported as a successful deletion of nothing.
      const row = findRiskByCode(risks.byWorkspace[workspaceId] ?? [], action.code);
      if (!row) {
        result(workspaceId, 'warn', globalTr.t('management.chat.riskNotFound', { code: action.code }));
        return;
      }
      try {
        await risks.remove(workspaceId, row.id);
        // The code AND the statement, unlike the update line: after this call the row is
        // gone from the register, so the transcript is the only place left that says what
        // R-004 actually was. A bare code would leave the operator unable to tell what they
        // had just agreed to lose.
        result(
          workspaceId,
          'info',
          globalTr.t('management.chat.riskDeleted', { code: row.code, event: row.event }),
        );
      } catch (e) {
        // Verbatim, and the one refusal here an operator can act on is a permission one:
        // delete is workspace-owner while everything else in this register is member-level,
        // so «row-level security» in this line means «ask the owner», not «try again».
        result(
          workspaceId,
          'error',
          globalTr.t('management.chat.riskDeleteFailed', { code: row.code, error: errorText(e) }),
        );
      }
      return;
    }
    if (action.kind === 'risk.export') {
      await exportRegister(workspaceId, action);
      return;
    }
    if (action.kind === 'release.notes') {
      startReleaseNotes(workspaceId, action);
      return;
    }
    if (action.kind === 'ticket.create') {
      await createBoardTicket(workspaceId, action);
      return;
    }
    if (action.kind === 'jira.ticket.create') {
      await createJiraTicket(workspaceId, action, created);
      return;
    }
    if (action.kind === 'jira.ticket.update') {
      await updateJiraTicket(workspaceId, action);
      return;
    }
    // The Home overview's create write. Rows land in the same store the Action List tile renders —
    // on the dashboard before this notice prints — and in this browser's localStorage only,
    // which is exactly what the prompt told the model about the list's scope. Nothing here
    // can fail short of a private-mode write, which lib/home-todo swallows by design.
    if (action.kind === 'todo.create') {
      const made = homeTodo.append(workspaceId, action.items);
      result(
        workspaceId,
        'info',
        globalTr.t(
          'management.chat.todoAdded',
          { n: made.length, items: action.items.map((i) => `«${i.text}»`).join(', ') },
          made.length,
        ),
      );
      return;
    }
    // Change one Action List row, addressed by the #N position the digest printed. A position
    // that names no row changed nothing, and the notice says exactly that rather than claiming
    // an edit — `warn`, because the operator's ask did not land.
    if (action.kind === 'todo.update') {
      const item = homeTodo.updateAt(workspaceId, action.index, action.patch);
      result(
        workspaceId,
        item ? 'info' : 'warn',
        item
          ? globalTr.t('management.chat.todoUpdated', { index: action.index, text: todoPlainText(item.html) })
          : globalTr.t('management.chat.todoIndexMissing', { index: action.index }),
      );
      return;
    }
    // Remove one row, addressed the same way. The notice quotes what went — the tile may be
    // scrolled out of view when it prints — or says the position named none.
    if (action.kind === 'todo.delete') {
      const removed = homeTodo.removeAt(workspaceId, action.index);
      result(
        workspaceId,
        removed ? 'info' : 'warn',
        removed
          ? globalTr.t('management.chat.todoDeleted', { index: action.index, text: todoPlainText(removed.html) })
          : globalTr.t('management.chat.todoIndexMissing', { index: action.index }),
      );
      return;
    }
    // Nothing was written, and that IS the outcome: the assistant needs a decision only the
    // operator can make, so the ticket stays unfiled until the next turn answers. Stated in
    // the app's own voice and numbered, because a question the operator reads past is a
    // ticket they will keep waiting for. `warn`, not `info` — this is work that did not
    // happen.
    if (action.kind === 'ticket.questions') {
      result(
        workspaceId,
        'warn',
        globalTr.t('management.chat.ticketNeedsAnswers', {
          ticket: action.forTicket,
          questions: action.questions.map((q, i) => `${i + 1}) ${q}`).join(' '),
        }),
      );
      return;
    }
    result(workspaceId, 'warn', refusalText(action));
  }

  // `section` is passed in rather than read from the router: Quasar builds the router in a
  // factory (`defineRouter`), so there is no module-level instance to import, and `useRouter()`
  // inside a store's setup depends on a component injection context this setup does not have.
  // ManagementPage already knows the active section from its own `useRoute()`, so it hands it
  // over — one source of truth, no second router lookup that could disagree with the strip.
  async function send(text: string, section: string, attachments: AttachedFile[] = []): Promise<void> {
    const workspaceId = store.selectedWorkspaceId;
    const body = text.trim();
    // Nothing to say, nothing to say it about, or a turn already in flight. Silent because
    // the composer disables its own send disc in exactly these three states. A turn of
    // files alone is a legitimate message — «ось документ» often has no words.
    if (busy.value || (!body && !attachments.length) || !workspaceId) return;

    // Kept OUTSIDE the transcript: the payloads back `jira.ticket.create.attachments` one
    // or more turns later, and the entry itself carries only names and thumbnails.
    if (attachments.length) {
      const perWs = sentFiles.get(workspaceId) ?? new Map<string, ManagementAttachment>();
      for (const f of attachments) {
        const name = f.name.trim();
        perWs.set(name, { name, mimeType: f.mimeType, data: f.data });
      }
      sentFiles.set(workspaceId, perWs);
    }

    // Appended before the request, so the operator's words are on screen while the model
    // thinks — a turn that takes twenty seconds must not look like a dropped keystroke.
    push(workspaceId, {
      kind: 'user',
      id: entryId(),
      at: Date.now(),
      text: body,
      ...(attachments.length
        ? { files: attachments.map((f) => ({ name: f.name, ...(f.url ? { url: f.url } : {}) })) }
        : {}),
    });
    busy.value = true;
    try {
      // The register travels with the question, so the assistant can see what is already
      // filed before it files another one. Fetched once per workspace: after that this store
      // IS the local copy — `useRisks().create/save` upsert into it — and refetching every
      // turn would flash the Risk Registry screen's loading state on each message.
      if (!risks.byWorkspace[workspaceId]) await risks.load(workspaceId);
      // The two rosters and the Jira board are what a TICKET needs and nothing else on this
      // surface does, so they are fetched here on the same once-per-workspace terms as the
      // register, and each is cached by its own store. `probe` answers whether this machine
      // holds a Jira token, which decides whether the assistant may offer the Jira board at
      // all; `jiraDigest` then reads Jira's assignable users through it, which is the one
      // genuine third-party call on this path — spent once per conversation, and only for a
      // board this operator can actually write to.
      //
      // Sequential rather than parallel with the register on purpose: three requests fired at
      // one Supabase project on the first keystroke of a conversation buys nothing a person
      // can perceive, and the register is the one a majority of turns actually reads.
      // `loadMembers` THROWS on a cloud failure — the membership screen wants to know — while
      // this turn does not: an unreachable roster costs the assistant the ability to assign a
      // ticket, not the ability to answer. Swallowed, and the context block then prints
      // «список недоступний», which is the honest sentence for it.
      if (!projects.members[workspaceId])
        try {
          await projects.loadMembers(workspaceId);
        } catch {
          /* no roster this turn */
        }
      if (jira.integration === undefined) await jira.probe(workspaceId);
      // The active board's mirror, loaded ONCE for the turn: both the ticket snapshot and the
      // capacity digest read it, and a board nobody has opened yet is otherwise empty here.
      if (jira.integration && !jira.issues.length) await jira.loadBoard();
      const jiraBoards = await jiraDigest();
      const capacity = await capacityDigestFor(workspaceId);
      // Documentation retrieval, ONLY in the Проєктна документація section and only once a
      // project is selected: embed the question and search, in one Edge Function round trip,
      // so the model is handed passages instead of the tools to go grep for them. Retrieval
      // happens BEFORE the turn on purpose — that is what removes the agent loop. A total
      // failure (network) leaves `docs` undefined and the turn answers without the block; the
      // Voyage-down case does NOT throw — the function returns status "fulltext".
      const docs = await docsDigest(section, body);
      const ask: ManagementChatAsk = {
        conversationId: conversationId(workspaceId),
        workspaceId,
        workspaceProjects: workspaceProjects(workspaceId),
        text: body,
        context: {
          workspaceName: projects.workspaceById.get(workspaceId)?.name ?? '',
          section,
          risks: riskDigest(workspaceId),
          members: memberDigest(workspaceId),
          ...(jiraBoards.length ? { jira: jiraBoards } : {}),
          ...(capacity ? { capacity } : {}),
          home: await homeDigestFor(workspaceId),
          ...(docs ? { docs } : {}),
        },
        // The model is told to answer in the operator's active locale (api rule ґ); the
        // prompt body stays Ukrainian.
        locale: locale.value,
        ...(attachments.length
          ? { attachments: attachments.map((f) => ({ name: f.name, mimeType: f.mimeType, data: f.data })) }
          : {}),
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
      // A sequence is still this loop: one action per ticket, in the order the model wrote
      // them, so a parent is created before the children that name it by `ref`.
      const created = new Map<string, string>();
      for (const action of reply.actions) await run(workspaceId, action, created);
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
    // The attachment payloads die with the conversation: a «новий чат» that still resolves
    // last conversation's file names would attach bytes the transcript no longer shows.
    sentFiles.delete(workspaceId);
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
