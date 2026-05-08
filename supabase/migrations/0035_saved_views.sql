-- 0035_saved_views.sql
-- Per-user saved filter/sort/search/warehouse presets for the
-- inventory + books tables. Replaces the placeholder "+ Saved view"
-- chip in inventory-table.tsx with a real DB-backed feature.
--
-- Spec: docs/superpowers/specs/2026-05-08-saved-views-design.md

create table if not exists public.saved_views (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references public.user_profiles(id) on delete cascade,
  name            text not null check (length(trim(name)) between 1 and 80),
  -- 'inventory' | 'books' — pages that share the InventoryTable component
  scope           text not null check (scope in ('inventory', 'books')),
  -- Toolbar params (q, status, stock, type, sort, cat[], loc[]) plus
  -- the warehouse id snapshot. JSON-encoded so adding new filter axes
  -- later doesn't need a migration.
  state           jsonb not null default '{}'::jsonb,
  -- Forward-compat for drag-to-reorder; default zero is a no-op until
  -- a UI wires it.
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, organization_id, scope, name)
);

create index if not exists saved_views_user_org_scope_idx
  on public.saved_views(user_id, organization_id, scope, sort_order, created_at);

alter table public.saved_views enable row level security;

-- Owner-only access. Org membership is implicit because the view's
-- organization_id was set at insert time from the user's active org.
create policy "saved_views_owner_select" on public.saved_views
  for select using (user_id = auth.uid());
create policy "saved_views_owner_insert" on public.saved_views
  for insert with check (user_id = auth.uid());
create policy "saved_views_owner_update" on public.saved_views
  for update using (user_id = auth.uid());
create policy "saved_views_owner_delete" on public.saved_views
  for delete using (user_id = auth.uid());

create trigger saved_views_set_updated_at
  before update on public.saved_views
  for each row execute function public.tg_set_updated_at();

comment on table public.saved_views is
  'Per-user filter/sort/warehouse presets for the inventory + books pages. Owner-only RLS.';
comment on column public.saved_views.state is
  'JSON-encoded toolbar state (q, status, stock, type, sort, cat[], loc[], warehouseId). Schema-flexible so adding filter axes does not need a migration.';
