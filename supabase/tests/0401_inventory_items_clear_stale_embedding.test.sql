-- supabase/tests/0401_inventory_items_clear_stale_embedding.test.sql
-- pgTAP proof for migration 0401: a change to an item's searched text (name,
-- sku, barcode, description, custom_fields.author) clears its search
-- embedding in the same statement, judged row by row on each row's own old
-- and new values; every other write keeps it.
--
-- T.  The trigger: BEFORE UPDATE OF exactly the five columns, FOR EACH ROW,
--     with a WHEN clause, on the function; the function is SECURITY INVOKER
--     with search_path pinned, and anon and authenticated cannot execute it.
-- C.  Each searched column clears it: name, sku, barcode (null to a value),
--     description (a value to null), the author; updated_at still moves.
-- K.  Everything else keeps it: a rack written into custom_fields, the same
--     values written again, a price, an on-hand change; an embedding-only
--     write keeps its new vector and updated_at (0242 holds).
-- R.  Row by row: one UPDATE over a SKU's other records (the edit fan-out's
--     shape) clears only the records whose own name changed, and a record
--     with no embedding stays without one.
-- U.  Ungroup: split_item_sku (0399), called as a manager, clears the split
--     record's embedding and keeps the other record's.
--
-- Roles: fixtures as the test superuser (RLS bypassed, the API-role guards
-- exempt). begin/rollback: nothing leaks. Namespace 04010000.

begin;

select plan(21);

\set org '\'04010000-0000-0000-0000-00000000000a\''
\set mgr '\'04010000-0000-0000-0000-0000000000a1\''
\set wh  '\'04010000-0000-0000-0000-0000000000d1\''
-- C: one record per searched column.
\set n1  '\'04010000-0000-0000-0000-000000000101\''
\set s1  '\'04010000-0000-0000-0000-000000000102\''
\set b1  '\'04010000-0000-0000-0000-000000000103\''
\set d1  '\'04010000-0000-0000-0000-000000000104\''
\set a1  '\'04010000-0000-0000-0000-000000000105\''
-- K: writes that keep it.
\set r1  '\'04010000-0000-0000-0000-000000000111\''
\set v1  '\'04010000-0000-0000-0000-000000000112\''
\set p1  '\'04010000-0000-0000-0000-000000000113\''
\set q1  '\'04010000-0000-0000-0000-000000000114\''
\set e1  '\'04010000-0000-0000-0000-000000000115\''
-- R: one SKU on four racks. f1 is the edited record (not in the fan-out), f2
-- already has its name, f3's name differs (a CSV import named it), f4 has no
-- embedding.
\set f1  '\'04010000-0000-0000-0000-000000000201\''
\set f2  '\'04010000-0000-0000-0000-000000000202\''
\set f3  '\'04010000-0000-0000-0000-000000000203\''
\set f4  '\'04010000-0000-0000-0000-000000000204\''
-- U: one product on two racks, no charter (the owner's Ungroup case).
\set u1  '\'04010000-0000-0000-0000-000000000301\''
\set u2  '\'04010000-0000-0000-0000-000000000302\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data)
  values (:mgr, '0401-mgr@test.local', '{}'::jsonb) on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, '0401 Stale embeddings', '0401-stale-embeddings');
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :mgr, 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, '0401 Main', 'WH-0401', 'active');

-- A fixed PAST updated_at, so a move is unambiguous (INSERT does not fire the
-- BEFORE UPDATE triggers, so the value sticks).
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, barcode, description, custom_fields, bin_location,
   quantity_on_hand, status, tracking_type, created_at, updated_at) values
  (:n1, :org, :wh, 'X0401-NAME',  'Item to rename',    null, null, '{}', null, 1, 'active', 'none', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:s1, :org, :wh, 'X0401-SKU',   'SKU changes',       null, null, '{}', null, 1, 'active', 'none', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:b1, :org, :wh, 'X0401-BAR',   'Barcode added',     null, null, '{}', null, 1, 'active', 'none', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:d1, :org, :wh, 'X0401-DESC',  'Description gone',  null, 'Old description', '{}', null, 1, 'active', 'none', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:a1, :org, :wh, 'X0401-AUTH',  'A book',            null, null, '{"author": "Old Author"}', null, 1, 'active', 'none', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:r1, :org, :wh, 'X0401-RACK',  'Racked',            null, null, '{"author": "Same Author"}', null, 1, 'active', 'none', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:v1, :org, :wh, 'X0401-SAME',  'Same values',       '9780000000401', 'Same', '{"author": "Same"}', null, 1, 'active', 'none', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:p1, :org, :wh, 'X0401-PRICE', 'Price changes',     null, null, '{}', null, 1, 'active', 'none', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:q1, :org, :wh, 'X0401-QTY',   'Stock moves',       null, null, '{}', null, 1, 'active', 'none', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:e1, :org, :wh, 'X0401-EMB',   'Embedded again',    null, null, '{}', null, 1, 'active', 'none', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:f1, :org, :wh, 'X0401-FAN',   'Widget',            null, null, '{}', '1-A', 1, 'active', 'none', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:f2, :org, :wh, 'X0401-FAN',   'Widget',            null, null, '{}', '2-A', 1, 'active', 'none', '2020-01-02T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:f3, :org, :wh, 'X0401-FAN',   'Widget (old pack)', null, null, '{}', '3-A', 1, 'active', 'none', '2020-01-03T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:f4, :org, :wh, 'X0401-FAN',   'Widget (old)',      null, null, '{}', '4-A', 1, 'active', 'none', '2020-01-04T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:u1, :org, :wh, 'X0401-PAIR',  'Mouse pad',         null, null, '{}', '22-A', 9, 'active', 'none', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
  (:u2, :org, :wh, 'X0401-PAIR',  'Mouse pad',         null, null, '{}', '22-C', 4, 'active', 'none', '2020-01-02T00:00:00Z', '2020-01-01T00:00:00Z');

-- Every record but f4 has an embedding: an embedding-only write, which fires
-- no column trigger of 0401 and keeps updated_at (0242).
update public.inventory_items
   set embedding = array_fill(0.05::real, array[1536])::extensions.vector(1536)
 where organization_id = :org and id <> :f4;

-- Guard the fixtures: a record without an embedding would make "cleared"
-- pass for the wrong reason.
do $$ begin
  if (select count(*) from public.inventory_items
       where id::text like '04010000-%' and embedding is not null
         and updated_at = '2020-01-01T00:00:00Z') <> 15 then
    raise exception 'fixture: embeddings (%)',
      (select count(*) from public.inventory_items where id::text like '04010000-%' and embedding is not null);
  end if;
end $$;

-- One call as a role and a user (0399's helper): the result as text, or
-- ERR:<sqlstate>:<hint>:<detail>.
create function pg_temp.run(p_as text, p_sub uuid, p_sql text) returns text language plpgsql as $$
declare v_state text; v_hint text; v_detail text; v text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('role', p_as, true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint, v_detail = pg_exception_detail;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    return 'ERR:' || v_state || ':' || coalesce(v_hint, '') || ':' || coalesce(v_detail, '');
  end;
  return coalesce(v, 'null');
end $$;

-- ══ T. The trigger and its function ═══════════════════════════════════════
select has_trigger('public', 'inventory_items', 'inventory_items_clear_stale_embedding',
  'T1: inventory_items has the trigger');

select matches(
  (select pg_get_triggerdef(t.oid) from pg_trigger t
    where t.tgrelid = 'public.inventory_items'::regclass
      and t.tgname = 'inventory_items_clear_stale_embedding'),
  '^CREATE TRIGGER inventory_items_clear_stale_embedding BEFORE UPDATE OF name, sku, barcode, description, custom_fields ON public\.inventory_items FOR EACH ROW WHEN ',
  'T2: BEFORE UPDATE OF exactly the five searched columns, for each row, with a WHEN clause'
);

select trigger_is('public', 'inventory_items', 'inventory_items_clear_stale_embedding',
  'public', 'tg_inventory_items_clear_stale_embedding',
  'T3: the trigger runs tg_inventory_items_clear_stale_embedding');

select ok(
  (select not p.prosecdef
          and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'tg_inventory_items_clear_stale_embedding'),
  'T4: the function is SECURITY INVOKER with search_path pinned'
);

-- Through pg_proc, so a missing function answers false instead of an error.
select ok(
  coalesce(
    (select not has_function_privilege('anon', p.oid, 'execute')
            and not has_function_privilege('authenticated', p.oid, 'execute')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'tg_inventory_items_clear_stale_embedding'),
    false),
  'T5: anon and authenticated cannot execute the function'
);

-- ══ C. Each searched column clears it ═════════════════════════════════════
update public.inventory_items set name = 'Item renamed' where id = :n1;
select ok((select embedding is null from public.inventory_items where id = :n1),
  'C1: a name change clears the embedding');

update public.inventory_items set sku = 'X0401-SKU-NEW' where id = :s1;
select ok((select embedding is null from public.inventory_items where id = :s1),
  'C2: a SKU change clears it');

update public.inventory_items set barcode = '9780000000418' where id = :b1;
select ok((select embedding is null from public.inventory_items where id = :b1),
  'C3: a barcode set where there was none clears it');

update public.inventory_items set description = null where id = :d1;
select ok((select embedding is null from public.inventory_items where id = :d1),
  'C4: a description removed clears it');

update public.inventory_items
   set custom_fields = jsonb_set(custom_fields, '{author}', '"New Author"')
 where id = :a1;
select ok((select embedding is null from public.inventory_items where id = :a1),
  'C5: an author change clears it');

select ok((select updated_at > '2020-01-02T00:00:00Z' from public.inventory_items where id = :n1),
  'C6: a searched change still moves updated_at (a real change, 0242)');

-- ══ K. Everything else keeps it ═══════════════════════════════════════════
update public.inventory_items
   set custom_fields = custom_fields || '{"rack_number": "7", "rack_row": "B"}'::jsonb,
       bin_location = '7-B'
 where id = :r1;
select ok((select embedding is not null from public.inventory_items where id = :r1),
  'K1: a rack written into custom_fields keeps it (the author did not change)');

update public.inventory_items
   set name = name, sku = sku, barcode = barcode, description = description,
       custom_fields = custom_fields
 where id = :v1;
select ok((select embedding is not null from public.inventory_items where id = :v1),
  'K2: the same values written again keep it (the edit form sends every field)');

update public.inventory_items set unit_cost = 2.5, retail_price = 4.25, reorder_point = 3 where id = :p1;
select ok((select embedding is not null from public.inventory_items where id = :p1),
  'K3: a price and reorder change keeps it');

update public.inventory_items set quantity_on_hand = quantity_on_hand + 1 where id = :q1;
select ok((select embedding is not null from public.inventory_items where id = :q1),
  'K4: an on-hand change keeps it');

update public.inventory_items
   set embedding = array_fill(0.07::real, array[1536])::extensions.vector(1536)
 where id = :e1;
select ok(
  (select embedding = array_fill(0.07::real, array[1536])::extensions.vector(1536)
          and updated_at = '2020-01-01T00:00:00Z'
     from public.inventory_items where id = :e1),
  'K5: an embedding-only write keeps its new vector and updated_at'
);

-- ══ R. Row by row ═════════════════════════════════════════════════════════
-- InventoryService.update's fan-out: the edited record's shared fields onto
-- the SKU's other live records, in one statement.
update public.inventory_items
   set name = 'Widget'
 where organization_id = :org and sku = 'X0401-FAN' and deleted_at is null and id <> :f1;

select is(
  array(select right(id::text, 3) from public.inventory_items
         where sku = 'X0401-FAN' and embedding is not null order by id),
  array['201', '202'],
  'R1: the fan-out clears only f3, whose own name changed; f1 (not written) and f2 (already Widget) keep theirs'
);

select ok((select name = 'Widget' and embedding is null from public.inventory_items where id = :f4),
  'R2: a record with no embedding is renamed and stays without one');

-- ══ U. Ungroup ════════════════════════════════════════════════════════════
create temp table ans as
  select pg_temp.run('authenticated', :mgr, format(
           'select public.split_item_sku(%L::jsonb, %L)::text',
           jsonb_build_object(
             'action', 'split_sku', 'organization_id', :org, 'actor_user_id', :mgr,
             'surface', 'web', 'item_ids', jsonb_build_array(:u2),
             'expected_skus', jsonb_build_object(:u2, 'X0401-PAIR')),
           '04019000-0000-4000-8000-000000000001')) as r;

select is((select case when r like 'ERR:%' then r else 'answered' end from ans), 'answered',
  'U1: split_item_sku answers the manager');

select ok(
  (select sku <> 'X0401-PAIR' and embedding is null from public.inventory_items where id = :u2),
  'U2: Ungroup gives u2 a SKU of its own and clears its embedding'
);

select ok(
  (select sku = 'X0401-PAIR' and embedding is not null from public.inventory_items where id = :u1),
  'U3: the record that keeps the SKU keeps its embedding'
);

select * from finish();
rollback;
