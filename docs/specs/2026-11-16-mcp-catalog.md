# «MCP-сервери»: a catalog of popular servers

Builds on `docs/specs/2026-11-14-project-mcp-servers.md` (whose decision 8 left the catalog out
of the first version) and `docs/specs/2026-11-16-mcp-servers-ux-redesign.md`.

## Goal

Adding a well-known service (GitHub, Linear, Figma…) meant finding its README, copying the
command or URL and the header shape, and getting the secret's `${VAR}` right by hand. The
operator asked for the catalog agreed earlier: pick a service, review, save.

## Context

«Додати сервер» opened an empty form (`McpServerEditor.vue`). The form model
(`apps/ui/src/lib/mcp.ts`) already turns a definition with `${VAR}` placeholders into secret rows
(`mcpDraftFrom`) and back (`mcpDraftToSave`), and the api writes `.mcp.json` plus the codex
mirror.

## Decisions

1. **The catalog is static data in the UI** (`apps/ui/src/lib/mcp-catalog.ts`): id, server name,
   vendor title, group, auth kind, definition, docs link, and for a key-based service where to get
   the key and what it looks like. Descriptions are i18n strings (`aiTeam.mcp.catalog.about.*`).
   *Rejected:* fetching a registry (the official MCP registry, Smithery) at runtime — a network
   dependency and entries nobody checked; the catalog is small and reviewed with the code.
2. **A pick only fills the form.** The operator sees every field, can change any of them, and
   saves through the same write as a hand-made server. Nothing else is special about a catalog
   server afterwards.
3. **Hosted (URL) servers where the vendor offers one**, a local `npx` server only where it
   does not (Playwright, Chrome DevTools, Brave Search). Each local server is another process per
   session (`docs/claude-resource-limits.md`).
4. **Auth is said on the card and in the form:** «без ключа», «потрібен ключ» (the form asks
   for it, «Отримати ключ ↗» opens the vendor's page, the value goes to `.env`), or «вхід через
   OAuth» (the form says to sign in inside the agent after saving: `/mcp` in omp or claude,
   `codex mcp login <name>`). Kermanych still does no OAuth itself.
5. **Every entry reaches codex.** Secrets are `Authorization: Bearer ${VAR}` or an env
   `${VAR}` of the same name, which map to `bearer_token_env_var` / `env_vars`; no placeholder in
   a URL or argument. A unit test holds every entry to it.
6. **Safe defaults where the vendor has a switch:** Supabase is added with `?read_only=true`,
   and its description says how to lift it. Stripe's says to start with a sandbox.
7. **A name already in `.mcp.json` is shown as «вже додано»** and cannot be picked; the api
   would refuse the create anyway.
8. **«Власний сервер»** stays the first card, so the catalog never blocks a server it lacks.
9. **Entries (checked against each vendor's docs on 2026-11-16):**

   | Server | Definition | Auth |
   | --- | --- | --- |
   | `playwright` | `npx -y @playwright/mcp@latest` | none |
   | `chrome-devtools` | `npx -y chrome-devtools-mcp@latest` | none |
   | `github` | `https://api.githubcopilot.com/mcp/`, `Authorization: Bearer ${GITHUB_PAT}` | key |
   | `linear` | `https://mcp.linear.app/mcp` | OAuth |
   | `atlassian` | `https://mcp.atlassian.com/v2/mcp` | OAuth |
   | `sentry` | `https://mcp.sentry.dev/mcp` | OAuth |
   | `context7` | `https://mcp.context7.com/mcp` | none |
   | `notion` | `https://mcp.notion.com/mcp` | OAuth |
   | `figma` | `https://mcp.figma.com/mcp` | OAuth |
   | `supabase` | `https://mcp.supabase.com/mcp?read_only=true` | OAuth |
   | `neon` | `https://mcp.neon.tech/mcp` | OAuth |
   | `vercel` | `https://mcp.vercel.com` | OAuth |
   | `stripe` | `https://mcp.stripe.com` | OAuth |
   | `brave-search` | `npx -y @brave/brave-search-mcp-server --transport stdio`, env `BRAVE_API_KEY` | key |
   | `firecrawl` | `https://mcp.firecrawl.dev/v2/mcp` (keyless tier) | none |

   *Left out:* the archived reference servers (`@modelcontextprotocol/server-postgres`,
   `server-github`), which their own npm pages mark unsupported; Postgres is covered by Supabase and
   Neon until a maintained generic server is picked.

## Changes

- `apps/ui/src/lib/mcp-catalog.ts` (new): `MCP_CATALOG`, `mcpCatalogDraft`, `mcpCatalogSearch`.
- `apps/ui/src/lib/mcp.ts`: `McpPair.placeholder` (what a catalog key looks like).
- `apps/ui/src/components/settings/McpCatalog.vue` (new): search, «Власний сервер», groups of
  cards with the auth label.
- `McpServerEditor.vue`: a new server opens at the catalog step; a pick fills the form and shows a
  banner (what the service does, what to do about auth, «Отримати ключ ↗», «Документація ↗»);
  «← Каталог» goes back. Takes `existing` (names in `.mcp.json`). A secret row always shows its
  variable as one line now, also for a variable named differently from the default.
- `McpServersPanel.vue`: passes `existing`; the empty state gets «Відкрити каталог».
- i18n `aiTeam.mcp.catalog.*`, `aiTeam.mcp.openCatalog`, `aiTeam.mcp.emptyHint` (uk, en).
- README «MCP servers»: the catalog bullet.

## Verification

- `pnpm exec vitest run test/mcp.spec.ts` in `apps/ui`: 12 passed, including «every entry saves
  as it is listed and reaches codex too» and the GitHub key row (`placeholder`, `stored: false`,
  a pasted `Bearer …` stored without the scheme).
- `pnpm exec vue-tsc --noEmit` in `apps/ui`: clean.
- Live preview on a fixture repository with `playwright` in `.mcp.json`:
  - the catalog showed 15 entries in 6 groups, Playwright as «вже додано»; search «jira» left
    Atlassian only;
  - GitHub: the form came filled (URL, `Authorization` secret → `GITHUB_PAT`, placeholder
    `github_pat_…`, both links); a pasted `Bearer github_pat_TEST123` saved `.mcp.json`
    `Bearer ${GITHUB_PAT}`, `.env` `GITHUB_PAT=github_pat_TEST123`, and `[mcp_servers.github]`
    with `bearer_token_env_var = "GITHUB_PAT"`; the catalog then marked GitHub as added;
  - Linear: the OAuth banner with `codex mcp login linear`, no headers;
  - «← Каталог» returned to the catalog, «Власний сервер» opened a blank form;
  - the empty list shows «Відкрити каталог».

Not verified: that each vendor's server answers «Перевірити» (most need a real account or OAuth);
the English locale on screen (typechecked only).

## Documentation impact

README «MCP servers («ШІ-команда → MCP-сервери»)»: the catalog bullet.
`docs/specs/2026-11-14-project-mcp-servers.md` decision 8 points here.
