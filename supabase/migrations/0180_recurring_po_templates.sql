-- Recurring purchase-order templates.
--
-- A template = a supplier + line items + a cadence + a send rule. The daily
-- /api/cron/recurring-pos turns each DUE template (next_run_at <= now) into a
-- purchase order — draft by default, or auto-sent when send_mode='send' and the
-- total is within both the configured cap and the org's PO approval threshold
-- (mirrors the auto-reorder money-safety gating).
--
-- Line items live in jsonb ([{itemId,quantityOrdered,unitCost}]) so the cron
-- needs no join. Writes happen only through the service-role client behind
-- gated server actions + the cron (no authenticated write policy), same posture
-- as restore_points (0178).

create table if not exists public.recurring_po_templates (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,
  supplier_id             uuid references public.suppliers(id) on delete set null,
  destination_location_id uuid references public.locations(id) on delete set null,
  name                    text not null,
  enabled                 boolean not null default true,
  cadence                 text not null check (cadence in ('weekly','biweekly','monthly','quarterly','custom')),
  custom_days             integer check (custom_days is null or (custom_days between 1 and 365)),
  send_mode               text not null default 'draft' check (send_mode in ('draft','send')),
  max_auto_send_cents     numeric(14,4) check (max_auto_send_cents is null or max_auto_send_cents >= 0),
  line_items              jsonb not null default '[]'::jsonb,
  notes                   text,
  last_run_at             timestamptz,
  next_run_at             timestamptz not null,
  created_by              uuid references public.user_profiles(id) on delete set null,
  updated_by              uuid references public.user_profiles(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (organization_id, name)
);

-- Fast "due templates for this org" lookup for the cron.
create index if not exists recurring_po_templates_due_idx
  on public.recurring_po_templates(organization_id, next_run_at)
  where enabled;

create trigger recurring_po_templates_set_updated_at
  before update on public.recurring_po_templates
  for each row execute function public.tg_set_updated_at();

alter table public.recurring_po_templates enable row level security;

-- READ: any org member (the management list page reads via the ctx client;
-- the create/update/delete actions enforce purchase_orders:manage on top).
-- No authenticated INSERT/UPDATE/DELETE policy → writes are service-role-only.
create policy recurring_po_templates_select on public.recurring_po_templates
  for select to authenticated
  using ((select public.is_org_member(organization_id)));

grant select on public.recurring_po_templates to authenticated;
