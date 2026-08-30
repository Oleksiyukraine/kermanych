import { describe, expect, it } from 'vitest';
import type { WorkspaceRisk } from '@kermanych/cloud';
import { findRiskByCode, refusalText } from '../src/stores/management-actions';

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
  // The reason is the section table's sentence, verbatim — never one the model supplied.
  it('quotes the limitation the section table owns', () => {
    const line = refusalText({ kind: 'unsupported', section: 'management-releases', request: 'додай нотатку' });
    expect(line).toContain('«Release Notes»');
    expect(line).toContain('розділ ще не реалізований');
    expect(line).not.toContain('додай нотатку');
  });

  it('resolves a section by its url segment as well as its route name', () => {
    expect(refusalText({ kind: 'unsupported', section: 'integrations', request: '' })).toContain('«Integrations»');
  });

  it('names a section this build does not have instead of inventing a reason', () => {
    const line = refusalText({ kind: 'unsupported', section: 'management-budget', request: 'зміни бюджет' });
    expect(line).toContain('management-budget');
    expect(line).toContain('якого не існує');
  });

  // The Risk Registry can be written. A refusal aimed at it is a broken prompt, and saying
  // «розділ доступний лише для читання» about a writable section would hide that.
  it('reports a refusal aimed at a writable section as the malfunction it is', () => {
    const line = refusalText({ kind: 'unsupported', section: 'management-risks', request: 'створи ризик' });
    expect(line).toContain('доступний для запису');
    expect(line).not.toContain('лише для читання');
  });
});
