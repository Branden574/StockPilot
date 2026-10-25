-- Created in one statement and decided over several later ones, with other
-- statements between them. Roles may be split across statements, and WITH
-- GRANT OPTION or GRANTED BY change nothing. A column grant leaves the
-- table-level privilege where it was, so that one is revoked first.
create table public.profiles (
  id uuid primary key,
  display_name text,
  email text
);

alter table public.profiles enable row level security;
create index profiles_email_idx on public.profiles (email);

revoke all on public.profiles from anon;
grant select (id, display_name) on public.profiles to anon;

comment on table public.profiles is 'Who is who.';

revoke insert, update, delete on public.profiles from authenticated;
grant select, update (display_name) on public.profiles to authenticated granted by current_user;

create policy profiles_read on public.profiles for select to authenticated using (true);

grant all privileges on public.profiles to service_role with grant option;
