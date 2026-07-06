-- 0227_inventory_value_and_po_list_rpcs.sql
--
-- Scale-audit batch 3 (ranks 6 + 8): push two more row-dump JS aggregations
-- into Postgres, same playbook as migrations 0223/0224/0225.
--
--   1. inventory_value_on_hand — the Items/Books "$N on hand" footer figure.
--      Before: loadInventoryValueOnHandUncached (apps/web/src/server/loaders/
--      inventory-list.ts) paged EVERY matching inventory_items row (3 columns)
--      through sequential 1000-row PostgREST pages and reduced
--      qty × unit_cost in JS — at 50k SKUs that is 50+ serial round trips per
--      cache fill. Existing aggregate sources were checked and REJECTED
--      because their predicates do not match the loader's:
--        • vw_inventory_valuation_by_warehouse / _by_category (mig 0179)
--          filter deleted_at IS NULL + status='active' + is_rental=false but
--          have NO item_type split — the loader sums ONE item_type per view
--          ('product' for Items, 'book' for Books);
--        • get_dashboard_summary (mig 0006) filters only status='active' +
--          deleted_at IS NULL — no item_type, no is_rental.
--      This function reproduces the loader's predicate EXACTLY:
--        organization_id = p_organization_id
--        AND deleted_at IS NULL AND status = 'active'
--        AND item_type = p_item_type AND is_rental = false
--        AND (p_warehouse_id IS NULL OR warehouse_id = p_warehouse_id)
--      and its math exactly: Σ (qty||0) × (unit_cost||0) → Σ coalesce(qty,0)
--      × coalesce(unit_cost,0) (numeric columns can't be NaN, so JS's
--      `Number(x) || 0` coercion reduces to the NULL→0 coalesce).
--
--   2. purchase_orders_stats + purchase_orders_page — the /dashboard/
--      purchase-orders index. Before: PurchaseOrdersService.list() paged the
--      org's ENTIRE purchase_orders rowset into Node (fetchAllRows) on every
--      page view; the page then computed the header/stat-card aggregates in
--      JS and rendered EVERY row with in-memory tab/search filtering — no
--      pagination at all. At tens of thousands of POs that is dozens of
--      serial round trips plus an unbounded HTML table per view.
--      purchase_orders_stats returns the six stat-card aggregates in one
--      row; purchase_orders_page returns one 30-row page with the filtered
--      total, with the tab/search/sort semantics of the page reproduced
--      exactly (see each function's comment).
--
-- ── SECURITY POSTURE ─────────────────────────────────────────────────────────
--   • inventory_value_on_hand mirrors 0223 (service-role only): it backs the
--     org-shared cached loader behind canUseSharedInventoryCaches (manager+
--     with items:read only) and is called via the admin client with the org
--     id taken from the loader's own cache key — never user input. EXECUTE
--     revoked from public/anon/authenticated so a user client can never turn
--     it into a cross-org aggregate oracle; SECURITY INVOKER so even a leaked
--     grant would still be bound by inventory_items RLS.
--   • purchase_orders_stats / purchase_orders_page mirror 0224 (SECURITY
--     INVOKER, granted to authenticated): they are called via the request's
--     USER client (ServiceContext.supabase), so purchase_orders RLS
--     (is_org_member — mig 0140) binds inside the function. A cross-org
--     p_organization_id yields zero rows. p_warehouse_ids reproduces the
--     APP-LEVEL destination-warehouse scoping list() applied via its
--     `destination:locations!inner` embed; it is a narrowing convenience, not
--     a security floor — purchase_orders' RLS floor is org membership, so a
--     caller inventing warehouse ids can never see more than a direct
--     PostgREST read of purchase_orders already returns. The joined
--     locations / suppliers / purchase_order_items reads are equally
--     RLS-bound (org member), same as the PostgREST embeds they replace.
--   • All three: language sql, STABLE, search_path pinned to public,
--     revokes explicit.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. inventory_value_on_hand — the default-view "$N on hand" sum.
--    JS parity: sumRows.reduce((acc, r) =>
--      acc + (Number(r.quantity_on_hand) || 0) * (Number(r.unit_cost) || 0), 0)
--    over the skinny default-view mirror (see header for the predicate).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.inventory_value_on_hand(
  p_organization_id uuid,
  p_item_type text,
  p_warehouse_id uuid default null
)
returns numeric
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    sum(coalesce(i.quantity_on_hand, 0) * coalesce(i.unit_cost, 0)),
    0
  )::numeric
  from public.inventory_items i
  where i.organization_id = p_organization_id
    and i.deleted_at is null
    and i.status = 'active'
    and i.item_type = p_item_type
    and i.is_rental = false
    and (p_warehouse_id is null or i.warehouse_id = p_warehouse_id)
$$;

revoke all on function public.inventory_value_on_hand(uuid, text, uuid) from public;
revoke all on function public.inventory_value_on_hand(uuid, text, uuid) from anon;
revoke all on function public.inventory_value_on_hand(uuid, text, uuid) from authenticated;
grant execute on function public.inventory_value_on_hand(uuid, text, uuid) to service_role;

comment on function public.inventory_value_on_hand(uuid, text, uuid) is
  'Default-view inventory $ value: sum(qty × unit_cost) over active, non-deleted, '
  'non-rental items of one item_type (optional warehouse narrowing). Reproduces the '
  'inventory-list.ts loadInventoryValueOnHand predicate exactly. Service-role only — '
  'called by the org-shared cached loader; EXECUTE revoked from anon/authenticated '
  'so it cannot become a cross-org aggregate oracle.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. purchase_orders_stats — the PO index header + stat cards, one row.
--    Faithful reproduction of the page's JS over the FULL (warehouse-scoped,
--    tab/search-independent) list (purchase-orders/page.tsx):
--      total_count / total_value      = pos.length, Σ Number(total ?? 0)
--      open  = status ∈ {draft, expected_inbound, ordered, partially_received}
--        → open_count, committed_value (Σ total over open),
--          open_supplier_count (DISTINCT non-null supplier_id over open)
--      inbound = status ∈ {ordered, expected_inbound, partially_received}
--        → inbound_count; next ETA = the inbound PO with the earliest
--          non-null expected_at (ties broken by the JS fetch order
--          created_at DESC, id ASC — Array.prototype.sort is stable)
--      avg_lead_days = AVG over POs with status='received', received_at not
--        null and within the trailing 90 days, of
--        (received_at − coalesce(ordered_at, created_at)) in fractional days,
--        negative durations excluded (JS: Number.isFinite(d) && d >= 0).
--        Returned UNROUNDED — the page keeps its own Math.round.
--    Warehouse scope parity with list(): p_warehouse_ids NULL → every org PO
--    (left-join embed); non-NULL → only POs whose destination location's
--    warehouse_id is in the list (the !inner embed dropped both
--    NULL-destination POs and NULL-warehouse locations — EXISTS does too).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.purchase_orders_stats(
  p_organization_id uuid,
  p_warehouse_ids uuid[] default null
)
returns table (
  total_count bigint,
  total_value numeric,
  open_count bigint,
  committed_value numeric,
  open_supplier_count bigint,
  inbound_count bigint,
  next_eta_po_number text,
  next_eta_expected_at timestamptz,
  avg_lead_days numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with scoped as (
    select po.id, po.po_number, po.status, po.supplier_id, po.expected_at,
           po.ordered_at, po.received_at, po.total, po.created_at
    from public.purchase_orders po
    where po.organization_id = p_organization_id
      and (
        p_warehouse_ids is null
        or exists (
          select 1
          from public.locations l
          where l.id = po.destination_location_id
            and l.warehouse_id = any(p_warehouse_ids)
        )
      )
  ),
  next_eta as (
    select s.po_number, s.expected_at
    from scoped s
    where s.status in ('ordered', 'expected_inbound', 'partially_received')
      and s.expected_at is not null
    order by s.expected_at asc, s.created_at desc, s.id asc
    limit 1
  ),
  lead as (
    select avg(
             extract(epoch from (s.received_at - coalesce(s.ordered_at, s.created_at))) / 86400.0
           )::numeric as avg_days
    from scoped s
    where s.status = 'received'
      and s.received_at is not null
      and s.received_at >= now() - interval '90 days'
      and extract(epoch from (s.received_at - coalesce(s.ordered_at, s.created_at))) >= 0
  )
  select
    count(*)::bigint as total_count,
    coalesce(sum(coalesce(s.total, 0)), 0)::numeric as total_value,
    count(*) filter (
      where s.status in ('draft', 'expected_inbound', 'ordered', 'partially_received')
    )::bigint as open_count,
    coalesce(
      sum(coalesce(s.total, 0)) filter (
        where s.status in ('draft', 'expected_inbound', 'ordered', 'partially_received')
      ),
      0
    )::numeric as committed_value,
    count(distinct s.supplier_id) filter (
      where s.status in ('draft', 'expected_inbound', 'ordered', 'partially_received')
    )::bigint as open_supplier_count,
    count(*) filter (
      where s.status in ('ordered', 'expected_inbound', 'partially_received')
    )::bigint as inbound_count,
    (select ne.po_number from next_eta ne) as next_eta_po_number,
    (select ne.expected_at from next_eta ne) as next_eta_expected_at,
    (select l.avg_days from lead l) as avg_lead_days
  from scoped s
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. purchase_orders_page — one server-side page of the PO index table.
--    Filter parity with the page's in-memory pass:
--      • p_statuses NULL → the 'all' tab; else status = any(p_statuses)
--        (the page's mutually-exclusive tab partition).
--      • p_q: the JS matched q (lowercased, trimmed) as a SUBSTRING of
--        po_number OR of the rendered supplier label — the supplier's name
--        from the non-deleted suppliers list, or the literal '—' placeholder
--        when the PO has no (or a deleted) supplier. ILIKE with escaped
--        %/_/\ reproduces case-insensitive literal containment; the
--        left join carries `deleted_at is null` so a deleted supplier
--        degrades to '—' exactly like the JS map miss.
--      • warehouse scope: same EXISTS as purchase_orders_stats.
--      • sort: created_at DESC, id ASC — identical to list().
--    line_count reproduces the `purchase_order_items(count)` embed (RLS-bound
--    correlated count). filtered_count = the full filtered-set size (window
--    count) so the page can render "Showing X–Y of N" without a second query;
--    it repeats on every row of the page.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.purchase_orders_page(
  p_organization_id uuid,
  p_warehouse_ids uuid[] default null,
  p_statuses text[] default null,
  p_q text default null,
  p_limit int default 30,
  p_offset int default 0
)
returns table (
  id uuid,
  po_number text,
  status text,
  supplier_id uuid,
  destination_location_id uuid,
  expected_at timestamptz,
  ordered_at timestamptz,
  received_at timestamptz,
  total numeric,
  created_at timestamptz,
  updated_at timestamptz,
  line_count bigint,
  filtered_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with params as (
    select case
      when p_q is null or btrim(p_q) = '' then null
      else '%' || replace(replace(replace(btrim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
    end as pat
  )
  select
    po.id,
    po.po_number,
    po.status,
    po.supplier_id,
    po.destination_location_id,
    po.expected_at,
    po.ordered_at,
    po.received_at,
    po.total,
    po.created_at,
    po.updated_at,
    (
      select count(*)
      from public.purchase_order_items poi
      where poi.purchase_order_id = po.id
    )::bigint as line_count,
    (count(*) over ())::bigint as filtered_count
  from public.purchase_orders po
  left join public.suppliers s
    on s.id = po.supplier_id and s.deleted_at is null
  cross join params
  where po.organization_id = p_organization_id
    and (
      p_warehouse_ids is null
      or exists (
        select 1
        from public.locations l
        where l.id = po.destination_location_id
          and l.warehouse_id = any(p_warehouse_ids)
      )
    )
    and (p_statuses is null or po.status = any(p_statuses))
    and (
      params.pat is null
      or po.po_number ilike params.pat
      or coalesce(s.name, '—') ilike params.pat
    )
  order by po.created_at desc, po.id asc
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0)
$$;

-- Privilege lock-down for the two PO functions — 0224 parity: SECURITY
-- INVOKER + authenticated may execute (RLS on purchase_orders/locations/
-- suppliers/purchase_order_items binds inside; a non-member aggregates
-- zero rows). anon/public revoked.
revoke all on function public.purchase_orders_stats(uuid, uuid[]) from public;
revoke all on function public.purchase_orders_stats(uuid, uuid[]) from anon;
grant execute on function public.purchase_orders_stats(uuid, uuid[]) to authenticated;

revoke all on function public.purchase_orders_page(uuid, uuid[], text[], text, int, int) from public;
revoke all on function public.purchase_orders_page(uuid, uuid[], text[], text, int, int) from anon;
grant execute on function public.purchase_orders_page(uuid, uuid[], text[], text, int, int) to authenticated;

comment on function public.purchase_orders_stats(uuid, uuid[]) is
  'PO index header + stat-card aggregates (total/open/committed/inbound/next-ETA/'
  'avg-lead) over the warehouse-scoped full list; set-based reproduction of the '
  'purchase-orders page''s JS roll-up. SECURITY INVOKER — purchase_orders RLS '
  '(is_org_member) binds; called via the USER client. authenticated may execute; '
  'anon/public revoked. p_warehouse_ids mirrors the app-level destination-warehouse '
  'scoping (narrowing only — the RLS floor is org membership).';
comment on function public.purchase_orders_page(uuid, uuid[], text[], text, int, int) is
  'One server-side page of the PO index (tab statuses + q over po_number/supplier '
  'label + warehouse scope, created_at DESC id ASC, limit/offset) with line_count '
  'and the filtered-set total. SECURITY INVOKER — RLS binds; called via the USER '
  'client. authenticated may execute; anon/public revoked.';
