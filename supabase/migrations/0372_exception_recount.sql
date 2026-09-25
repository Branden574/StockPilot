-- 0372_exception_recount.sql
--
-- F1-2: the targeted recount loop, and the one source of "last physical
-- count" that the count_variance rule reads.
--
-- From an occurrence (or an item) a manager starts a recount. It is an
-- ORDINARY cycle count: public.start_cycle_count creates it, staff record it
-- (online or offline), a manager posts it through ledger.post_cycle_count, and
-- the after-post sync re-checks the condition. F1 writes no stock.
--
-- ── WHAT IT ADDS ───────────────────────────────────────────────────────────
--   1. cycle_count_lines_item_idx on cycle_count_lines(item_id). Every read
--      below looks lines up by item; there was no index for it.
--   2. _latest_count_lines(org, item_ids, as_of): the latest COMPLETED,
--      COUNTED line per item, ordered by the moment its expected quantity is
--      true for (baseline_at, 0369), not by when the count was posted.
--      service_role only (the system evaluator, and later the F1-3
--      summaries). as_of leaves out counts completed after the evaluation
--      began, so the evaluator never judges a count the sync will not yet
--      close.
--   3. cycle_count_line_rechecks(line): whether a count line re-checks its
--      item, i.e. once its count is posted it is (or was) the item's latest
--      physical count. A line counted BEFORE another count of the item that
--      is already posted can never re-check it: posting it applies nothing
--      (or is refused as superseded, 0369) and _latest_count_lines keeps the
--      later line. The recount links only to lines that can re-check, and the
--      app says "counted before a later count" instead of "matched the book"
--      for one that could not. SECURITY INVOKER, readable wherever the line
--      is (a PostgREST computed field).
--   4. idempotency_keys.response: the first answer of a targeted recount, so
--      a replay (a lost answer, resent) says what the first call did.
--   5. _exc_link_recount(): points an open occurrence at the count that will
--      re-check it, with a recount_linked event (SECURITY DEFINER, gated in
--      its body, safe to call on its own).
--   6. start_targeted_recount(): the recount entry point (SECURITY INVOKER,
--      so the count is created under the caller's own RLS).
--   7. exceptions_sync, replaced with two changes (everything else is 0370's
--      body, unchanged):
--        * a row it resolves has its recount pointer closed first when that
--          count is over, whatever its completion time, so the timeline always
--          reads recount_closed, then resolved;
--        * an open count_variance whose item can no longer be counted
--          (discontinued, rental equipment, a kit, archived, deleted) resolves
--          as subject_gone, never as cleared: no count re-checked it.
--   count_variance is an item-level rule exceptions_sync already accepts
--   (0370 listed it), and a hold entry already keeps an open row open and
--   never opens one (the 30-day window).
--
-- ── FROZEN ─────────────────────────────────────────────────────────────────
-- start_cycle_count, ledger.post_cycle_count, the rebase trigger,
-- apply_level_delta, apply_cycle_count_location_delta and the 0371 holdings
-- objects are untouched. start_targeted_recount CALLS start_cycle_count
-- unchanged; it never copies its body.
--
-- ── WHO MAY RECOUNT ────────────────────────────────────────────────────────
-- Managers only, with cycle_counts:assign AND stock:adjust: the same floors
-- as CycleCountsService.start() (pattern #4), and the cycle_counts INSERT
-- policy is manager anyway. Managers have write access to every warehouse of
-- their org (user_can_access_inventory), so no per-warehouse check is needed
-- here; the service still runs its per-warehouse preflight first.
-- Recount is offered only for item-level rules (count_variance,
-- over_reserved): an item-total count cannot say which holding a Staging or
-- Unplaced difference belongs to (0342/0343 routing), so holding rules and
-- label_mismatch are skipped as not_recountable.
--
-- ── ONE COUNT PER ITEM, EVEN UNDER A DOUBLE TAP ────────────────────────────
--   * idempotency_keys scope 'targeted_recount' (the 0347 pattern). The
--     request hash is computed HERE over the sorted, de-duplicated occurrence
--     ids and item ids (notes are commentary and are not part of it). The same
--     key and hash returns the original count (created false, replay true);
--     the same key with another request is refused (idempotency_conflict).
--     The key row is written with INSERT ... ON CONFLICT DO NOTHING, so a
--     second call with the same key WAITS for the first transaction and then
--     reads its committed answer, instead of failing on the unique index.
--   * A transaction advisory lock per item ('sp:recount:<item>'), taken in
--     the sorted order of the lock keys themselves, so two starts can never
--     wait on each other in opposite orders. Under the lock, an item that is
--     already in an in-progress count WHOSE LINE CAN STILL RE-CHECK IT
--     (uncounted, or counted after every posted count of the item:
--     cycle_count_line_rechecks) is linked to that count, not counted again;
--     an open count whose line was counted before the difference was found
--     cannot settle it, so the item gets a new count (the overlap is allowed,
--     and 0369's superseded refusal keeps the old line from applying twice).
--     Two concurrent starts for one item make exactly one count
--     (scripts/db-concurrency/0372_recount_overlap.sh). Plain starts
--     (CycleCountsService.start) do not take these locks; overlaps from them
--     stay allowed (S5-C D6) and 0369's superseded refusal is the backstop.
--   * The open counts holding the items are locked FOR SHARE (id order)
--     before they are classified. A post holds its count FOR UPDATE and a
--     cancel updates it, so a count being posted or cancelled right now is
--     waited for and then seen as closed (its items get a new count), instead
--     of being linked in the instant before it closes.
--   * When occurrences are named, the org's exceptions_sync advisory lock is
--     taken before they are read. The sync updates many occurrence rows in one
--     statement; linking several rows one by one while it runs could meet it
--     in opposite row orders (a deadlock). Holding the sync lock also means no
--     sync resolves or re-points an occurrence between its read and its link.
--
-- ── RETURN SHAPE (jsonb) ───────────────────────────────────────────────────
--   {cycleCountId: uuid|null,   the NEW count (null when none was needed)
--    countNumber: bigint|null, lineCount: int, created: bool, replay: bool,
--    linked: [occurrenceId],    occurrences linked to the new count
--    linkedExisting: [{cycleCountId, countNumber, assignedTo, startedAt,
--                      itemIds: [..], occurrenceIds: [..]}],
--    skipped: [{occurrenceId|null, itemId, reason}]}
--   reason: resolved | not_recountable | not_countable. Every requested
--   occurrence or explicit item that is skipped appears once (an explicit
--   item that is also the item of a named open, recountable occurrence is
--   reported through that occurrence).
--   A replay answers with the FIRST call's answer, stored with the key
--   (idempotency_keys.response), marked created: false and replay: true: the
--   same count, links and skips, so a resent request after a lost answer still
--   says which counts the exceptions were linked to. The stored answer holds
--   ids only (counts, occurrences, items, the assignee) and is readable by the
--   org's members like the rest of the key row (0013).
--
-- ── REFUSALS (never 40001/40P01: 0367) ─────────────────────────────────────
--   42501  not signed in, or below the floors ('forbidden').
--   P0002  an occurrence, item or count that is not in the org or not
--          visible (existence is not leaked).
--   22023  hint invalid_argument | recount_nothing_selected |
--          recount_too_many_items (more than 200 items) | notes_too_long |
--          idempotency_key_too_long.
--   P0001  hint idempotency_conflict | recount_already_linked |
--          occurrence_resolved | not_recountable | recount_count_not_open |
--          recount_item_not_in_count | recount_line_already_counted |
--          recount_items_changed.
--   P0001  cycle_count_no_items (no hint) from start_cycle_count itself.
--   55P03  a lock wait past lock_timeout (5 s, below the API roles' 8 s
--          statement timeout so the retryable answer arrives first).
--
-- ── PROD PUSH NOTE ─────────────────────────────────────────────────────────
-- CREATE INDEX (not CONCURRENTLY: the CLI batch runs in a transaction) blocks
-- writes to cycle_count_lines while it builds, a few milliseconds at about
-- 2k rows. ADD COLUMN idempotency_keys.response (nullable, no default) is a
-- catalog-only change. lock_timeout makes the push fail fast instead of
-- queueing behind a long transaction (retry is the remedy). The replaced
-- exceptions_sync keeps 0370's signature and answer shape, so the deployed
-- cron keeps working across the push; everything else is new functions that
-- old app code never calls.

-- PLAIN `set`, not `set local` (0303/0358/0370). Reset at the end.
set lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. cycle_count_lines(item_id)
-- ═══════════════════════════════════════════════════════════════════════════
create index if not exists cycle_count_lines_item_idx
  on public.cycle_count_lines (item_id);

comment on index public.cycle_count_lines_item_idx is
  'Lines by item (0372): the latest physical count per item, and which open '
  'counts already hold an item a recount asks for.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. _latest_count_lines: the one source of "last physical count"
-- ═══════════════════════════════════════════════════════════════════════════
-- The latest line per item among COMPLETED counts where the item was counted.
-- Cancelled and in-progress counts, and lines left uncounted, are ignored.
--
-- ORDER: coalesce(baseline_at, counted_at) desc, then completed_at desc.
-- baseline_at (0369) is the moment the line's expected quantity is true for
-- (the capture time of an offline count, or the moment an online record read
-- the book). A count posted later can hold an OLDER observation (a phone that
-- counted offline and synced late), so "posted last" is not "observed last".
-- counted_at is the fallback for lines from before 0369; nulls sort last.
--
-- variance = counted_quantity - expected_quantity: exactly what the post
-- applied for that line (ledger.post_cycle_count, 0369).
--
-- item_countable is start_cycle_count's own predicate (active, not deleted,
-- not rental equipment, not a kit phantom): count_variance leaves the other
-- items out, and a recount skips them. It is returned rather than filtered so
-- the same rows can say "counted, but no longer countable" (F1-3).
--
-- AS OF: p_as_of (the evaluation's start) leaves out counts completed after
-- it. exceptions_sync closes a recount pointer only for a count completed at
-- or before p_evaluated_at; without this bound an evaluation whose read lands
-- just after a recount is posted would resolve the exception from that count
-- while the sync keeps its pointer open (the timeline would read "resolved",
-- then "recount closed"). completed_at is the post's transaction start, so a
-- post that began before the evaluation and commits after its read is still
-- missed by this read; the post's own follow-up sync applies it moments later.
--
-- SECURITY DEFINER with no API grant but service_role: it reads past RLS on
-- purpose (the system evaluator must see every count of the org), so it must
-- never be callable by a signed-in user. The org filter is the tenant
-- boundary; every join is pinned to the count's org.
create or replace function public._latest_count_lines(
  p_org      uuid,
  p_item_ids uuid[]      default null,
  p_as_of    timestamptz default null
)
returns table (
  item_id               uuid,
  cycle_count_id        uuid,
  count_number          bigint,
  scope                 text,
  completed_at          timestamptz,
  completed_by          uuid,
  counted_by            uuid,
  counted_at            timestamptz,
  captured_at           timestamptz,
  baseline_at           timestamptz,
  expected_quantity     numeric,
  expected_at_start     numeric,
  counted_quantity      numeric,
  counted_location_id   uuid,
  counted_location_name text,
  ai_assisted           boolean,
  line_warehouse_id     uuid,
  item_name             text,
  item_sku              text,
  item_warehouse_id     uuid,
  item_countable        boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (l.item_id)
         l.item_id,
         c.id,
         c.count_number,
         c.scope,
         c.completed_at,
         c.completed_by,
         l.counted_by,
         l.counted_at,
         l.captured_at,
         l.baseline_at,
         l.expected_quantity,
         l.expected_at_start,
         l.counted_quantity,
         l.counted_location_id,
         loc.name,
         l.ai_scan_id is not null,
         l.warehouse_id,
         i.name,
         i.sku,
         i.warehouse_id,
         (i.deleted_at is null and i.status = 'active' and not i.is_rental and not i.is_bundle)
    from public.cycle_counts c
    join public.cycle_count_lines l
      on l.cycle_count_id = c.id
    join public.inventory_items i
      on i.id = l.item_id
     and i.organization_id = c.organization_id
    left join public.locations loc
      on loc.id = l.counted_location_id
     and loc.organization_id = c.organization_id
   where c.organization_id = p_org
     and c.status = 'completed'
     and (p_as_of is null or c.completed_at <= p_as_of)
     and l.counted_quantity is not null
     and (p_item_ids is null or l.item_id = any (p_item_ids))
   order by l.item_id,
            coalesce(l.baseline_at, l.counted_at) desc nulls last,
            c.completed_at desc nulls last,
            c.id desc;
$$;

revoke all on function public._latest_count_lines(uuid, uuid[], timestamptz) from public, anon, authenticated;
grant execute on function public._latest_count_lines(uuid, uuid[], timestamptz) to service_role;

comment on function public._latest_count_lines(uuid, uuid[], timestamptz) is
  'The latest completed, counted cycle-count line per item of an org (0372), '
  'ordered by coalesce(baseline_at, counted_at) desc, completed_at desc. '
  'Optional item filter; optional as-of bound (counts completed at or before '
  'it). variance = counted_quantity - expected_quantity (what the post '
  'applied). item_countable = start_cycle_count''s predicate. '
  'SECURITY DEFINER, EXECUTE to service_role only.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. cycle_count_line_rechecks: can this line re-check its item?
-- ═══════════════════════════════════════════════════════════════════════════
-- A line RE-CHECKS its item when, once its count is posted, it is the item's
-- latest physical count in _latest_count_lines' order (coalesce(baseline_at,
-- counted_at), the moment the line's book quantity is true for):
--   * count in progress: the line is uncounted (whoever counts it counts it
--     now), or it was counted no earlier than every POSTED count of the item;
--   * count completed: the line was counted, and no count posted at or before
--     it holds a later observation of the item (null when the line's moment
--     is unknown: nothing can be said);
--   * count cancelled: false.
-- A line counted before another count of the item was posted cannot re-check
-- it: posting it applies nothing when it matched its book (the post skips a
-- zero line) and is refused as superseded otherwise (0369), and either way
-- the later line stays the latest. Linking a recount to such a line would
-- report "matched the book" for an item nobody counted again.
--
-- One predicate for every caller (pattern #26): start_targeted_recount's
-- choice of an open count, _exc_link_recount's checks, and the app's outcome
-- words (read as a PostgREST computed field, `rechecks:cycle_count_line_rechecks`).
--
-- SECURITY INVOKER: it reads only what the caller can read (cycle_counts and
-- cycle_count_lines are readable by every member of the org), so it discloses
-- nothing new and needs no gate. Called from _exc_link_recount (DEFINER) it
-- runs as that function's owner and sees the org's counts in full, the same
-- set a member sees.
create or replace function public.cycle_count_line_rechecks(p_line public.cycle_count_lines)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select case
           when c.status = 'in_progress' then
             p_line.counted_quantity is null
             or (coalesce(p_line.baseline_at, p_line.counted_at) is not null
                 and not exists (
                   select 1
                     from public.cycle_counts c2
                     join public.cycle_count_lines l2 on l2.cycle_count_id = c2.id
                    where c2.organization_id = c.organization_id
                      and c2.status = 'completed'
                      and c2.id <> c.id
                      and l2.item_id = p_line.item_id
                      and l2.counted_quantity is not null
                      and coalesce(l2.baseline_at, l2.counted_at)
                            > coalesce(p_line.baseline_at, p_line.counted_at)))
           when c.status = 'completed' then
             case
               when p_line.counted_quantity is null then false
               when coalesce(p_line.baseline_at, p_line.counted_at) is null then null
               else not exists (
                 select 1
                   from public.cycle_counts c2
                   join public.cycle_count_lines l2 on l2.cycle_count_id = c2.id
                  where c2.organization_id = c.organization_id
                    and c2.status = 'completed'
                    and c2.id <> c.id
                    and c2.completed_at <= c.completed_at
                    and l2.item_id = p_line.item_id
                    and l2.counted_quantity is not null
                    and coalesce(l2.baseline_at, l2.counted_at)
                          > coalesce(p_line.baseline_at, p_line.counted_at))
             end
           else false
         end
    from public.cycle_counts c
   where c.id = p_line.cycle_count_id;
$$;

revoke all on function public.cycle_count_line_rechecks(public.cycle_count_lines) from public, anon;
grant execute on function public.cycle_count_line_rechecks(public.cycle_count_lines) to authenticated, service_role;

comment on function public.cycle_count_line_rechecks(public.cycle_count_lines) is
  'Whether a count line re-checks its item (0372): once its count is posted it '
  'is (or was) the item''s latest physical count. In progress: uncounted, or '
  'counted no earlier than every posted count of the item. Completed: counted, '
  'and no count posted at or before it observed the item later (null when the '
  'line''s moment is unknown). Cancelled: false. SECURITY INVOKER; a PostgREST '
  'computed field on cycle_count_lines.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. idempotency_keys.response
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.idempotency_keys add column if not exists response jsonb;

comment on column public.idempotency_keys.response is
  'The first answer of an idempotent call, returned on a replay (0372: '
  'start_targeted_recount stores its jsonb answer; ids only). Null for scopes '
  'that answer with resource_id alone.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. _exc_link_recount: point an open occurrence at its recount
-- ═══════════════════════════════════════════════════════════════════════════
-- Called by start_targeted_recount for each occurrence, and safe to call on
-- its own (EXECUTE is granted to authenticated because the INVOKER caller
-- runs as the user; every gate is in the body, INV-25):
--   * signed in, and the occurrence is VISIBLE to the caller
--     (_exc_occurrence_visible), else "not found" (P0002), so an id from
--     another org or out of scope reveals nothing; the row is locked;
--   * a manager with cycle_counts:assign in the occurrence's org (42501);
--   * the occurrence is open (occurrence_resolved) and its rule recountable
--     (not_recountable);
--   * the count is in the occurrence's org (else P0002), in progress
--     (recount_count_not_open), holds a line for the occurrence's item
--     (recount_item_not_in_count) and that line can still re-check the item
--     (cycle_count_line_rechecks: uncounted, or counted no earlier than every
--     posted count of it; else recount_line_already_counted). It is locked
--     FOR SHARE, so a post (FOR UPDATE) or cancel waits for this link and is
--     then seen by the sync;
--   * already linked to this count: nothing is written, returns false;
--   * linked to ANOTHER in-progress count whose line can still re-check the
--     item: recount_already_linked (one live recount per occurrence);
--   * linked to a count that is over, no longer holds the item, or whose line
--     was counted before a later posted count (it can no longer settle the
--     exception), and the sync has not closed it: that pointer is closed here
--     first, with the same system recount_closed event the sync writes, so
--     the timeline stays in order (recount_closed, then recount_linked);
--   * writes the pointer and a recount_linked event (actor = caller) and
--     returns true.
-- It never touches resolved_at: only exceptions_sync resolves.
create or replace function public._exc_link_recount(
  p_occurrence_id  uuid,
  p_cycle_count_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
set lock_timeout = '5s'
as $$
declare
  c_recountable constant text[] := array['count_variance', 'over_reserved'];
  v_uid      uuid := auth.uid();
  v_occ      public.exception_occurrences%rowtype;
  v_status   text;
  v_rechecks boolean;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_occurrence_id is null or p_cycle_count_id is null then
    raise exception 'invalid_argument' using errcode = '22023', hint = 'invalid_argument';
  end if;

  select o.* into v_occ
    from public.exception_occurrences o
   where o.id = p_occurrence_id
     and public._exc_occurrence_visible(o.organization_id, o.item_id, o.location_id)
   for update;
  if not found then
    raise exception 'occurrence_not_found' using errcode = 'P0002';
  end if;

  if not public.has_org_role(v_occ.organization_id, 'manager')
     or not public.has_permission(v_occ.organization_id, 'cycle_counts:assign') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_occ.resolved_at is not null then
    raise exception 'occurrence_resolved' using errcode = 'P0001', hint = 'occurrence_resolved';
  end if;
  if v_occ.rule <> all (c_recountable) then
    raise exception 'not_recountable' using errcode = 'P0001', hint = 'not_recountable';
  end if;

  select c.status into v_status
    from public.cycle_counts c
   where c.id = p_cycle_count_id
     and c.organization_id = v_occ.organization_id
     for share;
  if not found then
    raise exception 'cycle_count_not_found' using errcode = 'P0002';
  end if;
  if v_status <> 'in_progress' then
    raise exception 'recount_count_not_open' using errcode = 'P0001', hint = 'recount_count_not_open';
  end if;
  select public.cycle_count_line_rechecks(l) into v_rechecks
    from public.cycle_count_lines l
   where l.cycle_count_id = p_cycle_count_id
     and l.item_id = v_occ.item_id;
  if not found then
    raise exception 'recount_item_not_in_count' using errcode = 'P0001', hint = 'recount_item_not_in_count';
  end if;
  if v_rechecks is not true then
    raise exception 'recount_line_already_counted' using errcode = 'P0001', hint = 'recount_line_already_counted';
  end if;

  if v_occ.recount_cycle_count_id = p_cycle_count_id then
    return false;
  end if;

  if v_occ.recount_cycle_count_id is not null then
    if exists (
      select 1
        from public.cycle_counts c
        join public.cycle_count_lines l
          on l.cycle_count_id = c.id
         and l.item_id = v_occ.item_id
       where c.id = v_occ.recount_cycle_count_id
         and c.status = 'in_progress'
         and public.cycle_count_line_rechecks(l)) then
      raise exception 'recount_already_linked' using errcode = 'P0001', hint = 'recount_already_linked';
    end if;
    insert into public.exception_occurrence_events
      (organization_id, occurrence_id, kind, cycle_count_id)
    values
      (v_occ.organization_id, v_occ.id, 'recount_closed', v_occ.recount_cycle_count_id);
  end if;

  update public.exception_occurrences
     set recount_cycle_count_id = p_cycle_count_id,
         updated_at             = now()
   where id = v_occ.id;

  insert into public.exception_occurrence_events
    (organization_id, occurrence_id, kind, actor_user_id, cycle_count_id)
  values
    (v_occ.organization_id, v_occ.id, 'recount_linked', v_uid, p_cycle_count_id);

  return true;
end;
$$;

revoke all on function public._exc_link_recount(uuid, uuid) from public, anon;
grant execute on function public._exc_link_recount(uuid, uuid) to authenticated;

comment on function public._exc_link_recount(uuid, uuid) is
  'Links an open, recountable exception occurrence to the in-progress count '
  'that will re-check it, with a recount_linked event (0372). Visible to the '
  'caller or P0002; manager with cycle_counts:assign or 42501; the count must '
  'be in the org, in progress and hold the item on a line that can still '
  're-check it (cycle_count_line_rechecks). No-op (false) when already linked '
  'to it; recount_already_linked when linked to another live recount that can '
  'still re-check the item. Never resolves.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. start_targeted_recount
-- ═══════════════════════════════════════════════════════════════════════════
-- See the header for the locking, the return shape and the refusals.
--
-- Steps:
--   1. floors: signed in; manager, cycle_counts:assign and stock:adjust in
--      p_org (42501 'forbidden').
--   2. arguments: no null elements; at least one occurrence or item; at most
--      200 of each; notes <= 500; key <= 200.
--   3. idempotency (scope targeted_recount): replay (the stored first answer)
--      or refuse, else record the key in progress. A refused call rolls the
--      key back with everything else.
--   4. occurrences (under the org's sync lock) and explicit items, read under
--      the caller's RLS and pinned to p_org: any missing -> P0002. Resolved
--      occurrences are skipped (resolved), other rules (not_recountable).
--   5. the item set: the open, recountable occurrences' items plus the
--      explicit items, at most 200; per-item advisory locks in key order.
--   6. the open counts holding those items, locked FOR SHARE in id order, then
--      each item: not countable (skipped), already in an in-progress count
--      whose line can still re-check it (linked to it; a count an occurrence
--      already points at wins, then the newest), or needs a new count (also
--      when the only open counts holding it counted it before a later posted
--      count: they cannot settle the difference).
--   7. one selection count for the new items through start_cycle_count, with
--      the shared warehouse as its header (null when they span warehouses or
--      have none, as CycleCountsService.start() does). A line count that
--      differs from the items asked for is refused (recount_items_changed).
--   8. each open, recountable occurrence with a countable item is linked
--      (_exc_link_recount): to the count it already points at when that one
--      is live and can still re-check the item, else to its item's open
--      count, else to the new count.
--   9. the key is marked completed with the new count's id and this answer.
create or replace function public.start_targeted_recount(
  p_org             uuid,
  p_occurrence_ids  uuid[] default null,
  p_item_ids        uuid[] default null,
  p_notes           text   default null,
  p_idempotency_key text   default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
set lock_timeout = '5s'
as $$
declare
  c_max_items   constant integer := 200;
  c_recountable constant text[]  := array['count_variance', 'over_reserved'];
  v_key         text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_notes       text := nullif(btrim(coalesce(p_notes, '')), '');
  v_occ_ids     uuid[];
  v_item_in     uuid[];
  v_hash        text;
  v_key_id      uuid;
  v_prev        record;
  v_n           integer;
  v_occ         jsonb := '[]'::jsonb;
  v_items       uuid[];
  v_lock_key    bigint;
  v_plan        jsonb;
  v_new_items   uuid[];
  v_header_wh   uuid;
  v_cc          uuid;
  v_cc_number   bigint;
  v_lines       integer := 0;
  v_targets     jsonb;
  v_t           record;
  v_linked      jsonb;
  v_existing    jsonb;
  v_skipped     jsonb;
  v_result      jsonb;
begin
  -- ── 1. Floors ────────────────────────────────────────────────────────────
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_org is null then
    raise exception 'invalid_argument' using errcode = '22023', hint = 'invalid_argument';
  end if;
  if not public.has_org_role(p_org, 'manager')
     or not public.has_permission(p_org, 'cycle_counts:assign')
     or not public.has_permission(p_org, 'stock:adjust') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- ── 2. Arguments ─────────────────────────────────────────────────────────
  if array_position(p_occurrence_ids, null) is not null
     or array_position(p_item_ids, null) is not null then
    raise exception 'invalid_argument' using errcode = '22023', hint = 'invalid_argument';
  end if;
  v_occ_ids := array(select distinct x from unnest(coalesce(p_occurrence_ids, '{}'::uuid[])) x order by x);
  v_item_in := array(select distinct x from unnest(coalesce(p_item_ids, '{}'::uuid[])) x order by x);
  if cardinality(v_occ_ids) = 0 and cardinality(v_item_in) = 0 then
    raise exception 'recount_nothing_selected' using errcode = '22023', hint = 'recount_nothing_selected';
  end if;
  if cardinality(v_occ_ids) > c_max_items or cardinality(v_item_in) > c_max_items then
    raise exception 'recount_too_many_items' using errcode = '22023', hint = 'recount_too_many_items';
  end if;
  if char_length(v_notes) > 500 then
    raise exception 'notes_too_long' using errcode = '22023', hint = 'notes_too_long';
  end if;
  if char_length(v_key) > 200 then
    raise exception 'idempotency_key_too_long' using errcode = '22023', hint = 'idempotency_key_too_long';
  end if;

  -- ── 3. Idempotency (0347 pattern, scope targeted_recount) ────────────────
  -- ON CONFLICT DO NOTHING waits for a concurrent holder of the same key to
  -- finish; afterwards its committed row is read (a new statement, a new
  -- snapshot). A committed key is always 'completed': the key row and the
  -- count commit or roll back together.
  if v_key is not null then
    v_hash := md5('targeted_recount|o:' || array_to_string(v_occ_ids, ',')
                  || '|i:' || array_to_string(v_item_in, ','));
    insert into public.idempotency_keys as k
      (organization_id, scope, key, request_hash, status, resource_type)
    values
      (p_org, 'targeted_recount', v_key, v_hash, 'in_progress', 'cycle_count')
    on conflict (organization_id, scope, key) do nothing
    returning k.id into v_key_id;

    if v_key_id is null then
      select k.request_hash, k.status, k.resource_id, k.response into v_prev
        from public.idempotency_keys k
       where k.organization_id = p_org
         and k.scope = 'targeted_recount'
         and k.key = v_key;
      if not found
         or v_prev.request_hash is distinct from v_hash
         or v_prev.status is distinct from 'completed' then
        raise exception 'idempotency_conflict' using errcode = 'P0001', hint = 'idempotency_conflict';
      end if;
      -- The first answer, as it was: the same count, links and skips. The
      -- count and its number come from the key row itself (resource_id is
      -- what the key stands for). A key stored without an answer (none is
      -- written without one) answers with the count alone.
      return coalesce(
               case when jsonb_typeof(v_prev.response) = 'object' then v_prev.response end,
               jsonb_build_object('lineCount', null, 'linked', '[]'::jsonb,
                                  'linkedExisting', '[]'::jsonb, 'skipped', '[]'::jsonb))
             || jsonb_build_object(
                  'cycleCountId', v_prev.resource_id,
                  'countNumber',  (select c.count_number from public.cycle_counts c where c.id = v_prev.resource_id),
                  'created',      false,
                  'replay',       true);
    end if;
  end if;

  -- ── 4. Occurrences and explicit items, under the caller's RLS ────────────
  if cardinality(v_occ_ids) > 0 then
    -- Same key as exceptions_sync: no sync runs while these rows are read and
    -- linked (see the header: row-lock order, and no resolve in between).
    perform pg_advisory_xact_lock(hashtextextended('exc_sync:' || p_org::text, 0));

    select coalesce(jsonb_agg(jsonb_build_object(
             'id',      o.id,
             'itemId',  o.item_id,
             'rule',    o.rule,
             'open',    o.resolved_at is null,
             'pointer', o.recount_cycle_count_id) order by o.id), '[]'::jsonb),
           count(*)
      into v_occ, v_n
      from public.exception_occurrences o
     where o.id = any (v_occ_ids)
       and o.organization_id = p_org;
    if v_n <> cardinality(v_occ_ids) then
      raise exception 'occurrence_not_found' using errcode = 'P0002';
    end if;
  end if;

  if cardinality(v_item_in) > 0 then
    select count(*) into v_n
      from public.inventory_items i
     where i.id = any (v_item_in)
       and i.organization_id = p_org;
    if v_n <> cardinality(v_item_in) then
      raise exception 'item_not_found' using errcode = 'P0002';
    end if;
  end if;

  -- ── 5. The item set, capped, and one advisory lock per item ──────────────
  v_items := array(
    select s.x
      from (select (e->>'itemId')::uuid as x
              from jsonb_array_elements(v_occ) e
             where (e->>'open')::boolean
               and (e->>'rule') = any (c_recountable)
            union
            select unnest(v_item_in)) s
     order by s.x);
  if cardinality(v_items) > c_max_items then
    raise exception 'recount_too_many_items' using errcode = '22023', hint = 'recount_too_many_items';
  end if;

  -- Sorted by the lock key itself: every caller takes any two keys in the
  -- same order, so two starts never wait on each other crosswise.
  for v_lock_key in
    select distinct hashtextextended('sp:recount:' || x::text, 0) as k
      from unnest(v_items) x
     order by k
  loop
    perform pg_advisory_xact_lock(v_lock_key);
  end loop;

  -- ── 6. Classify, against a stable set of open counts ─────────────────────
  perform 1
     from public.cycle_counts c
    where c.organization_id = p_org
      and c.status = 'in_progress'
      and exists (select 1 from public.cycle_count_lines l
                   where l.cycle_count_id = c.id
                     and l.item_id = any (v_items))
    order by c.id
      for share of c;

  with it as (
    select i.id,
           i.warehouse_id,
           -- start_cycle_count's own predicate (0369, D8).
           (i.deleted_at is null and i.status = 'active' and not i.is_rental and not i.is_bundle) as countable
      from public.inventory_items i
     where i.id = any (v_items)
  ),
  ptr as (
    select distinct (e->>'pointer')::uuid as cc_id, (e->>'itemId')::uuid as item_id
      from jsonb_array_elements(v_occ) e
     where e->>'pointer' is not null
  ),
  -- An open count counts as "already counting" the item only when its line
  -- can still re-check it: uncounted, or counted no earlier than every posted
  -- count of the item. A line counted before the difference was found would
  -- post nothing (or be refused as superseded) and leave the exception open.
  ex as (
    select distinct on (l.item_id) l.item_id, c.id as cc_id
      from public.cycle_count_lines l
      join public.cycle_counts c on c.id = l.cycle_count_id
     where l.item_id = any (v_items)
       and c.organization_id = p_org
       and c.status = 'in_progress'
       and public.cycle_count_line_rechecks(l)
     order by l.item_id,
              exists (select 1 from ptr where ptr.cc_id = c.id and ptr.item_id = l.item_id) desc,
              c.started_at desc,
              c.id desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'itemId',      it.id,
           'warehouseId', it.warehouse_id,
           'countable',   it.countable,
           'existing',    case when it.countable then ex.cc_id end) order by it.id), '[]'::jsonb)
    into v_plan
    from it
    left join ex on ex.item_id = it.id;

  -- ── 7. One new count for the items no open count holds ───────────────────
  v_new_items := array(
    select (e->>'itemId')::uuid
      from jsonb_array_elements(v_plan) e
     where (e->>'countable')::boolean
       and e->>'existing' is null
     order by 1);

  if cardinality(v_new_items) > 0 then
    select case when count(*) filter (where s.wh is null) = 0 and count(distinct s.wh) = 1
                then (array_agg(s.wh))[1] end
      into v_header_wh
      from (select (e->>'warehouseId')::uuid as wh
              from jsonb_array_elements(v_plan) e
             where (e->>'itemId')::uuid = any (v_new_items)) s;

    select s.cycle_count_id, s.line_count
      into v_cc, v_lines
      from public.start_cycle_count(p_org, 'selection', v_header_wh, null, v_new_items, v_notes) s;

    if v_cc is null or v_lines is distinct from cardinality(v_new_items) then
      raise exception 'recount_items_changed: % of % items could be counted',
        coalesce(v_lines, 0), cardinality(v_new_items)
        using errcode = 'P0001', hint = 'recount_items_changed';
    end if;

    select c.count_number into v_cc_number
      from public.cycle_counts c
     where c.id = v_cc;
  end if;

  -- ── 8. Link the occurrences ──────────────────────────────────────────────
  select coalesce(jsonb_agg(jsonb_build_object(
           'occurrenceId', o.occ_id,
           'itemId',       o.item_id,
           'target', case
             when not pl.countable then null
             when o.pointer is not null and exists (
                    select 1
                      from public.cycle_counts c
                      join public.cycle_count_lines l
                        on l.cycle_count_id = c.id and l.item_id = o.item_id
                     where c.id = o.pointer
                       and c.organization_id = p_org
                       and c.status = 'in_progress'
                       and public.cycle_count_line_rechecks(l))
               then o.pointer
             else coalesce(pl.existing, v_cc)
           end) order by o.occ_id), '[]'::jsonb)
    into v_targets
    from (select (e->>'id')::uuid as occ_id,
                 (e->>'itemId')::uuid as item_id,
                 (e->>'pointer')::uuid as pointer
            from jsonb_array_elements(v_occ) e
           where (e->>'open')::boolean
             and (e->>'rule') = any (c_recountable)) o
    join (select (e->>'itemId')::uuid as item_id,
                 (e->>'countable')::boolean as countable,
                 (e->>'existing')::uuid as existing
            from jsonb_array_elements(v_plan) e) pl
      on pl.item_id = o.item_id;

  for v_t in
    select (e->>'occurrenceId')::uuid as occ_id, (e->>'target')::uuid as target
      from jsonb_array_elements(v_targets) e
     where e->>'target' is not null
     order by 1
  loop
    perform public._exc_link_recount(v_t.occ_id, v_t.target);
  end loop;

  -- ── Result ───────────────────────────────────────────────────────────────
  select coalesce(jsonb_agg(e->'occurrenceId' order by e->>'occurrenceId'), '[]'::jsonb)
    into v_linked
    from jsonb_array_elements(v_targets) e
   where v_cc is not null
     and (e->>'target')::uuid = v_cc;

  with occ_t as (
    select (e->>'target')::uuid as cc_id, (e->>'itemId')::uuid as item_id, (e->>'occurrenceId')::uuid as occ_id
      from jsonb_array_elements(v_targets) e
     where e->>'target' is not null
       and (v_cc is null or (e->>'target')::uuid <> v_cc)
  ),
  item_t as (
    select (e->>'existing')::uuid as cc_id, (e->>'itemId')::uuid as item_id, null::uuid as occ_id
      from jsonb_array_elements(v_plan) e
     where e->>'existing' is not null
  ),
  g as (
    select p.cc_id,
           jsonb_agg(distinct p.item_id) as item_ids,
           coalesce(jsonb_agg(distinct p.occ_id) filter (where p.occ_id is not null), '[]'::jsonb) as occ_ids
      from (select * from occ_t union all select * from item_t) p
     group by p.cc_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'cycleCountId',  c.id,
           'countNumber',   c.count_number,
           'assignedTo',    c.assigned_to,
           'startedAt',     c.started_at,
           'itemIds',       g.item_ids,
           'occurrenceIds', g.occ_ids) order by c.count_number), '[]'::jsonb)
    into v_existing
    from g
    join public.cycle_counts c on c.id = g.cc_id;

  with occ as (
    select (e->>'id')::uuid as occ_id,
           (e->>'itemId')::uuid as item_id,
           e->>'rule' as rule,
           (e->>'open')::boolean as is_open
      from jsonb_array_elements(v_occ) e
  ),
  pl as (
    select (e->>'itemId')::uuid as item_id, (e->>'countable')::boolean as countable
      from jsonb_array_elements(v_plan) e
  ),
  s as (
    select o.occ_id, o.item_id,
           case when not o.is_open then 'resolved'
                when o.rule <> all (c_recountable) then 'not_recountable'
                when not pl.countable then 'not_countable'
           end as reason
      from occ o
      left join pl on pl.item_id = o.item_id
    union all
    select null::uuid, pl.item_id, 'not_countable'
      from pl
     where not pl.countable
       and pl.item_id = any (v_item_in)
       and not exists (select 1 from occ o
                        where o.item_id = pl.item_id
                          and o.is_open
                          and o.rule = any (c_recountable))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'occurrenceId', s.occ_id,
           'itemId',       s.item_id,
           'reason',       s.reason) order by s.reason, s.item_id, s.occ_id), '[]'::jsonb)
    into v_skipped
    from s
   where s.reason is not null;

  v_result := jsonb_build_object(
    'cycleCountId',   v_cc,
    'countNumber',    v_cc_number,
    'lineCount',      v_lines,
    'created',        v_cc is not null,
    'replay',         false,
    'linked',         v_linked,
    'linkedExisting', v_existing,
    'skipped',        v_skipped);

  -- ── 9. The key answers with this call's answer from now on ───────────────
  if v_key is not null then
    update public.idempotency_keys
       set status      = 'completed',
           resource_id = v_cc,
           response    = v_result,
           updated_at  = now()
     where organization_id = p_org
       and scope = 'targeted_recount'
       and key = v_key;
    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception 'targeted_recount_internal: idempotency key not recorded'
        using errcode = 'P0001', hint = 'targeted_recount_internal';
    end if;
  end if;

  return v_result;
end;
$$;

revoke all on function public.start_targeted_recount(uuid, uuid[], uuid[], text, text) from public, anon;
grant execute on function public.start_targeted_recount(uuid, uuid[], uuid[], text, text) to authenticated;

comment on function public.start_targeted_recount(uuid, uuid[], uuid[], text, text) is
  'Starts a targeted recount (0372): one selection cycle count (via '
  'start_cycle_count) for the items of the named open count_variance / '
  'over_reserved occurrences plus explicit items (at most 200), linking each '
  'occurrence to it; items already in an in-progress count are linked to that '
  'count instead. Manager with cycle_counts:assign and stock:adjust. '
  'Idempotent on p_idempotency_key (scope targeted_recount); per-item advisory '
  'locks. SECURITY INVOKER. Returns {cycleCountId, countNumber, lineCount, '
  'created, replay, linked, linkedExisting, skipped}.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. exceptions_sync, replaced (0370's body with two changes in step 5)
-- ═══════════════════════════════════════════════════════════════════════════
-- Same signature, grants, payload and answer as 0370 (the deployed cron and
-- the after-post sync call it unchanged). Step 5 now:
--   5a. collects the rows it will resolve (complete rule, absent, not held:
--       exactly 0370's test);
--   5b. closes the recount pointer of each of those rows whose count is over,
--       with the system recount_closed event, whatever the count's completion
--       time (step 3 closes only counts completed at or before
--       p_evaluated_at). The timeline then always reads recount_closed before
--       resolved, even when the evaluation saw a count the step-3 bound did
--       not (the evaluator now reads counts as of p_evaluated_at, so this is
--       the backstop). recountsClosed counts both steps;
--   5c. resolves them. An open count_variance whose item can no longer be
--       counted (discontinued, rental equipment, a kit) resolves as
--       subject_gone, like a deleted or archived item: the rule dropped it
--       because a count cannot include it, not because a count matched the
--       book. Other rules keep 0370's reasons (a discontinued item's holding
--       condition ending is still "cleared").
create or replace function public.exceptions_sync(
  p_org               uuid,
  p_evaluated_at      timestamptz,
  p_complete_rules    text[],
  p_failed_rules      text[],
  p_truncated_rules   text[],
  p_present           jsonb,
  p_hold              jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
set lock_timeout = '5s'
as $$
declare
  c_rules   constant text[] := array['orphaned_stock', 'over_reserved', 'stale_staging',
                                     'long_unplaced', 'label_mismatch', 'count_variance'];
  c_holding constant text[] := array['orphaned_stock', 'stale_staging', 'long_unplaced'];
  c_uuid    constant text   := '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$';
  -- The largest facts object a row may hold (exc_occ_facts_shape).
  c_facts_max constant integer := 16384;
  v_present_in  jsonb := coalesce(p_present, '[]'::jsonb);
  v_hold_in     jsonb := coalesce(p_hold, '[]'::jsonb);
  v_complete_in text[] := coalesce(p_complete_rules, '{}');
  v_failed      text[] := coalesce(p_failed_rules, '{}');
  v_truncated   text[] := coalesce(p_truncated_rules, '{}');
  v_complete    text[];
  v_last        timestamptz;
  v_present     jsonb;
  v_hold        jsonb;
  v_dropped     integer := 0;
  v_dropped_h   integer := 0;
  v_omitted     integer := 0;
  v_new         integer;
  v_top         bigint;
  v_closed      integer := 0;
  v_seen        integer := 0;
  v_raised      integer := 0;
  v_resolved    integer := 0;
  -- 0372: the rows step 5 resolves, and pointers closed there.
  v_gone        uuid[];
  v_closed_late integer := 0;
begin
  -- EXECUTE is granted to service_role only; this states the same rule where
  -- a future grant mistake would meet it.
  if current_user in ('authenticated', 'anon') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- ── Arguments ────────────────────────────────────────────────────────────
  if p_org is null or p_evaluated_at is null then
    raise exception 'exceptions_sync_bad_payload: organization and evaluation time are required'
      using errcode = 'P0001', hint = 'exceptions_sync_bad_payload';
  end if;
  -- A clock far ahead would pin last_evaluated_at in the future and every
  -- later (correct) evaluation would be skipped as "older".
  if p_evaluated_at > now() + interval '5 minutes' then
    raise exception 'exceptions_sync_evaluated_at_in_future'
      using errcode = 'P0001', hint = 'exceptions_sync_evaluated_at_in_future';
  end if;
  if not (v_complete_in <@ c_rules and v_failed <@ c_rules and v_truncated <@ c_rules)
     or array_position(v_complete_in, null) is not null
     or array_position(v_failed, null) is not null
     or array_position(v_truncated, null) is not null then
    raise exception 'exceptions_sync_bad_payload: unknown rule name'
      using errcode = 'P0001', hint = 'exceptions_sync_bad_payload';
  end if;
  if jsonb_typeof(v_present_in) <> 'array' or jsonb_typeof(v_hold_in) <> 'array' then
    raise exception 'exceptions_sync_bad_payload: present and hold must be arrays'
      using errcode = 'P0001', hint = 'exceptions_sync_bad_payload';
  end if;
  if exists (
    select 1
      from (select e, true as is_present from jsonb_array_elements(v_present_in) e
            union all
            select e, false from jsonb_array_elements(v_hold_in) e) x
     where jsonb_typeof(x.e) <> 'object'
        or coalesce(x.e->>'rule', '') <> all (c_rules)
        or coalesce(x.e->>'itemId', '') !~ c_uuid
        or coalesce(jsonb_typeof(x.e->'locationId'), 'null') not in ('string', 'null')
        or (jsonb_typeof(x.e->'locationId') = 'string' and (x.e->>'locationId') !~ c_uuid)
        or ((x.e->>'rule') = any (c_holding)) <> ((x.e->>'locationId') is not null)
        or (x.is_present and coalesce(jsonb_typeof(x.e->'facts'), 'null') not in ('object', 'null'))
        or (x.is_present and coalesce(jsonb_typeof(x.e->'conditionSince'), 'null') not in ('string', 'null'))
  ) then
    raise exception 'exceptions_sync_bad_payload: malformed present or hold entry'
      using errcode = 'P0001', hint = 'exceptions_sync_bad_payload';
  end if;
  if not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'exceptions_sync_unknown_org'
      using errcode = 'P0001', hint = 'exceptions_sync_unknown_org';
  end if;

  -- A rule is vouched for only when its read was complete: listed complete
  -- and neither failed nor truncated.
  select coalesce(array_agg(distinct r order by r), '{}') into v_complete
    from unnest(v_complete_in) r
   where r <> all (v_failed) and r <> all (v_truncated);

  -- ── 1. One sync per org at a time; evaluations apply in order ────────────
  perform pg_advisory_xact_lock(hashtextextended('exc_sync:' || p_org::text, 0));

  select s.last_evaluated_at into v_last
    from public.exception_sync_state s
   where s.organization_id = p_org;
  if v_last is not null and p_evaluated_at <= v_last then
    return jsonb_build_object('skipped', true, 'lastEvaluatedAt', v_last);
  end if;

  -- ── 2. Normalise: org-owned ids only, one entry per identity ─────────────
  -- An entry whose item or location is not in p_org is dropped and counted;
  -- the store never holds a cross-org reference. The first entry for an
  -- identity wins; entries keep the evaluator's order (it numbers rows).
  --
  -- A facts object larger than a row may hold is replaced by an empty one
  -- and counted (factsOmitted). The evaluator clips every name it copies, so
  -- this is a backstop, but a necessary one: item names, SKUs and labels have
  -- no length limit in the database, and one oversized facts object would
  -- otherwise fail the whole sync with 23514, so no rule would open or
  -- resolve anything for the org until someone found that item. The row
  -- itself is still raised, seen and resolved; only its stored words are
  -- dropped (describeOccurrence renders an empty object, and the page shows
  -- the item's live name).
  with raw0 as (
    select x.e->>'rule' as rule,
           (x.e->>'itemId')::uuid as item_id,
           (x.e->>'locationId')::uuid as location_id,
           coalesce(nullif(x.e->'facts', 'null'::jsonb), '{}'::jsonb) as facts,
           (x.e->>'conditionSince')::timestamptz as condition_since,
           x.ord
      from jsonb_array_elements(v_present_in) with ordinality as x(e, ord)
  ),
  raw as (
    select r.rule, r.item_id, r.location_id,
           case when octet_length(r.facts::text) <= c_facts_max then r.facts else '{}'::jsonb end as facts,
           octet_length(r.facts::text) > c_facts_max as facts_omitted,
           r.condition_since, r.ord
      from raw0 r
  ),
  kept as (
    select r.*,
           case when r.location_id is not null then l.warehouse_id else i.warehouse_id end as warehouse_id
      from raw r
      join public.inventory_items i on i.id = r.item_id and i.organization_id = p_org
      left join public.locations l on l.id = r.location_id
     where r.location_id is null or l.organization_id = p_org
  ),
  one as (
    select distinct on (k.rule, k.item_id, k.location_id) k.*
      from kept k
     order by k.rule, k.item_id, k.location_id, k.ord
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'rule', one.rule, 'item_id', one.item_id, 'location_id', one.location_id,
           'warehouse_id', one.warehouse_id, 'facts', one.facts,
           'condition_since', one.condition_since, 'ord', one.ord) order by one.ord), '[]'::jsonb),
         (select count(*) from raw) - (select count(*) from kept),
         count(*) filter (where one.facts_omitted)
    into v_present, v_dropped, v_omitted
    from one;

  with raw as (
    select x.e->>'rule' as rule,
           (x.e->>'itemId')::uuid as item_id,
           (x.e->>'locationId')::uuid as location_id
      from jsonb_array_elements(v_hold_in) as x(e)
  ),
  kept as (
    select r.*
      from raw r
      join public.inventory_items i on i.id = r.item_id and i.organization_id = p_org
      left join public.locations l on l.id = r.location_id
     where r.location_id is null or l.organization_id = p_org
  )
  select coalesce(jsonb_agg(distinct jsonb_build_object(
           'rule', kept.rule, 'item_id', kept.item_id, 'location_id', kept.location_id)), '[]'::jsonb),
         (select count(*) from raw) - (select count(*) from kept)
    into v_hold, v_dropped_h
    from kept;

  -- ── 3. Recount pointers: close the ones whose count is over ──────────────
  -- Runs before resolving so the timeline reads recount_closed, then
  -- resolved. The pointer is cleared in the same UPDATE that reads it, so a
  -- recount linked concurrently (a different count id) is left alone.
  --
  -- Only a count that ended AT OR BEFORE this evaluation is closed. The
  -- evaluation's reads started at p_evaluated_at, so a count posted after
  -- that instant is not in what it saw: closing its pointer would write
  -- "recount closed" before any check of that count ran, and would drop the
  -- occurrence from "Re-checking" back to Open until the next sync. That
  -- pointer stays for the sync that saw the count (the post's own follow-up).
  with closed as (
    update public.exception_occurrences o
       set recount_cycle_count_id = null,
           updated_at = now()
      from public.cycle_counts c
     where o.organization_id = p_org
       and o.recount_cycle_count_id = c.id
       and c.status <> 'in_progress'
       and coalesce(c.completed_at, c.canceled_at, '-infinity'::timestamptz) <= p_evaluated_at
    returning o.id, o.organization_id, c.id as cycle_count_id
  )
  insert into public.exception_occurrence_events (organization_id, occurrence_id, kind, cycle_count_id)
  select closed.organization_id, closed.id, 'recount_closed', closed.cycle_count_id
    from closed;
  get diagnostics v_closed = row_count;

  -- ── 4a. Present, already open: seen again ────────────────────────────────
  -- No event. Facts, the scope stamp and condition_since change only when
  -- they differ (updated_at moves only then).
  with p as (
    select * from jsonb_to_recordset(v_present) as x(
      rule text, item_id uuid, location_id uuid, warehouse_id uuid,
      facts jsonb, condition_since timestamptz, ord bigint)
  )
  update public.exception_occurrences o
     set last_seen_at    = greatest(o.last_seen_at, p_evaluated_at),
         facts           = case when o.facts is distinct from p.facts then p.facts else o.facts end,
         warehouse_id    = case when o.warehouse_id is distinct from p.warehouse_id then p.warehouse_id else o.warehouse_id end,
         condition_since = case when o.condition_since is distinct from p.condition_since then p.condition_since else o.condition_since end,
         updated_at      = case when (o.facts, o.warehouse_id, o.condition_since)
                                     is distinct from (p.facts, p.warehouse_id, p.condition_since)
                                then now() else o.updated_at end
    from p
   where o.organization_id = p_org
     and o.resolved_at is null
     and o.rule = p.rule
     and o.item_id = p.item_id
     and o.location_id is not distinct from p.location_id;
  get diagnostics v_seen = row_count;

  -- ── 4b. Present, not open: raise a new, numbered occurrence ──────────────
  select count(*) into v_new
    from jsonb_to_recordset(v_present) as p(rule text, item_id uuid, location_id uuid)
   where not exists (
     select 1 from public.exception_occurrences o
      where o.organization_id = p_org
        and o.resolved_at is null
        and o.rule = p.rule
        and o.item_id = p.item_id
        and o.location_id is not distinct from p.location_id);

  if v_new > 0 then
    -- Take the block of numbers in one step. The counter only ever goes up
    -- (never below the org's highest number), so a number is never reused.
    insert into public.exception_occurrence_counters as c (organization_id, last_number)
    values (
      p_org,
      coalesce((select max(o.occurrence_number) from public.exception_occurrences o
                 where o.organization_id = p_org), 0) + v_new)
    on conflict (organization_id) do update
      set last_number = greatest(
                          c.last_number,
                          coalesce((select max(o.occurrence_number) from public.exception_occurrences o
                                     where o.organization_id = p_org), 0)) + v_new,
          updated_at  = now()
    returning c.last_number into v_top;

    with p as (
      select * from jsonb_to_recordset(v_present) as x(
        rule text, item_id uuid, location_id uuid, warehouse_id uuid,
        facts jsonb, condition_since timestamptz, ord bigint)
    ),
    fresh as (
      select p.*, row_number() over (order by p.ord) as rn
        from p
       where not exists (
         select 1 from public.exception_occurrences o
          where o.organization_id = p_org
            and o.resolved_at is null
            and o.rule = p.rule
            and o.item_id = p.item_id
            and o.location_id is not distinct from p.location_id)
    ),
    ins as (
      insert into public.exception_occurrences (
        organization_id, occurrence_number, rule, item_id, location_id, warehouse_id,
        facts, condition_since, first_seen_at, last_seen_at,
        previous_occurrence_id, recurrence_index)
      select p_org, v_top - v_new + f.rn, f.rule, f.item_id, f.location_id, f.warehouse_id,
             f.facts, f.condition_since, p_evaluated_at, p_evaluated_at,
             prev.id, coalesce(prev.recurrence_index + 1, 0)
        from fresh f
        left join lateral (
          -- The latest earlier occurrence of the same identity (all earlier
          -- ones are resolved: only one can be open, and it is not).
          select o.id, o.recurrence_index
            from public.exception_occurrences o
           where o.organization_id = p_org
             and o.rule = f.rule
             and o.item_id = f.item_id
             and o.location_id is not distinct from f.location_id
             and o.resolved_at is not null
           order by o.occurrence_number desc
           limit 1
        ) prev on true
      returning id, organization_id
    )
    insert into public.exception_occurrence_events (organization_id, occurrence_id, kind)
    select ins.organization_id, ins.id, 'raised' from ins;
    get diagnostics v_raised = row_count;

    if v_raised <> v_new then
      raise exception 'exceptions_sync_internal: raised % of % new occurrences', v_raised, v_new
        using errcode = 'P0001', hint = 'exceptions_sync_internal';
    end if;
  end if;

  -- ── 5. Resolve: complete rule, absent, not held ──────────────────────────
  -- 5a. The rows this evaluation resolves.
  with p as (
    select * from jsonb_to_recordset(v_present) as x(rule text, item_id uuid, location_id uuid)
  ),
  h as (
    select * from jsonb_to_recordset(v_hold) as x(rule text, item_id uuid, location_id uuid)
  )
  select coalesce(array_agg(o.id order by o.id), '{}')
    into v_gone
    from public.exception_occurrences o
   where o.organization_id = p_org
     and o.resolved_at is null
     and o.rule = any (v_complete)
     and not exists (
       select 1 from p
        where p.rule = o.rule and p.item_id = o.item_id
          and p.location_id is not distinct from o.location_id)
     and not exists (
       select 1 from h
        where h.rule = o.rule and h.item_id = o.item_id
          and h.location_id is not distinct from o.location_id);

  -- 5b. (0372) Close the recount pointer of each row about to resolve whose
  -- count is over, whatever its completion time, so its timeline reads
  -- recount_closed, then resolved. Step 3 leaves a pointer open while its
  -- count completed after p_evaluated_at (no check had seen it); a row that
  -- resolves now has no later check to wait for. A count still in progress
  -- keeps its pointer: it closes when that count does.
  with closed as (
    update public.exception_occurrences o
       set recount_cycle_count_id = null,
           updated_at = now()
      from public.cycle_counts c
     where o.id = any (v_gone)
       and o.organization_id = p_org
       and o.recount_cycle_count_id = c.id
       and c.status <> 'in_progress'
    returning o.id, o.organization_id, c.id as cycle_count_id
  )
  insert into public.exception_occurrence_events (organization_id, occurrence_id, kind, cycle_count_id)
  select closed.organization_id, closed.id, 'recount_closed', closed.cycle_count_id
    from closed;
  get diagnostics v_closed_late = row_count;
  v_closed := v_closed + v_closed_late;

  -- 5c. Resolve them, with the reason.
  with p as (
    select * from jsonb_to_recordset(v_present) as x(rule text, item_id uuid, location_id uuid)
  ),
  gone as (
    update public.exception_occurrences o
       set resolved_at     = p_evaluated_at,
           resolved_reason = case
             -- Deleted or ARCHIVED. A discontinued item still exists, can
             -- hold stock and is evaluated like any other by the holding and
             -- reservation rules, so its condition ending means it cleared.
             when i.deleted_at is not null or i.status = 'archived' then 'subject_gone'
             -- (0372) count_variance is judged only for items a count can
             -- include (start_cycle_count's predicate). An item that can no
             -- longer be counted (discontinued, rental equipment, a kit)
             -- drops out of the evaluation although no count matched its
             -- book: that is not "cleared".
             when o.rule = 'count_variance'
                  and (i.status <> 'active' or i.is_rental or i.is_bundle) then 'subject_gone'
             when o.location_id is not null and exists (
                    select 1 from p
                     where p.item_id = o.item_id
                       and p.location_id = o.location_id
                       and p.rule <> o.rule
                       and p.rule = any (c_holding)) then 'reclassified'
             else 'cleared'
           end,
           updated_at      = now()
      from public.inventory_items i
     where i.id = o.item_id
       and o.id = any (v_gone)
       and o.organization_id = p_org
       and o.resolved_at is null
    returning o.id, o.organization_id
  )
  insert into public.exception_occurrence_events (organization_id, occurrence_id, kind)
  select gone.organization_id, gone.id, 'resolved' from gone;
  get diagnostics v_resolved = row_count;

  -- ── 6. Sync state ────────────────────────────────────────────────────────
  insert into public.exception_sync_state as s (
    organization_id, tracking_started_at, last_evaluated_at, last_synced_at,
    complete_rules, failed_rules, truncated_rules)
  values (
    p_org, p_evaluated_at, p_evaluated_at, clock_timestamp(),
    v_complete,
    (select coalesce(array_agg(distinct r order by r), '{}') from unnest(v_failed) r),
    (select coalesce(array_agg(distinct r order by r), '{}') from unnest(v_truncated) r))
  on conflict (organization_id) do update
    set last_evaluated_at = excluded.last_evaluated_at,
        last_synced_at    = excluded.last_synced_at,
        complete_rules    = excluded.complete_rules,
        failed_rules      = excluded.failed_rules,
        truncated_rules   = excluded.truncated_rules;

  return jsonb_build_object(
    'skipped',        false,
    'raised',         v_raised,
    'seen',           v_seen,
    'resolved',       v_resolved,
    'recountsClosed', v_closed,
    'dropped',        v_dropped + v_dropped_h,
    'factsOmitted',   v_omitted);
end;
$$;

revoke all on function public.exceptions_sync(uuid, timestamptz, text[], text[], text[], jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.exceptions_sync(uuid, timestamptz, text[], text[], text[], jsonb, jsonb)
  to service_role;

comment on function public.exceptions_sync(uuid, timestamptz, text[], text[], text[], jsonb, jsonb) is
  'Applies one org-wide Exception Center evaluation to the stored lifecycle '
  '(0370, step 5 revised in 0372): closes finished recount pointers, raises '
  'numbered occurrences for new conditions (linking recurrences), refreshes '
  'open ones, and resolves absent ones only for complete rules and never for '
  'held identities, closing a resolving row''s finished recount first. '
  'Per-org advisory lock; an evaluation at or before the last applied one is '
  'skipped. SECURITY INVOKER; EXECUTE to service_role only.';

reset lock_timeout;
