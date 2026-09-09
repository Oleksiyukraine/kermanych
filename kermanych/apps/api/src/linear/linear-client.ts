// apps/api/src/linear/linear-client.ts
// The one place that speaks HTTP to Linear. A single GraphQL endpoint, authenticated per
// INSTANCE with a personal API key — a client is built per request for the acting user, so
// every write lands in Linear under that person's identity (the whole point of per-user
// keys).
//
// One host, one verb: POST https://api.linear.app/graphql with a `{ query, variables }`
// body. The key rides RAW in the Authorization header — Linear does NOT use `Bearer`, and
// prefixing it earns a 400 phrased as an authentication error.
const API_URL = "https://api.linear.app/graphql";

const PAGE = 50;

// Linear's error envelope is a top-level `errors[]` that can arrive on a 200 as readily as
// on a 4xx, so the `type`/`userPresentableMessage` extensions travel here for the service
// and controller to read. An `authentication error` is normalised to status 401 so the UI
// drops that user to read-only exactly as it does for Jira.
export class LinearHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly type?: string,
  ) {
    super(message);
  }
}

export type LinearCredentials = { apiKey: string };

export type LinearTeamSummary = { id: string; key: string; name: string };

// A team's workflow state, the raw material of a board column. `type` is Linear's own
// string ("triage"|"backlog"|"unstarted"|"started"|"completed"|"canceled"|"duplicate");
// the map layer turns it into a column order and a status category.
export type LinearStateSummary = { id: string; name: string; type: string; position: number };

export type LinearUserSummary = { id: string; name: string; displayName: string; avatarUrl: string };

export type LinearLabelSummary = { id: string; name: string };

// A comment as the inline `comments` sub-connection returns it. `body` is markdown; `user`
// is nullable (a deleted account, or an integration comment).
export type LinearRawComment = {
  id: string;
  body?: string | null;
  user?: { id?: string; name?: string; avatarUrl?: string } | null;
  createdAt: string;
  updatedAt: string;
};

// An attachment as the inline `attachments` sub-connection returns it — a read-only link,
// never an upload.
export type LinearRawAttachment = {
  id: string;
  title?: string | null;
  subtitle?: string | null;
  url?: string | null;
  createdAt: string;
};

// Raw issue as the sync engine consumes it. Typed loosely on purpose — linear-map.ts is
// the tolerant boundary that turns this into a mirror row. Children ride INLINE: no extra
// request per issue, unlike Jira's separate comment/worklog fetches.
export type LinearRawIssue = {
  id: string;
  identifier: string;
  title?: string | null;
  description?: string | null;
  priority?: number | null;
  priorityLabel?: string | null;
  estimate?: number | null;
  url?: string | null;
  createdAt?: string | null;
  updatedAt: string;
  dueDate?: string | null;
  startedAt?: string | null;
  sortOrder?: number | null;
  parent?: { identifier?: string } | null;
  assignee?: { id?: string; name?: string; displayName?: string; avatarUrl?: string } | null;
  state?: { id?: string; name?: string; type?: string } | null;
  labels?: { nodes?: { id?: string; name?: string; color?: string }[] } | null;
  comments?: { nodes?: LinearRawComment[] } | null;
  attachments?: { nodes?: LinearRawAttachment[] } | null;
};

// The fields every issue fetch names — the standard set the mirror displays plus the two
// inline child connections. Bounded on purpose: an issue query naming everything would be
// both slower and a moving target as Linear adds fields.
const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  priorityLabel
  estimate
  url
  createdAt
  updatedAt
  dueDate
  startedAt
  sortOrder
  parent { identifier }
  assignee { id name displayName avatarUrl }
  state { id name type }
  labels { nodes { id name color } }
  comments(first: ${PAGE}) { nodes { id body user { id name avatarUrl } createdAt updatedAt } }
  attachments(first: ${PAGE}) { nodes { id title subtitle url createdAt } }
`;

export class LinearClient {
  private readonly apiKey: string;

  constructor(creds: LinearCredentials) {
    this.apiKey = creds.apiKey;
  }

  // The one method that touches the network. A non-2xx OR a present `errors[]` — even on a
  // 200 — is a failure; the first error's `userPresentableMessage` is the human sentence,
  // its `type` decides whether this is the read-only-triggering authentication case.
  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(variables ? { query, variables } : { query }),
    });
    const parsed = (await res.json().catch(() => undefined)) as
      | {
          data?: T;
          errors?: { message?: string; extensions?: { type?: string; userPresentableMessage?: string } }[];
        }
      | undefined;
    if (!res.ok || (parsed?.errors && parsed.errors.length > 0)) {
      const first = parsed?.errors?.[0];
      const type = first?.extensions?.type;
      const message =
        first?.extensions?.userPresentableMessage ?? first?.message ?? `Linear responded ${res.status}`;
      const status = type === "authentication error" ? 401 : res.status;
      throw new LinearHttpError(status, message, type);
    }
    return parsed!.data as T;
  }

  // ── identity ─────────────────────────────────────────────────────────────────

  // The key validator: the viewer proves the key works, the organization gives the urlKey
  // the token table and the integration are keyed by. A 401 here is «ключ не працює».
  async identity(): Promise<{ viewerId: string; viewerName: string; orgUrlKey: string; orgName: string }> {
    const data = await this.graphql<{
      viewer: { id: string; name: string; email?: string; displayName?: string };
      organization: { id: string; name: string; urlKey: string };
    }>(`query { viewer { id name email displayName } organization { id name urlKey } }`);
    return {
      viewerId: data.viewer.id,
      viewerName: data.viewer.displayName || data.viewer.name,
      orgUrlKey: data.organization.urlKey,
      orgName: data.organization.name,
    };
  }

  // ── teams (boards) ─────────────────────────────────────────────────────────────

  // A Linear team IS the board. Paginated the connection way: loop until `hasNextPage`
  // stops.
  async listTeams(): Promise<LinearTeamSummary[]> {
    const out: LinearTeamSummary[] = [];
    let after: string | undefined;
    do {
      const data = await this.graphql<{
        teams: {
          nodes: { id: string; key: string; name: string }[];
          pageInfo: { hasNextPage: boolean; endCursor: string };
        };
      }>(
        `query($after: String) {
          teams(first: ${PAGE}, after: $after) {
            nodes { id key name }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { after },
      );
      for (const t of data.teams.nodes) out.push({ id: t.id, key: t.key, name: t.name });
      after = data.teams.pageInfo.hasNextPage ? data.teams.pageInfo.endCursor : undefined;
    } while (after);
    return out;
  }

  // The team's workflow states — the board's columns. One team has few states, so no
  // pagination: the connection's default page holds the whole workflow.
  async teamStates(teamId: string): Promise<LinearStateSummary[]> {
    const data = await this.graphql<{
      team: { states: { nodes: { id: string; name: string; type: string; position: number }[] } } | null;
    }>(`query($id: String!) { team(id: $id) { states { nodes { id name type position color } } } }`, {
      id: teamId,
    });
    return (data.team?.states.nodes ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      position: s.position,
    }));
  }

  // The assignee picker's list — the team's members. Filtered by the service, not the
  // query: Linear's members connection has no substring argument the way Jira's search
  // does.
  async teamMembers(teamId: string): Promise<LinearUserSummary[]> {
    const data = await this.graphql<{
      team: {
        members: { nodes: { id: string; name: string; displayName?: string; avatarUrl?: string }[] };
      } | null;
    }>(`query($id: String!) { team(id: $id) { members { nodes { id name displayName avatarUrl } } } }`, {
      id: teamId,
    });
    return (data.team?.members.nodes ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      displayName: m.displayName ?? "",
      avatarUrl: m.avatarUrl ?? "",
    }));
  }

  // The label vocabulary. Names travel in the mirror; ids are resolved from this list at
  // write time, so the editor stores what a human reads and the mutation sends what Linear
  // needs.
  async teamLabels(teamId: string): Promise<LinearLabelSummary[]> {
    const data = await this.graphql<{
      team: { labels: { nodes: { id: string; name: string }[] } } | null;
    }>(`query($id: String!) { team(id: $id) { labels { nodes { id name } } } }`, { id: teamId });
    return (data.team?.labels.nodes ?? []).map((l) => ({ id: l.id, name: l.name }));
  }

  // ── issues ───────────────────────────────────────────────────────────────────

  // The sync search. A full sweep omits the `updatedAt` filter; an incremental poll names
  // the cursor and Linear returns only what moved since. Ordered by updatedAt and looped
  // until the connection stops paging — the same idempotence Jira's token pagination has.
  async searchIssues(teamId: string, sinceIso?: string): Promise<LinearRawIssue[]> {
    const out: LinearRawIssue[] = [];
    let after: string | undefined;
    do {
      const data = await this.graphql<{
        issues: { nodes: LinearRawIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string } };
      }>(
        `query($filter: IssueFilter, $after: String) {
          issues(filter: $filter, first: ${PAGE}, after: $after, orderBy: updatedAt) {
            nodes { ${ISSUE_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        {
          filter: {
            team: { id: { eq: teamId } },
            ...(sinceIso ? { updatedAt: { gt: sinceIso } } : {}),
          },
          after,
        },
      );
      out.push(...data.issues.nodes);
      after = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : undefined;
    } while (after);
    return out;
  }

  // One issue by its identifier ("ENG-42") — Linear accepts it wherever a uuid goes, so the
  // identifier is the action key everywhere, exactly as Jira uses its own key.
  async getIssue(key: string): Promise<LinearRawIssue> {
    const data = await this.graphql<{ issue: LinearRawIssue | null }>(
      `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
      { id: key },
    );
    if (!data.issue) throw new LinearHttpError(404, `issue ${key} not found`);
    return data.issue;
  }

  // Typed loosely, like Jira's `fields`: the service builds the input map (issueFields) so
  // the shape lives beside the other write-side decisions.
  async createIssue(input: Record<string, unknown>): Promise<{ id: string; identifier: string }> {
    const data = await this.graphql<{
      issueCreate: { success: boolean; issue: { id: string; identifier: string } | null };
    }>(`mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }`, {
      input,
    });
    if (!data.issueCreate.success || !data.issueCreate.issue) throw new LinearHttpError(400, "issue create failed");
    return { id: data.issueCreate.issue.id, identifier: data.issueCreate.issue.identifier };
  }

  // Edit and drag-to-column are the same call: a state move is `issueUpdate(id, {stateId})`.
  async updateIssue(key: string, input: Record<string, unknown>): Promise<void> {
    const data = await this.graphql<{ issueUpdate: { success: boolean } }>(
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id: key, input },
    );
    if (!data.issueUpdate.success) throw new LinearHttpError(400, "issue update failed");
  }

  // A soft trash — Linear's delete archives the issue, which the UI's confirm dialog already
  // describes.
  async deleteIssue(key: string): Promise<void> {
    const data = await this.graphql<{ issueDelete: { success: boolean } }>(
      `mutation($id: String!) { issueDelete(id: $id) { success } }`,
      { id: key },
    );
    if (!data.issueDelete.success) throw new LinearHttpError(400, "issue delete failed");
  }

  // The composer sends markdown; Linear stores it as-is (no ADF, unlike Jira). `issueId`
  // takes the identifier the same way every other id arg does.
  async addComment(key: string, body: string): Promise<{ id: string }> {
    const data = await this.graphql<{
      commentCreate: { success: boolean; comment: { id: string } | null };
    }>(`mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`, {
      input: { issueId: key, body },
    });
    if (!data.commentCreate.success || !data.commentCreate.comment)
      throw new LinearHttpError(400, "comment create failed");
    return { id: data.commentCreate.comment.id };
  }
}
