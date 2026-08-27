# Kermanych — Project Skill Library (Design)

- **Status:** Draft for review
- **Date:** 2026-08-27
- **Scope:** `supabase/migrations` (one new table), `packages/cloud` (new
  `skills` module + barrel export), `packages/core` (bundled default skills,
  `TranscriptEntry` reduction for skill reads, `tool-display`),
  `apps/api` (new `SkillsService` materializer, `RpcSession` argv, supervisor
  wiring at its five spawn sites), `apps/ui` (a Менеджмент section + transcript
  rendering)

## 1. Purpose

Give every Kermanych project a **library of skills** — named prose capability
packs that the agent pulls in **by itself, when the task calls for it** — with

1. a set Kermanych ships by default, and
2. per-project skills the operator authors in the UI,

delivered to each `omp` session so that the model discovers them natively, while
**never overriding the target repository's own rules**, and with the selection
**visible in the chat**: which skill the agent took, and from where.

A skill is knowledge, invoked by the model. It is not an "agent": nothing here
adds a new session type, prompt template, toolset, or button. That distinction
is load-bearing for the whole design — see §6.

## 2. Current state (as-is)

### 2.1 What Kermanych can influence in a session

`RpcSession.start()` (`apps/api/src/rpc/rpc-session.ts:47-53`) builds the entire
child command:

```ts
const argv = ["omp", "--mode", "rpc", "--cwd", this.opts.cwd];
if (this.opts.model) argv.push("--model", this.opts.model);
if (this.opts.fork) argv.push("--fork", this.opts.fork);
if (this.opts.noTools) argv.push("--no-tools");
if (this.opts.tools?.length) argv.push("--tools", this.opts.tools.join(","));
```

No `env`, no config file, no system-prompt flag anywhere in `apps/api/src` or
`packages/core/src`. Instructions reach the agent only as RPC `prompt` text —
four hand-written templates (`apps/api/src/supervisor/supervisor.service.ts:470`
chat→agent promotion, `:671-703` independent review, `:999-1005` conflict
resolution, `:1027-1036` pull request), of which only the PR one interpolates
project config (`:1022`, `project.conventions`).

Five spawn sites exist, all in `supervisor.service.ts`: `:419` chat (cwd =
project dir, `tools: CHAT_TOOLS`), `:575` agent launch (cwd = worktree or project
dir), `:641` discussion branch (`fork`, `noTools`), `:705` independent review
(`tools: ["read","grep","glob"]`), `:1295` resume after an API restart.

The session cwd is always a **repository root**: either the worktree root
`~/.kermanych/worktrees/<sessionId>` (`packages/core/src/worktree-names.ts:39-41`)
or the bound `project.localRepoPath`. Nothing is written into a worktree except
the project's carry files (`apps/api/src/env/carry-files.ts:7-18`, default
`[".env"]`).

`omp`'s RPC surface has **no** command to change skills, the system prompt, or
the toolset after start (`omp://rpc.md`, full command schema); only the model is
mutable (`set_model`). Skills are therefore a **launch-time** concern.

### 2.2 What `omp` already does, verified live

Both facts below were probed against the installed binary in Kermanych's exact
launch shape (`omp --mode rpc --cwd <repo> [--config <overlay>]`), reading
`systemPrompt` from a `get_state` response (no model call involved):

| probe | result |
| --- | --- |
| a skill committed in the repo (`.claude/skills/probe-alpha/SKILL.md`), no overlay | `- probe-alpha: PROBE ALPHA — repo-committed skill…` present |
| a skill in an external dir advertised through `--config` with `skills.customDirectories` | `- probe-beta: PROBE BETA — external dir via skills.customDirectories.` present |
| **the same name in both places** (`opening-a-pr`) | overlay wins: `- opening-a-pr: FROM-KERMANYCH injected rules.` — the repo skill **disappears silently** |

The third row is why §3.3 exists: `omp` documents custom directories as
overriding same-named provider skills (`omp://skills.md`), so "Kermanych must not
overwrite the project's rules" has to be enforced by Kermanych, not assumed.

What the probes did **not** cover: whether a `skills.customDirectories` entry a
*lower* config layer already declares survives the overlay. It does not — `--config`
is `omp`'s highest-precedence layer and array-typed settings are **replaced**
wholesale by a higher layer, never appended, so an overlay naming only Kermanych's
directory erases both the operator's `~/.omp/agent/config.yml` entries and the
target repository's own `<cwd>/.omp/config.yml` ones. §3.4 therefore reads the
effective value with `omp config get skills.customDirectories` **in the session
cwd** and emits the union with Kermanych's directory **last** (among custom
directories the first same-named skill wins, so appending preserves every other
layer's precedence); if that read fails, no overlay is written at all.

Two further constraints from `omp`'s discovery rules that shape the design:

- **`description` is mandatory** for custom-directory skills
  (`scanSkillsFromDir(..., { requireDescription: true })`, `omp://skills.md`):
  a skill without one is silently dropped.
- **Scanning is non-recursive** — exactly `<dir>/<name>/SKILL.md`.

### 2.3 Cloud and local state

`projects` (`supabase/migrations/20260821090000_team_cloud_schema.sql:22-34`) has
explicit columns only — no `json`/`jsonb` anywhere in the schema — and
`conventions text` is its single free-form prose column. Project config is
owner-only (`20260821090200_team_cloud_rls.sql:50-53`,
`projects_update_owner`); tasks are member-writable (`:98-101`). Membership is
tested by `public.is_project_member(project_id, user_id)`
(`20260821090100_team_cloud_functions.sql:88-98`). Only `tasks` is in the
Realtime publication (`…090000…:69`); `projects` is not, so project-level config
propagates to other members on their next `load()`, not live.

Cloud→local mirroring is column-by-column through five layers: `packages/cloud`
mappers (`projects.ts:8-9` `PROJECT_COLUMNS`, `:83-95` `toProjectRow`) → UI store
→ `POST /projects/sync` → `supervisor.syncProjects` (`:158-181`) →
`registry.upsertProject` (`registry.service.ts:201-227`). Every new exported
symbol must also be added to `packages/cloud/src/index.ts` or Vite's CJS interop
yields `undefined`.

### 2.4 How a skill read looks in the transcript today

A skill is used by reading `skill://<name>` with the `read` tool. The reducer
already receives call arguments (`apps/api/src/supervisor/transcript-reducer.ts:57-67`,
`pendingToolEntry`), so the signal is present — but it is unusable as-is:
`readDisplay` (`packages/core/src/tool-display.ts:56-57`) sets
`target = shortPath(args.path)`, and `shortPath` (`:33-39`) splits off a `:from-to`
range before shortening, so it leaves the full `skill://opening-a-pr` URI as the
target: the row is indistinguishable from a file read and coalesces with reads
(`COALESCE_TOOLS` covers `read`), summing their counts (`:6-8`).

## 3. Design

### 3.1 Data model (cloud)

One new table. A skill is a row, not an element of a JSON blob, because bodies
are prose that several members edit repeatedly and a blob write would clobber a
concurrent edit and drag the whole payload through all five mirror layers.

```sql
create table public.project_skills (
  project_id  uuid not null references public.projects(id) on delete cascade,
  name        text not null check (name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  description text not null check (length(btrim(description)) > 0),
  body        text not null,
  enabled     boolean not null default true,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null,
  primary key (project_id, name)
);
```

- `name` is also a **directory name** on disk (§3.4), so the pattern check is a
  security constraint, not cosmetics; it is re-validated before `mkdir` in the
  same spirit as `carry-files.ts:12`.
- `description` is `not null` and non-blank because `omp` drops custom-directory
  skills that lack one (§2.2).
- RLS mirrors project config: `select` for members, all writes owner-only.

```sql
alter table public.project_skills enable row level security;
grant select, insert, update, delete on public.project_skills to authenticated;

create policy project_skills_select_member on public.project_skills for select
  using (exists (select 1 from public.projects p
                 where p.id = project_id
                   and (p.owner_id = auth.uid()
                        or public.is_project_member(p.id, auth.uid()))));

create policy project_skills_insert_owner on public.project_skills for insert
  with check (exists (select 1 from public.projects p
                      where p.id = project_id and p.owner_id = auth.uid()));

create policy project_skills_update_owner on public.project_skills for update
  using      (exists (select 1 from public.projects p
                      where p.id = project_id and p.owner_id = auth.uid()))
  with check (exists (select 1 from public.projects p
                      where p.id = project_id and p.owner_id = auth.uid()));

create policy project_skills_delete_owner on public.project_skills for delete
  using (exists (select 1 from public.projects p
                 where p.id = project_id and p.owner_id = auth.uid()));
```

`updated_at` / `updated_by` are server-owned by a `before insert or update`
trigger that sets `new.updated_at := now()` and `new.updated_by := auth.uid()`,
following the `tasks_guard` precedent (`…090100…:138`). The table is **not**
added to the Realtime publication: skills are read at launch, so live fan-out
would buy nothing.

### 3.2 Defaults shipped by Kermanych

Defaults live in `packages/core/src/skills.ts` as exported constants
(`DEFAULT_SKILLS: SkillDef[]`, where `SkillDef = { name, description, body }`),
**not** as `.md` asset files: `pnpm build:app` packages compiled JS, not
arbitrary asset directories, and the UI must render the same text without a
filesystem read. `DEFAULT_PR_CONVENTIONS` (`supervisor.service.ts:64-69`) is the
existing precedent for harness-owned prose as a constant.

The initial set is two skills, both describing things **no repository can know**
— Kermanych's own instrumentation:

1. `kermanych-session` — how a session's environment works: it runs on a
   dedicated branch in a git worktree under `~/.kermanych/worktrees/<id>`, carry
   files (`.env`) were copied in and must not be committed, the operator merges
   through «Завершити», and the branch must not be switched from inside.
2. `kermanych-pull-request` — the PR discipline Kermanych's own button relies
   on: commit conventions, base-branch selection, and pushing before opening the
   PR.

Adding or editing a default is a content change to one constant file, not a code
change. Every default is overridable and disableable per project (§3.3).

### 3.3 Precedence, and the guard against overwriting the project

```
repository's own skills  (.omp/skills, .claude/skills, .agent[s]/skills,
                          .codex/skills, .github/skills)   ← always wins
project_skills           (authored in the Kermanych UI)
DEFAULT_SKILLS           (shipped by Kermanych)
```

Resolution, in order:

1. Start from `DEFAULT_SKILLS`.
2. Apply `project_skills` rows: a row with the same `name` **replaces** the
   default (description + body); a row with `enabled = false` **removes** it; a
   row with a new name **adds** it. Rows with `enabled = false` and no matching
   default are ignored.
3. Read the repository's skill names from the session cwd — the six directories
   listed above, one level deep (`<dir>/<name>/`), no ancestor walk, because the
   session cwd is always a repository root (§2.1). Any resolved skill whose name
   appears there is **not materialized** and is reported as
   `shadowedByRepo: <path>`.

Step 3 is the entire enforcement of "Kermanych does not overwrite the project's
rules", and §2.2's third probe is the regression it prevents. The exclusion is
surfaced in the UI (§3.6) with the winning file's path, so the override is never
silent in either direction.

### 3.4 Materialization and delivery

New `apps/api/src/skills/skills.service.ts`:

```ts
materialize(projectId: string, cwd: string): Promise<{ configPath?: string; view: SkillView[]; stale?: boolean }>
```

`configPath` is optional because a launch must never be blocked by the library:
it is set only once the overlay write succeeded, and `stale` means "what is on
disk may not reflect the cloud" (a failed cloud read, a failed repo scan, an
unreadable `skills.customDirectories`, or a filesystem failure).

- Resolves the set (§3.3), re-validating each `name` against
  `/^[a-z0-9][a-z0-9-]{0,63}$/` before touching the filesystem.
- Writes `~/.kermanych/skills/<projectId>/<name>/SKILL.md`: YAML frontmatter
  with `name` and `description`, then the body. Directories for names no longer
  in the set are **pruned**, so a deleted or repo-shadowed skill disappears from
  the next session instead of lingering.
- Writes the overlay as a **sibling** file,
  `~/.kermanych/skills/<projectId>.config.yml`, never inside the scanned
  directory:

  ```yaml
  skills:
    customDirectories:
      - "/Users/<user>/some/dir/a lower layer already declared"
      - "/Users/<user>/.kermanych/skills/<projectId>"
  ```

  Every path is emitted as a **quoted** scalar (`JSON.stringify`, valid YAML —
  the same technique `renderSkillFile` uses for descriptions): the paths derive
  from `homedir()`, which Kermanych does not control, and in a plain scalar a
  ` #` opens a comment and a `: ` a mapping. A malformed overlay is a hard `omp`
  startup error, the one outcome "never block a launch" forbids. The list is the
  union with the effective lower-layer value (§2.2), Kermanych's directory last.

- Returns `view` — one entry per resolved skill with
  `{ name, description, source: "default" | "project", shadowedByRepo?: string }`
  — which is both the UI's list (§3.6) and the source badge in the transcript
  (§3.5).
- **Offline:** if the cloud read fails, nothing is pruned and the previously
  materialized directory is reused (it *is* the offline cache; no SQLite mirror is
  added), with only names *missing* from disk written, so a richer cached library is
  never demoted. When there is **no** existing directory — a fresh install, a
  signed-out or offline first launch, or a machine before the `project_skills`
  migration — `DEFAULT_SKILLS` are still written: they are compile-time constants
  needing neither network nor sign-in, and suppressing them would hand `omp` an
  empty directory. Either way the session launches with `--config` and `stale: true`.

`RpcSession` gains one option, `configPath?: string`, appended as
`--config <path>` after `--cwd` (`rpc-session.ts:47-53`). The supervisor calls
`materialize` before each of its five `new RpcSession(...)` sites through one
private helper, so chat, agent, discussion, review and resume all see the same
library; the repo scan uses that session's own cwd.

### 3.5 Visibility in the chat

- **Recognition.** In `pendingToolEntry`
  (`transcript-reducer.ts:57-67`), a `read` whose `args.path` starts with
  `skill://` becomes `tool: "skill"` with `target` = the skill name, and a
  sub-resource read (`skill://x/refs/y.md`) keeps the sub-path on the target
  (`x/refs/y.md`) because that is the skill's identity. Renaming the tool is what
  lifts the row out of `read` coalescing and gives it its own renderer; no new
  `TranscriptEntry` kind is needed.
- **Rendering.** `packages/core/src/tool-display.ts` gains `REDUCERS.skill`
  (`:251-254`): the name passes through verbatim — never through `shortPath`,
  which mangles the scheme (§2.4) — and the read content becomes the preview
  lines.
- **Source badge, visible collapsed.** `KToolRow.vue` renders `tool`, `target`
  and `stat` on the collapsed row (`:5-8`) but shows `intent` only once the row
  is expanded (`:19`). The badge therefore rides in **`stat`** — «бібліотека»
  for a default, «проєкт» for a project row — so the answer to "which skill, from
  where" is readable without a click. `intent` carries the longer detail for the
  expanded row: the absolute path of the `SKILL.md` actually read. Both are
  supplied by the supervisor from the `view` of §3.4 through arguments
  `pendingToolEntry` already accepts, so no event shape changes.
- **Session summary.** A `Скіли` row joins the session meta list in the «Сесія»
  tab (`apps/ui/src/pages/WorkspacePage.vue:144-181`, alongside Модель / Гілка /
  Контекст): the unique skills used, in order of first use, derived in the UI
  from the transcript entries. No new component and no new server state.
- **Documented blind spots** (the `Скіли` row's title hint):
  a skill read by a **subagent** is invisible, because Kermanych never sends
  `set_subagent_subscription` and therefore receives no subagent frames; a model
  that acts on a description without opening the file produces no signal at all.
  The chat shows *actual* use, not intent. Consequently the library forbids
  `alwaysApply` / `globs` frontmatter, which would apply a skill without any
  read.

### 3.6 UI

A new project-scoped section in the Менеджмент tab
(`apps/ui/src/lib/management.ts:19-27`), not another block in the project
settings modal (`MainLayout.vue:184-296`), which is already at its limit:

- A list of resolved skills: name, description, source badge (`дефолт` /
  `проєкт` / `перекрито репо` with the winning path), and an enable switch.
- An editor: `name` (immutable after creation, validated against the same
  pattern as the DB), `description` (single line, **required** — the UI states
  that `omp` ignores a skill without one), `body` (multiline Markdown).
- Writes are owner-only, disabled for members exactly as the settings modal
  already does via `isOwner(id)`; RLS is the actual gate.
- `packages/cloud/src/skills.ts` provides `listProjectSkills(client, projectIds)`
  (batched `project_id=in.(…)`, following `tasks.ts:66-78`),
  `upsertProjectSkill`, `deleteProjectSkill`, plus `ProjectSkill` /
  `ProjectSkillInsert` types — all re-exported from
  `packages/cloud/src/index.ts`.

## 4. Isolation / boundaries

- **`packages/core`** — pure data and display: `SkillDef`, `DEFAULT_SKILLS`, the
  `skill://` reduction in `pendingToolEntry`, `REDUCERS.skill`. No I/O, no cloud
  knowledge.
- **`packages/cloud`** — the `project_skills` table's typed surface only; knows
  nothing about files or `omp`.
- **`SkillsService` (api)** — the only component that touches the filesystem or
  decides precedence; returns a `view` and a config path, owns nothing else.
- **`RpcSession`** — one more argv flag; still knows nothing about skills.
- **`SupervisorService`** — calls the materializer before each spawn and passes
  the source labels into the transcript; no resolution logic of its own.
- **`RegistryService` / SQLite** — untouched. The materialized directory is the
  offline cache.
- **UI** — one Менеджмент section plus one transcript row type; no new store.

## 5. Verification

**Unit (`packages/core`, vitest):**

- `pendingToolEntry` maps a `read` of `skill://opening-a-pr` to
  `tool: "skill"`, `target: "opening-a-pr"`; a sub-resource read keeps the
  sub-path on the target; an ordinary file read is unchanged.
- `toolDisplay("skill", …)` returns the full name (guards the `shortPath`
  mangling of §2.4).

**Unit (`apps/api`, vitest, temp dirs):**

- Resolution: a project row overrides a same-named default; `enabled: false`
  removes a default; a new name is added.
- Shadow guard: a `<name>` directory in each of the six repo skill locations
  excludes that skill from materialization and reports `shadowedByRepo`.
- Pruning: a skill removed from the set has its directory deleted on the next
  materialize.
- Name validation: `../evil`, absolute paths and uppercase are rejected before
  any `mkdir`.
- Overlay: exact YAML content and the sibling path.
- Offline: a failing cloud read keeps the existing directory (nothing pruned,
  nothing demoted) and still returns a config path; with **no** existing
  directory it writes `DEFAULT_SKILLS` — which need no cloud — and still returns
  a config path, so a fresh, signed-out or offline machine never launches against
  an empty directory.
- Lower config layers: an unreadable effective `skills.customDirectories` writes
  no overlay at all (`configPath` absent, `stale: true`) rather than one that
  would replace it; a readable one is extended, Kermanych's directory last.
- Transcript labels: a skill read routed through the supervisor yields a row with
  `stat` = «бібліотека» for a default and «проєкт» for a project row, and
  `intent` = the absolute path of the materialized `SKILL.md`.

**Integration (`apps/api`, real `omp` child; skipped unless
`KERMANYCH_E2E_OMP=1`, following `packages/cloud`'s env-gated suite):**

- Materialize two skills, spawn `RpcSession` with the overlay, send `get_state`,
  assert both descriptions appear in `systemPrompt`.
- Add a repo skill with the same name as a library skill; assert the description
  in `systemPrompt` is the repository's. This is the test that would have caught
  the silent override of §2.2.
- Point a **lower** config layer (`<cwd>/.omp/config.yml`) at a second skills
  directory, materialize, spawn with the overlay; assert BOTH that directory's
  skill and a library skill appear in `systemPrompt`. This is the test that would
  have caught the wholesale array replacement of §2.2.

**Manual smoke (`pnpm dev:app`):** author a skill in Менеджмент → launch a
session whose task matches its description → the agent reads it → the collapsed
transcript row reads `skill  <name>  <джерело>`, and the «Сесія» tab's `Скіли`
row lists it.

## 6. Non-goals

- **Roles / launch profiles.** Generalizing the four hard-coded prompt templates
  and `projects.conventions` into an editable registry (prompt + toolset + model
  + isolation) is explicitly out of scope; those code paths stay as they are.
- **Generating skill files inside the target repository.** Kermanych never writes
  to `.claude/skills` or `.omp/skills` of the project.
- **Subagent skill visibility.** `set_subagent_subscription` stays off; enabling
  it is a separate decision with its own event-volume cost.
- **`alwaysApply` / `globs` skills** in the library — they would bypass the
  read that makes use observable.
- **Deterministic invocation.** Whether the model takes a skill remains the
  model's decision; the only lever here is `description` quality. A guaranteed
  procedure needs a Kermanych button or a CI check, neither of which this design
  adds.
- **Realtime propagation** of skill edits, and any per-session skill pinning
  (`omp` exposes no such override).
