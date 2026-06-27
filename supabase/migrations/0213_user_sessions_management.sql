-- 0213_user_sessions_management.sql
-- Self-service active-session management. auth.sessions is the revocable unit
-- (one row per login; carries user_agent/ip/refreshed_at/aal). It lives in the
-- auth schema (not RLS-exposed to clients), so access goes through SECURITY
-- DEFINER functions scoped to auth.uid() — the DB enforces "only your own
-- sessions", with no service-role in the app and no spoofable id param.

create or replace function public.list_my_sessions()
returns table (
  id uuid,
  user_agent text,
  ip text,
  created_at timestamptz,
  refreshed_at timestamptz,
  aal text,
  not_after timestamptz
)
language sql
stable
security definer
set search_path = auth, public
as $$
  select s.id,
         s.user_agent,
         host(s.ip),
         s.created_at,
         s.refreshed_at::timestamptz,
         s.aal::text,
         s.not_after
  from auth.sessions s
  where s.user_id = auth.uid()
  order by s.refreshed_at desc nulls last, s.created_at desc;
$$;

create or replace function public.revoke_my_session(p_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = auth, public
as $$
declare
  n integer;
begin
  delete from auth.sessions
   where id = p_session_id and user_id = auth.uid();
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.revoke_my_other_sessions(p_keep_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = auth, public
as $$
declare
  n integer;
begin
  delete from auth.sessions
   where user_id = auth.uid()
     and id is distinct from p_keep_session_id;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.list_my_sessions() from public;
revoke all on function public.revoke_my_session(uuid) from public;
revoke all on function public.revoke_my_other_sessions(uuid) from public;
grant execute on function public.list_my_sessions() to authenticated;
grant execute on function public.revoke_my_session(uuid) to authenticated;
grant execute on function public.revoke_my_other_sessions(uuid) to authenticated;
