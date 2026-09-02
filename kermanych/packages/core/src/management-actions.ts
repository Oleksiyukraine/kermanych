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
  | { kind: "release.notes"; project: string; branch: string; rangeFrom: string; rangeTo: string };

export type ManagementActionKind = ManagementAction["kind"];
export type ManagementUnsupported = Extract<ManagementAction, { kind: "unsupported" }>;
export type ManagementRiskCreate = Extract<ManagementAction, { kind: "risk.create" }>;
export type ManagementRiskUpdate = Extract<ManagementAction, { kind: "risk.update" }>;
export type ManagementReleaseNotes = Extract<ManagementAction, { kind: "release.notes" }>;

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
