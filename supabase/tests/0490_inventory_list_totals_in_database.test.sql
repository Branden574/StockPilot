-- supabase/tests/0490_inventory_list_totals_in_database.test.sql
-- pgTAP proof for migration 0490: the computed field is_low_stock and the
-- inventory list's value total inventory_list_value.
--
-- S.  Structure and who may call them:
--     S1-S2  posture of each (language, volatility, invoker, search_path;
--            is_low_stock: an SQL-standard body and no SET clause, so it
--            inlines); S1b a filter on it plans as the bare column
--            comparison, never a call (the plan reads no whole row);
--     S3     EXECUTE: is_low_stock for authenticated and service_role only;
--            inventory_list_value for authenticated only; never anon or
--            PUBLIC; S4 anon's call is refused (42501).
-- L.  is_low_stock: its truth table (zero, negative, at, under and over the
--     reorder point, fractions, and every null case, which the NOT NULL
--     columns never hold), never null, the same answer as the old two-step
--     rule on every fixture row, and readable as a column (i.is_low_stock),
--     which is how PostgREST filters on it.
-- V.  inventory_list_value as a manager of A: each filter on its own, the
--     defaults the app sends, and combinations, each against the hand-listed
--     records it must add up.
-- R.  Row level security: a staff member (their warehouse only), a staff
--     member who may read only one charter's records in their warehouse
--     (their total equals the sum over the rows they can read), a viewer
--     with a category grant, a manager of B asking for A's id, and someone
--     with no membership; narrowing never widens.
-- E.  Refusals (22023): every malformed input the function checks.
--
-- Fixtures as the test superuser, made-up names; every call as an API role
-- runs in a subtransaction that is always undone. begin/rollback: nothing
-- leaks. Namespace 04900000.

begin;

select plan(101);

\set orgA  '\'04900000-0000-0000-0000-00000000000a\''
\set orgB  '\'04900000-0000-0000-0000-00000000000b\''
\set whA1  '\'04900000-0000-0000-0000-0000000000a1\''
\set whA2  '\'04900000-0000-0000-0000-0000000000a2\''
\set whB   '\'04900000-0000-0000-0000-0000000000b1\''
\set catA1 '\'04900000-0000-0000-0000-0000000000c1\''
\set catA2 '\'04900000-0000-0000-0000-0000000000c2\''
\set catB  '\'04900000-0000-0000-0000-0000000000cb\''
\set supA  '\'04900000-0000-0000-0000-0000000000d1\''
\set locA  '\'04900000-0000-0000-0000-0000000000e1\''
\set chA   '\'04900000-0000-0000-0000-0000000000f1\''
\set chA2  '\'04900000-0000-0000-0000-0000000000f2\''
\set mgrA  '\'04900000-0000-0000-0000-000000000101\''
\set stfA  '\'04900000-0000-0000-0000-000000000102\''
\set vwrA  '\'04900000-0000-0000-0000-000000000103\''
\set mgrB  '\'04900000-0000-0000-0000-000000000104\''
\set nobody '\'04900000-0000-0000-0000-000000000105\''
\set stfC  '\'04900000-0000-0000-0000-000000000106\''

insert into auth.users (id, email, raw_user_meta_data)
  select ('04900000-0000-0000-0000-00000000010' || g)::uuid, 'person' || g || '@t490.test', '{}'::jsonb
    from generate_series(1, 6) g;
insert into public.organizations (id, name, slug) values
  (:orgA, 'T490 Org A', 't490-org-a'),
  (:orgB, 'T490 Org B', 't490-org-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :mgrA, 'manager', now()),
  (:orgA, :stfA, 'staff',   now()),
  (:orgA, :vwrA, 'viewer',  now()),
  (:orgA, :stfC, 'staff',   now()),
  (:orgB, :mgrB, 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA1, :orgA, 'T490 Main',   'WH-T490A1', 'active'),
  (:whA2, :orgA, 'T490 Second', 'WH-T490A2', 'active'),
  (:whB,  :orgB, 'T490 Other',  'WH-T490B',  'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :stfA, :whA1, true),
  (:orgA, :vwrA, :whA1, true);
insert into public.categories (id, organization_id, name) values
  (:catA1, :orgA, 'T490 Shirts'), (:catA2, :orgA, 'T490 Mugs'), (:catB, :orgB, 'T490 Lamps');
insert into public.user_category_assignments (organization_id, user_id, category_id) values
  (:orgA, :vwrA, :catA1);
insert into public.suppliers (id, organization_id, name) values (:supA, :orgA, 'T490 Supplier');
insert into public.locations (id, organization_id, warehouse_id, name, type) values
  (:locA, :orgA, :whA1, 'T490 Aisle', 'room');
insert into public.charters (id, organization_id, name, code, status) values
  (:chA,  :orgA, 'T490 Charter',  'T490-CH',  'active'),
  (:chA2, :orgA, 'T490 Charter 2', 'T490-CH2', 'active');
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values
  (:orgA, :whA1, :chA),
  (:orgA, :whA1, :chA2);
-- A staff member who may read Main's records of one charter only (and Main's
-- records with no charter, as every Main assignment may).
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, charter_id, is_primary) values
  (:orgA, :stfC, :whA1, :chA, true);

-- Org A's records. Each column default is the plain case: active product in
-- Main, Shirts, not a rental, not a bundle, shown in Orders, received.
create temp table fx (
  sku text primary key, name text, barcode text, model_number text,
  warehouse_id uuid, category_id uuid, supplier_id uuid, primary_location_id uuid, charter_id uuid,
  quantity_on_hand numeric, reorder_point numeric, unit_cost numeric,
  status text default 'active', auto_archived boolean default false,
  awaiting_first_receipt boolean default false, item_type text default 'product',
  is_rental boolean default false, is_bundle boolean default false,
  order_catalog_visible boolean default true, custom_fields jsonb default '{}'::jsonb,
  created_at timestamptz default '2026-05-01T00:00:00Z', updated_at timestamptz default '2026-05-01T00:00:00Z',
  deleted boolean default false, org uuid default '04900000-0000-0000-0000-00000000000a'
);
insert into fx (sku, name, barcode, model_number, warehouse_id, category_id, quantity_on_hand, reorder_point, unit_cost) values
  ('T490-A01', 'Blue tee', '111', 'MX-1', :whA1, :catA1, 10, 0, 2);
insert into fx (sku, name, warehouse_id, category_id, supplier_id, primary_location_id, quantity_on_hand, reorder_point, unit_cost) values
  ('T490-A02', 'Red mug', :whA2, :catA2, :supA, :locA, 3, 5, 4);
insert into fx (sku, name, warehouse_id, category_id, charter_id, quantity_on_hand, reorder_point, unit_cost, item_type, custom_fields) values
  ('T490-A03', 'Field guide', :whA1, :catA1, :chA, 0, 0, 7, 'book', '{"book_rack_number":"17","book_rack_row":"B"}');
insert into fx (sku, name, warehouse_id, category_id, quantity_on_hand, reorder_point, unit_cost, status, auto_archived) values
  ('T490-A04', 'Old cap', :whA1, :catA1, 1, 2, 3, 'archived', true);
insert into fx (sku, name, warehouse_id, category_id, quantity_on_hand, reorder_point, unit_cost, awaiting_first_receipt) values
  ('T490-A05', 'Coming soon', :whA1, :catA1, 0, 0, 5, true);
insert into fx (sku, name, warehouse_id, category_id, quantity_on_hand, reorder_point, unit_cost, is_rental) values
  ('T490-A06', 'Canopy', :whA1, :catA1, 1, 0, 100, true);
insert into fx (sku, name, warehouse_id, category_id, quantity_on_hand, reorder_point, unit_cost, is_bundle, custom_fields) values
  ('T490-A07', 'Starter kit', :whA1, :catA1, 4, 0, 1, true, '{"rack_number":"17","rack_row":"B"}');
insert into fx (sku, name, warehouse_id, category_id, quantity_on_hand, reorder_point, unit_cost, order_catalog_visible, item_type) values
  ('T490-A08', 'Ladder', :whA1, :catA1, 6, 0, 0, false, 'asset');
insert into fx (sku, name, warehouse_id, category_id, quantity_on_hand, reorder_point, unit_cost, deleted) values
  ('T490-A09', 'Gone tee', :whA1, :catA1, 9, 0, 9, true);
insert into fx (sku, name, model_number, warehouse_id, category_id, quantity_on_hand, reorder_point, unit_cost, custom_fields, created_at, updated_at) values
  ('T490-A10', 'Green tee', 'zz_1', :whA1, :catA1, 2, 0, 10, '{"rack_number":"17-B"}', '2026-01-15T00:00:00Z', '2026-03-15T00:00:00Z');
insert into fx (sku, name, warehouse_id, category_id, quantity_on_hand, reorder_point, unit_cost, item_type, custom_fields) values
  ('T490-A11', 'Atlas', :whA1, :catA1, 5, 0, 3, 'book', '{"rack_number":"17","rack_row":"B"}');
insert into fx (sku, name, barcode, warehouse_id, category_id, quantity_on_hand, reorder_point, unit_cost, item_type) values
  ('T490-A12', 'Some novel', '9780306406157', :whA1, :catA1, 1, 0, 20, 'book');
insert into fx (sku, name, warehouse_id, category_id, quantity_on_hand, reorder_point, unit_cost, status) values
  ('T490-A13', 'Plate', :whA2, :catA2, 5, 5, 6, 'discontinued');
insert into fx (sku, name, warehouse_id, category_id, charter_id, quantity_on_hand, reorder_point, unit_cost, status, item_type) values
  ('T490-C01', 'Spare fuse', :whA1, :catA2, :chA2, 2, 0, 50, 'discontinued', 'consumable');
insert into fx (sku, name, warehouse_id, category_id, quantity_on_hand, reorder_point, unit_cost, org) values
  ('T490-B01', 'Desk lamp', :whB, :catB, 10, 0, 1000, :orgB);

insert into public.inventory_items (
  organization_id, sku, name, barcode, model_number, warehouse_id, category_id, supplier_id,
  primary_location_id, charter_id, quantity_on_hand, reorder_point, unit_cost, status, auto_archived,
  awaiting_first_receipt, item_type, is_rental, is_bundle, order_catalog_visible, custom_fields,
  created_at, updated_at, deleted_at)
select org, sku, name, barcode, model_number, warehouse_id, category_id, supplier_id,
       primary_location_id, charter_id, quantity_on_hand, reorder_point, unit_cost, status, auto_archived,
       awaiting_first_receipt, item_type, is_rental, is_bundle, order_catalog_visible, custom_fields,
       created_at, updated_at, case when deleted then now() end
  from fx;

-- ══ Helpers ═══════════════════════════════════════════════════════════════
-- The value p_sub reads as p_role, through EXECUTE (planned and permission-
-- checked on each call), ALWAYS undone: the number as text, or
-- 'error <SQLSTATE>'.
create function pg_temp.value_as(p_sub uuid, p_org uuid, p_filters jsonb, p_role text default 'authenticated')
returns text language plpgsql as $$
declare v numeric; v_state text; v_msg text;
begin
  begin
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_role, true);
    perform set_config('role', p_role, true);
    execute 'select public.inventory_list_value($1, $2)' into v using p_org, p_filters;
    perform set_config('role', 'none', true);
    raise exception using errcode = 'XX490', message = coalesce(v::text, 'null');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state = 'XX490' then
    return v_msg;
  end if;
  return 'error ' || v_state;
end $$;

-- The value of the named records, as the superuser, with the function's own
-- arithmetic.
create function pg_temp.sum_of(p_skus text[]) returns text language sql as $$
  select coalesce(sum(coalesce(quantity_on_hand, 0) * coalesce(unit_cost, 0)), 0)::text
    from public.inventory_items where sku = any (p_skus)
$$;

-- The value of the live A records p_sub can READ (a plain select as
-- authenticated, through row level security), always undone.
create function pg_temp.readable_sum(p_sub uuid) returns text language plpgsql as $$
declare v numeric; v_state text; v_msg text;
begin
  begin
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', p_sub::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    perform set_config('role', 'authenticated', true);
    execute 'select coalesce(sum(coalesce(quantity_on_hand, 0) * coalesce(unit_cost, 0)), 0) from public.inventory_items where organization_id = $1 and deleted_at is null'
      into v using '04900000-0000-0000-0000-00000000000a'::uuid;
    perform set_config('role', 'none', true);
    raise exception using errcode = 'XX490', message = v::text;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state = 'XX490' then
    return v_msg;
  end if;
  return 'error ' || v_state;
end $$;

-- The plan of a statement, as text.
create function pg_temp.plan_of(p_sql text) returns text language plpgsql as $$
declare v_line text; v_out text := '';
begin
  for v_line in execute 'explain (verbose, costs off) ' || p_sql loop
    v_out := v_out || v_line || chr(10);
  end loop;
  return v_out;
end $$;

-- A manager of A's value for p_filters.
create function pg_temp.mgr(p_filters jsonb) returns text language sql as $$
  select pg_temp.value_as('04900000-0000-0000-0000-000000000101', '04900000-0000-0000-0000-00000000000a', p_filters)
$$;

create function pg_temp.low(p_qty numeric, p_rp numeric) returns boolean language sql as $$
  select public.is_low_stock(jsonb_populate_record(null::public.inventory_items,
           jsonb_build_object('quantity_on_hand', p_qty, 'reorder_point', p_rp)))
$$;

-- ══ S. Structure and privileges ═══════════════════════════════════════════
select ok(
  (select p.prolang = (select oid from pg_language where lanname = 'sql') and p.provolatile = 'i'
          and not p.prosecdef and p.proconfig is null and p.prosqlbody is not null
          and p.prorettype = 'boolean'::regtype
     from pg_proc p where p.oid = 'public.is_low_stock(public.inventory_items)'::regprocedure),
  'S1 is_low_stock: SQL, IMMUTABLE, invoker, an SQL-standard body (names bound at creation) and no SET clause, so it inlines');
select ok(
  (select x !~ 'is_low_stock' and x ~ 'quantity_on_hand' and x ~ 'reorder_point'
     from pg_temp.plan_of('select count(*) from public.inventory_items i where i.is_low_stock') x),
  'S1b a filter on is_low_stock plans as the column comparison itself: inlined, no call and no whole-row value');
select ok(
  (select p.prolang = (select oid from pg_language where lanname = 'plpgsql') and p.provolatile = 's'
          and not p.prosecdef and p.proconfig @> array['search_path=""']
          and p.prorettype = 'numeric'::regtype
     from pg_proc p where p.oid = 'public.inventory_list_value(uuid, jsonb)'::regprocedure),
  'S2 inventory_list_value: PL/pgSQL, STABLE, SECURITY INVOKER, search_path pinned, returns numeric');
select is(
  array[has_function_privilege('anon', 'public.is_low_stock(public.inventory_items)', 'execute'),
        has_function_privilege('authenticated', 'public.is_low_stock(public.inventory_items)', 'execute'),
        has_function_privilege('service_role', 'public.is_low_stock(public.inventory_items)', 'execute'),
        has_function_privilege('anon', 'public.inventory_list_value(uuid, jsonb)', 'execute'),
        has_function_privilege('authenticated', 'public.inventory_list_value(uuid, jsonb)', 'execute'),
        has_function_privilege('service_role', 'public.inventory_list_value(uuid, jsonb)', 'execute')],
  array[false, true, true, false, true, false],
  'S3 EXECUTE: is_low_stock authenticated + service_role; inventory_list_value authenticated only');
select ok(
  not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
               where p.oid in ('public.is_low_stock(public.inventory_items)'::regprocedure,
                               'public.inventory_list_value(uuid, jsonb)'::regprocedure)
                 and a.grantee = 0),
  'S3b neither function is granted to PUBLIC');
select is(pg_temp.value_as(null, :orgA, '{}'::jsonb, 'anon'), 'error 42501',
  'S4 anon cannot execute inventory_list_value');

-- ══ L. is_low_stock ═══════════════════════════════════════════════════════
select is(pg_temp.low(0, 0), true,        'L1 nothing on hand, no reorder point: low (out)');
select is(pg_temp.low(-1, 0), true,       'L2 negative on hand: low');
select is(pg_temp.low(1, 0), false,       'L3 some on hand, no reorder point: not low');
select is(pg_temp.low(5, 5), true,        'L4 at the reorder point: low');
select is(pg_temp.low(4, 5), true,        'L5 under the reorder point: low');
select is(pg_temp.low(6, 5), false,       'L6 over the reorder point: not low');
select is(pg_temp.low(0, 5), true,        'L7 out with a reorder point: low');
select is(pg_temp.low(-3, -5), true,      'L8 negative reorder point, negative on hand: low (out)');
select is(pg_temp.low(1, -5), false,      'L9 negative reorder point, some on hand: not low');
select is(pg_temp.low(0.0001, 0), false,  'L10 a fraction above 0, no reorder point: not low');
select is(pg_temp.low(5, 5.0001), true,   'L11 a fraction under the reorder point: low');
select is(pg_temp.low(null, 5), true,     'L12 null on hand, positive reorder point: low (the old rule read null as 0)');
select is(pg_temp.low(null, 0), false,    'L13 null on hand, reorder point 0: not low (the old pre-filter dropped it)');
select is(pg_temp.low(null, -1), false,   'L14 null on hand, negative reorder point: not low');
select is(pg_temp.low(0, null), true,     'L15 null reorder point, out: low');
select is(pg_temp.low(3, null), false,    'L16 null reorder point, some on hand: not low');
select is(pg_temp.low(null, null), false, 'L17 both null: not low, and not null');
select is(
  (select array_agg(i.sku order by i.sku) from public.inventory_items i
    where i.organization_id = :orgA and i.deleted_at is null and i.is_low_stock),
  array['T490-A02', 'T490-A03', 'T490-A04', 'T490-A05', 'T490-A13'],
  'L18 read as a column (i.is_low_stock, as PostgREST filters): the low records of A');
select is(
  (select count(*)::int from public.inventory_items i
    where i.organization_id in (:orgA, :orgB)
      and public.is_low_stock(i) is distinct from
          ((i.reorder_point > 0 or i.quantity_on_hand <= 0)
           and (i.quantity_on_hand <= i.reorder_point or i.quantity_on_hand <= 0))),
  0,
  'L19 the same answer as the old pre-filter + post-filter on every fixture row');

-- ══ V. The value, filter by filter, as a manager of A ════════════════════
select is(pg_temp.mgr('{}'),
  pg_temp.sum_of(array['T490-A01','T490-A02','T490-A03','T490-A04','T490-A05','T490-A06','T490-A07','T490-A08','T490-A10','T490-A11','T490-A12','T490-A13','T490-C01']),
  'V1 no filter: every live record of A (not the deleted one, nothing of B)');
select is(pg_temp.mgr('{"status":"active","awaiting_first_receipt":false,"item_types":["product"],"is_rental":false}'),
  pg_temp.sum_of(array['T490-A01','T490-A02','T490-A07','T490-A10']),
  'V2 the defaults the list sends (active, received, product, not a rental)');
select is(pg_temp.mgr('{"status":"archived"}'), pg_temp.sum_of(array['T490-A04']), 'V3 status');
select is(pg_temp.mgr('{"auto_archived":true}'), pg_temp.sum_of(array['T490-A04']), 'V4 auto_archived');
select is(pg_temp.mgr('{"awaiting_first_receipt":true}'), pg_temp.sum_of(array['T490-A05']), 'V5 awaiting_first_receipt true');
select is(pg_temp.mgr('{"search":"tee"}'), pg_temp.sum_of(array['T490-A01','T490-A10']), 'V6 search: name ILIKE, case-insensitive, the deleted one left out');
select is(pg_temp.mgr('{"search":"t490-a1"}'), pg_temp.sum_of(array['T490-A10','T490-A11','T490-A12','T490-A13']), 'V7 search: sku');
select is(pg_temp.mgr('{"search":"mx-"}'), pg_temp.sum_of(array['T490-A01']), 'V8 search: model_number');
select is(pg_temp.mgr('{"search":"0306"}'), pg_temp.sum_of(array['T490-A12']), 'V9 search: barcode');
select is(pg_temp.mgr('{"search":"b_ue"}'), pg_temp.sum_of(array['T490-A01']), 'V10 search: _ is a LIKE wildcard, as in the request');
select is(pg_temp.mgr('{"search":"nothing like it","search_isbn_variants":["0306406152","9780306406157"]}'),
  pg_temp.sum_of(array['T490-A12']), 'V11 search ISBN forms: an exact barcode match');
select is(pg_temp.mgr('{"barcode":"111"}'), pg_temp.sum_of(array['T490-A01']), 'V12 barcode: exact');
select is(pg_temp.mgr('{"rack":{"number":"17","row":"B","label":"17-B","keys":"item"}}'),
  pg_temp.sum_of(array['T490-A07','T490-A10','T490-A11']), 'V13 rack, item keys: number and row, or the whole label');
select is(pg_temp.mgr('{"rack":{"number":"17","row":null,"label":"17","keys":"item"}}'),
  pg_temp.sum_of(array['T490-A07','T490-A11']), 'V14 rack number alone');
select is(pg_temp.mgr('{"rack":{"number":"17","row":"B","label":"17-B","keys":"book"}}'),
  pg_temp.sum_of(array['T490-A03']), 'V15 rack, book keys');
select is(pg_temp.mgr('{"rack":{"number":"17","row":"B","label":"17-B","keys":"by_type"}}'),
  pg_temp.sum_of(array['T490-A03','T490-A07','T490-A10']), 'V16 rack by type: a book reads book keys, others rack keys');
select is(pg_temp.mgr(format('{"category_ids":["%s"]}', :catA2)::jsonb), pg_temp.sum_of(array['T490-A02','T490-A13','T490-C01']), 'V17 category_ids');
select is(pg_temp.mgr(format('{"location_ids":["%s"]}', :locA)::jsonb), pg_temp.sum_of(array['T490-A02']), 'V18 location_ids');
select is(pg_temp.mgr(format('{"supplier_ids":["%s"]}', :supA)::jsonb), pg_temp.sum_of(array['T490-A02']), 'V19 supplier_ids');
select is(pg_temp.mgr(format('{"charter_ids":["%s"]}', :chA)::jsonb), pg_temp.sum_of(array['T490-A03']), 'V20 charter_ids');
select is(pg_temp.mgr('{"charter_generic":true}'),
  pg_temp.sum_of(array['T490-A01','T490-A02','T490-A04','T490-A05','T490-A06','T490-A07','T490-A08','T490-A10','T490-A11','T490-A12','T490-A13']),
  'V21 charter_generic alone: no charter');
select is(pg_temp.mgr(format('{"charter_generic":true,"charter_ids":["%s"]}', :chA)::jsonb),
  pg_temp.sum_of(array['T490-A01','T490-A02','T490-A03','T490-A04','T490-A05','T490-A06','T490-A07','T490-A08','T490-A10','T490-A11','T490-A12','T490-A13']),
  'V22 Generic plus a charter: either (not the other charter)');
select is(pg_temp.mgr('{"out_of_stock":true}'), pg_temp.sum_of(array['T490-A03','T490-A05']), 'V23 out_of_stock: on hand 0 or less');
select is(pg_temp.mgr('{"has_unit_cost":true}'),
  pg_temp.sum_of(array['T490-A01','T490-A02','T490-A03','T490-A04','T490-A05','T490-A06','T490-A07','T490-A10','T490-A11','T490-A12','T490-A13','T490-C01']),
  'V24 has_unit_cost: unit cost above 0');
select is(pg_temp.mgr('{"low_stock":true}'), pg_temp.sum_of(array['T490-A02','T490-A03','T490-A04','T490-A05','T490-A13']), 'V25 low_stock');
select is(pg_temp.mgr('{"item_types":["book","asset"]}'), pg_temp.sum_of(array['T490-A03','T490-A08','T490-A11','T490-A12']), 'V26 item_types');
select is(pg_temp.mgr('{"exclude_bundles":true}'),
  pg_temp.sum_of(array['T490-A01','T490-A02','T490-A03','T490-A04','T490-A05','T490-A06','T490-A08','T490-A10','T490-A11','T490-A12','T490-A13','T490-C01']),
  'V27 exclude_bundles');
select is(pg_temp.mgr('{"order_catalog_visible":false}'), pg_temp.sum_of(array['T490-A08']), 'V28 order_catalog_visible');
select is(pg_temp.mgr('{"is_rental":true}'), pg_temp.sum_of(array['T490-A06']), 'V29 is_rental');
select is(pg_temp.mgr('{"created_since":"2026-01-01","created_until":"2026-02-01"}'), pg_temp.sum_of(array['T490-A10']), 'V30 created range: since inclusive, until exclusive');
select is(pg_temp.mgr('{"created_until":"2026-01-15T00:00:00Z"}'), '0', 'V31 created_until excludes a record made at that instant');
select is(pg_temp.mgr('{"updated_since":"2026-03-15T00:00:00Z","updated_until":"2026-03-16"}'), pg_temp.sum_of(array['T490-A10']), 'V32 updated range');
select is(pg_temp.mgr((select format('{"ids":["%s","%s"]}', min(id::text), max(id::text))
                         from public.inventory_items where sku in ('T490-A01', 'T490-A02'))::jsonb),
  pg_temp.sum_of(array['T490-A01','T490-A02']), 'V33 ids');
select is(pg_temp.mgr(format('{"warehouse_ids":["%s"]}', :whA2)::jsonb), pg_temp.sum_of(array['T490-A02','T490-A13']), 'V34 warehouse_ids');
select is(pg_temp.mgr(format('{"category_grants":["%s"]}', :catA2)::jsonb), pg_temp.sum_of(array['T490-A02','T490-A13','T490-C01']), 'V35 category_grants');
select is(pg_temp.mgr('{"status":"active","low_stock":true,"item_types":["product"]}'),
  pg_temp.sum_of(array['T490-A02','T490-A05']), 'V36 combined: active, low, products');
select is(pg_temp.mgr('{"status":"active","awaiting_first_receipt":false,"is_rental":false,"low_stock":true,"item_types":["product","book"],"exclude_bundles":true}'),
  pg_temp.sum_of(array['T490-A02','T490-A03']), 'V37 combined: the list defaults with low stock over products and books');
select is(pg_temp.mgr(format('{"search":"tee","rack":{"number":"17","row":"B","label":"17-B","keys":"item"},"warehouse_ids":["%s"],"has_unit_cost":true}', :whA1)::jsonb),
  pg_temp.sum_of(array['T490-A10']), 'V38 combined: search, rack, warehouse and unit cost');
select is(pg_temp.mgr(format('{"category_ids":["%s"],"supplier_ids":["%s"],"out_of_stock":true}', :catA2, :supA)::jsonb),
  '0', 'V39 combined filters that match nothing add up to 0, never null');
select is(pg_temp.mgr('{"status":"active","search":"blue","search_isbn_variants":["0306406152"]}'),
  pg_temp.sum_of(array['T490-A01']), 'V40 search ISBN forms only widen the search, inside it');
select is(pg_temp.mgr('{"search":"%"}'), pg_temp.mgr('{}'), 'V41 the search text is a pattern body, as in the request: a % is a wildcard (the app strips it before sending)');

-- ══ R. Row level security ═════════════════════════════════════════════════
select is(pg_temp.value_as(:stfA, :orgA, '{}'),
  pg_temp.sum_of(array['T490-A01','T490-A03','T490-A04','T490-A05','T490-A06','T490-A07','T490-A08','T490-A10','T490-A11','T490-A12','T490-C01']),
  'R1 staff of A: only the warehouse they are assigned');
select is(pg_temp.value_as(:stfA, :orgA, format('{"warehouse_ids":["%s"]}', :whA2)::jsonb), '0',
  'R2 staff of A asking for a warehouse they cannot read: 0, never more');
select is(pg_temp.value_as(:vwrA, :orgA, '{}'),
  pg_temp.sum_of(array['T490-A01','T490-A03','T490-A04','T490-A05','T490-A06','T490-A07','T490-A08','T490-A10','T490-A11','T490-A12']),
  'R3 viewer of A with a Shirts grant, in Main: Shirts in Main');
select is(pg_temp.value_as(:vwrA, :orgA, format('{"category_grants":["%s"]}', :catA2)::jsonb), '0',
  'R4 viewer naming a category they are not granted: 0');
select is(pg_temp.value_as(:vwrA, :orgA, format('{"category_ids":["%s"]}', :catA1)::jsonb),
  pg_temp.value_as(:vwrA, :orgA, '{}'), 'R5 viewer narrowing to their own grant: the same');
select is(pg_temp.value_as(:mgrB, :orgA, '{}'), '0', 'R6 a manager of B asking for A: 0');
select is(pg_temp.value_as(:mgrB, :orgB, '{}'), pg_temp.sum_of(array['T490-B01']), 'R7 a manager of B: B''s value');
select is(pg_temp.value_as(:mgrA, :orgB, '{}'), '0', 'R8 a manager of A asking for B: 0');
select is(pg_temp.value_as(:nobody, :orgA, '{}'), '0', 'R9 someone with no membership: 0');
select is(pg_temp.value_as(null, :orgA, '{}'), '0', 'R10 authenticated with no user: 0');
select is(pg_temp.value_as(:stfC, :orgA, '{}'),
  pg_temp.sum_of(array['T490-A01','T490-A03','T490-A04','T490-A05','T490-A06','T490-A07','T490-A08','T490-A10','T490-A11','T490-A12']),
  'R11 staff who may read one charter in Main: Main''s records of that charter and of none, not the other charter''s');
select is(pg_temp.value_as(:stfC, :orgA, '{}'), pg_temp.readable_sum(:stfC),
  'R12 that staff member''s total equals the sum over the rows they can read');
select is(pg_temp.value_as(:stfC, :orgA, format('{"charter_ids":["%s"]}', :chA2)::jsonb), '0',
  'R13 that staff member naming the charter they cannot read: 0');

-- ══ E. Refusals ═══════════════════════════════════════════════════════════
select is(pg_temp.value_as(:mgrA, null, '{}'), 'error 22023', 'E1 no organization');
select is(pg_temp.mgr(null), 'error 22023', 'E2 no filters');
select is(pg_temp.mgr('[]'), 'error 22023', 'E3 filters that are not an object');
select is(pg_temp.mgr('{"warehouse":"x"}'), 'error 22023', 'E4 an unknown key');
select is(pg_temp.mgr('{"ids":[]}'), 'error 22023', 'E5 an empty id list');
select is(pg_temp.mgr('{"ids":["not-an-id"]}'), 'error 22023', 'E6 an id that is not a uuid');
select is(pg_temp.mgr('{"ids":[1]}'), 'error 22023', 'E7 an id that is not text');
select is(pg_temp.mgr(format('{"ids":%s}', (select jsonb_agg(gen_random_uuid()) from generate_series(1, 1001)))::jsonb),
  'error 22023', 'E8 more than 1000 ids');
select is(pg_temp.mgr('{"low_stock":"yes"}'), 'error 22023', 'E9 a switch that is not true or false');
select is(pg_temp.mgr(format('{"search":"%s"}', repeat('x', 121))::jsonb), 'error 22023', 'E10 a search over 120 characters');
select is(pg_temp.mgr(format('{"search":"%s"}', repeat('x', 119) || U&'\+01F600')::jsonb), '0',
  'E10b 119 characters and an emoji is 120 characters (code points, as the app cuts it), accepted');
select is(pg_temp.mgr(format('{"search":"%s"}', repeat('x', 120) || U&'\+01F600')::jsonb), 'error 22023',
  'E10c 120 characters and an emoji is 121, refused');
select is(pg_temp.mgr('{"search":""}'), 'error 22023', 'E11 an empty search');
select is(pg_temp.mgr('{"search_isbn_variants":["0306406152"]}'), 'error 22023', 'E12 ISBN forms without a search');
select is(pg_temp.mgr('{"search":"x","search_isbn_variants":["03064"]}'), 'error 22023', 'E13 an ISBN form of the wrong length');
select is(pg_temp.mgr('{"rack":{"number":"1,7","row":null,"label":"17","keys":"item"}}'), 'error 22023', 'E14 a rack part outside the sanitizing');
select is(pg_temp.mgr('{"rack":{"number":"17","row":null,"label":"17","keys":"shelf"}}'), 'error 22023', 'E15 rack keys outside the three');
select is(pg_temp.mgr('{"rack":{"number":"17","label":"17","keys":"item","x":1}}'), 'error 22023', 'E16 a rack with an unknown part');
select is(pg_temp.mgr('{"created_since":"yesterday-ish"}'), 'error 22023', 'E17 a timestamp Postgres cannot read');
select is(pg_temp.mgr(format('{"barcode":"%s"}', repeat('1', 4097))::jsonb), 'error 22023', 'E18 a barcode over 4096 characters');
select is(pg_temp.mgr('{"item_types":["product","book","asset","consumable","a","b","c","d","e","f","g"]}'), 'error 22023', 'E19 more than 10 item types');
select is(pg_temp.mgr('{"status":1}'), 'error 22023', 'E20 a status that is not text');

select * from finish();
rollback;
