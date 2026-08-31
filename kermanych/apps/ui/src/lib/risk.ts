// apps/ui/src/lib/risk.ts
// The risk register's rules, as pure functions and data tables. apps/ui has no component
// tests (apps/ui/test/*.spec.ts are unit only), so everything the register DECIDES —
// scoring, tolerance, review cadence, what makes a row valid — lives here rather than
// inside ManagementRisksPage.vue, and is pinned by apps/ui/test/risk.spec.ts.
//
// This module is also where the project's risk management PLAN is written down. The 1–5
// scales, the severity bands, the escalation threshold and the review cadence are agreed
// before a project starts and must be the same numbers everywhere they are quoted — a
// register scored against one scale and reported against another is worse than no register.
//
// Type-only imports on purpose: the file must stay loadable under bare vitest, which cannot
// resolve @kermanych/cloud's CJS dist.
import type {
  WorkspaceRisk,
  WorkspaceRiskInsert,
  WorkspaceRiskPatch,
  RiskCategory,
  RiskEventKind,
  RiskKind,
  RiskResponse,
  RiskStatus,
} from '@kermanych/cloud';
import { formatIsoDate, isoParts, todayIso } from './calendar';
import { tokens } from './format';

const DAY = 86_400_000;

// ── The plan: scales, bands, thresholds ─────────────────────────────────────────

export const SCALE = [1, 2, 3, 4, 5] as const;

// Anchors, not adjectives. «Середня ймовірність» means nothing across two people; a band of
// percentages means the same thing to both, which is the only way two risks scored by two
// people end up comparable in one register.
export const PROBABILITY_ANCHORS: Readonly<Record<number, string>> = {
  1: 'Дуже низька — до 10%',
  2: 'Низька — 10–30%',
  3: 'Середня — 30–50%',
  4: 'Висока — 50–75%',
  5: 'Дуже висока — понад 75%',
};

export const IMPACT_ANCHORS: Readonly<Record<number, string>> = {
  1: 'Незначний — поглинається спринтом',
  2: 'Малий — зсув до 3 днів',
  3: 'Помітний — зсув до 2 тижнів або перевитрата до 5%',
  4: 'Серйозний — зсув реліз-гейта або перевитрата до 15%',
  5: 'Критичний — зрив релізу, контракту або комплаєнсу',
};

export type RiskBand = 'low' | 'medium' | 'high' | 'extreme';

export const BAND_LABELS: Readonly<Record<RiskBand, string>> = {
  low: 'низький',
  medium: 'середній',
  high: 'високий',
  extreme: 'критичний',
};

// P × I on a 5×5 grid, cut where the management response changes: watched, planned for,
// actively worked, and «not the PM's to sit on».
export function bandOf(exposure: number): RiskBand {
  if (exposure >= 15) return 'extreme';
  if (exposure >= 10) return 'high';
  if (exposure >= 5) return 'medium';
  return 'low';
}

// The tolerance line, agreed up front: at or above this the risk exceeds the project
// manager's authority and must go to the sponsor. Measured on the EFFECTIVE score (residual
// once the response is scored, inherent until then) — a mitigation that has not been scored
// has not been shown to have bought anything.
export const ESCALATION_EXPOSURE = 15;

// Weekly at team level. A register touched only at kickoff is theatre, so a row that has not
// been re-read within the cadence is called out on the screen rather than quietly ageing.
export const REVIEW_CADENCE_DAYS = 7;

// ── Vocabulary ──────────────────────────────────────────────────────────────────

export type Labelled<T extends string> = { value: T; label: string };

// `mandatory` marks the IT-specific categories an audit expects to find considered in every
// register. They are not required on every ROW — they are required to have been THOUGHT
// about, which is what registerGaps() reports.
export const RISK_CATEGORIES: readonly (Labelled<RiskCategory> & { mandatory: boolean })[] = [
  { value: 'technical', label: 'Технічний', mandatory: false },
  { value: 'security', label: 'Безпека та захист даних (GDPR)', mandatory: true },
  { value: 'vendor', label: 'Постачальник, SaaS-залежність, vendor lock-in', mandatory: true },
  { value: 'resource', label: 'Ресурси команди', mandatory: false },
  { value: 'external', label: 'Зовнішні чинники', mandatory: false },
  { value: 'compliance', label: 'Комплаєнс і регуляторика', mandatory: false },
  { value: 'organizational', label: 'Організаційний', mandatory: false },
  { value: 'legacy', label: 'Легасі-інтеграції та технічний борг', mandatory: true },
  { value: 'key_person', label: 'Залежність від ключової людини', mandatory: true },
  { value: 'infrastructure', label: 'Середовища та інфраструктура', mandatory: true },
  { value: 'data_migration', label: 'Якість міграції даних', mandatory: true },
  { value: 'performance', label: 'Нефункціональні вимоги, продуктивність', mandatory: true },
  { value: 'licensing', label: 'Ліцензування', mandatory: true },
  { value: 'ai_model', label: 'AI/модель і використання даних', mandatory: true },
];

export const RISK_KINDS: readonly Labelled<RiskKind>[] = [
  { value: 'threat', label: 'Загроза' },
  { value: 'opportunity', label: 'Можливість' },
];

// Which strategies are legal depends on the direction of the uncertainty. The Postgres
// constraint workspace_risks_response_matches_kind enforces the same split, so the editor
// filtering this list is a courtesy, not the guard.
export const RISK_RESPONSES: readonly (Labelled<RiskResponse> & { kind: RiskKind | 'both' })[] = [
  { value: 'avoid', label: 'Уникнути', kind: 'threat' },
  { value: 'reduce', label: 'Зменшити', kind: 'threat' },
  { value: 'transfer', label: 'Передати', kind: 'threat' },
  { value: 'escalate', label: 'Ескалювати', kind: 'threat' },
  { value: 'exploit', label: 'Використати', kind: 'opportunity' },
  { value: 'enhance', label: 'Підсилити', kind: 'opportunity' },
  { value: 'share', label: 'Розділити', kind: 'opportunity' },
  { value: 'accept', label: 'Прийняти', kind: 'both' },
];

export const RISK_STATUSES: readonly Labelled<RiskStatus>[] = [
  { value: 'open', label: 'Відкритий' },
  { value: 'treated', label: 'Оброблений' },
  { value: 'closed', label: 'Закритий' },
  { value: 'materialized', label: 'Реалізувався' },
];

export const RISK_EVENT_LABELS: Readonly<Record<RiskEventKind, string>> = {
  created: 'Занесено в реєстр',
  scored: 'Переоцінено',
  response: 'Реакція змінена',
  status: 'Статус змінено',
  reviewed: 'Переглянуто',
  edited: 'Формулювання уточнено',
};

function labelFrom<T extends string>(table: readonly Labelled<T>[], value: string): string {
  return table.find((r) => r.value === value)?.label ?? value;
}

export const categoryLabel = (v: RiskCategory): string => labelFrom(RISK_CATEGORIES, v);
export const kindLabel = (v: RiskKind): string => labelFrom(RISK_KINDS, v);
export const responseLabel = (v: RiskResponse): string => labelFrom(RISK_RESPONSES, v);
export const statusLabel = (v: RiskStatus): string => labelFrom(RISK_STATUSES, v);

export function responsesFor(kind: RiskKind): readonly Labelled<RiskResponse>[] {
  return RISK_RESPONSES.filter((r) => r.kind === kind || r.kind === 'both');
}

// The event log stores machine tokens (`open`, `reduce`, `3x4 / 2x2`). Anything that is a
// known enum label gets translated here; a score pair passes through untouched.
export function eventValueLabel(kind: RiskEventKind, token: string): string {
  if (!token) return '';
  if (kind === 'status') return statusLabel(token as RiskStatus);
  if (kind === 'response') return responseLabel(token as RiskResponse);
  return token;
}

// ── Derived facts about one risk ────────────────────────────────────────────────

// A risk is uncertain and in the future. The moment it occurs it becomes an issue and gets a
// resolution plan, not a mitigation — which is exactly the line `materialized` draws, and
// why it is not counted as live here.
export function isLive(r: WorkspaceRisk): boolean {
  return r.status === 'open' || r.status === 'treated';
}

// What the register manages TODAY: the residual score once the response has been scored,
// the inherent score until then.
export function effectiveExposure(r: WorkspaceRisk): number {
  return r.residualExposure ?? r.exposure;
}

// Above the agreed tolerance and still live — the sponsor's problem, not the PM's.
export function needsEscalation(r: WorkspaceRisk): boolean {
  return isLive(r) && effectiveExposure(r) >= ESCALATION_EXPOSURE;
}

// What the mitigation bought, in exposure points. Undefined while the residual is unscored:
// zero would be a claim, and «not yet scored» is not «bought nothing».
export function mitigationGain(r: WorkspaceRisk): number | undefined {
  return r.residualExposure === undefined ? undefined : r.exposure - r.residualExposure;
}

export function reviewOverdue(r: WorkspaceRisk, nowMs: number): boolean {
  if (!isLive(r)) return false;
  const seen = new Date(r.lastReviewedAt).getTime();
  if (Number.isNaN(seen)) return false;
  return nowMs - seen > REVIEW_CADENCE_DAYS * DAY;
}

export type Proximity = 'unset' | 'passed' | 'immediate' | 'near' | 'far';

export const PROXIMITY_LABELS: Readonly<Record<Proximity, string>> = {
  unset: 'не визначено',
  passed: 'вікно минуло',
  immediate: 'цей спринт',
  near: 'цей квартал',
  far: 'далі',
};

// A high risk eight months out is not managed like one due next sprint, so proximity is a
// dimension of its own rather than a date column nobody sorts on.
export function proximityOf(date: string | undefined, nowMs: number): Proximity {
  if (!date) return 'unset';
  const days = daysUntil(date, nowMs);
  if (days === undefined) return 'unset';
  if (days < 0) return 'passed';
  if (days <= 14) return 'immediate';
  if (days <= 90) return 'near';
  return 'far';
}

// ── Facts about the whole register ──────────────────────────────────────────────

// Schedule and budget reserve justified by quantified exposure, not a flat 10%. Only the
// live rows count, and only the ones somebody actually put a number on — a register where
// nothing is quantified reports a reserve of nothing, which is the honest answer.
export function contingencyReserve(risks: readonly WorkspaceRisk[]): number {
  return risks.reduce((sum, r) => (isLive(r) && r.emv !== undefined ? sum + r.emv : sum), 0);
}

export function quantifiedCount(risks: readonly WorkspaceRisk[]): number {
  return risks.filter((r) => isLive(r) && r.emv !== undefined).length;
}

// Status reports carry the top 5–10 by exposure plus anything newly escalated; the full
// register stays in the tool. Ties break on the inherent score, then on code, so the list is
// stable between two reads of an unchanged register.
export function topByExposure(risks: readonly WorkspaceRisk[], n: number): WorkspaceRisk[] {
  return risks
    .filter(isLive)
    .slice()
    .sort(
      (a, b) =>
        effectiveExposure(b) - effectiveExposure(a) ||
        b.exposure - a.exposure ||
        a.code.localeCompare(b.code),
    )
    .slice(0, n);
}

// The IT-specific categories with nothing live filed against them. Not an error — a project
// may genuinely carry no licensing risk — but a register that has never once considered data
// migration or key-person dependency is a register that has not been worked, and this is
// what «force them into every register» looks like on a screen.
export function registerGaps(risks: readonly WorkspaceRisk[]): RiskCategory[] {
  const covered = new Set(risks.filter(isLive).map((r) => r.category));
  return RISK_CATEGORIES.filter((c) => c.mandatory && !covered.has(c.value)).map((c) => c.value);
}

export const cellKey = (probability: number, impact: number): string => `${probability}:${impact}`;

// Counts per 5×5 cell for the heat map, on the effective score — the matrix has to show
// where the register stands after its responses, not where it stood before them.
export function matrixCounts(risks: readonly WorkspaceRisk[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of risks) {
    if (!isLive(r)) continue;
    const p = r.residualProbability ?? r.probability;
    const i = r.residualImpact ?? r.impact;
    const k = cellKey(p, i);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

// ── Filtering and sorting ───────────────────────────────────────────────────────

// '' means «no constraint»; 'active' is the register's working view (open + treated) and is
// what the screen opens on, because a register whose default view includes everything ever
// closed is a register nobody scrolls.
export type RiskStatusFilter = '' | 'active' | RiskStatus;

export const STATUS_FILTERS: readonly Labelled<RiskStatusFilter>[] = [
  { value: 'active', label: 'У роботі' },
  { value: '', label: 'Усі статуси' },
  ...RISK_STATUSES,
];

export type RiskFilter = {
  query: string;
  category: RiskCategory | '';
  status: RiskStatusFilter;
  // Only what exceeds the tolerance line — the steering-committee view.
  aboveTolerance: boolean;
  // A clicked heat-map cell, `p:i` on the effective score.
  cell: string;
};

export const EMPTY_FILTER: RiskFilter = {
  query: '',
  category: '',
  status: 'active',
  aboveTolerance: false,
  cell: '',
};

export function filterRisks(risks: readonly WorkspaceRisk[], f: RiskFilter): WorkspaceRisk[] {
  const q = f.query.trim().toLowerCase();
  return risks.filter((r) => {
    if (f.status === 'active' ? !isLive(r) : f.status !== '' && r.status !== f.status) return false;
    if (f.category !== '' && r.category !== f.category) return false;
    if (f.aboveTolerance && !needsEscalation(r)) return false;
    if (f.cell !== '' && cellKey(r.residualProbability ?? r.probability, r.residualImpact ?? r.impact) !== f.cell) {
      return false;
    }
    // The whole statement is searchable, not just the code: people look for «sandbox», not
    // for R-004.
    const hay = `${r.code} ${r.cause} ${r.event} ${r.consequence} ${r.responseActions} ${r.earlyWarning}`;
    if (q !== '' && !hay.toLowerCase().includes(q)) return false;
    return true;
  });
}

export type RiskSort = 'exposure' | 'proximity' | 'review' | 'code';

export const SORTS: readonly Labelled<RiskSort>[] = [
  { value: 'exposure', label: 'За експозицією' },
  { value: 'proximity', label: 'За проксіміті' },
  { value: 'review', label: 'За давністю перегляду' },
  { value: 'code', label: 'За номером' },
];

export function sortRisks(risks: readonly WorkspaceRisk[], sort: RiskSort): WorkspaceRisk[] {
  const out = risks.slice();
  // Every comparator falls back to the code, so the order never depends on the order the
  // rows happened to arrive in.
  const byCode = (a: WorkspaceRisk, b: WorkspaceRisk): number => a.code.localeCompare(b.code);
  if (sort === 'code') return out.sort(byCode);
  if (sort === 'review') {
    return out.sort((a, b) => a.lastReviewedAt.localeCompare(b.lastReviewedAt) || byCode(a, b));
  }
  if (sort === 'proximity') {
    // A risk with no date sorts last: it is not «infinitely far away», it is unanswered, and
    // burying it under the far-future rows is how it stays unanswered.
    return out.sort(
      (a, b) => (a.proximity ?? '9999-12-31').localeCompare(b.proximity ?? '9999-12-31') || byCode(a, b),
    );
  }
  return out.sort(
    (a, b) => effectiveExposure(b) - effectiveExposure(a) || b.exposure - a.exposure || byCode(a, b),
  );
}

// ── Statement ───────────────────────────────────────────────────────────────────

function clause(s: string): string {
  return s.trim().replace(/[.,;:]+$/, '');
}

// cause -> event -> consequence, rendered as the one sentence a steering committee can read
// without the register open. Composed rather than stored, so the three parts stay separately
// editable and a row can never drift into an unscoreable «the API might be a problem».
export function statementOf(r: Pick<WorkspaceRisk, 'kind' | 'cause' | 'event' | 'consequence'>): string {
  const middle = r.kind === 'opportunity' ? 'існує можливість, що' : 'існує ризик, що';
  const tail = r.kind === 'opportunity' ? 'що дало б' : 'що призвело б до';
  return `Оскільки ${clause(r.cause)}, ${middle} ${clause(r.event)}, ${tail} ${clause(r.consequence)}.`;
}

// ── Dates and money ─────────────────────────────────────────────────────────────

// Date-only columns are calendar answers, so they are handled as a Y-M-D triple, never as a
// parsed Date: '2026-09-20' through `new Date()` is UTC midnight, which lands a day early for
// half of Europe. The triple work itself lives in lib/calendar.ts, which the date FIELD also
// runs on — one calendar, one set of rules.
export function formatDate(value: string | undefined): string {
  // The em dash is a READ-ONLY cell's answer for «no date»; the field renders '' instead,
  // which is why the shared formatter stops short of it.
  return formatIsoDate(value) || '—';
}

// Whole calendar days from today to a date column. Both sides are collapsed to UTC midnight
// of their Y-M-D triple, so the answer is a day count and never an hours-apart rounding.
export function daysUntil(date: string, nowMs: number): number | undefined {
  const p = isoParts(date);
  if (!p) return undefined;
  const target = Date.UTC(p.year, p.month - 1, p.day);
  const t = new Date(nowMs);
  const today = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate());
  return Math.round((target - today) / DAY);
}

// A date with its distance from today attached, because «20.09.2026» alone does not tell a
// reader whether it is this sprint's problem. Overdue is stated, not implied.
export function dueLabel(date: string | undefined, nowMs: number): string {
  if (!date) return '—';
  const d = daysUntil(date, nowMs);
  if (d === undefined) return '—';
  if (d < 0) return `прострочено ${-d} дн`;
  if (d === 0) return 'сьогодні';
  if (d === 1) return 'завтра';
  if (d <= 45) return `за ${d} дн`;
  return `за ${Math.round(d / 30)} міс`;
}

// Money at the register's zoom level, on the same magnitude ladder the rest of the app uses
// for large figures. An exact cent in a reserve figure is false precision.
export function money(n: number): string {
  return `$${tokens(Math.round(n))}`;
}

// A money field as typed: spaces and thousands separators are how people actually enter
// 40 000, and rejecting them would teach the user to leave the field empty instead.
export function parseAmount(raw: string): number | undefined {
  const cleaned = raw.replace(/[\s\u00a0]/g, '').replace(/,/g, '.');
  if (cleaned === '') return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : Number.NaN;
}

// ── Validation ──────────────────────────────────────────────────────────────────

// The editor's shape: numbers the matrix picks are numbers, everything a user types is a
// string, and 0 on a residual score means «not scored yet» (the scales start at 1).
export type RiskDraft = {
  kind: RiskKind;
  category: RiskCategory;
  cause: string;
  event: string;
  consequence: string;
  probability: number;
  impact: number;
  proximity: string;
  response: RiskResponse;
  responseActions: string;
  actionOwner: string;
  actionDue: string;
  riskOwner: string;
  residualProbability: number;
  residualImpact: number;
  costImpact: string;
  probabilityPct: string;
  earlyWarning: string;
  status: RiskStatus;
  closureNote: string;
};

export function emptyDraft(nowMs: number): RiskDraft {
  return {
    kind: 'threat',
    category: 'technical',
    cause: '',
    event: '',
    consequence: '',
    probability: 3,
    impact: 3,
    proximity: todayIso(nowMs),
    response: 'reduce',
    responseActions: '',
    actionOwner: '',
    actionDue: '',
    riskOwner: '',
    residualProbability: 0,
    residualImpact: 0,
    costImpact: '',
    probabilityPct: '',
    earlyWarning: '',
    status: 'open',
    closureNote: '',
  };
}

export function draftOf(r: WorkspaceRisk): RiskDraft {
  return {
    kind: r.kind,
    category: r.category,
    cause: r.cause,
    event: r.event,
    consequence: r.consequence,
    probability: r.probability,
    impact: r.impact,
    proximity: r.proximity ?? '',
    response: r.response,
    responseActions: r.responseActions,
    actionOwner: r.actionOwner ?? '',
    actionDue: r.actionDue ?? '',
    riskOwner: r.riskOwner ?? '',
    residualProbability: r.residualProbability ?? 0,
    residualImpact: r.residualImpact ?? 0,
    costImpact: r.costImpact === undefined ? '' : String(r.costImpact),
    probabilityPct: r.probabilityPct === undefined ? '' : String(r.probabilityPct),
    earlyWarning: r.earlyWarning,
    status: r.status,
    closureNote: r.closureNote,
  };
}

// Every message names the process rule it is enforcing, because the point of the register is
// that the team learns to write rows that do not need the message. Returned in field order
// so the list reads top-to-bottom against the form.
//
// The Postgres CHECK constraints cover the same ground for any other writer; this exists so
// the user gets an instant, readable answer instead of a round trip and a constraint name.
export function validateDraft(d: RiskDraft): string[] {
  const errors: string[] = [];
  const blank = (s: string): boolean => s.trim() === '';

  if (blank(d.cause)) errors.push('Причина порожня. Ризик записується як причина → подія → наслідок.');
  if (blank(d.event)) errors.push('Подія порожня — саме її ймовірність ви оцінюєте.');
  if (blank(d.consequence)) errors.push('Наслідок порожній. Без нього немає чого оцінювати за впливом.');

  if (blank(d.proximity)) {
    errors.push('Вкажіть проксіміті: ризик через 8 місяців і ризик у цьому спринті керуються по-різному.');
  }

  if (!responsesFor(d.kind).some((r) => r.value === d.response)) {
    errors.push('Стратегія не відповідає типу: загрози уникають, зменшують, передають, ескалюють або приймають.');
  }
  if (d.response !== 'accept') {
    if (blank(d.responseActions)) {
      errors.push('Опишіть дії у відповідь. «Моніторити» — це не реакція.');
    }
    if (blank(d.actionOwner)) errors.push('У дій має бути виконавець.');
    if (blank(d.actionDue)) errors.push('У дій має бути дедлайн.');
  }

  if (blank(d.riskOwner)) {
    errors.push('Призначте власника ризику — одну людину з повноваженнями діяти, не команду.');
  }
  if (blank(d.earlyWarning)) {
    errors.push('Вкажіть тригер: без раннього індикатора ризик помітять уже як проблему.');
  }

  const hasResidual = d.residualProbability > 0 || d.residualImpact > 0;
  if (hasResidual && (d.residualProbability === 0 || d.residualImpact === 0)) {
    errors.push('Залишкова оцінка неповна: потрібні і ймовірність, і вплив.');
  }
  if (hasResidual && d.residualProbability * d.residualImpact > d.probability * d.impact) {
    errors.push('Залишкова оцінка вища за початкову — реакція не може погіршувати ризик.');
  }
  if (d.status === 'treated' && !hasResidual) {
    errors.push('Оброблений ризик потребує залишкової оцінки — інакше не видно, що дала реакція.');
  }

  const cost = parseAmount(d.costImpact);
  const pct = parseAmount(d.probabilityPct);
  if (Number.isNaN(cost)) errors.push('Вартість наслідку — не число.');
  else if (cost !== undefined && cost < 0) errors.push('Вартість наслідку не може бути відʼємною.');
  if (Number.isNaN(pct)) errors.push('Ймовірність у відсотках — не число.');
  else if (pct !== undefined && (pct < 0 || pct > 100)) {
    errors.push('Ймовірність у відсотках має бути в межах 0–100.');
  }
  if (!Number.isNaN(cost) && !Number.isNaN(pct) && (cost === undefined) !== (pct === undefined)) {
    errors.push('Для EMV потрібні обидва числа: вартість наслідку і ймовірність у відсотках.');
  }

  if ((d.status === 'closed' || d.status === 'materialized') && blank(d.closureNote)) {
    errors.push(
      d.status === 'closed'
        ? 'Закриття потребує причини — рядки не видаляють, їх закривають із поясненням.'
        : 'Ризик, що реалізувався, потребує плану усунення: це вже проблема, а не мітигація.',
    );
  }

  return errors;
}

// ── Draft -> wire ───────────────────────────────────────────────────────────────
// Both converters assume validateDraft() already passed, so a NaN amount cannot reach them.

// An insert OMITS what the user left empty: `exactOptionalPropertyTypes` makes an explicit
// `undefined` a different type from an absent key, and the column defaults are what should
// apply to a field nobody filled in.
export function draftToInsert(workspaceId: string, d: RiskDraft): WorkspaceRiskInsert {
  const cost = parseAmount(d.costImpact);
  const pct = parseAmount(d.probabilityPct);
  return {
    workspaceId,
    kind: d.kind,
    category: d.category,
    cause: d.cause,
    event: d.event,
    consequence: d.consequence,
    probability: d.probability,
    impact: d.impact,
    response: d.response,
    responseActions: d.responseActions,
    earlyWarning: d.earlyWarning,
    status: d.status,
    closureNote: d.closureNote,
    ...(cost !== undefined && !Number.isNaN(cost) ? { costImpact: cost } : {}),
    ...(pct !== undefined && !Number.isNaN(pct) ? { probabilityPct: pct } : {}),
    ...(d.proximity ? { proximity: d.proximity } : {}),
    ...(d.actionOwner ? { actionOwner: d.actionOwner } : {}),
    ...(d.actionDue ? { actionDue: d.actionDue } : {}),
    ...(d.riskOwner ? { riskOwner: d.riskOwner } : {}),
    ...(d.residualProbability > 0 ? { residualProbability: d.residualProbability } : {}),
    ...(d.residualImpact > 0 ? { residualImpact: d.residualImpact } : {}),
  };
}

// A patch is the whole form, so an emptied field means CLEAR IT — `null`, not an omitted
// key. The editor loads every field, so nothing it sends can be «unspecified»; omitting the
// cleared ones instead would make an unassigned action owner impossible to record.
export function draftToPatch(d: RiskDraft): WorkspaceRiskPatch {
  const cost = parseAmount(d.costImpact);
  const pct = parseAmount(d.probabilityPct);
  return {
    kind: d.kind,
    category: d.category,
    cause: d.cause,
    event: d.event,
    consequence: d.consequence,
    probability: d.probability,
    impact: d.impact,
    costImpact: cost === undefined || Number.isNaN(cost) ? null : cost,
    probabilityPct: pct === undefined || Number.isNaN(pct) ? null : pct,
    proximity: d.proximity || null,
    response: d.response,
    responseActions: d.responseActions,
    actionOwner: d.actionOwner || null,
    actionDue: d.actionDue || null,
    riskOwner: d.riskOwner || null,
    residualProbability: d.residualProbability > 0 ? d.residualProbability : null,
    residualImpact: d.residualImpact > 0 ? d.residualImpact : null,
    earlyWarning: d.earlyWarning,
    status: d.status,
    closureNote: d.closureNote,
  };
}
