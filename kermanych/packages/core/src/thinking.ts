// How hard the agent is told to think. This is omp's own reasoning-effort ladder
// (`omp://rpc.md` «Thinking»: `set_thinking_level`, and `get_state.thinkingLevel`), mirrored
// here rather than re-invented: the value travels verbatim into `omp --thinking <level>` at
// spawn and into a `set_thinking_level` command on a live child, and it is read back out of
// `get_state` — a Kermanych-private vocabulary would need a translation table in both
// directions and would drift the first time omp adds a rung.
//
// Ordered low → high on purpose: the UI renders the picker in this order, so the list reads
// as a ladder rather than an alphabetised set of words.
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

// The api's boundary guard: the level arrives over HTTP as an unvalidated string and is then
// written into an argv / an RPC frame, so a typo has to be refused at the door rather than
// handed to omp — which would answer with an error the operator never sees.
export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v);
}
