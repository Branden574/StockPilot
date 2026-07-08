-- 0232_po_stats_exclude_cancelled_from_total_value.sql
--
-- Bug: the PO index "Total value" stat counted CANCELLED purchase orders.
-- purchase_orders_stats.total_value (migration 0227) summed po.total over EVERY
-- status, while its sibling committed_value already filtered to open statuses.
-- A cancelled PO represents money that was never (and won't be) spent, so it
-- must not inflate the total-value figure. (Prod at write time: 17 cancelled
-- POs summing ~$265,641.98 were being counted.)
--
-- Fix: total_value now excludes status='cancelled'. Body is otherwise VERBATIM
-- from 0227 — signature, security mode, search_path, and every other aggregate
-- (total_count, open_count, committed_value, inbound, next_eta, avg_lead_days)
-- are unchanged. total_count still counts ALL PO records (cancelled POs are real
-- rows that still appear in the list's "all"/cancelled views) — only the VALUE
-- excludes them, per the reported issue.

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
    -- *** 0232: exclude cancelled POs from total value (was: sum over all). ***
    coalesce(
      sum(coalesce(s.total, 0)) filter (where s.status <> 'cancelled'),
      0
    )::numeric as total_value,
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

comment on function public.purchase_orders_stats(uuid, uuid[]) is
  'PO index header + stat cards, one row. total_value EXCLUDES cancelled POs '
  '(0232); committed_value is open-status only; total_count counts all PO rows.';
