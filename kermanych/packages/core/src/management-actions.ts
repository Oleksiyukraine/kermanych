// packages/core/src/management-actions.ts
// The wire protocol between the Менеджмент assistant and the app.
//
// omp's RPC has no structured-output mode and no way to register a custom tool
// (apps/api/src/rpc/rpc-session.ts: the only outbound verbs are prompt/follow_up/steer),
// so the model's one channel back is prose. It therefore emits an action as a fenced block
// inside its answer and the app parses it out:
//
//     ```kermanych-action
//     { "kind": "unsupported", "section": "management-capacity", "request": "додай людину" }
//     ```
//
// Two rules make that safe rather than merely convenient:
//
//   * the app NEVER executes what it cannot validate — `parseManagementReply` returns only
//     actions that already type-check, and reports the rest as rejections the chat shows;
//   * an action that WRITES runs in the browser under the user's own JWT, so RLS decides
//     what a given member may actually change. A hallucinated action is refused by
//     Postgres, not by trust in the model.
//
// There are four action kinds. `unsupported` writes nothing and is the whole of the
// requirement «if the assistant cannot act on a page, it must say why» — every section
// whose ./management row is not `read_write` can only be answered with it. `risk.create`
// and `risk.update` are the write path into the Risk Registry (`workspace_risks`); they
// carry that schema's vocabulary, validated here against ./risks, so a category Postgres
// never heard of is refused in the browser with a sentence naming it rather than as a 400
// from PostgREST. `release.notes` is the write path into Release Notes, and the one action
// that is not a row insert: it asks the LOCAL api to write a document from a branch's git
// history and the browser then stores it, so what is validated here is the ask — a project,
// a branch and an inclusive calendar range.
import {
  isRiskCategory,
  isRiskKind,
  isRiskResponse,
  isRiskStatus,
  isTerminalRiskStatus,
  RISK_CATEGORY_VALUES,
  RISK_RESPONSES_BY_KIND,
  RISK_SCORE_MAX,
  RISK_SCORE_MIN,
  RISK_STATUS_VALUES,
  type RiskCategory,
  type RiskKind,
  type RiskResponse,
  type RiskStatus,
} from "./risks";
import { isReleaseDate } from "./release-notes";
import type { Usage } from "./types";
import type { Locale, ManagementRejection, Notice } from "./i18n-codes";
import { PLATFORMS, type Platform } from "./platform";
import { BRANCH_PREFIXES, type BranchPrefix } from "./worktree-names";

// The fence info string. Distinct from `json` on purpose: a model quoting example JSON in
// its prose must not be mistaken for an instruction to act.
export const MANAGEMENT_ACTION_FENCE = "kermanych-action";

// One risk as the assistant may state it. Deliberately NOT the whole of `WorkspaceRiskInsert`:
//
//   * `code`, `exposure`, `emv`, `residualExposure` and every audit column are minted by
//     Postgres (workspace_risks_touch), so nothing here can name them;
//   * `riskOwner` and `actionOwner` are profile uuids. A model cannot know one, and a
//     guessed uuid is either a foreign-key error or — worse — somebody else. Owners are
//     assigned on the screen, and the prompt says so.
export type ManagementRiskFields = {
  kind: RiskKind;
  category: RiskCategory;
  // cause -> event -> consequence, all three required and non-blank: the difference between
  // a register that can be scored and a list of worries.
  cause: string;
  event: string;
  consequence: string;
  probability: number;
  impact: number;
  response: RiskResponse;
  // Required unless the strategy is `accept` — «monitor» is not a response.
  responseActions: string;
  earlyWarning?: string;
  // ISO calendar date, YYYY-MM-DD.
  proximity?: string;
  actionDue?: string;
  // The quantitative lane: both halves or neither, or the EMV is a made-up number.
  costImpact?: number;
  probabilityPct?: number;
  // The score after the response lands: both halves or neither.
  residualProbability?: number;
  residualImpact?: number;
  status?: RiskStatus;
  // Required by `status`, not by this type: a terminal status without a reason is refused.
  closureNote?: string;
};

// Every field optional, because an update names only what changes. `null` is not accepted:
// clearing a column is a screen operation, and a model that means «unchanged» writes null
// far more often than it means «erase this».
export type ManagementRiskPatch = Partial<ManagementRiskFields>;

// ── Tickets ───────────────────────────────────────────────────────────────────

// One ticket, in the five slots a project manager's ticket actually has.
//
// The fields are NAMED rather than handed over as one `description` blob, and that split is
// the whole mechanism behind the requirement that a ticket filed from this chat reads like a
// senior manager wrote it:
//
//   * a blob satisfies «business context, user flow, acceptance criteria» on the turn it is
//     asked for and forgets it on the next one, while a record with these slots cannot be
//     filed at all without `context` and at least one acceptance criterion;
//   * `renderTicketDescription` is the ONLY thing that turns them into prose, so the
//     headings, their order and their language belong to the app — every ticket on the board
//     therefore has the same shape whichever turn produced it. They are English for the
//     reason the slots they head are (`ticketProtocol`, «МОВА ТІКЕТА»): a card whose body is
//     English under Ukrainian headings is one ticket written in two languages;
//   * every slot is business-facing by construction. There is no field for a design, a
//     schema, a library or a migration, which is how «a ticket states no technical
//     decisions» stops being an instruction the model may drift from and becomes a shape it
//     cannot express.
//
// Voice is the one part of that requirement no type can hold, so it is stated in the prompt
// (`ticketProtocol`) — and `openQuestion` below refuses the failure voice alone would let
// through: a ticket that ships the assistant's own uncertainty to whoever picks it up.
export type ManagementTicketFields = {
  // One line. Not a summary of the body — the string that has to be recognisable in a
  // kanban column.
  title: string;
  // WHY this work exists and for whom, in business terms. Required: a ticket without it is
  // an instruction, and an instruction is what a manager's ticket is specifically not.
  context: string;
  // The user-visible flow, one step per entry. Optional, because not every ticket is a
  // journey — «зібрати пакет рахунків за вересень» has no screens — and an invented flow is
  // worse than an absent one.
  userFlow?: string[];
  // What must be observably true before the ticket may be closed. At least one, and each a
  // statement somebody can check without reading code.
  acceptanceCriteria: string[];
  // What this ticket deliberately does NOT cover, so its scope is stated rather than
  // assumed. Optional.
  outOfScope?: string[];
};

// The body of a ticket, rendered once and identically for both boards.
//
// Markdown, because `tasks.description` is rendered as markdown on «Дошка»; the Jira path
// feeds the same string to the api, which splits it into ADF paragraphs, so the headings
// survive as lines there too. One renderer rather than two: a ticket that reads differently
// depending on which board it landed on is the same defect as two section tables.
export function renderTicketDescription(t: ManagementTicketFields): string {
  const out: string[] = ["## Context", t.context];
  if (t.userFlow?.length) {
    out.push("", "## User flow");
    t.userFlow.forEach((step, i) => out.push(`${i + 1}. ${step}`));
  }
  out.push("", "## Acceptance criteria");
  for (const c of t.acceptanceCriteria) out.push(`- [ ] ${c}`);
  if (t.outOfScope?.length) {
    out.push("", "## Out of scope");
    for (const s of t.outOfScope) out.push(`- ${s}`);
  }
  return out.join("\n");
}

export type ManagementAction =
  // The model was asked to change a section that cannot be changed. It reports WHICH
  // section and WHAT was asked; the reason shown to the user is read from the section
  // table (./management `limitation`), never from the model. That is what keeps the
  // refusal honest when the model would rather be agreeable.
  | { kind: "unsupported"; section: string; request: string }
  // Add one row to the project's risk register.
  | { kind: "risk.create"; risk: ManagementRiskFields }
  // Change one, named by the register code the operator sees (`R-003`) — never by uuid,
  // which the model has no honest way to know and every way to invent.
  | { kind: "risk.update"; code: string; patch: ManagementRiskPatch }
  // Remove one from the register entirely, named by the same register code `risk.update`
  // names. This is a HARD delete: the row goes, and `workspace_risk_events` follows it
  // through `on delete cascade`, so the risk's audit trail goes with it.
  //
  // It carries no other field on purpose. A delete has nothing to shape — there is no
  // patch to validate and no body to state — and a `reason` here would be a string written
  // into nothing, since the row that would have held it is the row being removed. The
  // operator's reason lives in the chat transcript, which survives the risk.
  //
  // Note this is the one risk action whose RLS gate is narrower than the register's own:
  // insert and update are workspace-member, delete is workspace-OWNER. A member who asks
  // the assistant to delete gets a postgrest refusal printed verbatim into the transcript
  // rather than a silent no-op — see the executor in stores/management-chat.ts.
  | { kind: "risk.delete"; code: string }
  // Write a new release note for one project of the workspace and store it. The project is
  // named the way the model was shown it — by NAME, in the prompt's repository list — for
  // the reason `risk.update` names a register code: a uuid is something the model has no
  // honest way to know and every way to invent, and the browser holds the list to resolve
  // it against. The branch and the inclusive range are the operator's own words, so this
  // action carries nothing the chat could not have been told.
  | { kind: "release.notes"; project: string; branch: string; rangeFrom: string; rangeTo: string }
  // File one card on the workspace's own board — «Дошка» → «Задачі», which is `tasks` rows
  // and therefore the DEFAULT board: it is the one that always exists, needs no integration
  // and no personal token, and every member of the workspace can already see it. A request
  // that does not name a board lands here, and `jira.ticket.create` is emitted only when the
  // operator named Jira — that asymmetry is the routing rule, expressed as two kinds rather
  // than one `board` field, because the two boards genuinely take different fields and a
  // single kind with everything optional would validate to no discipline at all.
  //
  // `project` is a NAME from the prompt's repository list, for the reason `release.notes`
  // names one: a card belongs to exactly one `projects` row, a uuid is something the model
  // has no honest way to know and every way to invent, and the browser holds the list to
  // resolve it against. `assignee` is likewise a name off the roster printed in the context
  // block — `tasks.assignee_id` is a profile uuid, and a guessed one is either a
  // foreign-key error or, worse, somebody else's queue.
  //
  // `prefix` and `platform` are the two launch hints a manager legitimately knows (this is
  // a fix, this is mobile). Everything else the board's own form offers — model, effort,
  // base branch, worktree — is a launch decision, which is exactly the kind of technical
  // decision a ticket from this surface must not carry.
  | {
      kind: "ticket.create";
      project: string;
      ticket: ManagementTicketFields;
      assignee?: string;
      prefix?: BranchPrefix;
      platform?: Platform;
      // NAMES of the operator's attached files, accepted here and honoured NOWHERE: `tasks`
      // has no attachment storage, so a card on this board cannot carry a file. It is parsed
      // rather than dropped because dropping it is silent — the operator asked for a ticket
      // WITH a file, and «тікет створено» beside a file nobody mentioned again is the
      // failure this field exists to make visible. The executor files the card and says the
      // files stayed in the chat.
      attachments?: string[];
    }
  // File one issue on the workspace's mirrored Jira board. No `project`: the Jira project
  // key comes from the workspace's integration row, so there is nothing here for the model
  // to choose or mistake. `issueType` and `priority` are NAMES («Task», «Bug», «High»)
  // because their Jira ids are not mirrored — jira_issues keeps only the display name — so
  // the browser resolves them against the live editor options; omitting them lets the Jira
  // project's own defaults apply, which is the honest answer when the operator did not say.
  | {
      kind: "jira.ticket.create";
      ticket: ManagementTicketFields;
      issueType?: string;
      priority?: string;
      labels?: string[];
      assignee?: string;
      // An existing key on the mirrored board, when the operator asked for a subtask.
      parentKey?: string;
      // NAMES of files the operator attached to the conversation («долучені файли» in the
      // context of the turn) that should be uploaded onto the created issue — stated only
      // when the operator asked for it. Names, not bytes: the browser holds the attached
      // files and resolves each name back to the payload it already has, so the model can
      // never invent content — an unknown name is refused with the file left unattached.
      attachments?: string[];
    }
  // The ticket was NOT written, because writing it would have required the assistant to
  // decide something only the operator can. Writes nothing — its whole job is to make the
  // app state that, in the app's own voice, exactly as `unsupported` does for a section that
  // cannot be changed.
  //
  // It exists because the requirement has two halves and prose only covers the first: an
  // assistant with open questions must ASK them, and until they are answered the ticket must
  // not be created. A question buried in a paragraph is easy to read past, and the operator
  // then waits for a card that was never filed. This way the transcript carries one
  // unmistakable line — «тікет не створено, очікую відповіді» — beside the numbered
  // questions, and the next turn either answers them or the ticket stays unfiled.
  | { kind: "ticket.questions"; forTicket: string; questions: string[] };

export type ManagementActionKind = ManagementAction["kind"];
export type ManagementUnsupported = Extract<ManagementAction, { kind: "unsupported" }>;
export type ManagementRiskCreate = Extract<ManagementAction, { kind: "risk.create" }>;
export type ManagementRiskUpdate = Extract<ManagementAction, { kind: "risk.update" }>;
export type ManagementRiskDelete = Extract<ManagementAction, { kind: "risk.delete" }>;
export type ManagementReleaseNotes = Extract<ManagementAction, { kind: "release.notes" }>;
export type ManagementTicketCreate = Extract<ManagementAction, { kind: "ticket.create" }>;
export type ManagementJiraTicketCreate = Extract<ManagementAction, { kind: "jira.ticket.create" }>;
export type ManagementTicketQuestions = Extract<ManagementAction, { kind: "ticket.questions" }>;

// ── Ask / reply ───────────────────────────────────────────────────────────────

// One project of the scoped workspace, as the BROWSER knows it. The split is deliberate and
// it is the whole reason this type exists instead of a bare `string[]`: `gitRemoteUrl` lives
// only on the cloud row (`CloudProject`) and is never mirrored into the local registry, while
// the on-disk path lives only in that registry and must never be taken from a client. So each
// side sends what only it can know, and the api joins them by id.
export type ManagementWorkspaceProject = {
  id: string;
  gitRemoteUrl?: string;
};

// One file the operator attached to a chat turn: the display name (also the name the model
// may quote back in `jira.ticket.create.attachments`), the mime type and the raw base64
// payload. Images reach the model natively through omp's image slots; everything else the
// api writes to disk so the read tool can open it.
export type ManagementAttachment = {
  name: string;
  mimeType: string;
  data: string;
};

// One repository of the scoped workspace, as the api resolved it from its LOCAL registry.
// Paths are never taken from the client: the browser sends project ids, the api joins them
// against `~/.kermanych/kermanych.sqlite`, so the prompt cannot be talked into naming a
// directory the operator never bound.
export type ManagementRepo = {
  projectId: string;
  name: string;
  // Absolute path on this machine, empty when the project is not bound here. The assistant
  // gets read-only tools (read/grep/glob) and one --cwd, so it reaches the other repos of
  // the workspace by absolute path.
  localRepoPath: string;
  gitRemoteUrl?: string;
  defaultBranch?: string;
  conventions?: string;
};

// One row of the register as the assistant is shown it: enough to say «this is already
// filed as R-004» and to name a row it wants to update, and no more. The full statement,
// the owners and the audit trail stay on the screen — a prompt that carried the whole
// register would spend the operator's plan re-reading columns the model cannot write.
//
// It travels on the ASK rather than being read by the api, because `workspace_risks` is
// behind RLS and the browser holds the user's JWT. The api has no cloud credentials for it
// and must not grow any: what the assistant may see is exactly what the operator may see.
export type ManagementRiskRow = {
  code: string;
  kind: RiskKind;
  category: RiskCategory;
  // The middle part of the statement — the uncertain event itself, which is what makes a
  // row recognisable in one line.
  event: string;
  probability: number;
  impact: number;
  response: RiskResponse;
  status: RiskStatus;
};

// One teammate of the scoped workspace, as the assistant is shown them: the name the app
// itself renders (`lib/members.ts handleOf` — github handle, then display name, then the raw
// id) and their role.
//
// It exists so a ticket can be ASSIGNED. `tasks.assignee_id` is a profile uuid and the model
// has no honest way to know one, so the operator's «на Олю» has to be matched against a list
// the assistant can actually see, and the browser resolves the name it picked back to the id
// it never sent. The role travels because a manager assigns by it («віддай розробнику»), and
// because it is one word.
//
// Like the register, it travels on the ASK rather than being read by the api:
// `workspace_members` is behind RLS and the browser holds the JWT, so what the assistant may
// see is exactly what the operator may see.
export type ManagementMember = {
  name: string;
  // `owner | manager | developer` as the cloud spells it. A plain string here rather than
  // the union, because that union lives in @kermanych/cloud, which depends on THIS package.
  role: string;
};

// The workspace's mirrored Jira board, when it has one — the second board a ticket may be
// filed on, and the only one that can be absent.
//
// Both flags matter and they fail differently. No integration row at all: there is no Jira
// board in this workspace and the assistant must say so rather than quietly filing on the
// native one. An integration but no personal token on THIS machine: the board is visible and
// unwritable, because every Jira write is signed with the acting user's own token from the
// local registry — and «I created it» would be a lie one round trip later.
export type ManagementJiraBoard = {
  // Jira's project key (`KRM`) — the prefix of every key on that board, so the assistant can
  // recognise a key the operator quotes at it.
  projectKey: string;
  boardName: string;
  // Whether this operator has a Jira token on this machine.
  canWrite: boolean;
  // Who JIRA says may be assigned an issue on this project, by display name — Jira's own
  // assignee picker, the same list the ticket dialog offers.
  //
  // Deliberately NOT `members`, and that distinction is the whole point of this field. A Jira
  // assignee is an Atlassian account on that site; a `ManagementMember` is somebody who can
  // sign into Kermanych. The two sets merely overlap, so naming a Jira assignee from the
  // roster refuses exactly the people the operator can see in Jira — a designer with a Jira
  // seat and no Kermanych account is assignable in Jira and absent from every roster.
  //
  // Names only, no `accountId`: the model is never given an opaque id it could invent, and
  // the browser matches the name it chose back to an id against Jira's live list — the same
  // shape as the roster, where the uuid never reaches the prompt either.
  //
  // Empty means the list could not be read this turn (no token on this machine, or Jira was
  // unreachable), which the context block states rather than hides: an empty list read as
  // «nobody is assignable» would be a refusal invented out of a network failure.
  assignees: string[];
};

// One week of somebody's (or everybody's) capacity, in hours with one decimal. `week` is
// the Monday, YYYY-MM-DD. Past weeks carry `loggedH` (worklogs), future weeks `plannedH`
// (remaining estimates spread to their due dates); the current week carries both.
export type ManagementCapacityWeek = { week: string; capacityH: number; plannedH: number; loggedH: number };

// One Jira assignee. `name` blank = the unassigned bucket. Not a `ManagementMember`: the
// estimates belong to Jira accounts, and the two rosters only overlap.
export type ManagementCapacityPerson = {
  name: string;
  weeks: ManagementCapacityWeek[];
  openIssues: number;
  unscheduled: number;
  overdue: number;
};

// The Team Capacity digest: a fixed window of weeks around today, computed in the browser by
// the same function the screen renders (apps/ui/src/lib/capacity.ts), so the assistant's
// numbers are the screen's. Travels on the ask like the register: the mirror is behind RLS.
export type ManagementCapacity = {
  from: string;
  to: string;
  hoursPerDay: number;
  team: ManagementCapacityWeek[];
  persons: ManagementCapacityPerson[];
  unscheduled: number;
  overdue: number;
};

export type ManagementContext = {
  workspaceName: string;
  // Deliberately NO project name. Nothing on this surface states a «current project» any
  // more: a transcript outlives the selection that opened it, so a line naming one project
  // would be lying about its own scope the moment the operator moved on — while
  // `ManagementRepo[]` already names every project of the group, which is the honest
  // answer to «which of our repos does this affect».
  //
  // Active section, by route name — the assistant answers "about this screen" first.
  section: string;
  // The project's risk register as it stands THIS turn. Re-sent every turn rather than once
  // with the contract: the register changes between turns — not least because the assistant
  // itself just wrote to it — and a stale copy is how it files a duplicate of R-004 or
  // updates a code that no longer means what it did.
  risks: ManagementRiskRow[];
  // The workspace roster, for assigning a ticket on the NATIVE board — and only there.
  // `tasks.assignee_id` is a profile uuid, so this is the set of people that board can name;
  // a Jira issue is assigned from `jira.assignees` instead. Re-sent every turn for the
  // register's reason: membership changes, and a name the assistant remembers from turn one
  // is a foreign-key error on turn nine.
  members: ManagementMember[];
  // The mirrored Jira board, absent when the workspace has none. Absent means the assistant
  // may not offer Jira at all — which is also why this is context and not contract: an
  // integration connected mid-conversation must reach the model on the next turn.
  jira?: ManagementJiraBoard;
  // Team Capacity, present only when the workspace has a Jira board. Re-sent every turn:
  // estimates move between turns.
  capacity?: ManagementCapacity;
};

export type ManagementChatAsk = {
  // One conversation per scoped WORKSPACE (`management:<workspaceId>`): switching workspace
  // in the sidebar switches conversation, which is also what the user sees happen on screen.
  // The level matches the subject — the register, the membership and the repositories the
  // assistant reads all belong to the group, not to one of its projects.
  conversationId: string;
  workspaceId: string;
  // Every project of the scoped workspace. The api turns these into `ManagementRepo[]`;
  // ids the local registry does not know are dropped, not guessed.
  workspaceProjects: ManagementWorkspaceProject[];
  text: string;
  context: ManagementContext;
  // Files the operator attached to THIS turn. Images reach the model through omp's own
  // image slots; documents are written to disk by the api and named in the turn so the
  // read tool can open them. Optional: an old client that omits it keeps the previous
  // behaviour.
  attachments?: ManagementAttachment[];
  // The operator's active UI locale, threaded into the model prompt so the answer is
  // written in it (management-prompt.ts rule ґ). Optional and defaulting to uk: an old
  // client that omits it keeps the previous behaviour.
  locale?: Locale;
};

export type ManagementChatReply = {
  // The model's prose, with the action blocks removed.
  text: string;
  actions: ManagementAction[];
  // One entry per action block that did not validate. Shown in the chat: a silently dropped
  // instruction is how an operator ends up believing something was recorded. Each carries a
  // localizable `code`+`params` and the Ukrainian `text` as the fallback the UI degrades to.
  rejected: ManagementRejection[];
  // omp notices raised during the turn (dropped frames, provider warnings, a cancelled
  // interactive prompt).
  notices: Notice[];
  // What the turn cost on the connected plan. This chat runs through the same `omp` binary,
  // the same provider account and the same subscription as every agent, so a turn here is a
  // turn debited there — and the composer says so.
  usage?: Usage;
  model?: string;
  ms: number;
};

// ── Parsing ───────────────────────────────────────────────────────────────────

export type ParsedManagementReply = {
  text: string;
  actions: ManagementAction[];
  rejected: ManagementRejection[];
};

// Fenced blocks whose info string is exactly our fence. `[^\S\n]*` rather than `\s*` so a
// blank line cannot be eaten as part of the info string.
const BLOCK_RE = new RegExp(
  "^[^\\S\\n]*```" + MANAGEMENT_ACTION_FENCE + "[^\\S\\n]*\\n([\\s\\S]*?)\\n?[^\\S\\n]*```[^\\S\\n]*$",
  "gm",
);

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

// A calendar date, which is what `proximity` and `action_due` are in Postgres. A timestamp
// or «наступного місяця» is refused here rather than becoming a date PostgREST guessed at.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// JSON numbers, and the quoted ones a model writes about as often. Coercing "4" is not
// leniency about a wrong value — it is the same value, and the alternative is refusing a
// well-formed risk over its quotation marks.
function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string" || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// A validation failure. `error` is a full `ManagementRejection`: the Ukrainian sentence as
// `text` (byte-identical to what the chat showed before codes existed, so it stays the
// fallback), plus the `code`+`params` the UI localizes.
type Fail = { error: ManagementRejection };

function isFail(v: unknown): v is Fail {
  return typeof v === "object" && v !== null && "error" in v;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Present means «the model said something about this field». `null` is treated as absent:
// a model writes `null` for «I have no value» far more often than for «erase the column»,
// and clearing a column is a screen operation.
function has(o: Record<string, unknown>, key: string): boolean {
  return o[key] !== undefined && o[key] !== null;
}

// Every field the model may state about a risk, validated one by one against ./risks and
// against the CHECK constraints the register table carries (written in
// 20260830120000_project_risks.sql, renamed with the table by 20260830140000_workspace_risks.sql).
// Shared by create and update: an update states a subset of exactly the same vocabulary.
//
// The cross-field rules that need two values are checked only when both are present — a
// patch that changes `response` alone cannot be matched against a `kind` it did not send,
// and Postgres still owns the final word.
function riskPatch(o: Record<string, unknown>): ManagementRiskPatch | Fail {
  const p: ManagementRiskPatch = {};

  if (has(o, "kind")) {
    if (!isRiskKind(o.kind))
      return {
        error: {
          text: `невідомий тип ризику ${JSON.stringify(o.kind)} (threat або opportunity)`,
          code: "risk_kind_unknown",
          params: { value: JSON.stringify(o.kind) },
        },
      };
    p.kind = o.kind;
  }
  if (has(o, "category")) {
    if (!isRiskCategory(o.category))
      return {
        error: {
          text: `невідома категорія ризику ${JSON.stringify(o.category)} — допустимі: ${RISK_CATEGORY_VALUES.join(", ")}`,
          code: "risk_category_unknown",
          params: { value: JSON.stringify(o.category), allowed: RISK_CATEGORY_VALUES.join(", ") },
        },
      };
    p.category = o.category;
  }
  if (has(o, "response")) {
    if (!isRiskResponse(o.response))
      return {
        error: {
          text: `невідома стратегія реагування ${JSON.stringify(o.response)}`,
          code: "risk_response_unknown",
          params: { value: JSON.stringify(o.response) },
        },
      };
    p.response = o.response;
  }
  if (has(o, "status")) {
    if (!isRiskStatus(o.status))
      return {
        error: {
          text: `невідомий статус ризику ${JSON.stringify(o.status)} — допустимі: ${RISK_STATUS_VALUES.join(", ")}`,
          code: "risk_status_unknown",
          params: { value: JSON.stringify(o.status), allowed: RISK_STATUS_VALUES.join(", ") },
        },
      };
    p.status = o.status;
  }

  // The statement's three parts. Blank is not «unset» here: the schema refuses a blank
  // cause, event or consequence, because that is what separates a scoreable risk from a worry.
  for (const key of ["cause", "event", "consequence"] as const) {
    if (!has(o, key)) continue;
    const t = str(o[key]);
    if (t === undefined)
      return { error: { text: `поле ${key} не може бути порожнім`, code: "risk_field_blank", params: { field: key } } };
    p[key] = t;
  }

  // Free text that MAY legitimately be emptied by an update (a cleared trigger note), so a
  // blank string is kept rather than refused.
  for (const key of ["responseActions", "earlyWarning", "closureNote"] as const) {
    if (!has(o, key)) continue;
    if (typeof o[key] !== "string")
      return { error: { text: `поле ${key} має бути текстом`, code: "risk_field_not_text", params: { field: key } } };
    p[key] = (o[key] as string).trim();
  }

  for (const key of ["probability", "impact", "residualProbability", "residualImpact"] as const) {
    if (!has(o, key)) continue;
    const n = num(o[key]);
    if (n === undefined || !Number.isInteger(n) || n < RISK_SCORE_MIN || n > RISK_SCORE_MAX)
      return {
        error: {
          text: `поле ${key} має бути цілим числом ${RISK_SCORE_MIN}–${RISK_SCORE_MAX}, а не ${JSON.stringify(o[key])}`,
          code: "risk_score_range",
          params: { field: key, min: RISK_SCORE_MIN, max: RISK_SCORE_MAX, value: JSON.stringify(o[key]) },
        },
      };
    p[key] = n;
  }

  if (has(o, "probabilityPct")) {
    const n = num(o.probabilityPct);
    if (n === undefined || !Number.isInteger(n) || n < 0 || n > 100)
      return {
        error: {
          text: `probabilityPct має бути цілим числом 0–100, а не ${JSON.stringify(o.probabilityPct)}`,
          code: "probability_pct_range",
          params: { value: JSON.stringify(o.probabilityPct) },
        },
      };
    p.probabilityPct = n;
  }
  if (has(o, "costImpact")) {
    const n = num(o.costImpact);
    if (n === undefined || n < 0)
      return {
        error: {
          text: `costImpact має бути невідʼємним числом, а не ${JSON.stringify(o.costImpact)}`,
          code: "cost_impact_negative",
          params: { value: JSON.stringify(o.costImpact) },
        },
      };
    p.costImpact = n;
  }

  for (const key of ["proximity", "actionDue"] as const) {
    if (!has(o, key)) continue;
    const t = str(o[key]);
    if (t === undefined || !DATE_RE.test(t))
      return {
        error: {
          text: `поле ${key} має бути датою РРРР-ММ-ДД, а не ${JSON.stringify(o[key])}`,
          code: "risk_date_format",
          params: { field: key, value: JSON.stringify(o[key]) },
        },
      };
    p[key] = t;
  }

  // workspace_risks_response_matches_kind, checked here so the operator reads «reduce не
  // застосовується до можливості» instead of a Postgres constraint name.
  if (p.kind !== undefined && p.response !== undefined && !RISK_RESPONSES_BY_KIND[p.kind].includes(p.response))
    return {
      error: {
        text: `стратегія ${p.response} не застосовується до ${p.kind} — допустимі: ${RISK_RESPONSES_BY_KIND[p.kind].join(", ")}`,
        code: "risk_response_kind_mismatch",
        params: { response: p.response, kind: p.kind, allowed: RISK_RESPONSES_BY_KIND[p.kind].join(", ") },
      },
    };
  // workspace_risks_closure_note_required. Demanded from the SAME action that closes the risk:
  // a terminal status is the one write that must arrive with its reason attached.
  if (p.status !== undefined && isTerminalRiskStatus(p.status) && !(p.closureNote ?? ""))
    return {
      error: {
        text: `статус ${p.status} потребує closureNote — причини закриття або плану по інциденту`,
        code: "risk_closure_note_required",
        params: { status: p.status },
      },
    };
  // workspace_risks_emv_pair and workspace_risks_residual_pair: both halves or neither.
  if ((p.costImpact === undefined) !== (p.probabilityPct === undefined))
    return {
      error: {
        text: "costImpact і probabilityPct вказуються разом — EMV з половини пари є вигаданим числом",
        code: "emv_pair_required",
      },
    };
  if ((p.residualProbability === undefined) !== (p.residualImpact === undefined))
    return {
      error: { text: "residualProbability і residualImpact вказуються разом", code: "residual_pair_required" },
    };

  return p;
}

// The fields a register row cannot exist without. Everything else has a schema default or is
// genuinely optional; owners are not here because a model cannot know a profile uuid.
const RISK_REQUIRED = ["kind", "category", "cause", "event", "consequence", "probability", "impact", "response"] as const;

// ── Ticket validation ─────────────────────────────────────────────────────────

// A title has to fit a kanban card and be recognisable in a column. The number is not a
// database limit (`tasks.title` is `text`) — it is the line between a title and a paragraph,
// and a model handed a slot called `title` will happily put the whole ticket in it.
const TICKET_TITLE_MAX = 120;

// A list field, as the model may state it. Blank entries are dropped rather than refused —
// a trailing empty string in a JSON array is a formatting slip, not a wrong ticket — but the
// key having the wrong TYPE is refused, because a `string` where a list belongs means the
// model packed several criteria into one line and the ticket would lose their separation.
function strList(v: unknown, field: string): string[] | Fail {
  if (!Array.isArray(v))
    return { error: { text: `поле ${field} має бути списком рядків`, code: "field_not_string_list", params: { field } } };
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string")
      return {
        error: {
          text: `поле ${field} має містити лише рядки, а не ${JSON.stringify(item)}`,
          code: "field_list_not_all_strings",
          params: { field, value: JSON.stringify(item) },
        },
      };
    const t = item.trim();
    if (t !== "") out.push(t);
  }
  return out;
}

// The markers of an unanswered question, and the reason this is a hard refusal rather than a
// line in the prompt: the rule is that a ticket which reaches a board contains NO open
// questions. A model told that follows it most of the time, and the exception is exactly the
// case that costs the most — a card whose acceptance criterion says «TBD» is unusable by
// whoever picks it up, and nobody re-reads a ticket they were told was written for them.
//
// Each entry is a shape a model actually produces, in BOTH languages a ticket can reach here
// in: the ticket's own text is English by default (`ticketProtocol`, «МОВА ТІКЕТА») and
// Ukrainian when the operator asked for it, so a list tuned to one of them would quietly stop
// catching half the cases. Deliberately narrow on both sides: «уточнити» on its own is
// ordinary Ukrainian («користувач може уточнити фільтр») and «clarify» on its own is ordinary
// English, so only the forms that hand the decision to somebody else are listed. The refusal
// quotes the fragment that matched, so a false positive is visible and re-askable rather than
// mysterious.
const OPEN_QUESTION_MARKERS: readonly RegExp[] = [
  /\b(?:TBD|TBC|TODO|FIXME|XXX)\b/i,
  /\?{2,}/,
  /<\s*(?:\?|\.{2,}|тут|назва|значення|value|placeholder)\s*>/i,
  /\[\s*(?:\?|\.{2,}|—|-)\s*\]/,
  /(?:потрібно|потрібен|треба|потребує|варто|слід)\s+(?:буде\s+)?уточн/i,
  /незрозуміл|під питанням|питання до|на розсуд/i,
  /to be (?:defined|decided|determined|discussed|confirmed|clarified|specified|agreed)/i,
  /open question|\bunclear\b/i,
  /(?:needs?|need to be|needed|requires?|pending)\s+(?:further\s+)?clarif/i,
  /(?:at|left to)\s+(?:the\s+)?(?:\w+\s+)?discretion\b/i,
  // A code fence in a ticket is the assistant slipping out of the manager's voice: this
  // surface files business tickets, and a snippet is a technical decision in the only form a
  // string can hold one.
  /```/,
];

// The offending fragment, or `undefined` when the ticket is answerable as written. Every
// string the ticket carries is scanned — a question in a field nobody looked at is still a
// question the person who picks the card up cannot answer.
function openQuestion(t: ManagementTicketFields): string | undefined {
  for (const line of [t.title, t.context, ...(t.userFlow ?? []), ...t.acceptanceCriteria, ...(t.outOfScope ?? [])])
    for (const re of OPEN_QUESTION_MARKERS) {
      const m = re.exec(line);
      if (m) return m[0];
    }
  // No marker above catches «Чи має адміністратор бачити архів?» — a perfectly formed
  // sentence that simply cannot be checked off or walked through. A step or a criterion that
  // ends in a question mark IS the open question this whole rule is about.
  return [...t.acceptanceCriteria, ...(t.userFlow ?? [])].find((l) => l.endsWith("?"));
}

// One ticket, validated into the five slots. Shared by both boards: a Jira issue and a board
// card differ in where they go and in the vocabulary AROUND the ticket (issue type, branch
// prefix), never in what makes the ticket readable — so there is one shape, one set of
// refusals, and no board on which a worse ticket is acceptable.
function ticketFields(v: unknown): ManagementTicketFields | Fail {
  if (!isObj(v)) return { error: { text: "дія без об'єкта ticket", code: "ticket_not_object" } };
  const title = str(v.title);
  if (title === undefined) return { error: { text: "тікет без назви (title)", code: "ticket_no_title" } };
  if (title.length > TICKET_TITLE_MAX)
    return {
      error: {
        text: `назва тікета довша за ${TICKET_TITLE_MAX} символів — це вже опис, а не назва`,
        code: "ticket_title_too_long",
        params: { max: TICKET_TITLE_MAX },
      },
    };
  const context = str(v.context);
  if (context === undefined)
    return {
      error: {
        text: `тікет «${title}» без бізнес-контексту (context) — навіщо ця робота і кому вона потрібна`,
        code: "ticket_no_context",
        params: { title },
      },
    };

  const acceptanceCriteria = strList(has(v, "acceptanceCriteria") ? v.acceptanceCriteria : [], "acceptanceCriteria");
  if (isFail(acceptanceCriteria))
    return {
      error: {
        text: `тікет «${title}»: ${acceptanceCriteria.error.text}`,
        code: "ticket_field_invalid",
        params: { title, detail: acceptanceCriteria.error.text },
      },
    };
  if (acceptanceCriteria.length === 0)
    return {
      error: {
        text: `тікет «${title}» без критеріїв приймання (acceptanceCriteria) — немає за чим його закривати`,
        code: "ticket_no_acceptance",
        params: { title },
      },
    };

  const t: ManagementTicketFields = { title, context, acceptanceCriteria };

  if (has(v, "userFlow")) {
    const flow = strList(v.userFlow, "userFlow");
    if (isFail(flow))
      return {
        error: {
          text: `тікет «${title}»: ${flow.error.text}`,
          code: "ticket_field_invalid",
          params: { title, detail: flow.error.text },
        },
      };
    if (flow.length) t.userFlow = flow;
  }
  if (has(v, "outOfScope")) {
    const out = strList(v.outOfScope, "outOfScope");
    if (isFail(out))
      return {
        error: {
          text: `тікет «${title}»: ${out.error.text}`,
          code: "ticket_field_invalid",
          params: { title, detail: out.error.text },
        },
      };
    if (out.length) t.outOfScope = out;
  }

  const open = openQuestion(t);
  if (open !== undefined)
    return {
      error: {
        text:
          `тікет «${title}» містить відкрите питання (${JSON.stringify(open)}) — такий тікет не створюється. ` +
          "Постав питання через ticket.questions і дочекайся відповіді.",
        code: "ticket_open_question",
        params: { title, value: JSON.stringify(open) },
      },
    };

  return t;
}

// A name off the roster, or off nothing at all. Absent is a legitimate ticket — an unassigned
// card is the board's normal state — so this only refuses a value of the wrong TYPE.
function ticketName(v: unknown, field: string): string | undefined | Fail {
  if (!has(v as Record<string, unknown>, field)) return undefined;
  const raw = (v as Record<string, unknown>)[field];
  if (typeof raw !== "string")
    return {
      error: {
        text: `поле ${field} має бути іменем-рядком, а не ${JSON.stringify(raw)}`,
        code: "field_not_name_string",
        params: { field, value: JSON.stringify(raw) },
      },
    };
  return str(raw);
}

// One parsed block -> one action, or a sentence explaining why not. The sentence is user
// facing, so it names the offending value rather than a schema path.
export function validateManagementAction(raw: unknown): ManagementAction | { error: ManagementRejection } {
  if (!isObj(raw)) return { error: { text: "блок дії має бути JSON-об'єктом", code: "action_not_object" } };
  const o = raw;
  const kind = str(o.kind);
  if (kind === "unsupported") {
    const section = str(o.section);
    if (section === undefined) return { error: { text: "unsupported без поля section", code: "unsupported_no_section" } };
    return { kind: "unsupported", section, request: str(o.request) ?? "" };
  }
  if (kind === "risk.create") {
    // Nested under `risk` and not flat, because a risk has a `kind` of its own
    // (threat/opportunity) and a flat block would have two fields fighting over that name.
    if (!isObj(o.risk)) return { error: { text: "risk.create без об'єкта risk", code: "risk_create_no_risk" } };
    const p = riskPatch(o.risk);
    if (isFail(p)) return p;
    const missing = RISK_REQUIRED.filter((k) => p[k] === undefined);
    if (missing.length)
      return {
        error: {
          text: `risk.create без обов'язкових полів: ${missing.join(", ")}`,
          code: "risk_create_missing_fields",
          params: { missing: missing.join(", ") },
        },
      };
    // workspace_risks_actions_required — «спостерігати» is not a response.
    if (p.response !== "accept" && !(p.responseActions ?? ""))
      return {
        error: {
          text: `стратегія ${p.response} потребує responseActions — що саме буде зроблено`,
          code: "risk_response_actions_required",
          params: { response: String(p.response) },
        },
      };
    return { kind: "risk.create", risk: { responseActions: "", ...p } as ManagementRiskFields };
  }
  if (kind === "risk.update") {
    const code = str(o.code);
    if (code === undefined)
      return { error: { text: "risk.update без коду ризику (наприклад R-003)", code: "risk_update_no_code" } };
    if (!isObj(o.patch))
      return { error: { text: `risk.update ${code} без об'єкта patch`, code: "risk_update_no_patch", params: { code } } };
    const p = riskPatch(o.patch);
    if (isFail(p)) return p;
    if (Object.keys(p).length === 0)
      return { error: { text: `risk.update ${code} нічого не змінює`, code: "risk_update_empty", params: { code } } };
    return { kind: "risk.update", code, patch: p };
  }
  // Deliberately the shortest branch in this function. A delete has one input and therefore
  // one way to be wrong, and every extra field a model might attach is ignored rather than
  // refused: it has still named exactly one row, which is the only thing that decides what
  // happens. The destructive half of this action is gated by RLS (workspace owner) and by
  // the confirm on the screen — not by finding more here to validate.
  if (kind === "risk.delete") {
    const code = str(o.code);
    if (code === undefined)
      return { error: { text: "risk.delete без коду ризику (наприклад R-003)", code: "risk_delete_no_code" } };
    return { kind: "risk.delete", code };
  }
  if (kind === "release.notes") {
    // Named, not guessed: a workspace of five repositories has five different release
    // histories, and a note generated against the wrong one spends a model turn to produce
    // a document about somebody else's work. The prompt tells the model to ask in prose
    // when the project is ambiguous, and this is the refusal if it did not.
    const project = str(o.project);
    if (project === undefined)
      return {
        error: {
          text: "release.notes без проєкту — назви його так, як він стоїть у списку репозиторіїв",
          code: "release_no_project",
        },
      };
    const branch = str(o.branch);
    if (branch === undefined)
      return { error: { text: `release.notes для «${project}» без гілки`, code: "release_no_branch", params: { project } } };
    const rangeFrom = str(o.rangeFrom);
    const rangeTo = str(o.rangeTo);
    if (rangeFrom === undefined || rangeTo === undefined)
      return {
        error: {
          text: `release.notes для «${project}» без періоду — потрібні rangeFrom і rangeTo`,
          code: "release_no_range",
          params: { project },
        },
      };
    // The offending value is named, because «за останній тиждень» left as prose in a date
    // field is the mistake a model actually makes here, and the operator can only re-ask if
    // they can see it.
    for (const [field, value] of [
      ["rangeFrom", rangeFrom],
      ["rangeTo", rangeTo],
    ] as const)
      if (!isReleaseDate(value))
        return {
          error: {
            text: `release.notes: ${field}=${JSON.stringify(value)} — це не дата у форматі РРРР-ММ-ДД`,
            code: "release_date_format",
            params: { field, value: JSON.stringify(value) },
          },
        };
    // Lexicographic IS chronological for YYYY-MM-DD, so no Date parsing that could disagree
    // with git. Refused here rather than at the endpoint: the same check exists there, but a
    // reversed range costs a round trip to hear about it.
    if (rangeFrom > rangeTo)
      return {
        error: {
          text: `release.notes: початок періоду (${rangeFrom}) пізніший за його кінець (${rangeTo})`,
          code: "release_range_reversed",
          params: { from: rangeFrom, to: rangeTo },
        },
      };
    return { kind: "release.notes", project, branch, rangeFrom, rangeTo };
  }
  if (kind === "ticket.create" || kind === "jira.ticket.create") {
    const ticket = ticketFields(o.ticket);
    if (isFail(ticket)) return ticket;

    const assignee = ticketName(o, "assignee");
    if (isFail(assignee)) return assignee;

    // Named files, parsed for BOTH kinds and before the split: the operator's request
    // («тікет із цим файлом») does not change with the board — only what can be done about
    // it does. Jira uploads them, the native board has nowhere to put them and says so, and
    // the empty list is the same statement as no field at all.
    let attached: string[] | undefined;
    if (has(o, "attachments")) {
      const parsed = strList(o.attachments, "attachments");
      if (isFail(parsed)) return parsed;
      if (parsed.length > 0) attached = parsed;
    }

    if (kind === "ticket.create") {
      // Named, not guessed — a card belongs to exactly one project, and the wrong one puts a
      // ticket in front of a team that does not own the work. The prompt tells the model to
      // ask in prose when the workspace has several and the operator named none; this is the
      // refusal if it did not.
      const project = str(o.project);
      if (project === undefined)
        return {
          error: {
            text: `тікет «${ticket.title}» без проєкту — назви його так, як він стоїть у списку репозиторіїв`,
            code: "ticket_no_project",
            params: { title: ticket.title },
          },
        };
      const a: ManagementTicketCreate = { kind: "ticket.create", project, ticket };
      if (assignee !== undefined) a.assignee = assignee;
      // The two launch hints a manager legitimately knows. Validated against the same core
      // constants the board's own form offers, so a value Postgres would happily store but no
      // screen can render is refused here with the list attached.
      if (has(o, "prefix")) {
        if (!BRANCH_PREFIXES.includes(o.prefix as BranchPrefix))
          return {
            error: {
              text: `невідомий тип задачі ${JSON.stringify(o.prefix)} (${BRANCH_PREFIXES.join(", ")})`,
              code: "ticket_prefix_unknown",
              params: { value: JSON.stringify(o.prefix), allowed: BRANCH_PREFIXES.join(", ") },
            },
          };
        a.prefix = o.prefix as BranchPrefix;
      }
      if (has(o, "platform")) {
        if (!PLATFORMS.includes(o.platform as Platform))
          return {
            error: {
              text: `невідома платформа ${JSON.stringify(o.platform)} (${PLATFORMS.join(", ")})`,
              code: "ticket_platform_unknown",
              params: { value: JSON.stringify(o.platform), allowed: PLATFORMS.join(", ") },
            },
          };
        a.platform = o.platform as Platform;
      }
      if (attached !== undefined) a.attachments = attached;
      return a;
    }

    const a: ManagementJiraTicketCreate = { kind: "jira.ticket.create", ticket };
    if (assignee !== undefined) a.assignee = assignee;
    for (const field of ["issueType", "priority", "parentKey"] as const) {
      const value = ticketName(o, field);
      if (isFail(value)) return value;
      if (value !== undefined) a[field] = value;
    }
    if (has(o, "labels")) {
      const labels = strList(o.labels, "labels");
      if (isFail(labels)) return labels;
      // Jira refuses a label containing whitespace, and it does so as a 400 naming a field
      // path. Refused here instead, with the offending label quoted.
      const spaced = labels.find((l) => /\s/.test(l));
      if (spaced !== undefined)
        return {
          error: {
            text: `мітка ${JSON.stringify(spaced)} містить пробіл — Jira такі мітки не приймає`,
            code: "jira_label_has_space",
            params: { value: JSON.stringify(spaced) },
          },
        };
      if (labels.length) a.labels = labels;
    }
    if (attached !== undefined) a.attachments = attached;
    return a;
  }
  if (kind === "ticket.questions") {
    const forTicket = str(o.forTicket);
    if (forTicket === undefined)
      return {
        error: {
          text: "ticket.questions без forTicket — назви тікет, який чекає на відповіді",
          code: "ticket_questions_no_target",
        },
      };
    const questions = strList(has(o, "questions") ? o.questions : [], "questions");
    if (isFail(questions)) return questions;
    // An empty list would render as «тікет не створено, питань немає», which is a state that
    // cannot be acted on: either there are questions, or there is a ticket.
    if (questions.length === 0)
      return {
        error: {
          text: `ticket.questions для «${forTicket}» без жодного питання — або питай, або створюй тікет`,
          code: "ticket_questions_empty",
          params: { forTicket },
        },
      };
    return { kind: "ticket.questions", forTicket, questions };
  }
  return { error: { text: `невідома дія ${JSON.stringify(o.kind)}`, code: "action_kind_unknown", params: { value: JSON.stringify(o.kind) } } };
}

// Split an assistant answer into the prose the user reads and the actions the app runs.
// Pure and total: unparseable JSON and an unknown `kind` both land in `rejected` and
// NOTHING is executed on a guess.
export function parseManagementReply(raw: string): ParsedManagementReply {
  const actions: ManagementAction[] = [];
  const rejected: ManagementRejection[] = [];
  const text = raw
    .replace(BLOCK_RE, (_m, body: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        const message = (err as Error).message;
        rejected.push({
          text: `не вдалося прочитати блок дії: ${message}`,
          code: "block_unreadable",
          params: { message },
        });
        return "";
      }
      // A model that batches two refusals into one block is being helpful, not wrong.
      for (const one of Array.isArray(parsed) ? parsed : [parsed]) {
        const res = validateManagementAction(one);
        if ("error" in res) rejected.push(res.error);
        else actions.push(res);
      }
      return "";
    })
    // Collapse the hole a removed block leaves, so the prose does not end in three
    // blank lines every time the assistant acts.
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, actions, rejected };
}
