-- A deliberate no-access table says so with a REVOKE for each role, and a
-- service-role-only table revokes everything, then grants service_role what
-- it needs. (0111's order_email_log revoked only from anon and authenticated,
-- which left service_role's UPDATE and DELETE to the default privileges.)
create table public.internal_ledger (id bigint primary key, payload jsonb);
alter table public.internal_ledger enable row level security;
revoke all on table public.internal_ledger from public, anon, authenticated, service_role;

create table public.service_only (id bigint primary key);
revoke all on table public.service_only from public, anon, authenticated, service_role;
grant select, insert on table public.service_only to service_role;
