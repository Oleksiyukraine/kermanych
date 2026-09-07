import { describe, expect, it } from 'vitest';
import type { WorkspaceMember, WorkspaceRisk } from '@kermanych/cloud';
import {
  findMemberByName,
  findProjectByName,
  findRiskByCode,
  refusalText,
} from '../src/stores/management-actions';

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
  // A read-only section quotes the section table's own limitation — verbatim, and never
  // one the model supplied.
  it('quotes the read-only limitation for a section that only reads Jira', () => {
    const line = refusalText({ kind: 'unsupported', section: 'management-capacity', request: 'додай людину' });
    expect(line).toContain('«Team Capacity»');
    expect(line).toContain('розділ лише читає оцінки й ворклоги Jira');
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

// The assignee a ticket named, resolved to the uuid the card carries. The model is shown the
// same names the app renders (`handleOf`) and never `assignee_id`, so this match is the only
// thing standing between «створи тікет на Олю» and a card in nobody's — or somebody else's —
// queue.
describe('findMemberByName', () => {
  function member(userId: string, profile?: { githubUsername?: string; displayName?: string }): WorkspaceMember {
    return {
      workspaceId: 'w1',
      userId,
      role: 'developer',
      addedAt: '2026-08-30T00:00:00.000Z',
      ...(profile ? { profile: { id: userId, ...profile } } : {}),
    };
  }

  const rows = [
    member('u1', { githubUsername: 'olya', displayName: 'Оля Петренко' }),
    member('u2', { githubUsername: 'andrii', displayName: 'Андрій Чесноков' }),
    // The roster row whose profile the caller could not read: `handleOf` falls back to the
    // raw uuid, so that uuid is the name the assistant was shown and must resolve.
    member('u3'),
  ];

  it('matches the handle the prompt printed, in any casing', () => {
    expect(findMemberByName(rows, 'olya')?.userId).toBe('u1');
    expect(findMemberByName(rows, '  ANDRII ')?.userId).toBe('u2');
    expect(findMemberByName(rows, 'Оля Петренко')?.userId).toBe('u1');
    expect(findMemberByName(rows, 'u3')?.userId).toBe('u3');
  });

  // The operator says «на Олю», not «на Оля Петренко», and the model relays what it was told.
  it('matches one word of a display name', () => {
    expect(findMemberByName(rows, 'Оля')?.userId).toBe('u1');
    expect(findMemberByName(rows, 'Чесноков')?.userId).toBe('u2');
  });

  // The one that matters: an ambiguous or absent name must stay a miss, because the executor
  // turns a miss into a question and a wrong hit into somebody else's assignment.
  it('refuses to pick between two candidates and never guesses', () => {
    const twoOlyas = [...rows, member('u4', { displayName: 'Оля Коваль' })];
    expect(findMemberByName(twoOlyas, 'Оля')).toBeUndefined();
    expect(findMemberByName(rows, 'Марія')).toBeUndefined();
    // A prefix is not a name: «Ол» must not reach «olya».
    expect(findMemberByName(rows, 'Ол')).toBeUndefined();
    expect(findMemberByName(rows, '   ')).toBeUndefined();
    expect(findMemberByName([], 'olya')).toBeUndefined();
  });
});
