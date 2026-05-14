-- 0082_bundle_distributions_event_unique.sql
-- ============================================================================
-- One distribution per schedule_event (auto-distribute race guard)
-- ----------------------------------------------------------------------------
-- Schedule events with a linked bundle auto-distribute on the first
-- transition into 'completed'. Today that gate is service-side only:
--
--     1) read current status from schedule_events
--     2) read bundle_distributions for prior runs
--     3) update status to 'completed'
--     4) call distribute_bundle()
--
-- Two managers clicking "Mark complete" in the same second race between
-- steps 2 and 4 → both pass the "no prior distribution" check, both fire
-- distribute_bundle, the kit ships twice. The non-unique
-- bundle_distributions_event_idx (migration 0040) doesn't help here.
--
-- Add a UNIQUE partial index so the second writer hits 23505 instead.
-- The service layer catches the unique-violation, swallows it as a
-- benign no-op (event already distributed), and the user-facing status
-- transition still succeeds.
--
-- NB: this index intentionally allows multiple distributions whose
-- schedule_event_id is NULL — ad-hoc / non-event distributions still
-- work normally. Only event-driven runs are de-duped.
-- ============================================================================

create unique index if not exists bundle_distributions_event_uniq
  on public.bundle_distributions(schedule_event_id)
  where schedule_event_id is not null;

-- The old non-unique partial index becomes redundant once the unique
-- one is in place (every lookup on schedule_event_id is satisfied by
-- the unique index). Drop it to save a write per insert.
drop index if exists public.bundle_distributions_event_idx;
