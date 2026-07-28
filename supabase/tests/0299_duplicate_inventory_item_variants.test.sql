-- supabase/tests/0299_duplicate_inventory_item_variants.test.sql
--
-- Proves 0299: a duplicated variant stays inside its product group, variant
-- attributes are inheritable AND overridable AND explicitly clearable, the
-- columns 0125 silently dropped now survive, an ungrouped legacy item is
-- untouched, and every 0125 behaviour (Model B placement uniqueness, the
-- ledger row, the two error codes, cross-org RLS) is intact.
--
-- Assertion index (51):
--    1-2   grants survive the re-body: authenticated keeps EXECUTE, anon has none
--    3-19  duplicate INHERITING everything: group membership, all nine variant
--          columns, the four pre-existing gaps now closed, the dual-write
--          custom_fields.size, and the two lifecycle columns a copy must NOT
--          inherit (public_visibility, awaiting_first_receipt)
--   20-24  duplicate OVERRIDING the size - the "add the next size" flow
--   25-28  duplicate CLEARING a field with an explicit JSON null
--   29-31  the group roll-up after four placements: derived, never stored
--   32-36  an UNGROUPED LEGACY item duplicates to an all-NULL variant row and
--          keeps its custom_fields.size / model_number / is_rental
--   38-40  Model B (0234) unchanged: same SKU at the same placement still
--          23505s, at a different bin_location still inserts - and THAT
--          placement duplicate is still inside the product group
--   41-44  0125 behaviours: the ledger row and its invariant, sku_required,
--          original_not_found
--   45-47  cross-org RLS: a foreign manager cannot duplicate my item (with a
--          positive control), and no row leaked into their org
--   48     not_authenticated still fires when auth.uid() is absent
--   49-51  LEDGER GUARD: a negative p_overrides.quantity is REFUSED, leaves no
--          row behind, and zero is still accepted (the guard refuses negative,
--          not falsy)
--
-- (The 1-37 spans above are the original author's grouping and were already
-- approximate; the 38-51 spans were re-pinned against the real numbering when
-- 49-51 were added.)
--
-- Namespace: d0299000. Wrapped in begin/rollback - nothing leaks.

begin;

select plan(51);

\set org   '\'d0299000-0000-0000-0000-000000000001\''
\set usr   '\'d0299000-0000-0000-0000-000000000002\''
\set wh    '\'d0299000-0000-0000-0000-000000000003\''
\set grp   '\'d0299000-0000-0000-0000-000000000004\''
\set src   '\'d0299000-0000-0000-0000-000000000005\''
\set leg   '\'d0299000-0000-0000-0000-000000000006\''
\set orgB  '\'d0299000-0000-0000-0000-000000000007\''
\set mgrB  '\'d0299000-0000-0000-0000-000000000008\''
\set whB   '\'d0299000-0000-0000-0000-000000000009\''
\set srcB  '\'d0299000-0000-0000-0000-000000000010\''

-- organizations.slug and warehouses.code are NOT NULL with no default.
insert into auth.users (id, email) values
  (:usr,  'u-0299@example.test'),
  (:mgrB, 'mgrb-0299@example.test')
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:org,  'Dup 0299 Org',   'dup-0299-org'),
  (:orgB, 'Other 0299 Org', 'other-0299-org')
  on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org,  :usr,  'manager', now()),
  (:orgB, :mgrB, 'manager', now())
  on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code) values
  (:wh,  :org,  'WH 0299',   'WH0299'),
  (:whB, :orgB, 'WH 0299 B', 'WH0299B')
  on conflict (id) do nothing;

insert into public.product_groups (id, organization_id, name, group_key, default_counting_unit)
  values (:grp, :org, 'Pegasus 41', 'shoes|nike|pegasus 41', 'pair')
  on conflict (id) do nothing;

-- The source variant. Every column asserted below is set to a NON-DEFAULT
-- value on purpose: is_rental/expiry_policy/public_visibility/
-- awaiting_first_receipt all have DB defaults, so a fixture left at the
-- default would make the corresponding assertion vacuous.
--
-- custom_fields.size is deliberately STALE ('10-OLD' against a variant_size of
-- '10'). That is the real drift state of the dual-write window, and it is what
-- makes assertions 19/24/27 bite: a copy that merely inherited the blob would
-- carry '10-OLD' forward, and a copy that never removed the key would keep it
-- after an explicit clear.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status,
   tracking_type, unit_of_measure, item_type, custom_fields,
   group_id, variant_size, variant_size_original, variant_size_system,
   variant_width, variant_fit, variant_color, jersey_number, player_name,
   variant_key,
   model_number, shelf_life_days, expiry_policy,
   public_visibility, awaiting_first_receipt)
  values (:src, :org, :wh, 'PEG41-10', 'Nike Pegasus 41 - 10', 6, 'active',
          'none', 'pair', 'product', '{"size": "10-OLD"}'::jsonb,
          :grp, '10', 'US 10', 'US_MENS',
          'D', 'regular', 'Black/White', '07', 'A. Rosas',
          'size=10|system=US_MENS',
          'FD2722-001', 400, 'block',
          'public', true)
  on conflict (id) do nothing;

-- A pre-Phase-3 item: ungrouped, no variant columns, its only size living in
-- custom_fields.size, a rental with a model number. Stands in for every item
-- in every existing org.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status,
   tracking_type, item_type, custom_fields, model_number, is_rental)
  values (:leg, :org, :wh, 'LEG-1', 'Legacy rental widget', 4, 'active',
          'none', 'product', '{"size": "XL"}'::jsonb, 'LEG-MODEL-1', true)
  on conflict (id) do nothing;

-- Org B's own item, so the cross-org refusal below has a positive control.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status,
   tracking_type)
  values (:srcB, :orgB, :whB, 'ORGB-1', 'Org B widget', 2, 'active', 'none')
  on conflict (id) do nothing;

-- ── 1-2. The grants survive `create or replace` ─────────────────────────────
select ok(
  has_function_privilege('authenticated',
    'public.duplicate_inventory_item(uuid, jsonb)', 'EXECUTE'),
  'authenticated can still EXECUTE duplicate_inventory_item (grant survives the re-body)');

select ok(
  not has_function_privilege('anon',
    'public.duplicate_inventory_item(uuid, jsonb)', 'EXECUTE'),
  'anon still cannot EXECUTE it - the revoke survives the re-body too');

set local "request.jwt.claim.sub" to 'd0299000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ── 3-19. Duplicate INHERITING every variant attribute ──────────────────────
select lives_ok(
  $$ select public.duplicate_inventory_item(
       'd0299000-0000-0000-0000-000000000005'::uuid,
       jsonb_build_object('sku', 'PEG41-10-B', 'quantity', 2)) $$,
  'a grouped variant duplicates cleanly for its owning manager');

select is(
  (select group_id from public.inventory_items
    where organization_id = :org and sku = 'PEG41-10-B'),
  :grp::uuid,
  'a duplicated variant stays inside the SAME product group');

select is(
  (select variant_size from public.inventory_items
    where organization_id = :org and sku = 'PEG41-10-B'),
  '10',
  'variant_size is inherited when not overridden');

select is(
  (select variant_size_original from public.inventory_items
    where organization_id = :org and sku = 'PEG41-10-B'),
  'US 10',
  'the ORIGINAL imported size text is carried through the copy');

select is(
  (select variant_size_system from public.inventory_items
    where organization_id = :org and sku = 'PEG41-10-B'),
  'US_MENS',
  'variant_size_system is inherited');

select is(
  (select array[variant_width, variant_fit, variant_color]
     from public.inventory_items
    where organization_id = :org and sku = 'PEG41-10-B'),
  array['D', 'regular', 'Black/White'],
  'width, fit and colour all survive the copy');

-- Leading zeroes are the whole point of jersey_number being TEXT. A copy that
-- round-tripped through a numeric type would land '7'.
select is(
  (select jersey_number from public.inventory_items
    where organization_id = :org and sku = 'PEG41-10-B'),
  '07',
  'jersey_number is inherited BYTE-IDENTICALLY - the leading zero survives');

select is(
  (select player_name from public.inventory_items
    where organization_id = :org and sku = 'PEG41-10-B'),
  'A. Rosas',
  'player_name is inherited');

select is(
  (select variant_key from public.inventory_items
    where organization_id = :org and sku = 'PEG41-10-B'),
  'size=10|system=US_MENS',
  'variant_key is inherited when not overridden');

-- Pre-existing gaps closed by 0299.
select is(
  (select model_number from public.inventory_items
    where organization_id = :org and sku = 'PEG41-10-B'),
  'FD2722-001',
  'model_number now survives a duplicate (0125 dropped it - pre-existing bug, closed)');

select is(
  (select shelf_life_days from public.inventory_items
    where organization_id = :org and sku = 'PEG41-10-B'),
  400,
  'shelf_life_days now survives a duplicate');

select is(
  (select expiry_policy from public.inventory_items
    where organization_id = :org and sku = 'PEG41-10-B'),
  'block',
  'expiry_policy now survives a duplicate (default is warn, so this is not vacuous)');

-- Columns a duplicate must NOT inherit.
select is(
  (select public_visibility from public.inventory_items
    where organization_id = :org and sku = 'PEG41-10-B'),
  'internal_only',
  'the copy is NOT published even though the original is public - visibility is a fresh decision');

select is(
  (select awaiting_first_receipt from public.inventory_items
    where organization_id = :org and sku = 'PEG41-10-B'),
  false,
  'awaiting_first_receipt is NOT inherited - the copy has its own lifecycle');

-- 0125 behaviours the re-body must not disturb.
select is(
  (select array[unit_of_measure, tracking_type, item_type, status]
     from public.inventory_items
    where organization_id = :org and sku = 'PEG41-10-B'),
  array['pair', 'none', 'product', 'active'],
  'uom (pair), tracking_type, item_type and status still copy across (0125 behaviour)');

select is(
  (select quantity_on_hand from public.inventory_items
    where organization_id = :org and sku = 'PEG41-10-B'),
  2::numeric,
  'the override quantity - not the original 6 - lands on the new row');

-- Dual-write window: custom_fields.size tracks the first-class column.
select is(
  (select custom_fields->>'size' from public.inventory_items
    where organization_id = :org and sku = 'PEG41-10-B'),
  '10',
  'custom_fields.size is REWRITTEN from variant_size, replacing the stale 10-OLD (dual-write window)');

-- ── 20-24. Duplicate OVERRIDING the size ────────────────────────────────────
select lives_ok(
  $$ select public.duplicate_inventory_item(
       'd0299000-0000-0000-0000-000000000005'::uuid,
       jsonb_build_object(
         'sku', 'PEG41-11',
         'quantity', 3,
         'variant_size', '11',
         'variant_size_original', 'US 11',
         'variant_key', 'FORGED|by=client')) $$,
  'duplicating size 10 as size 11 succeeds in ONE call');

select is(
  (select variant_key from public.inventory_items
    where organization_id = :org and sku = 'PEG41-11'),
  null,
  'client-supplied variant_key is IGNORED and the stale key cleared on attribute override');

select is(
  (select variant_size from public.inventory_items
    where organization_id = :org and sku = 'PEG41-11'),
  '11',
  'variant_size can be overridden - duplicating size 10 as size 11');

select is(
  (select group_id from public.inventory_items
    where organization_id = :org and sku = 'PEG41-11'),
  :grp::uuid,
  'overriding the size does NOT spawn a new group');

select is(
  (select variant_size_system from public.inventory_items
    where organization_id = :org and sku = 'PEG41-11'),
  'US_MENS',
  'attributes NOT named in the override are still inherited alongside one that is');

select is(
  (select custom_fields->>'size' from public.inventory_items
    where organization_id = :org and sku = 'PEG41-11'),
  '11',
  'custom_fields.size follows the OVERRIDE, not the original');

-- ── 25-28. Explicit JSON null CLEARS a field ────────────────────────────────
-- `p_overrides ? 'key'` rather than coalesce: absent inherits, present-but-null
-- clears. A coalesce-based implementation cannot tell the two apart and would
-- silently re-inherit here.
select lives_ok(
  $$ select public.duplicate_inventory_item(
       'd0299000-0000-0000-0000-000000000005'::uuid,
       jsonb_build_object('sku', 'PEG41-CLEAR', 'quantity', 1)
         || '{"variant_size": null, "jersey_number": null}'::jsonb) $$,
  'a duplicate that explicitly clears two variant fields succeeds');

select is(
  (select jersey_number from public.inventory_items
    where organization_id = :org and sku = 'PEG41-CLEAR'),
  null::text,
  'an explicit JSON null CLEARS jersey_number instead of inheriting 07');

select is(
  (select coalesce(variant_size, '<null>') || '/' || (custom_fields ? 'size')::text
     from public.inventory_items
    where organization_id = :org and sku = 'PEG41-CLEAR'),
  '<null>/false',
  'clearing variant_size also drops custom_fields.size - the dual-write never goes stale');

select is(
  (select player_name from public.inventory_items
    where organization_id = :org and sku = 'PEG41-CLEAR'),
  'A. Rosas',
  'clearing two fields does not clear their neighbours');

-- ── 29-31. The group roll-up over four placements ───────────────────────────
-- Four rows now hang off the group: the source (size=10), its inherited copy
-- (same variant_key) plus the size-11 copy. Because the size-11 duplicate
-- overrode a variant attribute, the RPC CLEARED its variant_key (identity is
-- server-computed; a copied key would be stale) — so only the size-10 key is
-- present until the service recomputes. variant_count counts DISTINCT non-null
-- keys: 1, not one per placement and not 2.
select is(
  (select variant_count::int from public.product_group_rollups
    where group_id = :grp),
  1,
  'variant_count is DISTINCT non-null variant_key - cleared key not counted');

select is(
  (select placement_count::int from public.product_group_rollups
    where group_id = :grp),
  4,
  'placement_count counts the placements: original + three duplicates');

select is(
  (select total_quantity from public.product_group_rollups
    where group_id = :grp),
  12::numeric,
  'the group total 6+2+3+1 is DERIVED at read time - product_groups stores no quantity');

-- ── 32-36. An UNGROUPED LEGACY item is untouched ────────────────────────────
select lives_ok(
  $$ select public.duplicate_inventory_item(
       'd0299000-0000-0000-0000-000000000006'::uuid,
       jsonb_build_object('sku', 'LEG-1-B', 'quantity', 1)) $$,
  'a plain pre-Phase-3 item still duplicates (the shared surface is intact)');

select is(
  (select coalesce(group_id::text, '-') || '/' ||
          coalesce(variant_size, '-') || '/' ||
          coalesce(variant_size_original, '-') || '/' ||
          coalesce(variant_size_system, '-') || '/' ||
          coalesce(variant_width, '-') || '/' ||
          coalesce(variant_fit, '-') || '/' ||
          coalesce(variant_color, '-') || '/' ||
          coalesce(jersey_number, '-') || '/' ||
          coalesce(player_name, '-') || '/' ||
          coalesce(variant_key, '-')
     from public.inventory_items
    where organization_id = :org and sku = 'LEG-1-B'),
  '-/-/-/-/-/-/-/-/-/-',
  'a duplicate of an UNGROUPED item stays all-NULL across group_id and all nine variant columns');

select is(
  (select custom_fields->>'size' from public.inventory_items
    where organization_id = :org and sku = 'LEG-1-B'),
  'XL',
  'a legacy custom_fields.size is PRESERVED - the dual-write never deletes a size the column never had');

select is(
  (select model_number from public.inventory_items
    where organization_id = :org and sku = 'LEG-1-B'),
  'LEG-MODEL-1',
  'model_number survives on the legacy path too');

select is(
  (select is_rental from public.inventory_items
    where organization_id = :org and sku = 'LEG-1-B'),
  true,
  'a duplicated rental asset is STILL a rental (default is false, so this is not vacuous)');

-- ── 37-39. Model B (0234) placement uniqueness is unchanged ─────────────────
-- The RPC passes the SKU straight through; (organization_id, sku, charter_id,
-- bin_location) NULLS NOT DISTINCT still decides what is a legal placement.
select throws_ok(
  $$ select public.duplicate_inventory_item(
       'd0299000-0000-0000-0000-000000000005'::uuid,
       jsonb_build_object('sku', 'PEG41-10', 'quantity', 1)) $$,
  '23505',
  null,
  'the SAME sku at the SAME (null) bin_location still 23505s - Model B unchanged');

select lives_ok(
  $$ select public.duplicate_inventory_item(
       'd0299000-0000-0000-0000-000000000005'::uuid,
       jsonb_build_object('sku', 'PEG41-10', 'quantity', 1,
                          'bin_location', '22-A', 'rack_number', '22',
                          'rack_row', 'A')) $$,
  'the SAME sku at a DIFFERENT bin_location still inserts - Model B unchanged');

select is(
  (select group_id from public.inventory_items
    where organization_id = :org and sku = 'PEG41-10' and bin_location = '22-A'),
  :grp::uuid,
  'THE HEADLINE: a Model B placement duplicate is still inside its product group');

-- ── 40-43. 0125 behaviours intact ───────────────────────────────────────────
select is(
  (select count(*)::int from public.stock_movements
    where item_id = (select id from public.inventory_items
                      where organization_id = :org and sku = 'PEG41-11')
      and movement_type = 'initial'
      and reference_type = 'duplicate'
      and reference_id = :src),
  1,
  'LEDGER: the duplicate wrote exactly one initial stock_movement pointing back at the original');

select is(
  (select sum(m.quantity_change) from public.stock_movements m
    where m.item_id = (select id from public.inventory_items
                        where organization_id = :org and sku = 'PEG41-11')),
  (select quantity_on_hand from public.inventory_items
    where organization_id = :org and sku = 'PEG41-11'),
  'LEDGER INVARIANT: sum(quantity_change) equals quantity_on_hand on the new row');

select throws_ok(
  $$ select public.duplicate_inventory_item(
       'd0299000-0000-0000-0000-000000000005'::uuid,
       jsonb_build_object('quantity', 1)) $$,
  '22023',
  'sku_required',
  'a duplicate with no SKU is still rejected (0125 behaviour intact)');

select throws_ok(
  $$ select public.duplicate_inventory_item(
       'd0299000-0000-0000-0000-0000000000ff'::uuid,
       jsonb_build_object('sku', 'X-1', 'quantity', 1)) $$,
  'P0002',
  'original_not_found',
  'duplicating a non-existent item is still rejected (0125 behaviour intact)');

-- ── 44-46. Cross-org RLS still holds ────────────────────────────────────────
set local "request.jwt.claim.sub" to 'd0299000-0000-0000-0000-000000000008';

-- Positive control first, so the refusal below is a real refusal and not
-- "org B's manager cannot duplicate anything".
select lives_ok(
  $$ select public.duplicate_inventory_item(
       'd0299000-0000-0000-0000-000000000010'::uuid,
       jsonb_build_object('sku', 'ORGB-1-B', 'quantity', 1)) $$,
  'org B''s manager CAN duplicate org B''s own item');

select throws_ok(
  $$ select public.duplicate_inventory_item(
       'd0299000-0000-0000-0000-000000000005'::uuid,
       jsonb_build_object('sku', 'STOLEN-1', 'quantity', 1)) $$,
  'P0002',
  'original_not_found',
  'org B''s manager CANNOT duplicate org A''s item - RLS hides the source row');

reset role;

select is(
  (select count(*)::int from public.inventory_items
    where sku in ('STOLEN-1', 'PEG41-10-B') and organization_id = :orgB),
  0,
  'nothing from org A''s item landed in org B (checked with RLS off)');

-- ── 47. not_authenticated ───────────────────────────────────────────────────
set local "request.jwt.claim.sub" to '';

select throws_ok(
  $$ select public.duplicate_inventory_item(
       'd0299000-0000-0000-0000-000000000005'::uuid,
       jsonb_build_object('sku', 'NOAUTH-1', 'quantity', 1)) $$,
  '28000',
  'not_authenticated',
  'a context with no auth.uid() is still refused (0125 behaviour intact)');

-- ── 48-50. LEDGER GUARD: a negative quantity is refused ─────────────────────
-- This RPC is granted to `authenticated`, so it is reachable directly at
-- POST /rest/v1/rpc/duplicate_inventory_item with a hand-written p_overrides -
-- the service layer is the only SANCTIONED caller, not the only possible one.
--
-- The function writes quantity_on_hand = v_qty unconditionally but only writes
-- the stock_movements row `if v_qty > 0`, so {"quantity": -5} used to produce an
-- item at -5 on hand with an EMPTY ledger:
-- SUM(stock_movements.quantity_change) = 0 <> quantity_on_hand = -5. Nothing
-- else catches it - quantity_on_hand is numeric(14,4) not null default 0 with no
-- CHECK (0002:95).
set local "request.jwt.claim.sub" to 'd0299000-0000-0000-0000-000000000002';

select throws_ok(
  $$ select public.duplicate_inventory_item(
       'd0299000-0000-0000-0000-000000000005'::uuid,
       jsonb_build_object('sku', 'NEG-1', 'quantity', -5)) $$,
  '22023',
  'quantity_must_not_be_negative',
  'a negative p_overrides.quantity is REFUSED (it would desync sum(movements) from quantity_on_hand)');

select is(
  (select count(*)::int from public.inventory_items where sku = 'NEG-1'),
  0,
  'the refused duplicate left NO row behind - no item at -5 on hand with an empty ledger');

-- Anti-vacuity: the guard refuses NEGATIVE, not falsy. A zero-quantity duplicate
-- is the normal "copy the definition, count it later" case; it writes no movement
-- row and 0 = 0, so the invariant holds and it must still be allowed.
select lives_ok(
  $$ select public.duplicate_inventory_item(
       'd0299000-0000-0000-0000-000000000005'::uuid,
       jsonb_build_object('sku', 'ZERO-QTY-1', 'quantity', 0)) $$,
  'a ZERO-quantity duplicate is still allowed (the guard refuses negative, not falsy)');

select * from finish();
rollback;
