-- 0214_user_session_names.sql
-- Editable, session-scoped custom names for the Active Sessions list (mig 0213).
-- auth.sessions is Supabase-managed (no new columns), so names live in a public
-- table reached ONLY through auth.uid()-scoped SECURITY DEFINER functions — the
-- table itself is not client-readable/writable. A name is keyed to the
-- auth.sessions row (one login) and cascades away when that session is revoked.

create table if not exists public.user_session_names (
  session_id uuid primary key references auth.sessions(id) on delete cascade,
  user_id    uuid not null,
  name       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Lock the table down: RLS on with NO policies + no client grants. Only the
-- SECURITY DEFINER functions below (running as the owner) ever touch it.
alter table public.user_session_names enable row level security;
revoke all on table public.user_session_names from public;
revoke all on table public.user_session_names from anon;
revoke all on table public.user_session_names from authenticated;

-- Set or clear the caller's custom name for ONE of their own sessions.
-- Trims; blank/null clears the name (reverts to the auto-detected label); caps
-- at 60 chars. Naming a session that isn't yours is a silent no-op (returns 0) —
-- the ownership check is in the DB, so no spoofable user id from the app.
create or replace function public.set_my_session_name(p_session_id uuid, p_name text)
returns integer
language plpgsql
security definer
set search_path = auth, public
as $$
declare
  v_name text;
begin
  if not exists (
    select 1 from auth.sessions
     where id = p_session_id and user_id = auth.uid()
  ) then
    return 0;
  end if;

  v_name := nullif(btrim(coalesce(p_name, '')), '');

  if v_name is null then
    delete from public.user_session_names
     where session_id = p_session_id and user_id = auth.uid();
    return 1;
  end if;

  if length(v_name) > 60 then
    v_name := left(v_name, 60);
  end if;

  insert into public.user_session_names (session_id, user_id, name)
  values (p_session_id, auth.uid(), v_name)
  on conflict (session_id) do update
    set name = excluded.name, updated_at = now();
  return 1;
end;
$$;

-- list_my_sessions gains a custom_name column. The OUT-column shape changes, so
-- CREATE OR REPLACE is not allowed — drop and recreate, then re-grant.
drop function if exists public.list_my_sessions();
create function public.list_my_sessions()
returns table (
  id uuid,
  user_agent text,
  ip text,
  created_at timestamptz,
  refreshed_at timestamptz,
  aal text,
  not_after timestamptz,
  custom_name text
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
         s.not_after,
         n.name
  from auth.sessions s
  left join public.user_session_names n
    on n.session_id = s.id and n.user_id = s.user_id
  where s.user_id = auth.uid()
  order by s.refreshed_at desc nulls last, s.created_at desc;
$$;

revoke all on function public.set_my_session_name(uuid, text) from public;
revoke all on function public.list_my_sessions() from public;
grant execute on function public.set_my_session_name(uuid, text) to authenticated;
grant execute on function public.list_my_sessions() to authenticated;
