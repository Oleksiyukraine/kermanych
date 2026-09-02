// apps/api/src/jira/jira.service.ts
// The Jira integration's engine: token custody, the connect flow, the polling sync that
// keeps the Supabase mirror honest, and every user action (transition, comment, author,
// launch) — each of which is one Jira call under the ACTING user's token followed by a
// mirror patch under their JWT, so the board reflects the action without waiting for
// the next poll.
//
// Jira is the source of truth. Nothing here merges: mirror rows are overwritten from
// Jira responses, and a disagreement is resolved by refetching the issue.
import { Injectable, Optional } from "@nestjs/common";
import { Buffer } from "node:buffer";
import {
  advanceJiraSyncCursor,
  createTask,
  deleteJiraIntegration,
  deleteJiraIssues,
  ensureJiraSyncState,
  getJiraIntegration,
  getJiraSyncState,
  listJiraIssues,
  patchJiraIssueBinding,
  replaceJiraColumns,
  replaceJiraIssueChildren,
  takeJiraSyncLease,
  upsertJiraIntegration,
  upsertJiraIssues,
} from "@kermanych/cloud";
import type { JiraIntegration, JiraIssue } from "@kermanych/cloud";
import type { ImageInput, Session } from "@kermanych/core";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AuthService } from "../auth/auth.service";
import { RegistryService } from "../registry/registry.service";
import { SupervisorService } from "../supervisor/supervisor.service";
import { JiraClient, JiraHttpError, normalizeSiteUrl } from "./jira-client";
import type {
  JiraBoardSummary,
  JiraCredentials,
  JiraRawIssue,
  JiraTransition,
  JiraWorklogAdjust,
} from "./jira-client";
import {
  adfDoc,
  adfText,
  fullJql,
  incrementalJql,
  mapAttachments,
  mapComments,
  mapIssue,
  mapWorklogs,
  pickStartDateFieldId,
  toJiraDate,
  toJiraStarted,
} from "./jira-map";

// The lease staleness window. The UI ticks every ~30 s; 25 s means the previous holder's
// stamp has expired by the time the next tick lands, while two clients ticking together
// still resolve to one poller.
const LEASE_STALE_MS = 25_000;

// A full sweep (deletion reconciliation + column layout) at most this often; incremental
// polls in between. In-process memory is enough: the worst a restart costs is one extra
// full sweep.
const FULL_SWEEP_EVERY_MS = 10 * 60_000;

// The site's field dictionary (which custom field is «Start date») re-read at most this
// often. Field configuration is site-wide and changes about as often as a workflow does;
// the worst a stale answer costs is one poll cycle without the start date.
const FIELD_TTL_MS = 10 * 60_000;

export type JiraIssueDraft = {
  // Required on create (createIssue guards); an edit may send any subset — the ticket
  // dialog's inline priority/assignee/estimate patches are one-field drafts.
  summary?: string;
  description?: string;
  issueTypeId?: string;
  priorityId?: string;
  labels?: string[];
  assigneeAccountId?: string | null;
  // Jira's own duration spelling («2w 3d 4h»); empty string clears the estimate.
  originalEstimate?: string;
  // Jira's own date spelling (YYYY-MM-DD); empty string clears the date. `startDate`
  // needs a site that HAS a start-date field — editIssue refuses otherwise instead of
  // writing the day nowhere.
  startDate?: string;
  dueDate?: string;
  parentKey?: string;
};

export type JiraLaunchResult = { session: Session; transitionError?: string };

// The wire shape of «Log work» — Jira's own dialog, field for field. Everything but the
// duration is optional the way Jira's defaults are: an omitted `started` means «now» and
// an omitted `adjust` means Jira's own «subtract this from the remaining estimate».
export type JiraWorklogDraft = {
  // Jira's duration spelling («3h 20m»). Jira validates it; a refusal is its own sentence.
  timeSpent: string;
  // An ISO-8601 INSTANT (the UI converts the wall time the user picked). Absent = now.
  started?: string;
  comment?: string;
  adjust?: JiraWorklogAdjust;
};

// The estimate adjustment as it arrives from a client: a mode string that must be one of
// Jira's, and — for the modes that carry one — a duration. An unknown mode degrades to
// Jira's own default rather than being forwarded as `adjustEstimate=garbage`, while a
// «set to»/«by this much» with nothing to set is a refusal: silently writing the entry
// with the estimate untouched would be a different action than the one asked for.
//
// `allowManual` is Jira's asymmetry, not a policy of ours: adding and deleting a worklog
// take a relative move (`reduceBy`/`increaseBy`), UPDATING one does not. On the update
// path a relative move is therefore not refused but read as what it is — «recalculate» —
// which is the mode Jira's own edit dialog defaults to.
function normalizeWorklogAdjust(
  raw: JiraWorklogAdjust | undefined,
  allowManual = true,
): JiraWorklogAdjust {
  if (!raw) return { mode: "auto" };
  if (raw.mode === "leave") return { mode: "leave" };
  if (raw.mode === "manual" && !allowManual) return { mode: "auto" };
  if (raw.mode !== "new" && raw.mode !== "manual") return { mode: "auto" };
  const value = raw.value?.trim();
  if (!value) throw new Error("this estimate adjustment needs a duration");
  return { mode: raw.mode, value };
}

// The four project permissions Jira gates a worklog write on. Named as constants because
// `GET /mypermissions` REFUSES the whole request on an unrecognised key — the list asked
// for and the flags read back must be the same four spellings.
const WORKLOG_PERMISSIONS = [
  "WORKLOG_EDIT_OWN",
  "WORKLOG_EDIT_ALL",
  "WORKLOG_DELETE_OWN",
  "WORKLOG_DELETE_ALL",
] as const;

// «Own» and «all» stay separate all the way to the UI: a member may fix their own entry
// and not somebody else's, which is one control shown and one hidden on the same list.
export type JiraWorklogPermissions = {
  editOwn: boolean;
  editAll: boolean;
  deleteOwn: boolean;
  deleteAll: boolean;
};

@Injectable()
export class JiraService {
  private lastFullSweep = new Map<string, number>();
  // Which custom field is «Start date», per SITE (the answer is site-wide, not
  // workspace-wide) with the resolution timestamp. The lastFullSweep reasoning: in-process
  // memory is enough, and a restart costs one extra field fetch.
  private startDateFields = new Map<string, { id: string | undefined; at: number }>();

  constructor(
    private registry: RegistryService,
    private auth: AuthService,
    private supervisor: SupervisorService,
    // Test seam: specs hand in a factory that returns a scripted client. @Optional so
    // Nest builds the service with the default factory (RegistryService's path idiom).
    @Optional() private clientFactory: (creds: JiraCredentials) => JiraClient = (creds) => new JiraClient(creds),
  ) {}

  // ── tokens ───────────────────────────────────────────────────────────────────

  tokenStatus(siteUrl: string, userId: string): { present: boolean; email?: string } {
    const row = this.registry.getJiraToken(normalizeSiteUrl(siteUrl), userId);
    return row ? { present: true, email: row.email } : { present: false };
  }

  // Validated against /myself BEFORE storing: a mistyped token discovered here costs one
  // clear refusal instead of a read-only board with no explanation later.
  //
  // The same answer carries the token's Jira accountId, which is stored beside it — that
  // is the identity every «is this worklog mine?» question is answered from, learned here
  // for free rather than by asking Jira again on each dialog open.
  async setToken(siteUrl: string, email: string, apiToken: string, userId: string): Promise<{ displayName: string }> {
    const site = normalizeSiteUrl(siteUrl);
    const me = await this.clientFactory({ siteUrl: site, email, apiToken }).myself();
    this.registry.setJiraToken(site, userId, email, apiToken, me.accountId);
    return { displayName: me.displayName };
  }

  deleteToken(siteUrl: string, userId: string): void {
    this.registry.deleteJiraToken(normalizeSiteUrl(siteUrl), userId);
  }

  // The per-request client for the acting user. Its absence is the read-only state, and
  // the message is what the UI shows beside the token block on the Integrations tab.
  private clientFor(siteUrl: string, userId: string): JiraClient {
    const site = normalizeSiteUrl(siteUrl);
    const row = this.registry.getJiraToken(site, userId);
    if (!row) throw new Error("no jira token");
    return this.clientFactory({ siteUrl: site, email: row.email, apiToken: row.apiToken });
  }

  // ── connect flow ─────────────────────────────────────────────────────────────

  listBoards(siteUrl: string, userId: string): Promise<JiraBoardSummary[]> {
    return this.clientFor(siteUrl, userId).listBoards();
  }

  // Owner action (RLS enforces it): write the integration row + column layout, then run
  // the first full sync so the board is populated before the tab even closes.
  async connect(workspaceId: string, siteUrl: string, boardId: number, userId: string): Promise<JiraIntegration> {
    const client = this.clientFor(siteUrl, userId);
    const projectKey = await client.boardProjectKey(boardId);
    if (!projectKey) throw new Error("board has no project");
    const boards = await client.listBoards();
    const board = boards.find((b) => b.id === boardId);
    if (!board) throw new Error("board not found");

    const cloud = this.auth.cloudClient();
    const integration = await upsertJiraIntegration(cloud, {
      workspaceId,
      siteUrl: normalizeSiteUrl(siteUrl),
      projectKey,
      boardId,
      boardName: board.name,
    });
    await ensureJiraSyncState(cloud, integration.id, workspaceId);
    await this.runSync(cloud, integration, client, { full: true });
    return integration;
  }

  async disconnect(workspaceId: string): Promise<void> {
    await deleteJiraIntegration(this.auth.cloudClient(), workspaceId);
  }

  async integration(workspaceId: string): Promise<JiraIntegration | undefined> {
    return getJiraIntegration(this.auth.cloudClient(), workspaceId);
  }

  // ── the site's start-date field ──────────────────────────────────────────────

  // Jira's `duedate` is a system field; a start date is not, so its id must be looked up
  // per site and cached (FIELD_TTL_MS) — a poll every 30 s cannot afford the whole field
  // dictionary each time.
  //
  // A refusal here is NOT an error: a token without the browse-fields permission, or an
  // older site, simply has no start date. The board keeps rendering with a blank one, the
  // negative answer is cached like a positive one, and only an explicit start-date WRITE
  // (issueFields) turns the absence into a refusal the user can read.
  private async startDateFieldId(siteUrl: string, client: JiraClient): Promise<string | undefined> {
    const site = normalizeSiteUrl(siteUrl);
    const cached = this.startDateFields.get(site);
    if (cached && cached.at > Date.now() - FIELD_TTL_MS) return cached.id;
    let id: string | undefined;
    try {
      id = pickStartDateFieldId(await client.listFields());
    } catch {
      id = undefined;
    }
    this.startDateFields.set(site, { id, at: Date.now() });
    return id;
  }

  // ── sync ─────────────────────────────────────────────────────────────────────

  // One poll tick. Honors the shared lease so N open boards cost one poller; `full`
  // bypasses it (connect and «Синхронізувати зараз» are deliberate human acts).
  async sync(workspaceId: string, userId: string, full = false): Promise<{ synced: boolean }> {
    const cloud = this.auth.cloudClient();
    const integration = await getJiraIntegration(cloud, workspaceId);
    if (!integration) throw new Error("no jira integration");
    if (!full) {
      const leased = await takeJiraSyncLease(cloud, integration.id, LEASE_STALE_MS);
      if (!leased) return { synced: false };
    }
    const client = this.clientFor(integration.siteUrl, userId);
    const wantFull = full || (this.lastFullSweep.get(integration.id) ?? 0) < Date.now() - FULL_SWEEP_EVERY_MS;
    await this.runSync(cloud, integration, client, { full: wantFull });
    return { synced: true };
  }

  private async runSync(
    cloud: SupabaseClient,
    integration: JiraIntegration,
    client: JiraClient,
    opts: { full: boolean },
  ): Promise<void> {
    const state = await getJiraSyncState(cloud, integration.id);
    const full = opts.full || !state?.syncCursor;

    if (full) {
      // The column layout travels with the sweep: it changes rarely, and when it does the
      // whole board re-renders anyway.
      const columns = await client.boardConfiguration(integration.boardId);
      await replaceJiraColumns(
        cloud,
        integration.id,
        integration.workspaceId,
        columns.map((c, position) => ({ position, name: c.name, statusIds: c.statusIds })),
      );
    }

    const startDateFieldId = await this.startDateFieldId(integration.siteUrl, client);
    const jql = full
      ? fullJql(integration.projectKey)
      : incrementalJql(integration.projectKey, state!.syncCursor!);
    const raws = await client.searchIssues(jql, startDateFieldId);

    const issues = raws.map((raw) =>
      mapIssue({ id: integration.id, workspaceId: integration.workspaceId }, raw, startDateFieldId),
    );
    await upsertJiraIssues(cloud, issues);

    // Children ride behind their issues: only issues the poll saw changed are refetched,
    // which is what keeps a 30-second tick cheap on a quiet board.
    for (const raw of raws) await this.refreshChildren(cloud, integration, client, raw);

    if (full) {
      // Deletion reconciliation — incremental JQL never reports a removed issue.
      const liveIds = new Set(raws.map((r) => r.id));
      const mirrored = await listJiraIssues(cloud, integration.id);
      const gone = mirrored.map((i) => i.issueId).filter((id) => !liveIds.has(id));
      await deleteJiraIssues(cloud, integration.id, gone);
      this.lastFullSweep.set(integration.id, Date.now());
    }

    // The cursor is the newest `updated` the poll saw; an empty poll leaves it alone.
    const newest = issues.reduce<string | undefined>(
      (max, i) => (!max || i.jiraUpdatedAt > max ? i.jiraUpdatedAt : max),
      undefined,
    );
    if (newest) await advanceJiraSyncCursor(cloud, integration.id, newest);
  }

  private async refreshChildren(
    cloud: SupabaseClient,
    integration: JiraIntegration,
    client: JiraClient,
    raw: JiraRawIssue,
  ): Promise<void> {
    const [comments, worklogs] = await Promise.all([client.listComments(raw.key), client.listWorklogs(raw.key)]);
    await replaceJiraIssueChildren(cloud, integration.id, integration.workspaceId, raw.id, {
      comments: mapComments(comments),
      worklogs: mapWorklogs(worklogs),
      attachments: mapAttachments(raw),
    });
  }

  // One issue, live → mirror. The action endpoints call this after their Jira write so
  // the board shows the result immediately; the dialog calls it on open for freshness.
  async refreshIssue(workspaceId: string, key: string, userId: string): Promise<JiraIssue> {
    const cloud = this.auth.cloudClient();
    const integration = await getJiraIntegration(cloud, workspaceId);
    if (!integration) throw new Error("no jira integration");
    const client = this.clientFor(integration.siteUrl, userId);
    const startDateFieldId = await this.startDateFieldId(integration.siteUrl, client);
    const raw = await client.getIssue(key, startDateFieldId);
    const issue = mapIssue({ id: integration.id, workspaceId: integration.workspaceId }, raw, startDateFieldId);
    await upsertJiraIssues(cloud, [issue]);
    await this.refreshChildren(cloud, integration, client, raw);
    return issue;
  }

  // ── actions ──────────────────────────────────────────────────────────────────

  private async withIntegration(workspaceId: string, userId: string): Promise<{
    cloud: SupabaseClient;
    integration: JiraIntegration;
    client: JiraClient;
  }> {
    const cloud = this.auth.cloudClient();
    const integration = await getJiraIntegration(cloud, workspaceId);
    if (!integration) throw new Error("no jira integration");
    return { cloud, integration, client: this.clientFor(integration.siteUrl, userId) };
  }

  async listTransitions(workspaceId: string, key: string, userId: string): Promise<JiraTransition[]> {
    const { client } = await this.withIntegration(workspaceId, userId);
    return client.listTransitions(key);
  }

  async transition(workspaceId: string, key: string, transitionId: string, userId: string): Promise<JiraIssue> {
    const { client } = await this.withIntegration(workspaceId, userId);
    await client.transition(key, transitionId);
    return this.refreshIssue(workspaceId, key, userId);
  }

  async addComment(workspaceId: string, key: string, body: string, userId: string): Promise<JiraIssue> {
    const { client } = await this.withIntegration(workspaceId, userId);
    await client.addComment(key, body);
    return this.refreshIssue(workspaceId, key, userId);
  }

  // «Log work»: one worklog into Jira under the acting user's own token — so the entry
  // carries THEIR name in Jira, exactly as if they had typed it there — followed by the
  // usual refresh, which brings back both the new worklog row and the counters the write
  // moved (timeSpent, remainingEstimate).
  //
  // The draft is off the wire, so the two things Jira would refuse in its own vocabulary
  // are refused here in the user's: an empty duration, and an adjustment mode whose value
  // is missing. The duration FORMAT stays Jira's to judge — it owns «3h 20m».
  async logWork(workspaceId: string, key: string, draft: JiraWorklogDraft, userId: string): Promise<JiraIssue> {
    const { client } = await this.withIntegration(workspaceId, userId);
    const timeSpent = draft.timeSpent?.trim();
    if (!timeSpent) throw new Error("timeSpent is required");
    const adjust = normalizeWorklogAdjust(draft.adjust);
    const comment = draft.comment?.trim();
    await client.addWorklog(key, {
      timeSpent,
      started: toJiraStarted(draft.started ?? new Date().toISOString()),
      ...(comment ? { comment: adfDoc(comment) } : {}),
      adjust,
    });
    return this.refreshIssue(workspaceId, key, userId);
  }

  // Editing an existing entry: the same three inputs, against a worklog id. Jira decides
  // whether this member may touch it (own vs all worklog permission) and its refusal is
  // what the UI shows — the dialog only offers the controls Jira said yes to, so a
  // refusal here means the permission changed under an open dialog.
  //
  // `started` is required rather than defaulted: an edit that omitted it would silently
  // move the entry to now, and «I fixed the duration» must not restamp the day.
  async editWorklog(
    workspaceId: string,
    key: string,
    worklogId: string,
    draft: JiraWorklogDraft,
    userId: string,
  ): Promise<JiraIssue> {
    const { client } = await this.withIntegration(workspaceId, userId);
    const timeSpent = draft.timeSpent?.trim();
    if (!timeSpent) throw new Error("timeSpent is required");
    if (!draft.started) throw new Error("started is required when editing a worklog");
    const comment = draft.comment?.trim();
    await client.updateWorklog(key, worklogId, {
      timeSpent,
      started: toJiraStarted(draft.started),
      // Present even when blank: Jira leaves an omitted comment alone, and clearing the
      // note is a legitimate edit (the client spells the empty doc).
      ...(comment ? { comment: adfDoc(comment) } : {}),
      // Jira's update endpoint has no relative move — normalised away, not forwarded.
      adjust: normalizeWorklogAdjust(draft.adjust, false),
    });
    return this.refreshIssue(workspaceId, key, userId);
  }

  // Removing an entry. The adjustment's `manual` mode is Jira's `increaseBy` here: the
  // time the entry claimed goes back onto the remaining estimate.
  async deleteWorklog(
    workspaceId: string,
    key: string,
    worklogId: string,
    adjust: JiraWorklogAdjust | undefined,
    userId: string,
  ): Promise<JiraIssue> {
    const { client } = await this.withIntegration(workspaceId, userId);
    await client.deleteWorklog(key, worklogId, normalizeWorklogAdjust(adjust));
    return this.refreshIssue(workspaceId, key, userId);
  }

  // ── authoring ────────────────────────────────────────────────────────────────

  // The standard-fields subset, spelled the way POST/PUT /issue expects. Absent keys are
  // not sent — Jira treats a present-but-empty field as «clear it».
  private issueFields(
    integration: JiraIntegration,
    draft: JiraIssueDraft,
    forCreate: boolean,
    startDateFieldId: string | undefined,
  ): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    if (forCreate) fields.project = { key: integration.projectKey };
    if (draft.summary !== undefined) fields.summary = draft.summary.trim();
    // Through `adfDoc` rather than one text node: a ticket written from the Менеджмент chat
    // arrives as several lines (context, flow, acceptance criteria) and ADF renders a `\n`
    // inside a text node as nothing, so a single node collapsed the whole body into one
    // paragraph.
    if (draft.description !== undefined) fields.description = adfDoc(draft.description);
    if (draft.issueTypeId) fields.issuetype = { id: draft.issueTypeId };
    if (draft.priorityId) fields.priority = { id: draft.priorityId };
    if (draft.labels !== undefined) fields.labels = draft.labels;
    // null unassigns; undefined leaves the field out entirely.
    if (draft.assigneeAccountId !== undefined)
      fields.assignee = draft.assigneeAccountId === null ? null : { accountId: draft.assigneeAccountId };
    if (draft.originalEstimate !== undefined)
      fields.timetracking = { originalEstimate: draft.originalEstimate.trim() || null };
    // `duedate` is Jira's own key; the start date's key is whatever this site calls the
    // field. null clears, and toJiraDate refuses a day Jira would only refuse later.
    if (draft.dueDate !== undefined) fields.duedate = toJiraDate(draft.dueDate);
    if (draft.startDate !== undefined) {
      // The absence belongs to the site, not to the user's input, so it is said plainly:
      // Jira's own refusal would name a customfield id nobody in the UI has heard of.
      if (!startDateFieldId) throw new Error("this Jira site has no start date field");
      fields[startDateFieldId] = toJiraDate(draft.startDate);
    }
    if (draft.parentKey) fields.parent = { key: draft.parentKey };
    return fields;
  }

  async createIssue(workspaceId: string, draft: JiraIssueDraft, userId: string): Promise<JiraIssue> {
    const { integration, client } = await this.withIntegration(workspaceId, userId);
    if (!draft.summary?.trim()) throw new Error("summary is required");
    // Resolved unconditionally: the refreshIssue below needs the same id anyway, so the
    // cache makes this free even for a draft that carries no start date.
    const startDateFieldId = await this.startDateFieldId(integration.siteUrl, client);
    const created = await client.createIssue(this.issueFields(integration, draft, true, startDateFieldId));
    return this.refreshIssue(workspaceId, created.key, userId);
  }

  async editIssue(workspaceId: string, key: string, draft: JiraIssueDraft, userId: string): Promise<JiraIssue> {
    const { integration, client } = await this.withIntegration(workspaceId, userId);
    const startDateFieldId = await this.startDateFieldId(integration.siteUrl, client);
    await client.editIssue(key, this.issueFields(integration, draft, false, startDateFieldId));
    return this.refreshIssue(workspaceId, key, userId);
  }

  async deleteIssue(workspaceId: string, key: string, userId: string): Promise<void> {
    const { cloud, integration, client } = await this.withIntegration(workspaceId, userId);
    const mirrored = await listJiraIssues(cloud, integration.id);
    const row = mirrored.find((i) => i.key === key);
    await client.deleteIssue(key);
    // The realtime DELETE carries the pk, so removing the mirror row here is what makes
    // every open board drop the card now rather than at the next full sweep.
    if (row) await deleteJiraIssues(cloud, integration.id, [row.issueId]);
  }

  // ── editor vocabularies ──────────────────────────────────────────────────────

  async editorOptions(workspaceId: string, userId: string): Promise<{
    issueTypes: { id: string; name: string; subtask: boolean }[];
    priorities: { id: string; name: string }[];
    // Whether this site HAS a start-date field at all. The editors show the control only
    // on `true`: offering an input whose every save is refused is worse than no input.
    startDateSupported: boolean;
    // This token's own Jira accountId, and what Jira says it may do to worklogs in this
    // project. Together they are the whole answer to «which entries wear Редагувати /
    // Видалити»: an entry is mine when its author matches, and Jira gates own and
    // others' entries on separate permissions.
    myAccountId: string;
    worklog: JiraWorklogPermissions;
  }> {
    const { integration, client } = await this.withIntegration(workspaceId, userId);
    const [issueTypes, priorities, startDateFieldId, myAccountId, worklog] = await Promise.all([
      client.projectIssueTypes(integration.projectKey),
      client.listPriorities(),
      this.startDateFieldId(integration.siteUrl, client),
      this.myAccountId(integration.siteUrl, userId, client),
      this.worklogPermissions(integration.projectKey, client),
    ]);
    return { issueTypes, priorities, startDateSupported: !!startDateFieldId, myAccountId, worklog };
  }

  // The acting token's Jira identity. Read from the registry, where setToken put it; a
  // token stored before that column existed is backfilled from /myself on this first ask,
  // so the answer costs one Jira call once per stale token and none afterwards.
  //
  // Blank on failure, and that is a usable answer: nothing then matches as «mine», so the
  // dialog offers only what an all-worklogs permission allows.
  private async myAccountId(siteUrl: string, userId: string, client: JiraClient): Promise<string> {
    const site = normalizeSiteUrl(siteUrl);
    const stored = this.registry.getJiraToken(site, userId)?.accountId;
    if (stored) return stored;
    try {
      const me = await client.myself();
      this.registry.setJiraAccountId(site, userId, me.accountId);
      return me.accountId;
    } catch {
      return "";
    }
  }

  // Jira's own verdict on the four worklog permissions. A refusal (an older site, a token
  // without browse-project) degrades to all-false: the dialog then shows the entries and
  // offers no edit or delete control, which is exactly what a member who cannot write
  // them should see.
  private async worklogPermissions(projectKey: string, client: JiraClient): Promise<JiraWorklogPermissions> {
    try {
      const held = await client.myPermissions(projectKey, WORKLOG_PERMISSIONS);
      return {
        editOwn: held.WORKLOG_EDIT_OWN === true,
        editAll: held.WORKLOG_EDIT_ALL === true,
        deleteOwn: held.WORKLOG_DELETE_OWN === true,
        deleteAll: held.WORKLOG_DELETE_ALL === true,
      };
    } catch {
      return { editOwn: false, editAll: false, deleteOwn: false, deleteAll: false };
    }
  }

  async assignableUsers(
    workspaceId: string,
    query: string,
    userId: string,
  ): Promise<{ accountId: string; displayName: string; avatar?: string }[]> {
    const { integration, client } = await this.withIntegration(workspaceId, userId);
    const users = await client.assignableUsers(integration.projectKey, query);
    return users.map((u) => {
      const out: { accountId: string; displayName: string; avatar?: string } = {
        accountId: u.accountId,
        displayName: u.displayName,
      };
      const a = u.avatarUrls?.["48x48"] ?? Object.values(u.avatarUrls ?? {})[0];
      if (a) out.avatar = a;
      return out;
    });
  }

  // ── attachments ──────────────────────────────────────────────────────────────

  async uploadAttachment(
    workspaceId: string,
    key: string,
    filename: string,
    data: Buffer,
    mime: string,
    userId: string,
  ): Promise<JiraIssue> {
    const { client } = await this.withIntegration(workspaceId, userId);
    await client.uploadAttachment(key, filename, data, mime);
    return this.refreshIssue(workspaceId, key, userId);
  }

  async downloadAttachment(
    workspaceId: string,
    attachmentId: string,
    userId: string,
  ): Promise<{ body: ReadableStream<Uint8Array>; contentType: string }> {
    const { client } = await this.withIntegration(workspaceId, userId);
    return client.downloadAttachment(attachmentId);
  }

  // ── launch ───────────────────────────────────────────────────────────────────

  // Order matters and is deliberate: shadow task → session → binding → transition. The
  // session is the expensive, wanted thing, so a transition Jira refuses NEVER kills it —
  // the refusal comes back beside the session as a warning.
  async launch(
    workspaceId: string,
    key: string,
    projectId: string,
    userId: string,
    transitionId?: string,
    images?: ImageInput[],
  ): Promise<JiraLaunchResult> {
    const { cloud, integration, client } = await this.withIntegration(workspaceId, userId);
    const raw = await client.getIssue(key);

    // The shadow task: the whole existing pipeline (worktree, outbox, force-stop,
    // tasks_guard) runs on this ordinary row; `jiraKey` is what keeps it off «Задачі».
    const task = await createTask(cloud, {
      projectId,
      // `summary` is a plain string in the v3 payload (only description is ADF).
      title: `${key} — ${typeof raw.fields.summary === "string" && raw.fields.summary ? raw.fields.summary : key}`,
      description: adfText(raw.fields.description),
      assigneeId: userId,
      createdBy: userId,
      jiraKey: key,
    });

    const session = await this.supervisor.createSessionFromTask(task.id, userId, images);
    await patchJiraIssueBinding(cloud, integration.id, raw.id, {
      kermanychProjectId: projectId,
      taskId: task.id,
    });

    if (!transitionId) return { session };
    try {
      await client.transition(key, transitionId);
      await this.refreshIssue(workspaceId, key, userId);
      return { session };
    } catch (err) {
      const message = err instanceof JiraHttpError ? err.message : (err as Error).message;
      return { session, transitionError: message };
    }
  }
}
