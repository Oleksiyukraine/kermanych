# «ШІ-команда → MCP-сервери»: UX/UI redesign

Plan: `docs/plans/2026-11-16-mcp-servers-ux-redesign.md`. The feature itself:
`docs/specs/2026-11-14-project-mcp-servers.md` (its decisions 1–7 stay as they are).

## Goal

The section works, but the operator could not read it (screenshots of 2026-11-16 in the task):

- the section header and the panel's lead say the same thing twice, in jargon («harness»,
  «дублюються в .codex/config.toml»), and the repository path hangs below them unlabelled;
- the omp / claude / codex marks at the right of a row have no labels: a dimmed mark is the
  only sign that a harness does not see the server;
- a server found in a bound subfolder looks like a second copy of the root one (two
  `project-docs` cards), with a red sentence and «Перенести в корінь», which the api refuses
  when the root `.mcp.json` already has that name;
- a codex mirror that is missing or written differently is a grey sentence with no action:
  the operator has to open the editor and save without changes to fix it;
- every row ends in three large buttons; «Додати сервер» sits under the list;
- in the editor, «Тип» is two big buttons, labels are of three different styles, «Команда» and
  «Аргументи» touch, and a secret row grows a second, unlabelled line «→ .env [ ]».

## Context

`apps/ui/src/components/settings/McpServersPanel.vue` (the list), `McpServerEditor.vue` (the
modal), `McpCodexConflict.vue` (both codex tables), `apps/ui/src/lib/mcp.ts` (the form model).
The api (`apps/api/src/mcp/mcp.service.ts`) already answers everything the list needs; the one
gap is that a server in a bound subfolder cannot be deleted from there.

## Decisions

1. **One header, one toolbar.** The section blurb is one plain sentence. The panel opens with a
   toolbar: «Репозиторій <path>» on the left, «Додати сервер» on the right. The note that running
   sessions get changes after a restart moves into the toolbar's second line. «не закомічено»
   and file parse errors are callouts under it.
2. **Two groups.** «Підключені» (root files, what sessions see) and «Не підключені» (a bound
   subfolder). The reason the second group is not connected is said once, in its header, not
   on every card. Each group shows its count.
3. **A card reads top to bottom:** name, kind, and the row's actions on one line («Перевірити»,
   «Змінити», «Видалити» as compact buttons); the command or URL in a code box that wraps
   instead of truncating; «Агенти» as three labelled chips (mark + name), a harness that does
   not see the server dimmed with a tooltip that says why; «Файли» as a plain list; «Змінні»
   with a status per variable.
4. **Every problem is a notice with its fix next to it.**
   - codex missing → «codex ще не отримав цей сервер» + «Додати в codex» (a save of the same
     definition, `PUT …/:name`, which writes the codex table);
   - codex differs → «У .codex/config.toml його описано інакше» + «Порівняти» (the same save;
     the api answers with both tables and the existing conflict modal asks to replace);
   - codex gap → the existing reason, as an info notice without an action;
   - root server outside `.mcp.json` → «Його бачить лише omp» + «Скопіювати в .mcp.json»;
   - subfolder server whose name is also in the root `.mcp.json` → «Дублікат: у корені вже є
     «name», ця копія ні на що не впливає» + «Видалити копію»; otherwise «Перенести в корінь»;
   - an unset required variable → the variable's status in red with «Задати».
   *Rejected:* a status dot per card. It says «something is wrong» without saying what; the
   notices already say it.
5. **Deleting a subfolder copy is new in the api:** `DELETE /api/projects/:id/mcp/:name?location=subdir`
   removes the server from every MCP file of the bound subfolder (the same removal
   «Перенести в корінь» does after its copy). Without it, the duplicate's only action was one the
   api refuses.
6. **Inline «Задати»** gets «Скасувати» and Escape; the input is focused when it opens.
7. **«Перевірити»** result: one status line (✓ works · N tools · ms, or ✗ the error), the tool
   list and stderr folded under `<details>`, so a 40-tool server does not push the next card off
   screen.
8. **Editor.**
   - «Тип» is the kit's segmented `KToggle`.
   - One label style (KField's) for every field; hints under fields in the faint small style.
   - «Назва» has a hint: allowed characters, and that the name cannot change later.
   - A local command shows «Запуск: <command line>» under the arguments, built from the form, so
     the one-argument-per-line rule is visible.
   - Variables / headers are a table with column headers «Назва», «Значення», «Секрет». A secret
     row says where the value goes on one line — «у .env як KEY» — and «змінити» turns that into
     the variable-name input. An empty table says so and offers «Додати змінну» / «Додати
     заголовок».
   - The secret hint is one sentence.
   - *Rejected:* a catalog of presets (Playwright, Linear…). Out of scope; decision 8 of the
     feature spec keeps it out.

## Changes

- **api** — `McpService.remove(projectId, name, location)`: `subdir` removes the server from
  the subfolder's files; `McpController` `DELETE :name` takes `?location=`. Test in
  `apps/api/test/mcp.spec.ts`.
- **ui** — `McpServersPanel.vue` rewritten as above; `McpServerEditor.vue` re-laid out;
  `lib/api.ts` `mcpRemove(id, name, location)`; i18n `aiTeam.mcp.*` (uk, en) and the section
  blurb `aiTeam.sections.mcp.blurb`.
- **README** «MCP servers» — the list and editing bullets describe the groups, the notices and
  their actions, and the new route.

## Verification

- `pnpm exec vitest run test/mcp.spec.ts` in `apps/api`: 13 passed, including the new «a
  subfolder copy is deleted from the subfolder only, the root server stays».
- `pnpm exec vue-tsc --noEmit` in `apps/ui`: clean (the en strings are checked against uk).
- Live preview, «Acme Web» bound to `/tmp/mcp-fixture/app` (a git repo with root `.mcp.json`,
  `.codex/config.toml`, `.cursor/mcp.json` and `app/.mcp.json`), dark and light theme:
  - groups «Підключені 5» / «Не підключені 2» with the subfolder note once; chips struck for the
    harnesses that do not see a server;
  - «Додати в codex» on `linear` wrote `[mcp_servers.linear]` with `bearer_token_env_var`, and
    the notice went away;
  - «Порівняти» on `playwright` opened both tables; «Замінити й зберегти» replaced the table;
  - «Видалити копію» on the subfolder `project-docs` (confirm) left `app/.mcp.json` with `figma`
    only and the root server in place;
  - «Перевірити» on a local stdio fixture server: «✓ Працює: 3 інструменти (26 мс)», the list
    folded under «Інструменти»; on an unreachable URL: «✕ Не запускається» and `fetch failed`;
  - «Задати» opens a focused field with «Зберегти в .env» and «Скасувати»;
  - the editor: new local command with a `${DATABASE_URL}` argument shows «Запуск …» and the
    codex gap notice, a secret row shows «значення піде в .env як PGPASSWORD · змінити»; saved
    into `.mcp.json` with `PGPASSWORD: ${PGPASSWORD}`; editing `linear` opens the stored header
    with its own variable name `LINEAR_API_KEY` in the input.

Not verified: the English locale on screen (only typechecked); a check that fails with stderr
lines (the fold is the same markup as the tool list); the inline «Задати» save itself (the
route and the call are unchanged).

## Documentation impact

README «MCP servers («ШІ-команда → MCP-сервери»)»: groups, notices and their actions, the form's
«Запуск» line and secret target, the folded «Перевірити» result, and the
`DELETE …/:name?location=subdir` route.
