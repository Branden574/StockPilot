-- supabase/tests/0242_inventory_updated_at_ignores_embedding.test.sql
-- Proves migration 0242: a background embedding/search_vector write does NOT
-- bump inventory_items.updated_at (so it no longer looks like a human edit),
-- while every real field edit still bumps it.
--
--   • the updated_at trigger is wired to tg_inventory_items_set_updated_at,
--   • an embedding-only UPDATE preserves the prior updated_at,
--   • a real edit (name) bumps updated_at to now,
--   • name + embedding together still bumps (a real change is present),
--   • re-embedding an already-embedded row still preserves updated_at.
--
-- Namespace: ab024200. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(6);

\set org '\'ab024200-0000-0000-0000-000000000001\''
\set usr '\'ab024200-0000-0000-0000-000000000002\''
\set wh  '\'ab024200-0000-0000-0000-000000000003\''
\set i1  '\'ab024200-0000-0000-0000-000000000011\''
\set i2  '\'ab024200-0000-0000-0000-000000000012\''
\set i3  '\'ab024200-0000-0000-0000-000000000013\''

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixtures (seeded as superuser — RLS is NOT active during this block).
-- Each item is seeded with a fixed PAST updated_at so a bump is unambiguous.
-- (INSERT does not fire the BEFORE UPDATE trigger, so the seed value sticks.)
-- ─────────────────────────────────────────────────────────────────────────────

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'emb-0242@test.local', '{}'::jsonb) on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values (:org, 'Embedding Org 0242', 'embedding-org-0242') on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'manager', now()) on conflict do nothing;

insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'Emb WH 0242', 'WH-EMB-0242', 'active') on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, updated_at)
  values
  (:i1, :org, :wh, 'SP-EMB-1-0242', 'Item one',   5, 'active', 'none', '2020-01-01 00:00:00+00'),
  (:i2, :org, :wh, 'SP-EMB-2-0242', 'Item two',   5, 'active', 'none', '2020-01-01 00:00:00+00'),
  (:i3, :org, :wh, 'SP-EMB-3-0242', 'Item three', 5, 'active', 'none', '2020-01-01 00:00:00+00');

-- 1. The trigger is wired to the new embedding-aware function.
select is(
  (select p.proname::text
     from pg_trigger t join pg_proc p on p.oid = t.tgfoid
     where t.tgrelid = 'public.inventory_items'::regclass
       and t.tgname = 'inventory_items_set_updated_at'),
  'tg_inventory_items_set_updated_at',
  'inventory_items updated_at trigger uses the embedding-aware function'
);

-- 2. An embedding-only write PRESERVES updated_at.
update public.inventory_items
   set embedding = (select ('[' || string_agg('0.001', ',') || ']')::vector from generate_series(1, 1536))
 where id = :i1;

select is(
  (select updated_at from public.inventory_items where id = :i1),
  '2020-01-01 00:00:00+00'::timestamptz,
  'embedding-only write does NOT bump updated_at'
);

-- 3. A real field edit (name) BUMPS updated_at.
update public.inventory_items set name = 'Item two renamed' where id = :i2;

select isnt(
  (select updated_at from public.inventory_items where id = :i2),
  '2020-01-01 00:00:00+00'::timestamptz,
  'a real field edit bumps updated_at'
);

select ok(
  (select updated_at from public.inventory_items where id = :i2) >= '2020-01-02'::timestamptz,
  'the bumped updated_at is current (well after the seeded past value)'
);

-- 4. name + embedding together still BUMPS (a real change is present).
update public.inventory_items
   set name = 'Item three renamed',
       embedding = (select ('[' || string_agg('0.002', ',') || ']')::vector from generate_series(1, 1536))
 where id = :i3;

select isnt(
  (select updated_at from public.inventory_items where id = :i3),
  '2020-01-01 00:00:00+00'::timestamptz,
  'name + embedding together bumps updated_at (a real change wins)'
);

-- 5. Re-embedding an already-embedded row (embedding → different vector) still preserves.
update public.inventory_items
   set embedding = (select ('[' || string_agg('0.003', ',') || ']')::vector from generate_series(1, 1536))
 where id = :i1;

select is(
  (select updated_at from public.inventory_items where id = :i1),
  '2020-01-01 00:00:00+00'::timestamptz,
  're-embedding (embedding → new vector) still does NOT bump updated_at'
);

select * from finish();
rollback;
