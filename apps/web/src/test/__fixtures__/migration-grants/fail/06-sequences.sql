-- Sequences: an explicit one, and the one each serial-family column makes.
-- The table's grants do not reach its sequences.
create sequence public.ticket_numbers;
create sequence if not exists public.other_numbers;
grant usage on sequence public.other_numbers to authenticated;

create table public.tickets (
  id serial primary key,
  big_ref bigserial,
  small_ref smallserial,
  old_style serial8,
  quoted_type "serial"
);
grant all on public.tickets to anon, authenticated, service_role;

create table public.later (note text);
grant all on public.later to anon, authenticated, service_role;
alter table public.later add column n serial2;

-- A grant on a name Postgres did not give the sequence decides nothing.
create table public.misnamed (id serial);
grant all on public.misnamed to anon, authenticated, service_role;
create sequence public.misnamed_seq;
grant all on sequence public.misnamed_seq to anon, authenticated, service_role;
