// packages/core/src/risks.ts
// The risk register's vocabulary, as VALUES rather than as a union of string literals, and
// in core rather than in @kermanych/cloud, because three consumers need to enumerate it and
// only two of them can see the cloud package:
//
//   1. @kermanych/cloud's row types (`RiskKind` and friends are re-exported from here, so
//      the Postgres enums, the wire types and this table cannot drift apart);
//   2. the management assistant's prompt (apps/api/src/management/management-prompt.ts) —
//      the model is told which labels exist by printing this table, never by a hand-copied
//      list that ages the moment a category is added;
//   3. the action validator below in ./management-actions — a `risk.create` naming a
//      category Postgres has never heard of is refused in the browser, with a sentence that
//      names the offending value, instead of arriving as a 400 from PostgREST.
//
// Every label here matches the enums created in
// supabase/migrations/20260830120000_project_risks.sql — carried through the move to
// workspace scope by 20260830140000_workspace_risks.sql, which renames the TABLES and
// leaves these five types exactly as they were. The human-readable names are NOT here: they
// are copy, they are Ukrainian, and they live with the screen that renders them
// (apps/ui/src/lib/risk.ts).

export const RISK_KIND_VALUES = ["threat", "opportunity"] as const;
export type RiskKind = (typeof RISK_KIND_VALUES)[number];

export const RISK_CATEGORY_VALUES = [
  "technical",
  "security",
  "vendor",
  "resource",
  "external",
  "compliance",
  "organizational",
  "legacy",
  "key_person",
  "infrastructure",
  "data_migration",
  "performance",
  "licensing",
  "ai_model",
] as const;
export type RiskCategory = (typeof RISK_CATEGORY_VALUES)[number];

export const RISK_RESPONSE_VALUES = [
  "avoid",
  "reduce",
  "transfer",
  "escalate",
  "exploit",
  "enhance",
  "share",
  "accept",
] as const;
export type RiskResponse = (typeof RISK_RESPONSE_VALUES)[number];

export const RISK_STATUS_VALUES = ["open", "treated", "closed", "materialized"] as const;
export type RiskStatus = (typeof RISK_STATUS_VALUES)[number];

// Which strategies a direction of uncertainty may take. The same split as the Postgres
// constraint `project_risks_response_matches_kind`; keeping it here lets the assistant be
// told «reduce is for threats» before it spends a round trip finding out from the database.
export const RISK_RESPONSES_BY_KIND: Readonly<Record<RiskKind, readonly RiskResponse[]>> = {
  threat: ["avoid", "reduce", "transfer", "escalate", "accept"],
  opportunity: ["exploit", "enhance", "share", "accept"],
};

// The 1..5 scales, fixed before the project starts (the anchors each number carries are the
// ui's copy). `check (probability between 1 and 5)` is the same range.
export const RISK_SCORE_MIN = 1;
export const RISK_SCORE_MAX = 5;

export const isRiskKind = (v: unknown): v is RiskKind =>
  typeof v === "string" && (RISK_KIND_VALUES as readonly string[]).includes(v);
export const isRiskCategory = (v: unknown): v is RiskCategory =>
  typeof v === "string" && (RISK_CATEGORY_VALUES as readonly string[]).includes(v);
export const isRiskResponse = (v: unknown): v is RiskResponse =>
  typeof v === "string" && (RISK_RESPONSE_VALUES as readonly string[]).includes(v);
export const isRiskStatus = (v: unknown): v is RiskStatus =>
  typeof v === "string" && (RISK_STATUS_VALUES as readonly string[]).includes(v);

// A risk leaves the register only through a terminal status, and only WITH a reason
// (`project_risks_closure_note_required`). One predicate, so the validator and the prompt
// agree on which statuses those are.
export const isTerminalRiskStatus = (s: RiskStatus): boolean => s === "closed" || s === "materialized";
