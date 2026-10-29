# «Дизайн» tab: design sessions that land in `docs/design/`

## Goal

Designs today are self-contained HTML files (`design/*.html`, 230–490 KB each) kept beside the
code. They drift from the code, cannot be edited by a colleague through an agent, and are too
large for an agent to read. The operator wants to make designs inside Kermanych: a «Дизайн» tab
right after «Чат» opens a page where a «Дизайнер» agent builds the screen while the operator
watches and points at it. When the design is done, Kermanych puts it in a fixed folder of the
project's repository, where developers and the agents that implement it can find it.

A design is a **prototype built on the project's real UI kit with fixtures**, not a separate
drawing. The prototype is code, so it cannot drift from the code. The saved folder carries the
text and the screenshots that people and agents read.

Rejected:
- **Dated HTML mockups.** They still drift.
- **A JSON spec on a component catalog with an inspector.** This is the real "mini-Figma", but
  it needs a catalog, a renderer route and a CI check in every target project. It stays
  possible as a later stage: the folder, the session and the flow below stay the same.
- **A vector canvas.** Free x/y positions and arbitrary colours do not map to flex/grid code,
  so the design would become a second artifact again.

## Context

- **Top nav.** The `VIEWS` table in `apps/ui/src/layouts/MainLayout.vue:975-994`, plus route
  records in `apps/ui/src/router/routes.ts`. The labels are `common.nav.view*` in
  `i18n/{uk,en}/index.ts`.
- **Session kinds.** `Session.kind` (`packages/core/src/types.ts:103`) is
  `agent | discussion | task | review | chat`. Variants of an agent session are stamped booleans:
  `deepAnalysis` (`:68`) and `minion` (`:73`).
  - Commit, PR, docs and finish require `kind === "agent"` (`supervisor.service.ts:2496, 2569,
    2979`).
  - AgentsPage lists every kind except `chat` (`AgentsPage.vue:1509`); ChatPage lists only
    `chat` (`ChatPage.vue:368-372`).
- **Chats are read-only.** They run in the operator's checkout without a worktree
  (`createChat`, `supervisor.service.ts:1172`), and get the tools `read, grep, glob` only
  (`chat-tools.ts`). A design must write files, so it cannot be a chat.
- **Launch.** `createSessionFromTask` → `launchTask` → `resolveLaunchParams` → `launch` →
  `spawnLaunched` (`supervisor.service.ts:1020-1155, 1318-1500`).
  - The branch is `branchName(slug, prefix)`, where `BRANCH_PREFIXES` is
    `feature | fix | refactoring | chore` (`packages/core/src/worktree-names.ts:36`). An
    unknown prefix falls back to `feature` (`supervisor.service.ts:1097-1099`).
  - A role's instruction wraps the first prompt in `openingPrompt` (`:1557-1575`), as the
    minion does via `agentPrompt(projectId, MINION_AGENT_ID, …)` and `renderInstruction`.
- **Roles.** The `AGENTS` array in `packages/core/src/agents.ts:234-243`, edited in «ШІ-команда →
  Агенти» (`components/settings/AiAgentsPanel.vue`). The cloud validates only the id format.
- **Default skills.** `DEFAULT_SKILLS` in `packages/core/src/skills.ts:131`. Adding one is a
  content change.
- **Preview.** `PreviewService.start(sessionId)` runs `project.previewCommand` from the worktree
  and returns `{url}`, or `{needsCommand: true}` when no command is set
  (`apps/api/src/preview/preview.service.ts:29-79`).
- **Browser.**
  - `KBrowserPane` (`components/kit/KBrowserPane.vue`) depends only on stores. It carries the
    viewport chip, «◎ Вказати» and the picks tray, which emits `send`.
  - Sending picks lives in AgentsPage (`onSendPicks`, `:3243-3264`).
  - The agent's `browser_screenshot` returns base64 to the model only
    (`browser-mcp.service.ts:497-502`). It cannot put a PNG into the repository.
- **Docs policy.**
  - `packages/core/src/doc-policy.ts`: `DOCS_LAYOUT`, `DocsPolicy`, `DOCS_RULES`,
    `DEFAULT_DOCS_POLICY`, `docsGateFailures`, `policyLine`.
  - The rules UI is `SettingsPage.vue:96-142, 1005-1033, 1454-1460`. The policy is stored in
    cloud `projects.docs_policy` (jsonb) and in SQLite.
  - Under the default policy (spec required), a design branch would fail `task-spec`.
- **«Задача →».** Inline in AgentsPage (`:737-743, 1220-1254, 3610-3716`), offered only for
  `handoff` / `api-request` paths and only for other projects of the workspace.
  `board.createTask(input, images)` can already attach images (`stores/board.ts:226-259`).
- **Images in docs.** PNGs are never listed, tagged or indexed (`isDocPath`, `docs.ts:19-33`).
  The «Проєктна документація» preview does render a README's relative `<img>`
  (`lib/markdown.ts`).

## Decisions

### The page

- **Placement.** «Дизайн» is a new `VIEWS` row between `chat` and `management`, with route
  `design` → `pages/DesignPage.vue`.
- **Layout.** Three columns. Each uses the existing component, so the page does not invent a
  new look.
  - Left: a rail, as in ChatPage. It lists the selected project's design sessions and has
    «+ Новий дизайн».
  - Centre: the canvas, `KBrowserPane` for the selected design. It covers the viewport presets
    390 / 768 / 1280 / 1440, «◎ Вказати» and the picks tray.
  - Right: the Дизайнер's log and composer, the same components as the Лог tab.
  - Toolbar: «Зберегти дизайн», «Створити ПР», «Завершити», and «Задача →» on a saved design.
- **«+ Новий дизайн».** A modal asks for a topic, an optional description (what the screen is
  for, links, constraints) and an optional base branch.
  - Creating is a short operation: the modal stays open and `persistent`, with `:loading` on
    the primary button, and errors show inside it (README → Async states).
  - The preview then starts by itself. That is a long operation: progress shows on the canvas,
    not in the modal.
  - With no `previewCommand`, the canvas says so and links to the project's settings, instead
    of showing an empty page.
- **One page for one view of a design.** Design sessions are hidden from «Агенти», as chats are.
  - They appear on «Карта агентів» with a design mark, because they are running agents.
  - On the board their card carries the same mark.
- **Web build.** The page lists designs and opens their saved folder, but has no canvas. It
  says that the canvas needs the desktop app, because the web build has no session browser.

### The session

- **A design is `kind: "agent"` with a stamped `designDir`.** `designDir` is the path of its
  folder, for example `docs/design/2026-10-29-orders-list`.
  - Its presence marks a design session, following the `deepAnalysis` / `minion` pattern.
    Worktree, preview, browser MCP, commit, PR, finish, resume and reports all work unchanged.
  - Rejected: a new `kind`. Every agent-only path would need a second branch for it.
- **A design has a card.** «+ Новий дизайн» creates a cloud task assigned to its author, as
  «Нова задача» on «Агенти» does, and launches it through `createSessionFromTask`.
  - The workspace sees design work on the board, and reports flow back to the card.
  - The task gets a boolean `design` column (one migration, like
    `20261008100000_task_deep_analysis.sql`). The launch stamps `designDir` from the launch
    date and the branch slug. A resumed session keeps it.
  - Rejected: a local-only session like a chat. Nobody else would see it, and the launch path
    would be duplicated.
- **The branch is `design/<slug>`.** `design` joins `BRANCH_PREFIXES`.
  - The Менеджмент ticket validator and prompt use the same list, so they accept `design` too.
    That is intended: a ticket may ask for a design.
- **The role is «Дизайнер»** (`designer`, kind `session`), a new `AGENTS` entry with an
  instruction that is editable in «ШІ-команда → Агенти». Its holes are `{topic}`,
  `{designDir}` and `{description}`. `openingPrompt` wraps a design session's first prompt
  with it, as it does for the minion. The instruction tells the agent to:
  - read the project's conventions, UI kit and routing first, and reuse kit components only.
    A missing component is recorded in the README as a gap, not invented inline;
  - build each screen as a prototype on fixtures, on a dev-only route `/__design/<slug>/<screen>`
    in the project's own app, so that it runs in the preview;
  - build every state the screen has: data, empty, loading, error, long content, and narrow
    width;
  - keep `{designDir}/README.md` current;
  - after each change, check the result with `browser_screenshot` at 390 and 1280 before
    answering.
- **Default skill `design-spec`.** It holds the method and the README template, so a project or
  workspace can override it by name. It is assigned to «Дизайнер» by default.

### What lands in the folder

```
docs/design/YYYY-MM-DD-<slug>/
  README.md        purpose, screens, states, decisions, open questions, acceptance criteria,
                   prototype paths and routes, kit gaps
  screens/<screen>-<state>@390.png
  screens/<screen>-<state>@1280.png
```

- **The prototype code stays in the app's source** (the README names the path), on a dev-only
  route. It is merged with the design. The task that implements the screen turns the prototype
  into the real screen and deletes it.
  - Rejected: keeping the prototype only on the design branch. Implementing agents could then
    neither run it nor copy from it.
- **Screenshots are files.** `browser_screenshot` gains an optional `path`: a worktree-relative
  `.png` under `docs/`. The tool writes the image there and answers with the path instead of the
  image.
  - Any other path is refused, so the tool cannot write outside the documentation tree.
  - Rejected: API-side capture. The API cannot know which screens and states exist; the agent
    that built them can.

### «Зберегти дизайн»

- **What it does.** It sends the Дизайнер one Kermanych prompt, the way «Закомітити» works
  (`commitChanges`, which renders an instruction and sets `reviewPending`). The prompt asks the
  agent to:
  - visit every screen and state listed in the README at 390 and 1280;
  - write the screenshots with `path`, deleting the ones whose screen or state is gone;
  - make the README match the prototype;
  - commit with the message `design: <topic>`.
- **Its instruction** is a new `design-save` entry in `AGENTS`, kind `procedure`, so the
  operator can edit it.
- **Feedback.** The button runs through `useAsyncAction`. The design stays `pending` until the
  transcript shows the commit.
- **«Створити ПР» and «Завершити»** are the existing flows. Through the PR, the design reaches
  the default branch the way code does, after review.

### Documentation policy

- **A new kind `design` → `docs/design`**, with rules `off | optional` and default `optional`.
  - With `optional`, `policyLine` tells every session of the project that designs live in
    `docs/design/<date>-<slug>/`. A task that names one is implemented with
    `implement-from-design`.
  - With `off`, other sessions are not told. Design sessions still write their folder.
- **The gate for a design session checks only its own folder.** PR, commit and finish need
  `{designDir}/README.md` on the branch. The spec, plan and docs-impact rules do not apply,
  because the design README is that branch's task document.
  - Without this, the default policy blocks every design branch on `task-spec`.
- **Tagging.** The session «Документація» tab tags `docs/design/**` as «дизайн».
- **Settings.** The «Документація» subsection gains the row «Дизайн · `docs/design/` ·
  off · optional».

### From design to implementation

- **«Задача →» is offered for a design's README** on the Дизайн page and in the Документація
  tab.
  - Its target defaults to the **same** project. Other projects of the workspace stay
    selectable.
  - Platform `web`, prefix `feature`.
  - The description is the origin line, followed by the README.
  - The card's images are the `@1280` and `@390` screenshots, uploaded through
    `board.createTask(input, images)`. An implementing agent therefore sees the target as
    images, not only as text.
- **Default skill `implement-from-design`.** The agent:
  1. reads the README and the screenshots;
  2. reuses the prototype's components and fixtures shape;
  3. implements every listed state;
  4. compares its own `browser_screenshot` at the same widths with the saved ones, and lists
     every deliberate difference in its handoff;
  5. deletes the prototype route and files.
- **Publishing.** Adding `docs/design` to the project's published `docFolders` shows designs,
  screenshots included, in «Менеджмент → Project Documentation». The README text is indexed
  like any other document. This is a settings recommendation, not a migration.

## Out of scope

- Several widths side by side on the canvas. One view per session exists today; the presets
  switch widths.
- The component inspector and JSON specs (variant B), Figma import, and comments that persist
  on the canvas. Picks go to the agent, as on «Агенти».
- Converting the existing `design/*.html` files.

## Changes

- **core**
  - `Session.designDir?`, `Task.design?`.
  - `BRANCH_PREFIXES += "design"`.
  - `AGENTS += designer, design-save`, and `packages/core/test/agents.spec.ts` lists them.
  - `DEFAULT_SKILLS += design-spec, implement-from-design`.
  - `doc-policy.ts`: kind `design`, `DocsPolicy.design`, `DOCS_RULES.design`, the default,
    `policyLine`, and a design-session branch in `docsGateFailures`. The `doc-policy` spec
    literals list the new key.
- **cloud**
  - Migration: `tasks.design boolean not null default false`.
  - `packages/cloud` maps it in task reads and writes.
  - `docs_policy` is jsonb and takes the new key without a migration.
- **api**
  - The launch stamps `designDir` and uses the `designer` opening prompt.
  - SQLite column `design_dir`.
  - `POST /sessions/:id/design/save`.
  - The docs gate takes the design branch.
  - `browser_screenshot` `path`, with its guard.
- **ui**
  - `DesignPage.vue`, a `VIEWS` row, a route, and uk/en strings.
  - Picks sending moves out of AgentsPage into a composable shared by both pages.
  - AgentsPage filters out design sessions.
  - Map and board design marks.
  - The «Задача →» dialog accepts `design` and attaches screenshots.
  - The Settings docs row, and the «дизайн» tag.

## Verification

- **core:** the gate passes a design branch that has `{designDir}/README.md` and fails one that
  lacks it, under the default policy. A non-design branch is unaffected by `docs/design/**`.
- **api:** `browser_screenshot` with `path` writes a PNG under `docs/` in the worktree, and
  refuses `../`, absolute paths and paths outside `docs/`.
- **Manual,** in the desktop app on a project with a `previewCommand`:
  1. Create a design and watch the preview start on the canvas.
  2. Point at an element with «◎ Вказати» and see the change.
  3. «Зберегти дизайн» → the folder holds the README and screenshots at both widths, committed.
  4. «Створити ПР».
  5. «Задача →» makes a card with the screenshots attached.
  6. An agent launched from that card follows `implement-from-design` and removes the
     prototype.

## Documentation impact

- `README.md`: a «Дизайн» section (page, session, folder, save, «Задача →»); the «Project
  documentation» table gains the `design` row; the «Session browser» agent-tools list notes
  `browser_screenshot`'s `path`; the «Design» section says new designs go through the tab and
  `design/*.html` are historical.
