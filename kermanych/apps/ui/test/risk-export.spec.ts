import { describe, it, expect } from 'vitest';
import type { WorkspaceRisk } from '@kermanych/cloud';
import { riskExportFileName, riskRegisterHtml, riskRegisterSheet, type RiskExportContext } from '../src/lib/risk-export';

// The export is the register leaving the app — forwarded to a sponsor, filtered in Excel —
// so what it must get right is what the screen gets right: the same scores, the same bands,
// real names instead of profile ids, and user text that cannot break the document it is in.

const NOW = Date.parse('2026-09-28T12:00:00.000Z');

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
    earlyWarning: '',
    status: 'open',
    closureNote: '',
    raisedAt: '2026-08-01T10:00:00.000Z',
    lastReviewedAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    ...over,
  };
}

// `t` echoes the key with its params, so an assertion reads which label was asked for.
const ctx: RiskExportContext = {
  t: (key, named) => (named ? `${key}${JSON.stringify(named)}` : key),
  memberName: (id) => ({ u1: 'Марина', u2: 'Олег' })[id] ?? id,
  workspaceName: 'Payments',
  scope: 'all',
  nowMs: NOW,
};

describe('riskRegisterSheet', () => {
  const sheet = riskRegisterSheet(
    [
      risk({
        code: 'R-001',
        probability: 4,
        impact: 5,
        exposure: 20,
        residualProbability: 2,
        residualImpact: 3,
        residualExposure: 6,
        riskOwner: 'u1',
        actionOwner: 'u2',
        actionDue: '2026-10-05',
        emv: 12000,
      }),
      risk({ code: 'R-002' }),
    ],
    ctx,
  );
  const col = (key: string): number => sheet.columns.findIndex((c) => c.label === `management.risks.export.columns.${key}`);
  const [first, second] = sheet.rows;

  it('carries scores and money as numbers the sheet can sort and sum', () => {
    expect(first![col('exposure')]).toBe(20);
    expect(first![col('residualExposure')]).toBe(6);
    expect(first![col('emv')]).toBe(12000);
  });

  it('leaves an unscored residual blank rather than claiming zero', () => {
    expect(second![col('residualExposure')]).toBeUndefined();
    expect(second![col('emv')]).toBeUndefined();
  });

  it('bands on the effective score, the way the screen colours the row', () => {
    // Inherent 20 would be extreme; the scored residual 6 is what the register manages.
    expect(first![col('band')]).toBe('risk.bands.medium');
  });

  it('names people instead of printing profile ids, and leaves the unassigned blank', () => {
    expect(first![col('riskOwner')]).toBe('Марина');
    expect(first![col('actionOwner')]).toBe('Олег');
    expect(second![col('riskOwner')]).toBe('');
  });

  it('writes dates in the house format', () => {
    expect(first![col('actionDue')]).toBe('05.10.2026');
    expect(first![col('raisedAt')]).toBe('01.08.2026');
  });
});

describe('riskRegisterHtml', () => {
  it('escapes user text, so a statement cannot inject markup into the document', () => {
    const doc = riskRegisterHtml([risk({ code: 'R-003', cause: '<img src=x onerror=alert(1)>' })], ctx);
    expect(doc).not.toContain('<img');
    expect(doc).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('marks the rows over tolerance and only those', () => {
    const doc = riskRegisterHtml(
      [risk({ code: 'R-004', probability: 4, impact: 4, exposure: 16 }), risk({ code: 'R-005' })],
      ctx,
    );
    expect(doc.match(/<tr class="hot">/g)).toHaveLength(1);
    expect(doc).toMatch(/<tr class="hot"><td class="code">R-004<\/td>/);
  });

  it('states the scope and the count, so a hand-picked subset never reads as the register', () => {
    const doc = riskRegisterHtml([risk({ code: 'R-006' })], { ...ctx, scope: 'selected' });
    expect(doc).toContain('&quot;count&quot;:1');
    expect(doc).toContain('management.risks.export.scope.selected');
  });
});

describe('riskExportFileName', () => {
  it('keeps the workspace name readable and file-system safe', () => {
    expect(riskExportFileName({ ...ctx, workspaceName: 'Платежі: Q3 / EU' }, 'xlsx')).toBe(
      'management.risks.export.fileBase-Платежі-Q3-EU-2026-09-28.xlsx',
    );
  });

  it('drops the workspace part when nothing of the name survives', () => {
    expect(riskExportFileName({ ...ctx, workspaceName: '??' }, 'pdf')).toBe('management.risks.export.fileBase-2026-09-28.pdf');
  });
});
