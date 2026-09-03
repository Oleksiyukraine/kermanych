-- Per-user agent runtime preference (Increment 2). Additive and nullable: null means
-- "not chosen yet" (the UI shows the onboarding gate). RLS is unchanged — profiles_select
-- (using true) already allows reads and profiles_update_own (id = auth.uid()) already allows
-- a user to set their own value, so no new policy is needed. Safe to push at any time.
alter table public.profiles add column agent_runtime text;
