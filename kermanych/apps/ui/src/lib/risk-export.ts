// apps/ui/src/lib/risk-export.ts
// The risk register as a file: an Excel workbook with every field of every row, and a
// printable document the desktop app turns into a PDF. Both are built here from the SAME
// rules the register screen scores with (lib/risk.ts), so a risk that reads «high, 16» on
// screen reads «high, 16» in the file somebody forwards to the sponsor.
//
// Pure and DOM-free: the caller passes `t`, the member lookup and the clock, and gets back
// a sheet model or an HTML string. Writing the bytes and saving them is lib/export-file.ts.
import type { WorkspaceRisk } from '@kermanych/cloud';
import { formatIsoDate, todayIso } from './calendar';
import {
  ESCALATION_EXPOSURE,
  REVIEW_CADENCE_DAYS,
  bandLabel,
  bandOf,
  categoryLabel,
  effectiveExposure,
  kindLabel,
  needsEscalation,
  responseLabel,
  statementOf,
  statusLabel,
  type RiskBand,
} from './risk';
import { sheetName, type XlsxCell, type XlsxSheet } from './xlsx';

export type RiskExportFormat = 'pdf' | 'xlsx';

// Which rows the operator asked for. It is printed in the document, because «12 risks» on a
// page that is really a hand-picked subset reads as the whole register.
export type RiskExportScope = 'all' | 'selected';

export type Translate = (key: string, named?: Record<string, unknown>) => string;

export type RiskExportContext = {
  t: Translate;
  // A profile id to the name the register screen shows beside it.
  memberName: (id: string) => string;
  workspaceName: string;
  scope: RiskExportScope;
  nowMs: number;
};

const COL = 'management.risks.export.columns.';

// An audit instant as the operator's own calendar day. The date columns (proximity, action
// due) are already calendar days and go straight through formatIsoDate.
function localDate(instant: string | undefined): string {
  const ms = instant ? Date.parse(instant) : Number.NaN;
  return Number.isNaN(ms) ? '' : formatIsoDate(todayIso(ms));
}

function owner(id: string | undefined, ctx: RiskExportContext): string {
  return id ? ctx.memberName(id) : '';
}

// ── Excel ───────────────────────────────────────────────────────────────────────
// One row per risk, one column per field — the export a register is filtered and pivoted
// in. Scores and money are numbers, not text, so the sheet can sort and sum them. The
// statement is kept in its three parts rather than as the composed sentence: filtering by
// cause is the question a spreadsheet gets asked.

type RiskColumn = { key: string; width: number; value: (r: WorkspaceRisk, ctx: RiskExportContext) => XlsxCell };

const XLSX_COLUMNS: readonly RiskColumn[] = [
  { key: 'code', width: 8, value: (r) => r.code },
  { key: 'kind', width: 12, value: (r, c) => c.t(kindLabel(r.kind)) },
  { key: 'category', width: 26, value: (r, c) => c.t(categoryLabel(r.category)) },
  { key: 'cause', width: 36, value: (r) => r.cause },
  { key: 'event', width: 36, value: (r) => r.event },
  { key: 'consequence', width: 36, value: (r) => r.consequence },
  { key: 'probability', width: 6, value: (r) => r.probability },
  { key: 'impact', width: 6, value: (r) => r.impact },
  { key: 'exposure', width: 8, value: (r) => r.exposure },
  { key: 'residualProbability', width: 9, value: (r) => r.residualProbability },
  { key: 'residualImpact', width: 9, value: (r) => r.residualImpact },
  { key: 'residualExposure', width: 11, value: (r) => r.residualExposure },
  // Banded on the effective score, exactly as the screen colours the row.
  { key: 'band', width: 10, value: (r, c) => c.t(bandLabel(bandOf(effectiveExposure(r)))) },
  { key: 'response', width: 12, value: (r, c) => c.t(responseLabel(r.response)) },
  { key: 'responseActions', width: 48, value: (r) => r.responseActions },
  { key: 'riskOwner', width: 20, value: (r, c) => owner(r.riskOwner, c) },
  { key: 'actionOwner', width: 20, value: (r, c) => owner(r.actionOwner, c) },
  { key: 'actionDue', width: 12, value: (r) => formatIsoDate(r.actionDue) },
  { key: 'proximity', width: 12, value: (r) => formatIsoDate(r.proximity) },
  { key: 'earlyWarning', width: 40, value: (r) => r.earlyWarning },
  { key: 'costImpact', width: 12, value: (r) => r.costImpact },
  { key: 'probabilityPct', width: 10, value: (r) => r.probabilityPct },
  { key: 'emv', width: 12, value: (r) => r.emv },
  { key: 'status', width: 14, value: (r, c) => c.t(statusLabel(r.status)) },
  { key: 'closureNote', width: 40, value: (r) => r.closureNote },
  { key: 'raisedAt', width: 12, value: (r) => localDate(r.raisedAt) },
  { key: 'lastReviewedAt', width: 14, value: (r) => localDate(r.lastReviewedAt) },
];

export function riskRegisterSheet(risks: readonly WorkspaceRisk[], ctx: RiskExportContext): XlsxSheet {
  return {
    name: sheetName(ctx.t('management.risks.export.sheetName')),
    columns: XLSX_COLUMNS.map((c) => ({ label: ctx.t(COL + c.key), width: c.width })),
    rows: risks.map((r) => XLSX_COLUMNS.map((c) => c.value(r, ctx))),
  };
}

// ── PDF ─────────────────────────────────────────────────────────────────────────
// A document to be READ, so it is laid out like the register screen rather than like the
// sheet: the composed statement, the two scores as coloured badges, the response with its
// plan, and one row per risk that never splits across a page. Landscape A4, because nine
// columns of prose do not fit portrait.

function html(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Light print colours, not the app's tokens: the document leaves the app, and a dark-theme
// page is unreadable on paper. Same four bands, same order of alarm.
const BAND_STYLE: Record<RiskBand, string> = {
  low: 'background:#e6f4ea;color:#1e5b2e',
  medium: 'background:#fff4d6;color:#7a5600',
  high: 'background:#ffe3cc;color:#8a3b00',
  extreme: 'background:#fbd5d5;color:#8e1111',
};

function badge(exposure: number, p: number | undefined, i: number | undefined): string {
  return (
    `<span class="score" style="${BAND_STYLE[bandOf(exposure)]}">${exposure}</span>` +
    `<span class="pi">P${p ?? '?'} × I${i ?? '?'}</span>`
  );
}

function dash(s: string): string {
  return s ? html(s) : '<span class="muted">—</span>';
}

function pdfRow(r: WorkspaceRisk, ctx: RiskExportContext): string {
  const { t } = ctx;
  const statement = statementOf(r);
  const meta = [t(categoryLabel(r.category)), r.kind === 'opportunity' ? t(kindLabel(r.kind)) : '']
    .filter(Boolean)
    .join(' · ');
  const notes = [
    r.earlyWarning.trim() ? `<div class="note"><b>${html(t(`${COL}earlyWarning`))}:</b> ${html(r.earlyWarning)}</div>` : '',
    r.closureNote.trim() ? `<div class="note"><b>${html(t(`${COL}closureNote`))}:</b> ${html(r.closureNote)}</div>` : '',
  ].join('');
  const residual =
    r.residualExposure !== undefined
      ? badge(r.residualExposure, r.residualProbability, r.residualImpact)
      : `<span class="muted">${html(t('management.risks.notScored'))}</span>`;
  const action = [owner(r.actionOwner, ctx), formatIsoDate(r.actionDue)].filter(Boolean).join(' · ');
  return (
    `<tr${needsEscalation(r) ? ' class="hot"' : ''}>` +
    `<td class="code">${html(r.code)}</td>` +
    `<td><div class="statement">${html(t(statement.key, statement.params))}</div><div class="meta">${html(meta)}</div>${notes}</td>` +
    `<td class="c">${badge(r.exposure, r.probability, r.impact)}</td>` +
    `<td class="c">${residual}</td>` +
    `<td><b>${html(t(responseLabel(r.response)))}</b><div class="pre">${html(r.responseActions)}</div>` +
    (action ? `<div class="meta">${html(action)}</div>` : '') +
    '</td>' +
    `<td>${dash(owner(r.riskOwner, ctx))}</td>` +
    `<td>${dash(formatIsoDate(r.proximity))}</td>` +
    `<td>${html(t(statusLabel(r.status)))}</td>` +
    `<td>${dash(localDate(r.lastReviewedAt))}</td>` +
    '</tr>'
  );
}

const PDF_STYLE = `
@page { size: A4 landscape; margin: 12mm 10mm 14mm; }
* { box-sizing: border-box; }
body { margin: 0; font: 9pt/1.4 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #1b1b1f; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
h1 { margin: 0 0 2px; font-size: 15pt; font-weight: 800; letter-spacing: -0.01em; }
.lead { margin: 0 0 10px; color: #5b5b66; }
table { width: 100%; border-collapse: collapse; }
thead { display: table-header-group; }
th { text-align: left; font-size: 7.5pt; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #5b5b66; border-bottom: 1.5px solid #1b1b1f; padding: 5px 6px; }
td { vertical-align: top; padding: 6px; border-bottom: 1px solid #d9d9e0; }
tr { break-inside: avoid; page-break-inside: avoid; }
tr.hot td:first-child { box-shadow: inset 3px 0 0 #c62828; }
.code { font-family: ui-monospace, Menlo, Consolas, monospace; white-space: nowrap; }
.c { text-align: center; white-space: nowrap; }
.statement { font-weight: 600; }
.meta, .pi, .muted { color: #6b6b76; font-size: 8pt; }
.pi { display: block; }
.note { margin-top: 3px; font-size: 8pt; }
.pre { white-space: pre-wrap; }
.score { display: inline-block; min-width: 22px; padding: 1px 5px; border-radius: 4px; font-weight: 700; text-align: center; }
.plan { margin-top: 10px; color: #6b6b76; font-size: 8pt; }
`;

export function riskRegisterHtml(risks: readonly WorkspaceRisk[], ctx: RiskExportContext): string {
  const { t } = ctx;
  const title = `${t('management.risks.export.docTitle')} · ${ctx.workspaceName}`;
  const lead = t('management.risks.export.docMeta', {
    count: risks.length,
    scope: t(`management.risks.export.scope.${ctx.scope}`),
    date: formatIsoDate(todayIso(ctx.nowMs)),
  });
  const head = ['code', 'statement', 'exposure', 'residualExposure', 'response', 'riskOwner', 'proximity', 'status', 'lastReviewedAt']
    .map((k) => `<th>${html(t(COL + k))}</th>`)
    .join('');
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    // The title is what a browser's «Save as PDF» offers as the file name.
    `<title>${html(riskExportFileName(ctx, 'pdf').replace(/\.pdf$/, ''))}</title>` +
    `<style>${PDF_STYLE}</style></head><body>` +
    `<h1>${html(title)}</h1><p class="lead">${html(lead)}</p>` +
    `<table><thead><tr>${head}</tr></thead><tbody>${risks.map((r) => pdfRow(r, ctx)).join('')}</tbody></table>` +
    `<p class="plan">${html(t('management.risks.plan', { exposure: ESCALATION_EXPOSURE, days: REVIEW_CADENCE_DAYS }))}</p>` +
    '</body></html>'
  );
}

// ── File name ───────────────────────────────────────────────────────────────────

// `risk-register-<workspace>-<YYYY-MM-DD>.<ext>`. The workspace name is free text, so the
// characters no file system accepts are dropped and whitespace becomes a dash; letters in
// any script stay, because a Cyrillic workspace name is still the most recognisable part.
export function riskExportFileName(
  ctx: Pick<RiskExportContext, 't' | 'workspaceName' | 'nowMs'>,
  format: RiskExportFormat,
): string {
  const workspace = ctx.workspaceName
    .replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '')
    .trim()
    .replace(/\s+/g, '-');
  const parts = [ctx.t('management.risks.export.fileBase'), workspace, todayIso(ctx.nowMs)].filter(Boolean);
  return `${parts.join('-')}.${format}`;
}
