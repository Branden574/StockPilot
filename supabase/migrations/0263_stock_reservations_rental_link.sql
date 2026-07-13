-- 0263_stock_reservations_rental_link.sql
-- Fix: rental checkout always failed with "an internal error occurred".
--
-- Rentals reserve stock through stock_reservations so the same unit can't be
-- double-committed. But that table (0044) only ever had `order_request_id` as
-- its reference — the rentals service wrote `reference_type`/`reference_id`
-- columns that DO NOT EXIST, omitted the NOT NULL `warehouse_id`, and (per the
-- 0119 defense-in-depth RLS) could not write the table from a member session
-- at all. So the reservation insert threw, the just-created rental was rolled
-- back, and checkout surfaced a generic internal error. Rental checkout has
-- never worked.
--
-- Add a parallel, nullable `rental_id` link (mirroring `order_request_id`) so a
-- reservation can belong to EITHER an order or a rental. The rentals service
-- creates/releases these via the service-role client, exactly as the order
-- approve/pick RPCs are the only writers of order reservations. The existing
-- active-reservation index (organization_id, item_id) already makes rental
-- reservations reduce available-to-promise with no availability-query change.

alter table public.stock_reservations
  add column if not exists rental_id uuid references public.rentals(id) on delete cascade;

create index if not exists stock_reservations_rental_idx
  on public.stock_reservations(rental_id)
  where rental_id is not null;

comment on column public.stock_reservations.rental_id is
  'Set when this reservation is held by a rental checkout (parallel to order_request_id for order reservations). released_at is set on rental return/cancel.';
