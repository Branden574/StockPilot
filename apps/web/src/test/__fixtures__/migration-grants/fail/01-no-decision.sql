-- RLS and a policy are not a decision: with no GRANT the Data API roles get
-- nothing from 2026-10-30, and the policy is never consulted.
create table public.widgets (id uuid primary key, name text);
alter table public.widgets enable row level security;
create policy widgets_read on public.widgets for select to authenticated using (true);

create table gadgets (id bigint primary key);
