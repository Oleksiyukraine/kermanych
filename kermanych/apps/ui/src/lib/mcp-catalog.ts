// The «MCP-сервери» catalog (docs/specs/2026-11-16-mcp-catalog.md): popular services the
// operator adds in one pick instead of copying a config from a README. Each entry is the
// definition the service documents for project-scoped clients, checked against its own docs on
// 2026-11-16. A hosted (URL) server is preferred over a local `npx` one where the vendor offers
// both: a local server is one more process per session (docs/claude-resource-limits.md).
//
// A local server names an exact package version, never `@latest`
// (docs/specs/2026-11-26-agentic-maturity-quick-wins.md): `npx -y` runs whatever the registry
// serves at launch, so an unpinned entry hands every new release — or a hijacked one — straight
// to the agent. A version moves only when someone bumps it here and the change is reviewed.
//
// A pick only fills the editor's form; the operator sees and can change everything before the
// save, which goes through the same `.mcp.json` + codex write as a hand-made server. Secrets are
// `${VAR}` placeholders in the definition, so every entry also reaches codex (the spec's test).
import type { McpServerDef } from '@kermanych/core';
import { mcpDraftFrom, type McpDraft } from './mcp';

export const MCP_CATALOG_GROUPS = ['browser', 'work', 'docs', 'design', 'backend', 'web'] as const;
export type McpCatalogGroup = (typeof MCP_CATALOG_GROUPS)[number];

/**
 * How the server signs in: nothing to set up, a key the form asks for (stored in `.env`), or
 * OAuth, which the operator completes inside the agent after the save (Kermanych does not do it).
 */
export type McpCatalogAuth = 'none' | 'key' | 'oauth';

export type McpCatalogEntry = {
  /** The i18n key of its description: `aiTeam.mcp.catalog.about.<id>`. */
  id: string;
  /** The server name written to the files. */
  name: string;
  /** The service as its vendor writes it; not translated. */
  title: string;
  group: McpCatalogGroup;
  auth: McpCatalogAuth;
  def: McpServerDef;
  /** The vendor's setup page. */
  docs: string;
  /** For `auth: 'key'`: where the key is issued, and what it looks like. */
  key?: { url: string; placeholder: string };
};

const http = (url: string, headers: Record<string, string> = {}): McpServerDef => ({ kind: 'http', url, headers });
const npx = (pkg: string, version: string, args: string[] = [], env: Record<string, string> = {}): McpServerDef => ({
  kind: 'stdio',
  command: 'npx',
  args: ['-y', `${pkg}@${version}`, ...args],
  env,
});

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: 'playwright',
    name: 'playwright',
    title: 'Playwright',
    group: 'browser',
    auth: 'none',
    def: npx('@playwright/mcp', '0.0.86'),
    docs: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    id: 'chromeDevtools',
    name: 'chrome-devtools',
    title: 'Chrome DevTools',
    group: 'browser',
    auth: 'none',
    def: npx('chrome-devtools-mcp', '1.14.0'),
    docs: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
  },
  {
    id: 'github',
    name: 'github',
    title: 'GitHub',
    group: 'work',
    auth: 'key',
    def: http('https://api.githubcopilot.com/mcp/', { Authorization: 'Bearer ${GITHUB_PAT}' }),
    docs: 'https://github.com/github/github-mcp-server',
    key: { url: 'https://github.com/settings/personal-access-tokens/new', placeholder: 'github_pat_…' },
  },
  {
    id: 'linear',
    name: 'linear',
    title: 'Linear',
    group: 'work',
    auth: 'oauth',
    def: http('https://mcp.linear.app/mcp'),
    docs: 'https://linear.app/docs/mcp',
  },
  {
    id: 'atlassian',
    name: 'atlassian',
    title: 'Atlassian',
    group: 'work',
    auth: 'oauth',
    def: http('https://mcp.atlassian.com/v2/mcp'),
    docs: 'https://support.atlassian.com/atlassian-ai-gateway/docs/use-atlassian-mcp-server',
  },
  {
    id: 'sentry',
    name: 'sentry',
    title: 'Sentry',
    group: 'work',
    auth: 'oauth',
    def: http('https://mcp.sentry.dev/mcp'),
    docs: 'https://mcp.sentry.dev',
  },
  {
    id: 'context7',
    name: 'context7',
    title: 'Context7',
    group: 'docs',
    auth: 'none',
    def: http('https://mcp.context7.com/mcp'),
    docs: 'https://context7.com/docs/resources/all-clients',
  },
  {
    id: 'notion',
    name: 'notion',
    title: 'Notion',
    group: 'docs',
    auth: 'oauth',
    def: http('https://mcp.notion.com/mcp'),
    docs: 'https://developers.notion.com/docs/get-started-with-mcp',
  },
  {
    id: 'figma',
    name: 'figma',
    title: 'Figma',
    group: 'design',
    auth: 'oauth',
    def: http('https://mcp.figma.com/mcp'),
    docs: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation',
  },
  {
    id: 'supabase',
    name: 'supabase',
    title: 'Supabase',
    group: 'backend',
    auth: 'oauth',
    def: http('https://mcp.supabase.com/mcp?read_only=true'),
    docs: 'https://supabase.com/docs/guides/ai-tools/mcp',
  },
  {
    id: 'neon',
    name: 'neon',
    title: 'Neon',
    group: 'backend',
    auth: 'oauth',
    def: http('https://mcp.neon.tech/mcp'),
    docs: 'https://github.com/neondatabase/mcp-server-neon',
  },
  {
    id: 'vercel',
    name: 'vercel',
    title: 'Vercel',
    group: 'backend',
    auth: 'oauth',
    def: http('https://mcp.vercel.com'),
    docs: 'https://vercel.com/docs/agent-resources/vercel-mcp',
  },
  {
    id: 'stripe',
    name: 'stripe',
    title: 'Stripe',
    group: 'backend',
    auth: 'oauth',
    def: http('https://mcp.stripe.com'),
    docs: 'https://docs.stripe.com/mcp',
  },
  {
    id: 'braveSearch',
    name: 'brave-search',
    title: 'Brave Search',
    group: 'web',
    auth: 'key',
    def: npx('@brave/brave-search-mcp-server', '2.2.0', ['--transport', 'stdio'], { BRAVE_API_KEY: '${BRAVE_API_KEY}' }),
    docs: 'https://github.com/brave/brave-search-mcp-server',
    key: { url: 'https://brave.com/search/api/', placeholder: 'BSA…' },
  },
  {
    id: 'firecrawl',
    name: 'firecrawl',
    title: 'Firecrawl',
    group: 'web',
    auth: 'none',
    def: http('https://mcp.firecrawl.dev/v2/mcp'),
    docs: 'https://docs.firecrawl.dev/mcp-server',
  },
];

/**
 * The editor's form for a catalog pick. The definition's placeholders read as secret rows; they
 * are new here, not stored, so the value field asks for the key instead of offering to keep one.
 */
export function mcpCatalogDraft(entry: McpCatalogEntry): McpDraft {
  const draft = mcpDraftFrom(entry.name, entry.def);
  for (const p of draft.pairs) {
    p.stored = false;
    if (p.secret && entry.key) p.placeholder = entry.key.placeholder;
  }
  return draft;
}

/** Entries matching a search over the title, the server name and the translated description. */
export function mcpCatalogSearch(query: string, about: (e: McpCatalogEntry) => string): McpCatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...MCP_CATALOG];
  return MCP_CATALOG.filter((e) => `${e.title} ${e.name} ${about(e)}`.toLowerCase().includes(q));
}
