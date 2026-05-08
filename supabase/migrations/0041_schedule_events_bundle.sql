-- ============================================================================
-- 0041_schedule_events_bundle.sql — link schedule_events to bundles
-- ============================================================================
-- Lets a calendar event optionally reference a bundle + a quantity. When
-- the event is marked complete, the service layer fires
-- distribute_bundle() automatically. Both columns nullable; existing
-- events are unaffected.
-- ============================================================================

alter table public.schedule_events
  add column if not exists bundle_id uuid
    references public.bundles(id) on delete set null,
  add column if not exists bundle_quantity numeric(14,4)
    check (bundle_quantity is null or bundle_quantity > 0),
  add column if not exists bundle_warehouse_id uuid
    references public.warehouses(id) on delete set null;

-- A bundle reference without a quantity is a half-configured event;
-- ensure both are set together (or both null).
alter table public.schedule_events
  add constraint schedule_events_bundle_paired_chk
  check (
    (bundle_id is null and bundle_quantity is null and bundle_warehouse_id is null)
    or (bundle_id is not null and bundle_quantity is not null and bundle_warehouse_id is not null)
  );

create index if not exists schedule_events_bundle_idx
  on public.schedule_events(bundle_id)
  where bundle_id is not null;
