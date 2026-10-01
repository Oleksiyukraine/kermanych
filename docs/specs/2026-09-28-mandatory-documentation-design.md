# Kermanych — Mandatory Documentation (Design)

- **Status:** Implemented (`e38feae`, branch `feature/docs-main-pattern`)
- **Superseded in part:** the single switch now has per-kind rules (spec, plan, schemas,
  handoff, API request) and `DocsGate.required` became `enabled` + `asks` — see
  `docs/specs/2026-09-30-documentation-settings.md`. §3.3–§3.7 describe the default rules.
- **Date:** 2026-09-28
- **Scope:** `supabase/migrations` (one column), `packages/core` (documentation
  policy, gate, two default skills, librarian fix), `packages/cloud` (project
  mapping), `apps/api` (registry column, system-prompt append, gate on
  PR/commit/finish, «Доповнити документацію» route), `apps/ui` (project setting,
  finish sheet, Документація tab badges, i18n), `README.md`

## 1. Purpose

Three requirements from the operator:

1. **Every task is documented.** Today specs and plans exist only when the agent
   happens to invoke the superpowers plugin. Kermanych neither enables nor
   references it, and not every machine has it installed.
2. **A task that changes how the service behaves updates the documentation.**
   Today this is one soft line, `DOC_MAINTAIN_DIRECTIVE`, on a task-born
   session's first prompt. Nothing checks it.
3. **A frontend handoff after the task, when the developer asks for it.**
   Nothing exists.

Decisions taken in discussion:

| # | Question | Decision |
| --- | --- | --- |
| 1 | Where it is switched on | A project setting «Обовʼязкова документація» |
| 2 | Where documents live | `docs/specs`, `docs/plans`, `docs/schemas`, `docs/handoffs`, overriding superpowers' `docs/superpowers/*` defaults |
| 3 | How hard | As hard as possible: Kermanych refuses PR, commit-to-PR and finish until the documentation is in place |
| 4 | When a handoff is required | A checkbox in the finish sheet, on by default |
| 5 | Where the handoff is shown | It is a document in the repository, so the session's «Документація» tab |
| 6 | Which sessions | All sessions of the project |
| 7 | Customisation | The handoff (and task-spec) instructions are skills a project can override |

## 2. Current state (as-is)

- **Directives.** `COAUTHOR_DIRECTIVE` and `DOC_MAINTAIN_DIRECTIVE`
  (`packages/core/src/agents.ts`) are appended to the first prompt in
  `SupervisorService.launch` only. Chats, discussions, reviews, resumes and every
  later prompt skip them.
- **System prompt.** `SupervisorService.languageOpts()` → `appendSystemPrompt` is
  the one system-level injection point. It reaches both runtimes (omp
  `--append-system-prompt`; claude-code `systemPrompt.append`) at every spawn:
  `createChat`, `launch`, `branchSession`, `reviewSession`, `doResume`.
- **Skills.** `DEFAULT_SKILLS` (`packages/core/src/skills.ts`) resolve under
  repository skills > `ai_skills` rows (user > project > workspace) > defaults.
  `SkillsService.assignedForNames(scope, names, cwd)` returns the resolved
  bodies as an inline block that works on both runtimes. The `librarian`
  description and its section 2 still describe a PR-time doc report that
  migration `20260915120000_drop_task_doc_report.sql` removed.
- **Finish sheet** (`AgentsPage.vue`, KModal `finishOpen`). It shows branch,
  ahead count and conflicts, with «Створити ПР» / «Закоміти» / «Завершити». The
  three actions POST `{}` to `/sessions/:id/pr|commit|finish`.
- **Changed files.** `WorktreeService.changedFiles(dir, base)` diffs the working
  tree (untracked included) against the fork point. `finishInfo` already returns
  it and the «Зміни» and «Документація» tabs use it.
- **Superpowers.** `brainstorming` and `writing-plans` (6.4.1) state that the
  spec and plan paths are defaults which "User preferences … override". The system
  prompt is where such a preference is placed, so the path override is reliable
  whenever the plugin is present. When it is absent, Kermanych's own policy and
  skills carry the whole contract.

## 3. Design

### 3.1 Setting

- **Cloud:** `alter table public.projects add column docs_required boolean not
  null default false;` The existing RLS and grants cover it (same as
  `default_effort`). The default is off: switching an existing project to
  blocking PRs has to be the operator's choice.
- **Plumbing:** threaded through every mirror layer like `doc_folders` —
  `PROJECT_COLUMNS`, `ProjectRow`, mappers, `CloudProjectPatch`/insert,
  `CloudProject.docsRequired`, core `Project.docsRequired?`, a registry SQLite
  column `docs_required INTEGER NOT NULL DEFAULT 0` (list/upsert/patch),
  `SupervisorService.updateProject`/`syncProjects`/the from-task refresh, and the
  `PATCH /projects/:id` body.
- **UI:** a `KCheckbox` «Обовʼязкова документація» with a hint that names the layout,
  saved through the existing `projects.patch` path. It first lived in the `project-git`
  pane next to the documentation-folders editor; it now sits in `project-basics`
  («Основне») — see `docs/specs/2026-09-29-docs-required-in-basics.md`.

### 3.2 Layout (repository-relative)

| Folder | Holds | Who writes it |
| --- | --- | --- |
| `docs/specs/YYYY-MM-DD-<topic>.md` | the task document: required for every task that changes the repository | the agent, from the start of the work |
| `docs/plans/YYYY-MM-DD-<topic>.md` | an implementation plan, when the work needs one | the agent, optional |
| `docs/schemas/` | how the service works: architecture, flows, data models, API contracts (living documentation) | the agent, whenever behaviour changes |
| `docs/handoffs/YYYY-MM-DD-<topic>.md` | a frontend handoff | the agent, when the finish sheet asks for it |

The constants live in `packages/core/src/doc-policy.ts` (`DOCS_LAYOUT`).

### 3.3 Policy delivery: all sessions, both runtimes

When `project.docsRequired` is true, `DOCS_POLICY_APPEND` (core) is joined to the
language append, and **every** spawn passes it through
`appendSystemPrompt`: chat, agent launch, discussion, review and resume. The
append:

- names the four folders and what goes in each;
- requires a task document in `docs/specs/` for every task that changes the
  repository, created before implementation and kept current, with a
  `## Documentation impact` section;
- requires updating `docs/schemas/` (or the project's other existing docs) when
  the service's behaviour changes. When it does not, `## Documentation impact`
  begins with `None` followed by the reason;
- states that these locations override any skill or plugin default, naming
  superpowers' `docs/superpowers/specs|plans` explicitly;
- states that Kermanych refuses PR, commit and finish until the documentation is
  in place.

Read-only sessions (chat, review, discussion) get the same text. Its rules are
worded "every task that changes the repository", so it only tells them where the
documentation is. `DOC_MAINTAIN_DIRECTIVE` is unchanged for projects with the
setting off.

### 3.4 The gate (pure, in core)

```ts
type DocsGateFailure = "task-spec" | "docs-impact" | "handoff";
docsGateFailures({ paths, specBodies, handoff }): DocsGateFailure[]
```

Given the branch's changed paths (the `changedFiles` listing) and the text of the
changed task documents:

- **doc-side path:** `isDocPath(p)` or any path under a `docs/` / `doc/`
  directory (so a `docs/schemas/*.svg` diagram counts as documentation, not
  code). Everything else is **code**.
- **`task-spec`:** no changed markup file under `docs/specs/`.
- **`docs-impact`:** some code changed **and** no doc-side path outside
  `docs/specs|plans|handoffs/` changed **and** no changed task document has a
  `## Documentation impact` section whose first non-empty line starts with
  `None` (case-insensitive; list markers and emphasis ignored). This is the only
  escape hatch. It is explicit, it lives in the repository, and the reviewer sees
  it.
- **`handoff`:** `handoff` requested **and** no changed markup file under
  `docs/handoffs/`.
- **empty change set:** no failures. The policy covers "every task that changes
  the repository", so a session that changed nothing can still be finished.

A machine cannot decide whether a change alters logic. The gate therefore makes
silence impossible rather than guessing: either the living documentation moves, or
the task document says in writing why it did not have to.

### 3.5 Enforcement in the API

- `SupervisorService.docsGate(id, handoff)` returns `{ required, failures }`. It
  computes `changedFiles` for the session (same dir/target resolution as
  `finishInfo`) and reads the changed `docs/specs/*` bodies with the guarded
  `readFileContent`. It returns `required: false, failures: []` when the project
  setting is off.
- `finishInfo(id, handoff)` also returns `docsGate`.
  `GET /sessions/:id/finish?handoff=1`.
- `createPullRequest(id, { handoff })`, `commitChanges(id, { handoff })` and
  `finishSession(id, { handoff })` evaluate the gate first and throw
  `documentation required: …` (a 400 via `sessionFailure`) when failures remain.
  Bodies: `POST /sessions/:id/pr|commit|finish` `{ handoff?: boolean }`. An
  absent value is `false`, which is also what a trigger-run PR uses; the gate's
  spec and impact rules still apply there.
- `completeDocs(id, { handoff })` → `POST /sessions/:id/docs` sends one Kermanych
  prompt (`sendAsKermanych`, so a dormant session is revived) built by core
  `docsCompletionPrompt(failures)`. The prompt lists exactly the failing items.
  `SkillsService.assignedForNames` then inlines the resolved `task-spec` and/or
  `frontend-handoff` skill bodies, so the project's or repository's override wins.
  The prompt ends with "commit these documents; if this branch already has an open
  pull request, push it; do not change code in this turn". The route returns
  `{ sent: boolean, failures }`, and `sent: false` means nothing was missing.

### 3.6 Skills (overridable per project)

Two new `DEFAULT_SKILLS`, both compact, overridden per project, workspace or
repository by name like any default:

- **`task-spec`** covers the task document: goal, context and task link,
  decisions and rejected alternatives, what changes, verification, and
  `## Documentation impact`. It is sized to the task (a fix gets a page, a feature
  a full spec).
- **`frontend-handoff`** is written for a frontend developer who did not see
  the work: what changed for the client, endpoints (method, path, request and
  response, errors), realtime/events, breaking changes, env/config, migration
  order, and how to try it. When nothing changed for the frontend, it says so in
  one line.

`librarian` loses its stale "report at PR time" section and description.

### 3.7 UI

- **Finish sheet**, only when `docsGate.required`:
  - a `KCheckbox` «Хендоф для фронта», on by default each time the sheet opens.
    Toggling it re-reads `finishInfo(id, handoff)`;
  - the list of failures in plain language;
  - «Доповнити документацію» → `POST /sessions/:id/docs`, then the sheet closes
    and the agent works in the transcript;
  - «Створити ПР»/«Закоміти»/«Завершити» are disabled while failures remain, and
    they send `{ handoff }`.
- **Документація tab:** changed docs carry a badge from `docsLayoutKind(path)`:
  специфікація / план / схема / хендоф. This makes the handoff findable where
  decision 5 puts it. The stale `usedHint` copy about the «Бібліотекар» report is
  corrected.

### 3.8 Superpowers compatibility and known limits

- **What the override covers.** Superpowers 6.4.1 `brainstorming/SKILL.md:241-242`
  and `writing-plans/SKILL.md:18-19` make their paths defaults that "User
  preferences … override", and `using-superpowers/SKILL.md:65` ranks user
  instructions above skills. `DOCS_POLICY_APPEND` rule 3 is that instruction.
  Specs and plans therefore land in `docs/specs` / `docs/plans`.
- **What it does not cover.** Superpowers knows no `docs/schemas` or
  `docs/handoffs` and writes no `## Documentation impact` section. The policy,
  the `task-spec` / `frontend-handoff` skills and the gate supply those, so the
  contract holds with or without the plugin.
- **Unverified.** The override has not been exercised in a live session with
  the plugin. `ClaudeCodeRuntime` passes no `settingSources`, so whether
  `~/.claude` plugins load on the claude-code runtime at all is unconfirmed.
- **Running sessions.** The policy reaches a session at spawn. A session already
  running when the setting is switched on gets it on its next resume or restart.
  The gate applies immediately.
- **Trigger-run PRs** evaluate the gate with `handoff: false`.
- **Rollout order.** Apply migration `20260928090000_project_docs_required.sql`
  before deploying the API: `PROJECT_COLUMNS` selects `docs_required`.

## 4. Out of scope

- Judging whether documentation is *good*. The gate checks presence and the
  explicit declaration, and review judges the content.
- Moving existing `docs/superpowers/*` files.
- Creating a board task from a handoff.
- Showing a retired (finished) session's documents in the tab. They live on the
  kept branch and, once merged, in Project Documentation.

## 5. Testing

- **core:** `docsGateFailures` covers the boundaries: no spec; spec present;
  code with no living doc; code with a `docs/schemas` change; code with a
  `None — …` declaration; a declaration that does not start with `None`; a
  docs-only change needing no impact; handoff requested/present/absent; a
  `docs/schemas/*.svg` counting as documentation. `docsLayoutKind` is covered, as
  is `docsCompletionPrompt` listing only the failing items.
- **cloud/registry:** `docs_required` round-trips and defaults to false.
- **api:** with the setting on, `createPullRequest`/`commitChanges`/
  `finishSession` refuse on failures and pass once the documents exist;
  `completeDocs` sends a prompt carrying the skill bodies; with the setting off
  nothing changes; the policy reaches `appendSystemPrompt`.
- **ui:** the i18n completeness suite covers the new keys.

## Documentation impact

Kermanych behaviour changes: a new project setting, a new session route
(`POST /sessions/:id/docs`), new request bodies on PR/commit/finish and a new
migration. `kermanych/README.md` gains the «Mandatory documentation» section.
