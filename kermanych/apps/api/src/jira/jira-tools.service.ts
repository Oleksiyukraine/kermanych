// apps/api/src/jira/jira-tools.service.ts
// The Менеджмент assistant's live Jira surface: the tools the chat child calls DURING a turn,
// at parity with the public Jira MCP servers (sooperset/mcp-atlassian and Atlassian's Rovo MCP)
// for everything a Jira Cloud project manager does — search, read an issue whole, discover the
// create screen, create, update, transition, comment, log work, link, watch, attach, sprints,
// versions and components.
//
// Why tools and not the action blocks the rest of the chat uses. A block is executed by the
// browser AFTER the turn, so the model never saw what happened: a missing issue type, a field
// the project's screen requires, a parent of the wrong hierarchy level or a failed mirror
// refresh became a warn line the operator read and the model did not — and a sequence whose
// parent failed silently dropped every child. Here each call answers the model at once, with
// Jira's own refusal, so it can read the create screen, fix the field and retry inside the same
// turn, and a series is filed one issue at a time with each new key in hand.
//
// Every call runs under the ACTING operator's own Jira token (JiraService.clientFor), exactly as
// the board's own buttons do, and reaches only the sites of boards the workspace connected. A
// write is followed by a best-effort mirror refresh (JiraService.refreshIssue) so «Дошка» shows
// it without waiting for a poll; a refresh that fails is REPORTED beside the write and never
// turns a write Jira accepted into an error — the key the model was handed must stay true.
import { Injectable } from "@nestjs/common";
import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderTicketDescription, validateNewTicket, type Notice, type NoticeCode } from "@kermanych/core";
import type { JiraIntegration } from "@kermanych/cloud";
import { JiraService } from "./jira.service";
import {
  JiraHttpError,
  normalizeSiteUrl,
  type JiraClient,
  type JiraCreateMetaIssueType,
  type JiraRawIssue,
  type JiraRawIssueLink,
} from "./jira-client";
import { adfDoc, adfMarkdown } from "./jira-adf";
import { toJiraDate, toJiraStarted } from "./jira-map";

// What one call is allowed to touch and where its side effects go. Built per conversation by
// ManagementChatService; the tool layer never learns who is asking any other way.
export type JiraToolScope = {
  userId: string;
  workspaceId: string;
  // A file the operator attached to this conversation, by the exact name the turn listed it
  // under — the only bytes jira_create_issue / jira_add_attachment may upload.
  file(name: string): { path: string; mimeType: string } | undefined;
  // Where jira_download_attachment writes, so the read tool can open what it fetched.
  downloadDir: string;
  // One line per write, in order — the reply's `jiraChanges`.
  changed(notice: Notice): void;
};

// A tool as MCP's tools/list describes it.
export type JiraToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean };
};

// A refusal phrased for the model: shown to it verbatim as the tool's error result.
export class JiraToolError extends Error {}

type Args = Record<string, unknown>;

type Tool = JiraToolDescriptor & { run: (c: Call, a: Args) => Promise<unknown> };

// The page cap a search may ask for. Jira's own ceiling is 100 for /search/jql with a named
// field list, and a page larger than that is a context window spent on one answer.
const SEARCH_MAX = 100;

// What a search row carries when the model names no fields: enough to recognise, triage and
// pick the next key to read — the whole issue is jira_get_issue's job.
const SEARCH_FIELDS = ["summary", "issuetype", "status", "priority", "assignee", "parent", "labels", "updated", "duedate"];

// jira_download_attachment writes the bytes where the read tool can open them; past this a file
// is not something a chat turn reads, and the model is told so instead of the disk filling up.
const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

// Atlassian account ids: the 24-hex legacy form and the `<number>:<uuid>` form.
const ACCOUNT_ID_RE = /^(?:[0-9a-f]{24}|\d+:[0-9a-f-]{36})$/i;

const KEY_RE = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/;

// Which end of POST /issueLink Jira stores as the SOURCE of the outward phrase. Jira documents
// the read side (an issue's `outwardIssue` = «this issue <outward> that one») but not the write
// side, and both spellings circulate. So the first link a process creates is read back and, if
// Jira stored it the other way round, re-created swapped; the answer is kept for the process.
let linkSourceIsInward: boolean | undefined;

// ── argument readers ─────────────────────────────────────────────────────────
// MCP arguments are JSON the model wrote. Each reader refuses a wrong TYPE in words the model
// can act on; absent stays absent, because «not mentioned» must never clear a field.

function optText(a: Args, name: string): string | undefined {
  const v = a[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new JiraToolError(`${name} must be a string`);
  return v.trim();
}

function reqText(a: Args, name: string): string {
  const v = optText(a, name);
  if (!v) throw new JiraToolError(`${name} is required`);
  return v;
}

// A list of names. A comma-separated string is accepted too: models write «a, b» where an
// array was asked for, and the intent is unambiguous.
function optList(a: Args, name: string): string[] | undefined {
  const v = a[name];
  if (v === undefined || v === null) return undefined;
  const items = typeof v === "string" ? v.split(",") : v;
  if (!Array.isArray(items) || items.some((x) => typeof x !== "string"))
    throw new JiraToolError(`${name} must be a list of strings`);
  return (items as string[]).map((x) => x.trim()).filter((x) => x !== "");
}

function optInt(a: Args, name: string, min: number, max: number): number | undefined {
  const v = a[name];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max)
    throw new JiraToolError(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

function optBool(a: Args, name: string): boolean | undefined {
  const v = a[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new JiraToolError(`${name} must be true or false`);
  return v;
}

function optObject(a: Args, name: string): Record<string, unknown> | undefined {
  const v = a[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new JiraToolError(`${name} must be a JSON object`);
  return v as Record<string, unknown>;
}

function issueKey(a: Args, name = "issueKey"): string {
  const key = reqText(a, name).toUpperCase();
  if (!KEY_RE.test(key)) throw new JiraToolError(`${name}=${JSON.stringify(a[name])} is not a Jira issue key (e.g. KRM-101)`);
  return key;
}

function keyList(a: Args, name: string): string[] {
  const keys = (optList(a, name) ?? []).map((k) => k.toUpperCase());
  if (!keys.length) throw new JiraToolError(`${name} is required`);
  const bad = keys.find((k) => !KEY_RE.test(k));
  if (bad) throw new JiraToolError(`${JSON.stringify(bad)} is not a Jira issue key`);
  if (keys.length > 50) throw new JiraToolError(`at most 50 issues per call`);
  return keys;
}

function projectOf(key: string): string {
  return key.slice(0, key.lastIndexOf("-"));
}

// A date the model wrote for a sprint or a worklog: anything Date reads, sent on as ISO.
function instant(a: Args, name: string): string | undefined {
  const v = optText(a, name);
  if (!v) return undefined;
  const at = new Date(v);
  if (Number.isNaN(at.getTime())) throw new JiraToolError(`${name}=${JSON.stringify(v)} is not a date/time`);
  return at.toISOString();
}

// A calendar day for a version: YYYY-MM-DD, validated by the same rule the ticket dates use.
function day(a: Args, name: string): string | undefined {
  const v = optText(a, name);
  if (v === undefined) return undefined;
  try {
    return toJiraDate(v) ?? undefined;
  } catch {
    throw new JiraToolError(`${name}=${JSON.stringify(v)} is not a YYYY-MM-DD date`);
  }
}

// ── value shaping ────────────────────────────────────────────────────────────

// A Jira field value as the model should read it: people by name, options by value, ADF as
// markdown, and nothing it would have to decode. Empty values are dropped by the caller.
function plain(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) {
    const out = v.map(plain).filter((x) => x !== undefined && x !== "");
    return out.length ? out : undefined;
  }
  const o = v as Record<string, unknown>;
  if (o.type === "doc") return adfMarkdown(o) || undefined;
  if (typeof o.displayName === "string") return o.displayName;
  if (typeof o.value === "string") return o.child ? `${o.value} / ${String(plain(o.child))}` : o.value;
  if (typeof o.name === "string") return o.name;
  if (typeof o.key === "string") return o.key;
  return o;
}

function person(v: unknown): { name: string; accountId?: string } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const p = v as { displayName?: string; accountId?: string };
  return { name: p.displayName ?? "", ...(p.accountId ? { accountId: p.accountId } : {}) };
}

// Drops the keys whose value says nothing, so a row is only what the issue actually carries.
function compact(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o))
    if (v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  return out;
}

function nameOf(v: unknown): string | undefined {
  return v && typeof v === "object" && typeof (v as { name?: unknown }).name === "string"
    ? (v as { name: string }).name
    : undefined;
}

function statusOf(fields: Record<string, unknown>): { status?: string; statusCategory?: string } {
  const s = fields.status as { name?: string; statusCategory?: { key?: string } } | undefined;
  return { status: s?.name, statusCategory: s?.statusCategory?.key };
}

// One end of a link, from the issue being read: «blocks KRM-2 (In Progress)».
function linkLine(l: JiraRawIssueLink): Record<string, unknown> {
  const other = l.outwardIssue ?? l.inwardIssue;
  const f = other?.fields ?? {};
  return compact({
    linkId: l.id,
    type: l.type.name,
    relation: l.outwardIssue ? l.type.outward : l.type.inward,
    key: other?.key,
    summary: f.summary,
    status: nameOf(f.status),
  });
}

// Every custom field the issue holds a value for, named «Display name (customfield_N)» so the
// model can both read it and pass the id back in `fields` when it writes one.
function customFields(fields: Record<string, unknown>, names: Record<string, string> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(fields)) {
    if (!id.startsWith("customfield_")) continue;
    const v = plain(raw);
    if (v === undefined || v === "") continue;
    out[names?.[id] ? `${names[id]} (${id})` : id] = v;
  }
  return out;
}

function searchRow(raw: JiraRawIssue, names: Record<string, string> | undefined, extra: string[]): Record<string, unknown> {
  const f = raw.fields;
  const parent = f.parent as { key?: string } | undefined;
  const row: Record<string, unknown> = {
    key: raw.key,
    summary: f.summary,
    type: nameOf(f.issuetype),
    ...statusOf(f),
    priority: nameOf(f.priority),
    assignee: person(f.assignee)?.name,
    parent: parent?.key,
    labels: f.labels,
    updated: f.updated,
    due: f.duedate,
  };
  for (const id of extra) if (!(id in row) && !SEARCH_FIELDS.includes(id)) row[names?.[id] ?? id] = plain(f[id]);
  return compact(row);
}

// ── the per-call context ────────────────────────────────────────────────────

type Where = { client: JiraClient; siteUrl: string; projectKey?: string; boards: JiraIntegration[] };

class Call {
  private boardsCache?: JiraIntegration[];

  constructor(
    readonly jira: JiraService,
    readonly scope: JiraToolScope,
  ) {}

  async boards(): Promise<JiraIntegration[]> {
    this.boardsCache ??= await this.jira.listIntegrations(this.scope.workspaceId);
    return this.boardsCache;
  }

  // The site (and so the token) a call runs against. An issue key or project names it through
  // the connected board of that project; otherwise the workspace's single site answers, and a
  // workspace spanning several sites must name `board`. A project on the right site that no
  // board mirrors is still reachable — Jira, not the mirror, is what the tools read.
  async where(opts: { key?: string; project?: string; board?: string; defaultProject?: boolean }): Promise<Where> {
    const boards = await this.boards();
    if (!boards.length)
      throw new JiraToolError("This workspace has no connected Jira board — the owner connects one under Менеджмент → Integrations.");
    let board: JiraIntegration | undefined;
    if (opts.board) {
      const want = opts.board.toLowerCase();
      board = boards.find((b) => b.boardName.toLowerCase() === want || b.projectKey.toLowerCase() === want);
      if (!board)
        throw new JiraToolError(
          `No connected board named ${JSON.stringify(opts.board)}. Connected: ${boards.map((b) => `«${b.boardName}» (${b.projectKey})`).join(", ")}`,
        );
    }
    let projectKey = opts.project?.toUpperCase() ?? (opts.key ? projectOf(opts.key) : undefined) ?? board?.projectKey;
    if (!projectKey && opts.defaultProject) {
      if (boards.length > 1)
        throw new JiraToolError(
          `Several boards are connected — name the project or board. Connected: ${boards.map((b) => `«${b.boardName}» (${b.projectKey})`).join(", ")}`,
        );
      projectKey = boards[0]!.projectKey;
    }
    board ??= boards.find((b) => b.projectKey.toUpperCase() === projectKey);
    const sites = [...new Set(boards.map((b) => normalizeSiteUrl(b.siteUrl)))];
    const siteUrl = board ? normalizeSiteUrl(board.siteUrl) : sites.length === 1 ? sites[0]! : undefined;
    if (!siteUrl)
      throw new JiraToolError(
        `The workspace's boards span several Jira sites (${sites.join(", ")}) and ${projectKey ?? "this call"} is on none of their projects — name \`board\`.`,
      );
    let client: JiraClient;
    try {
      client = this.jira.clientFor(siteUrl, this.scope.userId);
    } catch {
      throw new JiraToolError(
        `No personal Jira token for ${siteUrl} on this machine — every Jira call runs under the operator's own token, added under Менеджмент → Integrations. Tell the operator; do not retry.`,
      );
    }
    return { client, siteUrl, ...(projectKey ? { projectKey } : {}), boards };
  }

  // The board's mirror after a write, so «Дошка» shows it before the next poll. Every board of
  // the issue's project is refreshed (two boards may mirror one project). A failure is
  // returned as a warning: Jira has the write, and the mirror catches up on its next sweep.
  async mirror(w: Where, key: string): Promise<string | undefined> {
    const project = projectOf(key);
    const targets = w.boards.filter((b) => b.projectKey.toUpperCase() === project);
    const failed: string[] = [];
    for (const b of targets)
      try {
        await this.jira.refreshIssue(b.id, key, this.scope.userId);
      } catch (err) {
        failed.push((err as Error).message);
      }
    return failed.length
      ? `Written to Jira, but the board mirror was not refreshed (${failed.join("; ")}); it catches up on the next sync.`
      : undefined;
  }

  note(code: NoticeCode, params: Record<string, string>, text: string): void {
    this.scope.changed({ text, code, params });
  }
}

// ── resolvers ────────────────────────────────────────────────────────────────

function pickIssueType(types: JiraCreateMetaIssueType[], want: string, project: string): JiraCreateMetaIssueType {
  const lower = want.toLowerCase();
  const hit = types.find((t) => t.id === want || t.name.toLowerCase() === lower);
  if (hit) return hit;
  throw new JiraToolError(
    `Project ${project} has no issue type ${JSON.stringify(want)}. Available: ${types.map(typeLabel).join(", ")}`,
  );
}

function typeLabel(t: JiraCreateMetaIssueType): string {
  const level = t.subtask ? "sub-task" : t.hierarchyLevel === 1 ? "epic level" : t.hierarchyLevel && t.hierarchyLevel > 1 ? `level ${t.hierarchyLevel}` : "standard";
  return `${t.name} (id ${t.id}, ${level})`;
}

// An assignee by accountId, display name or e-mail — resolved against the people Jira will
// accept for THIS project, so a name the operator said becomes the account Jira means or a
// refusal that lists who it could have been.
async function assignee(client: JiraClient, project: string, who: string): Promise<{ accountId: string }> {
  if (ACCOUNT_ID_RE.test(who)) return { accountId: who };
  const users = await client.assignableUsers(project, who);
  const lower = who.toLowerCase();
  const exact = users.filter((u) => u.displayName.toLowerCase() === lower);
  const one = exact.length === 1 ? exact[0] : users.length === 1 ? users[0] : undefined;
  if (one) return { accountId: one.accountId };
  throw new JiraToolError(
    users.length
      ? `Several assignable users in ${project} match ${JSON.stringify(who)}: ${users.slice(0, 10).map((u) => `${u.displayName} (${u.accountId})`).join(", ")} — pass the accountId.`
      : `Nobody assignable in ${project} matches ${JSON.stringify(who)}. Use jira_search_users to look the person up.`,
  );
}

async function anyUser(client: JiraClient, who: string): Promise<{ accountId: string; name: string }> {
  if (ACCOUNT_ID_RE.test(who)) return { accountId: who, name: who };
  const users = await client.searchUsers(who);
  const lower = who.toLowerCase();
  const exact = users.filter((u) => u.displayName.toLowerCase() === lower || u.emailAddress?.toLowerCase() === lower);
  const one = exact.length === 1 ? exact[0] : users.length === 1 ? users[0] : undefined;
  if (one) return { accountId: one.accountId, name: one.displayName };
  throw new JiraToolError(
    users.length
      ? `Several users match ${JSON.stringify(who)}: ${users.slice(0, 10).map((u) => `${u.displayName} (${u.accountId})`).join(", ")} — pass the accountId.`
      : `No Jira user matches ${JSON.stringify(who)}.`,
  );
}

// The fields a create and an update share, written the way POST/PUT /issue reads them. Names
// travel as `{ name }` (priority, components, versions) — Jira resolves them itself and its
// refusal names the value — and `fields` is the escape hatch for any custom field by id,
// which is how a required field from jira_get_create_fields gets filled.
async function commonFields(
  c: Call,
  w: Where,
  a: Args,
  forCreate: boolean,
): Promise<{ fields: Record<string, unknown>; update: Record<string, unknown>; changed: string[] }> {
  const fields: Record<string, unknown> = {};
  const update: Record<string, unknown> = {};
  const changed: string[] = [];
  const project = w.projectKey!;

  const priority = optText(a, "priority");
  if (priority) {
    fields.priority = /^\d+$/.test(priority) ? { id: priority } : { name: priority };
    changed.push("priority");
  }
  if (a.assignee !== undefined) {
    const who = a.assignee === null ? "" : optText(a, "assignee");
    if (who) fields.assignee = await assignee(w.client, project, who);
    else if (!forCreate) fields.assignee = null;
    if (who || !forCreate) changed.push("assignee");
  }
  const labels = optList(a, "labels");
  if (labels) {
    const spaced = labels.find((l) => /\s/.test(l));
    if (spaced) throw new JiraToolError(`label ${JSON.stringify(spaced)} contains whitespace — Jira refuses such labels`);
    fields.labels = labels;
    changed.push("labels");
  }
  const add = optList(a, "addLabels") ?? [];
  const remove = optList(a, "removeLabels") ?? [];
  if (add.length || remove.length) {
    if (labels) throw new JiraToolError("labels replaces the whole list — do not combine it with addLabels/removeLabels");
    update.labels = [...add.map((l) => ({ add: l })), ...remove.map((l) => ({ remove: l }))];
    changed.push("labels");
  }
  for (const [arg, field] of [["components", "components"], ["fixVersions", "fixVersions"]] as const) {
    const names = optList(a, arg);
    if (names) {
      fields[field] = names.map((name) => ({ name }));
      changed.push(arg);
    }
  }
  const parent = optText(a, "parentKey");
  if (parent) {
    const key = parent.toUpperCase();
    if (!KEY_RE.test(key)) throw new JiraToolError(`parentKey=${JSON.stringify(parent)} is not a Jira issue key`);
    fields.parent = { key };
    changed.push("parent");
  }
  const due = optText(a, "dueDate");
  if (due !== undefined) {
    try {
      fields.duedate = toJiraDate(due);
    } catch {
      throw new JiraToolError(`dueDate=${JSON.stringify(due)} is not a YYYY-MM-DD date ("" clears it)`);
    }
    changed.push("dueDate");
  }
  const start = optText(a, "startDate");
  if (start !== undefined) {
    const id = await c.jira.startDateFieldId(w.siteUrl, w.client);
    if (!id) throw new JiraToolError("this Jira site has no start date field");
    try {
      fields[id] = toJiraDate(start);
    } catch {
      throw new JiraToolError(`startDate=${JSON.stringify(start)} is not a YYYY-MM-DD date ("" clears it)`);
    }
    changed.push("startDate");
  }
  const estimate = optText(a, "originalEstimate");
  if (estimate !== undefined) {
    fields.timetracking = { originalEstimate: estimate || null };
    changed.push("originalEstimate");
  }
  const raw = optObject(a, "fields");
  if (raw) {
    Object.assign(fields, raw);
    changed.push(...Object.keys(raw));
  }
  return { fields, update, changed };
}

// The operator's named files onto an issue. Each upload is its own outcome: one unreadable
// file must not lose the others, and none of them may undo the issue already written.
async function upload(c: Call, w: Where, key: string, names: string[]): Promise<{ attached: string[]; failed: string[] }> {
  const attached: string[] = [];
  const failed: string[] = [];
  for (const name of names) {
    const f = c.scope.file(name);
    if (!f) {
      failed.push(`${name}: no file of that name in this conversation`);
      continue;
    }
    try {
      await w.client.uploadAttachment(key, name, await readFile(f.path), f.mimeType);
      attached.push(name);
      c.note("jira_attachment_added", { key, name }, `Jira: до ${key} прикріплено «${name}»`);
    } catch (err) {
      failed.push(`${name}: ${(err as Error).message}`);
    }
  }
  return { attached, failed };
}

// ── the catalogue ────────────────────────────────────────────────────────────

const str = (description: string) => ({ type: "string", description });
const strs = (description: string) => ({ type: "array", items: { type: "string" }, description });
const int = (description: string) => ({ type: "integer", description });
const bool = (description: string) => ({ type: "boolean", description });
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});

const BOARD = str("Connected board name or its project key — only needed when the workspace's boards span several Jira sites.");
const ISSUE_KEY = str("Issue key, e.g. KRM-101.");
const PROJECT = str("Jira project key, e.g. KRM.");

// Fields create and update share — one description, so the two tools cannot drift apart.
const COMMON_WRITE_PROPS = {
  priority: str("Priority name (e.g. High) or id."),
  assignee: str("Assignee display name, e-mail or accountId; on update \"\" or null unassigns."),
  labels: strs("Labels (no whitespace). Replaces the whole list."),
  components: strs("Component names. Replaces the whole list."),
  fixVersions: strs("Fix version names. Replaces the whole list."),
  parentKey: str("Parent issue key: the epic for a story/task, the story/task for a sub-task."),
  dueDate: str("YYYY-MM-DD; \"\" clears it."),
  startDate: str("YYYY-MM-DD; \"\" clears it (only on sites with a start-date field)."),
  originalEstimate: str("Jira duration, e.g. \"3d 4h\"; \"\" clears it."),
  fields: {
    type: "object",
    description:
      "Any other field by id, raw Jira JSON — e.g. {\"customfield_10016\": 5}. Use jira_get_create_fields / jira_get_edit_fields for ids and allowed values.",
  },
  attachments: strs("Names of files the operator attached to this conversation, exactly as the turn lists them, to upload onto the issue."),
};

const TICKET_SCHEMA = {
  type: "object",
  description:
    "The ticket in the product's five slots; the description is rendered from them (## Context, ## User flow, ## Acceptance criteria as checkboxes, ## Out of scope). No open questions, TBDs or code.",
  properties: {
    title: str("One line, ≤120 characters — the issue summary."),
    context: str("Why this work exists and for whom, in business terms."),
    userFlow: strs("Optional user-visible steps."),
    acceptanceCriteria: strs("At least one checkable statement."),
    outOfScope: strs("Optional: what this ticket deliberately does not cover."),
  },
  required: ["title", "context", "acceptanceCriteria"],
};

const TOOLS: Tool[] = [
  // ── read ──
  {
    name: "jira_get_myself",
    description: "The Jira account the operator's token acts as.",
    inputSchema: schema({ board: BOARD }),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const w = await c.where({ board: optText(a, "board") });
      return w.client.myself();
    },
  },
  {
    name: "jira_list_projects",
    description: "Projects visible to the operator on the Jira site, optionally filtered by name/key substring.",
    inputSchema: schema({ query: str("Filter by name or key."), board: BOARD }),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const w = await c.where({ board: optText(a, "board") });
      const projects = await w.client.searchProjects(optText(a, "query") ?? "");
      return projects.map((p) =>
        compact({ key: p.key, name: p.name, type: p.projectTypeKey, managed: p.style === "next-gen" ? "team" : p.style === "classic" ? "company" : undefined }),
      );
    },
  },
  {
    name: "jira_list_boards",
    description:
      "Agile boards on the site (id, name, type, project), optionally filtered by project or name. Boards connected to this workspace are marked.",
    inputSchema: schema({ project: PROJECT, name: str("Board name substring."), board: BOARD }),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const w = await c.where({ board: optText(a, "board") });
      const project = optText(a, "project")?.toUpperCase();
      const name = optText(a, "name")?.toLowerCase();
      const connected = new Set(w.boards.map((b) => b.boardId));
      return (await w.client.listBoards())
        .filter((b) => (!project || b.projectKey === project) && (!name || b.name.toLowerCase().includes(name)))
        .map((b) => compact({ id: b.id, name: b.name, type: b.type, project: b.projectKey, connected: connected.has(b.id) || undefined }));
    },
  },
  {
    name: "jira_get_project_issue_types",
    description:
      "Issue types a CREATE in the project accepts, with hierarchy (sub-task / standard / epic level). Always check before creating: the type is required and names differ between projects (Subtask vs Sub-task).",
    inputSchema: schema({ project: PROJECT }, ["project"]),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const w = await c.where({ project: reqText(a, "project") });
      return (await w.client.createMetaIssueTypes(w.projectKey!)).map(typeLabel);
    },
  },
  {
    name: "jira_get_create_fields",
    description:
      "The create screen of one issue type: every field with its id, whether it is REQUIRED, its type and allowed values. Read it when a create fails on a field, or before filling custom fields.",
    inputSchema: schema({ project: PROJECT, issueType: str("Issue type name or id.") }, ["project", "issueType"]),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const w = await c.where({ project: reqText(a, "project") });
      const type = pickIssueType(await w.client.createMetaIssueTypes(w.projectKey!), reqText(a, "issueType"), w.projectKey!);
      return (await w.client.createMetaFields(w.projectKey!, type.id)).map((f) =>
        compact({
          id: f.fieldId,
          name: f.name,
          required: f.required && !f.hasDefaultValue ? true : undefined,
          type: f.schema?.type === "array" ? `array<${f.schema.items ?? "?"}>` : f.schema?.type,
          allowedValues: f.allowedValues?.slice(0, 50).map(plain),
        }),
      );
    },
  },
  {
    name: "jira_get_edit_fields",
    description: "The edit screen of an existing issue: which fields an update may set, with ids and allowed values.",
    inputSchema: schema({ issueKey: ISSUE_KEY }, ["issueKey"]),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const key = issueKey(a);
      const w = await c.where({ key });
      return Object.entries(await w.client.editMeta(key)).map(([id, f]) =>
        compact({
          id,
          name: f.name,
          required: f.required || undefined,
          type: f.schema?.type,
          allowedValues: f.allowedValues?.slice(0, 50).map(plain),
        }),
      );
    },
  },
  {
    name: "jira_search_fields",
    description: "Find field ids (custom fields included) by name — e.g. «story points» → customfield_10016.",
    inputSchema: schema({ keyword: str("Name or id substring; empty lists every field."), board: BOARD }),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const w = await c.where({ board: optText(a, "board") });
      const kw = optText(a, "keyword")?.toLowerCase() ?? "";
      return (await w.client.listFields())
        .filter((f) => !kw || f.id.toLowerCase().includes(kw) || f.name?.toLowerCase().includes(kw))
        .slice(0, 100)
        .map((f) => compact({ id: f.id, name: f.name, custom: f.custom || undefined, type: f.schema?.type }));
    },
  },
  {
    name: "jira_search",
    description:
      "JQL search across the site — any project, open or done, any field. Returns one page and a nextPageToken while more remain. Examples: `project = KRM AND statusCategory != Done ORDER BY priority DESC`, `parent = KRM-10`, `text ~ \"export\"`, `sprint in openSprints()`, `issueFunction`-free JQL only.",
    inputSchema: schema(
      {
        jql: str("JQL query."),
        fields: strs("Extra field ids to include per row (see jira_search_fields); the default row is key, summary, type, status, priority, assignee, parent, labels, updated, due."),
        limit: int(`Page size, 1–${SEARCH_MAX} (default 50).`),
        nextPageToken: str("Cursor from the previous page."),
        board: BOARD,
      },
      ["jql"],
    ),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const w = await c.where({ board: optText(a, "board") });
      const extra = optList(a, "fields") ?? [];
      const page = await w.client.searchPage({
        jql: reqText(a, "jql"),
        fields: [...new Set([...SEARCH_FIELDS, ...extra])],
        maxResults: optInt(a, "limit", 1, SEARCH_MAX) ?? 50,
        ...(optText(a, "nextPageToken") ? { nextPageToken: optText(a, "nextPageToken") } : {}),
      });
      const issues = (page.issues ?? []).map((i) => searchRow(i, page.names, extra));
      return compact({ issues, count: issues.length, nextPageToken: page.nextPageToken });
    },
  },
  {
    name: "jira_get_issue",
    description:
      "One issue, whole: every field (custom fields named), description and comments as markdown, parent, subtasks, issue links, attachments, time tracking; optionally changelog, worklogs, transitions, remote links and watchers. Read an issue this way before changing it.",
    inputSchema: schema(
      {
        issueKey: ISSUE_KEY,
        commentLimit: int("Newest comments to include, 0–200 (default 20)."),
        changelog: bool("Include the history of field changes (last 100)."),
        worklogs: bool("Include worklogs."),
        transitions: bool("Include the transitions available now."),
        remoteLinks: bool("Include web/remote links."),
        watchers: bool("Include watchers."),
      },
      ["issueKey"],
    ),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const key = issueKey(a);
      const w = await c.where({ key });
      const raw = await w.client.issueFull(key);
      const f = raw.fields;
      const tt = (f.timetracking ?? {}) as Record<string, unknown>;
      const parent = f.parent as { key?: string; fields?: Record<string, unknown> } | undefined;
      const commentLimit = optInt(a, "commentLimit", 0, 200) ?? 20;
      const embedded = (f.comment ?? {}) as { comments?: { id: string; author?: unknown; created?: string; updated?: string; body?: unknown }[]; total?: number };
      let comments = embedded.comments ?? [];
      if (commentLimit > 0 && (embedded.total ?? 0) > comments.length) comments = await w.client.listComments(key);
      const out: Record<string, unknown> = {
        key: raw.key,
        url: `${w.siteUrl}/browse/${raw.key}`,
        summary: f.summary,
        type: nameOf(f.issuetype),
        ...statusOf(f),
        resolution: nameOf(f.resolution),
        priority: nameOf(f.priority),
        assignee: person(f.assignee),
        reporter: person(f.reporter),
        parent: parent?.key ? compact({ key: parent.key, summary: parent.fields?.summary, type: nameOf(parent.fields?.issuetype) }) : undefined,
        labels: f.labels,
        components: plain(f.components),
        fixVersions: plain(f.fixVersions),
        affectsVersions: plain(f.versions),
        created: f.created,
        updated: f.updated,
        resolved: f.resolutiondate,
        due: f.duedate,
        originalEstimate: tt.originalEstimate,
        timeSpent: tt.timeSpent,
        remainingEstimate: tt.remainingEstimate,
        environment: plain(f.environment),
        subtasks: Array.isArray(f.subtasks)
          ? (f.subtasks as { key: string; fields?: Record<string, unknown> }[]).map((s) =>
              compact({ key: s.key, summary: s.fields?.summary, status: nameOf(s.fields?.status) }),
            )
          : undefined,
        links: Array.isArray(f.issuelinks) ? (f.issuelinks as JiraRawIssueLink[]).map(linkLine) : undefined,
        attachments: Array.isArray(f.attachment)
          ? (f.attachment as { id: string; filename?: string; mimeType?: string; size?: number }[]).map((x) =>
              compact({ id: x.id, filename: x.filename, mimeType: x.mimeType, size: x.size }),
            )
          : undefined,
        customFields: customFields(f, raw.names),
        description: adfMarkdown(f.description),
        commentsTotal: embedded.total,
        comments:
          commentLimit > 0
            ? comments.slice(-commentLimit).map((x) =>
                compact({ id: x.id, author: person(x.author)?.name, created: x.created, updated: x.updated !== x.created ? x.updated : undefined, body: adfMarkdown(x.body) }),
              )
            : undefined,
      };
      if (optBool(a, "changelog"))
        out.changelog = (await w.client.issueChangelog(key)).slice(-100).map((h) => ({
          at: h.created,
          by: h.author?.displayName,
          changes: h.items.map((i) => `${i.field}: ${i.fromString ?? "∅"} → ${i.toString ?? "∅"}`),
        }));
      if (optBool(a, "worklogs"))
        out.worklogs = (await w.client.listWorklogs(key)).map((x) =>
          compact({ id: x.id, author: x.author?.displayName, timeSpent: x.timeSpent, started: x.started, comment: adfMarkdown(x.comment) }),
        );
      if (optBool(a, "transitions"))
        out.transitions = (await w.client.listTransitions(key)).map((t) => ({ id: t.id, name: t.name, to: t.to.name }));
      if (optBool(a, "remoteLinks"))
        out.remoteLinks = (await w.client.remoteLinks(key)).map((l) => compact({ id: l.id, title: l.object?.title, url: l.object?.url }));
      if (optBool(a, "watchers")) out.watchers = (await w.client.watchers(key)).map((u) => u.displayName ?? u.accountId);
      return compact(out);
    },
  },
  {
    name: "jira_get_transitions",
    description: "Transitions available on an issue right now (id, name, target status).",
    inputSchema: schema({ issueKey: ISSUE_KEY }, ["issueKey"]),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const key = issueKey(a);
      const w = await c.where({ key });
      return (await w.client.listTransitions(key)).map((t) => ({ id: t.id, name: t.name, to: t.to.name, toCategory: t.to.statusCategory.key }));
    },
  },
  {
    name: "jira_get_project_statuses",
    description: "Every status the project's workflows use, with its category (new / indeterminate / done).",
    inputSchema: schema({ project: PROJECT }, ["project"]),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const w = await c.where({ project: reqText(a, "project") });
      return (await w.client.projectStatuses(w.projectKey!)).map((s) => ({ id: s.id, name: s.name, category: s.categoryKey }));
    },
  },
  {
    name: "jira_search_users",
    description:
      "Find Jira users by name or e-mail. With `project`, only people assignable in that project (the set an assignee must come from).",
    inputSchema: schema({ query: str("Name or e-mail fragment."), project: PROJECT, board: BOARD }, ["query"]),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const project = optText(a, "project");
      const w = await c.where({ ...(project ? { project } : {}), board: optText(a, "board") });
      const query = reqText(a, "query");
      const users = project ? await w.client.assignableUsers(w.projectKey!, query) : await w.client.searchUsers(query);
      return users.map((u) => ({ name: u.displayName, accountId: u.accountId }));
    },
  },
  {
    name: "jira_get_link_types",
    description: "Issue link types (name, outward phrase, inward phrase), e.g. Blocks: «blocks» / «is blocked by».",
    inputSchema: schema({ board: BOARD }),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const w = await c.where({ board: optText(a, "board") });
      return (await w.client.issueLinkTypes()).map((t) => ({ name: t.name, outward: t.outward, inward: t.inward }));
    },
  },
  {
    name: "jira_list_sprints",
    description: "Sprints of a board (id, name, state, dates, goal). The board is a connected board's name or any board id from jira_list_boards.",
    inputSchema: schema(
      { board: str("Connected board name/project key, or a numeric board id."), state: str("future | active | closed (comma-separated allowed).") },
      ["board"],
    ),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const { w, boardId } = await boardTarget(c, reqText(a, "board"));
      return (await w.client.boardSprints(boardId, optText(a, "state"))).map((s) =>
        compact({ id: s.id, name: s.name, state: s.state, start: s.startDate, end: s.endDate, completed: s.completeDate, goal: s.goal }),
      );
    },
  },
  {
    name: "jira_list_versions",
    description: "The project's versions (id, name, released, archived, dates).",
    inputSchema: schema({ project: PROJECT }, ["project"]),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const w = await c.where({ project: reqText(a, "project") });
      return (await w.client.projectVersions(w.projectKey!)).map((v) => compact({ ...v }));
    },
  },
  {
    name: "jira_list_components",
    description: "The project's components.",
    inputSchema: schema({ project: PROJECT }, ["project"]),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const w = await c.where({ project: reqText(a, "project") });
      return (await w.client.projectComponents(w.projectKey!)).map((x) =>
        compact({ id: x.id, name: x.name, description: x.description, lead: x.lead?.displayName }),
      );
    },
  },
  {
    name: "jira_download_attachment",
    description:
      "Download one attachment (id from jira_get_issue) to a local file and return its path — then open it with the read tool (images and text both work).",
    inputSchema: schema({ attachmentId: str("Attachment id."), board: BOARD }, ["attachmentId"]),
    annotations: { readOnlyHint: true },
    run: async (c, a) => {
      const id = reqText(a, "attachmentId");
      if (!/^\d+$/.test(id)) throw new JiraToolError("attachmentId must be the numeric id jira_get_issue lists");
      const w = await c.where({ board: optText(a, "board") });
      const meta = await w.client.attachmentMeta(id);
      if ((meta.size ?? 0) > DOWNLOAD_MAX_BYTES)
        throw new JiraToolError(`attachment is ${meta.size} bytes — larger than the ${DOWNLOAD_MAX_BYTES}-byte limit a chat turn reads`);
      const { body, contentType } = await w.client.downloadAttachment(id);
      const bytes = Buffer.from(await new Response(body).arrayBuffer());
      const name = `${id}-${(meta.filename ?? "file").replace(/[/\\]/g, "-").replace(/^\.+/, "")}`;
      await mkdir(c.scope.downloadDir, { recursive: true });
      const path = join(c.scope.downloadDir, name);
      await writeFile(path, bytes);
      return { path, filename: meta.filename, mimeType: meta.mimeType ?? contentType, size: bytes.length };
    },
  },

  // ── write ──
  {
    name: "jira_create_issue",
    description:
      "Create one issue and return its key. `issueType` is REQUIRED — take it from jira_get_project_issue_types. For a series (epic → stories → sub-tasks) create the parent first and pass its returned key as `parentKey` of each child; link dependencies afterwards with jira_create_issue_link. A refusal names the field: fix it (jira_get_create_fields shows required fields and allowed values) and retry.",
    inputSchema: schema(
      {
        project: str("Project key. Optional when the workspace has one connected board, or when `board` names one."),
        board: str("Connected board name — an alternative way to pick the project."),
        issueType: str("Issue type name or id — required."),
        ticket: TICKET_SCHEMA,
        ...COMMON_WRITE_PROPS,
      },
      ["issueType", "ticket"],
    ),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const ticket = validateNewTicket(a.ticket);
      if ("error" in ticket) throw new JiraToolError(ticket.error.text);
      const w = await c.where({ project: optText(a, "project"), board: optText(a, "board"), defaultProject: true });
      const project = w.projectKey!;
      const type = pickIssueType(await w.client.createMetaIssueTypes(project), reqText(a, "issueType"), project);
      if (type.subtask && !optText(a, "parentKey"))
        throw new JiraToolError(`${type.name} is a sub-task type — it needs parentKey (a standard-level issue).`);
      const { fields } = await commonFields(c, w, a, true);
      const created = await w.client.createIssue({
        ...fields,
        project: { key: project },
        issuetype: { id: type.id },
        summary: ticket.title,
        description: adfDoc(renderTicketDescription(ticket)),
      });
      c.note("jira_issue_created", { key: created.key, summary: ticket.title }, `Jira: створено ${created.key} — ${ticket.title}`);
      const files = await upload(c, w, created.key, optList(a, "attachments") ?? []);
      const warning = await c.mirror(w, created.key);
      return compact({
        key: created.key,
        url: `${w.siteUrl}/browse/${created.key}`,
        summary: ticket.title,
        issueType: type.name,
        parent: (fields.parent as { key?: string } | undefined)?.key,
        attached: files.attached,
        attachmentErrors: files.failed,
        warning,
      });
    },
  },
  {
    name: "jira_update_issue",
    description:
      "Change fields of an existing issue — only what you pass changes. `description` REPLACES the whole description (markdown): read the issue first (jira_get_issue) and carry over what must stay. Status is not a field — use jira_transition_issue.",
    inputSchema: schema(
      {
        issueKey: ISSUE_KEY,
        summary: str("New summary."),
        description: str("New full description, markdown."),
        issueType: str("New issue type name or id (Jira may refuse a type change that needs a move)."),
        addLabels: strs("Labels to add, keeping the rest."),
        removeLabels: strs("Labels to remove, keeping the rest."),
        ...COMMON_WRITE_PROPS,
      },
      ["issueKey"],
    ),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const key = issueKey(a);
      const w = await c.where({ key });
      const { fields, update, changed } = await commonFields(c, w, a, false);
      const summary = optText(a, "summary");
      if (summary) {
        fields.summary = summary;
        changed.unshift("summary");
      }
      const description = optText(a, "description");
      if (description !== undefined) {
        fields.description = adfDoc(description);
        changed.push("description");
      }
      const typeName = optText(a, "issueType");
      if (typeName) {
        fields.issuetype = { id: pickIssueType(await w.client.createMetaIssueTypes(w.projectKey!), typeName, w.projectKey!).id };
        changed.push("issueType");
      }
      const files = optList(a, "attachments") ?? [];
      if (!changed.length && !files.length) throw new JiraToolError("nothing to change — pass at least one field");
      if (changed.length) {
        await w.client.editIssue(key, fields, Object.keys(update).length ? update : undefined);
        c.note("jira_issue_updated", { key, fields: changed.join(", ") }, `Jira: оновлено ${key} (${changed.join(", ")})`);
      }
      const uploaded = await upload(c, w, key, files);
      const warning = await c.mirror(w, key);
      return compact({ key, changed, attached: uploaded.attached, attachmentErrors: uploaded.failed, warning });
    },
  },
  {
    name: "jira_transition_issue",
    description:
      "Move an issue through its workflow to a status (or by transition name/id). Transition-screen fields such as resolution go in `fields`; an optional comment is added with it. Several hops (To Do → Done via In Progress) are several calls.",
    inputSchema: schema(
      {
        issueKey: ISSUE_KEY,
        to: str("Target status name, transition name, or transition id."),
        comment: str("Optional comment, markdown."),
        fields: { type: "object", description: "Transition-screen fields, raw Jira JSON — e.g. {\"resolution\": {\"name\": \"Done\"}}." },
      },
      ["issueKey", "to"],
    ),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const key = issueKey(a);
      const w = await c.where({ key });
      const to = reqText(a, "to");
      const lower = to.toLowerCase();
      const transitions = await w.client.listTransitions(key);
      const t =
        transitions.find((x) => x.id === to) ??
        transitions.find((x) => x.to.name.toLowerCase() === lower) ??
        transitions.find((x) => x.name.toLowerCase() === lower);
      if (!t)
        throw new JiraToolError(
          `${key} has no transition to ${JSON.stringify(to)} from its current status. Available now: ${transitions.map((x) => `${x.name} → ${x.to.name}`).join(", ") || "none"}`,
        );
      const comment = optText(a, "comment");
      const fields = optObject(a, "fields");
      await w.client.transition(key, t.id, { ...(fields ? { fields } : {}), ...(comment ? { comment: adfDoc(comment) } : {}) });
      c.note("jira_issue_transitioned", { key, status: t.to.name }, `Jira: ${key} → ${t.to.name}`);
      const warning = await c.mirror(w, key);
      return compact({ key, status: t.to.name, warning });
    },
  },
  {
    name: "jira_add_comment",
    description: "Add a comment (markdown) to an issue.",
    inputSchema: schema({ issueKey: ISSUE_KEY, body: str("Comment, markdown.") }, ["issueKey", "body"]),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const key = issueKey(a);
      const w = await c.where({ key });
      const { id } = await w.client.addComment(key, adfDoc(reqText(a, "body")));
      c.note("jira_comment_added", { key }, `Jira: коментар до ${key}`);
      return compact({ key, commentId: id, warning: await c.mirror(w, key) });
    },
  },
  {
    name: "jira_edit_comment",
    description: "Replace the text of an existing comment (id from jira_get_issue).",
    inputSchema: schema({ issueKey: ISSUE_KEY, commentId: str("Comment id."), body: str("New text, markdown.") }, ["issueKey", "commentId", "body"]),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const key = issueKey(a);
      const w = await c.where({ key });
      await w.client.updateComment(key, reqText(a, "commentId"), adfDoc(reqText(a, "body")));
      c.note("jira_comment_updated", { key }, `Jira: змінено коментар у ${key}`);
      return compact({ key, warning: await c.mirror(w, key) });
    },
  },
  {
    name: "jira_delete_comment",
    description: "Delete a comment. Only when the operator explicitly asked for it.",
    inputSchema: schema({ issueKey: ISSUE_KEY, commentId: str("Comment id.") }, ["issueKey", "commentId"]),
    annotations: { readOnlyHint: false, destructiveHint: true },
    run: async (c, a) => {
      const key = issueKey(a);
      const w = await c.where({ key });
      await w.client.deleteComment(key, reqText(a, "commentId"));
      c.note("jira_comment_deleted", { key }, `Jira: видалено коментар у ${key}`);
      return compact({ key, warning: await c.mirror(w, key) });
    },
  },
  {
    name: "jira_add_worklog",
    description: "Log work on an issue under the operator's account; the remaining estimate adjusts automatically.",
    inputSchema: schema(
      {
        issueKey: ISSUE_KEY,
        timeSpent: str("Jira duration, e.g. \"3h 20m\"."),
        started: str("When the work started (ISO date-time); default now."),
        comment: str("Optional note, markdown."),
      },
      ["issueKey", "timeSpent"],
    ),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const key = issueKey(a);
      const w = await c.where({ key });
      const timeSpent = reqText(a, "timeSpent");
      const comment = optText(a, "comment");
      const { id } = await w.client.addWorklog(key, {
        timeSpent,
        started: toJiraStarted(instant(a, "started") ?? new Date().toISOString()),
        ...(comment ? { comment: adfDoc(comment) } : {}),
        adjust: { mode: "auto" },
      });
      c.note("jira_worklog_added", { key, time: timeSpent }, `Jira: залоговано ${timeSpent} у ${key}`);
      return compact({ key, worklogId: id, warning: await c.mirror(w, key) });
    },
  },
  {
    name: "jira_create_issue_link",
    description:
      "Link two issues so that «issueKey <phrase> targetKey» reads true — e.g. issueKey=KRM-1, type=Blocks, targetKey=KRM-2 means KRM-1 blocks KRM-2. `type` may be a link type name or either of its phrases («is blocked by» flips the direction). Use it for dependencies and ordering in a series.",
    inputSchema: schema(
      {
        issueKey: ISSUE_KEY,
        type: str("Link type name (Blocks, Relates, Duplicate, Cloners…) or one of its phrases."),
        targetKey: str("The other issue's key."),
        comment: str("Optional comment, markdown."),
      },
      ["issueKey", "type", "targetKey"],
    ),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      let from = issueKey(a);
      let to = issueKey(a, "targetKey");
      const w = await c.where({ key: from });
      const want = reqText(a, "type").toLowerCase();
      const types = await w.client.issueLinkTypes();
      let type = types.find((t) => t.name.toLowerCase() === want || t.outward.toLowerCase() === want);
      if (!type) {
        type = types.find((t) => t.inward.toLowerCase() === want);
        if (type) [from, to] = [to, from];
      }
      if (!type)
        throw new JiraToolError(`No link type ${JSON.stringify(a.type)}. Available: ${types.map((t) => `${t.name} (${t.outward} / ${t.inward})`).join(", ")}`);
      const comment = optText(a, "comment");
      const send = (inwardKey: string, outwardKey: string) =>
        w.client.createIssueLink({ typeName: type.name, inwardKey, outwardKey, ...(comment ? { comment: adfDoc(comment) } : {}) });
      // Read back from `from`: an `outwardIssue` of `to` is «from <outward> to», the sentence
      // asked for. See `linkSourceIsInward` for why the first write of a process checks.
      const stored = async () =>
        (await w.client.issueLinks(from)).find(
          (l) => l.type.name === type.name && (l.outwardIssue?.key === to || l.inwardIssue?.key === to),
        );
      await (linkSourceIsInward === false ? send(to, from) : send(from, to));
      let link = await stored();
      if (link && linkSourceIsInward === undefined) {
        linkSourceIsInward = link.outwardIssue?.key === to;
        if (!linkSourceIsInward && type.inward !== type.outward) {
          await w.client.deleteIssueLink(link.id);
          await send(to, from);
          link = await stored();
        }
      }
      c.note("jira_link_created", { from, type: type.outward, to }, `Jira: ${from} ${type.outward} ${to}`);
      return compact({ linkId: link?.id, reads: `${from} ${type.outward} ${to}` });
    },
  },
  {
    name: "jira_remove_issue_link",
    description: "Remove an issue link by its id (from jira_get_issue `links`).",
    inputSchema: schema({ linkId: str("Link id."), board: BOARD }, ["linkId"]),
    annotations: { readOnlyHint: false, destructiveHint: true },
    run: async (c, a) => {
      const w = await c.where({ board: optText(a, "board") });
      const id = reqText(a, "linkId");
      await w.client.deleteIssueLink(id);
      c.note("jira_link_removed", { id }, `Jira: прибрано звʼязок ${id}`);
      return { removed: id };
    },
  },
  {
    name: "jira_create_remote_link",
    description: "Attach a web link (URL + title) to an issue — a spec, a design, a pull request.",
    inputSchema: schema({ issueKey: ISSUE_KEY, url: str("http(s) URL."), title: str("Link title.") }, ["issueKey", "url", "title"]),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const key = issueKey(a);
      const url = reqText(a, "url");
      if (!/^https?:\/\//i.test(url)) throw new JiraToolError("url must start with http:// or https://");
      const w = await c.where({ key });
      const { id } = await w.client.addRemoteLink(key, { url, title: reqText(a, "title") });
      c.note("jira_remote_link_added", { key, url }, `Jira: до ${key} додано посилання ${url}`);
      return { key, remoteLinkId: id };
    },
  },
  {
    name: "jira_add_watcher",
    description: "Add a watcher to an issue (display name, e-mail or accountId).",
    inputSchema: schema({ issueKey: ISSUE_KEY, user: str("Who.") }, ["issueKey", "user"]),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const key = issueKey(a);
      const w = await c.where({ key });
      const u = await anyUser(w.client, reqText(a, "user"));
      await w.client.addWatcher(key, u.accountId);
      c.note("jira_watcher_added", { key, user: u.name }, `Jira: ${u.name} стежить за ${key}`);
      return { key, watcher: u.name };
    },
  },
  {
    name: "jira_remove_watcher",
    description: "Remove a watcher from an issue.",
    inputSchema: schema({ issueKey: ISSUE_KEY, user: str("Who.") }, ["issueKey", "user"]),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const key = issueKey(a);
      const w = await c.where({ key });
      const u = await anyUser(w.client, reqText(a, "user"));
      await w.client.removeWatcher(key, u.accountId);
      c.note("jira_watcher_removed", { key, user: u.name }, `Jira: ${u.name} більше не стежить за ${key}`);
      return { key, removed: u.name };
    },
  },
  {
    name: "jira_add_attachment",
    description: "Upload files the operator attached to this conversation onto an issue, by their exact names.",
    inputSchema: schema({ issueKey: ISSUE_KEY, files: strs("File names as the turn lists them.") }, ["issueKey", "files"]),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const key = issueKey(a);
      const names = optList(a, "files") ?? [];
      if (!names.length) throw new JiraToolError("files is required");
      const w = await c.where({ key });
      const files = await upload(c, w, key, names);
      if (!files.attached.length) throw new JiraToolError(`nothing was attached: ${files.failed.join("; ")}`);
      return compact({ key, attached: files.attached, errors: files.failed, warning: await c.mirror(w, key) });
    },
  },
  {
    name: "jira_delete_issue",
    description: "Delete an issue and its sub-tasks. Irreversible — only when the operator explicitly asked to delete THIS issue.",
    inputSchema: schema({ issueKey: ISSUE_KEY }, ["issueKey"]),
    annotations: { readOnlyHint: false, destructiveHint: true },
    run: async (c, a) => {
      const key = issueKey(a);
      const w = await c.where({ key });
      const mirrored = w.boards.filter((b) => b.projectKey.toUpperCase() === projectOf(key));
      // Through the service when a board mirrors the project: it removes the mirror row too,
      // which is what drops the card from every open board at once.
      if (mirrored.length) {
        await c.jira.deleteIssue(mirrored[0]!.id, key, c.scope.userId);
        for (const b of mirrored.slice(1)) await c.jira.refreshIssue(b.id, key, c.scope.userId).catch(() => undefined);
      } else await w.client.deleteIssue(key);
      c.note("jira_issue_deleted", { key }, `Jira: видалено ${key}`);
      return { deleted: key };
    },
  },
  {
    name: "jira_create_sprint",
    description: "Create a sprint on a scrum board.",
    inputSchema: schema(
      {
        board: str("Connected board name/project key, or a numeric board id."),
        name: str("Sprint name."),
        startDate: str("ISO date-time (not in the past)."),
        endDate: str("ISO date-time."),
        goal: str("Sprint goal."),
      },
      ["board", "name"],
    ),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const { w, boardId } = await boardTarget(c, reqText(a, "board"));
      const s = await w.client.createSprint(
        compact({ boardId, name: reqText(a, "name"), startDate: instant(a, "startDate"), endDate: instant(a, "endDate"), goal: optText(a, "goal") }) as {
          boardId: number;
          name: string;
        },
      );
      c.note("jira_sprint_created", { name: s.name }, `Jira: створено спринт «${s.name}»`);
      return compact({ id: s.id, name: s.name, state: s.state });
    },
  },
  {
    name: "jira_update_sprint",
    description: "Rename, re-date, set the goal of, start (state=active) or close (state=closed) a sprint.",
    inputSchema: schema(
      {
        sprintId: int("Sprint id."),
        name: str("New name."),
        state: str("future | active | closed."),
        startDate: str("ISO date-time."),
        endDate: str("ISO date-time."),
        goal: str("Sprint goal."),
        board: BOARD,
      },
      ["sprintId"],
    ),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const w = await c.where({ board: optText(a, "board") });
      const id = optInt(a, "sprintId", 1, Number.MAX_SAFE_INTEGER)!;
      const state = optText(a, "state");
      if (state && !["future", "active", "closed"].includes(state)) throw new JiraToolError("state must be future, active or closed");
      const patch = compact({ name: optText(a, "name"), state, startDate: instant(a, "startDate"), endDate: instant(a, "endDate"), goal: optText(a, "goal") });
      if (!Object.keys(patch).length) throw new JiraToolError("nothing to change");
      const s = await w.client.updateSprint(id, patch);
      c.note("jira_sprint_updated", { name: s.name }, `Jira: оновлено спринт «${s.name}»`);
      return compact({ id: s.id, name: s.name, state: s.state, start: s.startDate, end: s.endDate });
    },
  },
  {
    name: "jira_add_issues_to_sprint",
    description: "Move issues (up to 50) into a sprint.",
    inputSchema: schema({ sprintId: int("Sprint id."), issueKeys: strs("Issue keys.") }, ["sprintId", "issueKeys"]),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const keys = keyList(a, "issueKeys");
      const id = optInt(a, "sprintId", 1, Number.MAX_SAFE_INTEGER)!;
      const w = await c.where({ key: keys[0]! });
      await w.client.moveToSprint(id, keys);
      c.note("jira_issues_moved_to_sprint", { keys: keys.join(", "), sprint: String(id) }, `Jira: ${keys.join(", ")} → спринт ${id}`);
      return { sprintId: id, moved: keys };
    },
  },
  {
    name: "jira_move_issues_to_backlog",
    description: "Move issues (up to 50) out of their sprint into the backlog.",
    inputSchema: schema({ issueKeys: strs("Issue keys.") }, ["issueKeys"]),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const keys = keyList(a, "issueKeys");
      const w = await c.where({ key: keys[0]! });
      await w.client.moveToBacklog(keys);
      c.note("jira_issues_moved_to_backlog", { keys: keys.join(", ") }, `Jira: ${keys.join(", ")} → беклог`);
      return { moved: keys };
    },
  },
  {
    name: "jira_create_version",
    description: "Create a version (release) in a project.",
    inputSchema: schema(
      {
        project: PROJECT,
        name: str("Version name."),
        description: str("Description."),
        startDate: str("YYYY-MM-DD."),
        releaseDate: str("YYYY-MM-DD."),
      },
      ["project", "name"],
    ),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const w = await c.where({ project: reqText(a, "project") });
      const project = await w.client.project(w.projectKey!);
      const v = await w.client.createVersion({
        projectId: project.id,
        name: reqText(a, "name"),
        ...compact({ description: optText(a, "description"), startDate: day(a, "startDate"), releaseDate: day(a, "releaseDate") }),
      });
      c.note("jira_version_created", { name: v.name, project: project.key }, `Jira: створено версію «${v.name}» у ${project.key}`);
      return compact({ ...v });
    },
  },
  {
    name: "jira_update_version",
    description: "Rename, re-date, describe, release or archive a version (id from jira_list_versions).",
    inputSchema: schema(
      {
        versionId: str("Version id."),
        name: str("New name."),
        description: str("Description."),
        startDate: str("YYYY-MM-DD."),
        releaseDate: str("YYYY-MM-DD."),
        released: bool("Mark released / unreleased."),
        archived: bool("Archive / unarchive."),
        board: BOARD,
      },
      ["versionId"],
    ),
    annotations: { readOnlyHint: false },
    run: async (c, a) => {
      const w = await c.where({ board: optText(a, "board") });
      const patch = compact({
        name: optText(a, "name"),
        description: optText(a, "description"),
        startDate: day(a, "startDate"),
        releaseDate: day(a, "releaseDate"),
        released: optBool(a, "released"),
        archived: optBool(a, "archived"),
      });
      if (!Object.keys(patch).length) throw new JiraToolError("nothing to change");
      const v = await w.client.updateVersion(reqText(a, "versionId"), patch);
      c.note("jira_version_updated", { name: v.name }, `Jira: оновлено версію «${v.name}»`);
      return compact({ ...v });
    },
  },
];

// A board argument: a connected board's name/project key (whose Agile board id the integration
// row holds), or any numeric board id jira_list_boards returned.
async function boardTarget(c: Call, board: string): Promise<{ w: Where; boardId: number }> {
  if (/^\d+$/.test(board)) return { w: await c.where({}), boardId: Number(board) };
  const w = await c.where({ board });
  const want = board.toLowerCase();
  const b = w.boards.find((x) => x.boardName.toLowerCase() === want || x.projectKey.toLowerCase() === want)!;
  return { w, boardId: b.boardId };
}

@Injectable()
export class JiraToolsService {
  private readonly byName = new Map(TOOLS.map((t) => [t.name, t]));

  constructor(private jira: JiraService) {}

  list(): JiraToolDescriptor[] {
    return TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
  }

  // One call → the text the model reads. Every failure comes back as `{ error }` text rather
  // than a throw: to MCP it is a tool error the model can act on, never a transport failure.
  async call(scope: JiraToolScope, name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    const tool = this.byName.get(name);
    if (!tool) return { text: `unknown tool ${name}`, isError: true };
    const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Args) : {};
    try {
      const out = await tool.run(new Call(this.jira, scope), a);
      return { text: JSON.stringify(out), isError: false };
    } catch (err) {
      if (err instanceof JiraHttpError)
        return {
          text:
            err.status === 401
              ? "Jira rejected the operator's personal token (401) — it must be replaced under Менеджмент → Integrations. Tell the operator; do not retry."
              : `Jira refused (${err.status}): ${err.message}`,
          isError: true,
        };
      return { text: (err as Error).message, isError: true };
    }
  }
}
