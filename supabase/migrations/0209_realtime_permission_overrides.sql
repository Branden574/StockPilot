-- 0209_realtime_permission_overrides.sql
--
-- Add the configurable-permission override tables to the supabase_realtime
-- publication so an open session can react instantly when an admin changes a
-- user's access (no manual refresh): role_permission_overrides +
-- user_permission_overrides (mig 0207).
--
-- RLS still applies to realtime delivery — Supabase enforces the subscriber's
-- SELECT policies before sending each row event, so a client only receives
-- changes for rows it can already read (its org's role overrides; its OWN user
-- overrides, or all of them for admins). No cross-tenant leakage.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end$$;

-- Idempotent: `alter publication ... add table` errors 42710 if the table is
-- already a member, so guard each with a membership check.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'role_permission_overrides'
  ) then
    alter publication supabase_realtime add table public.role_permission_overrides;
  end if;
end$$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'user_permission_overrides'
  ) then
    alter publication supabase_realtime add table public.user_permission_overrides;
  end if;
end$$;
