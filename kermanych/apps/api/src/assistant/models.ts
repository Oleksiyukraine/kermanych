// apps/api/src/assistant/models.ts
// The model the api pins where an answer is decode-bound rather than reasoning-bound: the
// Менеджмент documentation turns and the Slack documentation bot (both answer from passages
// retrieved before the turn) and ЦУК (a console turn with no tools, mostly «відкрий X»).
// Decode is where the models differ: on this machine's own `omp bench`, Sonnet 5 sustains
// ~82 tok/s against Opus 4.8's ~57, which is a third off the wait for the same answer.
//
// The full id rather than omp's fuzzy `sonnet`: the model behind an answer must not drift
// with whatever omp decides a short name means this week.
import type { ThinkingLevel } from "@kermanych/core";

export const FAST_MODEL = "claude-sonnet-5";

// The effort pinned with it (docs/specs/2026-11-15-faster-assistant-answers.md, decisions 1–2).
// Left unset, omp takes the operator's own `defaultThinkingLevel` — `max` on a machine set up
// for agent work — and a ЦУК answer of 300 visible tokens spent 4–5k thinking: ~60 s against
// ~10 s at `low` for the same turn. `low` keeps a little room for schedule dates and for
// telling two similar sessions apart; `off` was faster still but riskier for both.
export const FAST_THINKING: ThinkingLevel = "low";
