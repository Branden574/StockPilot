-- Liquid Glass stage 5: the fidelity seed (IMPLEMENTATION-PLAN.md 8.1 "Same data").
--
-- A synthetic slice of the boards' demo world added to the Redesign Lab organisation, so the
-- glass pages and the reference boards show the same kind of rows with the same numbers:
--   * a fictional charter school, Lantern Hollow Academy (code LHA);
--   * the Staff Polo size family (product group, sports apparel), Navy, XS to XL, with the
--     boards' on-hand numbers: XS 12 on 12-A; S 40 (28 on 12-A, 12 on 12-B); M 6 on 12-A;
--     L 24 on 12-B; XL 0 (out of stock);
--   * two book editions of one fictional title (Grade 9 algebra, 2026 and 2025 editions):
--     104 and 42 on rack 30-A;
--   * one sales order (the customer-portal kind, pending approval) for M x2 and L x2, the
--     board's order lines.
-- Purchase orders, returns and cycle counts are the lab's own (seed S5 made every state of
-- each); the seed does not write them, because their rows are created through the app's
-- security-definer functions as a signed-in actor. Recorded as a gap in the stage 5 runbook.
--
-- FICTIONAL ONLY: every name is invented, every email is at example.test, there is no phone
-- number, card or token (apps/web/src/test/fidelity-fixture.guard.test.ts fails on any). The
-- ISBNs are invented 979-8 numbers.
--
-- HOW IT RUNS: only through seed-fidelity.mjs (next to this file), which refuses any database
-- that is not on 127.0.0.1 / localhost, and only inside a lab snapshot that is restored after
-- the run (liquid-glass/verify/stage5/run-stage5.sh). ONE transaction (psql -1, ON_ERROR_STOP):
-- all or nothing. Ids are fixed (5eed0000-f1d0-...), so a second run refuses instead of
-- doubling rows (the runner checks the marker first and skips an applied seed).
-- Column lists follow the lab seed (redesign-2026-10/lab/seed S2, S3, S5) exactly.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------- guard
do $$
begin
  -- The lab's own seed bookkeeping schema exists only in the Redesign Lab database.
  if to_regclass('rlab_seed.meta') is null then
    raise exception 'fidelity seed: rlab_seed.meta is missing: not the lab';
  end if;
  if not exists (select 1 from public.organizations
                  where id = '5eed0000-0001-4000-8000-000000000001' and slug = 'redesign-lab') then
    raise exception 'fidelity seed: the Redesign Lab organisation is missing: not the lab';
  end if;
  if exists (select 1 from public.charters where id = '5eed0000-f1d0-4000-8000-000000000001') then
    raise exception 'fidelity seed: already applied (charter LHA exists)';
  end if;
end $$;

create or replace function pg_temp.fid(n int) returns uuid language sql immutable as $$
  select ('5eed0000-f1d0-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function pg_temp.lab(t text, n int) returns uuid language sql immutable as $$
  select ('5eed0000-' || t || '-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;

-- Lab ids (seed S1/S2): org 1, manager user 3, portal user 11, North DC warehouse 1, its
-- site 1001 and racks 12-A 1011, 12-B 1012, 30-A 1021; categories Books 2 and Sports
-- apparel 12; the youth/adult size scale 1; customer 1.
create temp table fid_ref as select
  pg_temp.lab('0001', 1)    as org,
  pg_temp.lab('0002', 3)    as manager,
  pg_temp.lab('0002', 11)   as portal_user,
  pg_temp.lab('0003', 1)    as wh,
  pg_temp.lab('0004', 1001) as site,
  pg_temp.lab('0004', 1011) as r12a,
  pg_temp.lab('0004', 1012) as r12b,
  pg_temp.lab('0004', 1021) as r30a,
  pg_temp.lab('0007', 2)    as cat_books,
  pg_temp.lab('0007', 12)   as cat_apparel,
  pg_temp.lab('000e', 1)    as scale,
  pg_temp.lab('0090', 1)    as customer;

-- ---------------------------------------------------------------- charter
insert into public.charters
  (id, organization_id, name, code, description, status, contact_name, contact_email, contact_phone, address, created_by, created_at)
select pg_temp.fid(1), r.org, 'Lantern Hollow Academy', 'LHA', 'Fictional charter for the stage 5 fidelity run.', 'active',
       null, 'office@lantern-hollow.example.test', null, null, r.manager, now() - interval '200 days'
  from fid_ref r;
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id)
select r.org, r.wh, pg_temp.fid(1) from fid_ref r;

-- ---------------------------------------------------------------- the Staff Polo family
insert into public.product_groups
  (id, organization_id, category_id, subcategory_key, name, model, team, season, home_away, color, colorway,
   size_scale_id, default_counting_unit, tracking_mode, group_key, status, created_by, updated_by, created_at)
select pg_temp.fid(10), r.org, r.cat_apparel, 'sports_apparel', 'Staff Polo', 'Staff Polo',
       null, null, null, null, 'Navy', r.scale, 'each', 'QUANTITY_BY_VARIANT',
       'sports_apparel||staff polo||navy', 'active', r.manager, r.manager, now() - interval '150 days'
  from fid_ref r;

-- One row per item: n, sku, name, size (null for a book), type, quantity, first place, cost.
create temp table fid_item (n int primary key, sku text, name text, vsize text, item_type text, qty numeric,
  first_loc text, cost numeric, barcode text, cf jsonb);
insert into fid_item values
  (11, 'APP-POLO-NVY-XS', 'Staff Polo · Navy · XS', 'XS', 'product', 12, 'r12a', 14.5, null, '{"rack_number":"12","rack_row":"A","size":"XS"}'),
  (12, 'APP-POLO-NVY-S',  'Staff Polo · Navy · S',  'S',  'product', 40, 'r12a', 14.5, null, '{"rack_number":"12","rack_row":"A","size":"S"}'),
  (13, 'APP-POLO-NVY-M',  'Staff Polo · Navy · M',  'M',  'product',  6, 'r12a', 14.5, null, '{"rack_number":"12","rack_row":"A","size":"M"}'),
  (14, 'APP-POLO-NVY-L',  'Staff Polo · Navy · L',  'L',  'product', 24, 'r12b', 14.5, null, '{"rack_number":"12","rack_row":"B","size":"L"}'),
  (15, 'APP-POLO-NVY-XL', 'Staff Polo · Navy · XL', 'XL', 'product',  0, null,   14.5, null, '{"size":"XL"}'),
  (21, 'BK-ALG1-G9-2026', 'Algebra I · Grade 9 · 2026 edition', null, 'book', 104, 'r30a', 61.25, '9798900001418',
       '{"book_rack_number":"30","book_rack_row":"A","author":"Wren Okafor-Lindqvist","book_grade":"9"}'),
  (22, 'BK-ALG1-G9-2025', 'Algebra I · Grade 9 · 2025 edition', null, 'book',  42, 'r30a', 58.0, '9798900002552',
       '{"book_rack_number":"30","book_rack_row":"A","author":"Wren Okafor-Lindqvist","book_grade":"9"}');

-- Stock goes in at the first place (trg_seed_initial_level seeds that one holding), then the
-- primary location becomes the site label (lab rule: never a rack id), as seed S3 does.
insert into public.inventory_items (
  id, organization_id, sku, barcode, name, description, category_id, supplier_id, primary_location_id,
  unit_cost, retail_price, quantity_on_hand, reorder_point, reorder_quantity, unit_of_measure, status,
  bin_location, custom_fields, created_by, updated_by, created_at, updated_at, warehouse_id, charter_id,
  tracking_type, item_type, is_bundle, is_rental, model_number, shelf_life_days, expiry_policy, archived_at,
  public_visibility, public_display_name, public_description, zero_since, auto_archived, awaiting_first_receipt,
  group_id, variant_size, variant_size_original, variant_size_system, variant_key)
select pg_temp.fid(i.n), r.org, i.sku, i.barcode, i.name, null,
       case when i.item_type = 'book' then r.cat_books else r.cat_apparel end, null,
       case i.first_loc when 'r12a' then r.r12a when 'r12b' then r.r12b when 'r30a' then r.r30a else r.site end,
       i.cost, 0, i.qty, case when i.item_type = 'book' then 30 else 10 end, case when i.item_type = 'book' then 60 else 24 end,
       'each', 'active',
       case i.first_loc when 'r12a' then '12-A' when 'r12b' then '12-B' when 'r30a' then '30-A' end,
       i.cf, r.manager, r.manager, now() - interval '140 days', now() - interval '2 days', r.wh, pg_temp.fid(1),
       'none', i.item_type, false, false, null, null, 'warn', null,
       'internal_only', null, null, case when i.qty = 0 then now() - interval '20 days' end, false, false,
       case when i.vsize is not null then pg_temp.fid(10) end,
       i.vsize, i.vsize, null, case when i.vsize is not null then 'size=' || lower(i.vsize) end
  from fid_item i cross join fid_ref r;

-- Polo S: 28 stay on 12-A, 12 move to 12-B (the board's two places).
update public.item_stock_levels set quantity = 28
 where item_id = pg_temp.fid(12) and location_id = (select r12a from fid_ref);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
select r.org, pg_temp.fid(12), r.r12b, 12 from fid_ref r;
update public.inventory_items set primary_location_id = (select site from fid_ref)
 where id in (select pg_temp.fid(n) from fid_item) and primary_location_id is distinct from (select site from fid_ref);

-- ---------------------------------------------------------------- one sales order (portal kind)
insert into public.order_requests (id, organization_id, warehouse_id, status, source, customer_id,
       requester_user_id, requester_email, requester_name, notes, fulfillment_type)
select pg_temp.fid(30), r.org, r.wh, 'pending_approval', 'portal', r.customer, r.portal_user,
       'orders@lantern-hollow.example.test', 'Lantern Hollow Academy', 'Fidelity run: staff polos for the front office.', 'pickup'
  from fid_ref r;
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, unit_cost_at_request,
       unit_price_at_request)
values (pg_temp.fid(31), pg_temp.fid(30), pg_temp.fid(13), 2, 14.5, null),
       (pg_temp.fid(32), pg_temp.fid(30), pg_temp.fid(14), 2, 14.5, null);

-- ---------------------------------------------------------------- verify (inside the transaction)
do $$
declare v_items int; v_held numeric; v_s_places int; v_lines int;
begin
  select count(*) into v_items from public.inventory_items where id::text like '5eed0000-f1d0-%';
  if v_items <> 7 then raise exception 'fidelity seed: % items, want 7', v_items; end if;
  select coalesce(sum(quantity), 0) into v_held from public.item_stock_levels where item_id::text like '5eed0000-f1d0-%';
  if v_held <> 12 + 40 + 6 + 24 + 104 + 42 then raise exception 'fidelity seed: % held, want 228', v_held; end if;
  select count(*) into v_s_places from public.item_stock_levels where item_id = '5eed0000-f1d0-4000-8000-000000000012' and quantity > 0;
  if v_s_places <> 2 then raise exception 'fidelity seed: polo S is in % places, want 2', v_s_places; end if;
  select count(*) into v_lines from public.order_request_lines where order_request_id = '5eed0000-f1d0-4000-8000-000000000030';
  if v_lines <> 2 then raise exception 'fidelity seed: % order lines, want 2', v_lines; end if;
end $$;

select 'FIDELITY SEED OK' as result;
