// Команди: an operator's slash directive that runs a HARNESS ACTION for one chat, rather than
// adding text to the message. Pure data plus two parsers, shared by the API (which intercepts a
// command on its way to the child) and the UI (which lists them in the composer's picker): no
// fs, no cloud, no omp process knowledge.
//
// A command is NOT a helper. A helper (see helpers.ts) prepends prose to what the operator wrote
// and the model reads it as part of the turn. A command never reaches the model as text: the
// leading token is consumed and mapped to an RPC call against the live omp child. That is why it
// lives in its own table here, with no `body` and no `kind` — there is nothing to inject.

export type CommandDef = {
  // The token after the slash the operator types (`/compact`).
  name: string;
  // The picker's display name, in the product's language.
  label: string;
  // One line under the label in the picker: what the command does.
  hint: string;
};

/**
 * The shipped set. Baked into the app on purpose: a command is a way of driving the harness, not
 * a property of a repository, so every user gets the same list with nothing to configure. Adding
 * one is a content change to this constant plus its dispatch in the supervisor.
 */
export const DEFAULT_COMMANDS: readonly CommandDef[] = [
  {
    name: "compact",
    label: "Ущільнити контекст",
    hint: "стиснути історію діалогу й звільнити ліміт токенів без втрати сенсу",
  },
];

const COMMAND_BY_NAME: Record<string, CommandDef | undefined> = Object.fromEntries(
  DEFAULT_COMMANDS.map((c) => [c.name, c]),
);

// The token is the WHOLE word after the slash, bounded by whitespace or the end of the message —
// the same grammar helpers use, so `/compacted` and `/usr/bin/env` capture a candidate that is
// not a command and fall through untouched. Nothing but an exact known name is ever intercepted.
const COMMAND_TOKEN_RE = /^\/(\S+)(?=\s|$)/;

export type ParsedCommand = {
  // The resolved command name (a key of DEFAULT_COMMANDS).
  name: string;
  // Everything after the token, trimmed. Passed through as the command's free-text argument —
  // for `/compact` these become omp's compaction `customInstructions`. Empty string when none.
  args: string;
};

/**
 * Resolve the LEADING command token of an operator's message, or `null` when the message does not
 * begin with a known command. Leading only, exact-name only: a slash mid-sentence, a path, or an
 * unknown token all return `null` and leave the message to be delivered as an ordinary prompt.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const head = text.trimStart();
  const m = COMMAND_TOKEN_RE.exec(head);
  if (!m) return null;
  const def = COMMAND_BY_NAME[m[1]!];
  if (!def) return null;
  return { name: def.name, args: head.slice(m[0].length).trim() };
}

/**
 * The draft a composer holds after the operator picks `name` from the picker. At the FRONT, and a
 * no-op when the draft already leads with the same command — mirroring `prependHelper`, so a
 * double pick costs nothing.
 */
export function prependCommand(value: string, name: string): string {
  if (parseCommand(value)?.name === name) return value;
  return `/${name} ${value}`;
}
