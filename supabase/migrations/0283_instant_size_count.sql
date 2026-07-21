-- Instant Size Count — data model (Phase 1).
-- A continuous-camera size-sticker counting SESSION produces an immutable
-- ledger of per-garment count EVENTS (each +1/-1 with size, method, confidence,
-- counter) plus an audit of manual size-tally ADJUSTMENTS. The per-size tally
-- is SUM(quantity_delta) grouped by size. Events are idempotent on
-- (session_id, idempotency_key) so an offline outbox can safely replay.
--
-- Modeled on the cycle-count + AI-shelf-scan tables (0023, 0124): org-scoped
-- RLS, staff-write, immutable ledger. Inventory application (finalize →
-- adjust_stock) is a SEPARATE migration once the add-vs-set semantic +
-- size→item resolution are decided (see the Phase 0 spec). This migration is
-- the data foundation only. See docs/superpowers/specs/2026-07-21-instant-
-- size-count-phase0.md.

-- ── 1) Sessions ─────────────────────────────────────────────────────────────
create table public.size_count_sessions (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  warehouse_id      uuid references public.warehouses(id) on delete set null,
  -- Optional receiving context (a size count is usually counting an incoming box).
  purchase_order_id uuid references public.purchase_orders(id) on delete set null,
  -- The base style/SKU group the counted sizes resolve within (size-run.ts key).
  style_key         text,
  box_id            text,
  mode              text not null default 'rapid_pass'
                      check (mode in ('rapid_pass','box_overview')),
  status            text not null default 'active'
                      check (status in ('active','review','completed','canceled')),
  expected_quantity integer,
  started_by        uuid references public.user_profiles(id) on delete set null,
  started_at        timestamptz not null default now(),
  completed_by      uuid references public.user_profiles(id) on delete set null,
  completed_at      timestamptz,
  canceled_by       uuid references public.user_profiles(id) on delete set null,
  canceled_at       timestamptz,
  device_id         text,
  model_version     text,
  created_offline   boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index size_count_sessions_org_status_idx
  on public.size_count_sessions (organization_id, status, started_at desc);
create index size_count_sessions_org_wh_idx
  on public.size_count_sessions (organization_id, warehouse_id, status);

create trigger tg_size_count_sessions_updated_at
  before update on public.size_count_sessions
  for each row execute function public.tg_set_updated_at();

-- ── 2) Events (immutable per-garment ledger) ────────────────────────────────
create table public.size_count_events (
  id                 uuid primary key default gen_random_uuid(),
  session_id         uuid not null references public.size_count_sessions(id) on delete cascade,
  -- Denormalized org for RLS without a join to the parent.
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  -- Client-minted UUID: an offline outbox replays safely (dedup below).
  idempotency_key    text not null,
  -- The on-device track id that produced this count (dedupe/debug provenance).
  ephemeral_track_id text,
  size               text not null,
  -- Usually +1; -1 for an undo/correction. Tally = SUM(quantity_delta).
  quantity_delta     integer not null default 1,
  confidence         numeric(5,4),
  recognition_method text not null default 'rapid_pass_gate'
                      check (recognition_method in
                        ('rapid_pass_gate','box_overview','manual','ai_review','barcode')),
  reason             text,
  counted_by         uuid references public.user_profiles(id) on delete set null,
  counted_at         timestamptz not null default now(),
  model_version      text,
  review_status      text not null default 'auto'
                      check (review_status in ('auto','confirmed','rejected')),
  created_at         timestamptz not null default now(),
  -- Idempotent replay: the same client event key can only land once per session.
  unique (session_id, idempotency_key)
);

create index size_count_events_session_idx
  on public.size_count_events (session_id);
create index size_count_events_org_counted_idx
  on public.size_count_events (organization_id, counted_at desc);

-- ── 3) Adjustments (manual size-tally correction audit) ─────────────────────
create table public.size_count_adjustments (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references public.size_count_sessions(id) on delete cascade,
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  size              text not null,
  previous_quantity integer not null,
  new_quantity      integer not null,
  delta             integer not null,
  reason            text,
  operator_id       uuid references public.user_profiles(id) on delete set null,
  created_at        timestamptz not null default now()
);

create index size_count_adjustments_session_idx
  on public.size_count_adjustments (session_id);

-- ── 4) RLS ──────────────────────────────────────────────────────────────────
alter table public.size_count_sessions    enable row level security;
alter table public.size_count_events       enable row level security;
alter table public.size_count_adjustments  enable row level security;

-- Sessions: any org member reads; staff+ create/update within their org and
-- (when the session names a warehouse) a warehouse in that org.
create policy size_count_sessions_select on public.size_count_sessions
  for select to authenticated
  using ((select public.is_org_member(organization_id)));
create policy size_count_sessions_insert on public.size_count_sessions
  for insert to authenticated
  with check (
    (select public.has_org_role(organization_id, 'staff'))
    and (warehouse_id is null
         or (select public.warehouse_in_org(warehouse_id, organization_id)))
  );
create policy size_count_sessions_update on public.size_count_sessions
  for update to authenticated
  using ((select public.has_org_role(organization_id, 'staff')))
  with check (
    (select public.has_org_role(organization_id, 'staff'))
    and (warehouse_id is null
         or (select public.warehouse_in_org(warehouse_id, organization_id)))
  );

-- Events: org member reads; staff+ append (INSERT only — the ledger is
-- immutable, so no UPDATE/DELETE policy exists → those are denied by RLS).
-- counted_by must be the caller (audit integrity).
create policy size_count_events_select on public.size_count_events
  for select to authenticated
  using ((select public.is_org_member(organization_id)));
create policy size_count_events_insert on public.size_count_events
  for insert to authenticated
  with check (
    (select public.has_org_role(organization_id, 'staff'))
    and (counted_by is null or counted_by = (select auth.uid()))
    and exists (
      select 1 from public.size_count_sessions s
      where s.id = size_count_events.session_id
        and s.organization_id = size_count_events.organization_id
    )
  );

-- Adjustments: org member reads; staff+ append (immutable). operator = caller.
create policy size_count_adjustments_select on public.size_count_adjustments
  for select to authenticated
  using ((select public.is_org_member(organization_id)));
create policy size_count_adjustments_insert on public.size_count_adjustments
  for insert to authenticated
  with check (
    (select public.has_org_role(organization_id, 'staff'))
    and (operator_id is null or operator_id = (select auth.uid()))
    and exists (
      select 1 from public.size_count_sessions s
      where s.id = size_count_adjustments.session_id
        and s.organization_id = size_count_adjustments.organization_id
    )
  );
