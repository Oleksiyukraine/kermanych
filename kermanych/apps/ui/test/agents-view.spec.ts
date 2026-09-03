import { expect, test } from 'vitest';
import { AGENTS } from '@kermanych/core';
import { uk } from '../src/i18n/uk';

// The pure half of the «ШІ команда» catalogue. The panel itself is read-only markup over
// `AGENTS`, so what is worth pinning here is the badge vocabulary — an operator must never
// see a raw `kind` string — and the two promises the panel's markup makes about the
// registry: every entry falls into exactly one of its two branches, and a template it
// prints verbatim still carries the `{{holes}}` the runtime fills.

test('every kind has a Ukrainian label, and they differ', () => {
  // The badge vocabulary now lives in the i18n catalogue; the panel derives the key
  // from `kind` and renders it via t(). An operator must never see a raw enum, so each
  // kind resolves to a distinct, non-empty label.
  const labels = (['session', 'procedure', 'automation'] as const).map(
    (k) => uk.settings.agentKind[k],
  );
  expect(labels).toEqual(['власна сесія', 'процедура', 'без ШІ']);
  expect(new Set(labels).size).toBe(3);
  for (const l of labels) expect(l.trim()).not.toBe('');
});

test('the catalogue can render every registry entry: four with a template, two without', () => {
  expect(AGENTS.filter((a) => a.instruction)).toHaveLength(4);
  expect(AGENTS.filter((a) => !a.instruction).every((a) => a.kind === 'automation')).toBe(true);
});

// The panel prints the template as-is and tells the operator the braces are filled at launch.
// A hole renamed in the runtime but not in the text would make that caption a lie.
test('every declared hole is visible in the template the catalogue prints', () => {
  for (const a of AGENTS) {
    if (!a.instruction) continue;
    for (const hole of a.holes ?? []) expect(a.instruction).toContain(`{{${hole}}}`);
  }
});
