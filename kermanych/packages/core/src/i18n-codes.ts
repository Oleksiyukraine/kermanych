// Stable identifiers for server-produced prose the UI localizes. The server still sends
// the human `text` as a fallback, so a build that does not know a code — or a message the
// UI has no translation for — degrades to the original Ukrainian prose, never to a blank
// row or a bare code. These identifiers let a UI that DOES know the code re-render the same
// notice/error in the user's locale, interpolating `params`.
//
// Every member is backed by a live producer in the api (file:line noted beside it). Extend
// by adding a member here AND its uk/en `notices.*` / `errors.*` message — the completeness
// test in the message catalogs fails otherwise; the exhaustiveness test below keeps each
// array in lockstep with its union.

// Notices — prose that reaches the operator as a transcript `notice` entry (supervisor) or
// a `ManagementChatReply.notices` line (management chat). `params` documents the values the
// localized message interpolates; a code with no params carries a fixed sentence.
export type NoticeCode =
  // management-chat.service.ts — the seven strings a management turn can surface:
  | "chat_reset" // management-chat.service.ts:131 — turn aborted because the conversation was reset (params: none)
  | "omp_launch_timeout" // management-chat.service.ts:218 — omp did not start in time (params: { seconds })
  | "omp_exited_during_reply" // management-chat.service.ts:266 — the omp child died mid-turn (params: { reason })
  | "assistant_no_reply_timeout" // management-chat.service.ts:277 — no reply within the turn budget (params: { seconds })
  | "interactive_request_cancelled" // management-chat.service.ts:255 — an interactive prompt was auto-cancelled (params: { method })
  | "frames_lost" // management-chat.service.ts:291 — some omp frames were dropped (params: { count })
  | "helper_added_instruction" // management-chat.service.ts:165, supervisor.service.ts:1022 — a helper prepended guidance (params: { names })
  // supervisor.service.ts — the transcript notices a session turn can append:
  | "skill_added_by_trigger" // supervisor.service.ts:1072 — a trigger injected a skill (params: { trigger, skill })
  | "trigger_launches_agent" // supervisor.service.ts:1058 — a trigger launches an agent (params: { trigger, agent })
  | "trigger_skill_missing" // supervisor.service.ts:1068 — a trigger's skill was not found (params: { trigger, skill })
  | "trigger_agent_launch_failed" // supervisor.service.ts:1099 — a trigger failed to launch its agent (params: { trigger, reason })
  | "session_dormant_merged" // supervisor.service.ts:1494 — merged session, reopen to continue (params: none)
  | "session_dormant_inactive"; // supervisor.service.ts:1495 — inactive session, message to resume (params: none)

// HTTP errors — Ukrainian prose thrown as an exception and shown to the operator in place
// of a 500. `params` documents the values the localized message interpolates.
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
  // release-notes.service.ts — generation refusals and dead-child guards:
  | "project_not_in_registry" // release-notes.service.ts:55 — project not in the local registry (params: none)
  | "project_not_bound" // release-notes.service.ts:57 — project not bound on this machine (params: none)
  | "branch_not_in_repo" // release-notes.service.ts:63 — branch absent from the local repo (params: { branch })
  | "no_commits_in_range" // release-notes.service.ts:67 — no commits in the requested range (params: { branch, from, to })
  | "omp_launch_timeout" // release-notes.service.ts:116 — omp did not start in time (params: { seconds })
  | "omp_exited_during_generation" // release-notes.service.ts:110 — the omp child died mid-generation (params: { reason })
  | "generation_timeout" // release-notes.service.ts:122 — generation did not finish in time (params: { seconds })
  | "model_no_text"; // release-notes.service.ts:139 — the model returned no text (params: none)

// Runtime mirrors of the unions above. MUST list every member of their type exactly once;
// the exhaustiveness test in test/i18n-codes.spec.ts fails on a drift or a duplicate.
export const NOTICE_CODES = [
  "chat_reset",
  "omp_launch_timeout",
  "omp_exited_during_reply",
  "assistant_no_reply_timeout",
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
  "project_not_in_registry",
  "project_not_bound",
  "branch_not_in_repo",
  "no_commits_in_range",
  "omp_launch_timeout",
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
