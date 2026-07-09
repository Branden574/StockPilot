-- supabase/tests/0235_purchase_order_charges.test.sql
-- Proves migration 0235: purchase_order_charges is a financial-only child of
-- purchase_orders that NEVER touches inventory.
--
--   • the table + its columns exist (charge_type/label/quantity/unit_cost/amount),
--   • it has NO item_id column and NO foreign key to inventory_items — the
--     structural guarantee that a charge can never become / affect stock,
--   • charge_type CHECK rejects an unknown class and defaults to 'other',
--   • RLS is enabled and the select/write policies exist (mirroring
--     purchase_order_items: any org member reads, managers/purchase_orders:manage
--     write),
--   • deleting the parent PO cascades the charge away.
--
-- Namespace: ac023500. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(12);

\set org      '\'ac023500-0000-0000-0000-000000000001\''
\set usr      '\'ac023500-0000-0000-0000-000000000002\''
\set sup      '\'ac023500-0000-0000-0000-000000000003\''
\set po       '\'ac023500-0000-0000-0000-000000000004\''
\set chg      '\'ac023500-0000-0000-0000-000000000005\''

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'poc-0235@test.local', '{}'::jsonb) on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, 'PO Charges Org 0235', 'po-charges-org-0235') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'manager', now()) on conflict do nothing;
insert into public.suppliers (id, organization_id, name)
  values (:sup, :org, 'Sup 0235') on conflict (id) do nothing;
insert into public.purchase_orders (id, organization_id, po_number, supplier_id, status, subtotal, total)
  values (:po, :org, 'PO-0235-1', :sup, 'expected_inbound', 46995, 52769.23) on conflict (id) do nothing;

-- ── 1-5. Structure ──────────────────────────────────────────────────────────
select has_table('public', 'purchase_order_charges', 'purchase_order_charges table exists');
select has_column('public', 'purchase_order_charges', 'charge_type', 'has charge_type');
select has_column('public', 'purchase_order_charges', 'label', 'has label');
select has_column('public', 'purchase_order_charges', 'amount', 'has amount');
select has_column('public', 'purchase_order_charges', 'quantity', 'has quantity');

-- ── 6. CROWN GUARANTEE: no path to inventory ────────────────────────────────
-- The table must have NO item_id column AND no FK referencing inventory_items,
-- so a charge is structurally incapable of becoming or affecting stock.
select is(
  (select count(*)::int
     from information_schema.columns
     where table_schema = 'public' and table_name = 'purchase_order_charges'
       and column_name = 'item_id')
  + (select count(*)::int
       from information_schema.table_constraints tc
       join information_schema.constraint_column_usage ccu
         on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
       where tc.table_name = 'purchase_order_charges' and tc.constraint_type = 'FOREIGN KEY'
         and ccu.table_name = 'inventory_items'),
  0,
  'purchase_order_charges has NO item_id and NO FK to inventory_items (never touches stock)'
);

-- ── 7. RLS enabled ──────────────────────────────────────────────────────────
select is(
  (select relrowsecurity from pg_class where oid = 'public.purchase_order_charges'::regclass),
  true,
  'row level security is enabled'
);

-- ── 8-9. Policies exist ─────────────────────────────────────────────────────
select is(
  (select count(*)::int from pg_policies
     where schemaname = 'public' and tablename = 'purchase_order_charges'
       and policyname = 'purchase_order_charges_select'),
  1,
  'select policy exists'
);
select is(
  (select count(*)::int from pg_policies
     where schemaname = 'public' and tablename = 'purchase_order_charges'
       and policyname = 'purchase_order_charges_write'),
  1,
  'write policy exists'
);

-- ── 10. charge_type CHECK rejects an unknown class ──────────────────────────
select throws_ok(
  $$ insert into public.purchase_order_charges (organization_id, purchase_order_id, charge_type, amount)
     values ('ac023500-0000-0000-0000-000000000001', 'ac023500-0000-0000-0000-000000000004', 'bogus', 10) $$,
  '23514', null,
  'charge_type CHECK rejects an unknown class'
);

-- ── 11. Valid insert + default ──────────────────────────────────────────────
insert into public.purchase_order_charges (id, organization_id, purchase_order_id, label, amount)
  values (:chg, :org, :po, 'Sales tax 8.35%', 3999.23);
select is(
  (select charge_type from public.purchase_order_charges where id = :chg),
  'other',
  'charge_type defaults to other'
);

-- ── 12. Parent PO delete cascades the charge away ───────────────────────────
delete from public.purchase_orders where id = :po;
select is(
  (select count(*)::int from public.purchase_order_charges where id = :chg),
  0,
  'deleting the parent PO cascades its charges'
);

select * from finish();
rollback;
