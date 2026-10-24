-- An explicit sequence, and the sequence each serial-family column makes,
-- named as Postgres names it, each decided for the three roles.
create sequence public.ticket_numbers;
grant usage on sequence public.ticket_numbers to authenticated, service_role;
revoke all on sequence public.ticket_numbers from anon;

create table public.tickets (
  id serial primary key,
  big_ref bigserial,
  small_ref smallserial,
  number bigint default nextval('public.ticket_numbers')
);
grant select, insert on public.tickets to authenticated, service_role;
revoke all on public.tickets from anon;
grant usage on sequence public.tickets_id_seq, public.tickets_big_ref_seq,
  public.tickets_small_ref_seq to authenticated, service_role;
revoke all on sequence public.tickets_id_seq, public.tickets_big_ref_seq,
  public.tickets_small_ref_seq from anon;

-- Long names: Postgres shortens the longer of the two first, to fit 63 bytes.
create table public.a_table_name_that_is_long_enough_to_force_truncation_xyz (
  a_column_name_that_is_also_rather_long serial
);
grant select on public.a_table_name_that_is_long_enough_to_force_truncation_xyz
  to anon, authenticated, service_role;
grant usage on public.a_table_name_that_is_long_eno_a_column_name_that_is_also_ra_seq
  to anon, authenticated, service_role;

-- A quoted table and column keep their case in the sequence's name.
create table "Quoted Table" ("Quoted Col" bigserial);
grant select on "Quoted Table" to anon, authenticated, service_role;
grant usage on sequence "Quoted Table_Quoted Col_seq" to anon, authenticated, service_role;

-- A column added later with a serial type makes a sequence too.
alter table public.tickets add column if not exists line_no serial4;
grant usage on sequence public.tickets_line_no_seq to anon, authenticated, service_role;

-- The name is taken (by the first table here), so Postgres adds 1 to the label.
create table public.clash_id_seq (x int);
revoke all on public.clash_id_seq from anon, authenticated, service_role;
create table public.clash (id serial);
grant select on public.clash to anon, authenticated, service_role;
grant usage on sequence public.clash_id_seq1 to anon, authenticated, service_role;

-- A multibyte name is cut to 63 bytes on a character boundary (40 two-byte
-- characters keep 31), and the sequence name shortens it again, to 28.
create table "éééééééééééééééééééééééééééééééééééééééé" (id serial);
grant select on "éééééééééééééééééééééééééééééééééééééééé" to anon, authenticated, service_role;
grant usage on sequence "éééééééééééééééééééééééééééé_id_seq" to anon, authenticated, service_role;
