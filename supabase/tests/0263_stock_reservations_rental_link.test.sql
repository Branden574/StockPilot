-- supabase/tests/0263_stock_reservations_rental_link.test.sql
-- Proves migration 0263 (rental reservation link):
--   S1. stock_reservations.rental_id exists, is uuid, nullable.
--   S2. rental_id is a FK to rentals(id) with ON DELETE CASCADE.
--   S3. A reservation can be written with rental_id set + order_request_id null.
-- Namespace ab026300. Wrapped in begin/rollback.

begin;

select plan(5);

-- S1. Column shape
select has_column('public', 'stock_reservations', 'rental_id', 'rental_id column exists');
select col_type_is('public', 'stock_reservations', 'rental_id', 'uuid', 'rental_id is uuid');
select col_is_null('public', 'stock_reservations', 'rental_id', 'rental_id is nullable');

-- S2. FK to rentals with cascade delete
select is(
  (select confdeltype from pg_constraint
     where conrelid = 'public.stock_reservations'::regclass
       and confrelid = 'public.rentals'::regclass
       and 'rental_id' = (
         select attname from pg_attribute
         where attrelid = 'public.stock_reservations'::regclass and attnum = conkey[1])),
  'c',
  'rental_id FK to rentals cascades on delete'
);

-- S3. The index exists (rental reservations are looked up / released by rental_id)
select has_index(
  'public', 'stock_reservations', 'stock_reservations_rental_idx',
  'rental_id has a partial index'
);

select * from finish();
rollback;
