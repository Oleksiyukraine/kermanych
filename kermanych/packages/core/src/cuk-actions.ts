// packages/core/src/cuk-actions.ts
// The wire protocol between ЦУК («Центр управління Керманича», the console behind the avatar)
// and the app. Spec: docs/specs/2026-11-04-cuk-control-console.md.
//
// Same channel as the Менеджмент assistant (./management-actions): the model answers in prose
// and states what the app should do as ```kermanych-action``` blocks, which are validated here
// and executed in the BROWSER. Nothing ЦУК asks for runs in the api: board cards are written
// under the operator's own JWT, sessions are driven through the same store calls the buttons
// make.
//
// Two classes of action, and the split is the safety rule of the console (decision 4):
//
//   * at once — moving the operator around (`navigate`, `scope.select`, `session.open`) and
//     their own Action List (`todo.*`). Nothing is spent and nothing is interrupted;
//   * on a card — everything that spends the subscription or interferes with an agent. The
//     browser renders the action as a card with «Виконати» / «Скасувати» and runs it only on
//     the operator's click. `cukNeedsConfirm` is the one place that says which is which.
//
// Scheduled tasks (`schedule.*`, docs/specs/2026-11-06-scheduled-tasks.md) are weighed by kind
// (decision 7): a reminder spends nothing, so creating, editing or resuming one runs at once with
// «Скасувати» in the result line, as does pausing any task; an agent task spends the plan on
// every firing, so creating, editing or resuming it, and «запусти зараз», wait for the card.
// `schedule.delete` is the one delete in this vocabulary and is ALWAYS a card — its run history
// goes with it.
//
// Other irreversible verbs (deleting a session or a card, finish, PR, merge) do not exist in
// this vocabulary at all: a block naming one is refused as an unknown kind, never executed.
import {
  parseActionBlocks,
  validateManagementAction,
  type ManagementAttachment,
  type ManagementHomeTodoItem,
  type ManagementTodoCreate,
  type ManagementTodoDelete,
  type ManagementTodoUpdate,
} from "./management-actions";
import type { Locale, ManagementRejection, Notice } from "./i18n-codes";
import {
  scheduleAgentOnly,
  scheduleName,
  validateScheduleSkills,
  validateScheduleWhen,
  type ScheduleKind,
  type ScheduleWhen,
} from "./schedules";
import type { SessionStatus, Usage } from "./types";

// ── Actions ─────────────────────────────────────────────────────────────────

// Session verbs that need nothing but the session: each maps onto one orchestrator call.
export const CUK_SESSION_VERBS = [
  "session.stop",
  "session.resume",
  "session.restart",
  "session.archive",
  "session.unarchive",
  "preview.start",
  "preview.stop",
] as const;
export type CukSessionVerb = (typeof CUK_SESSION_VERBS)[number];

// A card title fits a kanban column; longer is a paragraph and is cut by the executor's own
// title rule instead.
export const CUK_TITLE_MAX = 120;

export type CukAction =
  // Go to one of the places the browser listed in `context.places` — a tab, a settings
  // section, a Менеджмент section. By id from that list only: the executor resolves it
  // against the same list, so a place the model invented is a warning, not a route.
  | { kind: "navigate"; place: string }
  // Change the header's scope. Names, as the digest prints them; at least one of the two.
  | { kind: "scope.select"; workspace?: string; project?: string }
  // Show one session in «Агенти» (by the `ref` the digest prints).
  | { kind: "session.open"; session: string }
  // The notepad — the current workspace's «Список дій». The Менеджмент verbs and their
  // validation, because it is the same list (decision 6).
  | ManagementTodoCreate
  | ManagementTodoUpdate
  | ManagementTodoDelete
  // File a card on the board («в беклог»). `title` optional: the executor derives one from
  // the task text the way the launcher does.
  | { kind: "task.create"; project: string; task: string; title?: string; deepAnalysis?: boolean }
  // File the card AND launch an agent on it, as «Нова задача» → «Запустити».
  | { kind: "agent.start"; project: string; task: string; title?: string; deepAnalysis?: boolean }
  // One message into a live session's conversation.
  | { kind: "session.message"; session: string; text: string }
  | { kind: CukSessionVerb; session: string }
  // A scheduled task. `type` is its kind (decision 3); `project` a NAME as the digest prints it
  // (absent = an agent task without a project, decision 9); `when` a schedule or «через N хв»,
  // which the executor resolves to a «once» when it runs the action (`resolveWhen`). Reminders
  // carry no project, skills or model.
  | {
      kind: "schedule.create";
      name: string;
      type: ScheduleKind;
      text: string;
      project?: string;
      skills?: string[];
      model?: string;
      when: ScheduleWhen;
    }
  // Change a task by the `ref` the digest prints; only the fields named change.
  | {
      kind: "schedule.update";
      ref: string;
      name?: string;
      text?: string;
      project?: string;
      skills?: string[];
      model?: string;
      when?: ScheduleWhen;
    }
  | { kind: CukScheduleVerb; ref: string };

// Schedule verbs that need nothing but the task's ref.
export const CUK_SCHEDULE_VERBS = ["schedule.pause", "schedule.resume", "schedule.run", "schedule.delete"] as const;
export type CukScheduleVerb = (typeof CUK_SCHEDULE_VERBS)[number];

export type CukActionKind = CukAction["kind"];
export type CukTaskAction = Extract<CukAction, { kind: "task.create" | "agent.start" }>;
export type CukSessionAction = Extract<CukAction, { kind: CukSessionVerb }>;
export type CukScheduleAction = Extract<CukAction, { kind: `schedule.${string}` }>;

// Decision 4: what runs only after the operator clicks «Виконати». Schedule actions follow the
// scheduled-tasks spec's decision 7; `scheduleKindOf` resolves a digest `ref` to the task's
// kind, and a ref it does not know is weighed as an agent task — the card is the safe side.
export function cukNeedsConfirm(action: CukAction, scheduleKindOf?: (ref: string) => ScheduleKind | undefined): boolean {
  switch (action.kind) {
    case "navigate":
    case "scope.select":
    case "session.open":
    case "todo.create":
    case "todo.update":
    case "todo.delete":
    case "schedule.pause":
      return false;
    case "schedule.create":
      return action.type === "agent";
    case "schedule.update":
    case "schedule.resume":
      return scheduleKindOf?.(action.ref) !== "reminder";
    default:
      return true;
  }
}

// ── Context (the browser's digest, re-sent every turn) ─────────────────────

// One place `navigate` may go to: `id` is the executor's, `label` what the operator reads.
export type CukPlace = { id: string; label: string };

export type CukWorkspaceRow = { name: string; role: string; selected: boolean };

// `bound`: the project has a repository on THIS machine — an agent can launch only then.
export type CukProjectRow = { name: string; workspace: string; bound: boolean; selected: boolean };

// One live session. `ref` is the first characters of its id — enough to name it uniquely,
// short enough not to spend the turn on uuids.
export type CukSessionRow = {
  ref: string;
  project: string;
  name: string;
  kind: string;
  status: SessionStatus;
  // The agent asks the operator something right now (status waiting_input or a pending UI
  // request): «хто чекає на мене» is answered from this flag.
  waiting: boolean;
  archived: boolean;
  preview?: boolean;
};

export type CukBoardRow = { title: string; project: string; status: string; assignee: string };

// One scheduled task. `ref` is the first 8 characters of its id; `when` the schedule in words
// (`describeSchedule`, uk); `next` the next firing as local wall time ("2026-11-06T19:00").
export type CukScheduleRow = {
  ref: string;
  name: string;
  type: ScheduleKind;
  project?: string;
  when: string;
  next?: string;
  enabled: boolean;
};

export type CukContext = {
  // The place the operator is on now (a `places` id, or the route name).
  view: string;
  // The header's scope, by name. Absent = nothing selected at that level.
  workspace?: string;
  project?: string;
  workspaces: CukWorkspaceRow[];
  projects: CukProjectRow[];
  sessions: CukSessionRow[];
  // How many sessions exist beyond the cap, so «їх більше» can be said honestly.
  sessionsOmitted: number;
  board: CukBoardRow[];
  boardOmitted: number;
  places: CukPlace[];
  // The current workspace's «Список дій»; absent when no workspace is selected.
  notes?: ManagementHomeTodoItem[];
  // The operator's local wall time with its offset ("2026-11-06T18:42+02:00") and IANA zone:
  // «о 19:00», «завтра», «через годину» are turned into a schedule against these.
  now: string;
  timeZone: string;
  // The operator's scheduled tasks, so «постав на паузу вітаміни» can name one.
  schedules: CukScheduleRow[];
  // Skill names a scheduled agent task may use: the library and the selected project's
  // repository skills. A name outside it is refused when the task is created.
  skills: string[];
};

export type CukChatAsk = {
  text: string;
  context: CukContext;
  // Images only: ЦУК has no file tools, so a document could not be read (decision 11).
  attachments?: ManagementAttachment[];
  locale?: Locale;
};

export type CukChatReply = {
  text: string;
  actions: CukAction[];
  rejected: ManagementRejection[];
  notices: Notice[];
  usage?: Usage;
  model?: string;
  ms: number;
};

// ── Validation ──────────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

type Refusal = { error: ManagementRejection };

function isVerb(kind: string): kind is CukSessionVerb {
  return (CUK_SESSION_VERBS as readonly string[]).includes(kind);
}

function isScheduleVerb(kind: string): kind is CukScheduleVerb {
  return (CUK_SCHEDULE_VERBS as readonly string[]).includes(kind);
}

// The optional fields schedule.create and schedule.update share. A reminder's are refused here
// for create; for update the kind is the stored task's, so the executor's PATCH refuses them.
function scheduleFields(o: Record<string, unknown>): { project?: string; skills?: string[]; model?: string; when?: ScheduleWhen } | Refusal {
  const project = str(o.project);
  const model = str(o.model);
  let skills: string[] | undefined;
  if (o.skills !== undefined) {
    const s = validateScheduleSkills(o.skills);
    if ("error" in s) return s;
    skills = s;
  }
  let when: ScheduleWhen | undefined;
  if (o.when !== undefined) {
    const w = validateScheduleWhen(o.when);
    if ("error" in w) return w;
    when = w;
  }
  return {
    ...(project !== undefined ? { project } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(when !== undefined ? { when } : {}),
  };
}

function scheduleAction(kind: string, o: Record<string, unknown>): CukScheduleAction | Refusal {
  if (kind === "schedule.create") {
    const name = scheduleName(o.name);
    if (typeof name !== "string") return name;
    const type = o.type;
    if (type !== "reminder" && type !== "agent")
      return { error: { text: `невідомий тип задачі ${JSON.stringify(type)}`, code: "schedule_type_invalid", params: { value: JSON.stringify(type) ?? "" } } };
    const text = str(o.text);
    if (text === undefined) return { error: { text: "schedule.create без тексту", code: "schedule_text_missing" } };
    if (o.when === undefined)
      return { error: { text: "schedule.create без розкладу", code: "schedule_when_invalid", params: { value: "" } } };
    const fields = scheduleFields(o);
    if ("error" in fields) return fields;
    if (type === "reminder") {
      if (fields.project !== undefined) return scheduleAgentOnly("project");
      if (fields.skills !== undefined && fields.skills.length > 0) return scheduleAgentOnly("skills");
      if (fields.model !== undefined) return scheduleAgentOnly("model");
      delete fields.skills;
    }
    return { kind, name, type, text, ...fields, when: fields.when as ScheduleWhen };
  }
  const ref = str(o.ref);
  if (ref === undefined) return { error: { text: `${kind} без задачі`, code: "schedule_ref_missing", params: { kind } } };
  if (kind === "schedule.update") {
    let name: string | undefined;
    if (o.name !== undefined) {
      const n = scheduleName(o.name);
      if (typeof n !== "string") return n;
      name = n;
    }
    const text = str(o.text);
    const fields = scheduleFields(o);
    if ("error" in fields) return fields;
    return { kind, ref, ...(name !== undefined ? { name } : {}), ...(text !== undefined ? { text } : {}), ...fields };
  }
  return { kind: kind as CukScheduleVerb, ref };
}

function taskAction(kind: "task.create" | "agent.start", o: Record<string, unknown>): CukTaskAction | Refusal {
  const project = str(o.project);
  if (project === undefined)
    return { error: { text: `${kind} без проєкту`, code: "cuk_project_missing", params: { kind } } };
  const task = str(o.task);
  if (task === undefined)
    return { error: { text: `${kind} без тексту задачі`, code: "cuk_task_missing", params: { kind } } };
  const title = str(o.title);
  if (title !== undefined && title.length > CUK_TITLE_MAX)
    return {
      error: {
        text: `назва довша за ${CUK_TITLE_MAX} символів`,
        code: "ticket_title_too_long",
        params: { max: CUK_TITLE_MAX },
      },
    };
  return {
    kind,
    project,
    task,
    ...(title !== undefined ? { title } : {}),
    ...(o.deepAnalysis === true || o.deepAnalysis === "true" ? { deepAnalysis: true } : {}),
  };
}

// One parsed block -> one action, or a sentence explaining why not.
export function validateCukAction(raw: unknown): CukAction | Refusal {
  if (!isObj(raw)) return { error: { text: "блок дії має бути JSON-об'єктом", code: "action_not_object" } };
  const kind = str(raw.kind) ?? "";
  if (kind === "navigate") {
    const place = str(raw.place);
    if (place === undefined) return { error: { text: "navigate без place", code: "cuk_place_missing" } };
    return { kind, place };
  }
  if (kind === "scope.select") {
    const workspace = str(raw.workspace);
    const project = str(raw.project);
    if (workspace === undefined && project === undefined)
      return { error: { text: "scope.select без воркспейсу і проєкту", code: "cuk_select_empty" } };
    return { kind, ...(workspace !== undefined ? { workspace } : {}), ...(project !== undefined ? { project } : {}) };
  }
  if (kind === "todo.create" || kind === "todo.update" || kind === "todo.delete") {
    // The Менеджмент validator, untouched: one list, one set of rules about it.
    const res = validateManagementAction(raw);
    if ("error" in res) return res;
    if (res.kind === "todo.create" || res.kind === "todo.update" || res.kind === "todo.delete") return res;
    return { error: { text: `невідома дія ${JSON.stringify(raw.kind)}`, code: "action_kind_unknown", params: { value: JSON.stringify(raw.kind) } } };
  }
  if (kind === "task.create" || kind === "agent.start") return taskAction(kind, raw);
  if (kind === "schedule.create" || kind === "schedule.update" || isScheduleVerb(kind)) return scheduleAction(kind, raw);
  if (kind === "session.open" || kind === "session.message" || isVerb(kind)) {
    const session = str(raw.session);
    if (session === undefined)
      return { error: { text: `${kind} без сесії`, code: "cuk_session_missing", params: { kind } } };
    if (kind === "session.open") return { kind, session };
    if (kind === "session.message") {
      const text = str(raw.text);
      if (text === undefined) return { error: { text: "session.message без тексту", code: "cuk_message_missing" } };
      return { kind, session, text };
    }
    return { kind, session };
  }
  return { error: { text: `невідома дія ${JSON.stringify(raw.kind)}`, code: "action_kind_unknown", params: { value: JSON.stringify(raw.kind) } } };
}

export function parseCukReply(raw: string): { text: string; actions: CukAction[]; rejected: ManagementRejection[] } {
  return parseActionBlocks(raw, validateCukAction);
}
