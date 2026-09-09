// apps/api/src/linear/linear.service.ts
// The Linear integration's engine: token custody, the connect flow, the polling sync that
// keeps the Supabase mirror honest, and every user action (transition, comment, author,
// launch) — each of which is one Linear call under the ACTING user's key followed by a
// mirror patch under their JWT, so the board reflects the action without waiting for the
// next poll.
//
// Linear is the source of truth. Nothing here merges: mirror rows are overwritten from
// Linear responses, and a disagreement is resolved by refetching the issue.
import { Injectable, Optional } from "@nestjs/common";
import {
  advanceLinearSyncCursor,
  createTask,
  deleteLinearIntegration,
  deleteLinearIssues,
  ensureLinearSyncState,
  getLinearIntegration,
  getLinearSyncState,
  listLinearIssues,
  patchLinearIssueBinding,
  replaceLinearColumns,
  replaceLinearIssueChildren,
  takeLinearSyncLease,
  upsertLinearIntegration,
  upsertLinearIssues,
} from "@kermanych/cloud";
import type { LinearIntegration, LinearIssue } from "@kermanych/cloud";
import type { ImageInput, Session } from "@kermanych/core";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AuthService } from "../auth/auth.service";
import { RegistryService } from "../registry/registry.service";
import { SupervisorService } from "../supervisor/supervisor.service";
import { LinearClient, LinearHttpError } from "./linear-client";
import type { LinearCredentials, LinearRawIssue, LinearTeamSummary } from "./linear-client";
import { categoryFromStateType, mapAttachments, mapComments, mapIssue, orderStates, sinceCursor } from "./linear-map";

// The lease staleness window. The UI ticks every ~30 s; 25 s means the previous holder's
// stamp has expired by the time the next tick lands, while two clients ticking together
// still resolve to one poller.
const LEASE_STALE_MS = 25_000;

// A full sweep (deletion reconciliation + column layout) at most this often; incremental
// polls in between. In-process memory is enough: the worst a restart costs is one extra
// full sweep.
const FULL_SWEEP_EVERY_MS = 10 * 60_000;

// A create may send any subset the ticket dialog offers; an edit's inline patches are
// one-field drafts. `dueDate` "" clears, `estimate`/`assigneeId` null clear, and `labels`
// are NAMES the service resolves to ids at write time.
export type LinearIssueDraft = {
  title?: string;
  description?: string;
  priority?: number;
  assigneeId?: string | null;
  labels?: string[];
  estimate?: number | null;
  dueDate?: string;
  parentKey?: string;
  stateId?: string;
};

export type LinearLaunchResult = { session: Session; transitionError?: string };

// The wire shape the board's status picker reads: a team's states dressed as transitions so
// the front end can reuse the Jira picker. `id === stateId`, and a drag or a launch move is
// `issueUpdate(id, {stateId})`.
export type LinearTransition = {
  id: string;
  name: string;
  to: { id: string; name: string; statusCategory: { key: string } };
};

@Injectable()
export class LinearService {
  private lastFullSweep = new Map<string, number>();

  constructor(
    private registry: RegistryService,
    private auth: AuthService,
    private supervisor: SupervisorService,
    // Test seam: specs hand in a factory that returns a scripted client. @Optional so Nest
    // builds the service with the default factory (RegistryService's path idiom).
    @Optional()
    private clientFactory: (creds: LinearCredentials) => LinearClient = (creds) => new LinearClient(creds),
  ) {}

  // ── tokens ───────────────────────────────────────────────────────────────────

  tokenStatus(orgUrlKey: string, userId: string): { present: boolean } {
    return { present: !!this.registry.getLinearToken(orgUrlKey, userId) };
  }

  // Validated against `viewer`/`organization` BEFORE storing: a mistyped key discovered
  // here costs one clear refusal instead of a read-only board with no explanation later.
  // The org's urlKey is the storage key (a machine shared across orgs keeps them apart),
  // and the viewer id rides along as the token's own Linear identity.
  async setToken(apiKey: string, userId: string): Promise<{ displayName: string; orgUrlKey: string; orgName: string }> {
    const id = await this.clientFactory({ apiKey }).identity();
    this.registry.setLinearToken(id.orgUrlKey, userId, apiKey, id.viewerId);
    return { displayName: id.viewerName, orgUrlKey: id.orgUrlKey, orgName: id.orgName };
  }

  deleteToken(orgUrlKey: string, userId: string): void {
    this.registry.deleteLinearToken(orgUrlKey, userId);
  }

  // The per-request client for the acting user. Its absence is the read-only state.
  private clientFor(orgUrlKey: string, userId: string): LinearClient {
    const row = this.registry.getLinearToken(orgUrlKey, userId);
    if (!row) throw new Error("no linear token");
    return this.clientFactory({ apiKey: row.apiKey });
  }

  // ── connect flow ─────────────────────────────────────────────────────────────

  listTeams(orgUrlKey: string, userId: string): Promise<LinearTeamSummary[]> {
    return this.clientFor(orgUrlKey, userId).listTeams();
  }

  // Owner action (RLS enforces it): write the integration row + column layout, then run
  // the first full sync so the board is populated before the tab even closes.
  async connect(workspaceId: string, orgUrlKey: string, teamId: string, userId: string): Promise<LinearIntegration> {
    const client = this.clientFor(orgUrlKey, userId);
    const teams = await client.listTeams();
    const team = teams.find((t) => t.id === teamId);
    if (!team) throw new Error("team not found");

    const cloud = this.auth.cloudClient();
    const integration = await upsertLinearIntegration(cloud, {
      workspaceId,
      orgUrlKey,
      teamKey: team.key,
      teamId,
      teamName: team.name,
    });
    await ensureLinearSyncState(cloud, integration.id, workspaceId);
    await this.runSync(cloud, integration, client, { full: true });
    return integration;
  }

  async disconnect(workspaceId: string): Promise<void> {
    await deleteLinearIntegration(this.auth.cloudClient(), workspaceId);
  }

  async integration(workspaceId: string): Promise<LinearIntegration | undefined> {
    return getLinearIntegration(this.auth.cloudClient(), workspaceId);
  }

  // ── sync ─────────────────────────────────────────────────────────────────────

  // One poll tick. Honors the shared lease so N open boards cost one poller; `full`
  // bypasses it (connect and «Синхронізувати зараз» are deliberate human acts).
  async sync(workspaceId: string, userId: string, full = false): Promise<{ synced: boolean }> {
    const cloud = this.auth.cloudClient();
    const integration = await getLinearIntegration(cloud, workspaceId);
    if (!integration) throw new Error("no linear integration");
    if (!full) {
      const leased = await takeLinearSyncLease(cloud, integration.id, LEASE_STALE_MS);
      if (!leased) return { synced: false };
    }
    const client = this.clientFor(integration.orgUrlKey, userId);
    const wantFull = full || (this.lastFullSweep.get(integration.id) ?? 0) < Date.now() - FULL_SWEEP_EVERY_MS;
    await this.runSync(cloud, integration, client, { full: wantFull });
    return { synced: true };
  }

  private async runSync(
    cloud: SupabaseClient,
    integration: LinearIntegration,
    client: LinearClient,
    opts: { full: boolean },
  ): Promise<void> {
    const state = await getLinearSyncState(cloud, integration.id);
    const full = opts.full || !state?.syncCursor;

    if (full) {
      // The column layout travels with the sweep: it changes rarely, and when it does the
      // whole board re-renders anyway.
      const states = await client.teamStates(integration.teamId);
      await replaceLinearColumns(cloud, integration.id, integration.workspaceId, orderStates(states));
    }

    const raws = await client.searchIssues(
      integration.teamId,
      full ? undefined : sinceCursor(state!.syncCursor!),
    );

    const issues = raws.map((raw) => mapIssue({ id: integration.id, workspaceId: integration.workspaceId }, raw));
    await upsertLinearIssues(cloud, issues);

    // Children ride INLINE with their issue — no extra request — so only issues the poll
    // saw changed have their comments and attachments replaced.
    for (const raw of raws) await this.refreshChildren(cloud, integration, raw);

    if (full) {
      // Deletion reconciliation — an incremental poll never reports a removed issue.
      const liveIds = new Set(raws.map((r) => r.id));
      const mirrored = await listLinearIssues(cloud, integration.id);
      const gone = mirrored.map((i) => i.issueId).filter((id) => !liveIds.has(id));
      await deleteLinearIssues(cloud, integration.id, gone);
      this.lastFullSweep.set(integration.id, Date.now());
    }

    // The cursor is the newest `updatedAt` the poll saw; an empty poll leaves it alone.
    const newest = issues.reduce<string | undefined>(
      (max, i) => (!max || i.linearUpdatedAt > max ? i.linearUpdatedAt : max),
      undefined,
    );
    if (newest) await advanceLinearSyncCursor(cloud, integration.id, newest);
  }

  private async refreshChildren(
    cloud: SupabaseClient,
    integration: LinearIntegration,
    raw: LinearRawIssue,
  ): Promise<void> {
    await replaceLinearIssueChildren(cloud, integration.id, integration.workspaceId, raw.id, {
      comments: mapComments(raw.comments?.nodes ?? []),
      attachments: mapAttachments(raw.attachments?.nodes ?? []),
    });
  }

  // One issue, live → mirror. The action endpoints call this after their Linear write so
  // the board shows the result immediately; the dialog calls it on open for freshness.
  async refreshIssue(workspaceId: string, key: string, userId: string): Promise<LinearIssue> {
    const cloud = this.auth.cloudClient();
    const integration = await getLinearIntegration(cloud, workspaceId);
    if (!integration) throw new Error("no linear integration");
    const client = this.clientFor(integration.orgUrlKey, userId);
    const raw = await client.getIssue(key);
    const issue = mapIssue({ id: integration.id, workspaceId: integration.workspaceId }, raw);
    await upsertLinearIssues(cloud, [issue]);
    await this.refreshChildren(cloud, integration, raw);
    return issue;
  }

  // ── actions ──────────────────────────────────────────────────────────────────

  private async withIntegration(
    workspaceId: string,
    userId: string,
  ): Promise<{ cloud: SupabaseClient; integration: LinearIntegration; client: LinearClient }> {
    const cloud = this.auth.cloudClient();
    const integration = await getLinearIntegration(cloud, workspaceId);
    if (!integration) throw new Error("no linear integration");
    return { cloud, integration, client: this.clientFor(integration.orgUrlKey, userId) };
  }

  // The team's states dressed as transitions, ordered the board's way. `id === stateId`,
  // so the front end posts the chosen id straight back to POST .../transition.
  async listTransitions(workspaceId: string, key: string, userId: string): Promise<LinearTransition[]> {
    const { integration, client } = await this.withIntegration(workspaceId, userId);
    const states = await client.teamStates(integration.teamId);
    const byId = new Map(states.map((s) => [s.id, s]));
    return orderStates(states).map((c) => {
      const s = byId.get(c.stateIds[0]!)!;
      return { id: s.id, name: s.name, to: { id: s.id, name: s.name, statusCategory: { key: categoryFromStateType(s.type) } } };
    });
  }

  async transition(workspaceId: string, key: string, stateId: string, userId: string): Promise<LinearIssue> {
    const { client } = await this.withIntegration(workspaceId, userId);
    await client.updateIssue(key, { stateId });
    return this.refreshIssue(workspaceId, key, userId);
  }

  async addComment(workspaceId: string, key: string, body: string, userId: string): Promise<LinearIssue> {
    const { client } = await this.withIntegration(workspaceId, userId);
    await client.addComment(key, body);
    return this.refreshIssue(workspaceId, key, userId);
  }

  // ── authoring ────────────────────────────────────────────────────────────────

  // The Linear issue input, spelled the way issueCreate/issueUpdate expect. Absent keys are
  // not sent — Linear treats a present field as «set this», so a one-field patch must carry
  // only its one field.
  private async issueFields(
    integration: LinearIntegration,
    draft: LinearIssueDraft,
    forCreate: boolean,
    client: LinearClient,
  ): Promise<Record<string, unknown>> {
    const input: Record<string, unknown> = {};
    if (forCreate) input.teamId = integration.teamId;
    if (draft.title !== undefined) input.title = draft.title.trim();
    // Markdown straight through — Linear stores it as-is, no ADF.
    if (draft.description !== undefined) input.description = draft.description;
    if (draft.priority !== undefined) input.priority = draft.priority;
    // null unassigns; undefined leaves the field out entirely.
    if (draft.assigneeId !== undefined) input.assigneeId = draft.assigneeId;
    if (draft.stateId !== undefined) input.stateId = draft.stateId;
    // Linear's estimate is an integer point count; null clears it.
    if (draft.estimate !== undefined) input.estimate = draft.estimate === null ? null : Math.round(draft.estimate);
    // "" clears the date (null is how Linear spells that); otherwise the TimelessDate day.
    if (draft.dueDate !== undefined) input.dueDate = draft.dueDate.trim() || null;
    if (draft.parentKey) input.parentId = draft.parentKey;
    // Labels are entities: the draft carries NAMES, and the write resolves them to ids,
    // dropping any the team does not define (case-insensitive).
    if (draft.labels !== undefined) input.labelIds = await this.resolveLabelIds(integration, draft.labels, client);
    return input;
  }

  private async resolveLabelIds(
    integration: LinearIntegration,
    names: readonly string[],
    client: LinearClient,
  ): Promise<string[]> {
    const labels = await client.teamLabels(integration.teamId);
    const byName = new Map(labels.map((l) => [l.name.trim().toLowerCase(), l.id]));
    return names
      .map((n) => byName.get(n.trim().toLowerCase()))
      .filter((id): id is string => typeof id === "string");
  }

  async createIssue(workspaceId: string, draft: LinearIssueDraft, userId: string): Promise<LinearIssue> {
    const { integration, client } = await this.withIntegration(workspaceId, userId);
    if (!draft.title?.trim()) throw new Error("title is required");
    const created = await client.createIssue(await this.issueFields(integration, draft, true, client));
    return this.refreshIssue(workspaceId, created.identifier, userId);
  }

  async editIssue(workspaceId: string, key: string, draft: LinearIssueDraft, userId: string): Promise<LinearIssue> {
    const { integration, client } = await this.withIntegration(workspaceId, userId);
    await client.updateIssue(key, await this.issueFields(integration, draft, false, client));
    return this.refreshIssue(workspaceId, key, userId);
  }

  async deleteIssue(workspaceId: string, key: string, userId: string): Promise<void> {
    const { cloud, integration, client } = await this.withIntegration(workspaceId, userId);
    const mirrored = await listLinearIssues(cloud, integration.id);
    const row = mirrored.find((i) => i.key === key);
    await client.deleteIssue(key);
    // The realtime DELETE carries the pk, so removing the mirror row here is what makes
    // every open board drop the card now rather than at the next full sweep.
    if (row) await deleteLinearIssues(cloud, integration.id, [row.issueId]);
  }

  // ── editor vocabularies ──────────────────────────────────────────────────────

  async editorOptions(workspaceId: string, userId: string): Promise<{ labels: { id: string; name: string }[] }> {
    const { integration, client } = await this.withIntegration(workspaceId, userId);
    const labels = await client.teamLabels(integration.teamId);
    return { labels };
  }

  async assignableUsers(
    workspaceId: string,
    query: string,
    userId: string,
  ): Promise<{ id: string; name: string; avatar?: string }[]> {
    const { integration, client } = await this.withIntegration(workspaceId, userId);
    const members = await client.teamMembers(integration.teamId);
    const q = query.trim().toLowerCase();
    const matched = q ? members.filter((m) => (m.displayName || m.name).toLowerCase().includes(q)) : members;
    return matched.map((m) => {
      const out: { id: string; name: string; avatar?: string } = { id: m.id, name: m.displayName || m.name };
      if (m.avatarUrl) out.avatar = m.avatarUrl;
      return out;
    });
  }

  // ── launch ───────────────────────────────────────────────────────────────────

  // Order matters and is deliberate: shadow task → session → binding → transition. The
  // session is the expensive, wanted thing, so a transition Linear refuses NEVER kills it —
  // the refusal comes back beside the session as a warning.
  async launch(
    workspaceId: string,
    key: string,
    projectId: string,
    userId: string,
    transitionId?: string,
    images?: ImageInput[],
  ): Promise<LinearLaunchResult> {
    const { cloud, integration, client } = await this.withIntegration(workspaceId, userId);
    const raw = await client.getIssue(key);

    // The shadow task: the whole existing pipeline (worktree, outbox, force-stop,
    // tasks_guard) runs on this ordinary row; `linearKey` is what keeps it off «Задачі».
    const task = await createTask(cloud, {
      projectId,
      title: `${key} — ${raw.title || key}`,
      // Linear's description is markdown already — no flattening needed.
      description: raw.description ?? "",
      assigneeId: userId,
      createdBy: userId,
      linearKey: key,
    });

    const session = await this.supervisor.createSessionFromTask(task.id, userId, images);
    await patchLinearIssueBinding(cloud, integration.id, raw.id, {
      kermanychProjectId: projectId,
      taskId: task.id,
    });

    if (!transitionId) return { session };
    try {
      await client.updateIssue(key, { stateId: transitionId });
      await this.refreshIssue(workspaceId, key, userId);
      return { session };
    } catch (err) {
      const message = err instanceof LinearHttpError ? err.message : (err as Error).message;
      return { session, transitionError: message };
    }
  }
}
