// packages/core/src/management.ts
// The Менеджмент surface, as one table, shared by three consumers that must never
// disagree about it:
//
//   1. the ui router + sub-nav  — `path`, `name`, `label` (apps/ui/src/router/routes.ts,
//      pages/ManagementPage.vue);
//   2. the management assistant — `capability` and `limitation`, quoted into the prompt so
//      the model knows what it may touch (apps/api/src/management/*);
//   3. the action executor      — the same two fields again, to REFUSE an action aimed at a
//      section that cannot take one (apps/ui/src/stores/management-chat.ts).
//
// It lives in core rather than in the ui because (2) runs in the api. Two tables would
// drift, and the drift would show up as the assistant confidently editing a screen that
// does not exist.
//
// Every section is WORKSPACE-SCOPED: ManagementPage renders none of them until a workspace
// is selected in the sidebar (selecting a project selects its workspace too), and hands the
// matched section that workspace's id and name as props. The level sits there because the
// subject does: the risk register, the membership that decides who may touch it and the
// repositories the assistant reads all belong to the group, so a per-project management tab
// could only ever show a slice of its own subject.

// What the assistant may do with a section.
//   read_write — it has a store and a table; the assistant may read it and change it.
//   read       — a screen exists but nothing persists, so the assistant may describe it only.
//   none       — a placeholder; there is nothing to read and nothing to write.
export type ManagementCapability = "read_write" | "read" | "none";

export interface ManagementSection {
  // Route name — also the value the section rail switches on, and the key the assistant
  // names a section by.
  name: string;
  // URL segment under /management.
  path: string;
  label: string;
  // Second line of the rail row: what the section holds, in the fewest words that
  // distinguish it from its neighbours. The rail is the only place it renders — the
  // section's own screen says the rest.
  hint: string;
  capability: ManagementCapability;
  // WHY the assistant cannot change this section, in the user's language. Present exactly
  // when `capability !== "read_write"`, and it is this string — never a sentence the model
  // invented — that the chat shows when it refuses. Requirement: a refusal must state a
  // reason the product can stand behind.
  limitation?: string;
}

const NOT_BUILT = "розділ ще не реалізований — за ним немає ні екрана, ні сховища даних";

export const MANAGEMENT_SECTIONS: readonly ManagementSection[] = [
  { name: "management-home", path: "home", label: "Home", hint: "огляд воркспейсу", capability: "none", limitation: NOT_BUILT },
  { name: "management-storage", path: "storage", label: "Storage", hint: "файли й артефакти", capability: "none", limitation: NOT_BUILT },
  // The one section the assistant can WRITE, because it is the one section with a real store
  // behind it: `workspace_risks` (threat vs opportunity, cause·event·consequence, 1-5
  // probability × impact, PMI response strategies, an append-only event log). Three pieces
  // make that true and all three must stay true for this row to say `read_write`:
  //   * ./management-actions carries `risk.create` / `risk.update` in THAT schema's
  //     vocabulary (note: it has no `client` or `financial` category — an unpaid invoice is
  //     `external`);
  //   * apps/api/src/management/management-prompt.ts prints that vocabulary and the current
  //     register into the prompt;
  //   * apps/ui/src/stores/management-chat.ts executes both kinds through
  //     `useRisks().create(workspaceId, …)`, in the browser, under the operator's own JWT —
  //     so RLS decides what a member may file.
  {
    name: "management-risks",
    path: "risk-registry",
    label: "Risk Registry",
    hint: "ризики й мітигації",
    capability: "read_write",
  },
  { name: "management-releases", path: "release-notes", label: "Release Notes", hint: "зміни по релізах", capability: "none", limitation: NOT_BUILT },
  { name: "management-capacity", path: "team-capacity", label: "Team Capacity", hint: "навантаження команди", capability: "none", limitation: NOT_BUILT },
  {
    name: "management-integrations",
    path: "integrations",
    label: "Integrations",
    hint: "Linear, Jira, Slack",
    capability: "read",
    limitation:
      "розділ лише показує список провайдерів (Linear, Jira, Slack) — жодне підключення не зроблено і стан ніде не зберігається",
  },
];

// The section /management itself lands on.
export const MANAGEMENT_DEFAULT_SECTION = "management-home";

// Resolve a section by route name OR by url segment: the model is told the route names, but
// it sees `/management/risk-registry` in the conversation too, and a refusal that fails to
// resolve its own section would print no reason at all.
export function managementSection(key: string): ManagementSection | undefined {
  const k = key.trim().toLowerCase();
  return MANAGEMENT_SECTIONS.find((s) => s.name === k || s.path === k || s.label.toLowerCase() === k);
}
