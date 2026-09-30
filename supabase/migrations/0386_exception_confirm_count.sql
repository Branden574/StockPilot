-- 0386_exception_confirm_count.sql
--
-- Count differences, R2: the person who counted, or a manager, can confirm the
-- counted number of a count_variance exception ("Count did not match the
-- stock on record"), which closes it at once, without a second count.
--
-- Owner decision 2026-09-29 ("1 and 2", after EX-000059): the page says
-- plainly what clears a count difference (R1, no database change, shipped in
-- #301), and the person who counted can confirm the counted number and close
-- the exception. The owner accepted that a single mistyped count can then
-- close without a second count. Plan: stockpilot-work/exceptions-confirm/
-- plan.md, revision 2 (written as 0383; this file is that plan's migration
-- under the next free number).
--
-- ── WHAT IT ADDS ───────────────────────────────────────────────────────────
--   1. exception_occurrences gains six nullable columns, the record of a
--      confirm (at most one per occurrence): confirmed_at, confirmed_by,
--      confirmed_cycle_count_id, confirmed_quantity (the line's counted
--      number), confirmed_on_record (the stock on record at the confirm;
--      stored, never sent or shown: while a confirm requires it to equal the
--      counted number it says nothing more) and confirmed_as ('counter' or
--      'manager'). Five CHECKs pair them with each other and with the reason.
--   2. resolved_reason accepts 'confirmed'; the events accept the kind
--      'count_confirmed'. Both CHECKs are replaced (NOT VALID, then
--      VALIDATE): Postgres cannot widen a CHECK in place.
--   3. exc_occ_confirmed_line_uniq: UNIQUE (organization_id, item_id,
--      confirmed_cycle_count_id) where confirmed: one confirmation per count
--      line, and the lookup exceptions_sync's step 2b makes.
--   4. exception_confirm_count(): the confirm itself. SECURITY DEFINER,
--      EXECUTE to authenticated only.
--   5. exceptions_sync v3: the 0372 body plus step 2b (every added line
--      carries the tag -- 0386, and pgTAP proves that removing them gives the
--      0372 text byte for byte). A count_variance entry whose line (the
--      entry's facts.cycleCountId, for its item) was confirmed is SETTLED and
--      moves to hold: it neither opens nor resolves anything. The answer gains
--      one key, settled.
--
-- ── WHO RESOLVES ───────────────────────────────────────────────────────────
-- exceptions_sync resolves when a complete system evaluation no longer finds
-- the condition. exception_confirm_count resolves one count_variance
-- occurrence whose counted number a person with the right to do so
-- confirmed. Nothing else resolves; exception_occurrence_act still never
-- does (its body is unchanged).
--
-- ── WHO MAY CONFIRM (the RPC checks, in this order) ────────────────────────
--   1  signed in                                            42501 not_authenticated
--   2  arguments present; note at most 1,000 characters    22023 invalid_argument | note_too_long
--   3  the row is visible (_exc_occurrence_visible)         P0002
--   4  the act gate against the ITEM'S LIVE warehouse       42501 not_permitted
--      (_exc_occurrence_can_act: stock:adjust and write access for the
--      item's charter, or a manager when the item has no warehouse; not the
--      occurrence's warehouse stamp, which the sync refreshes up to 15
--      minutes late)
--   5  replay: the same person already confirmed this count with this
--      number and this note                                 answers replay: true
--   6  the rule is count_variance                           P0001 not_confirmable
--   7  the row is open                                      P0001 occurrence_resolved
--   8  the count asked for is the facts' count, a completed
--      count with a counted line for the item, and the
--      number asked for is that line's                      P0001 count_changed
--   9  no linked recount in progress whose line can still
--      re-check the item                                    P0001 recount_in_progress
--  10  no other count in progress holds a counted line for
--      the item that can re-check it and differs from its
--      own expected quantity                                P0001 count_in_progress
--  11  that count is still the item's latest count, now     P0001 count_changed
--  12  the item can still be counted                        P0001 not_countable
--  13  the stock on record equals the counted number        P0001 stock_moved
--  14  no occurrence already confirms this (org, item,
--      count)                                               P0001 already_confirmed
--  15  the counter (cycle_count_lines.counted_by) or a
--      manager (has_org_role manager: manager, admin,
--      owner)                                               42501 not_counter
-- The act gate comes first so a viewer never learns more than the page shows;
-- the counter check comes last so someone who did not count reads the real
-- state. core countConfirmGate states the same order, and
-- exception-confirm.fixture.ts holds the two equal (the pgTAP C-matrix).
-- A manager who counted the line is recorded as the counter.
--
-- ── WHAT A CONFIRM WRITES ──────────────────────────────────────────────────
-- The row resolved as 'confirmed' with the six columns; one count_confirmed
-- event (actor = the confirmer, the count, the optional note, and never a
-- client_event_id, so exception_occurrence_act's replay lookup can never
-- mistake it for one of its own); no 'resolved' event (that kind means the
-- system check). A recount pointer still set at that point is over or can no
-- longer re-check the item: it is closed first, with the system
-- recount_closed event, so the timeline reads recount_closed, then
-- count_confirmed. No stock, no count and no ledger row is written.
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────
-- exception_confirm_count takes, in order: the org's advisory lock
-- exc_sync:<org> (the key and order exceptions_sync and
-- start_targeted_recount use), then the occurrence row FOR UPDATE. After that
-- it only reads (the item, the count lines, _latest_count_lines, other
-- occurrences), then updates the row and inserts events. It takes no item
-- lock and no count lock. Posts, records and ledger writers lock items and
-- counts, never the sync lock or occurrence rows; exception_occurrence_act,
-- evidence and escalation take the occurrence row lock without the advisory
-- lock and never wait on it. So no new lock edge, and no cycle.
-- Step 2b of exceptions_sync runs under the same advisory lock, so a stale
-- evaluation applied after a confirm still sees it.
--
-- ── RETRYABLE SQLSTATES ────────────────────────────────────────────────────
-- Never 40001/40P01 (0367: PostgREST < 16 retries 40001 forever), and never
-- 23505: a unique_violation on the confirm's UPDATE (only reachable if check
-- 14 were bypassed) is answered as P0001 already_confirmed. A lock wait past
-- lock_timeout (5 s, below the API roles' 8 s statement timeout) is 55P03,
-- which the service answers as 409 busy.
--
-- ── DATA SAFETY ────────────────────────────────────────────────────────────
-- Additive only. No existing row is updated or deleted. The only DROP
-- statements are the two CHECKs of item 2, re-added wider in the same ALTER
-- TABLE. The six columns are nullable with no default (a catalog change, no
-- rewrite) and null on every existing row, which every new CHECK accepts.
-- Grants are unchanged: signed-in users keep table-level SELECT only on
-- exception_occurrences (so they read the new columns and write none of
-- them), service_role keeps SELECT, INSERT and UPDATE; exceptions_sync never
-- writes these columns. Proven locally by
-- stockpilot-work/exceptions-confirm/data-safety-0386.sh.
--
-- ── PROD PUSH NOTE ─────────────────────────────────────────────────────────
-- ALTER TABLE takes ACCESS EXCLUSIVE on exception_occurrences (tens of rows)
-- and exception_occurrence_events until the file commits; the two new foreign
-- keys take SHARE ROW EXCLUSIVE on user_profiles and cycle_counts, which
-- blocks writes to them for that fraction of a second. Push outside L4L
-- working hours and not in the minute after a quarter hour (the cron sync).
-- lock_timeout makes the push fail fast instead of queueing behind a long
-- transaction (retry is the remedy). The replaced exceptions_sync keeps its
-- signature, grants and answer keys (plus settled), so the deployed cron keeps
-- working across the push; exception_confirm_count is new, and web builds
-- before this release never call it.

-- PLAIN `set`, not `set local` (0303/0358/0370): the CLI batch is atomic but
-- is not a transaction block. Reset at the end.
set lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. The confirmation columns and their CHECKs
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.exception_occurrences
  add column if not exists confirmed_at             timestamptz,
  add column if not exists confirmed_by             uuid
    constraint exception_occurrences_confirmed_by_fkey
    references public.user_profiles(id) on delete set null,
  add column if not exists confirmed_cycle_count_id uuid
    constraint exception_occurrences_confirmed_cycle_count_id_fkey
    references public.cycle_counts(id) on delete set null,
  add column if not exists confirmed_quantity       numeric(14,4),
  add column if not exists confirmed_on_record      numeric(14,4),
  add column if not exists confirmed_as             text
    constraint exception_occurrences_confirmed_as_check
    check (confirmed_as in ('counter', 'manager')),
  -- A confirmed row carries its confirm time, and only a confirmed row does.
  -- NOT "=": (NULL = true) is NULL, and a CHECK passes on NULL, so the "="
  -- form would let an OPEN row (resolved_reason null) carry a confirm time.
  add constraint exc_occ_confirmed_reason check (
    (resolved_reason is not distinct from 'confirmed') = (confirmed_at is not null)),
  add constraint exc_occ_confirmed_rule check (confirmed_at is null or rule = 'count_variance'),
  add constraint exc_occ_confirmed_shape check (
    confirmed_at is null
    or (confirmed_quantity is not null and confirmed_on_record is not null and confirmed_as is not null)),
  -- The account and the count can later be deleted (ON DELETE SET NULL); a
  -- confirmation without its time cannot exist.
  add constraint exc_occ_confirmed_by_pair check (confirmed_by is null or confirmed_at is not null),
  add constraint exc_occ_confirmed_count_pair check (confirmed_cycle_count_id is null or confirmed_at is not null);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. The reason and the event kind (replaced, then validated)
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.exception_occurrences
  drop constraint exception_occurrences_resolved_reason_check,
  add constraint exception_occurrences_resolved_reason_check check (
    resolved_reason in ('cleared', 'reclassified', 'subject_gone', 'confirmed')) not valid;
alter table public.exception_occurrences
  validate constraint exception_occurrences_resolved_reason_check;

alter table public.exception_occurrence_events
  drop constraint exception_occurrence_events_kind_check,
  add constraint exception_occurrence_events_kind_check check (kind in (
    'raised', 'acknowledged', 'note', 'recount_linked', 'recount_closed', 'resolved',
    'evidence_added', 'evidence_removed', 'escalated', 'count_confirmed')) not valid;
alter table public.exception_occurrence_events
  validate constraint exception_occurrence_events_kind_check;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. One confirmation per count line (and step 2b's lookup)
-- ═══════════════════════════════════════════════════════════════════════════
create unique index if not exists exc_occ_confirmed_line_uniq
  on public.exception_occurrences (organization_id, item_id, confirmed_cycle_count_id)
  where confirmed_cycle_count_id is not null;

comment on index public.exc_occ_confirmed_line_uniq is
  'One count confirmation per (organization, item, count) (0386), and the '
  'settled lookup of exceptions_sync step 2b.';

comment on table public.exception_occurrences is
  'Stored lifecycle of Exception Center conditions (0370). Opened by '
  'exceptions_sync (service_role) and resolved by it when a complete check no '
  'longer finds the condition, or, for one count_variance occurrence, by '
  'exception_confirm_count when a person confirms the counted number (0386). '
  'Acknowledged via exception_occurrence_act, which never resolves. Signed-in '
  'users hold SELECT only, filtered by _exc_occurrence_visible.';
comment on column public.exception_occurrences.confirmed_at is
  'When a person confirmed the counted number and resolved this count_variance '
  'occurrence (exception_confirm_count, 0386); null otherwise. Set exactly when '
  'resolved_reason is confirmed.';
comment on column public.exception_occurrences.confirmed_by is
  'Who confirmed the counted number (0386). Null for any other row, or after the '
  'account was deleted.';
comment on column public.exception_occurrences.confirmed_cycle_count_id is
  'The count whose line was confirmed (0386): with item_id, the key '
  'exceptions_sync step 2b settles on (a confirmed line neither opens nor '
  'resolves anything). Unique per organization and item.';
comment on column public.exception_occurrences.confirmed_quantity is
  'The confirmed line''s counted number (0386).';
comment on column public.exception_occurrences.confirmed_on_record is
  'The stock on record when the count was confirmed (0386). Stored for the '
  'record; not shown (a confirm requires it to equal confirmed_quantity).';
comment on column public.exception_occurrences.confirmed_as is
  'counter: the confirmer recorded the counted line (cycle_count_lines.counted_by); '
  'manager: a manager, admin or owner who did not (0386).';

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. exception_confirm_count
-- ═══════════════════════════════════════════════════════════════════════════
-- p_cycle_count_id and p_counted_quantity are what the person was shown (the
-- countConfirm block); the confirm is refused as count_changed when either no
-- longer describes the row. Returns {occurrenceId, replay, confirmedAs}; the
-- service re-reads the row. See the header for the checks, the locks and the
-- refusals. Every 42501 and P0001 carries its hint: a 42501 WITHOUT a hint can
-- only come from PostgREST after EXECUTE was revoked (the revert kit), which
-- the service answers as "unavailable".
create or replace function public.exception_confirm_count(
  p_id               uuid,
  p_cycle_count_id   uuid,
  p_counted_quantity numeric,
  p_note             text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
set lock_timeout = '5s'
as $$
declare
  c_uuid      constant text := '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$';
  v_uid       uuid := auth.uid();
  v_note      text := nullif(btrim(coalesce(p_note, '')), '');
  v_org       uuid;
  v_occ       public.exception_occurrences%rowtype;
  v_item_wh   uuid;
  v_prev_note text;
  v_facts_cc  text;
  v_counted   numeric;
  v_counted_by uuid;
  v_rc_status text;
  v_rc_rechecks boolean;
  v_other     uuid;
  v_latest_cc uuid;
  v_countable boolean;
  v_on_hand   numeric;
  v_as        text;
  v_closed_at timestamptz;
begin
  -- 1. Signed in.
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501', hint = 'not_authenticated';
  end if;

  -- 2. Arguments.
  if p_id is null or p_cycle_count_id is null or p_counted_quantity is null then
    raise exception 'invalid_argument' using errcode = '22023', hint = 'invalid_argument';
  end if;
  if char_length(v_note) > 1000 then
    raise exception 'note_too_long' using errcode = '22023', hint = 'note_too_long';
  end if;

  -- 3. Visible to the caller, or "not found" (existence is not leaked). Read
  -- without a lock: only the org is needed, to take the org's lock first.
  select o.organization_id into v_org
    from public.exception_occurrences o
   where o.id = p_id
     and public._exc_occurrence_visible(o.organization_id, o.item_id, o.location_id);
  if not found then
    raise exception 'occurrence_not_found' using errcode = 'P0002', hint = 'occurrence_not_found';
  end if;

  -- LOCK ORDER: the org's sync lock (exceptions_sync's key and order),
  -- then the row. A sync that applies an evaluation read before this confirm
  -- waits here, and its step 2b then sees the committed confirmation.
  perform pg_advisory_xact_lock(hashtextextended('exc_sync:' || v_org::text, 0));

  select o.* into v_occ
    from public.exception_occurrences o
   where o.id = p_id
     and o.organization_id = v_org
     and public._exc_occurrence_visible(o.organization_id, o.item_id, o.location_id)
   for update;
  if not found then
    raise exception 'occurrence_not_found' using errcode = 'P0002', hint = 'occurrence_not_found';
  end if;

  -- 4. The act gate, judged against the item's LIVE warehouse. The
  -- occurrence's own warehouse_id is a stamp the sync refreshes, up to 15
  -- minutes after the item moved. No item row lock: a move that commits
  -- after this read is a later change, like any change after the confirm.
  select i.warehouse_id into v_item_wh
    from public.inventory_items i
   where i.id = v_occ.item_id
     and i.organization_id = v_org;
  if not public._exc_occurrence_can_act(v_org, v_item_wh, v_occ.item_id) then
    raise exception 'not_permitted' using errcode = '42501', hint = 'not_permitted';
  end if;

  -- 5. Replay, judged from what is stored (a lost answer resent, or a double
  -- tap): the same person already confirmed this count with this number and
  -- this note. Nothing is written.
  if v_occ.resolved_reason = 'confirmed'
     and v_occ.confirmed_by = v_uid
     and v_occ.confirmed_cycle_count_id = p_cycle_count_id
     and v_occ.confirmed_quantity = p_counted_quantity then
    select e.note into v_prev_note
      from public.exception_occurrence_events e
     where e.organization_id = v_org
       and e.occurrence_id = v_occ.id
       and e.kind = 'count_confirmed'
     order by e.created_at desc, e.id desc
     limit 1;
    if found and v_prev_note is not distinct from v_note then
      return jsonb_build_object('occurrenceId', v_occ.id, 'replay', true, 'confirmedAs', v_occ.confirmed_as);
    end if;
  end if;

  -- 6, 7. A count difference, still open.
  if v_occ.rule <> 'count_variance' then
    raise exception 'not_confirmable' using errcode = 'P0001', hint = 'not_confirmable';
  end if;
  if v_occ.resolved_at is not null then
    raise exception 'occurrence_resolved' using errcode = 'P0001', hint = 'occurrence_resolved';
  end if;

  -- 8. The count and number the person was shown are the row's: the facts
  -- name that count, and it is a completed count with a counted line for the
  -- item holding that number. (One line per item per count: the
  -- cycle_count_lines (cycle_count_id, item_id) key.)
  v_facts_cc := v_occ.facts->>'cycleCountId';
  if v_facts_cc is null or v_facts_cc !~ c_uuid or v_facts_cc::uuid <> p_cycle_count_id then
    raise exception 'count_changed' using errcode = 'P0001', hint = 'count_changed';
  end if;
  select l.counted_quantity, l.counted_by into v_counted, v_counted_by
    from public.cycle_count_lines l
    join public.cycle_counts c on c.id = l.cycle_count_id
   where l.cycle_count_id = p_cycle_count_id
     and l.item_id = v_occ.item_id
     and c.organization_id = v_org
     and c.status = 'completed'
     and l.counted_quantity is not null;
  if not found or v_counted <> p_counted_quantity then
    raise exception 'count_changed' using errcode = 'P0001', hint = 'count_changed';
  end if;

  -- 9. A recount linked to this exception that is in progress and can still
  -- re-check the item settles it: a manager chose a second count. (A manager
  -- can cancel it to allow a confirm.) One that is over, or whose line can no
  -- longer re-check the item, or that no longer holds the item, does not
  -- block; its pointer is closed below.
  if v_occ.recount_cycle_count_id is not null then
    select c.status, public.cycle_count_line_rechecks(l)
      into v_rc_status, v_rc_rechecks
      from public.cycle_counts c
      join public.cycle_count_lines l
        on l.cycle_count_id = c.id
       and l.item_id = v_occ.item_id
     where c.id = v_occ.recount_cycle_count_id
       and c.organization_id = v_org;
    if found and v_rc_status = 'in_progress' and v_rc_rechecks is not false then
      raise exception 'recount_in_progress' using errcode = 'P0001', hint = 'recount_in_progress';
    end if;
  end if;

  -- 10. Another count in progress that has already recorded a different
  -- number for the item, on a line that can re-check it: posting it would
  -- reopen this row with its numbers minutes after a confirm. An uncounted
  -- line does not block (a warehouse-wide count must not freeze every
  -- confirm for its length), and neither does one that matches its own
  -- expected quantity (posting it changes nothing and opens nothing). A null
  -- expected counts as different (caution).
  select c.id into v_other
    from public.cycle_count_lines l
    join public.cycle_counts c on c.id = l.cycle_count_id
   where c.organization_id = v_org
     and c.status = 'in_progress'
     and l.item_id = v_occ.item_id
     and c.id is distinct from v_occ.recount_cycle_count_id
     and l.counted_quantity is not null
     and l.counted_quantity is distinct from l.expected_quantity
     and public.cycle_count_line_rechecks(l) is not false
   order by c.started_at, c.id
   limit 1;
  if found then
    raise exception 'count_in_progress'
      using errcode = 'P0001', hint = 'count_in_progress', detail = 'cycle_count_id=' || v_other;
  end if;

  -- 11. That count is still the item's latest physical count, as of now (a
  -- newer count posted but not yet applied by a sync, including a linked
  -- recount that is "Re-checking"). 12. The item can still be counted
  -- (start_cycle_count's predicate); such a row closes at the next check.
  select l.cycle_count_id, l.item_countable into v_latest_cc, v_countable
    from public._latest_count_lines(v_org, array[v_occ.item_id], null) l;
  if not found or v_latest_cc <> p_cycle_count_id then
    raise exception 'count_changed' using errcode = 'P0001', hint = 'count_changed';
  end if;
  if v_countable is not true then
    raise exception 'not_countable' using errcode = 'P0001', hint = 'not_countable';
  end if;

  -- 13. The stock on record still equals the counted number (owner default:
  -- the confirmer vouches for a number they can still check on the shelf). A
  -- move that nets to zero, such as a put-away, still counts as equal. Read
  -- without a row lock: a movement that commits after this read is a later
  -- recorded movement, like any movement after the confirm.
  select i.quantity_on_hand into v_on_hand
    from public.inventory_items i
   where i.id = v_occ.item_id
     and i.organization_id = v_org;
  if v_on_hand is distinct from v_counted then
    raise exception 'stock_moved'
      using errcode = 'P0001', hint = 'stock_moved', detail = 'on_record=' || coalesce(v_on_hand::text, 'unknown');
  end if;

  -- 14. This count line is not already confirmed on another occurrence of
  -- the item (only reachable if step 2b was bypassed). Race-free under the
  -- org's lock; the UPDATE below also turns the unique index's refusal into
  -- the same answer.
  if exists (
    select 1
      from public.exception_occurrences c
     where c.organization_id = v_org
       and c.item_id = v_occ.item_id
       and c.confirmed_cycle_count_id = p_cycle_count_id) then
    raise exception 'already_confirmed' using errcode = 'P0001', hint = 'already_confirmed';
  end if;

  -- 15. Who: the person who recorded the counted line (the last recorder), or
  -- a manager, admin or owner. A manager who counted it is the counter.
  if v_counted_by = v_uid then
    v_as := 'counter';
  elsif public.has_org_role(v_org, 'manager') then
    v_as := 'manager';
  else
    raise exception 'not_counter' using errcode = '42501', hint = 'not_counter';
  end if;

  -- Then the writes. A recount pointer still set here is over or can no
  -- longer re-check the item (check 9 refused a live one): it is closed with
  -- the same system event the sync writes, before the confirm's own event.
  if v_occ.recount_cycle_count_id is not null then
    insert into public.exception_occurrence_events (organization_id, occurrence_id, kind, cycle_count_id)
    values (v_org, v_occ.id, 'recount_closed', v_occ.recount_cycle_count_id)
    returning created_at into v_closed_at;
  end if;

  -- Resolve, with the record of the confirm.
  begin
    update public.exception_occurrences
       set resolved_at              = now(),
           resolved_reason          = 'confirmed',
           confirmed_at             = now(),
           confirmed_by             = v_uid,
           confirmed_cycle_count_id = p_cycle_count_id,
           confirmed_quantity       = v_counted,
           confirmed_on_record      = v_on_hand,
           confirmed_as             = v_as,
           recount_cycle_count_id   = null,
           updated_at               = now()
     where id = v_occ.id;
  exception when unique_violation then
    raise exception 'already_confirmed' using errcode = 'P0001', hint = 'already_confirmed';
  end;

  -- The one timeline event: never a client_event_id (the act RPC's replay
  -- lookup keys on it), and never a 'resolved' event (the system's words).
  -- Its time is after the recount_closed event's, whatever the clock's
  -- resolution, so the timeline reads recount_closed, then count_confirmed.
  insert into public.exception_occurrence_events
    (organization_id, occurrence_id, kind, actor_user_id, cycle_count_id, note, created_at)
  values
    (v_org, v_occ.id, 'count_confirmed', v_uid, p_cycle_count_id, v_note,
     greatest(clock_timestamp(), v_closed_at + interval '1 microsecond'));

  return jsonb_build_object('occurrenceId', v_occ.id, 'replay', false, 'confirmedAs', v_as);
end;
$$;

revoke all on function public.exception_confirm_count(uuid, uuid, numeric, text) from public, anon, service_role;
grant execute on function public.exception_confirm_count(uuid, uuid, numeric, text) to authenticated;

comment on function public.exception_confirm_count(uuid, uuid, numeric, text) is
  'Confirms the counted number of an open count_variance exception occurrence '
  'and resolves it as confirmed (0386), without a second count. The counter '
  '(cycle_count_lines.counted_by) or a manager who passes the act gate against '
  'the item''s live warehouse, while the count shown is still the item''s latest, '
  'no linked recount or other count in progress is about to settle it, the item '
  'can be counted and the stock on record equals the counted number. Takes the '
  'org''s exc_sync lock, then the row. Writes the confirmed_* columns and one '
  'count_confirmed event; no stock. Replay (same person, count, number and note) '
  'answers replay: true. SECURITY DEFINER; EXECUTE to authenticated only.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. exceptions_sync v3: 0372's body plus step 2b
-- ═══════════════════════════════════════════════════════════════════════════
-- Same signature, grants, lock_timeout, SECURITY INVOKER and answer keys as
-- 0372, plus one key, settled (count_variance entries moved to hold because
-- their line was confirmed). Every added line ends with the tag -- 0386, and
-- nothing else changes: the pgTAP file proves that this body minus its tagged
-- lines is the 0372 body (md5), and lists the tagged lines exactly.
--
-- Step 2b runs after the hold entries are normalised and before step 3. It
-- only reads. A settled entry is added to hold ({rule, item_id, location_id},
-- the shape step 5 reads), so an open row of that identity (which only a
-- bypass of the confirm could leave) is neither refreshed nor resolved, and
-- nothing new is raised for a confirmed line. `dropped` is counted in step 2,
-- before this, so it never counts a settled entry.
--
-- A later count of the item is a new line: it is settled only once it too is
-- confirmed. It opens a new occurrence when its own counted number differs
-- from the stock on record at that count (step 4b links it to the confirmed
-- one as a recurrence), and nothing when it matches.
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
  v_settled     integer := 0;                                                           -- 0386
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
  -- ── 2b. (0386) Settled: a count_variance entry whose line was confirmed ──          -- 0386
  -- The line is the entry's facts.cycleCountId for its item (the evaluator's           -- 0386
  -- latest line). A confirmed line is HELD: it neither opens nor resolves              -- 0386
  -- anything (exception_confirm_count resolved its row). A missing or                  -- 0386
  -- malformed id is NOT settled: it fails toward showing the difference,               -- 0386
  -- never toward hiding it (the CASE keeps the uuid cast behind the pattern            -- 0386
  -- test). Runs under the sync lock exception_confirm_count also takes, so a           -- 0386
  -- stale evaluation applied after a confirm still sees it.                            -- 0386
  with s as (                                                                           -- 0386
    select x.e, x.ord,                                                                  -- 0386
           case                                                                         -- 0386
             when (x.e->>'rule') = 'count_variance'                                     -- 0386
                  and coalesce(x.e->'facts'->>'cycleCountId', '') ~ c_uuid then exists (  -- 0386
               select 1 from public.exception_occurrences c                             -- 0386
                where c.organization_id = p_org                                         -- 0386
                  and c.item_id = (x.e->>'item_id')::uuid                               -- 0386
                  and c.confirmed_cycle_count_id = (x.e->'facts'->>'cycleCountId')::uuid  -- 0386
                  and c.resolved_reason = 'confirmed')                                  -- 0386
             else false                                                                 -- 0386
           end as settled                                                               -- 0386
      from jsonb_array_elements(v_present) with ordinality as x(e, ord)                 -- 0386
  )                                                                                     -- 0386
  select coalesce(jsonb_agg(s.e order by s.ord) filter (where not s.settled), '[]'::jsonb),  -- 0386
         v_hold || coalesce(jsonb_agg(jsonb_build_object(                               -- 0386
           'rule', s.e->>'rule', 'item_id', s.e->'item_id', 'location_id', s.e->'location_id'))  -- 0386
           filter (where s.settled), '[]'::jsonb),                                      -- 0386
         count(*) filter (where s.settled)                                              -- 0386
    into v_present, v_hold, v_settled                                                   -- 0386
    from s;                                                                             -- 0386

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
    'settled',        v_settled,                                                        -- 0386
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
  '(0370, step 5 revised in 0372, step 2b added in 0386): holds count_variance '
  'entries whose count line was confirmed (exception_confirm_count; answer key '
  'settled), closes finished recount pointers, raises numbered occurrences for '
  'new conditions (linking recurrences), refreshes open ones, and resolves '
  'absent ones only for complete rules and never for held identities, closing a '
  'resolving row''s finished recount first. Per-org advisory lock; an '
  'evaluation at or before the last applied one is skipped. SECURITY INVOKER; '
  'EXECUTE to service_role only.';

reset lock_timeout;
