// apps/ui/src/lib/management.ts
// The sections of the Менеджмент tab, in sub-nav order. One table drives three
// things: the child route records (router/routes.ts), the sub-nav tabs and the
// heading each section renders (ManagementPage / ManagementSectionPage). Adding a
// section is one row here; promoting one from placeholder to a real screen is a
// `component` swap in its generated route record.
//
// Every section is PROJECT-SCOPED: ManagementPage renders none of them until a
// project is selected in the sidebar, and hands the matched section that project's
// id and name as props.
export interface ManagementSection {
  // Route name — also the KTabs value the sub-nav switches on.
  name: string;
  // URL segment under /management.
  path: string;
  label: string;
}

export const MANAGEMENT_SECTIONS: readonly ManagementSection[] = [
  { name: 'management-home', path: 'home', label: 'Home' },
  { name: 'management-storage', path: 'storage', label: 'Storage' },
  { name: 'management-skills', path: 'skills', label: 'Skills' },
  { name: 'management-risks', path: 'risk-registry', label: 'Risk Registry' },
  { name: 'management-releases', path: 'release-notes', label: 'Release Notes' },
  { name: 'management-capacity', path: 'team-capacity', label: 'Team Capacity' },
  { name: 'management-integrations', path: 'integrations', label: 'Integrations' },
];

// The section /management itself lands on.
export const MANAGEMENT_DEFAULT_SECTION = 'management-home';
