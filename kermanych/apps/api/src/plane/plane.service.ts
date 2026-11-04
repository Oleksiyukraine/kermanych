// apps/api/src/plane/plane.service.ts
// The Plane integration's engine: token custody, the connect flow, the polling sync that
// keeps the Supabase mirror honest, and every user action (transition, comment, worklog,
// authoring, launch) — each of which is one Plane call under the ACTING user's key
// followed by a mirror patch under their JWT, so the board reflects the action without
// waiting for the next poll.
//
// Plane is the source of truth. Nothing here merges: mirror rows are overwritten from
// Plane responses, and a disagreement is resolved by refetching the item.
//
// What makes this the Jira engine's twin rather than its copy is Plane's budget: 60
// requests a minute per key (spec Decision 8). So the sync reads the list newest-first and
// stops at its cursor, refreshes children for a few stale items per tick instead of every
// changed one, and the project's vocabularies (states, labels, members, estimate) are
// cached in memory for ten minutes. A 429 ends a tick quietly; on a user action it is
// Plane's own sentence.
import { Injectable, Optional } from "@nestjs/common";
import { Buffer } from "node:buffer";
import {
  advancePlaneSyncCursor,
  createTask,
  deletePlaneIntegration,
  deletePlaneIssues,
  ensurePlaneSyncState,
  getPlaneIntegrationById,
  getPlaneSyncState,
  listPlaneIntegrations,
  listPlaneIssues,
  markPlaneChildrenSynced,
  patchPlaneIssueBinding,
  replacePlaneColumns,
  replacePlaneIssueChildren,
  takePlaneSyncLease,
  upsertPlaneIntegration,
  upsertPlaneIssues,
} from "@kermanych/cloud";
import type { PlaneIntegration, PlaneIssue } from "@kermanych/cloud";
import type { ImageInput, Session } from "@kermanych/core";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AuthService } from "../auth/auth.service";
import { RegistryService } from "../registry/registry.service";
import { SupervisorService } from "../supervisor/supervisor.service";
import { PlaneClient, PlaneHttpError, normalizePlaneSite, planeApiBase } from "./plane-client";
import type {
  PlaneCredentials,
  PlaneEstimatePoint,
  PlaneIssueType,
  PlaneLabel,
  PlaneRawIssue,
  PlaneRawWorklog,
  PlaneState,
  PlaneUserLite,
} from "./plane-client";
import { markdownToPlaneHtml, planeHtmlToMarkdown } from "./plane-html";
import {
  buildColumns,
  categoryFromGroup,
  formatMinutes,
  laterIso,
  mapAttachments,
  mapComments,
  mapIssue,
  mapWorklogs,
  parseDurationToMinutes,
  personAvatar,
  personName,
  pickChildrenDue,
  sinceCursor,
  toPlaneDate,
} from "./plane-map";
import type { MappedAttachment, MappedComment, MappedWorklog, PlaneMapContext } from "./plane-map";

// The lease staleness window. The UI ticks every ~30 s; 25 s means the previous holder's
// stamp has expired by the time the next tick lands, while two clients ticking together
// still resolve to one poller.
const LEASE_STALE_MS = 25_000;

// A full sweep (project + states + every item + deletion reconciliation) at most this
// often; incremental polls in between. In-process memory is enough: the worst a restart
// costs is one extra full sweep.
const FULL_SWEEP_EVERY_MS = 10 * 60_000;

// How long the project's vocabularies (meta, states, labels, members, estimate, types and
// whether the worklog route answers) are trusted. They change about as often as a
// workflow does; a stale answer costs one tick of an old name, while re-reading them would
// cost a request per tick out of sixty a minute.
const CACHE_TTL_MS = 10 * 60_000;

// Children (comments, attachments, worklogs) refreshed per tick, at most: three requests
// each, so five keep a tick under twenty requests (spec Decision 8). The dialog refreshes
// its own item at once.
const CHILDREN_PER_TICK = 5;

// Plane's project roles (member_role): 20 admin, 15 member, 5 guest.
const ADMIN_ROLE = 20;
const GUEST_ROLE = 5;

// Assignee picker page: the Jira picker's size.
const ASSIGNABLE_LIMIT = 50;

export type PlanePriority = "urgent" | "high" | "medium" | "low" | "none";

// Plane's fixed priority enum, urgent first — the editor's list. The ids ARE the enum
// values a draft sends back.
const PRIORITIES: { id: PlanePriority; name: string }[] = [
  { id: "urgent", name: "Urgent" },
  { id: "high", name: "High" },
  { id: "medium", name: "Medium" },
  { id: "low", name: "Low" },
  { id: "none", name: "None" },
];

const ESTIMATE_TYPES: Record<string, true> = { points: true, categories: true, time: true };

// A create may send any subset the ticket dialog offers; an edit's inline patches are
// one-field drafts. `description` is markdown, `labels` are NAMES resolved (and, when new,
// created) at write time, `assigneeAccountId` null unassigns, `estimatePointId` null clears
// the estimate, a "" date clears the date and a "" parentKey detaches the parent.
export type PlaneIssueDraft = {
  summary?: string;
  description?: string;
  issueTypeId?: string;
  priority?: PlanePriority;
  labels?: string[];
  assigneeAccountId?: string | null;
  estimatePointId?: string | null;
  startDate?: string;
  dueDate?: string;
  parentKey?: string;
  stateId?: string;
};

// «Log work», Plane's way (spec Decision 9): a duration in Jira's spelling («3h 20m»), and
// an optional note. No «started» — Plane has no work-date field — and no estimate
// adjustment, which Plane does not have either.
export type PlaneWorklogDraft = { timeSpent: string; description?: string };

// The project's states dressed as transitions, so the front end reuses the Jira picker.
// `id === stateId`: a drag or a launch move is a PATCH of `state`.
export type PlaneTransition = {
  id: string;
  name: string;
  to: { id: string; name: string; statusCategory: { key: string } };
};

export type PlaneEditorOptions = {
  issueTypes: { id: string; name: string }[];
  priorities: { id: string; name: string }[];
  labels: { id: string; name: string; color: string }[];
  states: { id: string; name: string; group: string; color: string }[];
  estimatePoints: { id: string; value: string }[];
  estimateType: "points" | "categories" | "time" | "";
  // The project's flag AND the worklog route answering: without both (feature off, a
  // Community instance, a plan without it) the UI hides the time fields instead of
  // offering writes Plane refuses.
  timeTrackingEnabled: boolean;
  // This key's own Plane user id: an entry is «mine» when its author matches.
  myAccountId: string;
  // Plane's rule: own entries are editable, a project admin may touch anyone's.
  worklog: { editOwn: boolean; editAll: boolean; deleteOwn: boolean; deleteAll: boolean };
};

export type PlaneLaunchResult = { session: Session; transitionError?: string };

type ProjectMeta = {
  identifier: string;
  estimateId?: string;
  // Absent when the edition's project object does not carry the flag — then the worklog
  // route alone decides.
  timeTracking?: boolean;
  issueTypes: boolean;
  memberRole?: number;
};

type EstimateInfo = { type: string; points: PlaneEstimatePoint[] };

type Cached<T> = { value: T; at: number };

// Everything an action needs, resolved once per request.
type Ctx = { cloud: SupabaseClient; integration: PlaneIntegration; client: PlaneClient; userId: string };

type Children = { comments: MappedComment[]; worklogs: MappedWorklog[]; attachments: MappedAttachment[] };

function isRateLimited(err: unknown): boolean {
  return err instanceof PlaneHttpError && err.status === 429;
}

// «This project/edition/key has no such feature» rather than a failure: no route
// (Community), a paid feature (402), or a permission the key lacks (403 — an invalid key is
// a 401 by the time it gets here, see PlaneHttpError).
function isUnavailable(err: unknown): boolean {
  return err instanceof PlaneHttpError && (err.status === 404 || err.status === 402 || err.status === 403);
}

function normalizeSlug(raw: string): string {
  return raw.trim().replace(/^\/+|\/+$/g, "");
}

function updatedMs(raw: PlaneRawIssue): number {
  return new Date(raw.updated_at ?? "").getTime();
}

@Injectable()
export class PlaneService {
  private lastFullSweep = new Map<string, number>();
  // Keyed by integration id, except what depends on the ACTING key: the project meta (its
  // `member_role`) and whether the worklog route answers (a guest's key may be refused
  // where a member's is not) are keyed by integration and user; the estimate by
  // integration and estimate id.
  private metaCache = new Map<string, Cached<ProjectMeta>>();
  private stateCache = new Map<string, Cached<PlaneState[]>>();
  private labelCache = new Map<string, Cached<PlaneLabel[]>>();
  private memberCache = new Map<string, Cached<PlaneUserLite[]>>();
  private estimateCache = new Map<string, Cached<EstimateInfo>>();
  private typeCache = new Map<string, Cached<PlaneIssueType[]>>();
  private worklogRoute = new Map<string, Cached<boolean>>();

  constructor(
    private registry: RegistryService,
    private auth: AuthService,
    private supervisor: SupervisorService,
    // Test seam: specs hand in a factory that returns a scripted client. @Optional so Nest
    // builds the service with the default factory (RegistryService's path idiom).
    @Optional()
    private clientFactory: (creds: PlaneCredentials) => PlaneClient = (creds) => new PlaneClient(creds),
  ) {}

  // ── tokens ───────────────────────────────────────────────────────────────────

  tokenStatus(siteUrl: string, workspaceSlug: string, userId: string): { present: boolean; displayName?: string } {
    const row = this.registry.getPlaneToken(normalizePlaneSite(siteUrl), normalizeSlug(workspaceSlug), userId);
    if (!row) return { present: false };
    return row.displayName ? { present: true, displayName: row.displayName } : { present: true };
  }

  // Validated BEFORE storing (spec Decision 3): /users/me/ proves the key is real, and one
  // projects read proves it reaches THIS workspace — some editions scope a key to one. A
  // mistyped key or slug discovered here costs one clear refusal instead of a read-only
  // board with no explanation later. The key's own Plane identity rides along: it is what
  // every «is this worklog mine?» question is answered from.
  async setToken(siteUrl: string, workspaceSlug: string, apiToken: string, userId: string): Promise<{ displayName: string }> {
    const site = normalizePlaneSite(siteUrl);
    const slug = normalizeSlug(workspaceSlug);
    const client = this.clientFactory({ siteUrl: site, workspaceSlug: slug, apiToken });
    const me = await client.me();
    await client.listProjects();
    const displayName = personName(me) || me.id;
    this.registry.setPlaneToken(site, slug, userId, apiToken, me.id, displayName);
    return { displayName };
  }

  deleteToken(siteUrl: string, workspaceSlug: string, userId: string): void {
    this.registry.deletePlaneToken(normalizePlaneSite(siteUrl), normalizeSlug(workspaceSlug), userId);
  }

  // The per-request client for the acting user. Its absence is the read-only state, and
  // the message is what the UI shows beside the token block. Public for the Менеджмент
  // assistant's tools, which act under the same key.
  clientFor(siteUrl: string, workspaceSlug: string, userId: string): PlaneClient {
    const site = normalizePlaneSite(siteUrl);
    const slug = normalizeSlug(workspaceSlug);
    const row = this.registry.getPlaneToken(site, slug, userId);
    if (!row) throw new Error("no plane token");
    return this.clientFactory({ siteUrl: site, workspaceSlug: slug, apiToken: row.apiToken });
  }

  // ── connect flow ─────────────────────────────────────────────────────────────

  async listProjects(
    siteUrl: string,
    workspaceSlug: string,
    userId: string,
  ): Promise<{ id: string; name: string; identifier: string }[]> {
    const projects = await this.clientFor(siteUrl, workspaceSlug, userId).listProjects();
    return projects.filter((p) => !p.archived_at).map((p) => ({ id: p.id, name: p.name, identifier: p.identifier }));
  }

  // Owner action (RLS enforces it): write the integration row, then run the first full
  // sync so the board is populated before the tab even closes. A workspace may hold up to
  // ten projects; the db refuses the eleventh. A 429 during that first sync does not undo
  // the connection — the next tick fills the board.
  async connect(
    workspaceId: string,
    siteUrl: string,
    workspaceSlug: string,
    projectId: string,
    userId: string,
  ): Promise<PlaneIntegration> {
    const site = normalizePlaneSite(siteUrl);
    const slug = normalizeSlug(workspaceSlug);
    const client = this.clientFor(site, slug, userId);
    const project = await client.getProject(projectId);

    const cloud = this.auth.cloudClient();
    const integration = await upsertPlaneIntegration(cloud, {
      workspaceId,
      siteUrl: site,
      workspaceSlug: slug,
      projectId: project.id || projectId,
      projectIdentifier: project.identifier,
      projectName: project.name,
    });
    await ensurePlaneSyncState(cloud, integration.id, workspaceId);
    try {
      await this.runSync({ cloud, integration, client, userId }, true);
    } catch (err) {
      if (!isRateLimited(err)) throw err;
    }
    return integration;
  }

  // Disconnect ONE project by its integration id — the workspace's others stay connected.
  async disconnect(integrationId: string): Promise<void> {
    await deletePlaneIntegration(this.auth.cloudClient(), integrationId);
    for (const cache of [this.stateCache, this.labelCache, this.memberCache, this.typeCache])
      cache.delete(integrationId);
    for (const cache of [this.metaCache, this.estimateCache, this.worklogRoute])
      for (const key of cache.keys()) if (key.startsWith(`${integrationId}:`)) cache.delete(key);
    this.lastFullSweep.delete(integrationId);
  }

  listIntegrations(workspaceId: string): Promise<PlaneIntegration[]> {
    return listPlaneIntegrations(this.auth.cloudClient(), workspaceId);
  }

  // ── cached project vocabularies ──────────────────────────────────────────────

  private async cached<T>(store: Map<string, Cached<T>>, key: string, load: () => Promise<T>, fresh = false): Promise<T> {
    const hit = store.get(key);
    if (!fresh && hit && hit.at > Date.now() - CACHE_TTL_MS) return hit.value;
    const value = await load();
    store.set(key, { value, at: Date.now() });
    return value;
  }

  private projectMeta(c: Ctx, fresh = false): Promise<ProjectMeta> {
    return this.cached(
      this.metaCache,
      `${c.integration.id}:${c.userId}`,
      async () => {
        const p = await c.client.getProject(c.integration.projectId);
        const meta: ProjectMeta = {
          identifier: p.identifier || c.integration.projectIdentifier,
          issueTypes: p.is_issue_type_enabled === true,
        };
        if (p.estimate) meta.estimateId = p.estimate;
        if (typeof p.is_time_tracking_enabled === "boolean") meta.timeTracking = p.is_time_tracking_enabled;
        if (typeof p.member_role === "number") meta.memberRole = p.member_role;
        return meta;
      },
      fresh,
    );
  }

  private projectStates(c: Ctx, fresh = false): Promise<PlaneState[]> {
    return this.cached(this.stateCache, c.integration.id, () => c.client.listStates(c.integration.projectId), fresh);
  }

  private projectLabels(c: Ctx): Promise<PlaneLabel[]> {
    return this.cached(this.labelCache, c.integration.id, () => c.client.listLabels(c.integration.projectId));
  }

  private projectMembers(c: Ctx): Promise<PlaneUserLite[]> {
    return this.cached(this.memberCache, c.integration.id, () => c.client.listMembers(c.integration.projectId));
  }

  // The project's ACTIVE estimate is the project's own `estimate` id; Plane's estimate
  // endpoint answers its first one, so its type is trusted only when the ids agree. No
  // estimate, or an edition without the endpoints, is an empty answer: the estimate then
  // shows read-only.
  private estimateInfo(c: Ctx, meta: ProjectMeta): Promise<EstimateInfo> {
    const estimateId = meta.estimateId;
    if (!estimateId) return Promise.resolve({ type: "", points: [] });
    return this.cached(this.estimateCache, `${c.integration.id}:${estimateId}`, async () => {
      const [estimate, points] = await Promise.all([
        c.client.getEstimate(c.integration.projectId),
        c.client.listEstimatePoints(c.integration.projectId, estimateId),
      ]);
      return {
        type: estimate?.id === estimateId ? (estimate.type ?? "") : "",
        points: [...points].sort((a, b) => (a.key ?? 0) - (b.key ?? 0)),
      };
    });
  }

  // Work-item type names (a Pro feature; `type` arrives as a uuid). Only asked for when the
  // project has types switched on — otherwise every item's type is blank anyway.
  private async typeNames(c: Ctx, meta: ProjectMeta): Promise<Map<string, string>> {
    if (!meta.issueTypes) return new Map();
    return new Map((await this.projectTypes(c)).map((t) => [t.id, t.name]));
  }

  private projectTypes(c: Ctx): Promise<PlaneIssueType[]> {
    return this.cached(this.typeCache, c.integration.id, () => c.client.listIssueTypes(c.integration.projectId));
  }

  private async mapContext(c: Ctx, meta: ProjectMeta): Promise<PlaneMapContext> {
    const [estimate, typeNames] = await Promise.all([this.estimateInfo(c, meta), this.typeNames(c, meta)]);
    return {
      id: c.integration.id,
      workspaceId: c.integration.workspaceId,
      projectIdentifier: meta.identifier,
      estimateType: estimate.type,
      typeNames,
      assetBase: planeApiBase(c.integration.siteUrl),
    };
  }

  // ── time tracking ────────────────────────────────────────────────────────────

  // `false` = known off (the project flag, or the worklog route refused within the cache
  // window), `true` = known on, `undefined` = not asked yet — the next worklog read is the
  // probe.
  private worklogsKnown(c: Ctx, meta: ProjectMeta): boolean | undefined {
    if (meta.timeTracking === false) return false;
    const hit = this.worklogRoute.get(`${c.integration.id}:${c.userId}`);
    return hit && hit.at > Date.now() - CACHE_TTL_MS ? hit.value : undefined;
  }

  private noteWorklogRoute(c: Ctx, available: boolean): void {
    this.worklogRoute.set(`${c.integration.id}:${c.userId}`, { value: available, at: Date.now() });
  }

  // Every item's logged minutes in one call — the sync's way to see which items' worklogs
  // moved. `undefined` when the route is not there for this project or key.
  private async readTotals(c: Ctx): Promise<Map<string, number> | undefined> {
    try {
      const rows = await c.client.totalWorklogs(c.integration.projectId);
      this.noteWorklogRoute(c, true);
      return new Map(rows.map((r) => [r.issue_id, r.duration]));
    } catch (err) {
      if (!isUnavailable(err)) throw err;
      this.noteWorklogRoute(c, false);
      return undefined;
    }
  }

  private async readWorklogs(c: Ctx, issueId: string): Promise<PlaneRawWorklog[] | undefined> {
    try {
      const rows = await c.client.listWorklogs(c.integration.projectId, issueId);
      this.noteWorklogRoute(c, true);
      return rows;
    } catch (err) {
      if (!isUnavailable(err)) throw err;
      this.noteWorklogRoute(c, false);
      return undefined;
    }
  }

  // ── sync ─────────────────────────────────────────────────────────────────────

  // One poll tick for ONE project. Honors the shared lease so N open boards cost one
  // poller per project; `full` bypasses it (connect and «Синхронізувати» are deliberate
  // human acts). The key is resolved BEFORE the lease: a member without one must never
  // take the lease and so starve the members who could actually poll.
  async sync(integrationId: string, userId: string, full = false): Promise<{ synced: boolean; rateLimited?: boolean }> {
    const cloud = this.auth.cloudClient();
    const integration = await getPlaneIntegrationById(cloud, integrationId);
    if (!integration) throw new Error("no plane integration");
    const client = this.clientFor(integration.siteUrl, integration.workspaceSlug, userId);
    if (!full) {
      const leased = await takePlaneSyncLease(cloud, integration.id, LEASE_STALE_MS);
      if (!leased) return { synced: false };
    }
    const wantFull = full || (this.lastFullSweep.get(integration.id) ?? 0) < Date.now() - FULL_SWEEP_EVERY_MS;
    try {
      await this.runSync({ cloud, integration, client, userId }, wantFull);
      return { synced: true };
    } catch (err) {
      // The budget is spent: this tick ends quietly, whatever it already wrote stands, and
      // the cursor only moved past what was mirrored. The next tick resumes.
      if (isRateLimited(err)) return { synced: false, rateLimited: true };
      throw err;
    }
  }

  private async runSync(c: Ctx, full: boolean): Promise<void> {
    const { cloud, integration, client } = c;
    const projectId = integration.projectId;
    const meta = await this.projectMeta(c, full);
    const state = await getPlaneSyncState(cloud, integration.id);
    const sweep = full || !state?.syncCursor;

    if (sweep) {
      // The column layout travels with the sweep: it changes rarely, and when it does the
      // whole board re-renders anyway.
      const states = await this.projectStates(c, true);
      await replacePlaneColumns(cloud, integration.id, integration.workspaceId, buildColumns(states));
    }

    // Newest change first; an incremental read stops at the first page reaching past the
    // cursor (minus a minute of slack) — on a quiet project that is one request.
    const since = sweep ? undefined : new Date(sinceCursor(state!.syncCursor!)).getTime();
    const raws = await client.listIssues(
      projectId,
      since === undefined ? undefined : (page) => page.some((r) => updatedMs(r) < since),
    );
    const changed = since === undefined ? raws : raws.filter((r) => updatedMs(r) >= since);

    // The mirror as it stands: what each item's logged time and child-refresh stamp were,
    // and — on a sweep — what Plane no longer lists.
    const mirrored = await listPlaneIssues(cloud, integration.id);
    const prior = new Map(mirrored.map((i) => [i.issueId, i]));
    const totals = this.worklogsKnown(c, meta) === false ? undefined : await this.readTotals(c);
    const ctx = await this.mapContext(c, meta);

    const issues = changed.map((raw) => {
      const before = prior.get(raw.id);
      // An item already mirrored keeps its logged time until its child refresh re-reads the
      // worklogs: the difference against `totals` is exactly what queues that refresh.
      return mapIssue(ctx, raw, before ? before.timeSpentSeconds / 60 : (totals?.get(raw.id) ?? 0));
    });
    await upsertPlaneIssues(cloud, issues);

    // The cursor is the newest `updated_at` the poll saw; an empty poll leaves it alone.
    const newest = issues.reduce<string | undefined>(
      (max, i) => (!max || i.planeUpdatedAt > max ? i.planeUpdatedAt : max),
      undefined,
    );
    if (newest) await advancePlaneSyncCursor(cloud, integration.id, newest);

    const current = new Map(prior);
    for (const issue of issues) {
      const stamp = prior.get(issue.issueId)?.childrenSyncedAt;
      current.set(issue.issueId, stamp ? { ...issue, childrenSyncedAt: stamp } : issue);
    }

    if (sweep) {
      // Deletion reconciliation — the incremental read never reports a removed, archived
      // or drafted item.
      const live = new Set(raws.map((r) => r.id));
      const gone = mirrored.map((i) => i.issueId).filter((id) => !live.has(id));
      await deletePlaneIssues(cloud, integration.id, gone);
      for (const id of gone) current.delete(id);
      this.lastFullSweep.set(integration.id, Date.now());
    }

    // Children are NOT fetched for every changed item: a few stale ones per tick, oldest
    // first. A long queue (a fresh connect) drains over minutes instead of spending the
    // whole budget in one tick.
    const due = pickChildrenDue([...current.values()], totals, CHILDREN_PER_TICK);
    if (due.length === 0) return;
    const people = await this.projectMembers(c);
    for (const id of due) {
      const issue = current.get(id)!;
      const { children, spentMinutes } = await this.fetchChildren(c, id, totals !== undefined, people);
      await replacePlaneIssueChildren(cloud, integration.id, integration.workspaceId, id, children);
      // The project total is the figure the next tick compares against, so it wins over
      // the item's own sum — otherwise a disagreement between the two would keep the item
      // due forever.
      const minutes = Math.round(totals ? (totals.get(id) ?? 0) : (spentMinutes ?? issue.timeSpentSeconds / 60));
      if (minutes * 60 !== issue.timeSpentSeconds)
        await upsertPlaneIssues(cloud, [{ ...issue, timeSpent: formatMinutes(minutes), timeSpentSeconds: minutes * 60 }]);
      await markPlaneChildrenSynced(cloud, integration.id, id, laterIso(new Date().toISOString(), issue.planeUpdatedAt));
    }
  }

  // One item's comments, attachments and (when the project tracks time) worklogs, mapped
  // for the mirror, plus the worklogs' own total. `spentMinutes` is undefined when the
  // worklog route is not there — «unknown», not zero.
  private async fetchChildren(
    c: Ctx,
    issueId: string,
    tracking: boolean,
    people: readonly PlaneUserLite[],
  ): Promise<{ children: Children; spentMinutes?: number }> {
    const projectId = c.integration.projectId;
    const [comments, attachments, worklogs] = await Promise.all([
      c.client.listComments(projectId, issueId),
      c.client.listAttachments(projectId, issueId),
      tracking ? this.readWorklogs(c, issueId) : Promise.resolve(undefined),
    ]);
    const byId = new Map(people.map((p) => [p.id, p]));
    const assetBase = planeApiBase(c.integration.siteUrl);
    const mappedWorklogs = mapWorklogs(worklogs ?? [], byId, assetBase);
    const out: { children: Children; spentMinutes?: number } = {
      children: {
        comments: mapComments(comments, assetBase),
        worklogs: mappedWorklogs,
        attachments: mapAttachments(attachments, byId),
      },
    };
    if (worklogs) out.spentMinutes = mappedWorklogs.reduce((sum, w) => sum + w.seconds / 60, 0);
    return out;
  }

  // ── refresh ──────────────────────────────────────────────────────────────────

  // One item, live → mirror, children included. The dialog calls it on open for
  // freshness; the actions that change children (comment, worklog, attachment) call it
  // after their Plane write.
  async refreshIssue(integrationId: string, key: string, userId: string): Promise<PlaneIssue> {
    const c = await this.withIntegration(integrationId, userId);
    return this.mirrorWithChildren(c, await c.client.getIssueByKey(key));
  }

  private async mirrorWithChildren(c: Ctx, raw: PlaneRawIssue): Promise<PlaneIssue> {
    const meta = await this.projectMeta(c);
    const tracking = this.worklogsKnown(c, meta) !== false;
    const [ctx, people] = await Promise.all([this.mapContext(c, meta), this.projectMembers(c)]);
    const { children, spentMinutes } = await this.fetchChildren(c, raw.id, tracking, people);
    const issue = mapIssue(ctx, raw, spentMinutes ?? 0);
    await upsertPlaneIssues(c.cloud, [issue]);
    await replacePlaneIssueChildren(c.cloud, c.integration.id, c.integration.workspaceId, raw.id, children);
    const at = laterIso(new Date().toISOString(), issue.planeUpdatedAt);
    await markPlaneChildrenSynced(c.cloud, c.integration.id, raw.id, at);
    return { ...issue, childrenSyncedAt: at };
  }

  // The item alone, after a write that cannot have touched its children (a move, a field
  // edit, a create) — one request instead of four. If its children were current before the
  // write they still are, so the stamp moves past the write and the item does not join the
  // drain queue for an edit Kermanych itself made.
  private async refreshItem(
    c: Ctx,
    issueId: string,
    before: PlaneIssue | undefined,
    childrenCurrent = false,
  ): Promise<PlaneIssue> {
    const meta = await this.projectMeta(c);
    const [ctx, raw] = await Promise.all([this.mapContext(c, meta), c.client.getIssue(c.integration.projectId, issueId)]);
    const issue = mapIssue(ctx, raw, (before?.timeSpentSeconds ?? 0) / 60);
    await upsertPlaneIssues(c.cloud, [issue]);
    const wasCurrent =
      !!before?.childrenSyncedAt && new Date(before.childrenSyncedAt).getTime() >= new Date(before.planeUpdatedAt).getTime();
    if (!childrenCurrent && !wasCurrent) return before?.childrenSyncedAt ? { ...issue, childrenSyncedAt: before.childrenSyncedAt } : issue;
    const at = laterIso(new Date().toISOString(), issue.planeUpdatedAt);
    await markPlaneChildrenSynced(c.cloud, c.integration.id, issue.issueId, at);
    return { ...issue, childrenSyncedAt: at };
  }

  // ── actions ──────────────────────────────────────────────────────────────────

  private async withIntegration(integrationId: string, userId: string): Promise<Ctx> {
    const cloud = this.auth.cloudClient();
    const integration = await getPlaneIntegrationById(cloud, integrationId);
    if (!integration) throw new Error("no plane integration");
    return { cloud, integration, client: this.clientFor(integration.siteUrl, integration.workspaceSlug, userId), userId };
  }

  // A key («WEB-42») to Plane's uuid. The mirror answers for free and hands back the row as
  // it was (its logged time and child stamp feed refreshItem); an item the mirror has not
  // seen yet costs one request.
  private async resolve(c: Ctx, key: string): Promise<{ issueId: string; before?: PlaneIssue }> {
    const before = (await listPlaneIssues(c.cloud, c.integration.id)).find((i) => i.key === key);
    if (before) return { issueId: before.issueId, before };
    return { issueId: (await c.client.getIssueByKey(key)).id };
  }

  // Every state other than the item's own, in board order. Plane has no workflow: any
  // state may follow any other.
  async listTransitions(integrationId: string, key: string, userId: string): Promise<PlaneTransition[]> {
    const c = await this.withIntegration(integrationId, userId);
    const [states, mirrored] = await Promise.all([this.projectStates(c), listPlaneIssues(c.cloud, c.integration.id)]);
    const currentId = mirrored.find((i) => i.key === key)?.statusId;
    return buildColumns(states)
      .filter((col) => col.stateIds[0] !== currentId)
      .map((col) => {
        const id = col.stateIds[0]!;
        return { id, name: col.name, to: { id, name: col.name, statusCategory: { key: categoryFromGroup(col.stateGroup) } } };
      });
  }

  async transition(integrationId: string, key: string, stateId: string, userId: string): Promise<PlaneIssue> {
    const c = await this.withIntegration(integrationId, userId);
    const { issueId, before } = await this.resolve(c, key);
    await c.client.updateIssue(c.integration.projectId, issueId, { state: stateId });
    return this.refreshItem(c, issueId, before);
  }

  // The composer's markdown, rendered to Plane's editor HTML so «**bold**» or a «- [ ]»
  // list arrive formatted rather than as literal punctuation.
  async addComment(integrationId: string, key: string, body: string, userId: string): Promise<PlaneIssue> {
    const c = await this.withIntegration(integrationId, userId);
    const { issueId } = await this.resolve(c, key);
    await c.client.addComment(c.integration.projectId, issueId, markdownToPlaneHtml(body));
    return this.mirrorWithChildren(c, await c.client.getIssue(c.integration.projectId, issueId));
  }

  // «Log work»: one worklog into Plane under the acting user's own key — so the entry
  // carries THEIR name in Plane — followed by the refresh that brings back the entry and
  // the moved total. The duration is parsed HERE (Plane takes whole minutes), so a typo is
  // refused in words before any request is spent.
  async logWork(integrationId: string, key: string, draft: PlaneWorklogDraft, userId: string): Promise<PlaneIssue> {
    const duration = parseDurationToMinutes(draft.timeSpent ?? "");
    const description = draft.description?.trim();
    const c = await this.withIntegration(integrationId, userId);
    const { issueId } = await this.resolve(c, key);
    await c.client.addWorklog(c.integration.projectId, issueId, { duration, ...(description ? { description } : {}) });
    return this.mirrorWithChildren(c, await c.client.getIssue(c.integration.projectId, issueId));
  }

  // Editing an entry. Whether this member MAY is Plane's call (own entries, or any for a
  // project admin) — the dialog only offers what editor-options said. The note is always
  // sent: an emptied note is a legitimate edit.
  async editWorklog(
    integrationId: string,
    key: string,
    worklogId: string,
    draft: PlaneWorklogDraft,
    userId: string,
  ): Promise<PlaneIssue> {
    const duration = parseDurationToMinutes(draft.timeSpent ?? "");
    const c = await this.withIntegration(integrationId, userId);
    const { issueId } = await this.resolve(c, key);
    await c.client.updateWorklog(c.integration.projectId, issueId, worklogId, {
      duration,
      description: draft.description?.trim() ?? "",
    });
    return this.mirrorWithChildren(c, await c.client.getIssue(c.integration.projectId, issueId));
  }

  async deleteWorklog(integrationId: string, key: string, worklogId: string, userId: string): Promise<PlaneIssue> {
    const c = await this.withIntegration(integrationId, userId);
    const { issueId } = await this.resolve(c, key);
    await c.client.deleteWorklog(c.integration.projectId, issueId, worklogId);
    return this.mirrorWithChildren(c, await c.client.getIssue(c.integration.projectId, issueId));
  }

  // ── authoring ────────────────────────────────────────────────────────────────

  // The draft spelled the way Plane's work-item POST/PATCH expects. Absent keys are not
  // sent — a PATCH changes only what it names.
  private async issueBody(c: Ctx, draft: PlaneIssueDraft, forCreate: boolean): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};
    if (draft.summary !== undefined) body.name = draft.summary.trim();
    // Markdown into Plane's editor HTML (plane-html.ts): the Менеджмент chat writes its
    // tickets as «## Context» / «- [ ] criterion», which must arrive as headings and a task
    // list, not as hashes and brackets.
    if (draft.description !== undefined) body.description_html = markdownToPlaneHtml(draft.description);
    if (draft.issueTypeId) body.type_id = draft.issueTypeId;
    if (draft.priority !== undefined) {
      if (!PRIORITIES.some((p) => p.id === draft.priority)) throw new Error(`unknown priority: ${String(draft.priority)}`);
      body.priority = draft.priority;
    }
    if (draft.labels !== undefined) body.labels = await this.labelIds(c, draft.labels);
    // One person on the Kermanych side (spec Decision 6): setting the assignee REPLACES
    // Plane's whole set with them, null empties it; undefined leaves it alone.
    if (draft.assigneeAccountId !== undefined) body.assignees = draft.assigneeAccountId ? [draft.assigneeAccountId] : [];
    if (draft.estimatePointId !== undefined) body.estimate_point = draft.estimatePointId || null;
    if (draft.startDate !== undefined) body.start_date = toPlaneDate(draft.startDate);
    if (draft.dueDate !== undefined) body.target_date = toPlaneDate(draft.dueDate);
    if (draft.parentKey !== undefined) {
      const parentKey = draft.parentKey.trim();
      if (parentKey) body.parent = (await this.resolve(c, parentKey)).issueId;
      else if (!forCreate) body.parent = null;
    }
    if (draft.stateId) body.state = draft.stateId;
    return body;
  }

  // Label NAMES (Jira parity, spec Decision 12) to the project's label ids,
  // case-insensitively. A name the project lacks is created once, best effort: a refusal
  // drops that one label rather than failing the whole write — except a dead key or a
  // spent budget, which the write itself would hit next.
  private async labelIds(c: Ctx, names: readonly string[]): Promise<string[]> {
    const wanted = [...new Map(names.map((n) => n.trim()).filter(Boolean).map((n) => [n.toLowerCase(), n])).values()];
    if (wanted.length === 0) return [];
    const byName = new Map((await this.projectLabels(c)).map((l) => [l.name.toLowerCase(), l.id]));
    const ids: string[] = [];
    for (const name of wanted) {
      let id = byName.get(name.toLowerCase());
      if (!id) {
        try {
          id = (await c.client.createLabel(c.integration.projectId, name)).id;
          this.labelCache.delete(c.integration.id);
        } catch (err) {
          if (!(err instanceof PlaneHttpError) || err.status === 401 || err.status === 429) throw err;
          continue;
        }
      }
      ids.push(id);
    }
    return ids;
  }

  async createIssue(integrationId: string, draft: PlaneIssueDraft, userId: string): Promise<PlaneIssue> {
    if (!draft.summary?.trim()) throw new Error("summary is required");
    const c = await this.withIntegration(integrationId, userId);
    const created = await c.client.createIssue(c.integration.projectId, await this.issueBody(c, draft, true));
    // A new item has no comments, attachments or worklogs: mirrored with its children
    // stamped current, without reading three empty lists.
    return this.refreshItem(c, created.id, undefined, true);
  }

  async editIssue(integrationId: string, key: string, draft: PlaneIssueDraft, userId: string): Promise<PlaneIssue> {
    const c = await this.withIntegration(integrationId, userId);
    const { issueId, before } = await this.resolve(c, key);
    await c.client.updateIssue(c.integration.projectId, issueId, await this.issueBody(c, draft, false));
    return this.refreshItem(c, issueId, before);
  }

  // What the editor opens an existing ticket with: the description as markdown, read live
  // from Plane's HTML. Saving it back goes through markdownToPlaneHtml, so headings, lists
  // and task items come back as themselves instead of one flattened paragraph.
  async issueDescription(integrationId: string, key: string, userId: string): Promise<{ markdown: string }> {
    const c = await this.withIntegration(integrationId, userId);
    const raw = await c.client.getIssueByKey(key);
    return { markdown: planeHtmlToMarkdown(raw.description_html ?? "") };
  }

  async deleteIssue(integrationId: string, key: string, userId: string): Promise<void> {
    const c = await this.withIntegration(integrationId, userId);
    const { issueId } = await this.resolve(c, key);
    await c.client.deleteIssue(c.integration.projectId, issueId);
    // The realtime DELETE carries the pk, so removing the mirror row here is what makes
    // every open board drop the card now rather than at the next full sweep.
    await deletePlaneIssues(c.cloud, c.integration.id, [issueId]);
  }

  // ── editor vocabularies ──────────────────────────────────────────────────────

  async editorOptions(integrationId: string, userId: string): Promise<PlaneEditorOptions> {
    const c = await this.withIntegration(integrationId, userId);
    const meta = await this.projectMeta(c);
    const [states, labels, estimate, types, timeTrackingEnabled] = await Promise.all([
      this.projectStates(c),
      this.projectLabels(c),
      this.estimateInfo(c, meta),
      meta.issueTypes ? this.projectTypes(c) : Promise.resolve([]),
      this.timeTrackingEnabled(c, meta),
    ]);
    const admin = meta.memberRole === ADMIN_ROLE;
    // A guest cannot log time at all (Plane's product rule); anyone else may touch their own.
    const own = timeTrackingEnabled && meta.memberRole !== GUEST_ROLE;
    return {
      // Epics are a type of their own in Plane and not a work item the board creates.
      issueTypes: types.filter((t) => t.is_active !== false && !t.is_epic).map((t) => ({ id: t.id, name: t.name })),
      priorities: PRIORITIES,
      labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color ?? "" })),
      states: buildColumns(states).map((col) => ({ id: col.stateIds[0]!, name: col.name, group: col.stateGroup, color: col.color })),
      estimatePoints: estimate.points.map((p) => ({ id: p.id, value: p.value ?? "" })),
      estimateType: ESTIMATE_TYPES[estimate.type] ? (estimate.type as PlaneEditorOptions["estimateType"]) : "",
      timeTrackingEnabled,
      myAccountId:
        this.registry.getPlaneToken(normalizePlaneSite(c.integration.siteUrl), normalizeSlug(c.integration.workspaceSlug), userId)
          ?.planeUserId ?? "",
      worklog: { editOwn: own, deleteOwn: own, editAll: own && admin, deleteAll: own && admin },
    };
  }

  // The project flag AND the route answering. Unknown is settled with one totals read (the
  // cheapest worklog request there is), then cached like every other vocabulary.
  private async timeTrackingEnabled(c: Ctx, meta: ProjectMeta): Promise<boolean> {
    const known = this.worklogsKnown(c, meta);
    if (known !== undefined) return known;
    return (await this.readTotals(c)) !== undefined;
  }

  // Who an item may be assigned to: the project's members, filtered here (Plane's member
  // list has no search) and cached, so typing in the picker spends no requests.
  async assignableUsers(
    integrationId: string,
    query: string,
    userId: string,
  ): Promise<{ accountId: string; displayName: string; avatar?: string }[]> {
    const c = await this.withIntegration(integrationId, userId);
    const members = await this.projectMembers(c);
    const needle = query.trim().toLowerCase();
    const assetBase = planeApiBase(c.integration.siteUrl);
    return members
      .filter(
        (m) =>
          !needle ||
          [m.display_name, m.first_name, m.last_name, m.email].some((v) => typeof v === "string" && v.toLowerCase().includes(needle)),
      )
      .slice(0, ASSIGNABLE_LIMIT)
      .map((m) => {
        const out: { accountId: string; displayName: string; avatar?: string } = { accountId: m.id, displayName: personName(m) };
        const avatar = personAvatar(m, assetBase);
        if (avatar) out.avatar = avatar;
        return out;
      });
  }

  // ── attachments ──────────────────────────────────────────────────────────────

  async uploadAttachment(
    integrationId: string,
    key: string,
    filename: string,
    data: Buffer,
    mime: string,
    userId: string,
  ): Promise<PlaneIssue> {
    const c = await this.withIntegration(integrationId, userId);
    const { issueId } = await this.resolve(c, key);
    await c.client.uploadAttachment(c.integration.projectId, issueId, filename, data, mime);
    return this.mirrorWithChildren(c, await c.client.getIssue(c.integration.projectId, issueId));
  }

  async downloadAttachment(
    integrationId: string,
    key: string,
    attachmentId: string,
    userId: string,
  ): Promise<{ body: ReadableStream<Uint8Array>; contentType: string }> {
    const c = await this.withIntegration(integrationId, userId);
    const { issueId } = await this.resolve(c, key);
    return c.client.downloadAttachment(c.integration.projectId, issueId, attachmentId);
  }

  // ── the Менеджмент assistant's tools (plane-tools.service.ts) ────────────────────
  // The tools write through the raw client (clientFor) and mirror as a SEPARATE, best-effort
  // step: a mirror that fails must never turn a write Plane accepted into an error, or the
  // model retries and files a duplicate (the Jira tools' rule). These are the pieces they
  // share with the actions above — so a label name, a parent key or a state means the same
  // thing whichever surface wrote it, and the vocabularies come from the same ten-minute
  // cache — keyed by the integration row the tools already hold.

  private ctxOf(integration: PlaneIntegration, userId: string): Ctx {
    return {
      cloud: this.auth.cloudClient(),
      integration,
      client: this.clientFor(integration.siteUrl, integration.workspaceSlug, userId),
      userId,
    };
  }

  statesOf(integration: PlaneIntegration, userId: string): Promise<PlaneState[]> {
    return this.projectStates(this.ctxOf(integration, userId));
  }

  labelsOf(integration: PlaneIntegration, userId: string): Promise<PlaneLabel[]> {
    return this.projectLabels(this.ctxOf(integration, userId));
  }

  membersOf(integration: PlaneIntegration, userId: string): Promise<PlaneUserLite[]> {
    return this.projectMembers(this.ctxOf(integration, userId));
  }

  // The project's ACTIVE estimate: its type and its points in Plane's order. Empty when the
  // project has none or the edition has no estimates.
  async estimateOf(integration: PlaneIntegration, userId: string): Promise<{ type: string; points: PlaneEstimatePoint[] }> {
    const c = this.ctxOf(integration, userId);
    return this.estimateInfo(c, await this.projectMeta(c));
  }

  mirroredIssues(integrationId: string): Promise<PlaneIssue[]> {
    return listPlaneIssues(this.auth.cloudClient(), integrationId);
  }

  // A key to Plane's uuid: the mirror first, one request otherwise.
  async issueIdOf(integration: PlaneIntegration, key: string, userId: string): Promise<string> {
    return (await this.resolve(this.ctxOf(integration, userId), key)).issueId;
  }

  // A draft as the work-item POST/PATCH body, by the same rules the board's editor writes
  // with (label names resolved and created when new, the parent key resolved, dates and
  // priority checked).
  draftBody(integration: PlaneIntegration, draft: PlaneIssueDraft, userId: string, forCreate: boolean): Promise<Record<string, unknown>> {
    return this.issueBody(this.ctxOf(integration, userId), draft, forCreate);
  }

  // The mirror after a tool's write, at the cost that write needs: a new item alone with its
  // (empty) children stamped current, an edited item alone, an item whose comments,
  // worklogs or attachments moved with its children, a deleted item's row dropped.
  async mirrorWrite(
    integration: PlaneIntegration,
    issueId: string,
    userId: string,
    what: "created" | "fields" | "children" | "deleted",
  ): Promise<void> {
    const c = this.ctxOf(integration, userId);
    if (what === "deleted") await deletePlaneIssues(c.cloud, integration.id, [issueId]);
    else if (what === "children") await this.mirrorWithChildren(c, await c.client.getIssue(integration.projectId, issueId));
    else if (what === "created") await this.refreshItem(c, issueId, undefined, true);
    else {
      const before = (await listPlaneIssues(c.cloud, integration.id)).find((i) => i.issueId === issueId);
      await this.refreshItem(c, issueId, before);
    }
  }

  // ── launch ───────────────────────────────────────────────────────────────────

  // Order matters and is deliberate: shadow task → session → binding → state move. The
  // session is the expensive, wanted thing, so a move Plane refuses NEVER kills it — the
  // refusal comes back beside the session as a warning.
  async launch(
    integrationId: string,
    key: string,
    projectId: string,
    userId: string,
    transitionId?: string,
    images?: ImageInput[],
  ): Promise<PlaneLaunchResult> {
    const c = await this.withIntegration(integrationId, userId);
    const raw = await c.client.getIssueByKey(key);

    // The shadow task: the whole existing pipeline (worktree, outbox, force-stop,
    // tasks_guard) runs on this ordinary row; `planeKey` is what keeps it off «Задачі».
    const task = await createTask(c.cloud, {
      projectId,
      title: `${key} — ${raw.name || key}`,
      // Markdown, not stripped text: the task body keeps the ticket's headings, lists and
      // task items, which is what both the board and the agent read.
      description: planeHtmlToMarkdown(raw.description_html ?? ""),
      assigneeId: userId,
      createdBy: userId,
      planeKey: key,
    });

    const session = await this.supervisor.createSessionFromTask(task.id, userId, images);
    await patchPlaneIssueBinding(c.cloud, c.integration.id, raw.id, { kermanychProjectId: projectId, taskId: task.id });

    if (!transitionId) return { session };
    try {
      await c.client.updateIssue(c.integration.projectId, raw.id, { state: transitionId });
      const before = (await listPlaneIssues(c.cloud, c.integration.id)).find((i) => i.issueId === raw.id);
      await this.refreshItem(c, raw.id, before);
      return { session };
    } catch (err) {
      return { session, transitionError: (err as Error).message };
    }
  }
}
