-- 0010_po_imports.sql
-- ─────────────────────────────────────────────────────────────────────
-- Staging tables for uploaded purchase orders.
--
-- A row in po_imports starts at status='uploaded' when a file lands in
-- storage, transitions through 'parsing' → 'parsed' (or 'failed') by a
-- server action, then 'approved' converts it into a real
-- purchase_orders row in status='expected_inbound'.
--
-- This staging layer is what lets PO upload NOT increase usable stock.
-- Inventory only changes when a separate receipt is posted against the
-- approved PO via the Phase 2 receiving service.
-- ─────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

-- ─────────────────────────────────────────────────────────────────────
-- po_imports
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.po_imports (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  uploaded_by     uuid not null references public.user_profiles(id) on delete restrict,
  source_type     text not null check (source_type in ('pdf','csv','xlsx','manual')),
  vendor_id       uuid references public.suppliers(id) on delete set null,
  warehouse_id    uuid references public.warehouses(id) on delete set null,
  file_name       text not null,
  file_mime_type  text not null,
  file_size       bigint not null,
  storage_path    text not null,
  sha256          text not null,
  raw_text        text,
  parsed_json     jsonb,
  parse_error     text,
  status          text not null default 'uploaded'
                    check (status in (
                      'uploaded','parsing','parsed','needs_review',
                      'approved','failed','duplicate','canceled'
                    )),
  approved_po_id  uuid references public.purchase_orders(id) on delete set null,
  approved_at     timestamptz,
  approved_by     uuid references public.user_profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Duplicate-detection: same org + same content hash, while still active.
create unique index if not exists po_imports_org_sha_uniq
  on public.po_imports(organization_id, sha256)
  where status not in ('failed','canceled','duplicate');

create index if not exists po_imports_org_status_idx
  on public.po_imports(organization_id, status, created_at desc);

create trigger po_imports_updated_at
  before update on public.po_imports
  for each row execute function public.tg_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- po_import_lines
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.po_import_lines (
  id                    uuid primary key default gen_random_uuid(),
  po_import_id          uuid not null references public.po_imports(id) on delete cascade,
  line_number           int not null,
  line_type             text not null default 'unknown'
                          check (line_type in (
                            'inventory','tax','freight','service',
                            'fee','discount','unknown'
                          )),
  qty_ordered_original  numeric(18,4),
  uom_original          text,
  description           text,
  unit_cost             numeric(18,4),
  line_total            numeric(18,4),
  vendor_item_number    text,
  vendor_product_number text,
  auxiliary_number      text,
  coa_code              text,
  -- Suggested / approved internal mapping
  item_id               uuid references public.inventory_items(id) on delete set null,
  match_status          text not null default 'needs_review'
                          check (match_status in (
                            'exact_match','mapped','suggested',
                            'needs_review','rejected','non_inventory'
                          )),
  match_confidence      numeric(4,3),
  exception_reason      text,
  parsed_json           jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (po_import_id, line_number)
);

create index if not exists po_import_lines_status_idx
  on public.po_import_lines(po_import_id, match_status);

create trigger po_import_lines_updated_at
  before update on public.po_import_lines
  for each row execute function public.tg_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- RLS — same model as purchase_orders: org members read; manager+ write.
-- ─────────────────────────────────────────────────────────────────────
alter table public.po_imports enable row level security;
alter table public.po_import_lines enable row level security;

drop policy if exists po_imports_select on public.po_imports;
create policy po_imports_select on public.po_imports
  for select using (
    exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = po_imports.organization_id
        and m.accepted_at is not null
    )
  );

drop policy if exists po_imports_insert on public.po_imports;
create policy po_imports_insert on public.po_imports
  for insert with check (
    public.has_org_role(organization_id, 'manager')
  );

drop policy if exists po_imports_update on public.po_imports;
create policy po_imports_update on public.po_imports
  for update
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));

drop policy if exists po_import_lines_select on public.po_import_lines;
create policy po_import_lines_select on public.po_import_lines
  for select using (
    exists (
      select 1 from public.po_imports i
      where i.id = po_import_lines.po_import_id
        and exists (
          select 1 from public.organization_members m
          where m.user_id = auth.uid()
            and m.organization_id = i.organization_id
            and m.accepted_at is not null
        )
    )
  );

drop policy if exists po_import_lines_write on public.po_import_lines;
create policy po_import_lines_write on public.po_import_lines
  for all using (
    exists (
      select 1 from public.po_imports i
      where i.id = po_import_lines.po_import_id
        and public.has_org_role(i.organization_id, 'manager')
    )
  );
