-- «Вдосконалювати навички» becomes a level (docs/specs/2026-11-06-skill-improvement-reflection.md,
-- decision 3): off | conservative | moderate | active, replacing the on/off switch of
-- 20261104120000_skill_improvements.sql. The level sets how low the bar for a lesson is, in the
-- improve_skill tool's description and in the reflection step Kermanych appends to «Створити ПР»,
-- «Закоміти» and «Зберегти дизайн»; `off` hands out neither. RLS is unchanged:
-- profiles_update_own already lets a user set their own value.
--
-- The old switch carries over: off stays off, on becomes the new default. An older client reads
-- the dropped column, gets an error and keeps «unknown = on», its existing fallback; its Settings
-- switch fails to save until it is updated.

alter table public.profiles
  add column skill_improvement_level text not null default 'moderate'
    check (skill_improvement_level in ('off', 'conservative', 'moderate', 'active'));

update public.profiles set skill_improvement_level = 'off' where skill_improvement = false;

alter table public.profiles drop column skill_improvement;
