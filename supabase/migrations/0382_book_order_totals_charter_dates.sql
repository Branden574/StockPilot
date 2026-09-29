-- 0382_book_order_totals_charter_dates.sql
--
-- Book Order Totals: the ORDER's charter as a filter, and two more date
-- presets (Today; This week, starting Sunday). An extension of 0379, not a
-- rewrite: the eligibility definition stays in book_order_report_lines, and
-- every answer (summary, rows, page count, drill-down, both export files and
-- the new by-charter breakdown) still comes from the same lines in the same
-- statement. Read-only: no table, no column, no index, no view, no policy, no
-- data change. Functions, their comments and their grants only.
--
-- ── WHAT 0382 ADDS ─────────────────────────────────────────────────────────
--   E2b  Charter visibility (owner decision Q1, option B). A reader whose
--        access at a warehouse is limited to some charters (a
--        user_warehouse_assignments row with a charter, and no row without
--        one there) sees, at that warehouse, only orders placed for those
--        charters plus orders with no charter (pickups and a few early
--        delivery orders saved without one). Managers, admins, owners and
--        anyone with a charter-free row at every assigned warehouse are not
--        affected: the whole arm folds to true. A leakproof necessary
--        condition (E2b-pre, uuid = ANY(array) and IS NULL only) runs first so
--        the planner may apply it before the orders policy; it is implied by
--        E2b and changes no result. E2b is a report-scope rule, not a security
--        boundary: order_requests stays readable by every member.
--   6b   The selected charter must be one the caller may report on
--        (book_order_report_charters, judged over all statuses and all time).
--        An unknown id, another organization's charter and a charter outside
--        the caller's scope are ONE refusal: 22023, hint invalid_charter,
--        message 'invalid charter', raised before any statement output. The
--        body is identical for the three causes; response time may differ
--        (a charter row that exists is evaluated, an unknown id is not), and
--        that is accepted because every member can read the organization's
--        charter ids and names already. Choosing a charter together with "no
--        charter" is the same refusal. An AUTHORIZED charter with nothing in
--        the chosen dates is an honest zero with its name.
--   E8b  The charter filter itself: o.delivery_charter_id = p_charter_id, or
--        o.delivery_charter_id IS NULL for "No charter". Both are plain uuid
--        comparisons ANDed after E1-E2b, so the charter can only narrow a set
--        visibility already bounded; it never widens anything.
--   Presets today and week in book_order_report_range (org zone; the week
--        starts on Sunday, computed as today minus its day of week, never an
--        ISO Monday week).
--   The charters block book_order_report_charters (id, name, code and status
--        only), options.charters and options.noCharter, filters.charter and
--        filters.noCharter echoes, drill-down charterId/charterName/
--        charterCode per order, and totals.byCharter (page mode with All
--        charters only: copies and orders per order charter from the same
--        lines, the No charter bucket last).
--
-- The charter is the ORDER's delivery charter, order_requests.
-- delivery_charter_id: the site the order was placed for. It is never
-- inventory_items.charter_id (who owns the stock; every ordered book is
-- generic stock, so it would read 0 for every charter) and never
-- purchase_orders.charter_id (the bill-to on a purchase). Pickup orders have
-- no charter and appear under No charter, so a charter's total counts the
-- orders delivered to it.
--
-- ── WHY DROP + CREATE FOR THREE FUNCTIONS ──────────────────────────────────
-- CREATE OR REPLACE cannot add parameters (it would leave a second overload
-- beside the old one, and a PostgREST named call that fits both fails with
-- PGRST203 while the old body stays callable) and cannot change a RETURNS
-- TABLE. So the three 0379 identities that gain parameters are dropped here,
-- without CASCADE, and recreated; nothing old remains. The new parameters are
-- trailing and defaulted, so named calls that omit them (the web build before
-- its deploy) and the positional calls inside these functions keep resolving.
-- Range and options keep their identities and are replaced in place.
--
-- Writes nothing. Nothing raises a serialization or deadlock SQLSTATE.

set lock_timeout = '5s';

-- ═══ 0. The 0379 signatures that change (no overload may remain) ═══════════
drop function if exists public.book_order_totals(uuid, text, date, date, text[], uuid, uuid, boolean, text, text[], text, integer, integer, boolean, integer);
drop function if exists public.book_order_totals_orders(uuid, uuid, text, date, date, text[], uuid, integer, integer);
drop function if exists public.book_order_report_lines(uuid, text, date, date, text[], uuid, uuid, boolean, text, text[], uuid);

-- ═══ 1. The date range: 0379 plus today and week ═════════════════════════
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
  elsif v_key = 'today' then
    v_from := v_today; v_to := v_today;
  elsif v_key = 'week' then
    -- The week starts on Sunday (the calendars are Sunday-first): today minus
    -- its day of week (0 = Sunday). Never an ISO week, which starts Monday.
    v_from := v_today - extract(dow from v_today)::integer; v_to := v_today;
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

-- ═══ 2. The charters a reader may report on ═══════════════════════════════
-- A charter of the organization is listed when
--   A1/A2  it is active AND (a warehouse where the caller reads every charter
--          services it, OR it is one of the caller's own charter pairs at an
--          assigned warehouse); or
--   A3     an eligible, visible book line exists on an order placed for it
--          (any of the 13 selectable statuses, all time, the four joins under
--          RLS, and E2b), whatever the charter's status.
-- A3 is skipped for a charter-scoped caller when the charter is not theirs
-- and they have no full-access warehouse: E2b could admit none of its orders
-- then, so the probe could find nothing (an exact consequence of E2b, not a
-- guess). It is never narrowed to "a full-access warehouse services it": the
-- warehouse/charter pairing of an order is not enforced, so that would hide
-- real history. This block never calls book_order_report_lines (gate 6b
-- there calls this block; the reverse would recurse); its probe restates the
-- eligibility and pgTAP holds the two equal.
create function public.book_order_report_charters(
  p_organization_id uuid,
  p_charter_id      uuid default null
)
returns table (id uuid, name text, code text, status text)
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
  v_full     uuid[];
  v_assigned uuid[];
  v_pairs_ch uuid[];
  v_scoped   boolean;
begin
  -- Gates 1-3, as in every Book Order Totals function.
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
  -- E2b inputs: the caller's full-access and assigned warehouses in this
  -- organization, whether they are charter-scoped anywhere here, and the
  -- charters of their own pairs at assigned warehouses. Computed once, as
  -- parameters, never per row.
  v_full     := array(select w.id from public.warehouses w
                       where w.organization_id = p_organization_id
                         and w.id in (select public.rls_inv_read_full_warehouse_ids()));
  v_assigned := array(select w.id from public.warehouses w
                       where w.organization_id = p_organization_id
                         and w.id in (select public.rls_inv_read_assigned_warehouse_ids()));
  v_scoped   := exists (select 1 from unnest(v_assigned) a(wid) where not (a.wid = any (v_full)));
  v_pairs_ch := array(select r.charter_id from public.rls_inv_read_warehouse_charter_ids() r
                       where r.warehouse_id = any (v_assigned));

  return query
  select c.id, c.name, c.code, c.status
    from public.charters c                                                      -- charters RLS
   where c.organization_id = p_organization_id
     and (p_charter_id is null or c.id = p_charter_id)
     and (
           (c.status = 'active' and (
                c.id = any (v_pairs_ch)                                                -- A2
             or exists (select 1 from public.warehouse_charters wc                    -- A1
                         where wc.charter_id = c.id and wc.warehouse_id = any (v_full))))
        or ((not v_scoped or c.id = any (v_pairs_ch) or cardinality(v_full) > 0)    -- A3 guard
            and exists (select 1                                                       -- A3
                     from public.order_requests o                                     -- orders RLS
                     join public.warehouses w on w.id = o.warehouse_id                -- warehouses RLS
                     join public.order_request_lines l on l.order_request_id = o.id   -- lines RLS
                     join public.inventory_items i on i.id = l.item_id                -- items RLS
                    where o.delivery_charter_id = c.id
                      and o.organization_id = p_organization_id
                      and i.organization_id = p_organization_id
                      and o.status = any (c_allowed)
                      and i.item_type = 'book' and not i.is_bundle
                      and (not v_scoped                                               -- E2b-pre (leakproof)
                           or o.warehouse_id = any (v_full)
                           or o.delivery_charter_id = any (v_pairs_ch))
                      and (not v_scoped                                               -- E2b (exact)
                           or o.warehouse_id = any (v_full)
                           or (o.warehouse_id, o.delivery_charter_id) in
                                (select r.warehouse_id, r.charter_id
                                   from public.rls_inv_read_warehouse_charter_ids() r))
                   offset 0)));
end $$;

-- ═══ 3. The eligible lines: THE eligibility definition ════════════════════
create function public.book_order_report_lines(
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
  p_item_id         uuid    default null,
  p_charter_id      uuid    default null,     -- E8b: the ORDER's charter (delivery_charter_id)
  p_no_charter      boolean default false     -- E8b: orders placed with no charter
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
  order_is_mine        boolean,
  order_charter_id     uuid,       -- o.delivery_charter_id (null: a pickup, or saved without one)
  counts_as_copies     boolean     -- the item's CURRENT unit is a single copy
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
  v_full     uuid[];
  v_assigned uuid[];
  v_pairs_ch uuid[];
  v_scoped   boolean;
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
  -- Gate 6b: the selected charter must be one the caller may report on, judged
  -- over all statuses and all time (never the current filters, so a charter
  -- picked from the list never turns invalid when the dates change). An
  -- unknown id, another organization's charter and one outside the caller's
  -- scope are the same refusal; so is a charter together with "no charter".
  -- "No charter" alone names nothing and has no gate.
  if p_charter_id is not null and coalesce(p_no_charter, false) then
    raise exception 'invalid charter' using errcode = '22023', hint = 'invalid_charter';
  end if;
  if p_charter_id is not null and not exists (
       select 1 from public.book_order_report_charters(p_organization_id, p_charter_id)) then
    raise exception 'invalid charter' using errcode = '22023', hint = 'invalid_charter';
  end if;
  -- Gate 7: the range (22023 invalid_range).
  select r.starts_at, r.ends_before into v_starts, v_ends
    from public.book_order_report_range(p_organization_id, p_range, p_from_date, p_to_date) r;
  -- A literal substring: \, % and _ escaped before ILIKE (the 0358
  -- convention), at most 200 characters matched.
  v_pat := case when nullif(btrim(p_search), '') is null then null
    else '%' || replace(replace(replace(left(btrim(p_search), 200), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  end;
  -- E2b inputs (see book_order_report_charters): computed once, as
  -- parameters. Under force_custom_plan a caller who is not charter-scoped
  -- gets v_scoped = false and both E2b clauses fold to true.
  v_full     := array(select w.id from public.warehouses w
                       where w.organization_id = p_organization_id
                         and w.id in (select public.rls_inv_read_full_warehouse_ids()));
  v_assigned := array(select w.id from public.warehouses w
                       where w.organization_id = p_organization_id
                         and w.id in (select public.rls_inv_read_assigned_warehouse_ids()));
  v_scoped   := exists (select 1 from unnest(v_assigned) a(wid) where not (a.wid = any (v_full)));
  v_pairs_ch := array(select r.charter_id from public.rls_inv_read_warehouse_charter_ids() r
                       where r.warehouse_id = any (v_assigned));

  return query
  select l.id, o.id, l.item_id,
         l.quantity_requested, l.quantity_fulfilled, l.returned_quantity,
         o.order_number, o.created_at, o.status, o.warehouse_id, w.name,
         (o.requester_user_id is not null and o.requester_user_id = (select auth.uid())),
         o.delivery_charter_id,
         lower(btrim(coalesce(i.unit_of_measure, ''))) in
           ('unit','units','ea','each','copy','copies','pc','pcs','piece','pieces')
    from public.order_requests o                                                   -- orders RLS
    join public.warehouses w on w.id = o.warehouse_id                              -- warehouses RLS (E2)
    join public.order_request_lines l on l.order_request_id = o.id                 -- lines RLS
    join public.inventory_items i on i.id = l.item_id                              -- items RLS (E2)
   where o.organization_id = p_organization_id                                     -- E1
     and i.organization_id = p_organization_id
     and (not v_scoped                                                             -- E2b-pre (leakproof)
          or o.warehouse_id = any (v_full)
          or o.delivery_charter_id is null
          or o.delivery_charter_id = any (v_pairs_ch))
     and (not v_scoped                                                             -- E2b (exact)
          or o.warehouse_id = any (v_full)
          or (o.delivery_charter_id is null and o.warehouse_id = any (v_assigned))
          or (o.warehouse_id, o.delivery_charter_id) in
               (select r.warehouse_id, r.charter_id from public.rls_inv_read_warehouse_charter_ids() r))
     and o.status = any (v_statuses)                                               -- E3
     and (v_starts is null or (o.created_at >= v_starts and o.created_at < v_ends)) -- E7
     and i.item_type = 'book'                                                      -- E4
     and not i.is_bundle                                                           -- E5
     and (p_warehouse_id is null or o.warehouse_id = p_warehouse_id)               -- E8
     and (p_charter_id   is null or o.delivery_charter_id = p_charter_id)          -- E8b
     and (not coalesce(p_no_charter, false) or o.delivery_charter_id is null)
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

-- ═══ 4. The report: summary, total count and one page (or every row) ═════
create function public.book_order_totals(
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
  p_max_rows        integer default null,
  p_charter_id      uuid    default null,
  p_no_charter      boolean default false
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
  -- 20,000 = core BOOK_REPORT_CSV_MAX_ROWS, the largest per-format ceiling.
  v_cap    integer := least(greatest(coalesce(p_max_rows, 20000), 1), 20000);
  v_size   integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
  -- The by-charter breakdown: page mode with All charters only.
  v_breakdown boolean := not coalesce(p_all_rows, false) and p_charter_id is null
                         and not coalesce(p_no_charter, false);
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
  -- Export mode hands over every row at once: it is the file path, so it
  -- needs reports:export as well (the same 42501 forbidden). The app route
  -- checks it first and adds MFA, the hourly budget and the audit row.
  if v_all and not public.has_permission(p_organization_id, 'reports:export') then
    raise exception 'forbidden' using errcode = '42501', hint = 'forbidden';
  end if;
  if v_sort not in ('copies', 'title', 'orders', 'latest') then
    raise exception 'invalid sort' using errcode = '22023', hint = 'invalid_sort';
  end if;
  -- The range first, so a bad range is always invalid_range; the lines
  -- helper then judges statuses, search keys, warehouse, category and the
  -- charter (gate 6b), all before any output exists.
  select * into v_rng
    from public.book_order_report_range(p_organization_id, p_range, p_from_date, p_to_date);

  with lines as materialized (
         select * from public.book_order_report_lines(p_organization_id, p_range, p_from_date, p_to_date,
           p_statuses, p_warehouse_id, p_category_id, p_uncategorized, p_search, p_isbn_keys, null,
           p_charter_id, p_no_charter)),
       per_item as (                                  -- grouped per book; distinct orders PER BOOK
         select l.item_id,
                sum(l.quantity) as qty, sum(l.fulfilled) as ful, sum(l.returned) as ret,
                count(distinct l.order_id) as n_orders, count(*) as n_lines,
                max(l.order_created_at) as latest,
                bool_and(l.counts_as_copies) as counts_as_copies   -- one unit rule: the lines helper's
           from lines l
          group by l.item_id),
       grouped as (
         select p.*, i.name, i.sku, i.bin_location, i.unit_of_measure, i.status as item_status,
                (i.deleted_at is not null) as is_deleted, i.is_rental as now_rental,      -- E6, E10
                i.warehouse_id as item_warehouse_id, wi.name as item_warehouse_name,
                coalesce(nullif(btrim(i.barcode), ''), nullif(btrim(i.custom_fields->>'isbn'), ''),
                         nullif(btrim(i.custom_fields->>'isbn13'), ''),
                         nullif(btrim(i.custom_fields->>'isbn10'), '')) as identifier
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
            and (v_all or (o.rn > (pg.eff - 1) * v_size and o.rn <= pg.eff * v_size))),
       -- By charter: one row per order (an order has one charter or none), then
       -- per charter. Read from lines only, never joined to grouped. With a
       -- charter chosen, No charter chosen, or in export mode, v_breakdown is
       -- false and both are empty at no cost.
       per_order as (
         select l.order_id, l.order_charter_id,
                sum(l.quantity) filter (where l.counts_as_copies) as copies
           from lines l
          where v_breakdown
          group by l.order_id, l.order_charter_id),
       by_charter as (
         select po.order_charter_id, coalesce(sum(po.copies), 0) as copies, count(*) as n_orders
           from per_order po
          group by po.order_charter_id)
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
      'uncategorized', coalesce(p_uncategorized, false),
      'charter',   (select jsonb_build_object('id', ch.id, 'name', ch.name, 'code', ch.code, 'status', ch.status)
                      from public.charters ch where ch.id = p_charter_id),
      'noCharter', coalesce(p_no_charter, false)),
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
        from page_rows r), '[]'::jsonb),
    'byCharter', case when v_breakdown then coalesce((select jsonb_agg(jsonb_build_object(
        'id', b.order_charter_id, 'name', ch.name, 'code', ch.code, 'status', ch.status,
        'copies', trim_scale(b.copies)::text, 'orders', b.n_orders)
        order by (b.order_charter_id is null), b.copies desc, lower(ch.name), b.order_charter_id)
        from by_charter b left join public.charters ch on ch.id = b.order_charter_id), '[]'::jsonb) end)
    into v_result;

  return v_result;
end $$;

-- ═══ 5. The drill-down: the orders behind one book's total ═══════════════
create function public.book_order_totals_orders(
  p_organization_id uuid,
  p_item_id         uuid,
  p_range           text    default 'all',
  p_from_date       date    default null,
  p_to_date         date    default null,
  p_statuses        text[]  default null,
  p_warehouse_id    uuid    default null,
  p_page            integer default 1,
  p_page_size       integer default 25,
  p_charter_id      uuid    default null,
  p_no_charter      boolean default false
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
  -- book's own totals: the drill-down takes the range, statuses, warehouse
  -- and charter (gate 6b runs in the helper).
  with lines as materialized (
         select * from public.book_order_report_lines(p_organization_id, p_range, p_from_date, p_to_date,
           p_statuses, p_warehouse_id, null, false, null, null, p_item_id, p_charter_id, p_no_charter)),
       book as (                                      -- RLS again: hidden, non-book or missing is found:false
         select i.id, i.name, i.sku, i.bin_location, i.unit_of_measure, i.status as item_status,
                (i.deleted_at is not null) as is_deleted, i.is_rental as now_rental,
                i.warehouse_id as item_warehouse_id, wi.name as item_warehouse_name,
                coalesce(nullif(btrim(i.barcode), ''), nullif(btrim(i.custom_fields->>'isbn'), ''),
                         nullif(btrim(i.custom_fields->>'isbn13'), ''),
                         nullif(btrim(i.custom_fields->>'isbn10'), '')) as identifier,
                -- Its own copy of the unit rule: it describes the book even when
                -- no line is in scope (found with zero orders).
                lower(btrim(coalesce(i.unit_of_measure, ''))) in
                  ('unit','units','ea','each','copy','copies','pc','pcs','piece','pieces') as counts_as_copies
           from public.inventory_items i
           left join public.warehouses wi on wi.id = i.warehouse_id
          where i.id = p_item_id and i.organization_id = p_organization_id
            and i.item_type = 'book' and not i.is_bundle),
       per_order as (                                 -- duplicate lines combined PER ORDER, line ids kept
         select l.order_id, l.order_number, l.order_created_at, l.order_status,
                l.order_warehouse_id, l.order_warehouse_name, l.order_charter_id,
                bool_or(l.order_is_mine) as mine,
                sum(l.quantity) as qty, sum(l.fulfilled) as ful, sum(l.returned) as ret,
                count(*) as n_lines,
                array_agg(l.line_id order by l.line_id) as line_ids
           from lines l
          group by l.order_id, l.order_number, l.order_created_at, l.order_status,
                   l.order_warehouse_id, l.order_warehouse_name, l.order_charter_id),
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
       page_rows as (                                 -- LEFT JOIN: a pickup has no charter and must stay
         select o.*, ch.name as charter_name, ch.code as charter_code
           from ordered o
          cross join paging pg
           left join public.charters ch on ch.id = o.order_charter_id
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
                      from public.warehouses w where w.id = p_warehouse_id),
      'charter',   (select jsonb_build_object('id', ch.id, 'name', ch.name, 'code', ch.code, 'status', ch.status)
                      from public.charters ch where ch.id = p_charter_id),
      'noCharter', coalesce(p_no_charter, false)),
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
        'charterId', r.order_charter_id, 'charterName', r.charter_name, 'charterCode', r.charter_code,
        'copies', trim_scale(r.qty)::text, 'fulfilled', trim_scale(r.ful)::text,
        'returned', trim_scale(r.ret)::text, 'lines', r.n_lines, 'lineIds', to_jsonb(r.line_ids))
        order by r.rn) from page_rows r), '[]'::jsonb))
    into v_result;

  return v_result;
end $$;

-- ═══ 6. Filter options from the caller's eligible lines ══════════════════
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
  v_full     uuid[];
  v_assigned uuid[];
  v_pairs_ch uuid[];
  v_scoped   boolean;
  v_result   jsonb;
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
  -- E2b inputs, as in book_order_report_lines.
  v_full     := array(select w.id from public.warehouses w
                       where w.organization_id = p_organization_id
                         and w.id in (select public.rls_inv_read_full_warehouse_ids()));
  v_assigned := array(select w.id from public.warehouses w
                       where w.organization_id = p_organization_id
                         and w.id in (select public.rls_inv_read_assigned_warehouse_ids()));
  v_scoped   := exists (select 1 from unnest(v_assigned) a(wid) where not (a.wid = any (v_full)));
  v_pairs_ch := array(select r.charter_id from public.rls_inv_read_warehouse_charter_ids() r
                       where r.warehouse_id = any (v_assigned));

  -- Every selectable status and all time, so an option exists wherever the
  -- caller can see demand, whatever the warehouse's status or whether the
  -- category was deleted since.
  --
  -- Each option is PROBED, not read from every line of all time: per
  -- warehouse, per category and for "no category", EXISTS stops at the first
  -- eligible line. Each probe ends in OFFSET 0, the planner's fence: without
  -- it an EXISTS is turned into a join over every line (LIMIT is dropped
  -- from an EXISTS), which is what made the options cost grow with history.
  -- The eligibility is book_order_report_lines' (E1-E5 and E2b over every
  -- selectable status and all time, with the orders, lines, items and
  -- warehouses RLS), restated for the probes; pgTAP holds the lists equal to
  -- the ones the lines helper gives, for every persona.
  with books as materialized (                              -- the caller's readable books (E1, E4, E5)
         select i.id, i.category_id
           from public.inventory_items i                                             -- items RLS
          where i.organization_id = p_organization_id
            and i.item_type = 'book' and not i.is_bundle),
       ordered as not materialized (                        -- a book with an eligible line (E1-E3, E2b)
         select b.id, b.category_id
           from books b
          where exists (select 1
                          from public.order_request_lines l                         -- lines RLS
                          join public.order_requests o on o.id = l.order_request_id  -- orders RLS
                          join public.warehouses w on w.id = o.warehouse_id         -- warehouses RLS
                         where l.item_id = b.id
                           and o.organization_id = p_organization_id
                           and o.status = any (c_allowed)
                           and (not v_scoped                                        -- E2b-pre (leakproof)
                                or o.warehouse_id = any (v_full)
                                or o.delivery_charter_id is null
                                or o.delivery_charter_id = any (v_pairs_ch))
                           and (not v_scoped                                        -- E2b (exact)
                                or o.warehouse_id = any (v_full)
                                or (o.delivery_charter_id is null and o.warehouse_id = any (v_assigned))
                                or (o.warehouse_id, o.delivery_charter_id) in
                                     (select r.warehouse_id, r.charter_id
                                        from public.rls_inv_read_warehouse_charter_ids() r))
                        offset 0)),
       wh as (
         select w.id, w.name, w.status
           from public.warehouses w                                                  -- warehouses RLS
          where w.organization_id = p_organization_id
            and exists (select 1
                          from public.order_requests o                              -- orders RLS
                         where o.warehouse_id = w.id
                           and o.organization_id = p_organization_id                -- E1
                           and o.status = any (c_allowed)                             -- E3
                           and (not v_scoped                                        -- E2b-pre (leakproof)
                                or o.warehouse_id = any (v_full)
                                or o.delivery_charter_id is null
                                or o.delivery_charter_id = any (v_pairs_ch))
                           and (not v_scoped                                        -- E2b (exact)
                                or o.warehouse_id = any (v_full)
                                or (o.delivery_charter_id is null and o.warehouse_id = any (v_assigned))
                                or (o.warehouse_id, o.delivery_charter_id) in
                                     (select r.warehouse_id, r.charter_id
                                        from public.rls_inv_read_warehouse_charter_ids() r))
                           and exists (select 1
                                         from public.order_request_lines l          -- lines RLS
                                        where l.order_request_id = o.id
                                          and l.item_id in (select b.id from books b)
                                       offset 0)
                        offset 0)),
       cats as (
         select c.id, c.name, c.deleted_at
           from public.categories c                                                  -- categories RLS
          where c.organization_id = p_organization_id
            and exists (select 1 from ordered x where x.category_id = c.id offset 0))
  select jsonb_build_object(
    'v', 1,
    'warehouses', coalesce((select jsonb_agg(jsonb_build_object('id', wh.id, 'name', wh.name, 'status', wh.status)
                             order by (wh.status <> 'active'), lower(wh.name), wh.id) from wh), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name,
                                                                'deleted', c.deleted_at is not null)
                             order by (c.deleted_at is not null), lower(c.name), c.id) from cats c), '[]'::jsonb),
    'uncategorized', exists (select 1 from ordered x where x.category_id is null offset 0),
    'orderStatusConfig', (select o.order_status_config from public.organizations o
                           where o.id = p_organization_id),
    -- The charters the caller may report on (active first, then by name).
    'charters', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'code', c.code,
                                                              'status', c.status)
                           order by (c.status <> 'active'), lower(c.name), c.id)
                           from public.book_order_report_charters(p_organization_id) c), '[]'::jsonb),
    -- "No charter" only when an eligible, visible book line exists on an order
    -- with no charter. For such an order E2b-pre always holds and E2b reduces
    -- to the clause below.
    'noCharter', exists (select 1
                           from public.order_requests o                             -- orders RLS
                           join public.warehouses w on w.id = o.warehouse_id        -- warehouses RLS
                           join public.order_request_lines l on l.order_request_id = o.id  -- lines RLS
                           join public.inventory_items i on i.id = l.item_id        -- items RLS
                          where o.delivery_charter_id is null
                            and o.organization_id = p_organization_id
                            and i.organization_id = p_organization_id
                            and o.status = any (c_allowed)
                            and i.item_type = 'book' and not i.is_bundle
                            and (not v_scoped or o.warehouse_id = any (v_full)
                                 or o.warehouse_id = any (v_assigned))
                         offset 0))
    into v_result;

  return v_result;
end $$;

-- ═══ Comments ═════════════════════════════════════════════════════════════
comment on function public.book_order_report_range(uuid, text, date, date) is
  'Book Order Totals building block (0379, presets extended in 0382): resolves a date preset (all, '
  'today, week, month, 30d, 90d, year, custom) to org-local days and [starts_at, ends_before) instants '
  'in the organization''s time zone. This week starts on Sunday and ends today, like the other presets. '
  'The zone is organizations.timezone when it is an IANA name the server knows, else America/Los_Angeles '
  'with time_zone_fallback = true. SECURITY INVOKER, gated in its body (signed in, member with '
  'reports:read, orders and books modules). 22023 invalid_range for an unknown preset or a bad custom '
  'range. Not called by the apps directly, over REST it is a set, subject to max_rows.';

comment on function public.book_order_report_charters(uuid, uuid) is
  'Book Order Totals building block (0382): the charters of one organization the caller may report on, '
  'id, name, code and status only (it selects no address or contact column). A charter is listed when it '
  'is active and serviced by a warehouse where the caller reads every charter, or is one of the caller''s '
  'own charter assignments (A1/A2), or when an eligible, visible book line exists on an order placed for '
  'it, any status and all time (A3, with the charter-visibility rule E2b). With p_charter_id, that one '
  'charter or nothing: gate 6b in book_order_report_lines refuses anything else as 22023 '
  'invalid_charter. SECURITY INVOKER, gated in its body. Not called by the apps directly.';

comment on function public.book_order_report_lines(uuid, text, date, date, text[], uuid, uuid, boolean, text, text[], uuid, uuid, boolean) is
  'Book Order Totals: THE eligibility definition (0379, charter added in 0382). The caller''s RLS-visible '
  'order lines for book items (not bundles) of one organization, on orders in the chosen statuses '
  '(default: all but pending_confirmation, denied, cancelled) placed in the chosen range, optionally '
  'narrowed by order warehouse, the order''s charter (E8b: delivery_charter_id, or orders with no charter), '
  'item category, search or ISBN keys. E2b: a reader limited to some charters at a warehouse sees there '
  'only orders for those charters and orders with no charter. Gate 6b: a charter id must be one '
  'book_order_report_charters lists for the caller, else 22023 invalid_charter (the same for an unknown, '
  'foreign or out-of-scope id). Returns order_charter_id and counts_as_copies per line. SECURITY INVOKER: '
  'orders, lines, items and warehouses RLS all apply. Gated in its body. Returns no requester data, '
  'order_is_mine says only whether the caller placed the order. Not called by the apps directly, over '
  'REST it is a set, subject to max_rows.';

comment on function public.book_order_totals(uuid, text, date, date, text[], uuid, uuid, boolean, text, text[], text, integer, integer, boolean, integer, uuid, boolean) is
  'Book Order Totals (0379, charter added in 0382): ONE jsonb from ONE statement (so max_rows cannot cut '
  'it short and the summary, count and rows share one snapshot): summary (copies requested on eligible '
  'lines, distinct book entries, distinct orders), totalCount, the effective page and its grouped rows '
  '(25 by default, 1..100), sorted by copies (copy units first), title, orders or latest order, ties by '
  'item id. p_charter_id narrows to the orders placed for one charter, p_no_charter to orders with none; '
  'filters.charter and filters.noCharter echo them. byCharter (page mode with All charters only, else '
  'null) gives copies and orders per order charter from the same lines, No charter last. Export mode '
  '(p_all_rows) needs reports:export as well and returns every grouped row in sort order, or tooMany with '
  'no rows above least(p_max_rows, 20000). SECURITY INVOKER over book_order_report_lines, gated in its '
  'body. Writes nothing.';

comment on function public.book_order_totals_orders(uuid, uuid, text, date, date, text[], uuid, integer, integer, uuid, boolean) is
  'Book Order Totals drill-down (0379, charter added in 0382): ONE jsonb for one book: its totals over the '
  'same range, statuses, warehouse and charter, and a page of the contributing orders (newest first) with '
  'each order''s charter id, name and code (null for a pickup), duplicate lines of an order combined with '
  'their line ids kept. found:false alike for a hidden, non-book or missing item. mine is a boolean about '
  'the caller only, no requester data. SECURITY INVOKER, gated in its body. Writes nothing.';

comment on function public.book_order_totals_options(uuid) is
  'Book Order Totals filter options (0379, charters added in 0382): ONE jsonb listing the warehouses (any '
  'status) and categories (deleted ones included, plus whether uncategorized books appear) that occur in '
  'the caller''s eligible lines over every selectable status and all time, the organization''s '
  'order_status_config for labels, the charters the caller may report on (book_order_report_charters, '
  'active first) and noCharter (whether an eligible line exists on an order with no charter). Each '
  'option is probed (EXISTS stops at the first eligible line), not read from every line. SECURITY '
  'INVOKER, gated in its body. Writes nothing.';

-- ═══ Grants: authenticated only ══════════════════════════════════════════
revoke all on function public.book_order_report_range(uuid, text, date, date) from public, anon, service_role;
grant execute on function public.book_order_report_range(uuid, text, date, date) to authenticated;

revoke all on function public.book_order_report_charters(uuid, uuid) from public, anon, service_role;
grant execute on function public.book_order_report_charters(uuid, uuid) to authenticated;

revoke all on function public.book_order_report_lines(uuid, text, date, date, text[], uuid, uuid, boolean, text, text[], uuid, uuid, boolean) from public, anon, service_role;
grant execute on function public.book_order_report_lines(uuid, text, date, date, text[], uuid, uuid, boolean, text, text[], uuid, uuid, boolean) to authenticated;

revoke all on function public.book_order_totals(uuid, text, date, date, text[], uuid, uuid, boolean, text, text[], text, integer, integer, boolean, integer, uuid, boolean) from public, anon, service_role;
grant execute on function public.book_order_totals(uuid, text, date, date, text[], uuid, uuid, boolean, text, text[], text, integer, integer, boolean, integer, uuid, boolean) to authenticated;

revoke all on function public.book_order_totals_orders(uuid, uuid, text, date, date, text[], uuid, integer, integer, uuid, boolean) from public, anon, service_role;
grant execute on function public.book_order_totals_orders(uuid, uuid, text, date, date, text[], uuid, integer, integer, uuid, boolean) to authenticated;

revoke all on function public.book_order_totals_options(uuid) from public, anon, service_role;
grant execute on function public.book_order_totals_options(uuid) to authenticated;

notify pgrst, 'reload schema';
