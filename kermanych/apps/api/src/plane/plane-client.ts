// apps/api/src/plane/plane-client.ts
// The one place that speaks HTTP to Plane. REST v1 (`/api/v1/`), authenticated per INSTANCE
// with a personal API key in `X-API-Key` — a client is built per request for the acting
// user, so every write lands in Plane under that person's identity (the whole point of
// per-user keys).
//
// v1, not v2 (spec Decision 1): it runs on Plane Cloud and on self-hosted Community
// editions alike. Every path ends in a slash — Plane routes nothing without one.
//
// The budget is the design constraint: Plane allows 60 requests a minute per key. Lists
// therefore always ask for the 100-row maximum, the work-item list can stop paging early
// (the incremental sync's cutoff), and nothing here fans out per item on its own — the
// service decides how many child reads a tick may spend.
import { Buffer } from "node:buffer";

// A non-2xx answer. Auth failures are normalised to status 401 whichever way Plane said
// them — an invalid key is a 401 on some deployments and a 403 `{"detail": "Given API
// token is not valid"}` on others — so the controller has one rule for «drop this user to
// read-only». A 403 that is a PERMISSION refusal keeps its 403 and reads as Plane's
// sentence. `body` is kept for the one caller that reads a refusal's payload (a 409 on
// createLabel names the label that already exists).
export class PlaneHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

export type PlaneCredentials = { siteUrl: string; workspaceSlug: string; apiToken: string };

// Plane's UserLite, the shape every expanded person arrives in (`assignees`, `created_by`,
// `actor`) and the project member list's rows.
export type PlaneUserLite = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  avatar?: string | null;
  avatar_url?: string | null;
  display_name?: string | null;
};

// Only the members the integration reads; Plane sends many more. `member_role` is the
// ACTING key's role in the project (20 admin, 15 member, 5 guest); the two feature flags
// are on the project object of every edition that has the feature.
export type PlaneProject = {
  id: string;
  name: string;
  identifier: string;
  estimate?: string | null;
  is_time_tracking_enabled?: boolean;
  is_issue_type_enabled?: boolean;
  member_role?: number | null;
  archived_at?: string | null;
};

export type PlaneState = {
  id: string;
  name: string;
  color?: string | null;
  group?: string | null;
  sequence?: number | null;
};

export type PlaneLabel = { id: string; name: string; color?: string | null };

export type PlaneEstimate = { id: string; type?: string | null; name?: string | null };

export type PlaneEstimatePoint = { id: string; key?: number | null; value?: string | null; estimate?: string | null };

export type PlaneIssueType = { id: string; name: string; is_active?: boolean | null; is_epic?: boolean | null };

// Raw work item as the sync engine consumes it, with ISSUE_EXPAND applied. Every relation
// is typed as «expanded object OR bare uuid» on purpose: plane-map.ts is the tolerant
// boundary that turns either into a mirror row.
export type PlaneRawIssue = {
  id: string;
  name?: string | null;
  description_html?: string | null;
  priority?: string | null;
  sequence_id?: number | null;
  state?: string | (Pick<PlaneState, "id" | "name" | "color" | "group">) | null;
  assignees?: (string | PlaneUserLite)[] | null;
  labels?: (string | PlaneLabel)[] | null;
  estimate_point?: string | PlaneEstimatePoint | null;
  parent?: string | { id?: string; sequence_id?: number | null; project_id?: string | null } | null;
  type?: string | { id?: string; name?: string | null } | null;
  type_id?: string | null;
  start_date?: string | null;
  target_date?: string | null;
  created_by?: string | PlaneUserLite | null;
  created_at?: string | null;
  updated_at?: string | null;
};

// `actor` is a uuid unless `expand=actor` was asked for, which listComments always does.
export type PlaneRawComment = {
  id: string;
  comment_html?: string | null;
  actor?: string | PlaneUserLite | null;
  created_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

// `duration` is in MINUTES (Plane's own unit). There is no work-date field: `created_at`
// is the only date an entry has.
export type PlaneRawWorklog = {
  id: string;
  duration?: number | null;
  description?: string | null;
  logged_by?: string | PlaneUserLite | null;
  created_by?: string | PlaneUserLite | null;
  created_at?: string | null;
};

export type PlaneRawAttachment = {
  id: string;
  attributes?: { name?: string | null; size?: number | null; type?: string | null } | null;
  size?: number | null;
  is_uploaded?: boolean | null;
  created_by?: string | PlaneUserLite | null;
  created_at?: string | null;
};

// Read-side shapes for the Менеджмент assistant's later tools; passed through close to
// Plane's own payload rather than re-modelled.
export type PlaneSearchHit = {
  id: string;
  name: string;
  sequence_id: number;
  project__identifier: string;
  project_id: string;
};

type PlanePage<T> = {
  results?: T[];
  next_cursor?: string | null;
  next_page_results?: boolean;
};

// The relations the mirror shows, expanded inline so a work item maps without a lookup
// per field: states and labels come back as objects, people as UserLite, the estimate
// point with its value, the parent with its sequence id.
export const ISSUE_EXPAND = "assignees,labels,state,created_by,estimate_point,parent";

// Plane's documented maximum. Always sent: the Community default is 1000 and Cloud's 20.
const PAGE = 100;

// A runaway guard, not a limit anyone should meet: 200 pages of 100 is 20 000 rows, and a
// cursor that never stops advancing must not spend the key's whole budget.
const MAX_PAGES = 200;

const CLOUD_WEB = "https://app.plane.so";
const CLOUD_API = "https://api.plane.so";
const CLOUD_HOSTS: Record<string, true> = { "plane.so": true, "www.plane.so": true, "app.plane.so": true, "api.plane.so": true };

// The site the operator typed or pasted, as the WEB origin every caller and the token table
// store (spec Decision 4): a bare host gains https, a pasted workspace URL loses its path,
// and any spelling of Plane Cloud becomes https://app.plane.so.
export function normalizePlaneSite(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return withScheme;
  }
  return CLOUD_HOSTS[url.hostname.toLowerCase()] ? CLOUD_WEB : url.origin;
}

// Plane Cloud serves its API from its own host; a self-hosted instance serves the API and
// the web app from one origin.
export function planeApiBase(site: string): string {
  const web = normalizePlaneSite(site);
  return web === CLOUD_WEB ? CLOUD_API : web;
}

export function planeWebBase(site: string): string {
  return normalizePlaneSite(site);
}

// The work item's page in Plane's web app (`/{slug}/browse/{IDENT}-{seq}/`).
export function planeIssueUrl(site: string, workspaceSlug: string, key: string): string {
  return `${planeWebBase(site)}/${encodeURIComponent(workspaceSlug)}/browse/${encodeURIComponent(key)}/`;
}

// Keys whose value IS the sentence (said without a field prefix), and the DRF bookkeeping
// keys that never carry one.
const BARE_KEYS: Record<string, true> = { error: true, detail: true, error_message: true, non_field_errors: true };
const SILENT_KEYS: Record<string, true> = { status: true, id: true, error_code: true, code: true };

// One flattened human line out of Plane's error shapes — `{"error": …}`, `{"detail": …}`,
// `{"error_code", "error_message"}` (the rate limiter) and DRF field dicts
// (`{"name": ["This field is required."]}`, `non_field_errors`) — so a refusal surfaces as
// text rather than JSON soup.
export function flattenPlaneError(status: number, body: unknown): string {
  const parts: string[] = [];
  const say = (v: unknown, field?: string): void => {
    const msgs = (Array.isArray(v) ? v : [v]).filter((m): m is string => typeof m === "string" && m.trim() !== "");
    if (msgs.length) parts.push(field ? `${field}: ${msgs.join(" ")}` : msgs.join(" "));
  };
  if (Array.isArray(body)) say(body);
  else if (typeof body === "string") say(body);
  else if (body && typeof body === "object") {
    for (const [field, v] of Object.entries(body)) {
      if (SILENT_KEYS[field]) continue;
      say(v, BARE_KEYS[field] ? undefined : field);
    }
  }
  return parts.length ? parts.join("; ") : `Plane responded ${status}`;
}

// A 403 is an auth failure only when Plane's authentication layer said so (its `detail`
// names the token or the credentials); a view's permission refusal is not.
function isAuthRefusal(status: number, body: unknown): boolean {
  if (status === 401) return true;
  if (status !== 403 || !body || typeof body !== "object") return false;
  const detail = (body as { detail?: unknown }).detail;
  return typeof detail === "string" && /token|credential|authenticat/i.test(detail);
}

async function errorFrom(res: Response): Promise<PlaneHttpError> {
  const body: unknown = await res.json().catch(() => undefined);
  if (isAuthRefusal(res.status, body)) return new PlaneHttpError(401, flattenPlaneError(res.status, body), body);
  let message = flattenPlaneError(res.status, body);
  // The limiter's own words are a code («RATE_LIMIT_EXCEEDED»); the wait it names is
  // what a person can act on.
  const retry = res.status === 429 ? res.headers.get("retry-after") : null;
  if (retry) message = `${message} (retry in ${retry}s)`;
  return new PlaneHttpError(res.status, message, body);
}

// S3-compatible storage answers a refused upload with an XML <Error>; its <Message> is the
// readable part («Your proposed upload exceeds the maximum allowed size»).
function storageMessage(status: number, text: string): string {
  const m = /<Message>([^<]*)<\/Message>/i.exec(text);
  return m?.[1]?.trim() || `attachment storage responded ${status}`;
}

export class PlaneClient {
  private readonly api: string;
  private readonly slug: string;
  private readonly key: string;

  constructor(creds: PlaneCredentials) {
    this.api = `${planeApiBase(creds.siteUrl)}/api/v1`;
    this.slug = encodeURIComponent(creds.workspaceSlug.trim());
    this.key = creds.apiToken;
  }

  private ws(path: string): string {
    return `/workspaces/${this.slug}${path}`;
  }

  private project(projectId: string, path = ""): string {
    return this.ws(`/projects/${encodeURIComponent(projectId)}/${path}`);
  }

  private item(projectId: string, issueId: string, path = ""): string {
    return this.project(projectId, `work-items/${encodeURIComponent(issueId)}/${path}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: {
        "X-API-Key": this.key,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw await errorFrom(res);
    // 204 from deletes and the upload completion: nothing to parse.
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // Cursor paging over Plane's envelope. A few endpoints answer a PLAIN ARRAY instead
  // (members, attachments, worklogs, depending on the edition) — that is the whole list,
  // returned as is. `stop` sees each page and ends the walk early once it says so (the
  // incremental sync stops at the first page reaching past its cutoff).
  private async listAll<T>(path: string, params: Record<string, string> = {}, stop?: (page: T[]) => boolean): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const q = new URLSearchParams({ per_page: String(PAGE), ...params, ...(cursor ? { cursor } : {}) });
      const page = await this.request<PlanePage<T> | T[] | undefined>("GET", `${path}?${q.toString()}`);
      if (Array.isArray(page)) return [...out, ...page];
      const results = page?.results ?? [];
      out.push(...results);
      if (stop?.(results)) return out;
      const next = page?.next_cursor ?? undefined;
      if (!page?.next_page_results || !next || next === cursor || results.length === 0) return out;
      cursor = next;
    }
    return out;
  }

  // ── identity & projects ──────────────────────────────────────────────────────

  // The token validator: an auth refusal here is «токен не працює», anything else means
  // the key is real.
  me(): Promise<PlaneUserLite> {
    return this.request("GET", "/users/me/");
  }

  // The projects this key can see in the workspace (its own memberships plus public
  // ones). Also the second half of token validation: a key scoped to another workspace,
  // or a mistyped slug, fails here rather than on the first sync.
  listProjects(): Promise<PlaneProject[]> {
    return this.listAll(this.ws("/projects/"));
  }

  getProject(projectId: string): Promise<PlaneProject> {
    return this.request("GET", this.project(projectId));
  }

  // Triage states are not listed (Plane excludes them), so every state here is a column.
  listStates(projectId: string): Promise<PlaneState[]> {
    return this.listAll(this.project(projectId, "states/"));
  }

  listLabels(projectId: string): Promise<PlaneLabel[]> {
    return this.listAll(this.project(projectId, "labels/"));
  }

  // A 409 means the label already exists (another writer, or a spelling the caller's
  // cached list did not have yet); Plane names its id, which is exactly what was wanted.
  async createLabel(projectId: string, name: string): Promise<PlaneLabel> {
    try {
      return await this.request<PlaneLabel>("POST", this.project(projectId, "labels/"), { name });
    } catch (err) {
      const id = err instanceof PlaneHttpError && err.status === 409 ? (err.body as { id?: unknown } | undefined)?.id : undefined;
      if (typeof id === "string") return { id, name };
      throw err;
    }
  }

  // A plain array of UserLite. The docs show it wrapped once more (`[[…]]`); either
  // spelling flattens to the same list.
  async listMembers(projectId: string): Promise<PlaneUserLite[]> {
    const rows = await this.listAll<PlaneUserLite | PlaneUserLite[]>(this.project(projectId, "members/"));
    return rows.flatMap((r) => (Array.isArray(r) ? r : [r]));
  }

  // ── work items ───────────────────────────────────────────────────────────────

  // Newest change first, the only order that lets an incremental read stop early: the list
  // has no updated-since filter on v1 (spec Decision 8). Archived, draft and triage items
  // are not listed — the full sweep's reconciliation drops them from the mirror.
  listIssues(projectId: string, stop?: (page: PlaneRawIssue[]) => boolean): Promise<PlaneRawIssue[]> {
    return this.listAll(this.project(projectId, "work-items/"), { order_by: "-updated_at", expand: ISSUE_EXPAND }, stop);
  }

  // Ids only — the cheapest answer to «which items still exist».
  async listIssueIds(projectId: string): Promise<string[]> {
    const rows = await this.listAll<{ id: string }>(this.project(projectId, "work-items/"), { fields: "id" });
    return rows.map((r) => r.id);
  }

  // By the human key («WEB-42»), workspace-wide. A non-numeric sequence part is a 404.
  getIssueByKey(key: string): Promise<PlaneRawIssue> {
    return this.request("GET", this.ws(`/work-items/${encodeURIComponent(key)}/?expand=${ISSUE_EXPAND}`));
  }

  getIssue(projectId: string, issueId: string): Promise<PlaneRawIssue> {
    return this.request("GET", `${this.item(projectId, issueId)}?expand=${ISSUE_EXPAND}`);
  }

  createIssue(projectId: string, body: Record<string, unknown>): Promise<PlaneRawIssue> {
    return this.request("POST", this.project(projectId, "work-items/"), body);
  }

  // PATCH: only the sent keys change, but `assignees`/`labels` REPLACE the whole set.
  updateIssue(projectId: string, issueId: string, body: Record<string, unknown>): Promise<PlaneRawIssue> {
    return this.request("PATCH", this.item(projectId, issueId), body);
  }

  // A soft delete; only an admin or the item's creator may.
  deleteIssue(projectId: string, issueId: string): Promise<void> {
    return this.request("DELETE", this.item(projectId, issueId));
  }

  // ── comments ─────────────────────────────────────────────────────────────────

  listComments(projectId: string, issueId: string): Promise<PlaneRawComment[]> {
    return this.listAll(this.item(projectId, issueId, "comments/"), { expand: "actor" });
  }

  addComment(projectId: string, issueId: string, html: string): Promise<PlaneRawComment> {
    return this.request("POST", this.item(projectId, issueId, "comments/"), { comment_html: html });
  }

  // Only the comment's author (or a project admin) may; Plane's 403 names the refusal.
  updateComment(projectId: string, issueId: string, commentId: string, html: string): Promise<PlaneRawComment> {
    return this.request("PATCH", this.item(projectId, issueId, `comments/${encodeURIComponent(commentId)}/`), { comment_html: html });
  }

  deleteComment(projectId: string, issueId: string, commentId: string): Promise<void> {
    return this.request("DELETE", this.item(projectId, issueId, `comments/${encodeURIComponent(commentId)}/`));
  }

  // ── attachments ──────────────────────────────────────────────────────────────

  // Only uploaded ones are listed (Plane filters half-finished uploads out).
  listAttachments(projectId: string, issueId: string): Promise<PlaneRawAttachment[]> {
    return this.listAll(this.item(projectId, issueId, "attachments/"));
  }

  // Plane's three-step upload: (1) the metadata POST hands out a presigned storage form,
  // (2) the file goes to storage as multipart WITHOUT the API key — the key must never
  // reach the storage host — with every presigned field first and `file` last (S3 ignores
  // fields after the file), (3) the PATCH marks it uploaded, which is what makes Plane
  // list it. The `type` sent in step 1 is a policy condition: storage refuses a different
  // Content-Type, so the same string travels in both places.
  async uploadAttachment(projectId: string, issueId: string, filename: string, data: Buffer, mime: string): Promise<void> {
    const type = mime || "application/octet-stream";
    const path = this.item(projectId, issueId, "attachments/");
    const started = await this.request<{
      upload_data?: { url?: string; fields?: Record<string, string> } | null;
      asset_id?: string;
      attachment?: { id?: string } | null;
    }>("POST", path, { name: filename, type, size: data.length });
    const url = started?.upload_data?.url;
    const assetId = started?.asset_id ?? started?.attachment?.id;
    if (!url || !assetId) throw new PlaneHttpError(502, "Plane did not hand out an upload address");

    const form = new FormData();
    for (const [k, v] of Object.entries(started.upload_data?.fields ?? {})) form.append(k, v);
    form.append("file", new Blob([new Uint8Array(data)], { type }), filename);
    const stored = await fetch(url, { method: "POST", body: form });
    if (!stored.ok) throw new PlaneHttpError(stored.status, storageMessage(stored.status, await stored.text().catch(() => "")));

    await this.request("PATCH", `${path}${encodeURIComponent(assetId)}/`, { is_uploaded: true });
  }

  // A streamed proxy hand-off (the controller pipes this body to the UI). Plane answers
  // the download with a redirect to a presigned storage URL; it is followed by hand, and
  // WITHOUT the key, so the key never reaches the storage host. A deployment that streams
  // the file itself (200) is passed straight through.
  async downloadAttachment(
    projectId: string,
    issueId: string,
    attachmentId: string,
  ): Promise<{ body: ReadableStream<Uint8Array>; contentType: string }> {
    const url = `${this.api}${this.item(projectId, issueId, `attachments/${encodeURIComponent(attachmentId)}/`)}`;
    const res = await fetch(url, { headers: { "X-API-Key": this.key }, redirect: "manual" });
    let file = res;
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location) throw new PlaneHttpError(502, "Plane gave no download location");
      file = await fetch(new URL(location, url).toString());
      if (!file.ok || !file.body) throw new PlaneHttpError(file.status, `attachment storage responded ${file.status}`);
    } else if (!res.ok || !res.body) {
      throw await errorFrom(res);
    }
    return { body: file.body!, contentType: file.headers.get("content-type") ?? "application/octet-stream" };
  }

  // ── worklogs (time tracking: Plane Pro; no route on Community — a 404) ────────

  listWorklogs(projectId: string, issueId: string): Promise<PlaneRawWorklog[]> {
    return this.listAll(this.item(projectId, issueId, "worklogs/"));
  }

  addWorklog(projectId: string, issueId: string, input: { duration: number; description?: string }): Promise<PlaneRawWorklog> {
    return this.request("POST", this.item(projectId, issueId, "worklogs/"), input);
  }

  updateWorklog(
    projectId: string,
    issueId: string,
    worklogId: string,
    input: { duration: number; description: string },
  ): Promise<PlaneRawWorklog> {
    return this.request("PATCH", this.item(projectId, issueId, `worklogs/${encodeURIComponent(worklogId)}/`), input);
  }

  deleteWorklog(projectId: string, issueId: string, worklogId: string): Promise<void> {
    return this.request("DELETE", this.item(projectId, issueId, `worklogs/${encodeURIComponent(worklogId)}/`));
  }

  // Every item's logged total in ONE call (minutes) — what the sync compares against the
  // mirror to find the items whose worklogs moved, instead of reading each item's list.
  async totalWorklogs(projectId: string): Promise<{ issue_id: string; duration: number }[]> {
    const rows = await this.request<{ issue_id?: string; duration?: number }[] | undefined>(
      "GET",
      this.project(projectId, "total-worklogs/"),
    );
    return (Array.isArray(rows) ? rows : [])
      .filter((r): r is { issue_id: string; duration: number } => typeof r.issue_id === "string")
      .map((r) => ({ issue_id: r.issue_id, duration: typeof r.duration === "number" ? r.duration : 0 }));
  }

  // ── estimates & types (Cloud/Commercial; absent or paid elsewhere) ───────────
  // Tolerant on purpose: a 404 (no route on Community, or no estimate) and a 402 (a paid
  // feature) are «this project has none», which the editor shows as read-only rather than
  // as an error.

  // `.first()` of the project's estimates on Plane's side — not necessarily the active one,
  // so the caller compares the id with the project's own `estimate`.
  async getEstimate(projectId: string): Promise<PlaneEstimate | undefined> {
    try {
      return await this.request<PlaneEstimate>("GET", this.project(projectId, "estimates/"));
    } catch (err) {
      if (err instanceof PlaneHttpError && (err.status === 404 || err.status === 402)) return undefined;
      throw err;
    }
  }

  async listEstimatePoints(projectId: string, estimateId: string): Promise<PlaneEstimatePoint[]> {
    try {
      return await this.listAll(this.project(projectId, `estimates/${encodeURIComponent(estimateId)}/estimate-points/`));
    } catch (err) {
      if (err instanceof PlaneHttpError && (err.status === 404 || err.status === 402)) return [];
      throw err;
    }
  }

  async listIssueTypes(projectId: string): Promise<PlaneIssueType[]> {
    try {
      return await this.listAll(this.project(projectId, "work-item-types/"));
    } catch (err) {
      if (err instanceof PlaneHttpError && (err.status === 404 || err.status === 402)) return [];
      throw err;
    }
  }

  // ── reads for the Менеджмент assistant's tools ──────────────────────────────

  // Name / identifier / exact-sequence search. `projectId` narrows it to one project.
  async searchWorkItems(search: string, opts: { projectId?: string; limit?: number } = {}): Promise<PlaneSearchHit[]> {
    const q = new URLSearchParams({
      search,
      limit: String(opts.limit ?? 10),
      workspace_search: opts.projectId ? "false" : "true",
      ...(opts.projectId ? { project_id: opts.projectId } : {}),
    });
    const res = await this.request<{ issues?: PlaneSearchHit[] }>("GET", this.ws(`/work-items/search/?${q.toString()}`));
    return res?.issues ?? [];
  }

  listCycles(projectId: string): Promise<Record<string, unknown>[]> {
    return this.listAll(this.project(projectId, "cycles/"));
  }

  listModules(projectId: string): Promise<Record<string, unknown>[]> {
    return this.listAll(this.project(projectId, "modules/"));
  }

  listLinks(projectId: string, issueId: string): Promise<Record<string, unknown>[]> {
    return this.listAll(this.item(projectId, issueId, "links/"));
  }

  // A web link on a work item (http/https only; Plane refuses a URL the item already has).
  createLink(projectId: string, issueId: string, input: { url: string; title?: string }): Promise<Record<string, unknown>> {
    return this.request("POST", this.item(projectId, issueId, "links/"), input);
  }

  // ── cycles & modules (the Менеджмент assistant's planning tools) ─────────────
  // Plane's answer to sprints and to versions/components. A work item sits in at most one
  // cycle (adding it moves it) and in any number of modules.

  // `start_date` and `end_date` travel together or not at all — Plane refuses one alone.
  createCycle(projectId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", this.project(projectId, "cycles/"), body);
  }

  addCycleIssues(projectId: string, cycleId: string, issueIds: string[]): Promise<unknown> {
    return this.request("POST", this.project(projectId, `cycles/${encodeURIComponent(cycleId)}/cycle-issues/`), { issues: issueIds });
  }

  removeCycleIssue(projectId: string, cycleId: string, issueId: string): Promise<void> {
    return this.request(
      "DELETE",
      this.project(projectId, `cycles/${encodeURIComponent(cycleId)}/cycle-issues/${encodeURIComponent(issueId)}/`),
    );
  }

  createModule(projectId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", this.project(projectId, "modules/"), body);
  }

  addModuleIssues(projectId: string, moduleId: string, issueIds: string[]): Promise<unknown> {
    return this.request("POST", this.project(projectId, `modules/${encodeURIComponent(moduleId)}/module-issues/`), { issues: issueIds });
  }

  removeModuleIssue(projectId: string, moduleId: string, issueId: string): Promise<void> {
    return this.request(
      "DELETE",
      this.project(projectId, `modules/${encodeURIComponent(moduleId)}/module-issues/${encodeURIComponent(issueId)}/`),
    );
  }

  listActivities(projectId: string, issueId: string): Promise<Record<string, unknown>[]> {
    return this.listAll(this.item(projectId, issueId, "activities/"), { expand: "actor" });
  }
}
