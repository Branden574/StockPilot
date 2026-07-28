-- supabase/tests/0300_product_group_org_immutable.test.sql
--
-- Proves 0300: product_groups.organization_id cannot be moved out from under
-- its variants, and nothing else about updating a group changed.
--
-- Assertion index (10):
--    1-3  the guard exists and is wired: the function, the BEFORE UPDATE
--         trigger, and its WHEN clause (so an ordinary group edit never enters
--         the function)
--    4    the gap 0298 documented is CLOSED: a manager in both orgs can no
--         longer re-home a group
--    5    the same UPDATE with organization_id left alone still succeeds —
--         the guard is not a blanket update lock (anti-vacuity for 4)
--    6-7  the group_key and every other identity column are still freely
--         editable, and the value really lands
--    8    setting organization_id to its OWN value is a no-op, not an error
--         (an ORM that echoes every column back must not be broken)
--    9    service_role is guarded too — there is no legitimate re-home
--   10    the variants a re-home would have orphaned are still pointing at a
--         group in their own org (the invariant the guard exists to protect)
--
-- Namespace: 9e300000. Wrapped in begin/rollback - nothing leaks.

begin;

select plan(10);

\set org    '\'9e300000-0000-0000-0000-000000000001\''
\set orgB   '\'9e300000-0000-0000-0000-000000000002\''
\set usr    '\'9e300000-0000-0000-0000-000000000003\''
\set wh     '\'9e300000-0000-0000-0000-000000000004\''
\set grp    '\'9e300000-0000-0000-0000-000000000005\''
\set itm    '\'9e300000-0000-0000-0000-000000000006\''

insert into auth.users (id, email) values
  (:usr, 'u-0300@example.test')
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:org,  'Sports 0300 Org', 'sports-0300-org'),
  (:orgB, 'Other 0300 Org',  'other-0300-org')
  on conflict (id) do nothing;
-- The exact shape the 0298 note called out: MANAGER IN BOTH ORGS. Without that
-- membership the RLS policy would refuse first and assertion 4 would pass
-- vacuously, proving nothing about the trigger.
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org,  :usr, 'manager', now()),
  (:orgB, :usr, 'manager', now())
  on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code) values
  (:wh, :org, 'WH 0300', 'WH0300')
  on conflict (id) do nothing;

insert into public.product_groups
  (id, organization_id, subcategory_key, name, brand, model, group_key, default_counting_unit)
  values (:grp, :org, 'shoes', 'Nike Pegasus 41', 'Nike', 'Pegasus 41',
          'shoes|nike|pegasus 41||', 'pair');

-- A variant attached to the group. This is what a re-home would strand.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type,
   group_id, variant_size, variant_key)
  values (:itm, :org, :wh, 'PEG41-10', 'Nike Pegasus 41 - 10', 4, 'active', 'none',
          :grp, '10', 'size=10');

-- ── 1-3. The guard is wired ─────────────────────────────────────────────────
select has_function(
  'public', 'tg_pin_product_group_org',
  'the organization_id-immutability trigger function exists');

select is(
  (select count(*)::int from pg_trigger
    where tgrelid = 'public.product_groups'::regclass
      and tgname = 'product_groups_pin_org'
      and not tgisinternal),
  1,
  'product_groups_pin_org is attached to product_groups');

-- BEFORE UPDATE + a WHEN clause, so an ordinary edit is filtered at the
-- executor and never pays for a function call.
select is(
  (select pg_get_triggerdef(oid) from pg_trigger
    where tgrelid = 'public.product_groups'::regclass
      and tgname = 'product_groups_pin_org'),
  'CREATE TRIGGER product_groups_pin_org BEFORE UPDATE ON public.product_groups '
  || 'FOR EACH ROW WHEN ((new.organization_id IS DISTINCT FROM old.organization_id)) '
  || 'EXECUTE FUNCTION tg_pin_product_group_org()',
  'the trigger is BEFORE UPDATE and only fires when organization_id actually changes');

-- ── 4-5. The 0298 gap is closed, and only that ──────────────────────────────
set local "request.jwt.claim.sub" to '9e300000-0000-0000-0000-000000000003';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select throws_ok(
  format('update public.product_groups set organization_id = %L where id = %L',
         '9e300000-0000-0000-0000-000000000002',
         '9e300000-0000-0000-0000-000000000005'),
  '42501',
  null,
  'a manager in BOTH orgs still cannot move a group out from under its variants');

select lives_ok(
  format('update public.product_groups set name = %L where id = %L',
         'Nike Pegasus 41 (renamed)',
         '9e300000-0000-0000-0000-000000000005'),
  'an ordinary group edit is untouched by the guard');

-- ── 6-7. Identity columns stay editable, and the write lands ────────────────
select lives_ok(
  format('update public.product_groups set group_key = %L, style_number = %L where id = %L',
         'shoes|nike|pegasus 41|fd9999|',
         'FD9999',
         '9e300000-0000-0000-0000-000000000005'),
  'group_key is still recomputable - the guard pins the ORG, not the identity');

select is(
  (select group_key || '/' || name from public.product_groups
    where id = '9e300000-0000-0000-0000-000000000005'),
  'shoes|nike|pegasus 41|fd9999|/Nike Pegasus 41 (renamed)',
  'both edits really persisted (assertions 5 and 6 are not vacuous)');

-- ── 8. Echoing the same org back is a no-op, not an error ───────────────────
select lives_ok(
  format('update public.product_groups set organization_id = %L, name = %L where id = %L',
         '9e300000-0000-0000-0000-000000000001',
         'Nike Pegasus 41 (again)',
         '9e300000-0000-0000-0000-000000000005'),
  'writing organization_id back as ITSELF is allowed - IS DISTINCT FROM, not "was mentioned"');

reset role;

-- ── 9. service_role is guarded too ──────────────────────────────────────────
set local role service_role;
select throws_ok(
  format('update public.product_groups set organization_id = %L where id = %L',
         '9e300000-0000-0000-0000-000000000002',
         '9e300000-0000-0000-0000-000000000005'),
  '42501',
  null,
  'service_role cannot re-home a group either - there is no legitimate re-home');
reset role;

-- ── 10. The invariant the guard protects ────────────────────────────────────
select is(
  (select count(*)::int
     from public.inventory_items i
     join public.product_groups g on g.id = i.group_id
    where i.id = '9e300000-0000-0000-0000-000000000006'
      and i.organization_id = g.organization_id),
  1,
  'the variant and its group still live in the SAME org after every attempt');

select * from finish();
rollback;
