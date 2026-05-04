-- 0017_reconciliation_views.sql
-- ─────────────────────────────────────────────────────────────────────
-- Three SQL views power the admin reconciliation dashboard:
--
--   vw_po_reconciliation     — per-PO summary (ordered/received/open totals)
--   vw_warehouse_inbound     — open POs + qty per warehouse
--   vw_vendor_performance    — fill rate per vendor
--
-- Plus tolerance_profiles + approvals tables for the over-receipt
-- approval workflow.
-- ─────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

-- ─────────────────────────────────────────────────────────────────────
-- tolerance_profiles
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.tolerance_profiles (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  vendor_id          uuid references public.suppliers(id) on delete cascade,  -- null = org default
  over_receipt_pct   numeric(6,4) not null default 0.05,  -- 5%
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organization_id, vendor_id)
);

create trigger tolerance_profiles_updated_at
  before update on public.tolerance_profiles
  for each row execute function public.tg_set_updated_at();

alter table public.tolerance_profiles enable row level security;

drop policy if exists tolerance_profiles_select on public.tolerance_profiles;
create policy tolerance_profiles_select on public.tolerance_profiles
  for select using (
    exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = tolerance_profiles.organization_id
        and m.accepted_at is not null
    )
  );

drop policy if exists tolerance_profiles_write on public.tolerance_profiles;
create policy tolerance_profiles_write on public.tolerance_profiles
  for all using (public.has_org_role(organization_id, 'manager'));

-- ─────────────────────────────────────────────────────────────────────
-- approvals
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.approvals (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  type               text not null check (type in ('over_receipt','manual_adjustment','receipt_reversal')),
  related_type       text not null,
  related_id         uuid,
  requested_by       uuid not null references public.user_profiles(id) on delete restrict,
  reason             text,
  payload            jsonb not null,
  status             text not null default 'requested'
                       check (status in ('requested','approved','denied','expired','superseded')),
  decided_by         uuid references public.user_profiles(id) on delete set null,
  decided_at         timestamptz,
  decision_notes     text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists approvals_org_status_idx
  on public.approvals(organization_id, status, created_at desc);
create index if not exists approvals_related_idx
  on public.approvals(related_type, related_id);

create trigger approvals_updated_at
  before update on public.approvals
  for each row execute function public.tg_set_updated_at();

alter table public.approvals enable row level security;

drop policy if exists approvals_select on public.approvals;
create policy approvals_select on public.approvals
  for select using (
    exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = approvals.organization_id
        and m.accepted_at is not null
    )
  );

drop policy if exists approvals_insert on public.approvals;
create policy approvals_insert on public.approvals
  for insert with check (
    exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = approvals.organization_id
        and m.accepted_at is not null
    )
  );

drop policy if exists approvals_admin_decide on public.approvals;
create policy approvals_admin_decide on public.approvals
  for update using (public.has_org_role(organization_id, 'admin'));

-- ─────────────────────────────────────────────────────────────────────
-- vw_po_reconciliation
-- ─────────────────────────────────────────────────────────────────────
create or replace view public.vw_po_reconciliation as
  select
    po.organization_id,
    po.id            as purchase_order_id,
    po.po_number,
    po.status,
    po.supplier_id,
    s.name           as supplier_name,
    po.destination_location_id,
    coalesce(sum(pol.quantity_ordered), 0)                            as qty_ordered_total,
    coalesce(sum(pol.quantity_received), 0)                           as qty_received_total,
    coalesce(sum(pol.quantity_ordered - pol.quantity_received), 0)    as qty_open_total,
    coalesce(sum(pol.quantity_ordered * pol.unit_cost), 0)            as cost_ordered_total,
    coalesce(sum(pol.quantity_received * pol.unit_cost), 0)           as cost_received_total,
    po.created_at,
    po.updated_at
  from public.purchase_orders po
  left join public.purchase_order_items pol on pol.purchase_order_id = po.id
  left join public.suppliers s on s.id = po.supplier_id
  group by po.id, po.po_number, po.status, po.supplier_id, s.name,
           po.destination_location_id, po.created_at, po.updated_at, po.organization_id;

grant select on public.vw_po_reconciliation to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- vw_warehouse_inbound
-- Joins through destination_location to get warehouse_id.
-- ─────────────────────────────────────────────────────────────────────
create or replace view public.vw_warehouse_inbound as
  select
    po.organization_id,
    loc.warehouse_id,
    count(distinct po.id) filter (
      where po.status in ('expected_inbound','ordered','partially_received')
    )                                                               as open_po_count,
    coalesce(sum(pol.quantity_ordered - pol.quantity_received) filter (
      where po.status in ('expected_inbound','ordered','partially_received')
    ), 0)                                                           as qty_open_total
  from public.purchase_orders po
  left join public.purchase_order_items pol on pol.purchase_order_id = po.id
  left join public.locations loc on loc.id = po.destination_location_id
  where loc.warehouse_id is not null
  group by po.organization_id, loc.warehouse_id;

grant select on public.vw_warehouse_inbound to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- vw_vendor_performance
-- ─────────────────────────────────────────────────────────────────────
create or replace view public.vw_vendor_performance as
  select
    po.organization_id,
    po.supplier_id,
    s.name as supplier_name,
    count(distinct po.id) as po_count,
    coalesce(sum(pol.quantity_ordered), 0)  as qty_ordered,
    coalesce(sum(pol.quantity_received), 0) as qty_received,
    case when coalesce(sum(pol.quantity_ordered), 0) > 0
      then round(sum(pol.quantity_received) * 100.0 / sum(pol.quantity_ordered), 2)
      else null
    end as fill_rate_pct
  from public.purchase_orders po
  left join public.purchase_order_items pol on pol.purchase_order_id = po.id
  left join public.suppliers s on s.id = po.supplier_id
  where po.supplier_id is not null
  group by po.organization_id, po.supplier_id, s.name;

grant select on public.vw_vendor_performance to authenticated;
