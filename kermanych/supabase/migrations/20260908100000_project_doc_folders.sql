-- Per-project documentation folders: repo-relative POSIX directory paths whose
-- files the Project Documentation screen renders. Team-shared SELECTION only —
-- the file CONTENT is read from each developer's local checkout and never stored
-- here. Column-only, like carry_files; no JSON blob. Existing project-update RLS
-- (projects_update_member) already covers it, so no policy is added.
alter table public.projects
  add column doc_folders text[] not null default '{}';
