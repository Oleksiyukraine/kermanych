# Kermanych — Project Documentation Preview (Design)

- **Status:** Draft for review
- **Date:** 2026-09-08
- **Scope:** `supabase/migrations` (one new column), `packages/cloud`
  (`projects` mappers + `CloudProject` type), `packages/core`
  (`Project` type; reuse `isDocPath`; promote the `management-docs` section),
  `apps/api` (three project-scoped doc routes on `ProjectsController`,
  `SupervisorService` methods, reuse `WorktreeService` readers, registry column
  + migration), `apps/ui` (a docs-tuned markdown renderer, a Settings
  folder-list editor, the `management-docs` screen + a read-only store, i18n)

## 1. Purpose

Give every Kermanych project a **documentation preview** driven from one or more
folders inside its own git repository. The operator selects the folders once (a
project-level, team-shared setting); Kermanych then renders a **faithful,
GitHub-style preview** of the real files in those folders — markdown formatted,
code highlighted, images shown inline — **never an AI summary or a reinterpreted
version**. The preview reflects exactly what is checked out locally and refreshes
when the repository is pulled.

Two levels, one screen:

1. **Project level** — the selected folders of one project, rendered as a
   browsable tree + preview.
2. **Workspace level** — every project in the workspace gathered in the same
   screen, so a member reads the whole product's documentation from one place.

The folder *selection* is shared across the team (it lives in the cloud project
row); the *content* is read from each developer's own local checkout and is
never uploaded (design decision **A**, §3.6). Nothing here adds an AI surface:
the `management-docs` section stays out of the assistant's write reach.

## 2. Current state (as-is)

### 2.1 A project is a repo bound per-machine; there is no auto-clone

A project's config lives as discrete typed columns on the cloud `projects` table
(`supabase/migrations/20260821090000_team_cloud_schema.sql`), mirrored into a
per-machine SQLite registry that adds the one local-only column,
`local_repo_path` (`apps/api/src/registry/registry.service.ts`,
`projects` DDL and `upsertProject`/`patchProject`/`listProjects`). `git_remote_url`
is informational — Kermanych **never clones**; each developer binds their own
checkout via `PUT /projects/:id/binding` (`ProjectsController.bind` →
`SupervisorService.bindProject`, "path must already be a git repo"). Documentation
therefore exists only inside a bound `localRepoPath` on a given machine.

Cloud→local mirroring is column-by-column: `packages/cloud/src/projects.ts`
(`PROJECT_COLUMNS`, `ProjectRow`, `toCloudProject`/`toProjectRow`) → UI store →
`POST /projects/sync` → `SupervisorService.syncProjects` →
`registry.upsertProject` (which preserves an existing `local_repo_path` when the
cloud sends `''`). Every new exported symbol must also be added to
`packages/cloud/src/index.ts` or Vite's CJS interop yields `undefined`.
`carry_files text[]` is the existing precedent for a string-array project column
threaded through all these layers.

### 2.2 Pull already re-reads the working tree

`POST /projects/:id/pull` (`ProjectsController.pull` →
`SupervisorService.projectPull` → `WorktreeService.pull`,
`worktree.service.ts:342`) runs `git pull --ff-only` on `localRepoPath` and is
wired to the footer button in `apps/ui/src/layouts/MainLayout.vue` (`gitPull`,
`api.pullProject`). After it succeeds, the working tree on disk is current, so a
docs re-read needs no filesystem watcher.

### 2.3 Path-guarded file readers already exist, but only session-scoped

`WorktreeService.listTree(dir, rel)` (`worktree.service.ts:270-280`) and
`readFileContent(dir, rel)` (`:286-300`) read one tree level / one file relative
to any directory. Both reject absolute paths and `..` escapes, hide `.git`, and
report `binary`/`truncated` flags (`FileContent` from `@kermanych/core`). They
are exposed today only through session/worktree endpoints (`api.sessionTree` /
`api.sessionFile`); there is **no** project-scoped tree/file route. The New-Project
directory picker (`apps/api/src/http/fs.controller.ts`, `GET /fs/list`) already
browses the real filesystem and flags git repos.

### 2.4 The documentation taxonomy is already defined

`packages/core/src/docs.ts` `isDocPath` (`:18-26`) classifies a path as
documentation by extension (`md|mdx|mdc|markdown|rst|adoc|asciidoc`,
`DOC_EXT_RE`), conventional name (`README|CHANGELOG|CONTRIBUTING|LICENSE|…`,
`DOC_NAME_RE`), or membership under a `docs/`/`doc/` directory (`DOC_DIR_RE`).
This is the project's single source of truth for "what is a doc file" and is
reused here rather than duplicated.

### 2.5 The screen is reserved but unbuilt

`packages/core/src/management.ts` (`MANAGEMENT_SECTIONS`, `:92-99`) already
declares the `management-docs` section: `label: "Project Documentation"`, path
`project-documentation`, `hint: "специфікації й рішення"`, and today
`capability: "none"` with `limitation: NOT_BUILT` ("розділ ще не реалізований —
за ним немає ні екрана, ні сховища даних"). The comment above it states its
subject exactly: the artifacts a project is *built from* — "specs, decisions,
the reasoning a new member reads first." The Management surface is
**workspace-scoped**: `ManagementPage.vue` renders a section only once a
workspace is selected and hands it that workspace's id/name; selecting a project
in the sidebar selects its workspace too. Sections without a screen fall back to
`ManagementSectionPage.vue`; a real screen is registered in the `SECTION_PAGES`
map in `apps/ui/src/router/routes.ts`.

### 2.6 Markdown rendering today is chat-tuned

`apps/ui/src/lib/markdown.ts` exports one shared `renderMarkdown(src)` backed by
a single `markdown-it` instance configured `html: false` (raw HTML is escaped, so
`v-html` output is a controlled tag set), `linkify: true`, **`breaks: true`**,
`typographer: false`, and **no fenced-code highlighting**. `breaks: true` and the
missing highlighter are deliberate chat-reading choices, not doc-fidelity ones.
Code files elsewhere render with `highlight.js` (`highlightAuto`, `github-dark`
theme) in `apps/ui/src/components/kit/KFileView.vue`, which also handles the
`binary`/`truncated` `FileContent` flags. Rendered markdown lands in a
`.k-log__markdown` container (e.g. `ManagementReleasesPage.vue`).

## 3. Design

### 3.1 Data model (the folder selection)

One new column on the cloud `projects` table:

```sql
alter table public.projects
  add column doc_folders text[] not null default '{}';
```

- Values are **repo-relative POSIX paths** to directories inside the project's
  own repository (e.g. `{'docs','packages/core/docs'}`). The empty array means
  "no documentation configured". Multiple entries are the multi-folder selection
  the feature requires.
- Column-only, mirroring the schema's no-JSON convention (`carry_files` is the
  direct precedent). RLS is unchanged — `doc_folders` is ordinary project config,
  covered by the existing project-update policy.
- **Not** added to the Realtime publication: like other project config it
  propagates on a member's next project load, which is sufficient — a folder
  selection changes rarely.

Threaded through every mirror layer exactly as `carry_files` is:

- `packages/cloud/src/projects.ts`: add `doc_folders` to `PROJECT_COLUMNS`,
  `ProjectRow`, `toProjectRow`/`toCloudProject`, `CloudProjectPatch`,
  `CloudProjectInsert`.
- `packages/cloud/src/types.ts`: `CloudProject.docFolders: string[]`.
- `packages/cloud/src/index.ts`: no new symbol unless a helper is added; verify
  the type re-export.
- `packages/core/src/types.ts`: `Project.docFolders?: string[]`.
- `apps/api/src/registry/registry.service.ts`: add a `doc_folders TEXT NOT NULL
  DEFAULT '[]'` column via an idempotent `ALTER TABLE projects ADD COLUMN` in the
  migration block (the exact pattern `carry_files` uses at
  `registry.service.ts:112`), encoding the array as **JSON text** —
  `JSON.stringify` on write in `upsertProject`/`patchProject`, `JSON.parse` on
  read in `listProjects` (mirroring `carryFiles` at `:250`, `:279`, `:291`).
  `syncProjects` copies it down and must not clobber it with an empty value on a
  partial cloud row, mirroring the `local_repo_path` guard.

### 3.2 API — three project-scoped, path-guarded routes

New routes on `apps/api/src/http/projects.controller.ts`, each delegating to a
new `SupervisorService` method that resolves the bound project and validates the
folder before touching disk:

- `GET /projects/:id/docs/tree?folder=<rel>&path=<rel>` → `TreeEntry[]`, one
  level. `path` defaults to `""` (the folder root).
- `GET /projects/:id/docs/file?folder=<rel>&path=<rel>` → `FileContent`
  (text/markdown/code; `binary`/`truncated` flags as-is).
- `GET /projects/:id/docs/raw?folder=<rel>&path=<rel>` → the raw bytes with a
  `Content-Type` derived from the extension, for `<img>` sources and binary
  downloads.

`SupervisorService` gains `docsTree` / `docsFile` / `docsRaw`, each of which:

1. Resolves `boundProject(id)`; if `localRepoPath` is unset, throws a coded error
   the controller maps to **`409 needsBinding`** (`coded-error.ts` precedent).
2. Asserts `folder` is a member of the project's `docFolders` (exact string
   match) and is itself free of `..`/absolute segments; otherwise **`400`**. This
   is the authorization boundary — a client may only read inside a folder the
   project actually published.
3. Computes `dir = join(localRepoPath, folder)` and calls the existing
   `WorktreeService.listTree(dir, path)` / `readFileContent(dir, path)`, whose
   guards reject any `..`/absolute `path`. `docsRaw` adds a small reader that
   streams bytes under the same guard (a private `readFileBytes(dir, rel)` on
   `WorktreeService` reusing the identical `rel` validation, so raw reads are
   guarded the same way as text reads).
4. If `dir` does not exist in this checkout (a configured folder absent from the
   current branch), `docsTree` returns an empty listing and the UI shows a
   per-folder notice (§3.5); it is not an error.

No new git operations; no clone; nothing is written.

### 3.3 A docs-tuned markdown renderer (fidelity)

`apps/ui/src/lib/markdown.ts` gains a second exported renderer,
`renderDoc(src, { resolveHref, resolveImg })`, backed by its own `markdown-it`
instance so the chat renderer is untouched. It differs from `renderMarkdown` only
where GitHub fidelity requires:

- `html: false` (keep the embedded-HTML-escaping safety), `linkify: true`,
  **`breaks: false`** (GitHub does not turn single newlines into `<br>`),
  `typographer: false`.
- **Fenced code blocks are syntax-highlighted** via a `highlight` option wired to
  the `highlight.js` instance already bundled for `KFileView`, matching the code
  theme used elsewhere.
- **Relative links are rewritten** by overriding the `image` and `link_open`
  renderer rules: a relative `src`/`href` (not `http(s):`, not `//`, not a bare
  `#anchor`) is resolved against the file's own folder/path and rewritten —
  images to the `docs/raw` endpoint, `.md`-family links to an in-app navigation
  target that opens that file in the tree, other relative links left as a
  resolved repo-relative path. Absolute and anchor links pass through unchanged.

This renderer is a pure function of `(src, current folder+path)`; the resolver
closures are provided by the store (§3.5) so the URL shape stays in one place.

### 3.4 Settings — the folder-list editor

`apps/ui/src/pages/SettingsPage.vue`, in the project scope, gains a
**"Documentation folders"** editor modeled on the existing `carryFiles: string[]`
list control: add / remove repo-relative folder paths. Adding opens a picker that
reuses `GET /fs/list` **rooted at the bound `localRepoPath`**, storing only the
path relative to the repo root; manual text entry is allowed (and is the only
option when the repo is not yet bound locally). Saving goes through the existing
`api.patchProject({ docFolders })` → cloud `CloudProjectPatch` → `syncProjects`
mirror, identical to how `conventions`/`carryFiles` already save.

### 3.5 The screen — `management-docs` → "Project Documentation"

Register a real component for `management-docs` in the `SECTION_PAGES` map
(`apps/ui/src/router/routes.ts`): a new
`apps/ui/src/pages/ProjectDocumentationPage.vue`, backed by a new read-only Pinia
store `apps/ui/src/stores/project-docs.ts` (patterned on
`stores/release-notes.ts`, minus any write path). Built from the shared `K*` kit
components and rendered markdown in the standard `.k-log__markdown` container.

Layout and behaviour:

- **Left rail** — the selected workspace's projects, from
  `useProjects.projectsByWorkspace` for the workspace `ManagementPage` hands in.
  Listing every project *is* the workspace-level aggregation ("documentation
  gathered within all projects").
- **Select a project** — its `docFolders` render as a **merged browsable tree**
  (each configured folder is a top-level node, its children lazily fetched via
  `api.projectDocsTree`). Selecting a file loads it: markdown/markup through
  `renderDoc` (§3.3), code through the `KFileView` highlighter, images inline via
  `docs/raw`, other binaries as a download link.
- **Pre-focus** — if `useOrchestrator.selectedProjectId` is set, that project
  opens on entry, so the sidebar acts as a deep link into the single-project view.
- **States (option A):** repo not bound on this machine → a "bind repo to view
  its documentation" prompt (the docs are simply not present here); bound but
  `docFolders` empty → a "configure documentation folders in Settings" prompt;
  a configured folder absent from the current checkout → a per-folder notice
  while the other folders still render; `binary`/`truncated` `FileContent` flags
  → the same notices `KFileView` already shows.

`packages/core/src/management.ts`: change `management-docs` from
`capability: "none"` to **`"read"`** and drop the `NOT_BUILT` limitation — a
screen now exists, and the section stays read-only (the assistant may mention it,
never write it). Update its `hint`/`limitation` copy accordingly.

### 3.6 Freshness (decision A)

Documentation is read live from `localRepoPath` on every navigation, so it always
reflects the current checkout. After a successful `api.pullProject(id)` (the
`MainLayout` footer button), if the docs store's active project equals the pulled
project, the store calls `refresh()` — re-fetch the open tree level and the open
file. This reuses the pull the operator already triggers; no watcher, no polling.
The workspace view shows only projects **bound on this machine**; unbound
projects render the bind prompt rather than another member's copy — repository
content is never uploaded or aggregated in the cloud.

## 4. Out of scope

- Editing documentation from Kermanych — the screen is read-only; edits happen in
  the repository through the normal session/PR flow.
- A cloud-published documentation snapshot for members who have not bound the repo
  (rejected in favour of decision A; would require storing repo content in
  Supabase).
- Rendering embedded raw HTML inside markdown — kept escaped (`html: false`),
  matching GitHub's default and the existing safety posture.
- A filesystem watcher / live reload independent of pull.
- A dedicated project-detail route hanging off the sidebar row (Approach 2);
  the sidebar deep-links into the unified screen instead.

## 5. Testing

- **api** (`apps/api/test`): `SupervisorService.docsTree`/`docsFile`/`docsRaw` —
  reject a `folder` not in `docFolders` (`400`), reject a `..`/absolute `path`,
  return `needsBinding` (`409`) when `localRepoPath` is unset, and return an
  empty tree for a configured-but-absent folder. Exercise the reused
  `WorktreeService` guards on the new `docs/*` paths.
- **cloud/registry**: `doc_folders` round-trips `toCloudProject`/`toProjectRow`;
  `registry.upsertProject`/`patchProject`/`listProjects` persist and return it;
  `syncProjects` does not clobber it with an empty cloud value.
- **ui** (`apps/ui/test`): `renderDoc` pure tests — `breaks: false` (single
  newline is not `<br>`), a fenced code block is highlighted, a relative
  `![](./x.png)` is rewritten to the `docs/raw` URL, a relative `[y](./z.md)`
  rewrites to the in-app navigation target, and an absolute/anchor link is left
  intact. Any aggregation helper added to `lib/scope.ts`.
- **smoke (browser-driven, the actual app):** configure a doc folder on a bound
  repo in Settings; open Project Documentation; confirm markdown renders
  GitHub-faithfully, an inline image loads, and a code file is highlighted; pull
  the repo and confirm the preview refreshes; open an unbound project and confirm
  the bind prompt. This is the verification of record for the UI surface.

## 6. i18n

All user-facing strings are added **Ukrainian-first** in `apps/ui/src/i18n/uk`
then mirrored in `en`: the Settings "Documentation folders" editor, the screen's
empty/bind/configure/absent-folder notices, and the updated `management-docs`
section `hint`/`limitation` in `packages/core/src/management.ts`.
