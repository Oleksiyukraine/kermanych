// apps/api/src/jira/jira-client.ts
// The one place that speaks HTTP to Jira Cloud. Basic auth (email:api-token) per
// INSTANCE — a client is built per request for the acting user, so every write lands in
// Jira under that person's identity (the whole point of per-user tokens).
//
// Two API families, one host: /rest/api/3 (issues, v3, ADF bodies + renderedFields HTML)
// and /rest/agile/1.0 (boards and their column layout). Search uses POST
// /rest/api/3/search/jql — the token-paginated endpoint that replaced the deprecated
// startAt-paginated /rest/api/3/search.
import { Buffer } from "node:buffer";

export class JiraHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type JiraCredentials = { siteUrl: string; email: string; apiToken: string };

export type JiraBoardSummary = { id: number; name: string; type: string; projectKey?: string };

export type JiraBoardColumnConfig = { name: string; statusIds: string[] }[];

export type JiraTransition = {
  id: string;
  name: string;
  to: { id: string; name: string; statusCategory: { key: string } };
};

export type JiraStatusSummary = { id: string; name: string; categoryKey: string };

// One entry of GET /rest/api/3/field — the site's field dictionary. Only what start-date
// resolution reads: the id to request, and the name/schema that identify it.
export type JiraFieldSummary = {
  id: string;
  name?: string;
  custom?: boolean;
  schema?: { type?: string; custom?: string };
};

// Raw issue as the sync engine consumes it: `fields` for data, `renderedFields` for the
// HTML Jira already rendered (description). Typed loosely on purpose — jira-map.ts is the
// tolerant boundary that turns this into mirror rows.
export type JiraRawIssue = {
  id: string;
  key: string;
  fields: Record<string, unknown>;
  renderedFields?: Record<string, unknown>;
};

// The standard set the mirror displays; requesting exactly these keeps the search payload
// bounded no matter what custom fields the site defines.
export const ISSUE_FIELDS = [
  "summary",
  "description",
  "issuetype",
  "priority",
  "labels",
  "assignee",
  "reporter",
  "status",
  "parent",
  "timetracking",
  "updated",
  "duedate",
  "attachment",
] as const;

const PAGE = 50;

// Jira Cloud sites are commonly typed bare («team.atlassian.net»); the client owns the
// normalisation so every caller and the token table store the same spelling.
export function normalizeSiteUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// One flattened human line out of Jira's two error shapes ({errorMessages: []} and
// {errors: {field: msg}}), so a refusal surfaces as text rather than JSON soup.
export function flattenJiraError(status: number, body: unknown): string {
  const parts: string[] = [];
  if (body && typeof body === "object") {
    if ("errorMessages" in body && Array.isArray(body.errorMessages)) {
      for (const m of body.errorMessages) if (typeof m === "string") parts.push(m);
    }
    if ("errors" in body && body.errors && typeof body.errors === "object") {
      for (const [field, msg] of Object.entries(body.errors)) parts.push(`${field}: ${String(msg)}`);
    }
  }
  return parts.length ? parts.join("; ") : `Jira responded ${status}`;
}

// One issue comment as GET .../comment returns it; `renderedBody` is present because the
// client always asks for the renderedBody expand, and `body` (the ADF source) always rides
// beside it — the Менеджмент assistant's tools read that one back as markdown.
export type JiraRawComment = {
  id: string;
  author?: { displayName?: string; avatarUrls?: Record<string, string> };
  renderedBody?: string;
  body?: unknown;
  created: string;
  updated: string;
};

export type JiraRawWorklog = {
  id: string;
  author?: { accountId?: string; displayName?: string; avatarUrls?: Record<string, string> };
  timeSpent?: string;
  timeSpentSeconds?: number;
  started: string;
  comment?: unknown;
};

// The shapes below serve the Менеджмент assistant's tools (jira-tools.service.ts). Only the
// members the tool layer reads are typed; Jira sends more, and the tools pass what they
// read through to the model rather than re-modelling Jira.
export type JiraRawChange = {
  id: string;
  author?: { displayName?: string };
  created: string;
  items: { field: string; fromString?: string | null; toString?: string | null }[];
};

// One entry of an issue's `issuelinks`, read from THAT issue's side: `outwardIssue` present
// means «this issue <type.outward> outwardIssue», `inwardIssue` means «this issue
// <type.inward> inwardIssue» (developer.atlassian.com, «Jira issue linking model»).
export type JiraRawIssueLink = {
  id: string;
  type: { name: string; inward: string; outward: string };
  inwardIssue?: { key: string; fields?: Record<string, unknown> };
  outwardIssue?: { key: string; fields?: Record<string, unknown> };
};

export type JiraProjectSummary = {
  id: string;
  key: string;
  name: string;
  projectTypeKey?: string;
  // "next-gen" = team-managed, "classic" = company-managed — the two differ in how issue
  // types and parents are configured, which is worth telling the model.
  style?: string;
};

export type JiraCreateMetaIssueType = {
  id: string;
  name: string;
  subtask?: boolean;
  hierarchyLevel?: number;
  description?: string;
};

export type JiraFieldMeta = {
  fieldId: string;
  key?: string;
  name: string;
  required: boolean;
  hasDefaultValue?: boolean;
  schema?: { type?: string; items?: string; system?: string; custom?: string };
  allowedValues?: unknown[];
};

export type JiraUserSummary = {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  active?: boolean;
  accountType?: string;
};

export type JiraSprint = {
  id: number;
  name: string;
  state?: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  goal?: string;
};

export type JiraVersion = {
  id: string;
  name: string;
  description?: string;
  released?: boolean;
  archived?: boolean;
  startDate?: string;
  releaseDate?: string;
};

// Jira's remaining-estimate adjustment, the choice its own «Log work» dialog offers. It
// rides in the QUERY string, not the body:
//   auto   — recalculate the remaining estimate from the logged time (Jira's default)
//   leave  — write the entry, touch no estimate
//   new    — replace the remaining estimate with `value`
//   manual — move the remaining estimate by `value`
//
// The three worklog endpoints do NOT accept the same set, and the difference is Jira's,
// not ours: adding takes `manual` as `reduceBy` (work done eats the estimate), DELETING
// takes it as `increaseBy` (removing an entry gives the time back), and UPDATING has no
// manual form at all — only auto, leave and an explicit new estimate. Each method below
// therefore states which parameter its `manual` becomes, and `worklogQuery` refuses a
// mode the endpoint cannot express instead of sending it for Jira to reject.
export type JiraWorklogAdjust =
  | { mode: "auto" }
  | { mode: "leave" }
  | { mode: "new"; value: string }
  | { mode: "manual"; value: string };

export type JiraWorklogWrite = {
  // Jira's duration spelling («3h 20m»). Jira parses and refuses it, not us.
  timeSpent: string;
  // Already in Jira's worklog spelling — see toJiraStarted in jira-map.ts.
  started: string;
  // An ADF doc; the service builds it from the note's markdown (adfDoc, jira-adf.ts).
  comment?: Record<string, unknown>;
  adjust: JiraWorklogAdjust;
};

export class JiraClient {
  private readonly base: string;
  private readonly authHeader: string;

  constructor(creds: JiraCredentials) {
    this.base = normalizeSiteUrl(creds.siteUrl);
    this.authHeader = `Basic ${Buffer.from(`${creds.email}:${creds.apiToken}`).toString("base64")}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const parsed: unknown = await res.json().catch(() => undefined);
      throw new JiraHttpError(res.status, flattenJiraError(res.status, parsed));
    }
    // 204 from transitions/edit/delete: nothing to parse, nothing the caller reads.
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // ── identity ─────────────────────────────────────────────────────────────────

  // The token validator: 401 here is «токен не працює», anything else means it does.
  myself(): Promise<{ accountId: string; displayName: string; emailAddress?: string }> {
    return this.request("GET", "/rest/api/3/myself");
  }

  // ── boards ───────────────────────────────────────────────────────────────────

  async listBoards(): Promise<JiraBoardSummary[]> {
    const out: JiraBoardSummary[] = [];
    for (let startAt = 0; ; startAt += PAGE) {
      const page = await this.request<{
        values: { id: number; name: string; type: string; location?: { projectKey?: string } }[];
        isLast: boolean;
      }>("GET", `/rest/agile/1.0/board?startAt=${startAt}&maxResults=${PAGE}`);
      for (const b of page.values) {
        const s: JiraBoardSummary = { id: b.id, name: b.name, type: b.type };
        if (b.location?.projectKey) s.projectKey = b.location.projectKey;
        out.push(s);
      }
      if (page.isLast || page.values.length === 0) return out;
    }
  }

  async boardConfiguration(boardId: number): Promise<JiraBoardColumnConfig> {
    const cfg = await this.request<{
      columnConfig: { columns: { name: string; statuses: { id: string }[] }[] };
    }>("GET", `/rest/agile/1.0/board/${boardId}/configuration`);
    return cfg.columnConfig.columns.map((c) => ({ name: c.name, statusIds: c.statuses.map((s) => s.id) }));
  }

  // The board's project key lives on the board itself, not its configuration.
  async boardProjectKey(boardId: number): Promise<string | undefined> {
    const board = await this.request<{ location?: { projectKey?: string } }>(
      "GET",
      `/rest/agile/1.0/board/${boardId}`,
    );
    return board.location?.projectKey;
  }

  // Every status the project's workflows can produce — the merge/launch pickers' list.
  // De-duplicated across issue types: the same status appears once per workflow it is in.
  async projectStatuses(projectKey: string): Promise<JiraStatusSummary[]> {
    const perType = await this.request<
      { statuses: { id: string; name: string; statusCategory: { key: string } }[] }[]
    >("GET", `/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`);
    const seen = new Map<string, JiraStatusSummary>();
    for (const t of perType)
      for (const s of t.statuses)
        if (!seen.has(s.id)) seen.set(s.id, { id: s.id, name: s.name, categoryKey: s.statusCategory.key });
    return [...seen.values()];
  }

  // ── issues ───────────────────────────────────────────────────────────────────

  // Both issue fetches take the site's start-date custom field id when the caller resolved
  // one (see pickStartDateFieldId in jira-map.ts): the id is per-site, so it travels as an
  // argument instead of joining the module const that keeps the payload predictable.

  // Every field the site defines, id and schema. Read to locate «Start date», whose id is
  // a per-site customfield_NNNNN — the whole reason this endpoint is called at all.
  listFields(): Promise<JiraFieldSummary[]> {
    return this.request("GET", "/rest/api/3/field");
  }

  // Token-paginated search. `fields` bounded to the standard set (plus the start date when
  // there is one), `renderedFields` for the description HTML. Loops until Jira stops
  // handing out a nextPageToken.
  async searchIssues(jql: string, startDateFieldId?: string): Promise<JiraRawIssue[]> {
    const out: JiraRawIssue[] = [];
    let nextPageToken: string | undefined;
    do {
      const page = await this.request<{ issues?: JiraRawIssue[]; nextPageToken?: string }>(
        "POST",
        "/rest/api/3/search/jql",
        {
          jql,
          maxResults: PAGE,
          fields: startDateFieldId ? [...ISSUE_FIELDS, startDateFieldId] : ISSUE_FIELDS,
          expand: "renderedFields",
          ...(nextPageToken ? { nextPageToken } : {}),
        },
      );
      out.push(...(page.issues ?? []));
      nextPageToken = page.nextPageToken;
    } while (nextPageToken);
    return out;
  }

  // The deletion sweep's cheap half: keys only, no field payload at all.
  async searchIssueIds(jql: string): Promise<string[]> {
    const out: string[] = [];
    let nextPageToken: string | undefined;
    do {
      const page = await this.request<{ issues?: { id: string }[]; nextPageToken?: string }>(
        "POST",
        "/rest/api/3/search/jql",
        { jql, maxResults: 200, fields: ["id"], ...(nextPageToken ? { nextPageToken } : {}) },
      );
      out.push(...(page.issues ?? []).map((i) => i.id));
      nextPageToken = page.nextPageToken;
    } while (nextPageToken);
    return out;
  }

  getIssue(key: string, startDateFieldId?: string): Promise<JiraRawIssue> {
    return this.request(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS.join(",")}${startDateFieldId ? `,${startDateFieldId}` : ""}&expand=renderedFields`,
    );
  }

  // The raw ADF description alone — the editor's starting text is read from this tree
  // rather than from renderedFields, whose HTML is a lossy, simplified rendering of it.
  async issueDescription(key: string): Promise<unknown> {
    const res = await this.request<{ fields?: { description?: unknown } }>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=description`,
    );
    return res.fields?.description;
  }

  createIssue(fields: Record<string, unknown>): Promise<{ id: string; key: string }> {
    return this.request("POST", "/rest/api/3/issue", { fields });
  }

  // `update` is Jira's verb form (`labels: [{ add: "x" }]`), which the assistant uses to add
  // or remove one label without restating — and so racing — the whole list.
  editIssue(key: string, fields: Record<string, unknown>, update?: Record<string, unknown>): Promise<void> {
    return this.request("PUT", `/rest/api/3/issue/${encodeURIComponent(key)}`, { fields, ...(update ? { update } : {}) });
  }

  // The links of one issue alone — how the link tool reads back which direction Jira stored.
  async issueLinks(key: string): Promise<JiraRawIssueLink[]> {
    const res = await this.request<{ fields?: { issuelinks?: JiraRawIssueLink[] } }>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=issuelinks`,
    );
    return res.fields?.issuelinks ?? [];
  }

  deleteIssue(key: string): Promise<void> {
    // deleteSubtasks: a parent with subtasks is otherwise a 400, and the UI's confirm
    // dialog already warned about exactly that.
    return this.request("DELETE", `/rest/api/3/issue/${encodeURIComponent(key)}?deleteSubtasks=true`);
  }

  // ── transitions ──────────────────────────────────────────────────────────────

  async listTransitions(key: string): Promise<JiraTransition[]> {
    const res = await this.request<{ transitions: JiraTransition[] }>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    );
    return res.transitions;
  }

  // `extra` is what a transition screen may ask for on the way (a resolution, a comment):
  // Jira refuses a transition whose screen requires a field the request did not carry, so
  // the assistant's tools pass them through. The board's own drag sends none.
  transition(
    key: string,
    transitionId: string,
    extra: { fields?: Record<string, unknown>; comment?: Record<string, unknown> } = {},
  ): Promise<void> {
    return this.request("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      transition: { id: transitionId },
      ...(extra.fields ? { fields: extra.fields } : {}),
      ...(extra.comment ? { update: { comment: [{ add: { body: extra.comment } }] } } : {}),
    });
  }

  // ── comments & worklogs ──────────────────────────────────────────────────────

  // `renderedBody` beside each ADF body: HTML Jira rendered, which is what the mirror
  // stores and the dialog shows.
  async listComments(key: string): Promise<JiraRawComment[]> {
    const out: JiraRawComment[] = [];
    for (let startAt = 0; ; startAt += PAGE) {
      const page = await this.request<{ comments: JiraRawComment[]; total: number }>(
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=${PAGE}&expand=renderedBody`,
      );
      out.push(...page.comments);
      if (startAt + PAGE >= page.total) return out;
    }
  }

  // v3 comments are ADF documents; the service builds one from the composer's markdown
  // (adfDoc, jira-adf.ts).
  addComment(key: string, body: Record<string, unknown>): Promise<{ id: string }> {
    return this.request("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body });
  }

  async listWorklogs(key: string): Promise<JiraRawWorklog[]> {
    const out: JiraRawWorklog[] = [];
    for (let startAt = 0; ; startAt += PAGE) {
      const page = await this.request<{ worklogs: JiraRawWorklog[]; total: number }>(
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(key)}/worklog?startAt=${startAt}&maxResults=${PAGE}`,
      );
      out.push(...page.worklogs);
      if (startAt + PAGE >= page.total) return out;
    }
  }

  // The one place the three endpoints' adjustment vocabularies are spelled out.
  // `manualParam` is the name THIS endpoint gives a relative move, or undefined where it
  // offers none — and then a `manual` mode is a caller bug, not something to forward.
  private worklogQuery(adjust: JiraWorklogAdjust, manualParam?: "reduceBy" | "increaseBy"): string {
    const params = new URLSearchParams({ adjustEstimate: adjust.mode });
    if (adjust.mode === "new") params.set("newEstimate", adjust.value);
    if (adjust.mode === "manual") {
      if (!manualParam) throw new Error("this worklog endpoint has no relative estimate adjustment");
      params.set(manualParam, adjust.value);
    }
    return params.toString();
  }

  // The write half of «Log work». Returns the created worklog's id; the caller's own
  // refresh is what puts the entry and the moved counters into the mirror.
  addWorklog(key: string, input: JiraWorklogWrite): Promise<{ id: string }> {
    return this.request(
      "POST",
      `/rest/api/3/issue/${encodeURIComponent(key)}/worklog?${this.worklogQuery(input.adjust, "reduceBy")}`,
      {
        timeSpent: input.timeSpent,
        started: input.started,
        ...(input.comment ? { comment: input.comment } : {}),
      },
    );
  }

  // Editing an existing entry. Jira's update has NO relative adjustment (see the type's
  // note), so `manual` never reaches here — the service normalises it away.
  updateWorklog(key: string, worklogId: string, input: JiraWorklogWrite): Promise<{ id: string }> {
    return this.request(
      "PUT",
      `/rest/api/3/issue/${encodeURIComponent(key)}/worklog/${encodeURIComponent(worklogId)}?${this.worklogQuery(input.adjust)}`,
      {
        timeSpent: input.timeSpent,
        started: input.started,
        // Always sent: Jira leaves an omitted comment ALONE, so clearing a note would be
        // impossible, and an emptied note is a legitimate edit. adfDoc("") is Jira's own
        // spelling of «no body».
        comment: input.comment ?? { type: "doc", version: 1, content: [] },
      },
    );
  }

  // Removing an entry gives its time back, so Jira spells this endpoint's relative move
  // `increaseBy`. 204, nothing to parse.
  deleteWorklog(key: string, worklogId: string, adjust: JiraWorklogAdjust): Promise<void> {
    return this.request(
      "DELETE",
      `/rest/api/3/issue/${encodeURIComponent(key)}/worklog/${encodeURIComponent(worklogId)}?${this.worklogQuery(adjust, "increaseBy")}`,
    );
  }

  // Which of the named permissions this token actually holds in this project — Jira's own
  // answer to «may I touch that worklog», rather than a guess from who wrote it. The
  // endpoint REQUIRES the permissions list (an unknown key is a 400), so the caller names
  // exactly the keys it will read back.
  async myPermissions(projectKey: string, permissions: readonly string[]): Promise<Record<string, boolean>> {
    const res = await this.request<{ permissions?: Record<string, { havePermission?: boolean }> }>(
      "GET",
      `/rest/api/3/mypermissions?projectKey=${encodeURIComponent(projectKey)}&permissions=${permissions.map(encodeURIComponent).join(",")}`,
    );
    const out: Record<string, boolean> = {};
    for (const key of permissions) out[key] = res.permissions?.[key]?.havePermission === true;
    return out;
  }

  // ── attachments ──────────────────────────────────────────────────────────────

  async uploadAttachment(key: string, filename: string, data: Buffer, mime: string): Promise<void> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)], { type: mime || "application/octet-stream" }), filename);
    const res = await fetch(`${this.base}/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, {
      method: "POST",
      // no-check: Jira refuses multipart without the XSRF opt-out header.
      headers: { Authorization: this.authHeader, "X-Atlassian-Token": "no-check" },
      body: form,
    });
    if (!res.ok) {
      const parsed: unknown = await res.json().catch(() => undefined);
      throw new JiraHttpError(res.status, flattenJiraError(res.status, parsed));
    }
  }

  // A streamed proxy hand-off: the controller pipes this body to the UI, so the file
  // never lands on disk and the browser never needs Jira credentials.
  async downloadAttachment(attachmentId: string): Promise<{ body: ReadableStream<Uint8Array>; contentType: string }> {
    const res = await fetch(`${this.base}/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`, {
      headers: { Authorization: this.authHeader },
      redirect: "follow",
    });
    if (!res.ok || !res.body) {
      const parsed: unknown = await res.json().catch(() => undefined);
      throw new JiraHttpError(res.status, flattenJiraError(res.status, parsed));
    }
    return { body: res.body, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  // ── create/edit vocabularies ─────────────────────────────────────────────────

  async projectIssueTypes(projectKey: string): Promise<{ id: string; name: string; subtask: boolean }[]> {
    const project = await this.request<{ issueTypes?: { id: string; name: string; subtask: boolean }[] }>(
      "GET",
      `/rest/api/3/project/${encodeURIComponent(projectKey)}`,
    );
    return project.issueTypes ?? [];
  }

  listPriorities(): Promise<{ id: string; name: string }[]> {
    return this.request("GET", "/rest/api/3/priority");
  }

  // Who an issue in this project may be assigned to — the assignee picker's list.
  assignableUsers(
    projectKey: string,
    query: string,
  ): Promise<{ accountId: string; displayName: string; avatarUrls?: Record<string, string> }[]> {
    const q = query ? `&query=${encodeURIComponent(query)}` : "";
    return this.request(
      "GET",
      `/rest/api/3/user/assignable/search?project=${encodeURIComponent(projectKey)}&maxResults=${PAGE}${q}`,
    );
  }

  // ── the Менеджмент assistant's tools ────────────────────────────────────────
  //
  // Everything below exists for apps/api/src/jira/jira-tools.service.ts: the live Jira surface
  // the chat assistant reads and writes through, at parity with the public Jira MCP servers.
  // Payloads are returned close to Jira's own shape — the tool layer decides what the model
  // is shown, and a second tolerant mapping here would only hide fields from it.

  // One page of a JQL search. Unlike `searchIssues` (the sync loop, which drains every page
  // with a fixed field set), the caller names the fields and holds the cursor: an assistant
  // asking «what is open in this sprint» wants the first page now, not the whole project.
  // `names` maps each returned field id to its display name, so a custom field reads as
  // «Story Points» and not as customfield_10016.
  searchPage(input: {
    jql: string;
    fields: string[];
    maxResults: number;
    nextPageToken?: string;
  }): Promise<{ issues?: JiraRawIssue[]; nextPageToken?: string; names?: Record<string, string> }> {
    return this.request("POST", "/rest/api/3/search/jql", {
      jql: input.jql,
      fields: input.fields,
      maxResults: input.maxResults,
      expand: "names",
      ...(input.nextPageToken ? { nextPageToken: input.nextPageToken } : {}),
    });
  }

  // An issue with every field the site defines (`*all`) and their display names. The sync's
  // `getIssue` asks for the mirror's fixed subset; this is the whole picture — links,
  // subtasks, components, versions, sprint, every custom field.
  issueFull(key: string): Promise<JiraRawIssue & { names?: Record<string, string> }> {
    return this.request("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=*all&expand=names`);
  }

  // The history, oldest first, capped: a ticket with thousands of edits is a log nobody
  // reads to the end, and the caller keeps only the tail anyway.
  async issueChangelog(key: string, cap = 500): Promise<JiraRawChange[]> {
    const out: JiraRawChange[] = [];
    for (let startAt = 0; out.length < cap; startAt += 100) {
      const page = await this.request<{ values?: JiraRawChange[]; isLast?: boolean; total?: number }>(
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(key)}/changelog?startAt=${startAt}&maxResults=100`,
      );
      const values = page.values ?? [];
      out.push(...values);
      if (page.isLast !== false || values.length === 0) break;
    }
    return out;
  }

  remoteLinks(key: string): Promise<{ id: number; relationship?: string; object?: { url?: string; title?: string } }[]> {
    return this.request("GET", `/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`);
  }

  addRemoteLink(key: string, link: { url: string; title: string }): Promise<{ id: number }> {
    return this.request("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`, { object: link });
  }

  async watchers(key: string): Promise<{ accountId: string; displayName?: string }[]> {
    const res = await this.request<{ watchers?: { accountId: string; displayName?: string }[] }>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(key)}/watchers`,
    );
    return res.watchers ?? [];
  }

  // Jira takes the bare accountId as a JSON STRING body — `request` stringifies it into
  // exactly that.
  addWatcher(key: string, accountId: string): Promise<void> {
    return this.request("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/watchers`, accountId);
  }

  removeWatcher(key: string, accountId: string): Promise<void> {
    return this.request(
      "DELETE",
      `/rest/api/3/issue/${encodeURIComponent(key)}/watchers?accountId=${encodeURIComponent(accountId)}`,
    );
  }

  async searchProjects(query: string): Promise<JiraProjectSummary[]> {
    const out: JiraProjectSummary[] = [];
    const q = query ? `&query=${encodeURIComponent(query)}` : "";
    for (let startAt = 0; out.length < 500; startAt += PAGE) {
      const page = await this.request<{ values?: JiraProjectSummary[]; isLast?: boolean }>(
        "GET",
        `/rest/api/3/project/search?startAt=${startAt}&maxResults=${PAGE}${q}`,
      );
      const values = page.values ?? [];
      out.push(...values);
      if (page.isLast !== false || values.length === 0) break;
    }
    return out;
  }

  project(projectKey: string): Promise<JiraProjectSummary> {
    return this.request("GET", `/rest/api/3/project/${encodeURIComponent(projectKey)}`);
  }

  // The issue types a CREATE in this project may use — createmeta rather than the project's
  // `issueTypes`, because createmeta is what POST /issue is judged against, and it carries
  // `hierarchyLevel`, which is how a parent/child pairing is chosen right (-1 sub-task,
  // 0 standard, 1 epic).
  async createMetaIssueTypes(projectKey: string): Promise<JiraCreateMetaIssueType[]> {
    const res = await this.request<{ issueTypes?: JiraCreateMetaIssueType[]; values?: JiraCreateMetaIssueType[] }>(
      "GET",
      `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes?maxResults=200`,
    );
    return res.issueTypes ?? res.values ?? [];
  }

  // The create screen of one issue type: which fields exist, which are REQUIRED, and the
  // allowed values of each — the answer to «Field X is required» before Jira has to say it.
  async createMetaFields(projectKey: string, issueTypeId: string): Promise<JiraFieldMeta[]> {
    const out: JiraFieldMeta[] = [];
    for (let startAt = 0; ; startAt += 200) {
      const page = await this.request<{ fields?: JiraFieldMeta[]; results?: JiraFieldMeta[]; total?: number }>(
        "GET",
        `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(issueTypeId)}?startAt=${startAt}&maxResults=200`,
      );
      const values = page.fields ?? page.results ?? [];
      out.push(...values);
      if (values.length < 200 || (page.total !== undefined && out.length >= page.total)) return out;
    }
  }

  // The edit screen of one existing issue — what an update may touch, keyed by field id.
  async editMeta(key: string): Promise<Record<string, Omit<JiraFieldMeta, "fieldId">>> {
    const res = await this.request<{ fields?: Record<string, Omit<JiraFieldMeta, "fieldId">> }>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(key)}/editmeta`,
    );
    return res.fields ?? {};
  }

  // Any user the token may see — watchers and «who is X» questions. Assignment keeps using
  // `assignableUsers`, which is the narrower set Jira will actually accept as an assignee.
  searchUsers(query: string): Promise<JiraUserSummary[]> {
    return this.request("GET", `/rest/api/3/user/search?query=${encodeURIComponent(query)}&maxResults=${PAGE}`);
  }

  async issueLinkTypes(): Promise<{ id: string; name: string; inward: string; outward: string }[]> {
    const res = await this.request<{ issueLinkTypes?: { id: string; name: string; inward: string; outward: string }[] }>(
      "GET",
      "/rest/api/3/issueLinkType",
    );
    return res.issueLinkTypes ?? [];
  }

  // 201 with an empty body; the link's id is only learnable by reading an issue back.
  createIssueLink(input: {
    typeName: string;
    inwardKey: string;
    outwardKey: string;
    comment?: Record<string, unknown>;
  }): Promise<void> {
    return this.request("POST", "/rest/api/3/issueLink", {
      type: { name: input.typeName },
      inwardIssue: { key: input.inwardKey },
      outwardIssue: { key: input.outwardKey },
      ...(input.comment ? { comment: { body: input.comment } } : {}),
    });
  }

  deleteIssueLink(linkId: string): Promise<void> {
    return this.request("DELETE", `/rest/api/3/issueLink/${encodeURIComponent(linkId)}`);
  }

  updateComment(key: string, commentId: string, body: Record<string, unknown>): Promise<{ id: string }> {
    return this.request(
      "PUT",
      `/rest/api/3/issue/${encodeURIComponent(key)}/comment/${encodeURIComponent(commentId)}`,
      { body },
    );
  }

  deleteComment(key: string, commentId: string): Promise<void> {
    return this.request("DELETE", `/rest/api/3/issue/${encodeURIComponent(key)}/comment/${encodeURIComponent(commentId)}`);
  }

  async attachmentMeta(attachmentId: string): Promise<{ filename?: string; mimeType?: string; size?: number }> {
    return this.request("GET", `/rest/api/3/attachment/${encodeURIComponent(attachmentId)}`);
  }

  // ── agile: sprints and backlog ───────────────────────────────────────────────

  async boardSprints(boardId: number, state?: string): Promise<JiraSprint[]> {
    const out: JiraSprint[] = [];
    const s = state ? `&state=${encodeURIComponent(state)}` : "";
    for (let startAt = 0; ; startAt += PAGE) {
      const page = await this.request<{ values?: JiraSprint[]; isLast?: boolean }>(
        "GET",
        `/rest/agile/1.0/board/${boardId}/sprint?startAt=${startAt}&maxResults=${PAGE}${s}`,
      );
      const values = page.values ?? [];
      out.push(...values);
      if (page.isLast !== false || values.length === 0) return out;
    }
  }

  createSprint(input: { boardId: number; name: string; startDate?: string; endDate?: string; goal?: string }): Promise<JiraSprint> {
    const { boardId, ...rest } = input;
    return this.request("POST", "/rest/agile/1.0/sprint", { originBoardId: boardId, ...rest });
  }

  // POST is Jira's PARTIAL update of a sprint (PUT would blank every field left out).
  updateSprint(sprintId: number, patch: Partial<Omit<JiraSprint, "id">>): Promise<JiraSprint> {
    return this.request("POST", `/rest/agile/1.0/sprint/${sprintId}`, patch);
  }

  moveToSprint(sprintId: number, keys: string[]): Promise<void> {
    return this.request("POST", `/rest/agile/1.0/sprint/${sprintId}/issue`, { issues: keys });
  }

  moveToBacklog(keys: string[]): Promise<void> {
    return this.request("POST", "/rest/agile/1.0/backlog/issue", { issues: keys });
  }

  // ── versions and components ─────────────────────────────────────────────────

  projectVersions(projectKey: string): Promise<JiraVersion[]> {
    return this.request("GET", `/rest/api/3/project/${encodeURIComponent(projectKey)}/versions`);
  }

  createVersion(input: { projectId: string } & Partial<Omit<JiraVersion, "id">>): Promise<JiraVersion> {
    return this.request("POST", "/rest/api/3/version", input);
  }

  updateVersion(versionId: string, patch: Partial<Omit<JiraVersion, "id">>): Promise<JiraVersion> {
    return this.request("PUT", `/rest/api/3/version/${encodeURIComponent(versionId)}`, patch);
  }

  projectComponents(projectKey: string): Promise<{ id: string; name: string; description?: string; lead?: { displayName?: string } }[]> {
    return this.request("GET", `/rest/api/3/project/${encodeURIComponent(projectKey)}/components`);
  }
}
