-- 0178_restore_points.sql
-- ─────────────────────────────────────────────────────────────────────
-- Inventory Restore Points — point-in-time snapshots of an org's items +
-- stock that it can roll back to (safe reconcile). Business tier and above.
--
-- One row = one snapshot. The `snapshot` jsonb holds the captured items
-- (and their category/supplier/location names) so a restore can re-create
-- deleted records. Snapshots are created on demand + daily (cron) and pruned
-- to a retention window in the service.
--
-- RLS: admin/owner-only READ (restore points are a sensitive admin surface —
-- the blob is the org's whole inventory). All WRITES go through the
-- service-role admin client behind the gated server actions (no insert/update/
-- delete policies → the authenticated client cannot write).
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.restore_points (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  created_at       timestamptz not null default now(),
  created_by       uuid references public.user_profiles(id) on delete set null,
  kind             text not null check (kind in ('manual', 'auto', 'pre_restore')),
  label            text,
  item_count       integer not null default 0,
  -- true when the capture hit SNAPSHOT_ITEM_CAP (disclosed in the UI)
  capped           boolean not null default false,
  snapshot         jsonb not null
);

create index if not exists restore_points_org_created_idx
  on public.restore_points (organization_id, created_at desc);

alter table public.restore_points enable row level security;

-- READ: owners/admins of the org only (has_org_role floor). No write policies →
-- inserts/prunes happen via the service-role client behind gated actions.
create policy restore_points_select on public.restore_points
  for select to authenticated
  using (public.has_org_role(organization_id, 'admin'));
