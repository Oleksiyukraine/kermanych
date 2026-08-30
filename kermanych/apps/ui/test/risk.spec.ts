import { describe, it, expect } from 'vitest';
import type { WorkspaceRisk } from '@kermanych/cloud';
import {
  contingencyReserve,
  daysUntil,
  draftOf,
  draftToInsert,
  dueLabel,
  effectiveExposure,
  emptyDraft,
  ESCALATION_EXPOSURE,
  eventValueLabel,
  filterRisks,
  formatDate,
  isoDate,
  matrixCounts,
  mitigationGain,
  money,
  needsEscalation,
  parseAmount,
  proximityOf,
  registerGaps,
  responsesFor,
  reviewOverdue,
  sortRisks,
  statementOf,
  topByExposure,
  validateDraft,
  EMPTY_FILTER,
  type RiskDraft,
} from '../src/lib/risk';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');

// Minimal register row: only the fields the rules read, everything else at a sane default.
function risk(over: Partial<WorkspaceRisk> & { code: string }): WorkspaceRisk {
  return {
    id: over.code,
    workspaceId: 'w1',
    kind: 'threat',
    category: 'technical',
    cause: 'причина',
    event: 'подія',
    consequence: 'наслідок',
    probability: 3,
    impact: 3,
    exposure: 9,
    response: 'reduce',
    responseActions: 'дії',
    earlyWarning: 'тригер',
    status: 'open',
    closureNote: '',
    raisedAt: '2026-08-01T00:00:00.000Z',
    lastReviewedAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
    ...over,
  };
}

// A draft that passes every rule, so each case can break exactly one thing.
function draft(over: Partial<RiskDraft> = {}): RiskDraft {
  return {
    ...emptyDraft(NOW),
    cause: 'пісочниця провайдера спільна з іншими клієнтами',
    event: 'інтеграційне тестування заблокують на кілька днів',
    consequence: 'UAT зсунеться за реліз-гейт',
    proximity: '2026-09-20',
    response: 'reduce',
    responseActions: 'замовити виділений тенант',
    actionOwner: 'u2',
    actionDue: '2026-09-05',
    riskOwner: 'u1',
    earlyWarning: 'черга в sandbox довша за 30 хв',
    ...over,
  };
}

describe('effectiveExposure / needsEscalation', () => {
  // The point of scoring a residual is that management reads the residual. A risk whose
  // mitigation is scored must stop being reported at its inherent severity.
  it('reads the residual once it is scored and the inherent until then', () => {
    expect(effectiveExposure(risk({ code: 'R-1', exposure: 20 }))).toBe(20);
    expect(effectiveExposure(risk({ code: 'R-2', exposure: 20, residualExposure: 6 }))).toBe(6);
  });

  it('escalates on the effective score, not the inherent one', () => {
    const treated = risk({ code: 'R-1', exposure: 25, residualExposure: 6, status: 'treated' });
    const raw = risk({ code: 'R-2', exposure: ESCALATION_EXPOSURE });
    expect(needsEscalation(treated)).toBe(false);
    expect(needsEscalation(raw)).toBe(true);
  });

  // A materialized risk is an issue now; leaving it in the escalation count would inflate
  // the steering report with something that already has a resolution plan.
  it('never escalates a risk that has left the register', () => {
    expect(needsEscalation(risk({ code: 'R-1', exposure: 25, status: 'closed', closureNote: 'x' }))).toBe(false);
    expect(needsEscalation(risk({ code: 'R-2', exposure: 25, status: 'materialized', closureNote: 'x' }))).toBe(false);
  });

  // Undefined, not 0: «not scored yet» is not «the mitigation bought nothing».
  it('reports the mitigation gain only once the residual exists', () => {
    expect(mitigationGain(risk({ code: 'R-1', exposure: 20 }))).toBeUndefined();
    expect(mitigationGain(risk({ code: 'R-2', exposure: 20, residualExposure: 6 }))).toBe(14);
  });
});

describe('reviewOverdue', () => {
  it('flags a live row untouched for longer than the cadence', () => {
    const stale = risk({ code: 'R-1', lastReviewedAt: '2026-08-10T00:00:00.000Z' });
    const fresh = risk({ code: 'R-2', lastReviewedAt: '2026-08-28T00:00:00.000Z' });
    expect(reviewOverdue(stale, NOW)).toBe(true);
    expect(reviewOverdue(fresh, NOW)).toBe(false);
  });

  // Closed rows are history. Nagging about them would drown the rows that still need work.
  it('never flags a closed row', () => {
    const closed = risk({
      code: 'R-1',
      status: 'closed',
      closureNote: 'провайдер замінений',
      lastReviewedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(reviewOverdue(closed, NOW)).toBe(false);
  });
});

describe('proximityOf', () => {
  it('buckets by distance from today and calls out a window that has passed', () => {
    expect(proximityOf(undefined, NOW)).toBe('unset');
    expect(proximityOf('2026-08-20', NOW)).toBe('passed');
    expect(proximityOf('2026-09-05', NOW)).toBe('immediate');
    expect(proximityOf('2026-10-20', NOW)).toBe('near');
    expect(proximityOf('2027-06-01', NOW)).toBe('far');
  });
});

describe('contingencyReserve', () => {
  // Reserve justified by quantified exposure, not a flat percentage — and only by the risks
  // that are still live and actually carry a number.
  it('sums EMV over live quantified rows only', () => {
    const rows = [
      risk({ code: 'R-1', emv: 18000 }),
      risk({ code: 'R-2', emv: 4500, status: 'treated' }),
      risk({ code: 'R-3', emv: 90000, status: 'closed', closureNote: 'x' }),
      risk({ code: 'R-4' }),
    ];
    expect(contingencyReserve(rows)).toBe(22500);
  });
});

describe('topByExposure', () => {
  it('reports the top N live rows by effective exposure, ties broken deterministically', () => {
    const rows = [
      risk({ code: 'R-3', exposure: 12 }),
      risk({ code: 'R-1', exposure: 20, residualExposure: 4 }),
      risk({ code: 'R-2', exposure: 12 }),
      risk({ code: 'R-4', exposure: 25, status: 'closed', closureNote: 'x' }),
    ];
    expect(topByExposure(rows, 2).map((r) => r.code)).toEqual(['R-2', 'R-3']);
  });
});

describe('registerGaps', () => {
  it('names the mandatory IT categories with nothing live filed against them', () => {
    const gaps = registerGaps([
      risk({ code: 'R-1', category: 'security' }),
      risk({ code: 'R-2', category: 'technical' }),
    ]);
    expect(gaps).not.toContain('security');
    expect(gaps).toContain('data_migration');
    expect(gaps).toContain('ai_model');
    // `technical` is not one of the categories an audit forces in, so covering it proves
    // nothing and its absence is never reported.
    expect(gaps).not.toContain('technical');
  });

  // A closed risk is not coverage: the category was considered once and the register moved
  // on, which is exactly the state worth re-checking.
  it('does not let a closed row count as coverage', () => {
    const gaps = registerGaps([
      risk({ code: 'R-1', category: 'licensing', status: 'closed', closureNote: 'x' }),
    ]);
    expect(gaps).toContain('licensing');
  });
});

describe('matrixCounts', () => {
  it('places a treated risk in its residual cell, not its inherent one', () => {
    const counts = matrixCounts([
      risk({ code: 'R-1', probability: 5, impact: 5, exposure: 25, residualProbability: 2, residualImpact: 1 }),
      risk({ code: 'R-2', probability: 5, impact: 5, exposure: 25 }),
    ]);
    expect(counts['2:1']).toBe(1);
    expect(counts['5:5']).toBe(1);
  });
});

describe('filterRisks', () => {
  const rows = [
    risk({ code: 'R-1', category: 'vendor', exposure: 20, cause: 'спільна пісочниця sandbox' }),
    risk({ code: 'R-2', category: 'security', exposure: 4, probability: 2, impact: 2 }),
    risk({ code: 'R-3', status: 'closed', closureNote: 'x', exposure: 25 }),
  ];

  // The register opens on what is being worked; everything closed stays one click away.
  it('defaults to the live rows', () => {
    expect(filterRisks(rows, EMPTY_FILTER).map((r) => r.code)).toEqual(['R-1', 'R-2']);
  });

  it('shows every status when the filter is cleared', () => {
    expect(filterRisks(rows, { ...EMPTY_FILTER, status: '' })).toHaveLength(3);
  });

  it('narrows to what exceeds the tolerance line', () => {
    expect(
      filterRisks(rows, { ...EMPTY_FILTER, aboveTolerance: true }).map((r) => r.code),
    ).toEqual(['R-1']);
  });

  it('searches the statement, not only the code', () => {
    expect(filterRisks(rows, { ...EMPTY_FILTER, query: 'SANDBOX' }).map((r) => r.code)).toEqual(['R-1']);
  });

  it('narrows to a clicked heat-map cell', () => {
    expect(filterRisks(rows, { ...EMPTY_FILTER, cell: '2:2' }).map((r) => r.code)).toEqual(['R-2']);
  });

  it('combines the category filter with the rest', () => {
    expect(filterRisks(rows, { ...EMPTY_FILTER, category: 'security' }).map((r) => r.code)).toEqual(['R-2']);
  });
});

describe('sortRisks', () => {
  const rows = [
    risk({ code: 'R-2', exposure: 9, proximity: '2027-01-01', lastReviewedAt: '2026-08-28T00:00:00.000Z' }),
    risk({ code: 'R-1', exposure: 20, residualExposure: 4, proximity: '2026-09-01', lastReviewedAt: '2026-08-01T00:00:00.000Z' }),
    risk({ code: 'R-3', exposure: 9, lastReviewedAt: '2026-08-29T00:00:00.000Z' }),
  ];

  it('orders by effective exposure, breaking ties on the inherent score then the code', () => {
    expect(sortRisks(rows, 'exposure').map((r) => r.code)).toEqual(['R-2', 'R-3', 'R-1']);
  });

  it('puts the least recently reviewed first', () => {
    expect(sortRisks(rows, 'review').map((r) => r.code)).toEqual(['R-1', 'R-2', 'R-3']);
  });

  // A missing proximity is an unanswered question, not a distant date; sorting it in with the
  // far-future rows is how it stays unanswered.
  it('sorts a dateless risk last by proximity', () => {
    expect(sortRisks(rows, 'proximity').map((r) => r.code)).toEqual(['R-1', 'R-2', 'R-3']);
  });

  it('never mutates the input', () => {
    const before = rows.map((r) => r.code);
    sortRisks(rows, 'code');
    expect(rows.map((r) => r.code)).toEqual(before);
  });
});

describe('statementOf', () => {
  it('composes cause → event → consequence into one readable sentence', () => {
    expect(
      statementOf({
        kind: 'threat',
        cause: 'пісочниця провайдера спільна.',
        event: 'тестування буде заблоковане',
        consequence: 'UAT зсунеться за реліз-гейт',
      }),
    ).toBe(
      'Оскільки пісочниця провайдера спільна, існує ризик, що тестування буде заблоковане, ' +
        'що призвело б до UAT зсунеться за реліз-гейт.',
    );
  });

  it('switches to opportunity wording for an upside', () => {
    const s = statementOf({ kind: 'opportunity', cause: 'a', event: 'b', consequence: 'c' });
    expect(s).toContain('існує можливість, що');
    expect(s).not.toContain('існує ризик');
  });
});

describe('responsesFor', () => {
  it('offers the threat strategies plus accept, and never an opportunity one', () => {
    const threat = responsesFor('threat').map((r) => r.value);
    expect(threat).toEqual(['avoid', 'reduce', 'transfer', 'escalate', 'accept']);
    expect(responsesFor('opportunity').map((r) => r.value)).toEqual([
      'exploit',
      'enhance',
      'share',
      'accept',
    ]);
  });
});

describe('dates and money', () => {
  // Date columns are text on purpose: parsing them into a Date and back is how a due date
  // lands a day early for half of Europe.
  it('formats a date column without going through a timezone', () => {
    expect(formatDate('2026-09-20')).toBe('20.09.2026');
    expect(formatDate('2026-09-20T23:30:00.000Z')).toBe('20.09.2026');
    expect(formatDate(undefined)).toBe('—');
  });

  it('counts whole calendar days in both directions', () => {
    expect(daysUntil('2026-08-30', NOW)).toBe(0);
    expect(daysUntil('2026-09-05', NOW)).toBe(6);
    expect(daysUntil('2026-08-27', NOW)).toBe(-3);
    expect(daysUntil('не дата', NOW)).toBeUndefined();
  });

  it('states overdue rather than implying it', () => {
    expect(dueLabel('2026-08-27', NOW)).toBe('прострочено 3 дн');
    expect(dueLabel('2026-08-30', NOW)).toBe('сьогодні');
    expect(dueLabel('2026-08-31', NOW)).toBe('завтра');
    expect(dueLabel('2026-09-05', NOW)).toBe('за 6 дн');
    expect(dueLabel('2027-02-28', NOW)).toBe('за 6 міс');
  });

  it('renders today as the value a date input expects', () => {
    expect(isoDate(Date.parse('2026-01-05T09:00:00'))).toBe('2026-01-05');
  });

  it('shows money at register zoom', () => {
    expect(money(840)).toBe('$840');
    expect(money(42000)).toBe('$42k');
    expect(money(1_200_000)).toBe('$1.2M');
  });

  // 40 000 is how people type it; rejecting the spaces teaches them to leave the field empty.
  it('accepts a money figure with separators and rejects nonsense', () => {
    expect(parseAmount('40 000')).toBe(40000);
    expect(parseAmount('12,5')).toBe(12.5);
    expect(parseAmount('')).toBeUndefined();
    expect(parseAmount('дорого')).toBeNaN();
  });
});

describe('eventValueLabel', () => {
  it('translates the enum tokens the log stores and leaves a score pair alone', () => {
    expect(eventValueLabel('status', 'treated')).toBe('Оброблений');
    expect(eventValueLabel('response', 'transfer')).toBe('Передати');
    expect(eventValueLabel('scored', '3x4 / 2x2')).toBe('3x4 / 2x2');
    expect(eventValueLabel('reviewed', '')).toBe('');
  });
});

describe('validateDraft', () => {
  it('accepts a properly written row', () => {
    expect(validateDraft(draft())).toEqual([]);
  });

  it('refuses a statement that is missing any of its three parts', () => {
    expect(validateDraft(draft({ cause: '   ' }))).toHaveLength(1);
    expect(validateDraft(draft({ event: '' }))).toHaveLength(1);
    expect(validateDraft(draft({ consequence: '' }))).toHaveLength(1);
  });

  // «Monitor» is not a response — and neither is an empty actions field.
  it('demands actions, an action owner and a due date for anything but accept', () => {
    const errors = validateDraft(draft({ responseActions: '', actionOwner: '', actionDue: '' }));
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain('Моніторити');
  });

  it('lets an accepted risk stand without actions', () => {
    expect(
      validateDraft(draft({ response: 'accept', responseActions: '', actionOwner: '', actionDue: '' })),
    ).toEqual([]);
  });

  it('refuses a strategy that does not match the direction of the uncertainty', () => {
    expect(validateDraft(draft({ kind: 'opportunity', response: 'reduce' }))).toHaveLength(1);
    expect(validateDraft(draft({ kind: 'opportunity', response: 'enhance' }))).toEqual([]);
  });

  it('requires a named owner, a trigger and a proximity date', () => {
    expect(validateDraft(draft({ riskOwner: '' }))[0]).toContain('власника ризику');
    expect(validateDraft(draft({ earlyWarning: '' }))[0]).toContain('тригер');
    expect(validateDraft(draft({ proximity: '' }))[0]).toContain('проксіміті');
  });

  it('refuses half a residual score and a residual worse than the inherent one', () => {
    expect(validateDraft(draft({ residualProbability: 2, residualImpact: 0 }))).toHaveLength(1);
    expect(
      validateDraft(draft({ probability: 2, impact: 2, residualProbability: 3, residualImpact: 3 })),
    ).toHaveLength(1);
  });

  // Steering committees need to see what the mitigation bought, so «treated» without a
  // residual is not a state the register accepts.
  it('requires a residual score once the risk is called treated', () => {
    expect(validateDraft(draft({ status: 'treated' }))[0]).toContain('залишкової оцінки');
    expect(
      validateDraft(draft({ status: 'treated', residualProbability: 2, residualImpact: 2 })),
    ).toEqual([]);
  });

  it('requires both halves of an EMV or neither', () => {
    expect(validateDraft(draft({ costImpact: '40000' }))).toHaveLength(1);
    expect(validateDraft(draft({ costImpact: '40000', probabilityPct: '45' }))).toEqual([]);
    expect(validateDraft(draft({ costImpact: '40000', probabilityPct: '140' }))).toHaveLength(1);
    expect(validateDraft(draft({ costImpact: 'багато', probabilityPct: '45' }))).toHaveLength(1);
  });

  // Never delete — close with a reason. A materialized risk needs a resolution plan, not a
  // mitigation, and the message says so.
  it('refuses a terminal status with no note, and names the right note for each', () => {
    expect(validateDraft(draft({ status: 'closed' }))[0]).toContain('рядки не видаляють');
    expect(validateDraft(draft({ status: 'materialized' }))[0]).toContain('плану усунення');
    expect(validateDraft(draft({ status: 'closed', closureNote: 'провайдер замінений' }))).toEqual([]);
  });
});

describe('draftOf', () => {
  it('round-trips a stored row into editable fields, unscored residual as 0', () => {
    const d = draftOf(risk({ code: 'R-1', costImpact: 40000, probabilityPct: 45 }));
    expect(d.residualProbability).toBe(0);
    expect(d.costImpact).toBe('40000');
    expect(d.probabilityPct).toBe('45');
    expect(d.proximity).toBe('');
  });
});

describe('draftToInsert', () => {
  // The register is scoped to a WORKSPACE, not a project. A row inserted with the old key
  // would be rejected by the table outright, and one inserted with no scope at all would be
  // filed against nothing — so the scope column is asserted by name, both ways.
  it('scopes the insert to the workspace and carries the draft through', () => {
    const out = draftToInsert('w1', draft());
    expect(out.workspaceId).toBe('w1');
    expect(out).not.toHaveProperty('projectId');
    expect(out.kind).toBe('threat');
    expect(out.category).toBe('technical');
    expect(out.cause).toBe('пісочниця провайдера спільна з іншими клієнтами');
    expect(out.event).toBe('інтеграційне тестування заблокують на кілька днів');
    expect(out.consequence).toBe('UAT зсунеться за реліз-гейт');
    expect(out.probability).toBe(3);
    expect(out.impact).toBe(3);
  });
});
