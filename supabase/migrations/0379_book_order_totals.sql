-- 0379_book_order_totals.sql
--
-- Book Order Totals: which books people asked for through Orders, how many
-- copies, and the orders behind each total. Read-only: no table, no column,
-- no index, no view, no data change, no counter, no cron. Five functions,
-- their comments and their grants.
--
-- ── WHAT "ORDERED" MEANS (the one eligibility definition) ──────────────────
-- A line L on order O for item I counts when all of these hold
-- (book_order_report_lines):
--   E1  O and I belong to the organization asked about, explicitly (RLS alone
--       spans every organization the caller belongs to).
--   E2  The caller can read O (orders RLS), L (lines RLS), I (items RLS:
--       warehouse, charter, category) and O's warehouse (warehouses RLS). All
--       four are INNER JOINs and every function is SECURITY INVOKER, so a
--       total can never include a book or warehouse the caller cannot read.
--   E3  O's CURRENT status is in the chosen set. Default: every status except
--       pending_confirmation, denied and cancelled (11). pending_confirmation
--       (an unconfirmed public-link form) is never selectable.
--   E4  I.item_type = 'book' (its current type).
--   E5  I is not a bundle (kit stock is never a copy).
--   E6  Any item status and any deleted_at: archived, discontinued and
--       soft-deleted books keep their history.
--   E7  O.created_at (as saved) falls in [start, end), where start is the
--       first chosen day at 00:00 and end is the day after the last chosen
--       day at 00:00, both in the organization's time zone. All time: no
--       bound.
--   E8  Optional: O's warehouse, I's category (or "no category"), and a
--       search on I (title, SKU, barcode, legacy isbn keys; ISBN keys
--       compared digit for digit).
--   E9  Every source counts (internal, public_link, portal): one order row
--       per order, nothing to dedupe.
--   E10 is_rental does not exclude a line (a rental item cannot be put on a
--       new line; old lines keep counting, flagged nowRental).
-- The primary measure is sum(quantity_requested) per line, each line once.
-- quantity_fulfilled and returned_quantity are carried separately and never
-- subtracted. The query reads only order_requests, order_request_lines,
-- inventory_items and warehouses, each one-to-one or many-to-one from the
-- line, so images, holdings, reservations, returns, approvals and audit rows
-- can never multiply a sum.
--
-- Units: an item whose CURRENT unit_of_measure is one of unit, units, ea,
-- each, copy, copies, pc, pcs, piece, pieces counts as copies. Any other unit
-- (blank included) is still a row, counts in entries and orders, and is left
-- out of the copy total and disclosed in summary.unresolved.
--
-- ── WHY SECURITY INVOKER, AND plan_cache_mode ──────────────────────────────
-- RLS applies by construction, so the report follows any future policy
-- change (category approval routing) without a restatement to drift. The
-- gates are in each function body as well: signed in (42501
-- unauthenticated), a member holding reports:read (42501 forbidden, one
-- error for both so existence does not leak), and the orders and books
-- modules (P0001 module_disabled). Nothing raises 40001 or 40P01.
--
-- plpgsql caches statement plans per session and may switch to a generic
-- plan after five calls on a pooled connection; a generic plan cannot fold
-- the catch-all filters ("p_x is null or col = p_x"). Every function here
-- sets plan_cache_mode = force_custom_plan (a USERSET parameter, so an
-- INVOKER function may set it for its own calls), so every call is planned
-- against its real values. This is the first public function to set it.
--
-- ── ANSWERS ────────────────────────────────────────────────────────────────
-- book_order_totals, book_order_totals_orders and book_order_totals_options
-- each return ONE jsonb value from ONE statement, so PostgREST's max_rows can
-- never cut an answer short, and the summary, total count and rows describe
-- one database state. generatedAt is when the figures were read, not a
-- frozen snapshot. Quantities are strings (exact numeric text); counts are
-- integers; every date a person reads is an org-local YYYY-MM-DD string, so
-- no client converts zones. No requester id, name, email, note, signature or
-- contact field is selected anywhere: `mine` is a boolean about the caller.
--
-- book_order_report_range and book_order_report_lines are the building
-- blocks; the apps never call them directly. Called over REST they return
-- sets, which max_rows may cut, and only the caller's own RLS-visible rows.
--
-- Grants: authenticated only. PUBLIC, anon and service_role are revoked
-- explicitly (Supabase's default privileges would otherwise leave
-- service_role with EXECUTE; a service-role call has no caller and would be
-- refused by the first gate anyway).

set lock_timeout = '5s';

-- ═══ 1. The date range and the organization's time zone ══════════════════
create or replace function public.book_order_report_range(
  p_organization_id uuid,
  p_range           text default 'all',
  p_from_date       date default null,
  p_to_date         date default null
)
returns table (
  range_key          text,
  from_date          date,
  to_date            date,
  time_zone          text,
  time_zone_fallback boolean,
  starts_at          timestamptz,
  ends_before        timestamptz
)
language plpgsql
stable
security invoker
set search_path = public
set plan_cache_mode = force_custom_plan
as $$
declare
  v_key      text := coalesce(nullif(btrim(p_range), ''), 'all');
  v_raw      text;
  v_tz       text := 'America/Los_Angeles';   -- = core ORG_TIMEZONE_DEFAULT
  v_fallback boolean := true;
  v_today    date;
  v_from     date;
  v_to       date;
begin
  if (select auth.uid()) is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;
  if not public.is_org_member(p_organization_id)
     or not public.has_permission(p_organization_id, 'reports:read') then
    raise exception 'forbidden' using errcode = '42501', hint = 'forbidden';
  end if;
  if not (public.module_enabled(p_organization_id, 'orders')
          and public.module_enabled(p_organization_id, 'books')) then
    raise exception 'module disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;

  -- The organization's zone, read under RLS. It is NOT NULL with no CHECK, so
  -- a blank, a POSIX form ('UTC+5', which Postgres reads with the sign
  -- inverted), an abbreviation ('PST') or a name missing from the server's tz
  -- data all fall back. Only IANA Area/Location names (plus UTC and GMT) are
  -- tried, and an unknown one is caught; pg_timezone_names is never scanned
  -- (it costs ~55 ms per call).
  select nullif(btrim(o.timezone), '') into v_raw
    from public.organizations o
   where o.id = p_organization_id;
  if v_raw is not null
     and (v_raw in ('UTC', 'GMT') or v_raw ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+){1,2}$') then
    begin
      perform now() at time zone v_raw;
      v_tz := v_raw;
      v_fallback := false;
    exception when invalid_parameter_value then
      null;  -- keep the fallback
    end;
  end if;

  v_today := (now() at time zone v_tz)::date;
  if v_key = 'all' then
    v_from := null; v_to := null;
  elsif v_key = 'month' then
    v_from := date_trunc('month', v_today)::date; v_to := v_today;
  elsif v_key = '30d' then
    v_from := v_today - 29; v_to := v_today;
  elsif v_key = '90d' then
    v_from := v_today - 89; v_to := v_today;
  elsif v_key = 'year' then
    v_from := date_trunc('year', v_today)::date; v_to := v_today;
  elsif v_key = 'custom' then
    if p_from_date is null or p_to_date is null
       or p_from_date > p_to_date
       or p_from_date < date '2000-01-01' or p_to_date > date '2100-12-31' then
      raise exception 'invalid range' using errcode = '22023', hint = 'invalid_range';
    end if;
    v_from := p_from_date; v_to := p_to_date;
  else
    raise exception 'invalid range' using errcode = '22023', hint = 'invalid_range';
  end if;

  return query
  select v_key, v_from, v_to, v_tz, v_fallback,
         case when v_from is null then null else v_from::timestamp at time zone v_tz end,
         case when v_to   is null then null else (v_to + 1)::timestamp at time zone v_tz end;
end $$;

-- ═══ 2. The eligible lines: the single eligibility definition ════════════
create or replace function public.book_order_report_lines(
  p_organization_id uuid,
  p_range           text    default 'all',
  p_from_date       date    default null,
  p_to_date         date    default null,
  p_statuses        text[]  default null,
  p_warehouse_id    uuid    default null,
  p_category_id     uuid    default null,
  p_uncategorized   boolean default false,
  p_search          text    default null,
  p_isbn_keys       text[]  default null,
  p_item_id         uuid    default null
)
returns table (
  line_id              uuid,
  order_id             uuid,
  item_id              uuid,
  quantity             numeric,
  fulfilled            numeric,
  returned             numeric,
  order_number         bigint,
  order_created_at     timestamptz,
  order_status         text,
  order_warehouse_id   uuid,
  order_warehouse_name text,
  order_is_mine        boolean
)
language plpgsql
stable
security invoker
set search_path = public
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
declare
  c_allowed constant text[] := array['pending_approval','approved','pick_slip_generated',
    'picking_in_progress','picking_complete','packing_slip_generated','staged_for_pickup',
    'staged_for_delivery','in_transit','backordered','completed','denied','cancelled'];
  c_default constant text[] := array['pending_approval','approved','pick_slip_generated',
    'picking_in_progress','picking_complete','packing_slip_generated','staged_for_pickup',
    'staged_for_delivery','in_transit','backordered','completed'];
  v_statuses text[] := coalesce(p_statuses, c_default);
  v_starts   timestamptz;
  v_ends     timestamptz;
  v_pat      text;
  v_keys     text[];
begin
  -- Gates 1-3: signed in; a member holding reports:read (one error for both);
  -- the orders and books modules.
  if (select auth.uid()) is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;
  if not public.is_org_member(p_organization_id)
     or not public.has_permission(p_organization_id, 'reports:read') then
    raise exception 'forbidden' using errcode = '42501', hint = 'forbidden';
  end if;
  if not (public.module_enabled(p_organization_id, 'orders')
          and public.module_enabled(p_organization_id, 'books')) then
    raise exception 'module disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;
  -- Gate 4 (E3): statuses from the 13 selectable ones only.
  if cardinality(v_statuses) is null or cardinality(v_statuses) = 0
     or not (v_statuses <@ c_allowed)
     or exists (select 1 from unnest(v_statuses) s where s is null) then
    raise exception 'invalid status' using errcode = '22023', hint = 'invalid_status';
  end if;
  -- Gate 5: at most 4 ISBN keys, each 10 (last may be X) or 13 characters.
  v_keys := nullif(p_isbn_keys, '{}'::text[]);
  if v_keys is not null and (cardinality(v_keys) > 4 or exists (
       select 1 from unnest(v_keys) k where k is null or k !~ '^([0-9]{9}[0-9X]|[0-9]{13})$')) then
    raise exception 'invalid isbn keys' using errcode = '22023', hint = 'invalid_search';
  end if;
  -- Gate 6: filter ids must be rows of this organization the caller can read
  -- under RLS, WHATEVER their status (an inactive or archived warehouse, a
  -- deleted category), so old demand stays filterable. It reveals nothing
  -- RLS does not already show.
  if p_warehouse_id is not null and not exists (
       select 1 from public.warehouses w0
        where w0.id = p_warehouse_id and w0.organization_id = p_organization_id) then
    raise exception 'invalid warehouse' using errcode = '22023', hint = 'invalid_warehouse';
  end if;
  if (p_category_id is not null and coalesce(p_uncategorized, false))
     or (p_category_id is not null and not exists (
       select 1 from public.categories c0
        where c0.id = p_category_id and c0.organization_id = p_organization_id)) then
    raise exception 'invalid category' using errcode = '22023', hint = 'invalid_category';
  end if;
  -- Gate 7: the range (22023 invalid_range).
  select r.starts_at, r.ends_before into v_starts, v_ends
    from public.book_order_report_range(p_organization_id, p_range, p_from_date, p_to_date) r;
  -- A literal substring: \, % and _ escaped before ILIKE (the 0358
  -- convention), at most 200 characters matched.
  v_pat := case when nullif(btrim(p_search), '') is null then null
    else '%' || replace(replace(replace(left(btrim(p_search), 200), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  end;

  return query
  select l.id, o.id, l.item_id,
         l.quantity_requested, l.quantity_fulfilled, l.returned_quantity,
         o.order_number, o.created_at, o.status, o.warehouse_id, w.name,
         (o.requester_user_id is not null and o.requester_user_id = (select auth.uid()))
    from public.order_requests o                                                   -- orders RLS
    join public.warehouses w on w.id = o.warehouse_id                              -- warehouses RLS (E2)
    join public.order_request_lines l on l.order_request_id = o.id                 -- lines RLS
    join public.inventory_items i on i.id = l.item_id                              -- items RLS (E2)
   where o.organization_id = p_organization_id                                     -- E1
     and i.organization_id = p_organization_id
     and o.status = any (v_statuses)                                               -- E3
     and (v_starts is null or (o.created_at >= v_starts and o.created_at < v_ends)) -- E7
     and i.item_type = 'book'                                                      -- E4
     and not i.is_bundle                                                           -- E5
     and (p_warehouse_id is null or o.warehouse_id = p_warehouse_id)               -- E8
     and (p_category_id  is null or i.category_id  = p_category_id)
     and (not coalesce(p_uncategorized, false) or i.category_id is null)
     and (p_item_id      is null or l.item_id      = p_item_id)
     and ((v_pat is null and v_keys is null)
       or (v_pat is not null and (
             i.name ilike v_pat or coalesce(i.sku, '') ilike v_pat or coalesce(i.barcode, '') ilike v_pat
          or coalesce(i.custom_fields->>'isbn', '')   ilike v_pat
          or coalesce(i.custom_fields->>'isbn13', '') ilike v_pat
          or coalesce(i.custom_fields->>'isbn10', '') ilike v_pat))
       or (v_keys is not null and (
             regexp_replace(upper(coalesce(i.barcode, '')), '[^0-9X]', '', 'g') = any (v_keys)
          or regexp_replace(upper(coalesce(i.custom_fields->>'isbn', '')),   '[^0-9X]', '', 'g') = any (v_keys)
          or regexp_replace(upper(coalesce(i.custom_fields->>'isbn13', '')), '[^0-9X]', '', 'g') = any (v_keys)
          or regexp_replace(upper(coalesce(i.custom_fields->>'isbn10', '')), '[^0-9X]', '', 'g') = any (v_keys))));
end $$;

-- ═══ 3. The report: summary, total count and one page (or every row) ═════
create or replace function public.book_order_totals(
  p_organization_id uuid,
  p_range           text    default 'all',
  p_from_date       date    default null,
  p_to_date         date    default null,
  p_statuses        text[]  default null,
  p_warehouse_id    uuid    default null,
  p_category_id     uuid    default null,
  p_uncategorized   boolean default false,
  p_search          text    default null,
  p_isbn_keys       text[]  default null,
  p_sort            text    default 'copies',
  p_page            integer default 1,
  p_page_size       integer default 25,
  p_all_rows        boolean default false,
  p_max_rows        integer default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
set plan_cache_mode = force_custom_plan
as $$
declare
  c_allowed constant text[] := array['pending_approval','approved','pick_slip_generated',
    'picking_in_progress','picking_complete','packing_slip_generated','staged_for_pickup',
    'staged_for_delivery','in_transit','backordered','completed','denied','cancelled'];
  c_default constant text[] := array['pending_approval','approved','pick_slip_generated',
    'picking_in_progress','picking_complete','packing_slip_generated','staged_for_pickup',
    'staged_for_delivery','in_transit','backordered','completed'];
  v_sort   text := coalesce(nullif(btrim(p_sort), ''), 'copies');
  v_all    boolean := coalesce(p_all_rows, false);
  v_cap    integer := least(greatest(coalesce(p_max_rows, 50000), 1), 50000);
  v_size   integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
  v_rng    record;
  v_result jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;
  if not public.is_org_member(p_organization_id)
     or not public.has_permission(p_organization_id, 'reports:read') then
    raise exception 'forbidden' using errcode = '42501', hint = 'forbidden';
  end if;
  if not (public.module_enabled(p_organization_id, 'orders')
          and public.module_enabled(p_organization_id, 'books')) then
    raise exception 'module disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;
  if v_sort not in ('copies', 'title', 'orders', 'latest') then
    raise exception 'invalid sort' using errcode = '22023', hint = 'invalid_sort';
  end if;
  -- The range first, so a bad range is always invalid_range; the lines
  -- helper then judges statuses, search keys, warehouse and category.
  select * into v_rng
    from public.book_order_report_range(p_organization_id, p_range, p_from_date, p_to_date);

  with lines as materialized (
         select * from public.book_order_report_lines(p_organization_id, p_range, p_from_date, p_to_date,
           p_statuses, p_warehouse_id, p_category_id, p_uncategorized, p_search, p_isbn_keys, null)),
       per_item as (                                  -- grouped per book; distinct orders PER BOOK
         select l.item_id,
                sum(l.quantity) as qty, sum(l.fulfilled) as ful, sum(l.returned) as ret,
                count(distinct l.order_id) as n_orders, count(*) as n_lines,
                max(l.order_created_at) as latest
           from lines l
          group by l.item_id),
       grouped as (
         select p.*, i.name, i.sku, i.bin_location, i.unit_of_measure, i.status as item_status,
                (i.deleted_at is not null) as is_deleted, i.is_rental as now_rental,      -- E6, E10
                i.warehouse_id as item_warehouse_id, wi.name as item_warehouse_name,
                coalesce(nullif(btrim(i.barcode), ''), nullif(btrim(i.custom_fields->>'isbn'), ''),
                         nullif(btrim(i.custom_fields->>'isbn13'), ''),
                         nullif(btrim(i.custom_fields->>'isbn10'), '')) as identifier,
                lower(btrim(coalesce(i.unit_of_measure, ''))) in
                  ('unit','units','ea','each','copy','copies','pc','pcs','piece','pieces') as counts_as_copies
           from per_item p
           join public.inventory_items i on i.id = p.item_id
           left join public.warehouses wi on wi.id = i.warehouse_id),
       totals as (                                    -- GLOBAL distinct orders from lines, never a sum per book
         select coalesce(sum(g.qty) filter (where g.counts_as_copies), 0) as copies,
                count(*) as entries,
                count(*) filter (where not g.counts_as_copies) as unresolved_entries,
                coalesce(sum(g.qty) filter (where not g.counts_as_copies), 0) as unresolved_qty,
                (select count(distinct x.order_id) from lines x) as n_orders,
                (select count(*) from lines x) as n_lines,
                (select min(x.order_created_at) from lines x) as first_at,
                (select max(x.order_created_at) from lines x) as last_at
           from grouped g),
       paging as (
         select case when v_all then 1
                     when t.entries = 0 then 1
                     else least(greatest(coalesce(p_page, 1), 1),
                                ceil(t.entries::numeric / v_size)::integer) end as eff,
                (v_all and t.entries > v_cap) as too_many
           from totals t),
       ordered as (
         select g.*, row_number() over (order by
                  case when v_sort = 'copies' then g.counts_as_copies end desc nulls last,  -- copies first,
                  case when v_sort = 'copies' then g.qty end desc nulls last,               -- then quantity
                  case when v_sort = 'title'  then lower(g.name) end asc nulls last,
                  case when v_sort = 'orders' then g.n_orders end desc nulls last,
                  case when v_sort = 'latest' then g.latest end desc nulls last,
                  g.item_id asc) as rn                                                       -- stable tie-breaker
           from grouped g),
       page_rows as (
         select o.* from ordered o, paging pg
          where not pg.too_many
            and (v_all or (o.rn > (pg.eff - 1) * v_size and o.rn <= pg.eff * v_size)))
  select jsonb_build_object(
    'v', 1,
    'generatedAt', now(),
    'generatedAtLocal', to_char(now() at time zone v_rng.time_zone, 'YYYY-MM-DD HH24:MI'),
    'range', jsonb_build_object('key', v_rng.range_key, 'from', v_rng.from_date, 'to', v_rng.to_date,
                                'timeZone', v_rng.time_zone, 'timeZoneFallback', v_rng.time_zone_fallback),
    'statuses', to_jsonb(array(select s from unnest(c_allowed) s
                                where s = any (coalesce(p_statuses, c_default)))),
    'filters', jsonb_build_object(
      'warehouse', (select jsonb_build_object('id', w.id, 'name', w.name, 'status', w.status)
                      from public.warehouses w where w.id = p_warehouse_id),
      'category',  (select jsonb_build_object('id', c.id, 'name', c.name, 'deleted', c.deleted_at is not null)
                      from public.categories c where c.id = p_category_id),
      'uncategorized', coalesce(p_uncategorized, false)),
    'scope', jsonb_build_object('restricted',
      not public.has_org_role(p_organization_id, 'manager')
      or p_organization_id not in (select public.rls_cat_unrestricted_org_ids())),
    'summary', (select jsonb_build_object(
      'copies', trim_scale(t.copies)::text, 'entries', t.entries, 'orders', t.n_orders, 'lines', t.n_lines,
      'firstOrderAt', t.first_at, 'lastOrderAt', t.last_at,
      'firstOrderDate', to_char(t.first_at at time zone v_rng.time_zone, 'YYYY-MM-DD'),
      'lastOrderDate',  to_char(t.last_at  at time zone v_rng.time_zone, 'YYYY-MM-DD'),
      'unresolved', jsonb_build_object('entries', t.unresolved_entries,
                                       'quantity', trim_scale(t.unresolved_qty)::text))
      from totals t),
    'totalCount', (select t.entries from totals t),
    'mode', case when v_all then 'all' else 'page' end,
    'tooMany', (select pg.too_many from paging pg),
    'maxRows', case when v_all then v_cap end,
    'page', (select pg.eff from paging pg),
    'pageSize', case when v_all then null else v_size end,
    'sort', v_sort,
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'itemId', r.item_id, 'name', r.name, 'sku', r.sku, 'identifier', r.identifier,
        'binLocation', r.bin_location, 'unit', r.unit_of_measure, 'countsAsCopies', r.counts_as_copies,
        'warehouseId', r.item_warehouse_id, 'warehouseName', r.item_warehouse_name,
        'itemStatus', r.item_status, 'deleted', r.is_deleted, 'nowRental', r.now_rental,
        'copies', trim_scale(r.qty)::text, 'orders', r.n_orders, 'lines', r.n_lines,
        'latestOrderAt', r.latest,
        'latestOrderDate', to_char(r.latest at time zone v_rng.time_zone, 'YYYY-MM-DD'),
        'fulfilled', trim_scale(r.ful)::text, 'returned', trim_scale(r.ret)::text) order by r.rn)
        from page_rows r), '[]'::jsonb))
    into v_result;

  return v_result;
end $$;

-- ═══ 4. The drill-down: the orders behind one book's total ═══════════════
create or replace function public.book_order_totals_orders(
  p_organization_id uuid,
  p_item_id         uuid,
  p_range           text    default 'all',
  p_from_date       date    default null,
  p_to_date         date    default null,
  p_statuses        text[]  default null,
  p_warehouse_id    uuid    default null,
  p_page            integer default 1,
  p_page_size       integer default 25
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
set plan_cache_mode = force_custom_plan
as $$
declare
  c_allowed constant text[] := array['pending_approval','approved','pick_slip_generated',
    'picking_in_progress','picking_complete','packing_slip_generated','staged_for_pickup',
    'staged_for_delivery','in_transit','backordered','completed','denied','cancelled'];
  c_default constant text[] := array['pending_approval','approved','pick_slip_generated',
    'picking_in_progress','picking_complete','packing_slip_generated','staged_for_pickup',
    'staged_for_delivery','in_transit','backordered','completed'];
  v_size   integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
  v_rng    record;
  v_result jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;
  if not public.is_org_member(p_organization_id)
     or not public.has_permission(p_organization_id, 'reports:read') then
    raise exception 'forbidden' using errcode = '42501', hint = 'forbidden';
  end if;
  if not (public.module_enabled(p_organization_id, 'orders')
          and public.module_enabled(p_organization_id, 'books')) then
    raise exception 'module disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;
  -- Without an item the helper would answer for every book.
  if p_item_id is null then
    raise exception 'invalid item' using errcode = '22023', hint = 'invalid_item';
  end if;
  select * into v_rng
    from public.book_order_report_range(p_organization_id, p_range, p_from_date, p_to_date);

  -- Search and category are item-level filters, so they never change one
  -- book's own totals: the drill-down takes the range, statuses and warehouse.
  with lines as materialized (
         select * from public.book_order_report_lines(p_organization_id, p_range, p_from_date, p_to_date,
           p_statuses, p_warehouse_id, null, false, null, null, p_item_id)),
       book as (                                      -- RLS again: hidden, non-book or missing is found:false
         select i.id, i.name, i.sku, i.bin_location, i.unit_of_measure, i.status as item_status,
                (i.deleted_at is not null) as is_deleted, i.is_rental as now_rental,
                i.warehouse_id as item_warehouse_id, wi.name as item_warehouse_name,
                coalesce(nullif(btrim(i.barcode), ''), nullif(btrim(i.custom_fields->>'isbn'), ''),
                         nullif(btrim(i.custom_fields->>'isbn13'), ''),
                         nullif(btrim(i.custom_fields->>'isbn10'), '')) as identifier,
                lower(btrim(coalesce(i.unit_of_measure, ''))) in
                  ('unit','units','ea','each','copy','copies','pc','pcs','piece','pieces') as counts_as_copies
           from public.inventory_items i
           left join public.warehouses wi on wi.id = i.warehouse_id
          where i.id = p_item_id and i.organization_id = p_organization_id
            and i.item_type = 'book' and not i.is_bundle),
       per_order as (                                 -- duplicate lines combined PER ORDER, line ids kept
         select l.order_id, l.order_number, l.order_created_at, l.order_status,
                l.order_warehouse_id, l.order_warehouse_name,
                bool_or(l.order_is_mine) as mine,
                sum(l.quantity) as qty, sum(l.fulfilled) as ful, sum(l.returned) as ret,
                count(*) as n_lines,
                array_agg(l.line_id order by l.line_id) as line_ids
           from lines l
          group by l.order_id, l.order_number, l.order_created_at, l.order_status,
                   l.order_warehouse_id, l.order_warehouse_name),
       t as (
         select count(*) as n, coalesce(sum(po.qty), 0) as copies, coalesce(sum(po.n_lines), 0) as n_lines,
                coalesce(sum(po.ful), 0) as ful, coalesce(sum(po.ret), 0) as ret
           from per_order po),
       paging as (
         select case when t.n = 0 then 1
                     else least(greatest(coalesce(p_page, 1), 1), ceil(t.n::numeric / v_size)::integer) end as eff
           from t),
       ordered as (
         select po.*, row_number() over (order by po.order_created_at desc, po.order_id desc) as rn
           from per_order po),
       page_rows as (
         select o.* from ordered o, paging pg
          where o.rn > (pg.eff - 1) * v_size and o.rn <= pg.eff * v_size)
  select jsonb_build_object(
    'v', 1,
    'generatedAt', now(),
    'generatedAtLocal', to_char(now() at time zone v_rng.time_zone, 'YYYY-MM-DD HH24:MI'),
    'found', exists (select 1 from book),
    'book', (select jsonb_build_object(
        'itemId', b.id, 'name', b.name, 'sku', b.sku, 'identifier', b.identifier,
        'binLocation', b.bin_location, 'unit', b.unit_of_measure, 'countsAsCopies', b.counts_as_copies,
        'warehouseId', b.item_warehouse_id, 'warehouseName', b.item_warehouse_name,
        'itemStatus', b.item_status, 'deleted', b.is_deleted, 'nowRental', b.now_rental)
        from book b),
    'range', jsonb_build_object('key', v_rng.range_key, 'from', v_rng.from_date, 'to', v_rng.to_date,
                                'timeZone', v_rng.time_zone, 'timeZoneFallback', v_rng.time_zone_fallback),
    'statuses', to_jsonb(array(select s from unnest(c_allowed) s
                                where s = any (coalesce(p_statuses, c_default)))),
    'filters', jsonb_build_object(
      'warehouse', (select jsonb_build_object('id', w.id, 'name', w.name, 'status', w.status)
                      from public.warehouses w where w.id = p_warehouse_id)),
    'totals', (select jsonb_build_object(
        'copies', trim_scale(t.copies)::text, 'orders', t.n, 'lines', t.n_lines,
        'fulfilled', trim_scale(t.ful)::text, 'returned', trim_scale(t.ret)::text) from t),
    'totalCount', (select t.n from t),
    'page', (select pg.eff from paging pg),
    'pageSize', v_size,
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'orderId', r.order_id, 'orderNumber', r.order_number,
        'createdAt', r.order_created_at,
        'orderDate', to_char(r.order_created_at at time zone v_rng.time_zone, 'YYYY-MM-DD'),
        'status', r.order_status, 'warehouseId', r.order_warehouse_id,
        'warehouseName', r.order_warehouse_name, 'mine', r.mine,
        'copies', trim_scale(r.qty)::text, 'fulfilled', trim_scale(r.ful)::text,
        'returned', trim_scale(r.ret)::text, 'lines', r.n_lines, 'lineIds', to_jsonb(r.line_ids))
        order by r.rn) from page_rows r), '[]'::jsonb))
    into v_result;

  return v_result;
end $$;

-- ═══ 5. Filter options from the caller's eligible lines ══════════════════
create or replace function public.book_order_totals_options(
  p_organization_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
set plan_cache_mode = force_custom_plan
as $$
declare
  c_allowed constant text[] := array['pending_approval','approved','pick_slip_generated',
    'picking_in_progress','picking_complete','packing_slip_generated','staged_for_pickup',
    'staged_for_delivery','in_transit','backordered','completed','denied','cancelled'];
  v_result jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
  end if;
  if not public.is_org_member(p_organization_id)
     or not public.has_permission(p_organization_id, 'reports:read') then
    raise exception 'forbidden' using errcode = '42501', hint = 'forbidden';
  end if;
  if not (public.module_enabled(p_organization_id, 'orders')
          and public.module_enabled(p_organization_id, 'books')) then
    raise exception 'module disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;

  -- Every selectable status and all time, so an option exists wherever the
  -- caller can see demand, whatever the warehouse's status or whether the
  -- category was deleted since.
  with lines as materialized (
         select * from public.book_order_report_lines(p_organization_id, 'all', null, null,
           c_allowed, null, null, false, null, null, null)),
       wh as (
         select distinct w.id, w.name, w.status
           from lines l join public.warehouses w on w.id = l.order_warehouse_id),        -- RLS
       cats as (
         select distinct i.category_id
           from lines l join public.inventory_items i on i.id = l.item_id)                -- RLS
  select jsonb_build_object(
    'v', 1,
    'warehouses', coalesce((select jsonb_agg(jsonb_build_object('id', wh.id, 'name', wh.name, 'status', wh.status)
                             order by (wh.status <> 'active'), lower(wh.name), wh.id) from wh), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name,
                                                                'deleted', c.deleted_at is not null)
                             order by (c.deleted_at is not null), lower(c.name), c.id)
                              from cats x join public.categories c on c.id = x.category_id), '[]'::jsonb),  -- RLS
    'uncategorized', exists (select 1 from cats x where x.category_id is null),
    'orderStatusConfig', (select o.order_status_config from public.organizations o
                           where o.id = p_organization_id))
    into v_result;

  return v_result;
end $$;

-- ═══ Comments ═════════════════════════════════════════════════════════════
comment on function public.book_order_report_range(uuid, text, date, date) is
  'Book Order Totals building block (0379): resolves a date preset (all, month, 30d, 90d, year, custom) '
  'to org-local days and [starts_at, ends_before) instants in the organization''s time zone. The zone '
  'is organizations.timezone when it is an IANA name the server knows, else America/Los_Angeles with '
  'time_zone_fallback = true. SECURITY INVOKER, gated in its body (signed in, member with reports:read, '
  'orders and books modules). 22023 invalid_range for an unknown preset or a bad custom range. Not '
  'called by the apps directly, over REST it is a set, subject to max_rows.';

comment on function public.book_order_report_lines(uuid, text, date, date, text[], uuid, uuid, boolean, text, text[], uuid) is
  'Book Order Totals: THE eligibility definition (0379). The caller''s RLS-visible order lines for '
  'book items (not bundles) of one organization, on orders in the chosen statuses (default: all but '
  'pending_confirmation, denied, cancelled) placed in the chosen range, optionally narrowed by order '
  'warehouse, item category, search or ISBN keys. SECURITY INVOKER: orders, lines, items and warehouses '
  'RLS all apply. Gated in its body (signed in, member with reports:read, orders and books modules, '
  'filter ids validated against rows the caller can read, any status). Returns no requester data, '
  'order_is_mine says only whether the caller placed the order. Not called by the apps directly, over '
  'REST it is a set, subject to max_rows.';

comment on function public.book_order_totals(uuid, text, date, date, text[], uuid, uuid, boolean, text, text[], text, integer, integer, boolean, integer) is
  'Book Order Totals (0379): ONE jsonb from ONE statement (so max_rows cannot cut it short and the '
  'summary, count and rows share one snapshot): summary (copies requested on eligible lines, distinct '
  'book entries, distinct orders), totalCount, the effective page and its grouped rows (25 by default, '
  '1..100), sorted by copies (copy units first), title, orders or latest order, ties by item id. Export '
  'mode (p_all_rows) returns every grouped row in sort order, or tooMany with no rows above '
  'least(p_max_rows, 50000). SECURITY INVOKER over book_order_report_lines, gated in its body. Writes '
  'nothing.';

comment on function public.book_order_totals_orders(uuid, uuid, text, date, date, text[], uuid, integer, integer) is
  'Book Order Totals drill-down (0379): ONE jsonb for one book: its totals over the same range, statuses '
  'and warehouse, and a page of the contributing orders (newest first), duplicate lines of an order '
  'combined with their line ids kept. found:false alike for a hidden, non-book or missing item. mine is '
  'a boolean about the caller only, no requester data. SECURITY INVOKER, gated in its body. Writes '
  'nothing.';

comment on function public.book_order_totals_options(uuid) is
  'Book Order Totals filter options (0379): ONE jsonb listing the warehouses (any status) and categories '
  '(deleted ones included, plus whether uncategorized books appear) that occur in the caller''s eligible '
  'lines over every selectable status and all time, and the organization''s order_status_config for '
  'labels. SECURITY INVOKER, gated in its body. Writes nothing.';

-- ═══ Grants: authenticated only ══════════════════════════════════════════
revoke all on function public.book_order_report_range(uuid, text, date, date) from public, anon, service_role;
grant execute on function public.book_order_report_range(uuid, text, date, date) to authenticated;

revoke all on function public.book_order_report_lines(uuid, text, date, date, text[], uuid, uuid, boolean, text, text[], uuid) from public, anon, service_role;
grant execute on function public.book_order_report_lines(uuid, text, date, date, text[], uuid, uuid, boolean, text, text[], uuid) to authenticated;

revoke all on function public.book_order_totals(uuid, text, date, date, text[], uuid, uuid, boolean, text, text[], text, integer, integer, boolean, integer) from public, anon, service_role;
grant execute on function public.book_order_totals(uuid, text, date, date, text[], uuid, uuid, boolean, text, text[], text, integer, integer, boolean, integer) to authenticated;

revoke all on function public.book_order_totals_orders(uuid, uuid, text, date, date, text[], uuid, integer, integer) from public, anon, service_role;
grant execute on function public.book_order_totals_orders(uuid, uuid, text, date, date, text[], uuid, integer, integer) to authenticated;

revoke all on function public.book_order_totals_options(uuid) from public, anon, service_role;
grant execute on function public.book_order_totals_options(uuid) to authenticated;
