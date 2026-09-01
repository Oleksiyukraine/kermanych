import { describe, expect, it } from 'vitest';
import type { WorkspaceRisk } from '@kermanych/cloud';
import { findProjectByName, findRiskByCode, refusalText } from '../src/stores/management-actions';

function risk(code: string): WorkspaceRisk {
  return {
    id: `id-${code}`,
    workspaceId: 'w1',
    code,
    kind: 'threat',
    category: 'external',
    cause: 'причина',
    event: 'подія',
    consequence: 'наслідок',
    probability: 4,
    impact: 5,
    exposure: 20,
    response: 'reduce',
    responseActions: 'план',
    earlyWarning: '',
    status: 'open',
    closureNote: '',
    raisedAt: '2026-08-30T00:00:00.000Z',
    lastReviewedAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
  };
}

describe('findRiskByCode', () => {
  const rows = [risk('R-001'), risk('R-012')];

  it('matches the code as the register writes it', () => {
    expect(findRiskByCode(rows, 'R-012')?.id).toBe('id-R-012');
  });

  // The model quotes a code from the context block, from the operator's message, or from its
  // own sentence — and those three are rarely padded the same way.
  it('matches the sequence number however the model padded or cased it', () => {
    expect(findRiskByCode(rows, 'r-12')?.id).toBe('id-R-012');
    expect(findRiskByCode(rows, ' R12 ')?.id).toBe('id-R-012');
    expect(findRiskByCode(rows, 'R-1')?.id).toBe('id-R-001');
  });

  // A miss must stay a miss: patching «the nearest row» would edit a risk nobody named.
  it('returns nothing for a code the project does not have', () => {
    expect(findRiskByCode(rows, 'R-999')).toBeUndefined();
    expect(findRiskByCode(rows, 'ризик')).toBeUndefined();
    expect(findRiskByCode([], 'R-001')).toBeUndefined();
  });
});

describe('refusalText', () => {
  // A section that is still a placeholder keeps the not-built sentence — verbatim, and never
  // one the model supplied.
  it('quotes the not-built limitation for a placeholder section', () => {
    const line = refusalText({ kind: 'unsupported', section: 'management-capacity', request: 'додай людину' });
    expect(line).toContain('«Team Capacity»');
    expect(line).toContain('розділ ще не реалізований');
    expect(line).not.toContain('додай людину');
  });

  it('quotes the limitation of a section that exists but stores nothing', () => {
    const line = refusalText({ kind: 'unsupported', section: 'management-integrations', request: 'підключи Slack' });
    expect(line).toContain('«Integrations»');
    expect(line).toContain('жодне підключення не зроблено');
  });

  it('resolves a section by its url segment as well as its route name', () => {
    expect(refusalText({ kind: 'unsupported', section: 'integrations', request: '' })).toContain('«Integrations»');
  });

  it('names a section this build does not have instead of inventing a reason', () => {
    const line = refusalText({ kind: 'unsupported', section: 'management-budget', request: 'зміни бюджет' });
    expect(line).toContain('management-budget');
    expect(line).toContain('якого не існує');
  });

  // Both writable sections. A refusal aimed at one is a broken prompt, not a property of the
  // product, and saying «розділ доступний лише для читання» about a section that DOES take an
  // action would hide the malfunction behind a sentence the table no longer has.
  it('reports a refusal aimed at a writable section as the malfunction it is', () => {
    for (const section of ['management-risks', 'management-releases']) {
      const line = refusalText({ kind: 'unsupported', section, request: 'зроби це' });
      expect(line).toContain('доступний для запису');
      expect(line).not.toContain('лише для читання');
    }
  });
});

describe('findProjectByName', () => {
  const rows = [{ name: 'Kermanych UI' }, { name: 'Kermanych API' }, { name: 'Лендінг' }];

  it('matches the name as the prompt printed it, whatever the casing and padding', () => {
    expect(findProjectByName(rows, 'Kermanych API')?.name).toBe('Kermanych API');
    expect(findProjectByName(rows, '  kermanych ui ')?.name).toBe('Kermanych UI');
    expect(findProjectByName(rows, 'лендінг')?.name).toBe('Лендінг');
  });

  // A model quoting a longer or shorter form of a name means the one project it can mean.
  it('accepts a unique partial name either way round', () => {
    expect(findProjectByName(rows, 'Лендінг (маркетинг)')?.name).toBe('Лендінг');
    expect(findProjectByName([{ name: 'Kermanych UI (web)' }], 'Kermanych UI')?.name).toBe('Kermanych UI (web)');
  });

  // The one that matters: an ambiguous fragment must stay a miss. Generating a release note
  // against the wrong repository spends a model turn and produces a document about somebody
  // else's work — strictly worse than the chat asking which project was meant.
  it('refuses to pick between two candidates', () => {
    expect(findProjectByName(rows, 'Kermanych')).toBeUndefined();
    expect(findProjectByName(rows, 'Бета')).toBeUndefined();
    expect(findProjectByName(rows, '   ')).toBeUndefined();
    expect(findProjectByName([], 'Kermanych UI')).toBeUndefined();
  });
});
