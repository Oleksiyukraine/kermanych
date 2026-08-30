// Data access for the project risk register. Owns the snake_case <-> camelCase boundary for
// `project_risks` and `project_risk_events`. Every call runs under the caller's JWT; the RLS
// policies (read and write = project member) are the authorization surface and refusals
// surface as thrown postgrest messages.
//
// There is deliberately NO deleteProjectRisk. A risk leaves the register by moving to
// `closed` or `materialized` with a closure note — the table grants no `delete` to anyone,
// so a function here could only ever throw.
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ProjectRisk,
  ProjectRiskEvent,
  ProjectRiskInsert,
  ProjectRiskPatch,
  RiskCategory,
  RiskEventKind,
  RiskKind,
  RiskResponse,
  RiskStatus,
} from "./types";

// One string literal, not a concatenation: postgrest-js parses this at the TYPE level to
// shape the response, and a `+`-joined value degrades to GenericStringError.
const RISK_COLUMNS = "id, project_id, code, kind, category, cause, event, consequence, probability, impact, exposure, cost_impact, probability_pct, emv, proximity, response, response_actions, action_owner, action_due, risk_owner, residual_probability, residual_impact, residual_exposure, early_warning, status, closure_note, closed_at, raised_at, raised_by, last_reviewed_at, updated_at, updated_by";

const EVENT_COLUMNS = "id, risk_id, at, actor, kind, from_value, to_value";

type RiskRow = {
  id: string;
  project_id: string;
  code: string;
  kind: RiskKind;
  category: RiskCategory;
  cause: string;
  event: string;
  consequence: string;
  probability: number;
  impact: number;
  exposure: number;
  // postgrest hands numeric(…) back as a STRING, so every money column is parsed rather
  // than trusted: `emv` arriving as "12500.00" would sort as text and sum as concatenation.
  cost_impact: string | number | null;
  probability_pct: number | null;
  emv: string | number | null;
  proximity: string | null;
  response: RiskResponse;
  response_actions: string;
  action_owner: string | null;
  action_due: string | null;
  risk_owner: string | null;
  residual_probability: number | null;
  residual_impact: number | null;
  residual_exposure: number | null;
  early_warning: string;
  status: RiskStatus;
  closure_note: string;
  closed_at: string | null;
  raised_at: string;
  raised_by: string | null;
  last_reviewed_at: string;
  updated_at: string;
  updated_by: string | null;
};

type RiskEventRow = {
  id: number;
  risk_id: string;
  at: string;
  actor: string | null;
  kind: RiskEventKind;
  from_value: string;
  to_value: string;
};

function num(v: string | number | null): number | undefined {
  if (v === null) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function toProjectRisk(row: RiskRow): ProjectRisk {
  const r: ProjectRisk = {
    id: row.id,
    projectId: row.project_id,
    code: row.code,
    kind: row.kind,
    category: row.category,
    cause: row.cause,
    event: row.event,
    consequence: row.consequence,
    probability: row.probability,
    impact: row.impact,
    exposure: row.exposure,
    response: row.response,
    responseActions: row.response_actions,
    earlyWarning: row.early_warning,
    status: row.status,
    closureNote: row.closure_note,
    raisedAt: row.raised_at,
    lastReviewedAt: row.last_reviewed_at,
    updatedAt: row.updated_at,
  };
  // `exactOptionalPropertyTypes` is on: an absent key and an explicit `undefined` are
  // different types, so every nullable column is assigned only when it has a value.
  const costImpact = num(row.cost_impact);
  if (costImpact !== undefined) r.costImpact = costImpact;
  if (row.probability_pct !== null) r.probabilityPct = row.probability_pct;
  const emv = num(row.emv);
  if (emv !== undefined) r.emv = emv;
  if (row.proximity !== null) r.proximity = row.proximity;
  if (row.action_owner !== null) r.actionOwner = row.action_owner;
  if (row.action_due !== null) r.actionDue = row.action_due;
  if (row.risk_owner !== null) r.riskOwner = row.risk_owner;
  if (row.residual_probability !== null) r.residualProbability = row.residual_probability;
  if (row.residual_impact !== null) r.residualImpact = row.residual_impact;
  if (row.residual_exposure !== null) r.residualExposure = row.residual_exposure;
  if (row.closed_at !== null) r.closedAt = row.closed_at;
  if (row.raised_by !== null) r.raisedBy = row.raised_by;
  if (row.updated_by !== null) r.updatedBy = row.updated_by;
  return r;
}

export function toProjectRiskEvent(row: RiskEventRow): ProjectRiskEvent {
  const e: ProjectRiskEvent = {
    id: row.id,
    riskId: row.risk_id,
    at: row.at,
    kind: row.kind,
    fromValue: row.from_value,
    toValue: row.to_value,
  };
  if (row.actor !== null) e.actor = row.actor;
  return e;
}

// Only the keys actually present in the patch are sent, so a two-field edit never overwrites
// a column someone else changed in between. An explicit `null` clears the column; an empty
// string in a text field is a legitimate value (a cleared trigger note), not a NULL.
export function toRiskRow(patch: ProjectRiskPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.kind !== undefined) row.kind = patch.kind;
  if (patch.category !== undefined) row.category = patch.category;
  if (patch.cause !== undefined) row.cause = patch.cause.trim();
  if (patch.event !== undefined) row.event = patch.event.trim();
  if (patch.consequence !== undefined) row.consequence = patch.consequence.trim();
  if (patch.probability !== undefined) row.probability = patch.probability;
  if (patch.impact !== undefined) row.impact = patch.impact;
  if (patch.costImpact !== undefined) row.cost_impact = patch.costImpact;
  if (patch.probabilityPct !== undefined) row.probability_pct = patch.probabilityPct;
  if (patch.proximity !== undefined) row.proximity = patch.proximity || null;
  if (patch.response !== undefined) row.response = patch.response;
  if (patch.responseActions !== undefined) row.response_actions = patch.responseActions.trim();
  if (patch.actionOwner !== undefined) row.action_owner = patch.actionOwner || null;
  if (patch.actionDue !== undefined) row.action_due = patch.actionDue || null;
  if (patch.riskOwner !== undefined) row.risk_owner = patch.riskOwner || null;
  if (patch.residualProbability !== undefined) row.residual_probability = patch.residualProbability;
  if (patch.residualImpact !== undefined) row.residual_impact = patch.residualImpact;
  if (patch.earlyWarning !== undefined) row.early_warning = patch.earlyWarning.trim();
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.closureNote !== undefined) row.closure_note = patch.closureNote.trim();
  if (patch.lastReviewedAt !== undefined) row.last_reviewed_at = patch.lastReviewedAt;
  return row;
}

// One project at a time, unlike listTasks: the register is a screen you open for a project,
// not a board that spans every project you are a member of.
//
// Ordered by exposure so the rows that matter arrive first even before the UI sorts them,
// and by code as the tiebreak so two equally exposed risks keep a stable order between reads.
export async function listProjectRisks(
  client: SupabaseClient,
  projectId: string,
): Promise<ProjectRisk[]> {
  const { data, error } = await client
    .from("project_risks")
    .select(RISK_COLUMNS)
    .eq("project_id", projectId)
    .order("exposure", { ascending: false })
    .order("code", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as RiskRow[]).map(toProjectRisk);
}

export async function createProjectRisk(
  client: SupabaseClient,
  input: ProjectRiskInsert,
): Promise<ProjectRisk> {
  // `code` is minted by project_risks_touch() under a per-project advisory lock, so it is
  // not sent — a client-chosen id would race and would not survive the trigger anyway.
  const { projectId, ...rest } = input;
  const { data, error } = await client
    .from("project_risks")
    .insert({ project_id: projectId, ...toRiskRow(rest) })
    .select(RISK_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toProjectRisk(data as RiskRow);
}

export async function patchProjectRisk(
  client: SupabaseClient,
  id: string,
  patch: ProjectRiskPatch,
): Promise<ProjectRisk> {
  const { data, error } = await client
    .from("project_risks")
    .update(toRiskRow(patch))
    .eq("id", id)
    .select(RISK_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toProjectRisk(data as RiskRow);
}

// The audit trail behind one risk, newest first. Read on demand — the register lists dozens
// of risks and every one of them carries a history nobody is looking at until they open it.
export async function listRiskEvents(
  client: SupabaseClient,
  riskId: string,
): Promise<ProjectRiskEvent[]> {
  const { data, error } = await client
    .from("project_risk_events")
    .select(EVENT_COLUMNS)
    .eq("risk_id", riskId)
    .order("at", { ascending: false })
    .order("id", { ascending: false });
  if (error) throw new Error(error.message);
  return (data as RiskEventRow[]).map(toProjectRiskEvent);
}
