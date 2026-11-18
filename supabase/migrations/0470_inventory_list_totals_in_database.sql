-- 0470_inventory_list_totals_in_database.sql
--
-- The Items, Books and Rentals lists (InventoryService.list) show a value
-- footer: the sum of quantity_on_hand x unit_cost over EVERY record the view
-- matches, not only the visible page. It was read by paging the whole
-- filtered view through PostgREST in 1000-row windows, one after another, and
-- adding up in the app: 51 requests for a view of 50,000 records. The
-- low-stock view could not be filtered in the request at all (PostgREST
-- cannot compare two columns), so its pages were cut down after they were
-- read: short, uneven pages, and page N was not the Nth slice of the set.
--
-- 1. public.is_low_stock(public.inventory_items) -> boolean
--    A computed field: PostgREST lets a request filter on it like a column
--    (`is_low_stock=eq.true`), so the page, its exact count and every scan of
--    the view describe the same set. The rule is the one the app applied in
--    two steps (the pre-filter `reorder_point > 0 OR quantity_on_hand <= 0`
--    in the request, then `quantity_on_hand <= reorder_point OR
--    quantity_on_hand <= 0` on the rows read), as one expression:
--        quantity_on_hand <= 0
--        OR (reorder_point > 0 AND quantity_on_hand <= reorder_point)
--    Both columns are numeric(14,4) NOT NULL DEFAULT 0 (0002) and no later
--    migration changes that, so a null never reaches it. Were one ever null,
--    the answer is still the old two-step answer (the request's three-valued
--    logic, then JavaScript reading null as 0): a null quantity is low only
--    when the reorder point is above 0; a null reorder point is low only when
--    the quantity is 0 or less. The answer is never null.
--    IMMUTABLE: it reads only the row it is given.
--    Written so Postgres INLINES it: an SQL-standard body (RETURN) and no
--    SET clause. A SET clause stops inlining, and a call that is not inlined
--    builds each row's whole value first, which reads every out-of-line
--    column, the 1536-dimension embedding (about 6 KB) included, on every
--    row the filter judges. Inlined, it is the bare comparison of two
--    columns. The SQL-standard body is parsed and every name in it bound when
--    the function is created, so no caller's search_path ever applies (what a
--    pinned search_path is for elsewhere); security_invariants allowlist N
--    holds it to that shape (invoker, immutable, no SET, depends on no
--    function, operator or other table) and to this exact body: any later
--    CREATE OR REPLACE fails that test until a reviewer reads the new body
--    and records its md5 there.
--    The SQL-standard body records a dependency on the two columns it reads,
--    so a later ALTER TABLE that changes the type of quantity_on_hand or
--    reorder_point is refused ("cannot alter type of a column used by a
--    function or procedure"; the trigger trg_inventory_items_low_stock
--    already refuses it for the same two columns), and dropping either needs
--    CASCADE: such a migration must drop is_low_stock (and that trigger),
--    change the column, recreate both with the function's grants, and reload
--    PostgREST's schema cache.
--
-- 2. public.inventory_list_value(p_organization_id uuid, p_filters jsonb)
--    -> numeric
--    One aggregate for the value footer:
--        sum(coalesce(quantity_on_hand, 0) * coalesce(unit_cost, 0))
--    over the organization's live records (deleted_at IS NULL) that match
--    p_filters. SECURITY INVOKER: the caller's own row level security
--    applies, so it can never add up a record the caller's own list request
--    could not read, whatever organization id or filters it is given.
--    p_filters is built by ONE function in the app
--    (buildItemListValueFilters, next to applyContentFilters in
--    apps/web/src/server/services/inventory.ts) from the same filters as the
--    page request. Every key is optional, and an absent key adds no
--    condition; the app always sends the defaults (status, expected,
--    item type, rentals) explicitly. The keys:
--      warehouse_ids          uuid[]  warehouse_id = any (the caller's
--                                     readable warehouses, or the chosen one)
--      category_grants        uuid[]  category_id = any (a viewer's grants;
--                                     a record with no category is not
--                                     granted)
--      status                 text    status = value
--      auto_archived          boolean auto_archived = value
--      awaiting_first_receipt boolean awaiting_first_receipt = value
--      search                 text    name, sku, barcode or model_number
--                                     ILIKE '%' || value || '%', the same
--                                     pattern the request sends (the app
--                                     strips , ( ) % * and caps it at 120)
--      search_isbn_variants   text[]  only with search: OR barcode = any
--      barcode                text    barcode = value
--      rack                   object  {number, row (or null), label, keys}:
--                                     keys 'item' reads custom_fields
--                                     rack_number/rack_row, 'book' the
--                                     book_rack_* keys, 'by_type' each
--                                     record its own type's keys. With a row:
--                                     (number AND row) OR the whole label in
--                                     the number key; without one: number.
--      category_ids           uuid[]  category_id = any
--      location_ids           uuid[]  primary_location_id = any
--      supplier_ids           uuid[]  supplier_id = any
--      charter_ids            uuid[]  charter_id = any
--      charter_generic        boolean true: OR charter_id IS NULL (alone:
--                                     only charter_id IS NULL)
--      out_of_stock           boolean true: quantity_on_hand <= 0
--      has_unit_cost          boolean true: unit_cost > 0
--      low_stock              boolean true: is_low_stock(record)
--      item_types             text[]  item_type = any
--      exclude_bundles        boolean true: is_bundle IS NOT TRUE
--      order_catalog_visible  boolean order_catalog_visible = value
--      is_rental              boolean is_rental = value
--      created_since          timestamptz created_at >= value
--      created_until          timestamptz created_at <  value
--      updated_since          timestamptz updated_at >= value
--      updated_until          timestamptz updated_at <  value
--      ids                    uuid[]  id = any
--    Checked before anything is read, each refusal SQLSTATE 22023: an
--    organization id; p_filters an object; no other key (a filter the app
--    adds later must be added here too, never dropped silently); each value
--    of its type; arrays of 1 to 1000 values (item_types 1 to 10,
--    search_isbn_variants 1 to 20); every uuid one Postgres reads as a uuid;
--    every timestamp one it reads as a timestamptz; status and an item type
--    1 to 32 characters; search 1 to 120; barcode 1 to 4096; rack parts the
--    app's own rack sanitizing (letters, digits and dashes, 1 to 40) and
--    keys one of the three; an ISBN variant 10 or 13 of 0-9 and X.
--    STABLE, PL/pgSQL for the checks, one static query (no dynamic SQL).
--
-- Grants: is_low_stock to authenticated and service_role (a filter in their
-- own requests); inventory_list_value to authenticated only (list() calls it
-- with the signed-in member's client). Nothing for anon or PUBLIC.
-- inventory_list_value pins search_path to '' and schema-qualifies every
-- name; is_low_stock binds its names at creation (above).

-- LOCKS: no user table is locked to commit. Creating the two functions takes
-- pg_proc's unique name index and SHARE on pg_description; behind an
-- uncommitted function of the same name and signature, or behind
-- maintenance on the catalog, that wait ends after 900ms with 55P03 and
-- nothing applied, and the push can be run again later.
set lock_timeout = '900ms';

create or replace function public.is_low_stock(p_item public.inventory_items)
returns boolean
language sql
immutable
return coalesce(p_item.quantity_on_hand <= 0, false)
    or coalesce(p_item.reorder_point > 0
                and coalesce(p_item.quantity_on_hand, 0) <= p_item.reorder_point, false);

comment on function public.is_low_stock(public.inventory_items) is
  'Computed field (0470): true when the record is out (quantity_on_hand <= 0) or at or under a positive reorder point. The rule the inventory list''s low-stock view uses; filterable in a request as is_low_stock=eq.true. Never null.';

revoke all on function public.is_low_stock(public.inventory_items) from public, anon, authenticated, service_role;
grant execute on function public.is_low_stock(public.inventory_items) to authenticated, service_role;

create or replace function public.inventory_list_value(p_organization_id uuid, p_filters jsonb)
returns numeric
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_key text;
  v_value jsonb;
  v_element jsonb;
  v_max integer;
  v_warehouse_ids uuid[];
  v_category_grants uuid[];
  v_status text;
  v_auto_archived boolean;
  v_awaiting boolean;
  v_search text;
  v_isbn text[];
  v_barcode text;
  v_rack_number text;
  v_rack_row text;
  v_rack_label text;
  v_rack_keys text;
  v_category_ids uuid[];
  v_location_ids uuid[];
  v_supplier_ids uuid[];
  v_charter_ids uuid[];
  v_charter_generic boolean;
  v_out_of_stock boolean;
  v_has_unit_cost boolean;
  v_low_stock boolean;
  v_item_types text[];
  v_exclude_bundles boolean;
  v_order_catalog_visible boolean;
  v_is_rental boolean;
  v_created_since timestamptz;
  v_created_until timestamptz;
  v_updated_since timestamptz;
  v_updated_until timestamptz;
  v_ids uuid[];
  v_total numeric;
begin
  if p_organization_id is null then
    raise exception 'inventory_list_value: an organization is required'
      using errcode = '22023';
  end if;
  if p_filters is null or jsonb_typeof(p_filters) <> 'object' then
    raise exception 'inventory_list_value: the filters must be a JSON object'
      using errcode = '22023';
  end if;

  -- Every key checked against its type before anything is read.
  for v_key, v_value in select e.key, e.value from jsonb_each(p_filters) e loop
    if v_key in ('warehouse_ids', 'category_grants', 'category_ids', 'location_ids',
                 'supplier_ids', 'charter_ids', 'ids') then
      if jsonb_typeof(v_value) <> 'array'
         or jsonb_array_length(v_value) < 1 or jsonb_array_length(v_value) > 1000 then
        raise exception 'inventory_list_value: % must be a list of 1 to 1000 ids', v_key
          using errcode = '22023';
      end if;
      for v_element in select a.value from jsonb_array_elements(v_value) a loop
        if jsonb_typeof(v_element) <> 'string'
           or not pg_catalog.pg_input_is_valid(v_element #>> '{}', 'uuid') then
          raise exception 'inventory_list_value: % holds a value that is not an id', v_key
            using errcode = '22023';
        end if;
      end loop;
    elsif v_key in ('item_types', 'search_isbn_variants') then
      v_max := case v_key when 'item_types' then 10 else 20 end;
      if jsonb_typeof(v_value) <> 'array'
         or jsonb_array_length(v_value) < 1 or jsonb_array_length(v_value) > v_max then
        raise exception 'inventory_list_value: % must be a list of 1 to % values', v_key, v_max
          using errcode = '22023';
      end if;
      for v_element in select a.value from jsonb_array_elements(v_value) a loop
        if jsonb_typeof(v_element) <> 'string'
           or (v_key = 'item_types'
               and char_length(v_element #>> '{}') not between 1 and 32)
           or (v_key = 'search_isbn_variants'
               and (v_element #>> '{}') !~ '^([0-9X]{10}|[0-9X]{13})$') then
          raise exception 'inventory_list_value: % holds a value it does not accept', v_key
            using errcode = '22023';
        end if;
      end loop;
    elsif v_key in ('auto_archived', 'awaiting_first_receipt', 'charter_generic',
                    'out_of_stock', 'has_unit_cost', 'low_stock', 'exclude_bundles',
                    'order_catalog_visible', 'is_rental') then
      if jsonb_typeof(v_value) <> 'boolean' then
        raise exception 'inventory_list_value: % must be true or false', v_key
          using errcode = '22023';
      end if;
    elsif v_key in ('status', 'search', 'barcode') then
      v_max := case v_key when 'status' then 32 when 'search' then 120 else 4096 end;
      if jsonb_typeof(v_value) <> 'string'
         or char_length(v_value #>> '{}') not between 1 and v_max then
        raise exception 'inventory_list_value: % must be text of 1 to % characters', v_key, v_max
          using errcode = '22023';
      end if;
    elsif v_key in ('created_since', 'created_until', 'updated_since', 'updated_until') then
      if jsonb_typeof(v_value) <> 'string'
         or char_length(v_value #>> '{}') not between 1 and 64
         or not pg_catalog.pg_input_is_valid(v_value #>> '{}', 'timestamptz') then
        raise exception 'inventory_list_value: % must be a timestamp', v_key
          using errcode = '22023';
      end if;
    elsif v_key = 'rack' then
      if jsonb_typeof(v_value) <> 'object'
         or exists (select 1 from jsonb_object_keys(v_value) k
                     where k not in ('number', 'row', 'label', 'keys'))
         or jsonb_typeof(v_value -> 'number') is distinct from 'string'
         or (v_value ->> 'number') !~ '^[A-Za-z0-9-]{1,40}$'
         or jsonb_typeof(v_value -> 'label') is distinct from 'string'
         or (v_value ->> 'label') !~ '^[A-Za-z0-9-]{1,40}$'
         or coalesce(jsonb_typeof(v_value -> 'row'), 'null') not in ('string', 'null')
         or (jsonb_typeof(v_value -> 'row') = 'string'
             and (v_value ->> 'row') !~ '^[A-Za-z0-9-]{1,40}$')
         or jsonb_typeof(v_value -> 'keys') is distinct from 'string'
         or (v_value ->> 'keys') not in ('item', 'book', 'by_type') then
        raise exception 'inventory_list_value: rack must be {number, row, label, keys} as the list sends it'
          using errcode = '22023';
      end if;
    else
      raise exception 'inventory_list_value: unknown filter %', v_key
        using errcode = '22023';
    end if;
  end loop;

  if p_filters ? 'search_isbn_variants' and not p_filters ? 'search' then
    raise exception 'inventory_list_value: search_isbn_variants is only read with search'
      using errcode = '22023';
  end if;

  if p_filters ? 'warehouse_ids' then
    v_warehouse_ids := array(select jsonb_array_elements_text(p_filters -> 'warehouse_ids'))::uuid[];
  end if;
  if p_filters ? 'category_grants' then
    v_category_grants := array(select jsonb_array_elements_text(p_filters -> 'category_grants'))::uuid[];
  end if;
  if p_filters ? 'category_ids' then
    v_category_ids := array(select jsonb_array_elements_text(p_filters -> 'category_ids'))::uuid[];
  end if;
  if p_filters ? 'location_ids' then
    v_location_ids := array(select jsonb_array_elements_text(p_filters -> 'location_ids'))::uuid[];
  end if;
  if p_filters ? 'supplier_ids' then
    v_supplier_ids := array(select jsonb_array_elements_text(p_filters -> 'supplier_ids'))::uuid[];
  end if;
  if p_filters ? 'charter_ids' then
    v_charter_ids := array(select jsonb_array_elements_text(p_filters -> 'charter_ids'))::uuid[];
  end if;
  if p_filters ? 'ids' then
    v_ids := array(select jsonb_array_elements_text(p_filters -> 'ids'))::uuid[];
  end if;
  if p_filters ? 'item_types' then
    v_item_types := array(select jsonb_array_elements_text(p_filters -> 'item_types'));
  end if;
  if p_filters ? 'search_isbn_variants' then
    v_isbn := array(select jsonb_array_elements_text(p_filters -> 'search_isbn_variants'));
  end if;
  v_status := p_filters ->> 'status';
  v_auto_archived := (p_filters ->> 'auto_archived')::boolean;
  v_awaiting := (p_filters ->> 'awaiting_first_receipt')::boolean;
  v_search := p_filters ->> 'search';
  v_barcode := p_filters ->> 'barcode';
  v_rack_number := p_filters #>> '{rack,number}';
  v_rack_row := p_filters #>> '{rack,row}';
  v_rack_label := p_filters #>> '{rack,label}';
  v_rack_keys := p_filters #>> '{rack,keys}';
  v_charter_generic := coalesce((p_filters ->> 'charter_generic')::boolean, false);
  v_out_of_stock := coalesce((p_filters ->> 'out_of_stock')::boolean, false);
  v_has_unit_cost := coalesce((p_filters ->> 'has_unit_cost')::boolean, false);
  v_low_stock := coalesce((p_filters ->> 'low_stock')::boolean, false);
  v_exclude_bundles := coalesce((p_filters ->> 'exclude_bundles')::boolean, false);
  v_order_catalog_visible := (p_filters ->> 'order_catalog_visible')::boolean;
  v_is_rental := (p_filters ->> 'is_rental')::boolean;
  v_created_since := (p_filters ->> 'created_since')::timestamptz;
  v_created_until := (p_filters ->> 'created_until')::timestamptz;
  v_updated_since := (p_filters ->> 'updated_since')::timestamptz;
  v_updated_until := (p_filters ->> 'updated_until')::timestamptz;

  select coalesce(sum(coalesce(i.quantity_on_hand, 0) * coalesce(i.unit_cost, 0)), 0)
    into v_total
    from public.inventory_items i
   where i.organization_id = p_organization_id
     and i.deleted_at is null
     and (v_warehouse_ids is null or i.warehouse_id = any (v_warehouse_ids))
     and (v_category_grants is null or i.category_id = any (v_category_grants))
     and (v_status is null or i.status = v_status)
     and (v_auto_archived is null or i.auto_archived = v_auto_archived)
     and (v_awaiting is null or i.awaiting_first_receipt = v_awaiting)
     and (v_search is null
          or i.name ilike ('%' || v_search || '%')
          or i.sku ilike ('%' || v_search || '%')
          or i.barcode ilike ('%' || v_search || '%')
          or i.model_number ilike ('%' || v_search || '%')
          or i.barcode = any (v_isbn))
     and (v_barcode is null or i.barcode = v_barcode)
     and (v_rack_number is null
          or (v_rack_keys = 'by_type'
              and ((i.item_type = 'book'
                    and (case when v_rack_row is null
                              then i.custom_fields ->> 'book_rack_number' = v_rack_number
                              else (i.custom_fields ->> 'book_rack_number' = v_rack_number
                                    and i.custom_fields ->> 'book_rack_row' = v_rack_row)
                                   or i.custom_fields ->> 'book_rack_number' = v_rack_label
                         end))
                   or (i.item_type <> 'book'
                       and (case when v_rack_row is null
                                 then i.custom_fields ->> 'rack_number' = v_rack_number
                                 else (i.custom_fields ->> 'rack_number' = v_rack_number
                                       and i.custom_fields ->> 'rack_row' = v_rack_row)
                                      or i.custom_fields ->> 'rack_number' = v_rack_label
                            end))))
          or (v_rack_keys = 'book'
              and (case when v_rack_row is null
                        then i.custom_fields ->> 'book_rack_number' = v_rack_number
                        else (i.custom_fields ->> 'book_rack_number' = v_rack_number
                              and i.custom_fields ->> 'book_rack_row' = v_rack_row)
                             or i.custom_fields ->> 'book_rack_number' = v_rack_label
                   end))
          or (v_rack_keys = 'item'
              and (case when v_rack_row is null
                        then i.custom_fields ->> 'rack_number' = v_rack_number
                        else (i.custom_fields ->> 'rack_number' = v_rack_number
                              and i.custom_fields ->> 'rack_row' = v_rack_row)
                             or i.custom_fields ->> 'rack_number' = v_rack_label
                   end)))
     and (v_category_ids is null or i.category_id = any (v_category_ids))
     and (v_location_ids is null or i.primary_location_id = any (v_location_ids))
     and (v_supplier_ids is null or i.supplier_id = any (v_supplier_ids))
     and ((v_charter_ids is null and not v_charter_generic)
          or (v_charter_generic and i.charter_id is null)
          or i.charter_id = any (v_charter_ids))
     and (not v_out_of_stock or i.quantity_on_hand <= 0)
     and (not v_has_unit_cost or i.unit_cost > 0)
     and (not v_low_stock or public.is_low_stock(i))
     and (v_item_types is null or i.item_type = any (v_item_types))
     and (not v_exclude_bundles or i.is_bundle is not true)
     and (v_order_catalog_visible is null or i.order_catalog_visible = v_order_catalog_visible)
     and (v_is_rental is null or i.is_rental = v_is_rental)
     and (v_created_since is null or i.created_at >= v_created_since)
     and (v_created_until is null or i.created_at < v_created_until)
     and (v_updated_since is null or i.updated_at >= v_updated_since)
     and (v_updated_until is null or i.updated_at < v_updated_until)
     and (v_ids is null or i.id = any (v_ids));

  return v_total;
end;
$$;

comment on function public.inventory_list_value(uuid, jsonb) is
  'Inventory list value footer (0470): sum(quantity_on_hand x unit_cost) over the organization''s live records matching p_filters, the same filters as the list''s page request (built by buildItemListValueFilters in the app). SECURITY INVOKER: the caller''s row level security applies. Unknown keys and malformed values are refused with 22023. authenticated may execute; anon and PUBLIC may not.';

revoke all on function public.inventory_list_value(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.inventory_list_value(uuid, jsonb) to authenticated;
