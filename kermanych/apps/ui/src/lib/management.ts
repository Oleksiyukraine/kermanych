// apps/ui/src/lib/management.ts
// The sections of the Менеджмент tab, in rail order. One table drives three
// things: the child route records (router/routes.ts), the rows of the section
// rail and the heading each section renders (ManagementPage). Adding a section is
// one row here; promoting one from placeholder to a real screen is a `component`
// swap in its generated route record.
//
// Every section is PROJECT-SCOPED: ManagementPage renders none of them until a
// project is selected in the sidebar, and hands the matched section that project's
// id and name as props.
export interface ManagementSection {
  // Route name — also the value the section rail switches on.
  name: string;
  // URL segment under /management.
  path: string;
  label: string;
  // Second line of the rail row: what the section holds, in the fewest words that
  // distinguish it from its neighbours. The rail is the only place it renders —
  // the section's own screen says the rest.
  hint: string;
}

export const MANAGEMENT_SECTIONS: readonly ManagementSection[] = [
  { name: 'management-home', path: 'home', label: 'Home', hint: 'огляд проєкту' },
  { name: 'management-storage', path: 'storage', label: 'Storage', hint: 'файли й артефакти' },
  { name: 'management-skills', path: 'skills', label: 'Skills', hint: 'бібліотека скілів' },
  { name: 'management-risks', path: 'risk-registry', label: 'Risk Registry', hint: 'ризики й мітигації' },
  { name: 'management-releases', path: 'release-notes', label: 'Release Notes', hint: 'зміни по релізах' },
  { name: 'management-capacity', path: 'team-capacity', label: 'Team Capacity', hint: 'навантаження команди' },
  { name: 'management-integrations', path: 'integrations', label: 'Integrations', hint: 'Linear, Jira, Slack' },
];

// The section /management itself lands on.
export const MANAGEMENT_DEFAULT_SECTION = 'management-home';
