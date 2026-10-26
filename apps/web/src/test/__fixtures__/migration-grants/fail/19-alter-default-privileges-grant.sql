-- The only defect: ALTER DEFAULT PRIVILEGES ... GRANT. The table is decided
-- for all three roles, and the statement still fails: it gives privileges to
-- tables not created yet, out of sight of the statements that create them,
-- and in public it puts back what Supabase's 2026-10-30 change takes away.
create table public.shelf_labels (id int primary key, label text);
revoke all on public.shelf_labels from anon, authenticated, service_role;
grant select on public.shelf_labels to authenticated;
grant all on public.shelf_labels to service_role;

alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
