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
//     therefore has the same shape whichever turn produced it;
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
  const out: string[] = ["## Контекст", t.context];
  if (t.userFlow?.length) {
    out.push("", "## Користувацький сценарій");
    t.userFlow.forEach((step, i) => out.push(`${i + 1}. ${step}`));
  }
  out.push("", "## Критерії приймання");
  for (const c of t.acceptanceCriteria) out.push(`- [ ] ${c}`);
  if (t.outOfScope?.length) {
    out.push("", "## Поза межами задачі");
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
};

export type ManagementChatReply = {
  // The model's prose, with the action blocks removed.
  text: string;
  actions: ManagementAction[];
  // One line per action block that did not validate. Shown in the chat: a silently dropped
  // instruction is how an operator ends up believing something was recorded.
  rejected: string[];
  // omp notices raised during the turn (dropped frames, provider warnings, a cancelled
  // interactive prompt).
  notices: string[];
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
  rejected: string[];
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

type Fail = { error: string };

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
    if (!isRiskKind(o.kind)) return { error: `невідомий тип ризику ${JSON.stringify(o.kind)} (threat або opportunity)` };
    p.kind = o.kind;
  }
  if (has(o, "category")) {
    if (!isRiskCategory(o.category))
      return {
        error: `невідома категорія ризику ${JSON.stringify(o.category)} — допустимі: ${RISK_CATEGORY_VALUES.join(", ")}`,
      };
    p.category = o.category;
  }
  if (has(o, "response")) {
    if (!isRiskResponse(o.response)) return { error: `невідома стратегія реагування ${JSON.stringify(o.response)}` };
    p.response = o.response;
  }
  if (has(o, "status")) {
    if (!isRiskStatus(o.status))
      return { error: `невідомий статус ризику ${JSON.stringify(o.status)} — допустимі: ${RISK_STATUS_VALUES.join(", ")}` };
    p.status = o.status;
  }

  // The statement's three parts. Blank is not «unset» here: the schema refuses a blank
  // cause, event or consequence, because that is what separates a scoreable risk from a worry.
  for (const key of ["cause", "event", "consequence"] as const) {
    if (!has(o, key)) continue;
    const t = str(o[key]);
    if (t === undefined) return { error: `поле ${key} не може бути порожнім` };
    p[key] = t;
  }

  // Free text that MAY legitimately be emptied by an update (a cleared trigger note), so a
  // blank string is kept rather than refused.
  for (const key of ["responseActions", "earlyWarning", "closureNote"] as const) {
    if (!has(o, key)) continue;
    if (typeof o[key] !== "string") return { error: `поле ${key} має бути текстом` };
    p[key] = (o[key] as string).trim();
  }

  for (const key of ["probability", "impact", "residualProbability", "residualImpact"] as const) {
    if (!has(o, key)) continue;
    const n = num(o[key]);
    if (n === undefined || !Number.isInteger(n) || n < RISK_SCORE_MIN || n > RISK_SCORE_MAX)
      return { error: `поле ${key} має бути цілим числом ${RISK_SCORE_MIN}–${RISK_SCORE_MAX}, а не ${JSON.stringify(o[key])}` };
    p[key] = n;
  }

  if (has(o, "probabilityPct")) {
    const n = num(o.probabilityPct);
    if (n === undefined || !Number.isInteger(n) || n < 0 || n > 100)
      return { error: `probabilityPct має бути цілим числом 0–100, а не ${JSON.stringify(o.probabilityPct)}` };
    p.probabilityPct = n;
  }
  if (has(o, "costImpact")) {
    const n = num(o.costImpact);
    if (n === undefined || n < 0) return { error: `costImpact має бути невідʼємним числом, а не ${JSON.stringify(o.costImpact)}` };
    p.costImpact = n;
  }

  for (const key of ["proximity", "actionDue"] as const) {
    if (!has(o, key)) continue;
    const t = str(o[key]);
    if (t === undefined || !DATE_RE.test(t)) return { error: `поле ${key} має бути датою РРРР-ММ-ДД, а не ${JSON.stringify(o[key])}` };
    p[key] = t;
  }

  // workspace_risks_response_matches_kind, checked here so the operator reads «reduce не
  // застосовується до можливості» instead of a Postgres constraint name.
  if (p.kind !== undefined && p.response !== undefined && !RISK_RESPONSES_BY_KIND[p.kind].includes(p.response))
    return {
      error: `стратегія ${p.response} не застосовується до ${p.kind} — допустимі: ${RISK_RESPONSES_BY_KIND[p.kind].join(", ")}`,
    };
  // workspace_risks_closure_note_required. Demanded from the SAME action that closes the risk:
  // a terminal status is the one write that must arrive with its reason attached.
  if (p.status !== undefined && isTerminalRiskStatus(p.status) && !(p.closureNote ?? ""))
    return { error: `статус ${p.status} потребує closureNote — причини закриття або плану по інциденту` };
  // workspace_risks_emv_pair and workspace_risks_residual_pair: both halves or neither.
  if ((p.costImpact === undefined) !== (p.probabilityPct === undefined))
    return { error: "costImpact і probabilityPct вказуються разом — EMV з половини пари є вигаданим числом" };
  if ((p.residualProbability === undefined) !== (p.residualImpact === undefined))
    return { error: "residualProbability і residualImpact вказуються разом" };

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
  if (!Array.isArray(v)) return { error: `поле ${field} має бути списком рядків` };
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") return { error: `поле ${field} має містити лише рядки, а не ${JSON.stringify(item)}` };
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
// Each entry is a shape a model actually produces. Deliberately narrow: «уточнити» on its own
// is ordinary Ukrainian («користувач може уточнити фільтр»), so only the forms that hand the
// decision to somebody else are listed. The refusal quotes the fragment that matched, so a
// false positive is visible and re-askable rather than mysterious.
const OPEN_QUESTION_MARKERS: readonly RegExp[] = [
  /\b(?:TBD|TBC|TODO|FIXME|XXX)\b/i,
  /\?{2,}/,
  /<\s*(?:\?|\.{2,}|тут|назва|значення|value|placeholder)\s*>/i,
  /\[\s*(?:\?|\.{2,}|—|-)\s*\]/,
  /(?:потрібно|потрібен|треба|потребує|варто|слід)\s+(?:буде\s+)?уточн/i,
  /незрозуміл|під питанням|питання до|на розсуд|to be (?:defined|decided|confirmed)|open question/i,
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
  if (!isObj(v)) return { error: "дія без об'єкта ticket" };
  const title = str(v.title);
  if (title === undefined) return { error: "тікет без назви (title)" };
  if (title.length > TICKET_TITLE_MAX)
    return { error: `назва тікета довша за ${TICKET_TITLE_MAX} символів — це вже опис, а не назва` };
  const context = str(v.context);
  if (context === undefined)
    return { error: `тікет «${title}» без бізнес-контексту (context) — навіщо ця робота і кому вона потрібна` };

  const acceptanceCriteria = strList(has(v, "acceptanceCriteria") ? v.acceptanceCriteria : [], "acceptanceCriteria");
  if (isFail(acceptanceCriteria)) return { error: `тікет «${title}»: ${acceptanceCriteria.error}` };
  if (acceptanceCriteria.length === 0)
    return { error: `тікет «${title}» без критеріїв приймання (acceptanceCriteria) — немає за чим його закривати` };

  const t: ManagementTicketFields = { title, context, acceptanceCriteria };

  if (has(v, "userFlow")) {
    const flow = strList(v.userFlow, "userFlow");
    if (isFail(flow)) return { error: `тікет «${title}»: ${flow.error}` };
    if (flow.length) t.userFlow = flow;
  }
  if (has(v, "outOfScope")) {
    const out = strList(v.outOfScope, "outOfScope");
    if (isFail(out)) return { error: `тікет «${title}»: ${out.error}` };
    if (out.length) t.outOfScope = out;
  }

  const open = openQuestion(t);
  if (open !== undefined)
    return {
      error:
        `тікет «${title}» містить відкрите питання (${JSON.stringify(open)}) — такий тікет не створюється. ` +
        "Постав питання через ticket.questions і дочекайся відповіді.",
    };

  return t;
}

// A name off the roster, or off nothing at all. Absent is a legitimate ticket — an unassigned
// card is the board's normal state — so this only refuses a value of the wrong TYPE.
function ticketName(v: unknown, field: string): string | undefined | Fail {
  if (!has(v as Record<string, unknown>, field)) return undefined;
  const raw = (v as Record<string, unknown>)[field];
  if (typeof raw !== "string") return { error: `поле ${field} має бути іменем-рядком, а не ${JSON.stringify(raw)}` };
  return str(raw);
}

// One parsed block -> one action, or a sentence explaining why not. The sentence is user
// facing, so it names the offending value rather than a schema path.
export function validateManagementAction(raw: unknown): ManagementAction | { error: string } {
  if (!isObj(raw)) return { error: "блок дії має бути JSON-об'єктом" };
  const o = raw;
  const kind = str(o.kind);
  if (kind === "unsupported") {
    const section = str(o.section);
    if (section === undefined) return { error: "unsupported без поля section" };
    return { kind: "unsupported", section, request: str(o.request) ?? "" };
  }
  if (kind === "risk.create") {
    // Nested under `risk` and not flat, because a risk has a `kind` of its own
    // (threat/opportunity) and a flat block would have two fields fighting over that name.
    if (!isObj(o.risk)) return { error: "risk.create без об'єкта risk" };
    const p = riskPatch(o.risk);
    if (isFail(p)) return p;
    const missing = RISK_REQUIRED.filter((k) => p[k] === undefined);
    if (missing.length) return { error: `risk.create без обов'язкових полів: ${missing.join(", ")}` };
    // workspace_risks_actions_required — «спостерігати» is not a response.
    if (p.response !== "accept" && !(p.responseActions ?? ""))
      return { error: `стратегія ${p.response} потребує responseActions — що саме буде зроблено` };
    return { kind: "risk.create", risk: { responseActions: "", ...p } as ManagementRiskFields };
  }
  if (kind === "risk.update") {
    const code = str(o.code);
    if (code === undefined) return { error: "risk.update без коду ризику (наприклад R-003)" };
    if (!isObj(o.patch)) return { error: `risk.update ${code} без об'єкта patch` };
    const p = riskPatch(o.patch);
    if (isFail(p)) return p;
    if (Object.keys(p).length === 0) return { error: `risk.update ${code} нічого не змінює` };
    return { kind: "risk.update", code, patch: p };
  }
  if (kind === "release.notes") {
    // Named, not guessed: a workspace of five repositories has five different release
    // histories, and a note generated against the wrong one spends a model turn to produce
    // a document about somebody else's work. The prompt tells the model to ask in prose
    // when the project is ambiguous, and this is the refusal if it did not.
    const project = str(o.project);
    if (project === undefined)
      return { error: "release.notes без проєкту — назви його так, як він стоїть у списку репозиторіїв" };
    const branch = str(o.branch);
    if (branch === undefined) return { error: `release.notes для «${project}» без гілки` };
    const rangeFrom = str(o.rangeFrom);
    const rangeTo = str(o.rangeTo);
    if (rangeFrom === undefined || rangeTo === undefined)
      return { error: `release.notes для «${project}» без періоду — потрібні rangeFrom і rangeTo` };
    // The offending value is named, because «за останній тиждень» left as prose in a date
    // field is the mistake a model actually makes here, and the operator can only re-ask if
    // they can see it.
    for (const [field, value] of [
      ["rangeFrom", rangeFrom],
      ["rangeTo", rangeTo],
    ] as const)
      if (!isReleaseDate(value))
        return { error: `release.notes: ${field}=${JSON.stringify(value)} — це не дата у форматі РРРР-ММ-ДД` };
    // Lexicographic IS chronological for YYYY-MM-DD, so no Date parsing that could disagree
    // with git. Refused here rather than at the endpoint: the same check exists there, but a
    // reversed range costs a round trip to hear about it.
    if (rangeFrom > rangeTo)
      return { error: `release.notes: початок періоду (${rangeFrom}) пізніший за його кінець (${rangeTo})` };
    return { kind: "release.notes", project, branch, rangeFrom, rangeTo };
  }
  if (kind === "ticket.create" || kind === "jira.ticket.create") {
    const ticket = ticketFields(o.ticket);
    if (isFail(ticket)) return ticket;

    const assignee = ticketName(o, "assignee");
    if (isFail(assignee)) return assignee;

    if (kind === "ticket.create") {
      // Named, not guessed — a card belongs to exactly one project, and the wrong one puts a
      // ticket in front of a team that does not own the work. The prompt tells the model to
      // ask in prose when the workspace has several and the operator named none; this is the
      // refusal if it did not.
      const project = str(o.project);
      if (project === undefined)
        return { error: `тікет «${ticket.title}» без проєкту — назви його так, як він стоїть у списку репозиторіїв` };
      const a: ManagementTicketCreate = { kind: "ticket.create", project, ticket };
      if (assignee !== undefined) a.assignee = assignee;
      // The two launch hints a manager legitimately knows. Validated against the same core
      // constants the board's own form offers, so a value Postgres would happily store but no
      // screen can render is refused here with the list attached.
      if (has(o, "prefix")) {
        if (!BRANCH_PREFIXES.includes(o.prefix as BranchPrefix))
          return { error: `невідомий тип задачі ${JSON.stringify(o.prefix)} (${BRANCH_PREFIXES.join(", ")})` };
        a.prefix = o.prefix as BranchPrefix;
      }
      if (has(o, "platform")) {
        if (!PLATFORMS.includes(o.platform as Platform))
          return { error: `невідома платформа ${JSON.stringify(o.platform)} (${PLATFORMS.join(", ")})` };
        a.platform = o.platform as Platform;
      }
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
        return { error: `мітка ${JSON.stringify(spaced)} містить пробіл — Jira такі мітки не приймає` };
      if (labels.length) a.labels = labels;
    }
    return a;
  }
  if (kind === "ticket.questions") {
    const forTicket = str(o.forTicket);
    if (forTicket === undefined)
      return { error: "ticket.questions без forTicket — назви тікет, який чекає на відповіді" };
    const questions = strList(has(o, "questions") ? o.questions : [], "questions");
    if (isFail(questions)) return questions;
    // An empty list would render as «тікет не створено, питань немає», which is a state that
    // cannot be acted on: either there are questions, or there is a ticket.
    if (questions.length === 0)
      return { error: `ticket.questions для «${forTicket}» без жодного питання — або питай, або створюй тікет` };
    return { kind: "ticket.questions", forTicket, questions };
  }
  return { error: `невідома дія ${JSON.stringify(o.kind)}` };
}

// Split an assistant answer into the prose the user reads and the actions the app runs.
// Pure and total: unparseable JSON and an unknown `kind` both land in `rejected` and
// NOTHING is executed on a guess.
export function parseManagementReply(raw: string): ParsedManagementReply {
  const actions: ManagementAction[] = [];
  const rejected: string[] = [];
  const text = raw
    .replace(BLOCK_RE, (_m, body: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        rejected.push(`не вдалося прочитати блок дії: ${(err as Error).message}`);
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
