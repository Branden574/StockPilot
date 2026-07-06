-- 0226_cycle_count_scale.sql
--
-- Two SCALE bugs in cycle counts, fixed set-based (no multi-MB wire transfer):
--
--   1) START (scope=warehouse) shipped one INSERT row per SKU. At 20k–50k
--      SKUs the single .insert(linesPayload) is a multi-MB statement that
--      blows the 8s statement_timeout / payload limits — a big-warehouse
--      count could not even be STARTED. And the header was inserted in a
--      SEPARATE round trip from the lines, so a failed line insert orphaned
--      an in_progress cycle_counts row with zero lines.
--
--   2) The detail page + printable count sheet read cycle_count_lines with an
--      unbounded PostgREST select, silently clamped to [api] max_rows = 1000.
--      A >1000-SKU count showed the counter only the first 1000 lines; the
--      rest were invisible and UNCOUNTABLE. Fixing the read side needs
--      server-side pagination that can ORDER + FILTER by the joined item's
--      columns (sku / name / barcode) and by a column-vs-column variance
--      predicate — neither expressible through PostgREST — plus a whole-count
--      summary the paginated page can no longer derive client-side.
--
-- ── SECURITY POSTURE ───────────────────────────────────────────────────────
-- ALL THREE functions are SECURITY INVOKER and are called via the request's
-- USER-authed client (ServiceContext.supabase), never the service-role admin
-- client. This is load-bearing:
--
--   • start_cycle_count's INSERT … SELECT reads inventory_items under the
--     caller's JWT, so RLS (user_can_access_inventory 'read' +
--     user_can_see_item_category) binds the snapshot to EXACTLY the items the
--     caller may see — reproducing the old TS fetch (this.ctx.supabase, same
--     org + deleted_at IS NULL + status='active' + optional warehouse filter)
--     verbatim. A service-role snapshot would BYPASS item RLS and let a
--     restricted caller snapshot items they cannot see. The header + line
--     writes bind to the cycle_counts / cycle_count_lines INSERT policies
--     (manager+), so a non-manager caller is refused at the DB, and a
--     cross-org p_organization_id fails the header WITH CHECK — atomically,
--     leaving NO orphan header (the whole function is one transaction).
--
--   • cycle_count_lines_page / cycle_count_summary read cycle_count_lines
--     (RLS: org member) joined to inventory_items (RLS: read + category), so
--     a member only ever reads a count / lines they may already read; a
--     cross-org id returns zero rows. Passing another org's id can never
--     become an oracle.
--
-- EXECUTE is granted to `authenticated` (the caller role) and revoked from
-- anon/public — same matrix as the dashboard RPCs (migration 0224), and for
-- the same reason: SECURITY INVOKER + RLS makes an authenticated grant safe.
-- search_path is pinned to public on every function.

-- ────────────────────────────────────────────────────────────────────────────
-- start_cycle_count
--   Atomically inserts the cycle_counts header AND snapshots one line per
--   in-scope item via INSERT … SELECT (never leaves the DB). Replaces the
--   TS fetchAllRows + separate header insert + bulk line .insert() in
--   CycleCountsService.start().
--
--   ITEM-SELECTION PREDICATE (preserved verbatim from the old TS start()):
--     organization_id = p_organization_id
--       AND deleted_at IS NULL
--       AND status = 'active'
--       AND ( warehouse scope : p_filter_warehouse_id IS NULL
--                                 OR warehouse_id = p_filter_warehouse_id
--             selection scope : id = ANY(p_item_ids) )
--     (+ inventory_items RLS via SECURITY INVOKER — identical to the old
--      user-client fetch.)
--   Each line snapshots the item's CURRENT warehouse_id + quantity_on_hand,
--   exactly like the old payload builder. Empty scope RAISES (rolls the
--   header back) so the caller surfaces the same "no active items"
--   validation error with NO orphan header.
create or replace function public.start_cycle_count(
  p_organization_id     uuid,
  p_scope               text,
  p_header_warehouse_id uuid,
  p_filter_warehouse_id uuid,
  p_item_ids            uuid[],
  p_notes               text
)
returns table (cycle_count_id uuid, line_count integer)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id    uuid;
  v_count integer;
begin
  if p_scope not in ('warehouse', 'selection') then
    raise exception 'cycle_count_bad_scope' using errcode = '22023';
  end if;

  insert into public.cycle_counts (
    organization_id, warehouse_id, scope, status, notes, started_by
  ) values (
    p_organization_id, p_header_warehouse_id, p_scope, 'in_progress', p_notes, auth.uid()
  )
  returning id into v_id;

  insert into public.cycle_count_lines (
    cycle_count_id, item_id, warehouse_id, expected_quantity
  )
  select
    v_id,
    ii.id,
    ii.warehouse_id,
    coalesce(ii.quantity_on_hand, 0)
  from public.inventory_items ii
  where ii.organization_id = p_organization_id
    and ii.deleted_at is null
    and ii.status = 'active'
    and (
      (p_scope = 'warehouse'
        and (p_filter_warehouse_id is null or ii.warehouse_id = p_filter_warehouse_id))
      or
      (p_scope = 'selection' and ii.id = any(p_item_ids))
    );

  get diagnostics v_count = row_count;

  -- No in-scope items: abort so the header insert rolls back (no orphan).
  -- The service maps this stable string to the same validation error the
  -- old TS empty-check produced.
  if v_count = 0 then
    raise exception 'cycle_count_no_items' using errcode = 'P0001';
  end if;

  cycle_count_id := v_id;
  line_count := v_count;
  return next;
end;
$$;

revoke all on function public.start_cycle_count(uuid, text, uuid, uuid, uuid[], text) from public;
revoke all on function public.start_cycle_count(uuid, text, uuid, uuid, uuid[], text) from anon;
grant execute on function public.start_cycle_count(uuid, text, uuid, uuid, uuid[], text) to authenticated;

comment on function public.start_cycle_count(uuid, text, uuid, uuid, uuid[], text) is
  'Atomic cycle-count snapshot: inserts the cycle_counts header + one '
  'cycle_count_lines row per in-scope active item via INSERT … SELECT (no '
  'per-row wire transfer, scales to 50k SKUs). SECURITY INVOKER so item RLS '
  'binds the snapshot to the caller''s visible items and the manager-level '
  'header/line INSERT policies apply; empty scope raises (rolls back → no '
  'orphan header). authenticated may execute; anon/public revoked.';

-- ────────────────────────────────────────────────────────────────────────────
-- cycle_count_lines_page
--   One server-paginated, search/filter-able, joined page of a count's lines,
--   ordered like the on-screen list (sku for open counts, counted_at desc for
--   closed). full_count is the filtered total (window count) for the page
--   controls. Replaces the unbounded PostgREST select in the detail page.
--
--   INNER join to inventory_items mirrors the client list, which hides lines
--   whose item is not visible ( `if (!item) return false` ). RLS on
--   inventory_items applies (INVOKER), so category-restricted items drop out
--   exactly as the old embedded select returned a null item.
--
--   p_search is matched LITERALLY (the old client filter was a lowercase
--   .includes over name/sku/barcode): \, % and _ are escaped before the
--   ILIKE pattern is built — same expression as purchase_orders_page (0227) —
--   so searching 'SKU_1' matches only the underscore SKU, not 'SKU-1'.
create or replace function public.cycle_count_lines_page(
  p_cycle_count_id uuid,
  p_search         text default null,
  p_filter         text default 'all',
  p_order          text default 'sku',
  p_limit          integer default 50,
  p_offset         integer default 0
)
returns table (
  id               uuid,
  cycle_count_id   uuid,
  item_id          uuid,
  warehouse_id     uuid,
  expected_quantity numeric,
  counted_quantity numeric,
  reason           text,
  notes            text,
  counted_by       uuid,
  counted_at       timestamptz,
  item_name        text,
  item_sku         text,
  item_uom         text,
  item_barcode     text,
  full_count       bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with params as (
    -- Literal containment, not pattern matching: escape \ % _ before
    -- building the ILIKE pattern (identical to purchase_orders_page, 0227)
    -- so the term is matched verbatim like the old JS .includes().
    select case
      when p_search is null or btrim(p_search) = '' then null
      else '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
    end as pat
  ),
  matched as (
    select
      l.id, l.cycle_count_id, l.item_id, l.warehouse_id,
      l.expected_quantity, l.counted_quantity, l.reason, l.notes,
      l.counted_by, l.counted_at,
      ii.name, ii.sku, ii.unit_of_measure, ii.barcode
    from public.cycle_count_lines l
    join public.inventory_items ii on ii.id = l.item_id
    cross join params
    where l.cycle_count_id = p_cycle_count_id
      and (
        params.pat is null
        or ii.name ilike params.pat
        or ii.sku ilike params.pat
        or coalesce(ii.barcode, '') ilike params.pat
      )
      and (
        p_filter = 'all'
        or (p_filter = 'uncounted' and l.counted_quantity is null)
        or (p_filter = 'variance'
            and l.counted_quantity is not null
            and l.counted_quantity <> l.expected_quantity)
      )
  )
  select
    m.id, m.cycle_count_id, m.item_id, m.warehouse_id,
    m.expected_quantity, m.counted_quantity, m.reason, m.notes,
    m.counted_by, m.counted_at,
    m.name, m.sku, m.unit_of_measure, m.barcode,
    count(*) over () as full_count
  from matched m
  order by
    case when p_order = 'recent' then m.counted_at end desc nulls last,
    case when p_order = 'sku'    then m.sku end asc nulls last,
    m.id asc
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0)
$$;

revoke all on function public.cycle_count_lines_page(uuid, text, text, text, integer, integer) from public;
revoke all on function public.cycle_count_lines_page(uuid, text, text, text, integer, integer) from anon;
grant execute on function public.cycle_count_lines_page(uuid, text, text, text, integer, integer) to authenticated;

comment on function public.cycle_count_lines_page(uuid, text, text, text, integer, integer) is
  'One server-paginated + searched + filtered page of a cycle count''s lines, '
  'joined to inventory_items and ordered like the on-screen list; full_count '
  'is the filtered total for the page controls. p_search matches LITERALLY '
  '(\, %, _ escaped before the ILIKE pattern — 0227 parity). SECURITY INVOKER '
  '— org-member RLS on cycle_count_lines + read/category RLS on '
  'inventory_items apply. authenticated may execute; anon/public revoked.';

-- ────────────────────────────────────────────────────────────────────────────
-- cycle_count_summary
--   Whole-count roll-up the paginated detail page can no longer derive from a
--   single page: total lines, counted, and the variance count + net delta
--   (counted_quantity - expected_quantity over the counted, differing lines) —
--   exactly the numbers the client used to reduce off the full lines array.
--   Reads cycle_count_lines directly (no item join) so it counts every line,
--   matching the old client `lines.length` / counted / variances math.
create or replace function public.cycle_count_summary(
  p_cycle_count_id uuid
)
returns table (
  total          bigint,
  counted        bigint,
  variance_count bigint,
  net_delta      numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*)::bigint as total,
    count(*) filter (where l.counted_quantity is not null)::bigint as counted,
    count(*) filter (
      where l.counted_quantity is not null
        and l.counted_quantity <> l.expected_quantity
    )::bigint as variance_count,
    coalesce(
      sum(l.counted_quantity - l.expected_quantity)
        filter (where l.counted_quantity is not null),
      0
    )::numeric as net_delta
  from public.cycle_count_lines l
  where l.cycle_count_id = p_cycle_count_id
$$;

revoke all on function public.cycle_count_summary(uuid) from public;
revoke all on function public.cycle_count_summary(uuid) from anon;
grant execute on function public.cycle_count_summary(uuid) to authenticated;

comment on function public.cycle_count_summary(uuid) is
  'Whole-count roll-up for the server-paginated detail page: total / counted / '
  'variance_count / net_delta (Σ counted−expected over counted lines). '
  'SECURITY INVOKER — org-member RLS on cycle_count_lines applies. '
  'authenticated may execute; anon/public revoked.';
