-- Every spelling Postgres reads as schema public, every ON ALL form, the
-- matching REVOKE forms, a DO block's statements and a CREATE SCHEMA GRANT
-- element: each fails on its own line. Nothing here creates a public object.
create schema d1_other;
grant select on all tables in schema PUBLIC to anon;
grant select on all tables in schema "public" to anon;
grant select on all tables in schema U&"publi\0063" to anon;
grant select on all tables in schema U&"publi!0063" uescape '!' to anon;
grant select on all /* tables */ tables in -- schema d1_other
  schema public to anon;
grant select on all tables in schema d1_other, public to anon;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all procedures in schema public to service_role;
grant execute on all routines in schema public to service_role;
revoke select on all tables in schema public from anon;
revoke execute on all functions in schema public from anon;
revoke grant option for select on all tables in schema public from service_role;
revoke all on all routines in schema public from public;
do $$
begin
  if current_setting('server_version_num')::int >= 170000 then
    grant select on all tables in schema public to anon;
  end if;
end
$$;
do E'begin revoke all on all sequences in schema public from anon; end';
create schema d1_elements
  create table element_rows (id int)
  grant select on all tables in schema public to anon;
