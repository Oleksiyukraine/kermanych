// apps/api/src/plane/plane-tools.service.ts
// The Менеджмент assistant's live Plane surface — the twin of jira/jira-tools.service.ts,
// served beside the jira_* tools on the same MCP endpoint (management-mcp.service.ts): search,
// read a work item whole, the project's vocabularies (states, labels, members, estimate
// points), create, update, move, comment, log time, link, attach, delete — and plan with
// cycles and modules, Plane's own answer to Jira's sprints and versions/components.
//
// Why tools and not the action blocks the rest of the chat uses: the Jira tools' reason. Each
// call answers the model at once, with Plane's own refusal, so it can fix the field and retry
// inside the same turn, and a series is filed one work item at a time with each new key in
// hand.
//
// Every call runs under the ACTING operator's own Plane API key (PlaneService.clientFor),
// exactly as the board's own buttons do, and reaches ONLY the projects the workspace
// connected: a key from any other project is refused, not guessed at. A write is followed by
// a best-effort mirror step (PlaneService.mirrorWrite) so «Дошка» shows it before the next
// poll; a mirror that fails is REPORTED beside the write and never turns a write Plane accepted
// into an error — the key the model was handed must stay true. Links, cycles and modules are
// not mirrored, so their writes have nothing to refresh (Jira's links, sprints and versions
// neither).
//
// Plane's budget shapes the reads: 60 requests a minute per key, shared with the board's own
// sync. The vocabularies come from PlaneService's ten-minute cache, plane_search filters the
// board mirror instead of paging Plane, and plane_get_issue reads worklogs and the activity
// log only when asked.
import { Injectable } from "@nestjs/common";
import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderTicketDescription, validateNewTicket, type NoticeCode } from "@kermanych/core";
import type { PlaneIntegration, PlaneIssue } from "@kermanych/cloud";
import {
  DOWNLOAD_MAX_BYTES,
  TICKET_SCHEMA,
  ToolError,
  bool,
  compact,
  int,
  optBool,
  optInt,
  optList,
  optText,
  reqText,
  schema,
  str,
  strs,
  type ManagementToolDescriptor,
  type ManagementToolScope,
  type ToolArgs as Args,
} from "../management/tracker-tools";
import { PlaneService, type PlaneIssueDraft, type PlanePriority } from "./plane.service";
import {
  PlaneHttpError,
  normalizePlaneSite,
  planeIssueUrl,
  type PlaneClient,
  type PlaneRawIssue,
  type PlaneState,
  type PlaneUserLite,
} from "./plane-client";
import { markdownToPlaneHtml, planeHtmlToMarkdown } from "./plane-html";
import { buildColumns, formatMinutes, parseDurationToMinutes, personName, toPlaneDate } from "./plane-map";

type Tool = ManagementToolDescriptor & { run: (c: Call, a: Args) => Promise<unknown> };

// The page a search answers with, at most: a page larger than this is a context window spent
// on one answer, and Plane's own search caps its hits at the same hundred.
const SEARCH_MAX = 100;

// How many people plane_search_users lists — the board's assignee picker's page.
const USERS_MAX = 50;

// A Plane key: the project identifier, a dash, the item's sequence number.
const KEY_RE = /^[A-Z0-9][A-Z0-9_]*-[1-9]\d*$/;

const PRIORITIES: readonly PlanePriority[] = ["urgent", "high", "medium", "low", "none"];

// Plane's state groups in board order (triage is not listed by the API).
const STATE_GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"];

const MODULE_STATUSES = ["backlog", "planned", "in-progress", "paused", "completed", "cancelled"];

// ── argument readers ─────────────────────────────────────────────────────────

function itemKey(a: Args, name = "issueKey"): string {
  const key = reqText(a, name).toUpperCase();
  if (!KEY_RE.test(key)) throw new ToolError(`${name}=${JSON.stringify(a[name])} is not a Plane work item key (e.g. WEB-42)`);
  return key;
}

function projectOf(key: string): string {
  return key.slice(0, key.lastIndexOf("-"));
}

// Keys of ONE project: a cycle or a module belongs to a single project, and so does every
// item a call puts into it.
function keyList(a: Args, name: string): string[] {
  const keys = (optList(a, name) ?? []).map((k) => k.toUpperCase());
  if (!keys.length) throw new ToolError(`${name} is required`);
  const bad = keys.find((k) => !KEY_RE.test(k));
  if (bad) throw new ToolError(`${JSON.stringify(bad)} is not a Plane work item key`);
  if (keys.length > 50) throw new ToolError("at most 50 work items per call");
  if (new Set(keys.map(projectOf)).size > 1) throw new ToolError(`${name} must all be keys of one project`);
  return keys;
}

// A calendar day, YYYY-MM-DD, by the rule the board's editor writes dates with. "" stays ""
// — on an update that clears the date.
function day(a: Args, name: string): string | undefined {
  const v = optText(a, name);
  if (v === undefined) return undefined;
  try {
    return toPlaneDate(v) ?? "";
  } catch {
    throw new ToolError(`${name}=${JSON.stringify(v)} is not a YYYY-MM-DD date ("" clears it)`);
  }
}

function pickPriority(v: string): PlanePriority {
  const p = PRIORITIES.find((x) => x === v.toLowerCase());
  if (!p) throw new ToolError(`priority must be one of ${PRIORITIES.join(", ")}`);
  return p;
}

// ── value shaping ────────────────────────────────────────────────────────────

const projectLabel = (i: PlaneIntegration) => `«${i.projectName}» (${i.projectIdentifier})`;

// The Plane workspace a project lives in — what a token is keyed by.
const workspaceOf = (i: PlaneIntegration) => `${normalizePlaneSite(i.siteUrl)}/${i.workspaceSlug}`;

function memberLine(m: PlaneUserLite): string {
  const name = personName(m);
  return `${name}${m.email && m.email !== name ? ` <${m.email}>` : ""} (${m.id})`;
}

// A relation that arrives expanded (an object) or bare (a uuid), read as the object.
function expanded<T extends object>(v: string | T | null | undefined): T | undefined {
  return v && typeof v === "object" ? v : undefined;
}

// A person who arrives as an expanded UserLite or as a bare id, by name.
function who(v: string | PlaneUserLite | null | undefined, people: ReadonlyMap<string, PlaneUserLite>): string | undefined {
  const p = typeof v === "string" ? people.get(v) : expanded(v);
  return p ? personName(p) || p.id : typeof v === "string" ? v : undefined;
}

function itemRow(i: PlaneIssue): Record<string, unknown> {
  return compact({
    key: i.key,
    summary: i.summary,
    state: i.statusName,
    category: i.statusCategory,
    priority: i.priority === "none" ? undefined : i.priority,
    assignee: i.assigneeName,
    labels: i.labels,
    parent: i.parentKey,
    estimate: i.estimate,
    start: i.startDate,
    due: i.dueDate,
    updated: i.planeUpdatedAt,
  });
}

function stateRows(states: readonly PlaneState[]): { id: string; name: string; group: string }[] {
  return buildColumns(states).map((s) => ({ id: s.stateIds[0]!, name: s.name, group: s.stateGroup }));
}

const cycleRow = (x: Record<string, unknown>) =>
  compact({
    id: x.id,
    name: x.name,
    status: x.status,
    start: x.start_date,
    end: x.end_date,
    description: x.description,
    issues: x.total_issues,
    completed: x.completed_issues,
  });

const moduleRow = (x: Record<string, unknown>) =>
  compact({
    id: x.id,
    name: x.name,
    status: x.status,
    start: x.start_date,
    target: x.target_date,
    description: x.description,
    issues: x.total_issues,
    completed: x.completed_issues,
  });

// ── the per-call context ────────────────────────────────────────────────────

type Where = { client: PlaneClient; integration: PlaneIntegration; integrations: PlaneIntegration[] };

type MirrorStep = "created" | "fields" | "children" | "deleted";

class Call {
  private cache?: PlaneIntegration[];

  constructor(
    readonly plane: PlaneService,
    readonly scope: ManagementToolScope,
  ) {}

  async connected(): Promise<PlaneIntegration[]> {
    this.cache ??= await this.plane.listIntegrations(this.scope.workspaceId);
    if (!this.cache.length)
      throw new ToolError("This workspace has no connected Plane project — the owner connects one under Менеджмент → Integrations.");
    return this.cache;
  }

  client(i: PlaneIntegration): PlaneClient {
    try {
      return this.plane.clientFor(i.siteUrl, i.workspaceSlug, this.scope.userId);
    } catch {
      throw new ToolError(
        `No personal Plane API key for ${workspaceOf(i)} on this machine — every Plane call runs under the operator's own key, added under Менеджмент → Integrations. Tell the operator; do not retry.`,
      );
    }
  }

  // The project (and so the Plane workspace and the key) a call runs against. A work item key
  // or `project` names it among the CONNECTED projects only; with neither, the workspace's one
  // project answers, and a call that only needs the Plane workspace (`anyProject`: who am I,
  // which projects exist) takes any project of it when all of them share one.
  async where(opts: { key?: string; project?: string; anyProject?: boolean }): Promise<Where> {
    const all = await this.connected();
    const list = all.map(projectLabel).join(", ");
    let integration: PlaneIntegration | undefined;
    const want = (opts.key ? projectOf(opts.key) : opts.project)?.toLowerCase();
    if (want) {
      const hits = all.filter(
        (i) => i.projectIdentifier.toLowerCase() === want || (!opts.key && i.projectName.toLowerCase() === want),
      );
      if (!hits.length)
        throw new ToolError(
          `${opts.key ?? JSON.stringify(opts.project)} is not in a connected Plane project — the plane_* tools reach only the projects this workspace connected: ${list}.`,
        );
      if (hits.length > 1)
        throw new ToolError(
          `Several connected Plane projects answer to ${JSON.stringify(opts.key ?? opts.project)}, in different Plane workspaces (${hits.map(workspaceOf).join(", ")}) — the tools cannot tell which one is meant. Tell the operator.`,
        );
      integration = hits[0]!;
    } else if (all.length === 1 || (opts.anyProject && new Set(all.map(workspaceOf)).size === 1)) integration = all[0]!;
    else throw new ToolError(`Several Plane projects are connected — name \`project\`. Connected: ${list}`);
    return { client: this.client(integration), integration, integrations: all };
  }

  // The board's mirror after a write, so «Дошка» shows it before the next poll. A failure is
  // returned as a warning: Plane has the write, and the mirror catches up on its next sync.
  async mirror(w: Where, issueId: string, step: MirrorStep): Promise<string | undefined> {
    try {
      await this.plane.mirrorWrite(w.integration, issueId, this.scope.userId, step);
      return undefined;
    } catch (err) {
      return `Written to Plane, but the board mirror was not refreshed (${(err as Error).message}); it catches up on the next sync.`;
    }
  }

  note(code: NoticeCode, params: Record<string, string>, text: string): void {
    this.scope.changed({ text, code, params });
  }
}

// ── resolvers ────────────────────────────────────────────────────────────────

// An assignee by member id, display name, full name or e-mail — resolved among the project's
// members, the only people Plane accepts as assignees. A name that fits several comes back as
// a refusal listing them, so the model asks or passes the id.
function pickMember(members: readonly PlaneUserLite[], want: string, project: string): PlaneUserLite {
  const byId = members.find((m) => m.id === want);
  if (byId) return byId;
  const lower = want.toLowerCase();
  const names = (m: PlaneUserLite) =>
    [m.display_name, [m.first_name, m.last_name].filter((p) => typeof p === "string" && p.trim()).join(" "), m.email]
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .map((v) => v.toLowerCase());
  const exact = members.filter((m) => names(m).includes(lower));
  const partial = members.filter((m) => names(m).some((n) => n.includes(lower)));
  const one = exact.length === 1 ? exact[0] : partial.length === 1 ? partial[0] : undefined;
  if (one) return one;
  const candidates = exact.length > 1 ? exact : partial;
  throw new ToolError(
    candidates.length
      ? `Several members of ${project} match ${JSON.stringify(want)}: ${candidates.slice(0, 10).map(memberLine).join(", ")} — pass the id.`
      : `Nobody among the members of ${project} matches ${JSON.stringify(want)} — a Plane assignee must be a member of the project. Use plane_search_users to look the person up.`,
  );
}

// A state by id, name, or — when exactly one state has it — group name («completed»).
function pickState(states: readonly PlaneState[], want: string, project: string): PlaneState {
  const lower = want.toLowerCase();
  const hit = states.find((s) => s.id === want) ?? states.find((s) => s.name.toLowerCase() === lower);
  if (hit) return hit;
  const inGroup = states.filter((s) => (s.group ?? "") === lower);
  if (inGroup.length === 1) return inGroup[0]!;
  throw new ToolError(
    `Project ${project} has no state ${JSON.stringify(want)}. States: ${stateRows(states).map((s) => `${s.name} (${s.group})`).join(", ")}`,
  );
}

async function pickPoint(c: Call, w: Where, want: string): Promise<string> {
  const { points } = await c.plane.estimateOf(w.integration, c.scope.userId);
  const lower = want.toLowerCase();
  const hit = points.find((p) => p.id === want) ?? points.find((p) => (p.value ?? "").toLowerCase() === lower);
  if (hit) return hit.id;
  throw new ToolError(
    points.length
      ? `Project ${w.integration.projectIdentifier} has no estimate point ${JSON.stringify(want)}. Points: ${points.map((p) => p.value).join(", ")}`
      : `Project ${w.integration.projectIdentifier} has no estimate points (no estimate set up, or this Plane edition has none).`,
  );
}

async function cycleOf(w: Where, want: string): Promise<Record<string, unknown>> {
  const cycles = await w.client.listCycles(w.integration.projectId);
  const lower = want.toLowerCase();
  const hit = cycles.find((x) => x.id === want) ?? cycles.find((x) => String(x.name ?? "").toLowerCase() === lower);
  if (hit) return hit;
  throw new ToolError(
    `Project ${w.integration.projectIdentifier} has no cycle ${JSON.stringify(want)}. Cycles: ${cycles.map((x) => String(x.name)).join(", ") || "none"}`,
  );
}

async function moduleOf(w: Where, want: string): Promise<Record<string, unknown>> {
  const modules = await w.client.listModules(w.integration.projectId);
  const lower = want.toLowerCase();
  const hit = modules.find((x) => x.id === want) ?? modules.find((x) => String(x.name ?? "").toLowerCase() === lower);
  if (hit) return hit;
  throw new ToolError(
    `Project ${w.integration.projectIdentifier} has no module ${JSON.stringify(want)}. Modules: ${modules.map((x) => String(x.name)).join(", ") || "none"}`,
  );
}

// Keys to Plane's uuids: one mirror read for the lot, one request per key the mirror has not
// seen yet.
async function issueIds(c: Call, w: Where, keys: readonly string[]): Promise<string[]> {
  const byKey = new Map((await c.plane.mirroredIssues(w.integration.id)).map((i) => [i.key, i.issueId]));
  const out: string[] = [];
  for (const k of keys) out.push(byKey.get(k) ?? (await w.client.getIssueByKey(k)).id);
  return out;
}

// The fields a create and an update share, as the draft PlaneService turns into Plane's body —
// the board editor's own rules, so a label name or a parent key means the same on both
// surfaces. Absent stays absent; on an update "" clears.
async function draftFields(c: Call, w: Where, a: Args, forCreate: boolean): Promise<{ draft: PlaneIssueDraft; changed: string[] }> {
  const draft: PlaneIssueDraft = {};
  const changed: string[] = [];
  const project = w.integration.projectIdentifier;

  const priority = optText(a, "priority");
  if (priority) {
    draft.priority = pickPriority(priority);
    changed.push("priority");
  }
  if (a.assignee !== undefined) {
    const name = a.assignee === null ? "" : optText(a, "assignee");
    if (name) draft.assigneeAccountId = pickMember(await c.plane.membersOf(w.integration, c.scope.userId), name, project).id;
    else if (!forCreate) draft.assigneeAccountId = null;
    if (name || !forCreate) changed.push("assignee");
  }
  const labels = optList(a, "labels");
  if (labels) {
    draft.labels = labels;
    changed.push("labels");
  }
  const estimate = optText(a, "estimate");
  if (estimate || (estimate !== undefined && !forCreate)) {
    draft.estimatePointId = estimate ? await pickPoint(c, w, estimate) : null;
    changed.push("estimate");
  }
  const start = day(a, "startDate");
  if (start || (start !== undefined && !forCreate)) {
    draft.startDate = start;
    changed.push("startDate");
  }
  const due = day(a, "dueDate");
  if (due || (due !== undefined && !forCreate)) {
    draft.dueDate = due;
    changed.push("dueDate");
  }
  const parent = optText(a, "parentKey");
  if (parent || (parent !== undefined && !forCreate)) {
    const key = parent!.toUpperCase();
    if (key && !KEY_RE.test(key)) throw new ToolError(`parentKey=${JSON.stringify(parent)} is not a Plane work item key`);
    if (key && projectOf(key) !== project.toUpperCase())
      throw new ToolError(`parentKey ${key} is in another project — a Plane parent must be in the same project (${project})`);
    draft.parentKey = key;
    changed.push("parent");
  }
  return { draft, changed };
}

// The operator's named files onto a work item. Each upload is its own outcome: one unreadable
// file must not lose the others, and none of them may undo the item already written.
async function upload(c: Call, w: Where, issueId: string, key: string, names: string[]): Promise<{ attached: string[]; failed: string[] }> {
  const attached: string[] = [];
  const failed: string[] = [];
  for (const name of names) {
    const f = c.scope.file(name);
    if (!f) {
      failed.push(`${name}: no file of that name in this conversation`);
      continue;
    }
    try {
      await w.client.uploadAttachment(w.integration.projectId, issueId, name, await readFile(f.path), f.mimeType);
      attached.push(name);
      c.note("plane_attachment_added", { key, name }, `Plane: до ${key} прикріплено «${name}»`);
    } catch (err) {
      failed.push(`${name}: ${(err as Error).message}`);
    }
  }
  return { attached, failed };
}

// ── the catalogue ────────────────────────────────────────────────────────────

const PROJECT = str("Connected Plane project: its identifier (e.g. WEB) or name. Optional when the workspace connected one project.");
const ISSUE_KEY = str("Work item key, e.g. WEB-42.");
const CYCLE = str("Cycle name or id (plane_list_cycles).");
const MODULE = str("Module name or id (plane_list_modules).");

// Fields create and update share — one description, so the two tools cannot drift apart.
const COMMON_WRITE_PROPS = {
  priority: str(`${PRIORITIES.join(" | ")}.`),
  assignee: str("A project member's display name, full name, e-mail or id; on update \"\" or null unassigns. Only project members can be assigned."),
  labels: strs("Label names (a name the project lacks is created). Replaces the whole list."),
  estimate: str("Estimate point value (e.g. 3, M) or id — plane_list_estimate_points; on update \"\" clears it."),
  startDate: str("YYYY-MM-DD; on update \"\" clears it."),
  dueDate: str("YYYY-MM-DD (Plane's target date); on update \"\" clears it."),
  parentKey: str("Parent work item key, in the same project; on update \"\" detaches it."),
  attachments: strs("Names of files the operator attached to this conversation, exactly as the turn lists them, to upload onto the work item."),
};

const TOOLS: Tool[] = [
  // ── read ──
  {
    name: "plane_get_myself",
    description: "The Plane account the operator's API key acts as.",
    inputSchema: schema({ project: PROJECT }),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const w = await c.where({ project: optText(a, "project"), anyProject: true });
      const me = await w.client.me();
      return compact({ id: me.id, name: personName(me), email: me.email });
    },
  },
  {
    name: "plane_list_projects",
    description:
      "Projects visible to the operator in the Plane workspace, optionally filtered by name/identifier substring. The ones connected to this Kermanych workspace — the only ones the other plane_* tools reach — are marked.",
    inputSchema: schema({ query: str("Filter by name or identifier."), project: PROJECT }),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const w = await c.where({ project: optText(a, "project"), anyProject: true });
      const q = optText(a, "query")?.toLowerCase() ?? "";
      const here = workspaceOf(w.integration);
      const connected = new Set(w.integrations.filter((i) => workspaceOf(i) === here).map((i) => i.projectId));
      return (await w.client.listProjects())
        .filter((p) => !p.archived_at && (!q || p.name.toLowerCase().includes(q) || p.identifier.toLowerCase().includes(q)))
        .map((p) => compact({ identifier: p.identifier, name: p.name, id: p.id, connected: connected.has(p.id) || undefined }));
    },
  },
  {
    name: "plane_list_states",
    description:
      "The project's states in board order, each with its group (backlog / unstarted / started / completed / cancelled). Plane has no workflow: any state can follow any other — plane_set_state moves an item.",
    inputSchema: schema({ project: PROJECT }),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const w = await c.where({ project: optText(a, "project") });
      return stateRows(await c.plane.statesOf(w.integration, c.scope.userId));
    },
  },
  {
    name: "plane_list_labels",
    description: "The project's labels. Writes take label NAMES; a name the project lacks is created on write.",
    inputSchema: schema({ project: PROJECT }),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const w = await c.where({ project: optText(a, "project") });
      return (await c.plane.labelsOf(w.integration, c.scope.userId)).map((l) => ({ id: l.id, name: l.name }));
    },
  },
  {
    name: "plane_search_users",
    description:
      "Find members of a Plane project by name or e-mail — the set a Plane assignee must come from (people outside the project cannot be assigned).",
    inputSchema: schema({ query: str("Name or e-mail fragment; empty lists every member."), project: PROJECT }),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const w = await c.where({ project: optText(a, "project") });
      const q = optText(a, "query")?.toLowerCase() ?? "";
      return (await c.plane.membersOf(w.integration, c.scope.userId))
        .filter((m) => !q || [m.display_name, m.first_name, m.last_name, m.email].some((v) => typeof v === "string" && v.toLowerCase().includes(q)))
        .slice(0, USERS_MAX)
        .map((m) => compact({ name: personName(m), id: m.id, email: m.email }));
    },
  },
  {
    name: "plane_search",
    description:
      "Find work items in the connected Plane projects — one page. `query` searches Plane live (name, identifier, or the exact sequence number); the filters narrow the board mirror (state group, state, assignee, label, priority). Without `project`, every connected project is searched. Archived and draft items are not listed.",
    inputSchema: schema({
      project: str("Connected project identifier or name; default: every connected project."),
      query: str("Text to search for (name, identifier, or the number of WEB-42)."),
      stateGroup: strs(`State groups: ${STATE_GROUPS.join(" | ")}. completed + cancelled = closed work.`),
      state: strs("State names."),
      assignee: str("Assignee name, e-mail fragment or id; \"none\" = unassigned."),
      labels: strs("Label names — an item matches when it has any of them."),
      priority: strs(`Priorities: ${PRIORITIES.join(" | ")}.`),
      limit: int(`Page size, 1–${SEARCH_MAX} (default 50).`),
    }),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const named = optText(a, "project");
      const targets = named ? [(await c.where({ project: named })).integration] : await c.connected();
      const query = optText(a, "query");
      const groups = optList(a, "stateGroup")?.map((g) => g.toLowerCase());
      const badGroup = groups?.find((g) => !STATE_GROUPS.includes(g));
      if (badGroup) throw new ToolError(`stateGroup ${JSON.stringify(badGroup)} is not one of ${STATE_GROUPS.join(", ")}`);
      const stateNames = optList(a, "state")?.map((s) => s.toLowerCase());
      const assignee = optText(a, "assignee")?.toLowerCase();
      const labels = optList(a, "labels")?.map((l) => l.toLowerCase());
      const priorities = optList(a, "priority")?.map(pickPriority);
      const limit = optInt(a, "limit", 1, SEARCH_MAX) ?? 50;
      const filtered = !!(groups?.length || stateNames?.length || assignee || labels?.length || priorities?.length);
      // Under the operator's key like every call, the mirror-only path included: an answer
      // given without one would tell the model Plane works here when the next write cannot.
      const clients = new Map(targets.map((t) => [t.id, c.client(t)]));

      // The state group is not on the mirror row; the project's states (cached) say it.
      const groupOf = new Map<string, string>();
      if (groups?.length)
        for (const t of targets) for (const s of await c.plane.statesOf(t, c.scope.userId)) groupOf.set(s.id, s.group ?? "");
      const mirrored = (await Promise.all(targets.map((t) => c.plane.mirroredIssues(t.id)))).flat();
      const matches = (i: PlaneIssue): boolean =>
        (!groups?.length || groups.includes(groupOf.get(i.statusId) ?? "")) &&
        (!stateNames?.length || stateNames.includes(i.statusName.toLowerCase())) &&
        (!assignee ||
          (assignee === "none" || assignee === "unassigned"
            ? !i.assigneeAccountId
            : i.assigneeAccountId === assignee || (i.assigneeName ?? "").toLowerCase().includes(assignee))) &&
        (!labels?.length || i.labels.some((l) => labels.includes(l.toLowerCase()))) &&
        (!priorities?.length || priorities.includes(i.priority as PlanePriority));

      let rows: Record<string, unknown>[];
      if (query) {
        // Plane's own search, once per Plane workspace, kept to the connected projects; its
        // hits are read through the mirror, where the fields the filters need live.
        const byId = new Map(mirrored.map((i) => [i.issueId, i]));
        const projectIds = new Set(targets.map((t) => t.projectId));
        rows = [];
        for (const space of [...new Set(targets.map(workspaceOf))]) {
          const inSpace = targets.filter((t) => workspaceOf(t) === space);
          const hits = await clients
            .get(inSpace[0]!.id)!
            .searchWorkItems(query, { ...(inSpace.length === 1 ? { projectId: inSpace[0]!.projectId } : {}), limit: SEARCH_MAX });
          for (const h of hits) {
            if (!projectIds.has(h.project_id)) continue;
            const m = byId.get(h.id);
            if (m ? matches(m) : !filtered) rows.push(m ? itemRow(m) : { key: `${h.project__identifier}-${h.sequence_id}`, summary: h.name, mirrored: false });
          }
        }
      } else {
        rows = mirrored
          .filter(matches)
          .sort((x, y) => (x.planeUpdatedAt < y.planeUpdatedAt ? 1 : x.planeUpdatedAt > y.planeUpdatedAt ? -1 : 0))
          .map(itemRow);
      }
      const page = rows.slice(0, limit);
      return compact({
        issues: page,
        count: page.length,
        total: rows.length,
        more: rows.length > page.length ? `${rows.length - page.length} more match — narrow the query or the filters` : undefined,
      });
    },
  },
  {
    name: "plane_get_issue",
    description:
      "One work item, whole: every field by name (state and its group, priority, assignees, labels, estimate, type, dates), description and comments as markdown, attachments, links, parent and sub-items; optionally worklogs (where the project tracks time) and the activity log. Read an item this way before changing it.",
    inputSchema: schema(
      {
        issueKey: ISSUE_KEY,
        commentLimit: int("Newest comments to include, 0–200 (default 20)."),
        worklogs: bool("Include worklogs (only on projects with time tracking)."),
        activities: bool("Include the activity log (field changes, last 100)."),
      },
      ["issueKey"],
    ),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const key = itemKey(a);
      const w = await c.where({ key });
      const pid = w.integration.projectId;
      const commentLimit = optInt(a, "commentLimit", 0, 200) ?? 20;
      const raw = await w.client.getIssueByKey(key);
      const [comments, attachments, links, mirrored, members] = await Promise.all([
        commentLimit > 0 ? w.client.listComments(pid, raw.id) : Promise.resolve([]),
        w.client.listAttachments(pid, raw.id),
        w.client.listLinks(pid, raw.id),
        c.plane.mirroredIssues(w.integration.id),
        c.plane.membersOf(w.integration, c.scope.userId),
      ]);
      const people = new Map(members.map((m) => [m.id, m]));
      const mirror = mirrored.find((i) => i.issueId === raw.id);
      const state = expanded(raw.state);
      const point = expanded(raw.estimate_point);
      const parent = expanded(raw.parent);
      const parentKey = typeof parent?.sequence_id === "number" ? `${w.integration.projectIdentifier}-${parent.sequence_id}` : undefined;
      const out: Record<string, unknown> = {
        key,
        url: planeIssueUrl(w.integration.siteUrl, w.integration.workspaceSlug, key),
        summary: raw.name,
        type: mirror?.typeName,
        state: state?.name,
        stateGroup: state?.group,
        priority: raw.priority,
        assignees: (raw.assignees ?? []).map((x) => who(x, people)).filter(Boolean),
        reporter: who(raw.created_by, people),
        labels: (raw.labels ?? []).flatMap((l) => (l && typeof l === "object" ? [l.name] : [])),
        estimate: point?.value,
        start: raw.start_date,
        due: raw.target_date,
        created: raw.created_at,
        updated: raw.updated_at,
        timeSpent: mirror?.timeSpent,
        parent: parentKey ? compact({ key: parentKey, summary: mirrored.find((i) => i.key === parentKey)?.summary }) : undefined,
        subItems: mirrored.filter((i) => i.parentKey === key).map((i) => compact({ key: i.key, summary: i.summary, state: i.statusName })),
        links: links.map((l) => compact({ id: l.id, title: l.title, url: l.url })),
        attachments: attachments
          .filter((x) => x.is_uploaded !== false)
          .map((x) =>
            compact({ id: x.id, filename: x.attributes?.name, mimeType: x.attributes?.type, size: x.attributes?.size ?? x.size, by: who(x.created_by, people) }),
          ),
        description: planeHtmlToMarkdown(raw.description_html ?? ""),
        comments:
          commentLimit > 0
            ? [...comments]
                .sort((x, y) => String(x.created_at ?? "").localeCompare(String(y.created_at ?? "")))
                .slice(-commentLimit)
                .map((x) =>
                  compact({
                    id: x.id,
                    author: who(x.actor, people),
                    created: x.created_at,
                    updated: x.updated_at !== x.created_at ? x.updated_at : undefined,
                    body: planeHtmlToMarkdown(x.comment_html ?? ""),
                  }),
                )
            : undefined,
      };
      if (optBool(a, "worklogs"))
        try {
          out.worklogs = (await w.client.listWorklogs(pid, raw.id)).map((x) =>
            compact({ id: x.id, author: who(x.logged_by ?? x.created_by, people), time: formatMinutes(x.duration ?? 0), at: x.created_at, description: x.description }),
          );
        } catch (err) {
          if (!(err instanceof PlaneHttpError) || ![402, 403, 404].includes(err.status)) throw err;
          out.worklogs = "time tracking is not available on this project (switched off, or this Plane edition/plan has no worklogs)";
        }
      if (optBool(a, "activities"))
        out.activities = (await w.client.listActivities(pid, raw.id)).slice(-100).map((x) =>
          compact({
            at: x.created_at,
            by: who(x.actor as string | PlaneUserLite | null | undefined, people),
            verb: x.verb,
            field: x.field,
            from: x.old_value,
            to: x.new_value,
            comment: x.comment,
          }),
        );
      return compact(out);
    },
  },
  {
    name: "plane_list_cycles",
    description: "The project's cycles (Plane's sprints): id, name, status, dates, progress. Archived cycles are not listed.",
    inputSchema: schema({ project: PROJECT }),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const w = await c.where({ project: optText(a, "project") });
      return (await w.client.listCycles(w.integration.projectId)).map(cycleRow);
    },
  },
  {
    name: "plane_list_modules",
    description: "The project's modules (Plane's grouping of work into features or releases — Jira's components/versions): id, name, status, dates, progress.",
    inputSchema: schema({ project: PROJECT }),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const w = await c.where({ project: optText(a, "project") });
      return (await w.client.listModules(w.integration.projectId)).map(moduleRow);
    },
  },
  {
    name: "plane_list_estimate_points",
    description: "The project's estimate type (points / categories / time) and its points — the values `estimate` accepts on create and update.",
    inputSchema: schema({ project: PROJECT }),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const w = await c.where({ project: optText(a, "project") });
      const { type, points } = await c.plane.estimateOf(w.integration, c.scope.userId);
      return points.length
        ? compact({ type, points: points.map((p) => compact({ id: p.id, value: p.value })) })
        : { points: [], note: "This project has no estimate set up (or this Plane edition has no estimates)." };
    },
  },
  {
    name: "plane_download_attachment",
    description:
      "Download one attachment of a work item (id from plane_get_issue) to a local file and return its path — then open it with the read tool (images and text both work).",
    inputSchema: schema({ issueKey: ISSUE_KEY, attachmentId: str("Attachment id.") }, ["issueKey", "attachmentId"]),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const key = itemKey(a);
      const id = reqText(a, "attachmentId");
      const w = await c.where({ key });
      const pid = w.integration.projectId;
      const [issueId] = await issueIds(c, w, [key]);
      const meta = (await w.client.listAttachments(pid, issueId!)).find((x) => x.id === id);
      if (!meta) throw new ToolError(`${key} has no attachment ${JSON.stringify(id)} — take the id from plane_get_issue`);
      const size = meta.attributes?.size ?? meta.size ?? 0;
      if (size > DOWNLOAD_MAX_BYTES)
        throw new ToolError(`attachment is ${size} bytes — larger than the ${DOWNLOAD_MAX_BYTES}-byte limit a chat turn reads`);
      const { body, contentType } = await w.client.downloadAttachment(pid, issueId!, id);
      const bytes = Buffer.from(await new Response(body).arrayBuffer());
      const filename = meta.attributes?.name ?? "file";
      const path = join(c.scope.downloadDir, `${id}-${filename.replace(/[/\\]/g, "-").replace(/^\.+/, "")}`);
      await mkdir(c.scope.downloadDir, { recursive: true });
      await writeFile(path, bytes);
      return { path, filename, mimeType: meta.attributes?.type ?? contentType, size: bytes.length };
    },
  },

  // ── write ──
  {
    name: "plane_create_issue",
    description:
      "Create one work item and return its key. For a series create the parent first and pass its returned key as `parentKey` of each child (same project). `state` is optional — the project's default state otherwise. A refusal names the field: fix it (plane_list_states / plane_list_labels / plane_search_users / plane_list_estimate_points) and retry.",
    inputSchema: schema(
      {
        project: str("Connected project identifier or name. Optional when the workspace connected one Plane project."),
        ticket: TICKET_SCHEMA,
        state: str("State name or id (plane_list_states); default: the project's default state."),
        ...COMMON_WRITE_PROPS,
      },
      ["ticket"],
    ),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const ticket = validateNewTicket(a.ticket);
      if ("error" in ticket) throw new ToolError(ticket.error.text);
      const w = await c.where({ project: optText(a, "project") });
      const { draft } = await draftFields(c, w, a, true);
      const stateName = optText(a, "state");
      const state = stateName ? pickState(await c.plane.statesOf(w.integration, c.scope.userId), stateName, w.integration.projectIdentifier) : undefined;
      if (state) draft.stateId = state.id;
      draft.summary = ticket.title;
      draft.description = renderTicketDescription(ticket);
      const created = await w.client.createIssue(w.integration.projectId, await c.plane.draftBody(w.integration, draft, c.scope.userId, true));
      const key = `${w.integration.projectIdentifier}-${created.sequence_id}`;
      c.note("plane_issue_created", { key, summary: ticket.title }, `Plane: створено ${key} — ${ticket.title}`);
      const files = await upload(c, w, created.id, key, optList(a, "attachments") ?? []);
      const warning = await c.mirror(w, created.id, files.attached.length ? "children" : "created");
      return compact({
        key,
        url: planeIssueUrl(w.integration.siteUrl, w.integration.workspaceSlug, key),
        summary: ticket.title,
        state: state?.name,
        parent: draft.parentKey,
        attached: files.attached,
        attachmentErrors: files.failed,
        warning,
      });
    },
  },
  {
    name: "plane_update_issue",
    description:
      "Change fields of an existing work item — only what you pass changes. `description` REPLACES the whole description (markdown): read the item first (plane_get_issue) and carry over what must stay. The state is not a field here — use plane_set_state.",
    inputSchema: schema(
      {
        issueKey: ISSUE_KEY,
        summary: str("New title."),
        description: str("New full description, markdown."),
        addLabels: strs("Label names to add, keeping the rest."),
        removeLabels: strs("Label names to remove, keeping the rest."),
        ...COMMON_WRITE_PROPS,
      },
      ["issueKey"],
    ),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const key = itemKey(a);
      const w = await c.where({ key });
      const { draft, changed } = await draftFields(c, w, a, false);
      const summary = optText(a, "summary");
      if (summary) {
        draft.summary = summary;
        changed.unshift("summary");
      }
      const description = optText(a, "description");
      if (description !== undefined) {
        draft.description = description;
        changed.push("description");
      }
      const add = optList(a, "addLabels") ?? [];
      const remove = optList(a, "removeLabels") ?? [];
      let raw: PlaneRawIssue | undefined;
      if (add.length || remove.length) {
        if (draft.labels) throw new ToolError("labels replaces the whole list — do not combine it with addLabels/removeLabels");
        // Plane replaces the whole label set on a PATCH, so the item's current one is read first.
        raw = await w.client.getIssueByKey(key);
        const drop = new Set(remove.map((l) => l.toLowerCase()));
        const current = (raw.labels ?? []).flatMap((l) => (l && typeof l === "object" ? [l.name] : []));
        draft.labels = [...current.filter((l) => !drop.has(l.toLowerCase())), ...add];
        changed.push("labels");
      }
      const files = optList(a, "attachments") ?? [];
      if (!changed.length && !files.length) throw new ToolError("nothing to change — pass at least one field");
      const issueId = raw?.id ?? (await issueIds(c, w, [key]))[0]!;
      if (changed.length) {
        await w.client.updateIssue(w.integration.projectId, issueId, await c.plane.draftBody(w.integration, draft, c.scope.userId, false));
        c.note("plane_issue_updated", { key, fields: changed.join(", ") }, `Plane: оновлено ${key} (${changed.join(", ")})`);
      }
      const uploaded = await upload(c, w, issueId, key, files);
      const warning = await c.mirror(w, issueId, uploaded.attached.length ? "children" : "fields");
      return compact({ key, changed, attached: uploaded.attached, attachmentErrors: uploaded.failed, warning });
    },
  },
  {
    name: "plane_set_state",
    description:
      "Move a work item to a state — by state name or id (plane_list_states), or by group (e.g. completed) when the project has exactly one state in it. Plane has no workflow, so any state is reachable in one call. An optional comment is added with it.",
    inputSchema: schema({ issueKey: ISSUE_KEY, state: str("State name, id, or group."), comment: str("Optional comment, markdown.") }, ["issueKey", "state"]),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const key = itemKey(a);
      const w = await c.where({ key });
      const state = pickState(await c.plane.statesOf(w.integration, c.scope.userId), reqText(a, "state"), w.integration.projectIdentifier);
      const [issueId] = await issueIds(c, w, [key]);
      await w.client.updateIssue(w.integration.projectId, issueId!, { state: state.id });
      c.note("plane_issue_state_changed", { key, state: state.name }, `Plane: ${key} → ${state.name}`);
      const comment = optText(a, "comment");
      let commentId: string | undefined;
      if (comment) {
        commentId = (await w.client.addComment(w.integration.projectId, issueId!, markdownToPlaneHtml(comment))).id;
        c.note("plane_comment_added", { key }, `Plane: коментар до ${key}`);
      }
      const warning = await c.mirror(w, issueId!, comment ? "children" : "fields");
      return compact({ key, state: state.name, group: state.group, commentId, warning });
    },
  },
  {
    name: "plane_add_comment",
    description: "Add a comment (markdown) to a work item.",
    inputSchema: schema({ issueKey: ISSUE_KEY, body: str("Comment, markdown.") }, ["issueKey", "body"]),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const key = itemKey(a);
      const body = reqText(a, "body");
      const w = await c.where({ key });
      const [issueId] = await issueIds(c, w, [key]);
      const { id } = await w.client.addComment(w.integration.projectId, issueId!, markdownToPlaneHtml(body));
      c.note("plane_comment_added", { key }, `Plane: коментар до ${key}`);
      return compact({ key, commentId: id, warning: await c.mirror(w, issueId!, "children") });
    },
  },
  {
    name: "plane_edit_comment",
    description: "Replace the text of an existing comment (id from plane_get_issue). Plane lets the author (or a project admin) edit it.",
    inputSchema: schema({ issueKey: ISSUE_KEY, commentId: str("Comment id."), body: str("New text, markdown.") }, ["issueKey", "commentId", "body"]),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const key = itemKey(a);
      const commentId = reqText(a, "commentId");
      const body = reqText(a, "body");
      const w = await c.where({ key });
      const [issueId] = await issueIds(c, w, [key]);
      await w.client.updateComment(w.integration.projectId, issueId!, commentId, markdownToPlaneHtml(body));
      c.note("plane_comment_updated", { key }, `Plane: змінено коментар у ${key}`);
      return compact({ key, warning: await c.mirror(w, issueId!, "children") });
    },
  },
  {
    name: "plane_delete_comment",
    description: "Delete a comment. Only when the operator explicitly asked for it.",
    inputSchema: schema({ issueKey: ISSUE_KEY, commentId: str("Comment id.") }, ["issueKey", "commentId"]),
    annotations: { readOnlyHint: false, destructiveHint: true },
    run: async (c, a) => {
      const key = itemKey(a);
      const commentId = reqText(a, "commentId");
      const w = await c.where({ key });
      const [issueId] = await issueIds(c, w, [key]);
      await w.client.deleteComment(w.integration.projectId, issueId!, commentId);
      c.note("plane_comment_deleted", { key }, `Plane: видалено коментар у ${key}`);
      return compact({ key, warning: await c.mirror(w, issueId!, "children") });
    },
  },
  {
    name: "plane_add_worklog",
    description:
      "Log time on a work item under the operator's account (Plane's time tracking — only on projects that have it). Plane has no work date and no remaining estimate: an entry is a duration and an optional note, dated now.",
    inputSchema: schema(
      { issueKey: ISSUE_KEY, timeSpent: str("Duration, e.g. \"3h 20m\", \"45m\", \"1.5h\"."), description: str("Optional note.") },
      ["issueKey", "timeSpent"],
    ),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const key = itemKey(a);
      let minutes: number;
      try {
        minutes = parseDurationToMinutes(reqText(a, "timeSpent"));
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
      const description = optText(a, "description");
      const w = await c.where({ key });
      const [issueId] = await issueIds(c, w, [key]);
      let worklogId: string;
      try {
        ({ id: worklogId } = await w.client.addWorklog(w.integration.projectId, issueId!, { duration: minutes, ...(description ? { description } : {}) }));
      } catch (err) {
        // The item was found a moment ago, so a 404 here is the worklog ROUTE: no time
        // tracking on this edition. A 402 is the plan.
        if (err instanceof PlaneHttpError && (err.status === 404 || err.status === 402))
          throw new ToolError(
            `Time tracking is not available on ${w.integration.projectIdentifier} (switched off for the project, or this Plane edition/plan has no worklogs). Tell the operator; do not retry.`,
          );
        throw err;
      }
      const time = formatMinutes(minutes);
      c.note("plane_worklog_added", { key, time }, `Plane: залоговано ${time} у ${key}`);
      return compact({ key, worklogId, time, warning: await c.mirror(w, issueId!, "children") });
    },
  },
  {
    name: "plane_create_link",
    description: "Attach a web link (URL + optional title) to a work item — a spec, a design, a pull request.",
    inputSchema: schema({ issueKey: ISSUE_KEY, url: str("http(s) URL."), title: str("Link title.") }, ["issueKey", "url"]),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const key = itemKey(a);
      const url = reqText(a, "url");
      if (!/^https?:\/\//i.test(url)) throw new ToolError("url must start with http:// or https://");
      const title = optText(a, "title");
      const w = await c.where({ key });
      const [issueId] = await issueIds(c, w, [key]);
      const link = await w.client.createLink(w.integration.projectId, issueId!, { url, ...(title ? { title } : {}) });
      c.note("plane_link_added", { key, url }, `Plane: до ${key} додано посилання ${url}`);
      return compact({ key, linkId: link.id });
    },
  },
  {
    name: "plane_add_attachment",
    description: "Upload files the operator attached to this conversation onto a work item, by their exact names (Plane's default limit is 5 MB a file).",
    inputSchema: schema({ issueKey: ISSUE_KEY, files: strs("File names as the turn lists them.") }, ["issueKey", "files"]),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const key = itemKey(a);
      const names = optList(a, "files") ?? [];
      if (!names.length) throw new ToolError("files is required");
      const w = await c.where({ key });
      const [issueId] = await issueIds(c, w, [key]);
      const files = await upload(c, w, issueId!, key, names);
      if (!files.attached.length) throw new ToolError(`nothing was attached: ${files.failed.join("; ")}`);
      return compact({ key, attached: files.attached, errors: files.failed, warning: await c.mirror(w, issueId!, "children") });
    },
  },
  {
    name: "plane_delete_issue",
    description: "Delete a work item. Only when the operator explicitly asked to delete THIS item (Plane lets an admin or the item's creator do it).",
    inputSchema: schema({ issueKey: ISSUE_KEY }, ["issueKey"]),
    annotations: { readOnlyHint: false, destructiveHint: true },
    run: async (c, a) => {
      const key = itemKey(a);
      const w = await c.where({ key });
      const [issueId] = await issueIds(c, w, [key]);
      await w.client.deleteIssue(w.integration.projectId, issueId!);
      c.note("plane_issue_deleted", { key }, `Plane: видалено ${key}`);
      // Removing the mirror row is what drops the card from every open board at once.
      return compact({ deleted: key, warning: await c.mirror(w, issueId!, "deleted") });
    },
  },
  {
    name: "plane_create_cycle",
    description: "Create a cycle (Plane's sprint) in a project. Dates go together or not at all.",
    inputSchema: schema(
      {
        project: PROJECT,
        name: str("Cycle name."),
        description: str("Description."),
        startDate: str("YYYY-MM-DD."),
        endDate: str("YYYY-MM-DD."),
      },
      ["name"],
    ),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const name = reqText(a, "name");
      const start = day(a, "startDate") || undefined;
      const end = day(a, "endDate") || undefined;
      if (!start !== !end) throw new ToolError("startDate and endDate go together — Plane takes both or neither");
      if (start && end && start > end) throw new ToolError("startDate is after endDate");
      const w = await c.where({ project: optText(a, "project") });
      const pid = w.integration.projectId;
      const x = await w.client.createCycle(
        pid,
        compact({ name, description: optText(a, "description"), start_date: start, end_date: end, project_id: pid }),
      );
      c.note("plane_cycle_created", { name, project: w.integration.projectIdentifier }, `Plane: створено цикл «${name}» у ${w.integration.projectIdentifier}`);
      return cycleRow(x);
    },
  },
  {
    name: "plane_add_issues_to_cycle",
    description: "Put work items (up to 50, one project) into a cycle. An item sits in one cycle at a time: adding it moves it.",
    inputSchema: schema({ cycle: CYCLE, issueKeys: strs("Work item keys.") }, ["cycle", "issueKeys"]),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const keys = keyList(a, "issueKeys");
      const w = await c.where({ key: keys[0]! });
      const cycle = await cycleOf(w, reqText(a, "cycle"));
      await w.client.addCycleIssues(w.integration.projectId, String(cycle.id), await issueIds(c, w, keys));
      const name = String(cycle.name);
      c.note("plane_issues_added_to_cycle", { keys: keys.join(", "), cycle: name }, `Plane: ${keys.join(", ")} → цикл «${name}»`);
      return { cycle: name, added: keys };
    },
  },
  {
    name: "plane_remove_issue_from_cycle",
    description: "Take a work item out of a cycle.",
    inputSchema: schema({ cycle: CYCLE, issueKey: ISSUE_KEY }, ["cycle", "issueKey"]),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const key = itemKey(a);
      const w = await c.where({ key });
      const cycle = await cycleOf(w, reqText(a, "cycle"));
      const [issueId] = await issueIds(c, w, [key]);
      await w.client.removeCycleIssue(w.integration.projectId, String(cycle.id), issueId!);
      const name = String(cycle.name);
      c.note("plane_issue_removed_from_cycle", { key, cycle: name }, `Plane: ${key} прибрано з циклу «${name}»`);
      return { cycle: name, removed: key };
    },
  },
  {
    name: "plane_create_module",
    description: "Create a module (a feature or release grouping — Jira's component/version) in a project.",
    inputSchema: schema(
      {
        project: PROJECT,
        name: str("Module name."),
        description: str("Description."),
        startDate: str("YYYY-MM-DD."),
        targetDate: str("YYYY-MM-DD."),
        status: str(`${MODULE_STATUSES.join(" | ")} (default: Plane's).`),
      },
      ["name"],
    ),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const name = reqText(a, "name");
      const status = optText(a, "status")?.toLowerCase();
      if (status && !MODULE_STATUSES.includes(status)) throw new ToolError(`status must be one of ${MODULE_STATUSES.join(", ")}`);
      const start = day(a, "startDate") || undefined;
      const target = day(a, "targetDate") || undefined;
      if (start && target && start > target) throw new ToolError("startDate is after targetDate");
      const w = await c.where({ project: optText(a, "project") });
      const x = await w.client.createModule(
        w.integration.projectId,
        compact({ name, description: optText(a, "description"), start_date: start, target_date: target, status }),
      );
      c.note("plane_module_created", { name, project: w.integration.projectIdentifier }, `Plane: створено модуль «${name}» у ${w.integration.projectIdentifier}`);
      return moduleRow(x);
    },
  },
  {
    name: "plane_add_issues_to_module",
    description: "Add work items (up to 50, one project) to a module. An item may belong to several modules.",
    inputSchema: schema({ module: MODULE, issueKeys: strs("Work item keys.") }, ["module", "issueKeys"]),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const keys = keyList(a, "issueKeys");
      const w = await c.where({ key: keys[0]! });
      const mod = await moduleOf(w, reqText(a, "module"));
      await w.client.addModuleIssues(w.integration.projectId, String(mod.id), await issueIds(c, w, keys));
      const name = String(mod.name);
      c.note("plane_issues_added_to_module", { keys: keys.join(", "), module: name }, `Plane: ${keys.join(", ")} → модуль «${name}»`);
      return { module: name, added: keys };
    },
  },
  {
    name: "plane_remove_issue_from_module",
    description: "Remove a work item from a module.",
    inputSchema: schema({ module: MODULE, issueKey: ISSUE_KEY }, ["module", "issueKey"]),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const key = itemKey(a);
      const w = await c.where({ key });
      const mod = await moduleOf(w, reqText(a, "module"));
      const [issueId] = await issueIds(c, w, [key]);
      await w.client.removeModuleIssue(w.integration.projectId, String(mod.id), issueId!);
      const name = String(mod.name);
      c.note("plane_issue_removed_from_module", { key, module: name }, `Plane: ${key} прибрано з модуля «${name}»`);
      return { module: name, removed: key };
    },
  },
];

@Injectable()
export class PlaneToolsService {
  private readonly byName = new Map(TOOLS.map((t) => [t.name, t]));

  constructor(private plane: PlaneService) {}

  list(): ManagementToolDescriptor[] {
    return TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
  }

  // One call → the text the model reads. Every failure comes back as text rather than a
  // throw: to MCP it is a tool error the model can act on, never a transport failure.
  async call(scope: ManagementToolScope, name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    const tool = this.byName.get(name);
    if (!tool) return { text: `unknown tool ${name}`, isError: true };
    const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Args) : {};
    try {
      const out = await tool.run(new Call(this.plane, scope), a);
      return { text: JSON.stringify(out), isError: false };
    } catch (err) {
      if (err instanceof PlaneHttpError)
        return {
          text:
            err.status === 401
              ? "Plane rejected the operator's personal API key (401) — it must be replaced under Менеджмент → Integrations. Tell the operator; do not retry."
              : err.status === 429
                ? "Plane's rate limit is spent (60 requests a minute per key, shared with the board's sync) — wait about a minute before the next plane_* call, and do not retry in a loop."
                : `Plane refused (${err.status}): ${err.message}`,
          isError: true,
        };
      return { text: (err as Error).message, isError: true };
    }
  }
}
