// apps/ui/src/stores/management-actions.ts
// The decisions the management action executor makes that are worth making without a store:
// which register row a model meant, which project it meant, and what to say when it asked
// for something the Менеджмент surface cannot do. Split out of ./management-chat.ts for the
// same reason ./transcript-update.ts is split out of the transcript store — the wiring needs
// a pinia instance and a network, these rules need neither, and they are the part that can
// be wrong.
import { managementSection } from '@kermanych/core';
import type { ManagementUnsupported } from '@kermanych/core';
import type { WorkspaceRisk } from '@kermanych/cloud';
import { globalTr } from '../boot/i18n';

// The register code as a person writes it. `R-003`, `R-3` and `r3` are one row to everyone
// except a string comparison, and the model writes all three — the code it saw in the
// context block, the code the operator typed at it, and the one it reconstructed from a
// sentence. Exact match first; then the sequence number, which is the only part that
// identifies a row inside its workspace (`R-` + lpad(3) is minted by workspace_risks_touch).
export function findRiskByCode(rows: readonly WorkspaceRisk[], code: string): WorkspaceRisk | undefined {
  const wanted = code.trim().toUpperCase();
  const exact = rows.find((r) => r.code.toUpperCase() === wanted);
  if (exact) return exact;
  const digits = wanted.replace(/\D/g, '');
  if (digits === '') return undefined;
  const n = Number(digits);
  return rows.find((r) => Number(r.code.replace(/\D/g, '')) === n);
}

// The project a `release.notes` action named, resolved to the row the executor can act on.
// The model is shown project NAMES and never ids (management-prompt.ts prints the repository
// list), for the reason it names a register code rather than a uuid: an id is something it
// has no honest way to know and every way to invent. So a name comes back and is matched
// here, against the list the browser already holds.
//
// Exact match first, then a UNIQUE containment either way — a model quoting «Kermanych UI»
// for a project called «Kermanych UI (web)» means that project. An AMBIGUOUS fragment stays
// a miss on purpose: generating a note against the wrong repository spends a model turn and
// produces a document about somebody else's work, which is strictly worse than a question.
export function findProjectByName<T extends { name: string }>(
  rows: readonly T[],
  name: string,
): T | undefined {
  const wanted = name.trim().toLowerCase();
  if (wanted === '') return undefined;
  const exact = rows.find((p) => p.name.trim().toLowerCase() === wanted);
  if (exact) return exact;
  const near = rows.filter((p) => {
    const n = p.name.trim().toLowerCase();
    return n.includes(wanted) || wanted.includes(n);
  });
  return near.length === 1 ? near[0] : undefined;
}

// Why a section could not be changed, in the user's language and NEVER in the model's. The
// reason is read from the section table in @kermanych/core, because a model that would
// rather be agreeable invents a plausible limitation and an invented reason is worse than
// no answer at all.
//
// Three cases, and the third is the one that matters most: a refusal aimed at a section the
// app CAN write is a malfunction of the prompt, not a property of the product, and it is
// reported as such instead of being dressed in a limitation the table does not have.
export function refusalText(action: ManagementUnsupported): string {
  const section = managementSection(action.section);
  if (section === undefined)
    return globalTr.t('management.refusal.unknownSection', { section: action.section });
  if (section.capability === 'read_write')
    return globalTr.t('management.refusal.writableRefused', { section: section.label });
  return globalTr.t('management.refusal.readOnly', {
    section: section.label,
    limitation: section.limitation
      ? globalTr.t(`management.section.${section.name}.limitation`)
      : globalTr.t('management.refusal.readOnlyFallback'),
  });
}
