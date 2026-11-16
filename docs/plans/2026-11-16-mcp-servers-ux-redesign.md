# Plan: «MCP-сервери» UX/UI redesign

Spec: `docs/specs/2026-11-16-mcp-servers-ux-redesign.md`. Status: steps 1–6 landed on 2026-11-16;
the results are in the spec's Verification.

1. **api: delete a subfolder copy.** `apps/api/src/mcp/mcp.service.ts` (`remove` takes a
   location), `apps/api/src/http/mcp.controller.ts` (`?location=`), test in
   `apps/api/test/mcp.spec.ts`. Verify: `pnpm --filter @kermanych/api exec vitest run test/mcp.spec.ts`.
2. **ui client.** `apps/ui/src/lib/api.ts` `mcpRemove(id, name, location)`.
3. **Strings.** `apps/ui/src/i18n/uk/index.ts`, `apps/ui/src/i18n/en/index.ts` (`aiTeam.mcp.*`,
   `aiTeam.sections.mcp.blurb`). Verify: `vue-tsc` through the ui typecheck (the en schema).
4. **List.** `apps/ui/src/components/settings/McpServersPanel.vue`. Verify: the live preview
   against a fixture repo with a root server, a codex mismatch, a missing codex table, an unset
   variable, a server only in `.cursor/mcp.json`, and a bound subfolder holding a duplicate and a
   unique server.
5. **Editor.** `apps/ui/src/components/settings/McpServerEditor.vue`. Verify: the preview, new
   and edit, local command and URL, a secret header with a renamed variable.
6. **Docs.** README «MCP servers»; the spec's Verification.

Risks: none of the data shapes change; the api route gains an optional query parameter, so an
older UI keeps working.
