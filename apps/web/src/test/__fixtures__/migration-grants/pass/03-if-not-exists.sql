-- IF NOT EXISTS still asks for the decision, and a second IF NOT EXISTS of the
-- same table in the file leaves it (and its decisions) alone.
create table if not exists public.settings_cache (key text primary key, value jsonb);
revoke all on public.settings_cache from anon, authenticated;
grant select on public.settings_cache to authenticated;
grant all on public.settings_cache to service_role;

create table if not exists public.settings_cache (key text primary key, value jsonb);

create sequence if not exists public.settings_version;
grant usage, select on sequence public.settings_version to authenticated, service_role;
revoke all on sequence public.settings_version from anon;
