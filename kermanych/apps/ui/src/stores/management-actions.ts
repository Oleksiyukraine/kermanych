// apps/ui/src/stores/management-actions.ts
// The two decisions the management action executor makes that are worth making without a
// store: which register row a model meant, and what to say when it asked for something the
// Менеджмент surface cannot do. Split out of ./management-chat.ts for the same reason
// ./transcript-update.ts is split out of the transcript store — the wiring needs a pinia
// instance and a network, these rules need neither, and they are the part that can be wrong.
import { managementSection } from '@kermanych/core';
import type { ManagementUnsupported } from '@kermanych/core';
import type { ProjectRisk } from '@kermanych/cloud';

// The register code as a person writes it. `R-003`, `R-3` and `r3` are one row to everyone
// except a string comparison, and the model writes all three — the code it saw in the
// context block, the code the operator typed at it, and the one it reconstructed from a
// sentence. Exact match first; then the sequence number, which is the only part that
// identifies a row inside its project (`R-` + lpad(3) is minted by project_risks_touch).
export function findRiskByCode(rows: readonly ProjectRisk[], code: string): ProjectRisk | undefined {
  const wanted = code.trim().toUpperCase();
  const exact = rows.find((r) => r.code.toUpperCase() === wanted);
  if (exact) return exact;
  const digits = wanted.replace(/\D/g, '');
  if (digits === '') return undefined;
  const n = Number(digits);
  return rows.find((r) => Number(r.code.replace(/\D/g, '')) === n);
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
    return `Асистент назвав розділ «${action.section}», якого не існує в Менеджменті.`;
  if (section.capability === 'read_write')
    return `Асистент відмовився змінити розділ «${section.label}», хоча цей розділ доступний для запису — спробуйте перепитати.`;
  return `Не можу змінити розділ «${section.label}»: ${section.limitation ?? 'розділ доступний лише для читання'}`;
}
