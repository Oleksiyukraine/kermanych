-- Per-user agent communication language. Additive and nullable: null means "no preference"
-- (the agent keeps its own default; no directive is injected). RLS is unchanged —
-- profiles_select (using true) already allows reads and profiles_update_own (id = auth.uid())
-- already allows a user to set their own value, so no new policy is needed. Safe to push at
-- any time.
alter table public.profiles add column agent_language text;
