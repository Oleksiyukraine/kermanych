# «Tool commands» notices in the chat: one row of server pills

## Goal

omp 19.1 (2026-11-21) announces MCP and extension tools that it mounts or unmounts as bash
commands with one English line, for example
`Tool commands: added mcp__supabase_v1_execute_sql, mcp__supabase_v1_get_advisors, …`. Kermanych
showed that line verbatim in the session log. With a few MCP servers, a dozen full tool names
pushed the conversation out of view. The operator wants to keep the notice but make it compact.
omp announces each MCP server as it connects, so a session with several servers opens with one
such line per server.

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
- **A burst is one row.** `buildChatBlocks` coalesces consecutive tool-commands notices into a
  `commands` chat item, as it already coalesces runs of `read`/`grep`/`glob`. Anything between
  two notices starts a new row.
- **One pill per server.** omp names MCP tools `mcp__<server>_<tool>`, and either part may contain
  `_`, so the server cannot be split off one name. One notice is one server's batch, so the
  longest prefix its names share, cut at a `_`, is the server. A lone tool is filed under a
  server another notice in the row already named, when it starts with `<server>_`. Otherwise its
  whole name is the pill, with no list. When a server is mounted and then unmounted in the same
  row, its pill shows the final state.
- **Look: «Плашки».** The operator chose this from four variants built side by side in the kit
  gallery: pills, a divider rule across the log, a bordered card, and a terminal-style `MCP` tag.
  The row is a green plug mark, an `MCP` label, and then one pill per server with a green dot,
  the name and the tool count. An unmounted server is a dashed pill with a grey dot and a
  struck-through name. Rejected: the first version of this change, a muted
  `▸ підключено 14 команд [supabase_v1]` line for each notice. The operator found it barely
  different from the raw line, because it was still one line per server and nothing set it
  apart from the conversation.
- **Folded by default.** A click on a pill opens that server's tools as mono chips under the row.
  «деталі: розгорнути все» opens every pill, and «стиснути все» closes them all.

## Changes

- `packages/core/src/i18n-codes.ts`: adds the `tool_commands_added` and `tool_commands_removed`
  notice codes.
- `apps/api/src/supervisor/transcript-reducer.ts`: adds `toolCommandNotices(text)`. The `notice`
  branch emits one entry for each parsed half.
- `packages/core/src/chat-blocks.ts`: adds the `ChatItem` `{ kind: "commands"; notices }`, which
  coalesces a run of tool-commands notices. Exports `NoticeEntry`.
- `apps/ui/src/lib/tool-commands.ts`: `toolCommandGroup(names)` returns a batch's shared prefix
  and items, and `toolCommandServers(notices)` returns one `{ server, tools, state }` per server.
- `apps/ui/src/components/kit/KToolCommandsRow.vue`: new component for the pill row and its
  tool lists.
- `apps/ui/src/components/kit/KRequestBlock.vue`: renders a `commands` item through
  `KToolCommandsRow`. `KLogBlock.vue` does the same for a single entry, as on the agent map.
- `apps/ui/src/i18n/{uk,en}`: adds `kit.toolCommands.*` (the pill tooltip) and
  `notices.tool_commands_*` (the full sentence for any other surface that shows notices).
- `apps/ui/src/pages/KitGalleryPage.vue`: the log-blocks section shows the row with two mounted
  servers and one unmounted.

## Verification

- `apps/api`: `vitest run test/supervisor.transcript.spec.ts` passed 12 tests. The new cases are
  a combined `added …; removed …` line split into two coded entries with distinct ids, and an
  unknown shape kept as a plain notice.
- `apps/ui`: `vitest run test/tool-commands.spec.ts test/i18n-completeness.spec.ts` passed 16
  tests. They check the server grouping (batches in arrival order, a lone tool filed under its
  server, mount then unmount ending as removed). `packages/core`: `vitest run
  test/chat-blocks.spec.ts test/i18n-codes.spec.ts` passed. The new chat-blocks case checks that
  a burst becomes one `commands` item and that another notice splits it.
- `vue-tsc --noEmit` reported no errors in `src/`. Its only errors are about `@kermanych/api`
  not being built in `src-electron`, which is unrelated.
- Visual check in the kit gallery (`/#/kit`, quasar dev), dark and light themes:
  `⏚ MCP (● nestjs_docs 5) (● supabase_v1 16) (◌ c̶o̶n̶t̶e̶x̶t̶7̶_̶q̶u̶e̶r̶y̶_̶d̶o̶c̶s̶)`. A click on
  `nestjs_docs` gave it a green outline and listed its five tools as chips under the row.

Not verified: a live omp session that mounts an MCP server mid-session. The reducer test uses
the line copied from the omp 19.1.1 binary.

## Documentation impact

None. This is a presentation change to one log row. No command, endpoint, config key or flow
changed.
