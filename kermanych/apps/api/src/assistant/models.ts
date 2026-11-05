// apps/api/src/assistant/models.ts
// The model the api pins where an answer is decode-bound rather than reasoning-bound: the
// Менеджмент documentation turns and the Slack documentation bot (both answer from passages
// retrieved before the turn) and ЦУК (a console turn with no tools, mostly «відкрий X»).
// Decode is where the models differ: on this machine's own `omp bench`, Sonnet 5 sustains
// ~82 tok/s against Opus 4.8's ~57, which is a third off the wait for the same answer.
//
// The full id rather than omp's fuzzy `sonnet`: the model behind an answer must not drift
// with whatever omp decides a short name means this week.
export const FAST_MODEL = "claude-sonnet-5";
