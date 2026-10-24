-- A deliberate no-access table says so with a REVOKE for each role, and a
-- service-role-only table revokes the other two (as 0111's order_email_log).
create table public.internal_ledger (id bigint primary key, payload jsonb);
alter table public.internal_ledger enable row level security;
revoke all on table public.internal_ledger from public, anon, authenticated, service_role;

create table public.service_only (id bigint primary key);
revoke all on table public.service_only from public, anon, authenticated;
grant select, insert on table public.service_only to service_role;
