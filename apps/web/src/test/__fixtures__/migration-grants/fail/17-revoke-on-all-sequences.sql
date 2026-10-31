-- The only defect: a schema-wide REVOKE. The sequence is decided for all
-- three roles, and the REVOKE still fails: it reaches every sequence already
-- in public, so it would take away what earlier migrations granted.
create sequence public.label_numbers;
revoke all on sequence public.label_numbers from anon, authenticated, service_role;
grant usage, select on sequence public.label_numbers to service_role;

revoke usage on all sequences in schema public from anon;
