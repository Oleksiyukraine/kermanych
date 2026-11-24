# Folded «Tool commands» notices in the chat

## Goal

omp 19.1 (2026-11-21) announces MCP and extension tools that it mounts or unmounts as bash
commands with one English line, for example
`Tool commands: added mcp__supabase_v1_execute_sql, mcp__supabase_v1_get_advisors, …`. Kermanych
showed that line verbatim in the session log. With a few MCP servers, a dozen full tool names
pushed the conversation out of view. The operator wants to keep the notice but make it compact.

## Context

- omp emits the notice through `emitNotice("info", "Tool commands: …")`. The `tools.commandNotices`
  setting (default `true`) turns it off.
- `apps/api/src/supervisor/transcript-reducer.ts` turns every omp `notice` frame into a transcript
  `notice` entry with omp's text.
- `apps/ui/src/components/kit/KLogBlock.vue` showed a notice as one muted monospace line.

## Decisions

- **Parsed on the server, coded like every other notice.** The reducer recognises the exact
  `Tool commands: added …; removed …` shape. It turns each half into a `notice` with code
  `tool_commands_added` or `tool_commands_removed` and params `{ names, count }`, where `names`
  is a comma-joined string, as in the other `*_names` notices. A line in any other shape stays a
  plain notice with omp's text, so a wording change in omp does not hide the line.
  Rejected: parsing the text in the UI. That would put omp's English prose into a second
  consumer and skip the `code`+`params` localisation contract.
- **One entry per direction.** A line that both adds and removes tools gives two rows, each with
  its own id from the reducer's stamp.
- **The label is the names' shared prefix, not a server name.** omp names MCP tools
  `mcp__<server>_<tool>`, and either part may contain `_`, so the server cannot be split off
  reliably. The UI strips `mcp__`, then uses the longest prefix the names share, cut at a `_`, as
  the tag. It shows the rest of each name in the list. The label plus `_` plus an item is
  always the real name.
- **Folded by default and covered by «деталі: розгорнути все».** This uses the same disclosure
  as the reasoning chip, but upright, because the row is a system row, not the model's voice.
  A single command has nothing to fold, so its name goes into the tag and there is no toggle.

## Changes

- `packages/core/src/i18n-codes.ts`: adds the `tool_commands_added` and `tool_commands_removed`
  notice codes.
- `apps/api/src/supervisor/transcript-reducer.ts`: adds `toolCommandNotices(text)`. The `notice`
  branch emits one entry for each parsed half.
- `apps/ui/src/lib/tool-commands.ts`: adds `toolCommandGroup(names)`, which returns the shared
  prefix and the remaining items.
- `apps/ui/src/components/kit/KLogBlock.vue`: shows a coded tool-commands notice as
  `▸ підключено 14 команд [supabase_v1]`. Expanding it shows the names as small mono chips.
- `apps/ui/src/i18n/{uk,en}`: adds `kit.logBlock.commandsAdded`/`commandsRemoved` (the summary)
  and `notices.tool_commands_*` (the full sentence for any other surface that shows notices).
- `apps/ui/src/pages/KitGalleryPage.vue`: adds both forms (folded group, single command) to the
  log samples.

## Verification

- `apps/api`: `vitest run test/supervisor.transcript.spec.ts` passed 12 tests. The new cases are
  a combined `added …; removed …` line split into two coded entries with distinct ids, and an
  unknown shape kept as a plain notice.
- `apps/ui`: `vitest run test/tool-commands.spec.ts test/i18n-completeness.spec.ts
  test/i18n-plural.spec.ts` passed 37 tests. `packages/core`: `vitest run test/i18n-codes.spec.ts`
  passed 5 tests.
- `vue-tsc --noEmit` reported no errors in `src/`. Its only errors are about `@kermanych/api`
  not being built in `src-electron`, which is unrelated.
- Visual check in the kit gallery (`/#/kit`, quasar dev): the folded row read
  `▸ підключено 3 команди [nestjs_docs]`. Expanded, it listed
  `get_nestjs_manual get_project_spec search_nestjs_api` as chips. The single form read
  `відключено 1 команду [context7_query_docs]`.

Not verified: a live omp session that mounts an MCP server mid-session. The reducer test uses
the line copied from the omp 19.1.1 binary.

## Documentation impact

None. This is a presentation change to one log row. No command, endpoint, config key or flow
changed.
