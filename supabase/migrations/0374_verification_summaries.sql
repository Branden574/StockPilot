-- 0374_verification_summaries.sql
--
-- F1-3: verification summaries. "Last physical count" for an item, and for
-- every item held at a location, on the web and the phone. Read-only: no table,
-- no column, no data change, no stock written.
--
-- ── WHAT IT ADDS ───────────────────────────────────────────────────────────
--   1. item_verification_summaries(org, item_ids): one row per requested item
--      the caller can read in that org, with
--        * the item's own facts the words depend on (status, rental, kit,
--          deleted, countable, quantity on hand now);
--        * its latest physical count, from _latest_count_lines (0372), the one
--          source of "last physical count" the count_variance rule also reads:
--          the count, who counted and who posted, when it was observed, the
--          book and the counted quantity, the counted location (and its kind
--          and archived state, for the label) and whether AI helped;
--        * movements_since: stock ledger rows (via_ledger, 0369) for the item
--          written after the moment the count is true for
--          (coalesce(baseline_at, counted_at)), EXCLUDING the count's own
--          correction (reference_type 'cycle_count', reference_id = that
--          count): ledger.post_cycle_count stamps its movement with
--          clock_timestamp() at post time, after the line's baseline, so
--          without the exclusion every corrected count would read "1 movement
--          since" the moment it was posted;
--        * outside_ledger_since: rows in the same window that did NOT come
--          through a ledger transaction (via_ledger false: a direct API
--          insert by a signed-in user). They moved no stock the ledger knows
--          of, so they are not movements; the words say how many there are;
--        * open_count: the newest in-progress count that holds the item
--          (cycle_count_lines_item_idx, 0372).
--      An item that was never counted still gets a row, with every count
--      field null, so "never counted" is a stated answer, never the absence
--      of one. An item the caller cannot read, or one outside the org, gets
--      no row at all.
--   2. location_holdings_visible(location): whether the caller's holdings
--      scope (item_stock_levels_select, 0331/0371) covers that location. A
--      location page reads the holdings there under the caller's RLS; a staff
--      member or viewer whose warehouses do not include the location's
--      warehouse reads NONE, which must be shown as "not in your warehouses",
--      never as "nothing here". The predicate is item_stock_levels_select's
--      location clause restated for one location; pgTAP 0374 holds the two
--      equal for every persona and location of its fixture.
--
-- ── WHO MAY CALL, AND WHY SECURITY DEFINER ─────────────────────────────────
-- item_verification_summaries must read two things past the caller's RLS:
--   * _latest_count_lines, which is service_role only (it reads every count of
--     an org, 0372);
--   * stock_movements, whose SELECT policy (0321) hides an item's movements
--     from a member without activity_logs:read when the item's warehouse is
--     not in my_warehouse_ids(). A member can read an item whose movements
--     that policy hides (pgTAP 0374 builds one), and an INVOKER count would
--     then be silently low: "0 movements since" for an item that moved.
-- So it is SECURITY DEFINER with its gates in its own body (the 0346 class,
-- INV-25): signed in, an accepted member of p_org (is_org_member), and per item
-- caller_can_read_item (the inventory_items_select predicate) and the item in
-- p_org. It returns counts and the count's own facts, never a movement row.
-- EXECUTE to authenticated only (a service-role call has no auth.uid() and
-- would get no rows anyway).
--
-- At most 500 ids per call (22023 too_many_items): the answer is one row per
-- item, and PostgREST caps every response at 1000 rows (max_rows), so a
-- larger call could be cut short without an error. The app batches 500.
--
-- location_holdings_visible is SECURITY INVOKER: it reads the location under
-- the caller's own RLS (locations_select: any member of its org) and calls
-- the same helpers item_stock_levels_select calls. It discloses nothing the
-- caller could not already find out by reading the holdings.
--
-- ── FROZEN ─────────────────────────────────────────────────────────────────
-- start_cycle_count, ledger.post_cycle_count, the rebase trigger,
-- apply_level_delta, apply_cycle_count_location_delta, _latest_count_lines and
-- every policy are untouched. Both functions are new; nothing calls them but
-- the new app code.
--
-- ── REFUSALS (never 40001/40P01: 0367) ─────────────────────────────────────
--   item_verification_summaries: 22023 too_many_items (more than 500 ids).
--   Not signed in, not a member, a null org or a null array: no rows.
--   location_holdings_visible: none (false for an unknown or foreign location).
--
-- ── PROD PUSH NOTE ─────────────────────────────────────────────────────────
-- Two CREATE FUNCTION statements and their grants and comments: catalog-only,
-- no table lock. lock_timeout makes the push fail fast instead of queueing
-- (retry is the remedy).

-- PLAIN `set`, not `set local` (0303/0358/0370). Reset at the end.
set lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. item_verification_summaries
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.item_verification_summaries(
  p_org      uuid,
  p_item_ids uuid[]
)
returns table (
  item_id                   uuid,
  item_status               text,
  item_is_rental            boolean,
  item_is_bundle            boolean,
  item_deleted              boolean,
  item_countable            boolean,
  quantity_on_hand          numeric,
  cycle_count_id            uuid,
  count_number              bigint,
  scope                     text,
  completed_at              timestamptz,
  completed_by              uuid,
  counted_by                uuid,
  counted_at                timestamptz,
  captured_at               timestamptz,
  baseline_at               timestamptz,
  expected_quantity         numeric,
  expected_at_start         numeric,
  counted_quantity          numeric,
  counted_location_id       uuid,
  counted_location_name     text,
  counted_location_kind     text,
  counted_location_archived boolean,
  ai_assisted               boolean,
  movements_since           integer,
  outside_ledger_since      integer,
  open_count_id             uuid,
  open_count_number         bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- Gate 1: a signed-in caller, arguments present.
  if auth.uid() is null or p_org is null or p_item_ids is null then
    return;
  end if;
  if cardinality(p_item_ids) > 500 then
    raise exception 'too_many_items' using errcode = '22023', hint = 'too_many_items';
  end if;
  -- Gate 2: an accepted, enabled member of the org asked about.
  if not public.is_org_member(p_org) then
    return;
  end if;

  return query
  with readable as (
    -- Gate 3, per item: in p_org and readable by the caller (warehouse,
    -- charter and category scope: the inventory_items_select predicate).
    select i.id,
           i.status,
           i.is_rental,
           i.is_bundle,
           i.deleted_at,
           i.quantity_on_hand
      from public.inventory_items i
     where i.id = any (p_item_ids)
       and i.organization_id = p_org
       and public.caller_can_read_item(i.id)
  ),
  latest as materialized (
    select l.*
      from public._latest_count_lines(p_org, array(select r.id from readable r)) l
  )
  select r.id,
         r.status,
         r.is_rental,
         r.is_bundle,
         r.deleted_at is not null,
         -- start_cycle_count's own predicate (0369, D8).
         (r.deleted_at is null and r.status = 'active' and not r.is_rental and not r.is_bundle),
         r.quantity_on_hand,
         lc.cycle_count_id,
         lc.count_number,
         lc.scope,
         lc.completed_at,
         lc.completed_by,
         lc.counted_by,
         lc.counted_at,
         lc.captured_at,
         lc.baseline_at,
         lc.expected_quantity,
         lc.expected_at_start,
         lc.counted_quantity,
         lc.counted_location_id,
         lc.counted_location_name,
         loc.kind,
         case when lc.counted_location_id is null or loc.id is null then null
              else loc.deleted_at is not null end,
         lc.ai_assisted,
         mv.movements,
         mv.outside,
         oc.id,
         oc.count_number
    from readable r
    left join latest lc
      on lc.item_id = r.id
    left join public.locations loc
      on loc.id = lc.counted_location_id
     and loc.organization_id = p_org
    -- Movements after the moment the count is true for. Null (not 0) when the
    -- item was never counted, or its line has no moment at all: "unknown" is
    -- never shown as "none".
    left join lateral (
      select count(*) filter (
               where m.via_ledger
                 -- the count's own correction is not a movement "since" it;
                 -- IS DISTINCT FROM so a row with no reference is counted
                 and (m.reference_type is distinct from 'cycle_count'
                      or m.reference_id is distinct from lc.cycle_count_id))::integer as movements,
             count(*) filter (where not m.via_ledger)::integer as outside
        from public.stock_movements m
       where m.item_id = r.id
         and m.organization_id = p_org
         and m.created_at > coalesce(lc.baseline_at, lc.counted_at)
    ) mv
      on lc.cycle_count_id is not null
     and coalesce(lc.baseline_at, lc.counted_at) is not null
    -- The newest in-progress count holding the item.
    left join lateral (
      select c.id, c.count_number
        from public.cycle_count_lines l
        join public.cycle_counts c
          on c.id = l.cycle_count_id
       where l.item_id = r.id
         and c.organization_id = p_org
         and c.status = 'in_progress'
       order by c.started_at desc, c.id desc
       limit 1
    ) oc on true
   order by r.id;
end;
$$;

revoke all on function public.item_verification_summaries(uuid, uuid[]) from public, anon;
grant execute on function public.item_verification_summaries(uuid, uuid[]) to authenticated;

comment on function public.item_verification_summaries(uuid, uuid[]) is
  'F1-3 (0374): per requested item the caller can read in p_org (is_org_member, '
  'caller_can_read_item, same org), the item''s countability facts and on-hand, '
  'its latest physical count (_latest_count_lines: count, people, moments, book '
  'and counted quantity, counted location with kind and archived state, AI '
  'assisted), movements_since (via_ledger rows after coalesce(baseline_at, '
  'counted_at), excluding the count''s own cycle_count movement), '
  'outside_ledger_since (via_ledger = false rows in the same window) and the '
  'newest in-progress count holding the item. Never-counted items get a row '
  'with null count fields; unreadable or foreign items get none. At most 500 '
  'ids (22023 too_many_items). SECURITY DEFINER, gated in its body; counts '
  'only, never movement rows. EXECUTE to authenticated.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. location_holdings_visible
-- ═══════════════════════════════════════════════════════════════════════════
-- item_stock_levels_select (0331; 0371 extended it to staff) for one
-- location: a member of the location's org who is a manager or above, or the
-- location has no warehouse, or its warehouse is one of my_warehouse_ids().
-- True means every holding at the location is readable to the caller (the
-- policy is location-based only), so a location page's holdings are complete.
-- False means none are, and the page says so instead of showing it empty.
-- An unknown location, one in another org, or no caller: false.
create or replace function public.location_holdings_visible(p_location_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce((
    select public.is_org_member(l.organization_id)
       and (public.has_org_role(l.organization_id, 'manager')
            or l.warehouse_id is null
            or l.warehouse_id in (select mw.warehouse_id from public.my_warehouse_ids() mw))
      from public.locations l
     where l.id = p_location_id), false);
$$;

revoke all on function public.location_holdings_visible(uuid) from public, anon;
grant execute on function public.location_holdings_visible(uuid) to authenticated;

comment on function public.location_holdings_visible(uuid) is
  'F1-3 (0374): whether the caller''s holdings scope (item_stock_levels_select) '
  'covers this location: member of its org and manager+, or the location has no '
  'warehouse, or its warehouse is in my_warehouse_ids(). False for an unknown '
  'or foreign location. SECURITY INVOKER; pgTAP 0374 holds it equal to the '
  'policy for every persona and location of its fixture.';

reset lock_timeout;
