import { expect, test } from 'vitest';
import { AGENTS } from '@kermanych/core';
import {
  triggerActionOptions,
  triggerAgentOptions,
  triggerMatches,
  triggerSourceLabel,
} from '../src/lib/settings';

// The pure half of the Тригери pane. A trigger fires WITHOUT the model choosing to, so
// everything the editor refuses to offer is a combination the runtime would reject — and the
// one thing the editor must catch that the runtime cannot is a pattern that does not compile:
// at launch it is a warning in a log nobody reads and a rule that silently never fires.

test('only an operator-sourced trigger may run an agent', () => {
  // A child has no callback into Kermanych, so an `agent` action can only hang off the one
  // source Kermanych itself matches. The DB carries the same rule as a check constraint
  // (project_triggers_agent_action_is_operator); this is what stops the editor from offering
  // a choice that postgrest would refuse on save.
  expect(triggerActionOptions('operator').map((o) => o.value)).toEqual(['skill', 'agent']);
  for (const s of ['assistant', 'thinking', 'tool'] as const) {
    expect(triggerActionOptions(s).map((o) => o.value)).toEqual(['skill']);
  }
});

test('the agent picker offers exactly the instruction-carrying agents, from the registry', () => {
  // `finish` and `summary` are automations: no model, no session, no instruction. The
  // supervisor's runTriggerAgent throws «агента … не існує» for them, so offering them would
  // build a trigger whose only possible outcome is an error notice. Derived from AGENTS by the
  // presence of an instruction rather than listed by hand, so a seventh agent cannot drift out
  // of the picker — the same filter assignmentRows uses.
  expect(triggerAgentOptions(AGENTS).map((o) => o.value)).toEqual([
    'review',
    'promote',
    'pull-request',
    'resolve-conflict',
  ]);
  expect(triggerAgentOptions(AGENTS).map((o) => o.label)).toEqual([
    'Ревізор',
    'Промоутер',
    'Провізор',
    'Вирішувач конфліктів',
  ]);
});

test('the test field reports a match, a miss, and a broken pattern distinguishably', () => {
  expect(triggerMatches('new env var', 'we need a new env var here')).toBe(true);
  expect(triggerMatches('new env var', 'nothing relevant')).toBe(false);
  expect(typeof triggerMatches('env(', 'anything')).toBe('string');
});

// The load-bearing one. `false` and «this does not compile» must never be the same answer:
// a miss invites the operator to widen the pattern, while an uncompilable pattern means the
// trigger can never fire at all. Asserted for every source, because the editor shows this
// line whatever the source is.
test('a pattern that does not compile reports a message rather than a miss', () => {
  for (const s of ['operator', 'assistant', 'thinking', 'tool'] as const) {
    const got = triggerMatches('env(', 'env', s);
    expect(typeof got).toBe('string');
    expect(got as string).not.toBe('');
  }
});

// Kermanych compiles an operator pattern with `i` (supervisor.service.ts, matchOperatorTriggers)
// because it runs against prose a human typed, where the capitalisation of a sentence is not a
// decision they made. The other three sources become TTSR rule conditions that omp compiles
// itself, and Kermanych adds no flag to them — so the test field must not promise a match
// Kermanych is not the one making.
test('an operator pattern is tested case-insensitively and a child-side one is not', () => {
  expect(triggerMatches('Env Var', 'add an env var', 'operator')).toBe(true);
  expect(triggerMatches('Env Var', 'add an env var', 'thinking')).toBe(false);
  expect(triggerMatches('env var', 'add an env var', 'thinking')).toBe(true);
});

// A short pattern matches far more than it looks, and every match costs a turn. The editor
// says so beside the field, with these very words; this is what pins them. (The brief's own
// example — `env` matching «Convention» — is not true: C-o-n-v-e-n-t has no `env` in it. The
// warning would have been teaching a rule with a counter-example attached.)
test('a short pattern matches substrings of unrelated words', () => {
  for (const sample of ['.env', 'environment', 'Envoy']) {
    expect(triggerMatches('env', sample, 'operator')).toBe(true);
  }
  // And the capital is only forgiven on the source Kermanych matches itself.
  expect(triggerMatches('env', 'Envoy', 'assistant')).toBe(false);
});

test('a source outside the union labels itself rather than rendering blank', () => {
  // Rows predating the DB constraint exist in the api's own tests (triggers.spec.ts keeps a
  // `reasoning` row). The list must name what it read instead of showing an empty cell.
  expect(triggerSourceLabel('thinking')).toBe('розмірковування моделі');
  expect(triggerSourceLabel('reasoning')).toBe('reasoning');
});
