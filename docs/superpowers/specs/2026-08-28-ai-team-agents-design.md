# Kermanych — «ШІ команда»: agent catalogue and skill assignment (Design)

- **Status:** Draft for review
- **Date:** 2026-08-28
- **Scope:** `packages/core` (an agent registry extracted from the supervisor's
  prompts), `supabase/migrations` (one new table), `packages/cloud` (its typed
  surface), `apps/api` (assignment resolution + launch wiring at the four
  procedure/session sites), `apps/ui` (three settings rows, one relocated panel,
  the Менеджмент cleanup)
- **Builds on:** `docs/superpowers/specs/2026-08-27-project-skills-design.md`
  (the skill library: materialisation, `--config`, the resolved view, the badges)
- **Baseline:** `dev` at the settings-v2 and workspaces merges. Every line
  reference below is to `dev`, not to the branch this document is written on.

## 1. Purpose

Give the operator a screen that answers two questions Kermanych currently
answers only in source code:

1. **Who is on the AI team, and what were they told?** A read-only catalogue at
   the **app** scope, listing every agent Kermanych ships and the exact
   instruction it sends. Its job is didactic: a newcomer should learn the shape
   of the product from it.
2. **What extra instructions does this project give them?** At the **project**
   scope, assign skills to those agents. An assigned skill is **guaranteed** to
   be in the agent's instruction — unlike a library skill, which the model takes
   at its own discretion.

## 2. Current state (as-is)

### 2.1 The six real behaviours, and which of them have instructions

`apps/api/src/supervisor/supervisor.service.ts` on `dev`:

| behaviour | entry point | instruction text | nature |
| --- | --- | --- | --- |
| chat → agent promotion | `promoteChatToAgent` `:482` | `:504` | prompt into a forked session |
| independent review | `reviewSession` `:708` | `:734` | **own** `omp` child, tools `read/grep/glob`, `kind:"review"` |
| conflict resolution | `resolveConflict` `:1041` | `:1048` | prompt into the existing session |
| pull request | `createPullRequest` `:1064` | `:1076` | prompt into the existing session, interpolates `project.conventions` |
| pour a conclusion back | `mergeDiscussion` `:768` | **none** | transport: wraps the child's own last assistant text as `[Ревізія «…»]: …` |
| finish (merge the branch) | `finishSession` `:1197` | **none** | plain git: commit, merge, delete branch |

Two consequences the design must respect: only four of the six have anything to
display, and the two that do not are not AI at all.

### 2.2 The settings surface

`apps/ui/src/lib/settings.ts` is the registry: `SettingsCategory { key, scope,
label, sub, blurb, danger? }`, three scopes (`project` / `workspace` / `app`),
and eleven categories (`project-basics`, `project-git`, `project-commands`,
`project-env`, `project-danger`, `workspace-basics`, `workspace-members`,
`workspace-danger`, `app-general`, `app-keymap`, `app-account`).

Two rules stated in that file's own header bind this design:

- **No placeholders.** "Everything registered below is backed by a real read and
  a real write. Nothing here is a placeholder" — a category with nothing behind
  it may not be registered.
- **Scope must not lie** about where the data lives; membership hangs off the
  workspace, which is why «Учасники» is workspace-scoped.

`apps/ui/src/pages/SettingsPage.vue` is 1777 lines and renders each category's
pane inline. It already owns the state this design needs: `projectId` from the
store (`:598`), `isOwnerOfProject` (`:640`), a `watch(projectId, …)` (`:797`),
and a blank state for a project-scoped category with no project selected
(`:57`).

### 2.3 Authorization after the workspaces migration

`projects.owner_id` is gone. `20260827100000_workspaces.sql:355-388` rewrote the
skill-library policies onto the workspace model, and any new table must copy that
shape verbatim:

- read: `public.is_project_member(project_id, auth.uid())`
- write: `exists (select 1 from public.projects p join public.workspaces w on w.id = p.workspace_id where p.id = project_id and w.owner_id = auth.uid())`

### 2.4 What the skill library already provides

From the previous spec, shipped and verified against a real `omp` child:
per-project resolution (repository skills > project rows > `DEFAULT_SKILLS`), the
repo-shadow guard, materialisation to `~/.kermanych/skills/<projectId>/<name>/SKILL.md`,
a merged `skills.customDirectories` overlay passed as `--config`, the resolved
view behind `GET /api/projects/:id/skills`, and the transcript's `skill` rows
with their source badges. `apps/ui/src/pages/ManagementSkillsPage.vue` is the
editor, mounted today as a Менеджмент section and taking `{ projectId, projectName }`.
The session's used-skills summary lives in `AgentsPage.vue` (`:214`, `:830`).

### 2.5 Verified `omp` levers, and one that does not exist

- `--skills <globs>` / `--no-skills` — a glob filter over all discovered skills,
  and a full disable. Both confirmed in `omp --help` on this machine. **Held in
  reserve, deliberately unused** — see §3.4: a launch-time flag is available at
  two of the four instruction sites and not at the other two, and buying a hard
  de-duplication for half the agents at the price of two different delivery
  behaviours is the wrong trade.
- `--append-system-prompt <text|file>` — appends to the system prompt. Also held
  in reserve: it would deliver the same guarantee invisibly, which costs the
  operator the audit trail the transcript gives for free.
- **`alwaysApply` on a skill is not a usable guarantee.** It belongs to the
  *rules* pipeline, a different capability: always-apply injection ("full content
  injected into system prompt") applies to rules discovered from `rules/*.md`
  directories — i.e. inside the repository. Writing there is exactly what the
  skill-library design refused to do, and the runtime effect of the field on a
  *skill* is undocumented. This design therefore does not rely on it.

## 3. Design

### 3.1 The agent registry lives in code, not in data

`packages/core/src/agents.ts` exports `AGENTS: readonly AgentDef[]` with
`AgentDef = { id, label, kind, instruction? }` and
`kind: "session" | "procedure" | "automation"`:

| `id` | `label` | `kind` | `instruction` |
| --- | --- | --- | --- |
| `review` | Ревізор | `session` | the `:734` template |
| `promote` | Промоутер | `session` | the `:504` template |
| `pull-request` | Провізор | `procedure` | the `:1076` template |
| `resolve-conflict` | Вирішувач конфліктів | `procedure` | the `:1048` template |
| `finish` | Завершити | `automation` | absent |
| `summary` | Саммарі | `automation` | absent |

`kind` describes the agent for the catalogue — `session` starts its own `omp`
child, `procedure` sends a message to a child that is already running,
`automation` involves no model at all. It is a label, **not** a switch: §3.4
delivers an assigned skill identically regardless of it. `promote` counts as
`session` because `promoteChatToAgent` forks a child through `launch`.

The four templates move out of `supervisor.service.ts` into this file and the
supervisor imports them, so the text the catalogue displays and the text the
agent receives cannot drift. `id` values are stable strings: they are the key
assignments hang off.

The templates keep their interpolation holes (the diff and base branch for
`review`, the branch and conventions for `pull-request`, the unmerged file list
for `resolve-conflict`). The catalogue renders the template **with the holes
visible**; interpolating outside a session is impossible, and the named holes
double as an explanation of where each agent gets its context.

### 3.2 Assignments are project data

```sql
create table public.project_agent_skills (
  project_id uuid not null references public.projects(id) on delete cascade,
  agent_id   text not null check (agent_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  skill_name text not null check (skill_name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  position   int  not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  primary key (project_id, agent_id, skill_name)
);
```

RLS and the audit trigger copy `project_skills` in its post-workspaces form
(§2.3) exactly: read for a project member, every write for the workspace owner,
`updated_at`/`updated_by` server-owned. The table is **not** added to the
Realtime publication — assignments are read when a session launches.

Order in the prompt is `position` then `skill_name`: deterministic, which
matters for provider prompt caching, and it leaves room for drag-ordering later
without a schema change.

### 3.3 `skill_name` is a name, not a foreign key

This is the load-bearing decision. A Kermanych default (`kermanych-session`,
`kermanych-pull-request`) has **no row** in `project_skills` — it is a
compile-time constant — so a foreign key would forbid assigning exactly the
skills the catalogue teaches. The name is resolved at launch by the resolver the
library already owns (repository > project row > default). Four consequences:

1. A default is assignable with no database row anywhere.
2. If the project later overrides that name with its own body, the assignment
   picks up the new text — override semantics stay identical everywhere.
3. If the **repository** defines that name, the repository's text wins, as it
   does everywhere in this feature. The assignment screen therefore shows the
   source badge already computed for the library (`source`, `shadowedByRepo`).
4. A name can resolve to nothing (the skill was deleted). That is a **UI state**
   — «зламане призначення», shown with the agent — not a database error and not
   a silent drop.

### 3.4 One delivery contract, at every site

**The invariant:** an assigned skill is delivered as a labelled block inside the
agent's own instruction. One code path, one text shape, one sentence in the
explainer — at all four instruction-bearing sites, regardless of `kind`.

```
assigned = resolve(assigned names, in position order)
         → «Скіли, призначені цій ролі (наведено повністю — не читай їх
            повторно через skill://):» + bodies, appended to the instruction
```

The block header carries the de-duplication instruction, and that is the whole
de-duplication mechanism: uniform, soft, and identical for a fresh child and for
a running session.

**Why not the launch-time flag.** `--skills` would give a hard guarantee that the
library never re-advertises an assigned skill, but only where Kermanych starts the
process: `review` (`reviewSession` `:708`) and `promote` (`promoteChatToAgent`
`:527`, which forks through `launch`) are launches, while `pull-request` (`:1064`)
and `resolve-conflict` (`:1041`) send a message into a session that is already
running — and skills, tools and the system prompt are fixed when a child starts.
Taking the flag would buy hard de-duplication for half the agents at the price of
two different delivery behaviours, two branches in the code and a two-clause
sentence in the explainer. The design refuses that trade: the flag stays in
reserve (§2.5), and if measurement ever shows the duplicate reads cost real
context, it can be added for the two launch sites without changing this contract.

**Why the process shapes stay as they are.** Each of the four is shaped by what it
needs, and unifying the shapes would cost quality rather than buy it. `review`
is a fresh child *by design* — its instruction opens «You did NOT do this work».
`promote` forks the chat so the settled discussion carries into the
implementation. `pull-request` and `resolve-conflict` run inside the session that
did the work because that session remembers **why** it wrote what it wrote: a PR
body describing "what changed and why", and a conflict resolution that keeps the
intent of both sides, are exactly what a fresh child cannot reconstruct from a
diff. That memory is durable, not incidental — `sendMessage` revives a dormant
session and rehydrates its history — and a fresh child in a mid-merge worktree
would additionally put a second writer into a tree that today has exactly one.
Turning those two into their own children is a separate change to those flows,
not a consequence of this feature; this contract would survive it unchanged.

Because an assigned skill is guaranteed by construction, the session's «Скіли»
field lists it statically as «від ролі»; the transcript's `skill` row keeps
meaning what it means today — a skill the model chose by itself.

### 3.5 The settings surface

Three rows added to `SETTINGS_CATEGORIES`:

| `key` | `scope` | `label` | contents |
| --- | --- | --- | --- |
| `app-agents` | `app` | ШІ команда | the read-only catalogue (§3.6) |
| `project-agents` | `project` | ШІ команда | the assignment board |
| `project-skills` | `project` | Бібліотека скілів | the relocated editor |

No workspace-scoped row: there is nothing behind it, and the file's own
no-placeholder rule forbids registering one. The rail filters by scope, so the
«Воркспейс» switch simply does not list it — no empty screen. Adding it later is
one row.

The same agent appears under two scopes with two different verbs, so the `sub`
and `blurb` must say which is which: the app row is «хто в команді й що їм
сказано», the project row «що додатково доручено на цьому проєкті». Without that
the operator will look for the assignment control in the catalogue.

`project_skills` is project-scoped, so the library lands at the project scope.
The Менеджмент tab loses it: the `management-skills` row in `lib/management.ts`
and its `SECTION_PAGES` entry in `router/routes.ts` are removed.

**Structural exception, deliberate.** `lib/settings.ts` says a new category costs
"one row here; the page's `v-if` for it is the only other edit", but
`SettingsPage.vue` is already 1777 lines and three inline panes would push it
past 2500. `ManagementSkillsPage.vue` is already a self-contained component
taking exactly the props the page can supply, so it is renamed to
`components/settings/SkillsLibraryPanel.vue` and **mounted** in its pane rather
than inlined. The two new panels are components for the same reason. The page
keeps ownership of `projectId`, `isOwnerOfProject` and the blank state.

### 3.6 What the catalogue shows

Per agent: the label, a badge for `kind`, and — for the four that have one — the
instruction template verbatim, in the **English it is actually sent in**. No
translation and no authored Ukrainian summary: the model receives the English
text, and a Ukrainian paraphrase beside it would be a second source of truth that
can drift. The didactic weight therefore sits on the labels and the `kind`
badges: `session` («власна сесія»), `procedure` («доручення тому, хто вже
працює»), `automation` («без ШІ»). `finish` and `summary` render with the
automation badge and no instruction panel — which is itself the lesson about
where a model is and is not involved.

### 3.7 The explainer

On the assignment screen, not in the skill editor: the difference is a property
of assignment, not of the skill. Four sentences, in this order:

1. Скіл у бібліотеці — агент бере його сам, коли вважає за потрібне; у чаті це
   видно окремим рядком `skill`.
2. Скіл, призначений ролі, вклеюється в інструкцію запуску — агент не може його
   не побачити.
3. Той самий скіл може бути і в бібліотеці, і призначеним: у блоці призначення він
   наведений повністю, і агенту сказано не читати його вдруге з бібліотеки.
4. Призначений текст оплачується контекстом на кожному ході — тримай його
   коротким.

The skill editor carries one line pointing at that screen.

**Budget, shown not enforced.** Prompt-injected text is paid on every turn of the
session, not once. The editor shows each body's size and the assignment board
shows the sum per agent, with a warning past a threshold. Nothing is blocked: a
long assigned skill is a legitimate choice with a visible price.

## 4. Isolation / boundaries

- **`packages/core`** — `AgentDef`, `AGENTS`, the four templates. Pure data; no
  I/O, no cloud, no `omp` knowledge. Imported by both the supervisor and the UI.
- **`packages/cloud`** — the `project_agent_skills` typed surface only.
- **`SkillsService` (api)** — gains assignment resolution and the block builder.
  It remains the only component that decides precedence or touches the
  filesystem.
- **`SupervisorService`** — appends the resolved block at all four instruction
  sites through one helper. It sets no skill-related launch flags and gains no
  resolution logic.
- **UI** — three panels; no resolution logic, no second source of truth for the
  instruction texts.

## 5. Verification

**Unit (`packages/core`):** every `AGENTS` entry has a stable id matching the
name pattern; exactly the four expected ids carry an instruction; the two
`automation` entries carry none; each template still contains its interpolation
holes (a guard against the extraction silently dropping one).

**Unit (`apps/api`):** assignment resolution — order by `position` then name; a
default assignable with no cloud row; a project override replacing a default's
body; a repository-defined name winning and being reported as such; a dangling
name surfaced rather than dropped. The delivery contract — one helper produces the
labelled block, its header carries the "do not re-read via `skill://`" clause, and
all four sites call that same helper (the test names the four call sites, so a
later edit cannot quietly give one of them its own text shape).

**Integration (`apps/api`, real `omp` child, `KERMANYCH_E2E_OMP=1`):** a skill
assigned to `review` appears verbatim in the child's opening instruction; the
library's own advertisement in the system prompt is unchanged by the assignment
(the contract deliberately does not filter it); and no skill-related flag appears
in the child's argv.

**RLS (`packages/cloud`, env-gated):** a member reads assignments; a member's
write is refused; the workspace owner's write succeeds; `updated_by` is stamped
by the trigger.

**Manual smoke:** Налаштування → Застосунок → ШІ команда shows six agents, four
with English templates and two with none; Проєкт → ШІ команда assigns a skill to
Ревізор; launching a review shows the assigned text in the opening message and
the skill listed as «від ролі»; Проєкт → Бібліотека скілів is the former
Менеджмент screen, and Менеджмент no longer lists it.

## 6. Non-goals

- **Project-defined agents.** No user-created roles in this iteration: the
  product has no way to *launch* one (today's affordances are buttons bound to
  specific system flows plus the task board), and inventing that affordance is a
  separate product decision. `tasks.kind` remains an unused column that could
  carry a per-task role later.
- **An `executor` agent.** The main work session is deliberately excluded, so
  assignments affect side flows only (review, PR, conflicts, promotion). Its
  instruction is the task, and how work is done in a repository is already
  governed by that repository's own context files and by the library the executor
  reads on its own; a mandatory Kermanych block in every work session would
  compete with the repository's rules — the one thing this feature refuses to do.
- **A workspace scope** for agents or skills, until there is something real
  behind it.
- **Translating or paraphrasing the instructions** in the catalogue.
- **Editing the system agents' instructions.** Read-only in this iteration;
  assignment is the only project-level lever.
- **Any skill-related launch flag.** Neither `--skills` nor `--no-skills` nor
  `--append-system-prompt` is used: one delivery contract (§3.4) beats a harder
  guarantee that only half the agents could have. All three stay available if
  measurement later justifies one.
- **Unifying the four process shapes.** Turning `pull-request` and
  `resolve-conflict` into their own children is a change to those flows, weighed
  and declined in §3.4; the delivery contract does not depend on it either way.
- **Enforcing a context budget.** Sizes and a warning are shown; nothing is
  blocked.
