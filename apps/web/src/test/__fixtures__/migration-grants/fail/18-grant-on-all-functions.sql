-- The only defect: a schema-wide GRANT on functions. The function's EXECUTE is
-- decided by name, and the GRANT still fails: it reaches every function in
-- public, the ones earlier migrations revoked EXECUTE on included.
create function public.label_for(p_id int) returns text
language sql
stable
set search_path = ''
as $$ select 'tag ' || p_id::text $$;
revoke all on function public.label_for(int) from public, anon, authenticated;
grant execute on function public.label_for(int) to authenticated, service_role;

grant execute on all functions in schema public to service_role;
