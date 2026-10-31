-- The only defect: a schema-wide GRANT. The table is decided for all three
-- roles, and the GRANT still fails: it reaches every table and view already
-- in public, so it would put back what earlier migrations revoked.
create table public.price_tags (id int primary key, label text);
revoke all on public.price_tags from anon, authenticated, service_role;
grant select on public.price_tags to authenticated;
grant select, insert, update, delete on public.price_tags to service_role;

grant select on all tables in schema public to authenticated;
