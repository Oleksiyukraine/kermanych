-- «Кімната відпочинку» with colleagues (docs/specs/2026-11-23-lounge-multiplayer.md, decision 1):
-- who sits in the lounge and the rounds they play together ride Supabase Realtime, on PRIVATE
-- channels only. A public channel is open to anyone holding the publishable key; a private one
-- is checked against these policies on `realtime.messages`, per join (select) and per send /
-- track (insert).
--
-- Topics:
--   lounge:<workspace uuid>               the lobby: presence of the windows in the lounge
--   lounge:<workspace uuid>:room:<id>     one room: presence of its players, broadcast of its round
--
-- Both are open to the members of that workspace and to nobody else. A topic that does not
-- parse maps to no workspace, and is_workspace_member(null, …) is false, so these policies grant
-- nothing outside the lounge. No table: a room exists while its host is present.

-- The workspace a lounge topic belongs to; null for anything else.
create or replace function public.lounge_topic_workspace(p_topic text)
returns uuid
language sql
immutable
set search_path = public
as $$
  select case
    when p_topic ~ '^lounge:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:room:[A-Za-z0-9-]{1,64})?$'
      then substring(p_topic from 8 for 36)::uuid
  end;
$$;

revoke all on function public.lounge_topic_workspace(text) from public, anon;
grant execute on function public.lounge_topic_workspace(text) to authenticated;

-- Join a lounge channel and hear it: broadcast messages and the presence state.
create policy lounge_members_receive
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension in ('broadcast', 'presence')
  and public.is_workspace_member(public.lounge_topic_workspace((select realtime.topic())), (select auth.uid()))
);

-- Send on a lounge channel: broadcast a message, track one's own presence.
create policy lounge_members_send
on realtime.messages
for insert
to authenticated
with check (
  realtime.messages.extension in ('broadcast', 'presence')
  and public.is_workspace_member(public.lounge_topic_workspace((select realtime.topic())), (select auth.uid()))
);
