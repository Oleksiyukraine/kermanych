-- Per-user agent runtime preference (Increment 2). Additive and nullable: null means
-- "not chosen yet" (the UI shows the onboarding gate). RLS unchanged — profiles_select
-- (using true) allows reads; profiles_update_own (id = auth.uid()) allows user updates.
-- No new policy needed. Safe to push anytime.
alter table public.profiles add column agent_runtime text;
