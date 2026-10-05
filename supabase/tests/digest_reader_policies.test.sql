-- supabase/tests/digest_reader_policies.test.sql
-- The weekly digest's reader restates these SELECT policies and helpers.
--
-- WHY. The weekly digest cron (apps/web/src/app/api/cron/weekly-digest) reads
-- with the service role, which bypasses row-level security. So it builds each
-- recipient's email with a TypeScript reader that restates the policies below
-- clause for clause (apps/web/src/server/services/digest.ts: canReadItem,
-- canReadPo, canReadWarehouse, digestReaderFor). If one of them changes and the
-- reader does not, the digest mails people rows the app would not show them, or
-- leaves out rows it would. The hashes pin the definitions the reader was
-- written against: these migrations and production were equal on 2026-10-05
-- (read-only catalog query).
--
-- A SNAPSHOT, ON PURPOSE, like postgrest_embed_relationships.test.sql: the
-- property is "the reader's input is still the database's truth", and a hash is
-- the cheapest exact comparison. The "any member" policies are pinned too: if
-- counts, lines, suppliers or locations become scoped, the reader must learn it.
--
-- IF THIS FAILS: read the new definition, change the reader in digest.ts (and
-- route.scope.test.ts, digest.test.ts) to match in the same pull request, then
-- re-pin the hash here:
--   select md5(qual) from pg_policies
--    where schemaname = 'public' and tablename = '<table>' and policyname = '<policy>';
--   select md5(pg_get_functiondef('public.<function>(<argument types>)'::regprocedure));
begin;
select plan(19);

-- ── SELECT policies ──────────────────────────────────────────────────
select is(
  (select md5(qual) from pg_policies
    where schemaname = 'public' and tablename = 'inventory_items' and policyname = 'inventory_items_select'),
  '474f2b2a999d8c903f2f0bb346080647',
  'inventory_items_select is the policy canReadItem restates'
);
select is(
  (select md5(qual) from pg_policies
    where schemaname = 'public' and tablename = 'purchase_orders' and policyname = 'purchase_orders_select'),
  '575afc0e329984413358887d9714ddca',
  'purchase_orders_select is the policy canReadPo restates'
);
select is(
  (select md5(qual) from pg_policies
    where schemaname = 'public' and tablename = 'warehouses' and policyname = 'warehouses_select'),
  '1532d88af95f886876a0469232ffa5ba',
  'warehouses_select is the policy canReadWarehouse restates'
);
select is(
  (select md5(qual) from pg_policies
    where schemaname = 'public' and tablename = 'cycle_counts' and policyname = 'cycle_counts_select'),
  'b3c4a78efa6f1987d04bbe80806f9272',
  'cycle_counts_select still lets any member read every count'
);
select is(
  (select md5(qual) from pg_policies
    where schemaname = 'public' and tablename = 'cycle_count_lines' and policyname = 'cycle_count_lines_select'),
  'a3986e39d54097dc3292a7803342c22f',
  'cycle_count_lines_select still lets any member read every line'
);
select is(
  (select md5(qual) from pg_policies
    where schemaname = 'public' and tablename = 'suppliers' and policyname = 'suppliers_select'),
  'bf4b5b540d2a135aa3dac4823adde71d',
  'suppliers_select still lets any member read supplier names'
);
select is(
  (select md5(qual) from pg_policies
    where schemaname = 'public' and tablename = 'locations' and policyname = 'locations_select'),
  '97a698478c9772a0f1459c44e3461071',
  'locations_select still lets any member read a destination location'
);

-- ── The helpers those policies call ──────────────────────────────────
select is(
  md5(pg_get_functiondef('public.rls_inv_read_full_warehouse_ids()'::regprocedure)),
  '6913e6e2ed3d1c800f0bc84084f7e6d2',
  'rls_inv_read_full_warehouse_ids: manager and up every warehouse, or an assignment with no charter'
);
select is(
  md5(pg_get_functiondef('public.rls_inv_read_assigned_warehouse_ids()'::regprocedure)),
  '52f05c449abcd6393ff298115568a051',
  'rls_inv_read_assigned_warehouse_ids: generic stock at any assigned warehouse'
);
select is(
  md5(pg_get_functiondef('public.rls_inv_read_warehouse_charter_ids()'::regprocedure)),
  '79053914841f6060d93a540b916d7dd1',
  'rls_inv_read_warehouse_charter_ids: the assigned (warehouse, charter) pairs'
);
select is(
  md5(pg_get_functiondef('public.rls_cat_unrestricted_org_ids()'::regprocedure)),
  '6bf49299aaf0272aad32a20c4491fe14',
  'rls_cat_unrestricted_org_ids: owner, admin, manager, staff, or a viewer with no category rows'
);
select is(
  md5(pg_get_functiondef('public.rls_cat_allowed_category_ids()'::regprocedure)),
  'a6ba01b9465096218f726737f49e8b85',
  'rls_cat_allowed_category_ids: a viewer''s assigned categories'
);
select is(
  md5(pg_get_functiondef('public.has_permission(uuid, text)'::regprocedure)),
  '49911efe30d3b2a39a69e9c295de78ec',
  'has_permission: owner, else user override, else role override, else role_default_permissions'
);
select is(
  md5(pg_get_functiondef('public.rls_orgs_with_permission(text)'::regprocedure)),
  '9ffffbb2fa11d0f9d6ee7b33ab22466d',
  'rls_orgs_with_permission: has_permission per accepted, unexpired membership'
);
select is(
  md5(pg_get_functiondef('public.has_org_role(uuid, text)'::regprocedure)),
  'c857b57e41136364db88d2f6539b2f4c',
  'has_org_role: the owner > admin > manager > staff > viewer floor'
);
select is(
  md5(pg_get_functiondef('public.is_org_member(uuid)'::regprocedure)),
  'bc2d23e5cd73b96bb304c35ec7ef21f6',
  'is_org_member: accepted, unexpired, not disabled'
);
select is(
  md5(pg_get_functiondef('public.my_warehouse_ids()'::regprocedure)),
  '32d1893e28697e6f562cfa521102b4c1',
  'my_warehouse_ids: manager and up every warehouse, staff and viewers their assignments'
);
select is(
  md5(pg_get_functiondef('public.user_can_access_warehouse(uuid, uuid, text)'::regprocedure)),
  '30151be2664af7b12f12da8ee82eaf85',
  'user_can_access_warehouse: manager and up, or staff and viewers with an assignment'
);
select is(
  md5(pg_get_functiondef('public.account_is_disabled(uuid)'::regprocedure)),
  '0d0087a069f03aec32f9bf42793e7334',
  'account_is_disabled: disabled_at set'
);

select * from finish();
rollback;
