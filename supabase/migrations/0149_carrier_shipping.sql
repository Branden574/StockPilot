-- ============================================================================
-- 0149_carrier_shipping.sql — Carrier shipping (EasyPost).
--
-- Manual EasyPost shipping labels + read-only tracking for delivery orders to
-- charter campuses. One-way: StockPilot pushes label requests + receives
-- tracking; nothing here mutates inventory from EasyPost.
--
-- The EasyPost API key + webhook secret live ONLY in Supabase Vault (via the
-- service-role connector_secret_* RPCs from 0146) and the connection row in
-- public.org_connections — NEVER in this table or returned to a client.
--
-- The `shipping` module is OFF by default (grandfathered enabled=false for all
-- existing orgs at the bottom of this file); every shipping server entrypoint
-- gates on assertModuleEnabled('shipping') + assertPermission('shipping:manage').
--
-- Conventions re-used:
--   • RLS helpers from 0001_init.sql: is_org_member(org_id uuid),
--     has_org_role(org_id uuid, min_role text) — wrapped in (SELECT ...) per
--     the InitPlan convention (0140).
--   • tg_set_updated_at() updated_at trigger (0001) with the `drop trigger if
--     exists` idempotency guard (0146).
--   • `drop policy if exists` policy guards (0144/0146); grants to authenticated.
--   • Grandfather pattern from 0147 (net-new optional module, enabled=false).
--
-- citext extension is already installed (0001_init.sql); warehouses.contact_email
-- already uses citext, so charters.contact_email mirrors it.
-- ============================================================================

-- 1. Charter mailing address + contact — destination for delivery shipments. -
--    No new RLS: charters already has organization_id + the charters_select /
--    charters_admin_write policies from 0007_internal_company.sql, which cover
--    these added columns automatically.
alter table public.charters add column if not exists address       jsonb;
alter table public.charters add column if not exists contact_name  text;
alter table public.charters add column if not exists contact_email citext;
alter table public.charters add column if not exists contact_phone text;

create index if not exists charters_org_with_address_idx
  on public.charters (organization_id) where address is not null;

-- 2. carrier_shipments — one per (delivery order, EasyPost shipment). ---------
--    NOTE: deliberately NOT named `shipments` — that name is taken by the
--    deprecated outbound warehouse-to-warehouse packing-slip table from
--    0050_shipments.sql, whose drop is still deferred (0114). Reusing the name
--    would make `create table if not exists` a silent no-op on any DB that has
--    the 0050 table (every existing/prod DB), so none of the EasyPost columns
--    would be created and the easypost_shipment_id index below would then abort.
--
--    FK on-delete (deliberate): organization_id + order_request_id CASCADE so a
--    deleted org/order takes its shipments with it. connection_id and
--    purchased_by intentionally use the default NO ACTION: org_connections is
--    soft-disconnected (status='disconnected', secret_id nulled — never hard
--    deleted) so it is never the deletion source, and on org deletion both this
--    table and org_connections cascade together via organizations; purchased_by
--    points at the actor and we keep the shipment audit even if the user row is
--    later removed (no automatic deletion path exercises these FKs today).
create table if not exists public.carrier_shipments (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  order_request_id     uuid not null references public.order_requests(id) on delete cascade,
  connection_id        uuid references public.org_connections(id),
  carrier              text,
  service              text,
  rate_cents           int,
  currency             text default 'USD',
  tracking_code        text,
  tracking_status      text,
  tracking_url         text,
  label_url            text,
  easypost_shipment_id text,
  easypost_rate_id     text,
  from_address         jsonb,
  to_address           jsonb,
  parcel               jsonb,
  status               text not null default 'draft'
                         check (status in ('draft','purchased','in_transit','delivered','returned','failure','cancelled')),
  purchased_at         timestamptz,
  purchased_by         uuid references public.user_profiles(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists carrier_shipments_org_order_idx
  on public.carrier_shipments (organization_id, order_request_id);
create index if not exists carrier_shipments_easypost_shipment_idx
  on public.carrier_shipments (easypost_shipment_id);

-- updated_at maintenance (tg_set_updated_at convention, 0001). ---------------
drop trigger if exists carrier_shipments_set_updated_at on public.carrier_shipments;
create trigger carrier_shipments_set_updated_at
  before update on public.carrier_shipments
  for each row execute function public.tg_set_updated_at();

-- RLS: member read, manager write. -------------------------------------------
alter table public.carrier_shipments enable row level security;

drop policy if exists carrier_shipments_select on public.carrier_shipments;
create policy carrier_shipments_select on public.carrier_shipments
  for select to authenticated using ((select public.is_org_member(organization_id)));

drop policy if exists carrier_shipments_write on public.carrier_shipments;
create policy carrier_shipments_write on public.carrier_shipments
  for all to authenticated
  using ((select public.has_org_role(organization_id,'manager')))
  with check ((select public.has_org_role(organization_id,'manager')));

grant select, insert, update, delete on public.carrier_shipments to authenticated;

-- 3. Grandfather: net-new 'shipping' module OFF for every existing org. -------
--    Mirrors 0147 (explicit opt-in; admin connects EasyPost from settings).
insert into public.organization_modules (organization_id, module_id, enabled, tier, enabled_at)
select o.id, 'shipping', false, 'optional', now()
from public.organizations o
on conflict (organization_id, module_id) do nothing;
