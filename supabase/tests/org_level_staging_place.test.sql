-- supabase/tests/org_level_staging_place.test.sql
-- B38 (no migration): stock in the organization-level Staging bucket
-- (ensure_org_placement_locations, 0194: a Staging location with no
-- warehouse) is placed by the same transfer_stock every Place uses, under the
-- same rules, and order readiness (0377) agrees before and after the move.
--
-- The web Staging page used to offer no Place for such a row (it had no
-- warehouse to list racks from), while readiness counts that Staging as
-- "here" for every order and sends people to put it away. The page now asks
-- for the warehouse first and places through the unchanged actions. These pin
-- the server behaviour that change relies on:
--
--  1  the bucket is a Staging location with no warehouse, in the org
--  2  readiness, for an order in the item's warehouse: the units are
--     here.staging and the bucket is the Staging source to put away, and the
--     item's own warehouse (the page's default) is the order's
--  3  a viewer cannot move them (42501 forbidden: no stock:transfer, 0395)
--  4  staff who work only in warehouse B cannot touch warehouse A's item,
--     even into their own rack (P0002 item_not_found: the item is unreadable
--     to them), although the bucket itself belongs to no warehouse
--  5  staff who work in A cannot put them into warehouse B's rack
--     (42501 forbidden: 0365, below manager the destination must be theirs)
--  6  the refusals moved nothing and wrote no ledger row
--  7  staff who work in A move them into warehouse A's rack
--  8  the holdings: the bucket 0, the rack 6; on hand unchanged
--  9  one transfer ledger row: quantity_change 0, previous = new = on hand,
--     moved 6, from the bucket to the rack, by that member, with the note
-- 10  readiness after: here.staging 0, here.rack 6, no Staging source left
-- 11  a manager may place bucket stock in any warehouse (0365: a manager is
--     not limited; the page offers a manager every warehouse)
-- 12  and that move is a transfer row by the manager, from the bucket
--
-- Roles: fixtures as the test superuser (RLS bypassed, the API-role guards
-- exempt); the moves and the readiness reads run as `authenticated` with
-- request.jwt.claim.sub. begin/rollback: nothing leaks. Namespace b3800000.

begin;
select plan(12);

\set org    '\'b3800000-0000-0000-0000-00000000000a\''
\set mgr    '\'b3800000-0000-0000-0000-0000000000a1\''
\set stfA   '\'b3800000-0000-0000-0000-0000000000a2\''
\set stfB   '\'b3800000-0000-0000-0000-0000000000a3\''
\set vwrA   '\'b3800000-0000-0000-0000-0000000000a4\''
\set whA    '\'b3800000-0000-0000-0000-0000000000b1\''
\set whB    '\'b3800000-0000-0000-0000-0000000000b2\''
\set rackA  '\'b3800000-0000-0000-0000-0000000000c1\''
\set rackB  '\'b3800000-0000-0000-0000-0000000000c2\''
\set item   '\'b3800000-0000-0000-0000-0000000000d1\''
\set item2  '\'b3800000-0000-0000-0000-0000000000d2\''
\set ord    '\'b3800000-0000-0000-0000-0000000000e1\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr,  'b38-mgr@test.local',  '{}'::jsonb),
  (:stfA, 'b38-stfa@test.local', '{}'::jsonb),
  (:stfB, 'b38-stfb@test.local', '{}'::jsonb),
  (:vwrA, 'b38-vwra@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
-- An org insert enables the default modules (orders among them); a warehouse
-- insert creates its own Staging and Unplaced.
insert into public.organizations (id, name, slug) values
  (:org, 'B38 Org-level Staging', 'b38-org-level-staging');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :mgr,  'manager', now()),
  (:org, :stfA, 'staff',   now()),
  (:org, :stfB, 'staff',   now()),
  (:org, :vwrA, 'viewer',  now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :org, 'B38 Main',  'WH-B38A', 'active'),
  (:whB, :org, 'B38 Annex', 'WH-B38B', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:org, :stfA, :whA, true),
  (:org, :stfB, :whB, true),
  (:org, :vwrA, :whA, true);
insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:rackA, :org, :whA, 'B38-A-1', 'shelf', 'rack'),
  (:rackB, :org, :whB, 'B38-B-1', 'shelf', 'rack');
select public.ensure_org_placement_locations(:org) as "_ignored" \gset
select id as "stOrg" from public.locations where organization_id = :org and warehouse_id is null
                                            and kind = 'staging' and deleted_at is null \gset
select id as "unA"   from public.locations where warehouse_id = :whA and kind = 'unplaced'
                                            and deleted_at is null \gset

-- Two items of warehouse A whose units sit in the organization's Staging
-- (they landed there while the items had no warehouse). Their opening stock
-- was seeded at A's Unplaced; the upsert puts it in the bucket instead.
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status) values
  (:item,  :org, :whA, 'B38-ITEM-1', 'B38 trail runner', 6, 'active'),
  (:item2, :org, :whA, 'B38-ITEM-2', 'B38 desk lamp',    2, 'active');
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values
  (:org, :item,  :'unA',   0),
  (:org, :item,  :'stOrg', 6),
  (:org, :item2, :'unA',   0),
  (:org, :item2, :'stOrg', 2)
  on conflict (item_id, location_id) do update set quantity = excluded.quantity;

-- An order in warehouse A for the six.
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type) values
  (:ord, :org, :whA, 'pending_approval', 'internal', :stfA, 'pickup');
insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values
  (:ord, :item, 6);

-- ── Helpers ──────────────────────────────────────────────────────────────
-- One item of a readiness answer.
create function pg_temp.item(p_facts jsonb, p_item uuid) returns jsonb language sql as $$
  select x from jsonb_array_elements(p_facts->'items') x where x->>'itemId' = p_item::text
$$;
-- The facts a put-away decision reads, for one item.
create function pg_temp.putaway_facts(p_facts jsonb, p_item uuid) returns jsonb language sql as $$
  select jsonb_build_object(
    'itemWarehouseId', pg_temp.item(p_facts, p_item)->'itemWarehouseId',
    'here',            pg_temp.item(p_facts, p_item)->'here',
    'sources',         pg_temp.item(p_facts, p_item)->'stagingSources')
$$;
-- Where the item's units are: the bucket, A's rack, B's rack.
create function pg_temp.where_units(p_item uuid, p_bucket uuid, p_rack_a uuid, p_rack_b uuid)
returns text language sql as $$
  select concat_ws('|',
    coalesce((select trim_scale(s.quantity) from public.item_stock_levels s
               where s.item_id = p_item and s.location_id = p_bucket), 0),
    coalesce((select trim_scale(s.quantity) from public.item_stock_levels s
               where s.item_id = p_item and s.location_id = p_rack_a), 0),
    coalesce((select trim_scale(s.quantity) from public.item_stock_levels s
               where s.item_id = p_item and s.location_id = p_rack_b), 0),
    (select trim_scale(i.quantity_on_hand) from public.inventory_items i where i.id = p_item))
$$;

create temp table fx (who text primary key, r jsonb not null);
grant all on fx to authenticated;
-- The ledger rows that existed before the moves (the opening stock's).
create temp table mv0 as
  select id from public.stock_movements where item_id in (:item, :item2);

-- Guard the fixtures: a silently missing row would let an assertion pass for
-- the wrong reason.
do $$
begin
  if (select count(*) from public.locations
       where organization_id = 'b3800000-0000-0000-0000-00000000000a'
         and warehouse_id is null and kind = 'staging' and deleted_at is null) <> 1 then
    raise exception 'fixture: expected one organization-level Staging';
  end if;
  if (select coalesce(sum(quantity), 0) from public.item_stock_levels
       where item_id = 'b3800000-0000-0000-0000-0000000000d1') <> 6 then
    raise exception 'fixture: expected the item''s six units on record';
  end if;
end $$;

-- ═══ 1-2. The bucket, and what readiness makes of it ═════════════════════
select is(
  (select jsonb_build_object('kind', l.kind, 'noWarehouse', l.warehouse_id is null,
                             'org', l.organization_id)
     from public.locations l where l.id = :'stOrg'),
  jsonb_build_object('kind', 'staging', 'noWarehouse', true, 'org', :org::uuid),
  '1: the organization-level bucket is a Staging location with no warehouse, in the org (0194)');

set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'before', public.order_readiness_facts(:ord);
reset role;

select is(
  (select pg_temp.putaway_facts(r, :item) from fx where who = 'before'),
  jsonb_build_object(
    'itemWarehouseId', :whA::text,
    'here', jsonb_build_object('rack', 0, 'site', 0, 'unplaced', 0, 'staging', 6),
    'sources', jsonb_build_array(jsonb_build_object('locationId', :'stOrg'::text, 'quantity', 6))),
  '2: readiness counts the bucket''s units as here.staging for an order in the item''s warehouse and lists the bucket as the Staging source to put away');

-- ═══ 3-6. Who may not move them ═══════════════════════════════════════════
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :vwrA;
select throws_ok(
  format($$select public.transfer_stock(%L, %L, %L, 6, 'b38')$$, :item, :'stOrg', :rackA),
  '42501', 'forbidden',
  '3: a viewer cannot move the bucket''s units (no stock:transfer, 0395)');
set local "request.jwt.claim.sub" to :stfB;
select throws_ok(
  format($$select public.transfer_stock(%L, %L, %L, 6, 'b38')$$, :item, :'stOrg', :rackB),
  'P0002', 'item_not_found',
  '4: staff who work only in warehouse B cannot take warehouse A''s item out of the bucket, even into their own rack');
set local "request.jwt.claim.sub" to :stfA;
select throws_ok(
  format($$select public.transfer_stock(%L, %L, %L, 6, 'b38')$$, :item, :'stOrg', :rackB),
  '42501', 'forbidden',
  '5: staff who work in A cannot put the bucket''s units into warehouse B''s rack (0365)');
reset role;

select is(
  pg_temp.where_units(:item, :'stOrg', :rackA, :rackB)
    || '|' || (select count(*) from public.stock_movements
                where item_id = :item and id not in (select id from mv0)),
  '6|0|0|6|0',
  '6: the refusals moved nothing and wrote no ledger row');

-- ═══ 7-10. The put-away ══════════════════════════════════════════════════
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :stfA;
select lives_ok(
  format($$select public.transfer_stock(%L, %L, %L, 6, 'b38 put-away')$$, :item, :'stOrg', :rackA),
  '7: staff who work in A move the bucket''s units into warehouse A''s rack');
reset role;

select is(
  pg_temp.where_units(:item, :'stOrg', :rackA, :rackB),
  '0|6|0|6',
  '8: the bucket holds 0 and A''s rack 6; the on-hand quantity is unchanged');

select is(
  (select jsonb_agg(jsonb_build_object(
            'type', m.movement_type, 'change', trim_scale(m.quantity_change),
            'previous', trim_scale(m.previous_quantity), 'new', trim_scale(m.new_quantity),
            'moved', trim_scale(m.moved_quantity), 'from', m.from_location_id,
            'to', m.to_location_id, 'by', m.user_id, 'notes', m.notes))
     from public.stock_movements m
    where m.item_id = :item and m.id not in (select id from mv0)),
  jsonb_build_array(jsonb_build_object(
    'type', 'transfer', 'change', 0, 'previous', 6, 'new', 6, 'moved', 6,
    'from', :'stOrg'::uuid, 'to', :rackA::uuid, 'by', :stfA::uuid, 'notes', 'b38 put-away')),
  '9: one transfer ledger row: no change on hand, 6 moved, from the bucket to the rack, by the member who placed it');

set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'after', public.order_readiness_facts(:ord);
reset role;

select is(
  (select pg_temp.putaway_facts(r, :item) from fx where who = 'after'),
  jsonb_build_object(
    'itemWarehouseId', :whA::text,
    'here', jsonb_build_object('rack', 6, 'site', 0, 'unplaced', 0, 'staging', 0),
    'sources', '[]'::jsonb),
  '10: readiness after the put-away: the six are on A''s rack, nothing is left in Staging to put away');

-- ═══ 11-12. A manager is not limited ═════════════════════════════════════
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
select lives_ok(
  format($$select public.transfer_stock(%L, %L, %L, 2, 'b38 manager')$$, :item2, :'stOrg', :rackB),
  '11: a manager may place the bucket''s units in any warehouse''s rack (0365)');
reset role;

select is(
  pg_temp.where_units(:item2, :'stOrg', :rackA, :rackB)
    || '|' || (select string_agg(concat_ws(',', m.movement_type, trim_scale(m.moved_quantity),
                                           m.from_location_id = :'stOrg'::uuid,
                                           m.to_location_id = :rackB::uuid,
                                           m.user_id = :mgr::uuid), ';')
                 from public.stock_movements m
                where m.item_id = :item2 and m.id not in (select id from mv0)),
  '0|0|2|2|transfer,2,t,t,t',
  '12: and that move is one transfer row by the manager, from the bucket to B''s rack');

select * from finish();
rollback;
