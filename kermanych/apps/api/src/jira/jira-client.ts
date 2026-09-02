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
// client always asks for the renderedBody expand.
export type JiraRawComment = {
  id: string;
  author?: { displayName?: string; avatarUrls?: Record<string, string> };
  renderedBody?: string;
  created: string;
  updated: string;
};

export type JiraRawWorklog = {
  id: string;
  author?: { displayName?: string; avatarUrls?: Record<string, string> };
  timeSpent?: string;
  timeSpentSeconds?: number;
  started: string;
  comment?: unknown;
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

  // Token-paginated search. `fields` bounded to ISSUE_FIELDS, `renderedFields` for the
  // description HTML. Loops until Jira stops handing out a nextPageToken.
  async searchIssues(jql: string): Promise<JiraRawIssue[]> {
    const out: JiraRawIssue[] = [];
    let nextPageToken: string | undefined;
    do {
      const page = await this.request<{ issues?: JiraRawIssue[]; nextPageToken?: string }>(
        "POST",
        "/rest/api/3/search/jql",
        {
          jql,
          maxResults: PAGE,
          fields: ISSUE_FIELDS,
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

  getIssue(key: string): Promise<JiraRawIssue> {
    return this.request(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS.join(",")}&expand=renderedFields`,
    );
  }

  createIssue(fields: Record<string, unknown>): Promise<{ id: string; key: string }> {
    return this.request("POST", "/rest/api/3/issue", { fields });
  }

  editIssue(key: string, fields: Record<string, unknown>): Promise<void> {
    return this.request("PUT", `/rest/api/3/issue/${encodeURIComponent(key)}`, { fields });
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

  transition(key: string, transitionId: string): Promise<void> {
    return this.request("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      transition: { id: transitionId },
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

  // v3 comments are ADF documents; the composer sends one paragraph of plain text.
  addComment(key: string, text: string): Promise<{ id: string }> {
    return this.request("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      body: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
    });
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
}
