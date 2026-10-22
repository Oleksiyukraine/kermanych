# «ШІ-команда → Навички»: import a skill from disk, show the repository's own

- **Date:** 2026-10-22
- **Scope:** `packages/core` (types, name normalisation), `apps/api` (local skill scan and
  read, `/fs/list` hidden mode, the project skills payload), `apps/ui` (import picker,
  `KDirPicker` skills mode, the library pane, `SkillSequence`, i18n), `kermanych/README.md`.
- **Builds on:** `docs/superpowers/specs/2026-08-27-project-skills-design.md` (library,
  repository shadow), `docs/superpowers/specs/2026-08-28-ai-team-agents-design.md`
  (assignments resolve by name).
- **Mode:** «Глибокий аналіз». Decisions settled with the operator on 2026-10-22.

## Goal

Developers already keep skills outside Kermanych: in the repository and in their own
home-directory skill folders. Today the «Навички» pane only offers to type a skill from scratch.
The operator asked for a way to pick such a skill in Kermanych, in the way a file picker works.

## Context (as-is)

- **Library rows** (`ai_skills`) hold `name`, `description`, `body` per owner (user, project,
  workspace). Precedence at launch: repository skills > user > project > workspace >
  `DEFAULT_SKILLS` (`apps/api/src/skills/skills.service.ts`).
- **Repository skills**: `repoSkillNames` scans six fixed directories (`.omp/skills`,
  `.claude/skills`, `.agent/skills`, `.agents/skills`, `.codex/skills`, `.github/skills`), one
  level deep. `GET /projects/:id/skills` returns them as `repo: Record<name, path>`. The pane
  ignores that half (`SkillsLibraryPanel.vue` `load()`), and `SkillSequence.vue` (`left`) offers
  only library names. So a repository-only skill is resolvable when assigned
  (`assignedForNames` reads the file) but cannot be seen or picked.
- **Home-directory skills** (`~/.omp/agent/skills`, `~/.claude/skills`, `~/.agents/skills`,
  `~/.codex/skills`): Kermanych does not scan them. If one of these names is assigned, it
  resolves to `missing`. A teammate's machine does not have the file at all.
- **Skill locations differ by runtime:**

  | Source | managed omp | managed claude-code | native session |
  | --- | --- | --- | --- |
  | 6 repository directories | discovers all six | only `.claude/skills` (SDK, no `settingSources`) | the harness's own |
  | home directories | discovers them | only `~/.claude/skills` and plugins | the harness's own |
  | Kermanych library, model's choice | yes, `--config` overlay | **no** (`configPaths` is omp-only) | no |
  | assigned to an agent / trigger | inline in the prompt | inline in the prompt | no |

  Assignment is the only path that works the same on both managed runtimes.
- **Real skills carry files.** `~/.agents/skills/humanizer` has `scripts/`, `README.md`,
  `agents/openai.yaml`. Claude's `pdf` has `FORMS.md`, `REFERENCE.md`, `scripts/`. Their
  descriptions are often YAML block scalars (`description: |`), and `readRepoSkill`'s one-line
  regex reads those as empty.
- **The existing picker** `KDirPicker` → `GET /fs/list` is a server-side browser. It works in
  Electron and in a plain browser (`quasar dev`) and hides dot-directories
  (`fs.controller.ts:22`). The preload exposes no native open-file dialog.

## Decisions

1. **Import by copy.** The picked skill's `SKILL.md` fills the pane's existing editor (name,
   description, body). «Зберегти» creates a row at the owner on screen. That row is a snapshot:
   it syncs through the cloud, works for teammates, and is delivered on both runtimes when
   assigned. *Rejected:* referencing files without copying them. A home-directory skill assigned
   at project scope would break for every teammate. *Rejected:* both modes, which brings the
   same footgun back.

2. **Skills in the six repository directories are read-only and assignable. They are not
   imported.** At project scope only, because only a project has a checkout:
   - the library pane gets a «З репозиторію» block that lists every repository skill not
     already shown as a shadowed own row, with its name, description and path, and no edit
     controls. A repository skill that shadows a Kermanych default says so;
   - `SkillSequence` (agents and prompt triggers) offers repository-only names next to library
     names, badged «репо». When assigned, such a name reaches omp and claude-code inline, so a
     `.agents/skills/x` skill that claude-code would never discover reaches it this way.

   *Why not import them:* a copy under a name the repository owns is always shadowed and never
   delivered (decision 6.4). A repository skill outside the six directories (for example
   `docs/skills/x`) is visible to neither omp nor Kermanych, so for that one, import through
   «Інша тека…» is the right tool.
   - The scan is the bound checkout (`localRepoPath`), as it is today. A session on a branch that
     lacks the file reports the name as `missing`, which is existing behaviour.

3. **The picker lists the four standard home roots, one level deep:** `~/.omp/agent/skills`,
   `~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills`, plus «Інша тека…». A root that does
   not exist is skipped silently; an unreadable root shows its error. *Rejected:* Claude.ai
   synced skills (`~/.claude/skills/synced/<bucket>/…`) and the Claude plugin cache (134
   `SKILL.md` on the operator's machine, versioned per plugin). Other tools manage and update
   them, so a copy goes stale with the next update. They stay reachable through «Інша тека…».
   *Rejected:* no list at all, because the common case would then need manual navigation into a
   hidden folder.

4. **«Інша тека…» is `KDirPicker` in a skills mode.** In this mode it shows dot-directories and
   marks folders that contain `SKILL.md`. «Обрати цю теку» on a folder with `SKILL.md` picks that
   skill. On a skills root (`*/SKILL.md` one level down) it lists the skills found there, in the
   same list as the standard roots. On a folder with neither it shows «Тут немає навичок»
   (no SKILL.md here). The local API reads the files, so it also sees the skill's other files.
   *Rejected:* an Electron-only native dialog, which does not work in the browser build. Also
   *rejected:* `<input type="file">`, which cannot see sibling files, and macOS hides
   dot-folders in it.

5. **Only the text of `SKILL.md` is copied, with a warning about the other files.** The picker
   row and the editor list the skill's other files (relative paths, at most 20 shown plus
   «і ще N»). The note says they are not copied and that references to them in the text will
   not work. Import is still allowed. *Rejected:* refusing such skills (most real skills have
   files); appending `.md` files to the body (bloat, rewriting the author's skill); storing files
   in Supabase Storage (a separate feature, and assigned and claude-code delivery is text only
   anyway).

6. **Names: suggest, refuse damage, warn about overrides.** The name comes from frontmatter
   `name`, else the folder name.
   1. If the name does not match `SKILL_NAME_RE`, the editor is pre-filled with
      `normaliseSkillName(raw)`: lowercase, every run of characters outside `[a-z0-9-]` becomes
      `-`, leading/trailing `-` trimmed, cut to 64. The operator can edit it.
   2. **This owner already has the name** (`storedRows`): «Зберегти» is refused with «Навичка
      `x` уже є в бібліотеці — оберіть іншу назву або відредагуйте наявну». The row is never
      overwritten. The picker row is marked «уже є» and stays selectable, so the operator can
      import under another name.
   3. **The name is a Kermanych default** (`DEFAULT_SKILLS`), or, at project scope, a skill of
      the project's workspace: saving is allowed, with a warning that it overrides that skill,
      which is how overrides work.
   4. **Project scope, and the name is a repository skill** (`repo` map): «Зберегти» is refused
      with «Цю назву займає навичка з репозиторію — копія ніколи не потрапить в сесію; оберіть
      іншу назву».
   *Rejected:* allowing overwrite after a confirm. Re-importing a newer version is rare and is
   covered by «Редагувати» plus paste. *Rejected:* no checks.

   The same refusal (6.2) does not apply to the pane's plain «Додати». That flow overwrites
   silently today, which is reported separately as a finding and is out of this scope.

7. **No provenance is stored.** An imported row is indistinguishable from a hand-written one,
   and the schema does not change. A source path means something only on the importer's machine.
   *Rejected:* an `imported_from` column, and a «Оновити з джерела» button that works on one
   machine only.

8. **Import is available at every owner scope** (власні / проєкт / воркспейс) under the pane's
   existing `canWrite`. The picker reads this machine's disk, and that does not depend on the
   owner. Checks 6.3 (workspace part) and 6.4 apply at project scope only.

9. **Frontmatter is parsed as YAML.** `js-yaml` (4.3.1, already in the lockfile transitively,
   loaded with `JSON_SCHEMA`) becomes a direct `apps/api` dependency. The parsed `description`
   has its whitespace collapsed to single spaces, because the description is a one-line label in
   omp's skill list and in the UI. A file whose frontmatter does not parse is listed with an
   empty description and a «frontmatter не розібрано» note, and the editor still opens. The body
   is everything after the closing `---`, as is. The repository block (decision 2) uses the same
   parser, so a block-scalar description shows there too. The launch path's `readRepoSkill`
   stays as it is.

10. **Nothing changes for delivery.** An imported skill behaves like any library row: omp gets it
    through the overlay at the model's choice, and claude-code gets it only when assigned. The
    picker's footnote says this in one line, so nobody expects «імпортував — і claude його
    бачить».

## Changes

- **core**
  - `skills.ts`: `normaliseSkillName(raw: string): string`; types `SkillImportCandidate =
    { name, suggestedName, description, dir, bytes, extraFiles: string[], extraCount: number,
    frontmatterError?: true }` and `SkillImportRead = SkillImportCandidate & { body }`;
    `RepoSkill = { path, description }`.
  - `ProjectSkillsPayload.repo` becomes `Record<string, RepoSkill>`. This is a clean cutover:
    `SkillSequence`, `AiAgentsPanel`, `TriggersPanel`, `assignments` helpers and their tests read
    `.path`.
  - `DirEntry` gains `hasSkill?: boolean`.
- **api**
  - `skills/skill-files.ts` (new): `parseSkillFile(text)` (frontmatter via `js-yaml`, body),
    `scanSkillRoot(dir)` (one level, follows symlinks like `repoSkillNames`, skips entries
    without a `SKILL.md` file), `skillCandidate(dir)` (reads `SKILL.md`, lists other files
    recursively, skipping `.git`, capped).
  - `http/skill-import.controller.ts` (new, `@Controller("skills/import")`, behind the global
    auth guard):
    - `GET /skills/import/roots`: the four home roots, each `{ label: "~/.agents/skills", path,
      skills: SkillImportCandidate[], error? }`;
    - `GET /skills/import/scan?path=`: one folder, either itself a skill or a skills root;
    - `GET /skills/import/read?dir=`: `SkillImportRead` for a folder that contains a `SKILL.md`.
      It reads nothing else. The other files are listed by name only.
  - `fs.controller.ts`: `?hidden=1` keeps dot-directories; each entry gets `hasSkill` when that
    query is set.
  - `SkillsService.view()` fills `repo` with `{ path, description }` through `parseSkillFile`.
- **ui**
  - `components/settings/SkillImportPicker.vue` (new modal, one `SkillImportRow.vue` per skill): the roots and their skills
    (name, description, size, «N файлів не скопіюються», «уже є»), «Інша тека…» →
    `KDirPicker` skills mode → scan result in the same list, the delivery footnote. A pick reads
    the skill and hands `{ name: suggestedName, description, body, extraFiles }` to the pane.
  - `KDirPicker.vue`: `skills?: boolean` prop → `api.listDirs(path, { hidden: true })`, a
    `SKILL.md` mark, and the empty-folder message on choose.
  - `SkillsLibraryPanel.vue`: an «Імпортувати з диска…» button next to «Додати». The editor is
    opened pre-filled, shows the extra-files note, and runs checks 6.2–6.4 through a pure
    `importNameProblem(name, { scope, stored, workspace, repo })` in `lib/ai-team.ts`. The
    «З репозиторію» block appears at project scope.
  - `SkillSequence.vue`: the picker's options come from `sequenceCandidates(view, repo, names)`
    (`lib/settings.ts`): library names first, then repository-only names labelled «репо».
  - i18n keys (uk/en) for every new string; the i18n completeness suite covers them.
- **docs**: `kermanych/README.md` gets a short `### Skills («ШІ-команда → Навички»)` section
  before «Project documentation»: where skills come from, import and its limits (snapshot, files
  not copied), the repository block, and the runtime table above in brief.

No migration and no cloud changes.

## Verification

- **api** (`--maxWorkers=4` equivalent, one run at a time):
  - a new `skill-import.spec.ts` over temp dirs. Covered: a root lists only `*/SKILL.md`
    folders (a symlinked one included, an asset-only one excluded); a block-scalar description
    is collapsed; a broken frontmatter is flagged rather than thrown; `suggestedName`
    normalises; other files are listed relative and capped with a count; a folder that is
    itself a skill vs a root vs neither; `read` refuses a folder without `SKILL.md`;
  - `fs` listing with `hidden=1` shows dot-directories and `hasSkill`;
  - `skills.endpoint.spec.ts` updated for `repo` entries carrying a description.
- **ui**: `importNameProblem` covers each case in 6.1–6.4 and the scope gates in 8.
  `SkillSequence` offers a repository-only name and does not offer it once it is assigned.
  `assignments.spec.ts` is updated for the new `repo` shape.
- **Smoke** (preview api + `quasar dev`, signed in):
  1. At «власні», import `humanizer` from `~/.agents/skills`. The picker shows its description
     and the warning about files that are not copied. The editor is pre-filled. Save. The row
     appears in the list.
  2. Import it again. The picker shows «уже є», and saving under the same name is refused.
  3. At project scope with a checkout that has `.agents/skills/x`: the «З репозиторію» block lists
     `x`. Assign `x` to «Ревізор». It shows the «репо» badge. A claude-code review session's
     first prompt contains `x`'s body.
  4. «Інша тека…» → `~/.claude/skills/synced/<bucket>` lists `pdf`, `docx`, …
- **Typecheck**: `apps/api`, `apps/ui`.

### Results (2026-10-22)

- `@kermanych/core` 217 passed. `@kermanych/api` `tsc --noEmit` is clean, and the suite gives
  1020 passed and 4 skipped (`skill-import.spec.ts` adds 7). `@kermanych/ui` 681 passed;
  `vue-tsc` shows only errors that predate this change: `test/runtime-messages.spec.ts` TS2352,
  and `src-electron` cannot resolve `@kermanych/api` when the api is not built.
- Smoke used a preview api (`KERMANYCH_PREVIEW=1`, temp DB) and `quasar dev` against the real
  home directory:
  - `GET /skills/import/roots` listed `dev-report` (`~/.claude/skills`, 1 other file), and
    `find-skills` plus `humanizer` (`~/.agents/skills`, 8 other files, the block-scalar
    description collapsed). `~/.codex/skills` came back empty. The absent `~/.omp/agent/skills`
    was left out.
  - `scan` on `~/.claude/skills/synced/<bucket>` listed `docs`, `docx`, `pdf`, `xlsx` and the
    rest. `read` on `$HOME` answered 400 «no SKILL.md».
  - UI at «Користувач»: the picker showed both roots. «Інша тека…» browsed into `.agents/skills`,
    where both folders were marked `SKILL.md`, and choosing that folder listed its two skills.
    Picking `humanizer` opened the editor with its name, description and body filled in and
    listed the files that are not copied. Renaming it `task-spec` showed the default-override
    warning.
  - What the preview could not do: it has no cloud, so the library read fails («invalid input
    syntax for type uuid»). Saving, the «уже є» / `exists` refusal and the project-scope
    «З репозиторію» block (which needs `GET /projects/:id/skills`, and that endpoint reads the
    cloud) were not exercised live. They are covered by `importNameProblem`, `sequenceCandidates`
    and the `view()` repo-description test.

## Documentation impact

`kermanych/README.md`: the new «Skills» section described under Changes. No migration and no
endpoint docs beyond the README.
