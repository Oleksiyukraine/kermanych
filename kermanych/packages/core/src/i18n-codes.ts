// Stable identifiers for server-produced prose the UI localizes. The server still sends
// the human `text`/`message` as a fallback, so a build that does not know a code — or a
// message the UI has no translation for — degrades to the original Ukrainian prose, never
// to a blank row or a bare code. These identifiers let a UI that DOES know the code
// re-render the same notice/error in the user's locale, interpolating `params`.
//
// Every member is backed by a live producer in the api (file:line noted beside it). Extend
// by adding a member here AND its uk/en `notices.*` / `errors.*` message — the completeness
// test in the message catalogs fails otherwise; the exhaustiveness test below keeps each
// array in lockstep with its union.

// Notices — prose RETURNED to the operator as a transcript `notice` entry (supervisor) or a
// `ManagementChatReply.notices` line (management chat). These never abort a turn: they ride
// alongside a real answer. A turn that FAILS is an `ApiErrorCode`, thrown to the controller.
// `params` documents the values the localized message interpolates; a code with no params
// carries a fixed sentence.
export type NoticeCode =
  // management-chat.service.ts — asides a completed turn appends to its reply:
  | "interactive_request_cancelled" // management-chat.service.ts:255 — an interactive prompt was auto-cancelled (params: { method })
  | "frames_lost" // management-chat.service.ts:291 — some omp frames were dropped (params: { count })
  | "helper_added_instruction" // management-chat.service.ts:165, supervisor.service.ts:1024 — a helper prepended guidance (params: { names, count })
  // supervisor.service.ts — the transcript notices a session turn can append:
  | "skill_added_by_trigger" // supervisor.service.ts:1074 — a trigger injected a skill (params: { trigger, skill })
  | "trigger_launches_agent" // supervisor.service.ts:1060 — a trigger launches an agent (params: { trigger, agent })
  | "trigger_skill_missing" // supervisor.service.ts:1070 — a trigger's skill was not found (params: { trigger, skill })
  | "trigger_agent_launch_failed" // supervisor.service.ts:1101 — a trigger failed to launch its agent (params: { trigger, reason })
  | "session_dormant_merged" // supervisor.service.ts:1496 — merged session, reopen to continue (params: none)
  | "session_dormant_inactive"; // supervisor.service.ts:1497 — inactive session, message to resume (params: none)

// HTTP errors — Ukrainian prose thrown as an exception and shown to the operator in place
// of a 500. The controller carries `{ code, message, params }` in the response body (see
// `ApiErrorBody`). `params` documents the values the localized message interpolates.
export type ApiErrorCode =
  // management.controller.ts — request-validation refusals:
  | "conversation_id_missing" // management.controller.ts:61,104 — conversationId absent (params: none)
  | "message_empty" // management.controller.ts:65 — blank message (params: none)
  | "workspace_missing" // management.controller.ts:74 — workspaceId absent (params: none)
  | "section_context_missing" // management.controller.ts:83 — section context absent (params: none)
  | "project_missing" // management.controller.ts:124 — projectId absent (params: none)
  | "branch_missing" // management.controller.ts:126 — branch absent (params: none)
  | "period_format_invalid" // management.controller.ts:130 — range is not a YYYY-MM-DD pair (params: none)
  | "period_start_after_end" // management.controller.ts:132 — range start is after its end (params: none)
  // management-chat.service.ts — a management turn that fails is thrown to the controller:
  | "omp_launch_timeout" // management-chat.service.ts:218 & release-notes.service.ts:116 — omp did not start in time (params: { seconds })
  | "omp_exited_during_reply" // management-chat.service.ts:266 — the omp child died mid-turn (params: { reason })
  | "assistant_no_reply_timeout" // management-chat.service.ts:277 — no reply within the turn budget (params: { seconds })
  // release-notes.service.ts — generation refusals and dead-child guards:
  | "project_not_in_registry" // release-notes.service.ts:55 — project not in the local registry (params: none)
  | "project_not_bound" // release-notes.service.ts:57 — project not bound on this machine (params: none)
  | "branch_not_in_repo" // release-notes.service.ts:63 — branch absent from the local repo (params: { branch })
  | "no_commits_in_range" // release-notes.service.ts:67 — no commits in the requested range (params: { branch, from, to })
  | "omp_exited_during_generation" // release-notes.service.ts:110 — the omp child died mid-generation (params: { reason })
  | "generation_timeout" // release-notes.service.ts:122 — generation did not finish in time (params: { seconds })
  | "model_no_text"; // release-notes.service.ts:139 — the model returned no text (params: none)

// Runtime mirrors of the unions above. MUST list every member of their type exactly once;
// the exhaustiveness test in test/i18n-codes.spec.ts fails on a drift or a duplicate.
export const NOTICE_CODES = [
  "interactive_request_cancelled",
  "frames_lost",
  "helper_added_instruction",
  "skill_added_by_trigger",
  "trigger_launches_agent",
  "trigger_skill_missing",
  "trigger_agent_launch_failed",
  "session_dormant_merged",
  "session_dormant_inactive",
] as const satisfies readonly NoticeCode[];

export const API_ERROR_CODES = [
  "conversation_id_missing",
  "message_empty",
  "workspace_missing",
  "section_context_missing",
  "project_missing",
  "branch_missing",
  "period_format_invalid",
  "period_start_after_end",
  "omp_launch_timeout",
  "omp_exited_during_reply",
  "assistant_no_reply_timeout",
  "project_not_in_registry",
  "project_not_bound",
  "branch_not_in_repo",
  "no_commits_in_range",
  "omp_exited_during_generation",
  "generation_timeout",
  "model_no_text",
] as const satisfies readonly ApiErrorCode[];

// Compile-time exhaustiveness (checked by `tsc` at build; test/ is not compiled). The
// `satisfies` above rejects an array member absent from its union; these reject a union
// member absent from its array. Either drift makes `tsc -p tsconfig.json` fail.
type AssertNever<T extends never> = T;
type _NoticeExhaustive = AssertNever<Exclude<NoticeCode, (typeof NOTICE_CODES)[number]>>;
type _ApiErrorExhaustive = AssertNever<Exclude<ApiErrorCode, (typeof API_ERROR_CODES)[number]>>;

// The locales the UI ships. The api threads the operator's active locale into the model
// prompts (management-prompt.ts / release-notes-prompt.ts) so the answer is written in it;
// the prompt bodies stay Ukrainian templates and only the "answer in X" directive varies.
export type Locale = "uk" | "en";

// Interpolation values a localized message reads. Numbers (seconds, count) travel unquoted
// so vue-i18n can format and pluralize them; everything else is prose the message inlines.
export type NoticeParams = Record<string, string | number>;

// A notice as it crosses the wire: the server's Ukrainian `text` is always present as the
// fallback, and `code`/`params` let a UI that knows the code re-render it in the locale.
export type Notice = { text: string; code?: NoticeCode; params?: NoticeParams };

export type ApiErrorParams = Record<string, string | number>;

// The body an HTTP error carries. `message` is the server's Ukrainian sentence — shown
// verbatim when the UI does not know `code` — and `code`/`params` localize it otherwise.
export type ApiErrorBody = { code: ApiErrorCode; message: string; params?: ApiErrorParams };

// Management action-rejections — one line per action block the assistant emitted that did
// NOT validate (`ManagementChatReply.rejected`). Unlike a Notice, a rejection ALWAYS carries
// a code: it is core-produced prose with no omp origin, so every site here is enumerated and
// localizable. The Ukrainian `text` stays the fallback a build without the code shows. Each
// member is backed by a `return { error }` site in management-actions.ts; extend by adding a
// member here AND its uk/en `rejections.*` message (the catalog completeness test fails
// otherwise) — the exhaustiveness assert below keeps the array in lockstep with the union.
export type ManagementRejectionCode =
  // riskPatch — one field of a risk, validated against ./risks and the register's CHECKs:
  | "riskKindUnknown" // kind is neither threat nor opportunity (params: { value })
  | "riskCategoryUnknown" // category is not a register category (params: { value, allowed })
  | "riskResponseUnknown" // response is not a known strategy (params: { value })
  | "riskStatusUnknown" // status is not a register status (params: { value, allowed })
  | "riskFieldBlank" // cause/event/consequence sent blank (params: { field })
  | "riskFieldNotText" // a free-text field sent as a non-string (params: { field })
  | "riskScoreRange" // a 1–5 score out of range (params: { field, min, max, value })
  | "probabilityPctRange" // probabilityPct outside 0–100 (params: { value })
  | "costImpactNegative" // costImpact negative (params: { value })
  | "riskDateFormat" // proximity/actionDue not YYYY-MM-DD (params: { field, value })
  | "riskResponseKindMismatch" // response does not apply to kind (params: { response, kind, allowed })
  | "riskClosureNoteRequired" // a terminal status arrived without a closure note (params: { status })
  | "emvPairRequired" // costImpact and probabilityPct must arrive together (params: none)
  | "residualPairRequired" // residualProbability and residualImpact must arrive together (params: none)
  // validateManagementAction — the block as a whole, per kind:
  | "actionNotObject" // the block body was not a JSON object (params: none)
  | "unsupportedNoSection" // an unsupported block without a section (params: none)
  | "riskCreateNoRisk" // a risk.create without its nested risk object (params: none)
  | "riskCreateMissingFields" // a risk.create missing required fields (params: { missing })
  | "riskResponseActionsRequired" // a non-accept strategy without responseActions (params: { response })
  | "riskUpdateNoCode" // a risk.update without a register code (params: none)
  | "riskUpdateNoPatch" // a risk.update without a patch object (params: { code })
  | "riskUpdateEmpty" // a risk.update that changes nothing (params: { code })
  | "releaseNoProject" // a release.notes without a project name (params: none)
  | "releaseNoBranch" // a release.notes without a branch (params: { project })
  | "releaseNoRange" // a release.notes without an inclusive range (params: { project })
  | "releaseDateFormat" // a release.notes range bound that is not a date (params: { field, value })
  | "releaseRangeReversed" // a release.notes range whose start is after its end (params: { from, to })
  | "actionKindUnknown" // a block whose kind nobody implemented (params: { value })
  // parseManagementReply — the block never parsed as JSON:
  | "blockUnreadable"; // the fenced block was not readable JSON (params: { message })

// Runtime mirror of the union above. MUST list every member exactly once.
export const MANAGEMENT_REJECTION_CODES = [
  "riskKindUnknown",
  "riskCategoryUnknown",
  "riskResponseUnknown",
  "riskStatusUnknown",
  "riskFieldBlank",
  "riskFieldNotText",
  "riskScoreRange",
  "probabilityPctRange",
  "costImpactNegative",
  "riskDateFormat",
  "riskResponseKindMismatch",
  "riskClosureNoteRequired",
  "emvPairRequired",
  "residualPairRequired",
  "actionNotObject",
  "unsupportedNoSection",
  "riskCreateNoRisk",
  "riskCreateMissingFields",
  "riskResponseActionsRequired",
  "riskUpdateNoCode",
  "riskUpdateNoPatch",
  "riskUpdateEmpty",
  "releaseNoProject",
  "releaseNoBranch",
  "releaseNoRange",
  "releaseDateFormat",
  "releaseRangeReversed",
  "actionKindUnknown",
  "blockUnreadable",
] as const satisfies readonly ManagementRejectionCode[];

type _ManagementRejectionExhaustive = AssertNever<
  Exclude<ManagementRejectionCode, (typeof MANAGEMENT_REJECTION_CODES)[number]>
>;

// A management action-rejection as it crosses the wire. Like `Notice`, the server's
// Ukrainian `text` is the fallback; `code`+`params` let the UI localize. Unlike `Notice`,
// `code` is REQUIRED — every rejection is core-produced and enumerated above.
export type ManagementRejection = { text: string; code: ManagementRejectionCode; params?: NoticeParams };
