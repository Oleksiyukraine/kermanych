# «ШІ-команда → Агенти»: a short list and a page per agent

- **Branch:** `feature/redesign-agent-settings-list`
- **Scope:** `apps/ui` only. `pages/AiTeamPage.vue`, `router/routes.ts`, `lib/ai-team.ts`,
  `components/kit/KIcon.vue`, `components/settings/AiAgentsPanel.vue` and `MinionPanel.vue`
  (replaced, see Implementation notes), `i18n/{uk,en}`, a unit test, `kermanych/README.md`.
  No api, cloud or core change.
- **Builds on:** `docs/specs/2026-10-23-minion-auto-run.md` (decisions 6, 8, 11: the «Посіпака»
  card in the project scope).

## Goal

Operator's ask: make the agent list in «ШІ-команда» short and clear, with icons like the
«Посіпака» one, and let the operator open a page per agent that explains in detail how the agent
works.

## Context

- `/ai-team/:section?` is one route (`router/routes.ts:76-81`); `AiTeamPage.vue` renders a rail
  (scope switcher + sections) and one pane. The scope (`user` / `project` / `workspace`) is local
  state, `project` by default.
- «Агенти» pane today, per scope (`AiTeamPage.vue:94-105`):
  - **workspace** → `AiAgentsPanel.vue`: all 10 agents of `AGENTS` (`packages/core/src/agents.ts:276-287`)
    in one long list. Each of the 8 with an instruction has an open 14-row editor, hole hints,
    save / cancel / reset, provenance and a skill-sequence editor. The literal assigned-skills
    header and the base-sync block sit above / inside the list.
  - **project** → `MinionPanel.vue` only: activation on this machine, the machine's cap / pause /
    active projects, and the workspace's minion instruction and skills read-only. The other nine
    agents are not visible at all.
  - **user** → a stub.
- Nothing explains what an agent does or when it runs; the row shows the kind badge
  («власна сесія / процедура / без ШІ») and the raw English instruction.
- Icons: `KIcon.vue` inlines Lucide geometry; `minion` (Lucide `bot`) is the only agent mark.
- Launch resolution (`apps/api/src/skills/skills.service.ts:362-391`): instruction and skill
  sequence come from the most specific scope that has a row, user > project > workspace. The UI
  writes only workspace rows since `65ca7f8e`; project rows can still exist from before
  (migration `20260908090000_ai_scope.sql:162-166`). That gap is reported separately as a finding
  (no UI to see or remove such rows); this task only shows them truthfully (decision 1).

## Decisions

1. **The same list in the project and workspace scopes; the page depends on the scope.**
   - **workspace:** the list, and per-agent pages with the instruction and skill editors as today.
   - **project:** the same list; each page is read-only and shows what this project's agent
     actually gets: the instruction and the skill sequence resolved project row → workspace row →
     compile-time default (the launch order without the per-operator user layer), with a label
     naming the source («дефолт Керманича» / «з воркспейсу <name>» / «перевизначено в проєкті»)
     and a «Редагувати у воркспейсі» link that switches the scope. «Посіпака»'s page keeps the
     machine block from `MinionPanel` (activation, cap, pause, active projects).
   - **user:** the stub stays.
   - A project with no workspace shows the defaults (and any project rows) with a note.
   *Rejected:* keeping the split (list only in workspace, project = «Посіпака» only): the default
   scope hides nine agents. Showing the list in the user scope too: there is no user layer to edit.

2. **A page is a route: `/ai-team/agents/<id>`.** The route becomes `ai-team/:section?/:item?`.
   The rail stays; the pane shows the agent page instead of the list, with a «← Агенти»
   breadcrumb. Deep links and Back work. An unknown `<id>` lands on the list (`router.replace`),
   the way `aiTeamSection()` treats an unknown section; `:item` on any other section is dropped
   the same way. Switching the scope on an agent page stays on the same agent.
   *Rejected:* master-detail inside the pane (three columns; the instruction gets squeezed);
   expanding rows in place (not a page).

3. **A list row is one clickable line or two:** the agent's icon in a disc (the «Нова задача»
   menu style), the name, one human sentence of what it does, and on the right small marks —
   «переписано» when the effective instruction is not the default, «N навичок» when a sequence
   is assigned — and a `›` chevron. The kind and the `id` move to the page.
   *Rejected:* the kind badge in the row too (noise); icon + name only (says nothing).

4. **Grouped by the stage of work**, each group with a caption:
   - **Виконання:** Посіпака, Промоутер
   - **Дизайн:** Дизайнер, Зберегти дизайн
   - **Перевірка і здача:** Ревізор, Провізор, Комітер, Вирішувач конфліктів
   - **Без власної інструкції:** Завершити, Саммарі (worded per decision 8 rather than «Без ШІ»)

   The grouping is presentation and lives in `lib/ai-team.ts`, not in `@kermanych/core`.
   *Rejected:* grouping by kind (session / procedure / automation — technical); a flat list.

5. **The agent page, top to bottom:**
   1. **Header:** large icon, name, the one-line description, marks (kind with a tooltip saying
      what it means; «переписано»), the `id` small.
   2. **«Як працює»**, in sub-sections: *Коли запускається* (the control or event, and whether a
      trigger can run it), *Що робить* (3–5 steps), *Що отримує* (each `{{hole}}` in words),
      *Що Керманич додає сам* (what no override can change), *Чим закінчується* (the result).
   3. **«Інструкція»:** the editor in the workspace (as today: holes hint, required holes,
      save / cancel / «Повернути дефолт», provenance), read-only text in the project. The literal
      assigned-skills header and, for Провізор / Комітер, the base-sync block move here from
      above the list.
   4. **«Навички»:** the sequence editor in the workspace, the read-only list in the project.
   5. **«Посіпака» in the project only:** the «На цій машині» block (decision 1).

   Agents with no instruction (Завершити, Саммарі) get the header, «Як працює» and a note that
   there is no instruction or skills.
   The texts are i18n (uk and en), written from the code (fact sheet below).
   *Rejected:* «Як працює» as one paragraph; a «Тригери, що запускають агента» block (extra reads,
   separate task if wanted).

6. **Icons: Lucide line marks inlined in `KIcon`, one colour (`currentColor`).**
   | Agent | Lucide | `KIconName` |
   |---|---|---|
   | Посіпака | `bot` | `minion` (exists) |
   | Промоутер | `hammer` | `agentPromote` |
   | Дизайнер | `pen-tool` | `design` (exists) |
   | Зберегти дизайн | `save` | `agentDesignSave` |
   | Ревізор | `shield-check` | `agentReview` |
   | Провізор | `git-pull-request` | `agentPullRequest` |
   | Комітер | `git-commit-horizontal` | `agentCommit` |
   | Вирішувач конфліктів | `git-merge` | `agentResolveConflict` |
   | Завершити | `flag` | `agentFinish` |
   | Саммарі | `scroll-text` | `agentSummary` |

   The magnifier (`analysis`) and the rocket (`start`) are not reused: they already mean
   «Глибокий аналіз» and «Розпочати».
   *Rejected:* emoji (colour glyphs beside line marks, which `KIcon` exists to avoid); a colour
   per group (no such tokens in the theme).

7. **Leaving an agent page with an unsaved instruction asks first.** `onBeforeRouteLeave` /
   `onBeforeRouteUpdate` → `confirmAction` («Піти без збереження? Інструкцію «…» змінено і не
   збережено.», confirm «Піти»; the cancel is the dialog's own). Changing the scope, the project
   or the workspace changes no route and keeps today's behaviour: the draft is dropped, so text
   typed for one workspace is never saved into another.
   *Rejected:* dropping silently; keeping drafts per agent in memory (unsaved text lost unseen).

8. **The «без ШІ» kind label is reworded to «автоматика»** with the tooltip «Керманич виконує
   сам — власної інструкції й навичок немає», and the note on an automation's page no longer says
   «модель тут не задіяна». «Саммарі» does reach a model: it sends a fixed request into the same
   session, answered by that session's model. The list's group caption follows (decision 4).
   (Settled by the author during writing; the operator may overrule.)

## Fact sheet for «Як працює»

Collected from code; the texts are written from it.

| Agent | When | What it does | Inputs | Kermanych adds | Ends |
|---|---|---|---|---|---|
| Ревізор | session menu «⚖ Ревізор» (⌘D); trigger | own fresh child, read-only tools, in the doer's worktree; audits task vs diff | task, base, branch, diff (`git diff` from the fork point, incl. uncommitted) | skills block | verdict APPROVE / NEEDS CHANGES in its transcript; «⤴ Віддати» sends it to the doer |
| Промоутер | «▶» in «Чат»; trigger | the chat becomes an agent: a card, a worktree on a `feature/…` branch, full tools, same context (fork) | branch | skills block, co-author and docs directives | an ordinary agent session in «Агенти» |
| Провізор | «Створити ПР» (finish sheet, «Дизайн»); trigger; Посіпака after `ready` | message into the running agent: commit, push, `gh pr create` with `GIT_TOKEN` | branch, conventions (repo's or fallback), baseLine | base sync (merge `origin/<base>`), `[Minion]` title rule for a minion run, skills block, QA checklist for a card's session | PR link on the session, status «На ревʼю» |
| Комітер | «Закоміти» once a PR exists | message into the running agent: commit and push, never a second PR | branch, conventions | base sync, skills block | the open PR updated, back to «На ревʼю» |
| Вирішувач конфліктів | «Вирішити автоматично» on conflicts; trigger | message into the agent mid-merge: resolve keeping both sides, commit | files | skills block | merge committed, session back to «На ревʼю» / «Готово» |
| Посіпака | no button: polls every 60 s for the author's backlog cards with «Дозволити автовиконання» on an activated project | own session in a worktree, no ask tool; checks the card still applies, smallest change, commits; 2 h cap | task (card name + description) | finding line + `minion-findings` skill for a finding card, skills block, `report_outcome` contract, co-author and docs directives | `ready` → docs turn if needed → PR → «На ревʼю»; `not_needed` → card done; `needs_decision` → «На ревʼю» with the reason |
| Дизайнер | «+ Новий дизайн» in «Дизайн» | own session on `design/<slug>`: prototype on dev routes, every state, screenshots at 390 / 1280, README | designDir, topic, description | `design-spec` skill, skills block, co-author and docs directives | the design folder committed; PR / finish as usual |
| Зберегти дизайн | «Зберегти дизайн» in «Дизайн» | message into the Дизайнер: screenshots of every screen and state, README synced, commit without push | designDir, branch, message | skills block | screenshots listed in the reply |
| Завершити | ✓ «Завершити» → finish sheet | no model: auto-commits leftovers, stops the session, removes the worktree; the branch stays | — | — | the card in «Завершені»; «↻ Відновити» brings the worktree back |
| Саммарі | «≡» in the composer | no own instruction: a fixed request into the same session | — | — | the summary as the agent's next reply |

## Implementation notes

- `router/routes.ts`: `ai-team/:section?/:item?`.
- `lib/ai-team.ts`: `AI_TEAM_AGENT_GROUPS` (group key → agent ids), `AGENT_ICONS`
  (id → `KIconName`), `aiTeamAgent(id)` (the `AgentDef` or undefined), and `resolveAgent` — the
  launch's resolution over any mix of rows (the top scope's row alone decides the instruction,
  broken or blank → default; the sequence whole from the top scope that has one, the
  `SkillsService.assignedFor` comparator).
- `composables/useAiAgentRows.ts` (new): reads the agent rows and sequences of the owners a page
  is about (`agentOwners`: a project and its workspace, or a workspace).
- `components/settings/AiAgentsList.vue` (new): the grouped list.
- `components/settings/AiAgentPage.vue` (new): one agent — meta, «Як працює», then the editor or
  the read-only view, and «Посіпака»'s machine block.
- `components/settings/AiAgentEditor.vue` (new): the workspace editor of `AiAgentsPanel.vue` for
  one agent (one draft, one save / reset, one sequence) and the leave guard; keyed on the owner,
  so a workspace switch remounts it. `AiAgentsPanel.vue` is deleted.
- `components/settings/AiAgentReadonly.vue` (new): the project view, replacing `MinionPanel.vue`'s
  instruction block; the machine block moves to `components/settings/MinionMachineBlock.vue` and
  `MinionPanel.vue` is deleted.
- `pages/AiTeamPage.vue`: the agent page's header (breadcrumb, disc, name, tagline) in place of
  the section heading; an `:item` that names no agent, or sits under another section, is
  replaced away; the rail's «Агенти» row from an agent page goes back to the list.
- `KIcon.vue`: the eight new names of decision 6.
- `i18n/{uk,en}`: `aiTeam.agents.*` (groups, list marks, breadcrumb, page headings, source labels)
  and `aiTeam.agents.about.<id>.*` from `i18n/<locale>/agent-about.ts` (tagline and the «Як
  працює» sub-sections); `confirmations.leaveAgent` and `confirmations.label.leave`; the
  `aiTeam.sections.agents` sub / blurb reworded; `settings.agentKind.automation` and
  `settings.aiAgents.automationNote` per decision 8. Keys only the deleted panels read are removed.

## Out of scope

- Seeing or removing a legacy project / user override (reported as a finding).
- «Комітер» offered in the trigger picker while the api cannot run it (reported as a finding by
  the fact-collecting pass).
- Triggers, skills library, helpers panes.
- What any agent is told (`packages/core/src/agents.ts` unchanged).

## Verification

- **Unit (`apps/ui/test`, vitest, `--maxWorkers=4`):** every `AGENTS` id is in exactly one group
  and has an icon; the project-view resolution: project row beats workspace row beats default, a
  broken row falls back like `effectiveInstruction`, the sequence comes whole from one scope.
- `pnpm --filter @kermanych/ui typecheck`; the existing suite stays green.
- **Live check in the preview:** the list in the project scope (grouped, icons, one line each);
  opening an agent, the breadcrumb and Back; an unknown `/ai-team/agents/x` lands on the list;
  switching the scope on a page keeps the agent; «Посіпака»'s page in the project shows the
  machine block; Завершити / Саммарі show no instruction. The preview has no cloud workspace, so
  the workspace editor and the leave confirmation are checked only if a workspace is available;
  otherwise that is reported as not exercised.

## Documentation impact

- `kermanych/README.md:1405`: the activation path becomes «ШІ-команда» → project → «Агенти» →
  «Посіпака» → «Активувати на цій машині» (the page).
- `kermanych/README.md:1125`, `:1323`, `:1415`: references to «ШІ-команда → Агенти» stay true;
  one sentence where the section is introduced on the list, the page per agent and the
  project / workspace difference.
