-- 0370_exception_occurrences.sql
--
-- F1-1: the Exception Center keeps a LIFECYCLE for each condition it finds.
--
-- Conditions stay derived. ExceptionsService (TypeScript) is still the only
-- place a rule is evaluated; this migration only stores what the system saw and
-- when: a numbered occurrence (EX-000042) per condition, when it was first and
-- last seen, who acknowledged it, notes, when the system saw it clear, and the
-- chain of earlier occurrences of the same condition (recurrence).
--
-- ── WHAT IT ADDS ───────────────────────────────────────────────────────────
--   1. item_stock_levels.positive_since: the moment a holding last went from
--      empty to stocked. Stale Staging and long Unplaced ages come from it,
--      not from updated_at (a weekly top-up reset updated_at, so a Staging
--      holding topped up every few days never looked old).
--   2. exception_occurrences: one row per occurrence of a condition. Identity
--      is (organization_id, rule, item_id, location_id); at most one OPEN row
--      per identity (exc_occ_one_open, NULLS NOT DISTINCT).
--   3. exception_occurrence_events: the append-only timeline of each
--      occurrence (raised, acknowledged, note, recount_closed, resolved, and
--      the kinds later slices write).
--   4. exception_occurrence_counters: the per-org EX number series (the 0358
--      counter pattern). No API role can read or write it.
--   5. exception_sync_state: one row per org: when tracking began, the last
--      evaluation the store reflects, and which rules were complete, failed or
--      truncated in it (the page's "Checked at" and its banners).
--   6. _exc_occurrence_visible(): THE visibility rule for one row (the RPC
--      re-checks), and the SELECT policy, the same rule written in a form the
--      planner evaluates once per query instead of once per row. A pgTAP
--      test holds the two equal for every reader.
--   7. exceptions_sync(): the only writer that opens or resolves an
--      occurrence. service_role only (the cron and the post/cancel follow-up).
--   8. exception_occurrence_act(): acknowledge / note. The only user write.
--
-- ── WHO RESOLVES ───────────────────────────────────────────────────────────
-- Nobody. Only exceptions_sync sets resolved_at, and only when an org-wide,
-- system-context evaluation says the condition is gone AND that rule's read
-- was complete. A person can acknowledge an occurrence and add notes; nothing a
-- person does marks it resolved. exception_occurrence_act never writes
-- resolved_at or resolved_reason.
--
-- ── WHAT exceptions_sync TRUSTS, AND WHAT IT DOES NOT ──────────────────────
--   * It trusts the evaluation's verdicts: present entries, hold entries and
--     the complete/failed/truncated rule lists.
--   * It does NOT trust ids: an entry whose item or location is not in p_org
--     is dropped (and counted), so a cross-org id can never open a row.
--   * It derives warehouse_id itself (the location's warehouse for a holding
--     rule, the item's otherwise); a warehouseId in the payload is ignored.
--   * A rule resolves only when it is in p_complete_rules and in neither
--     p_failed_rules nor p_truncated_rules. A failed or truncated read proves
--     nothing about absence, so it never clears a row.
--   * A hold entry (indeterminate: e.g. a labelled item with stock but no rack
--     holding) never opens a row and never resolves one.
--   * A present entry that is also in hold counts as present.
--   * Evaluations are applied in order: an evaluation that started at or
--     before the last applied one is skipped (a slow run finishing after a
--     newer one must not reopen what the newer one cleared). The whole sync
--     runs under a per-org transaction advisory lock.
--
-- ── RETRYABLE SQLSTATES ────────────────────────────────────────────────────
-- Never 40001/40P01 (0367: PostgREST < 16 retries 40001 forever). Refusals are
-- P0001 with a stable hint, or 22023 for a bad argument, P0002 for "not found
-- or not visible", 42501 for "not allowed". A wait for the org's sync lock
-- past lock_timeout (5 s) is 55P03, which the service treats as "busy: the
-- next run applies".
--
-- WHY 5 s AND NOT 8 s: the whole RPC, lock wait included, runs under the API
-- roles' statement_timeout of 8 s (authenticator's setting; service_role has
-- none of its own, so it inherits 8 s measured from the START of the
-- statement). With lock_timeout at 8 s the statement timeout always fired
-- first, so a sync queued behind another one ended as 57014 ("canceling
-- statement due to statement timeout") and was reported as a failure instead
-- of "busy". 5 s leaves the 55P03 answer room to arrive first. A 57014 is
-- still a real failure: the sync itself ran too long.
--
-- ── positive_since AND THE LEDGER GUARDS ───────────────────────────────────
-- trg_item_stock_levels_positive_since is BEFORE INSERT OR UPDATE OF quantity,
-- positive_since. It does no reads, so it adds nothing to the ledger's lock
-- order, and it ignores any value a writer supplies. Its name sorts before
-- trg_zz_item_stock_levels_guard, so the S1 guard still sees the final row and
-- still refuses every API-role write outside a ledger transaction (0364).
-- Every ledger writer reaches item_stock_levels through adjust_stock's upsert,
-- transfer_stock's upsert, apply_level_delta or
-- apply_cycle_count_location_delta; the trigger covers them all without
-- touching any of them (all four stay frozen).
--
-- BACKFILL: positive_since = updated_at for every positive holding. updated_at
-- is the holding's last change, and the holding has been positive at least
-- since then, so the backfilled age is a LOWER bound on the true age (the copy
-- reads "for at least N days"); values written after this migration are exact.
-- item_stock_levels_set_updated_at is disabled around the backfill UPDATE (the
-- 0358 pattern) so no holding looks as if it changed today.
--
-- ── PROD PUSH NOTE ─────────────────────────────────────────────────────────
-- ADD COLUMN and DISABLE TRIGGER take ACCESS EXCLUSIVE on item_stock_levels
-- until the file commits: every stock write waits for this migration. The
-- backfill is one UPDATE over a few hundred rows in prod. lock_timeout makes
-- the push fail fast instead of queueing behind a long transaction (retry is
-- the remedy). Everything else is new objects. Old app code reads none of them.

-- PLAIN `set`, not `set local` (0303/0358): the CLI batch is atomic but is not
-- a transaction block. Reset at the end.
set lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. item_stock_levels.positive_since
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.item_stock_levels
  add column if not exists positive_since timestamptz;

comment on column public.item_stock_levels.positive_since is
  'When this holding last went from empty to stocked (0370). Null while the '
  'holding is empty. Stamped only by trg_item_stock_levels_positive_since; any '
  'value a writer supplies is ignored. Rows that were positive when 0370 ran '
  'carry their updated_at at that time, a lower bound on the true age.';

create or replace function public.tg_item_stock_levels_positive_since()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- No reads, on purpose: this fires inside every ledger writer, between the
  -- item lock and the movement insert. Whatever NEW carried for the column is
  -- replaced, so no writer can choose or refresh the age.
  if new.quantity > 0 then
    if tg_op = 'INSERT' or old.quantity <= 0 or old.positive_since is null then
      -- Empty (or never stamped) to stocked: the age starts now.
      new.positive_since := now();
    else
      -- A top-up or a partial draw of a stocked holding keeps its age.
      new.positive_since := old.positive_since;
    end if;
  else
    new.positive_since := null;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_item_stock_levels_positive_since() from public, anon, authenticated;

comment on function public.tg_item_stock_levels_positive_since() is
  'BEFORE INSERT OR UPDATE OF quantity, positive_since on item_stock_levels '
  '(0370): now() when a holding goes from empty (or unstamped) to positive, '
  'unchanged on a top-up or partial draw, null at zero. Ignores any supplied '
  'value. Reads nothing.';

-- One-shot backfill, kept as a no-grant helper so the pgTAP file can re-run
-- the real statements against planted legacy rows (the 0358 pattern).
-- Idempotent: only positive rows with no value are touched. Returns how many
-- rows it stamped.
create or replace function public._backfill_item_stock_levels_positive_since()
returns bigint
language plpgsql
set search_path = public
as $fn$
declare
  v_stamped bigint;
begin
  -- updated_at is the time the holding last CHANGED. Recording its age is not
  -- a change, so the bump is suppressed for this statement only. The
  -- positive_since trigger is suppressed too, or it would overwrite the
  -- backfilled value with now(). The S1 guard stays on: this runs as the
  -- table owner, which the guard exempts.
  alter table public.item_stock_levels disable trigger item_stock_levels_set_updated_at;
  alter table public.item_stock_levels disable trigger trg_item_stock_levels_positive_since;

  update public.item_stock_levels
     set positive_since = updated_at
   where quantity > 0
     and positive_since is null;
  get diagnostics v_stamped = row_count;

  alter table public.item_stock_levels enable trigger trg_item_stock_levels_positive_since;
  alter table public.item_stock_levels enable trigger item_stock_levels_set_updated_at;

  return v_stamped;
end;
$fn$;

revoke all on function public._backfill_item_stock_levels_positive_since()
  from public, anon, authenticated, service_role;

comment on function public._backfill_item_stock_levels_positive_since() is
  'One-shot 0370 backfill: positive_since = updated_at for positive holdings '
  'with no value, with the updated_at and positive_since triggers disabled '
  'for that statement only. No runtime caller, so no grants.';

-- The trigger exists before the backfill runs (the helper disables it for its
-- own statement), so the helper is the same code the pgTAP file re-runs.
drop trigger if exists trg_item_stock_levels_positive_since on public.item_stock_levels;
create trigger trg_item_stock_levels_positive_since
  before insert or update of quantity, positive_since on public.item_stock_levels
  for each row execute function public.tg_item_stock_levels_positive_since();

select public._backfill_item_stock_levels_positive_since();

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. exception_occurrences
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.exception_occurrences (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,
  occurrence_number       bigint not null check (occurrence_number > 0),
  rule                    text not null check (rule in (
                            'orphaned_stock', 'over_reserved', 'stale_staging',
                            'long_unplaced', 'label_mismatch', 'count_variance')),
  item_id                 uuid not null references public.inventory_items(id) on delete cascade,
  location_id             uuid references public.locations(id) on delete cascade,
  warehouse_id            uuid references public.warehouses(id) on delete set null,
  facts                   jsonb not null default '{}'::jsonb,
  condition_since         timestamptz,
  first_seen_at           timestamptz not null,
  last_seen_at            timestamptz not null,
  acknowledged_at         timestamptz,
  acknowledged_by         uuid references public.user_profiles(id) on delete set null,
  recount_cycle_count_id  uuid references public.cycle_counts(id) on delete set null,
  resolved_at             timestamptz,
  resolved_reason         text check (resolved_reason in ('cleared', 'reclassified', 'subject_gone')),
  previous_occurrence_id  uuid references public.exception_occurrences(id) on delete set null,
  recurrence_index        integer not null default 0 check (recurrence_index >= 0),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  -- Holding rules name a location; item-level rules never do.
  constraint exc_occ_location_matches_rule check (
    (rule in ('orphaned_stock', 'stale_staging', 'long_unplaced')) = (location_id is not null)),
  constraint exc_occ_resolution_pair check ((resolved_at is null) = (resolved_reason is null)),
  -- An acknowledgement always records its time. The account can later be
  -- deleted (acknowledged_by is ON DELETE SET NULL, like every *_by column
  -- here), so a time without an account is allowed; an account without a
  -- time is not.
  constraint exc_occ_ack_pair check (acknowledged_by is null or acknowledged_at is not null),
  constraint exc_occ_seen_order check (first_seen_at <= last_seen_at),
  -- Numbers and names only (rendered by core describeOccurrence); the cap is
  -- a backstop against a runaway evaluator, far above any real facts object.
  constraint exc_occ_facts_shape check (
    jsonb_typeof(facts) = 'object' and octet_length(facts::text) <= 16384)
);

comment on table public.exception_occurrences is
  'Stored lifecycle of Exception Center conditions (0370). Opened and resolved '
  'only by exceptions_sync (service_role); acknowledged via '
  'exception_occurrence_act. Signed-in users hold SELECT only, filtered by '
  '_exc_occurrence_visible.';
comment on column public.exception_occurrences.warehouse_id is
  'Scope stamp for action checks: the location''s warehouse for holding rules, '
  'the item''s otherwise. Derived by exceptions_sync on every sync.';
comment on column public.exception_occurrences.condition_since is
  'positive_since of the holding for holding rules; the count''s observation '
  'time for count_variance (F1-2); null otherwise. As sent by the evaluator.';
comment on column public.exception_occurrences.recount_cycle_count_id is
  'The ACTIVE recount only (F1-2). exceptions_sync clears it, with a '
  'recount_closed event, once that count is no longer in progress.';

create unique index if not exists exc_occ_org_number_uniq
  on public.exception_occurrences (organization_id, occurrence_number);

-- At most one open occurrence per identity. NULLS NOT DISTINCT so two open
-- item-level rows (location_id null) for the same rule and item conflict too.
create unique index if not exists exc_occ_one_open
  on public.exception_occurrences (organization_id, rule, item_id, location_id)
  nulls not distinct
  where resolved_at is null;

create index if not exists exc_occ_org_resolved_idx
  on public.exception_occurrences (organization_id, resolved_at desc);
create index if not exists exc_occ_item_idx
  on public.exception_occurrences (item_id);
create index if not exists exc_occ_location_idx
  on public.exception_occurrences (location_id) where location_id is not null;
create index if not exists exc_occ_recount_idx
  on public.exception_occurrences (recount_cycle_count_id) where recount_cycle_count_id is not null;
create index if not exists exc_occ_previous_idx
  on public.exception_occurrences (previous_occurrence_id) where previous_occurrence_id is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. exception_occurrence_events (append-only)
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.exception_occurrence_events (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,
  occurrence_id           uuid not null references public.exception_occurrences(id) on delete cascade,
  kind                    text not null check (kind in (
                            'raised', 'acknowledged', 'note', 'recount_linked',
                            'recount_closed', 'resolved', 'evidence_added',
                            'evidence_removed', 'escalated')),
  -- Null for the system's own events (raised, recount_closed, resolved). A
  -- deleted account also reads null; the kind says which it was.
  actor_user_id           uuid references public.user_profiles(id) on delete set null,
  cycle_count_id          uuid references public.cycle_counts(id) on delete set null,
  -- F1-4 adds the foreign key when exception_evidence exists.
  evidence_id             uuid,
  maintenance_request_id  uuid references public.maintenance_requests(id) on delete set null,
  note                    text check (note is null or char_length(note) between 1 and 1000),
  client_event_id         text check (client_event_id is null or char_length(client_event_id) between 1 and 200),
  created_at              timestamptz not null default clock_timestamp()
);

comment on table public.exception_occurrence_events is
  'Append-only timeline of an exception occurrence (0370). Written by '
  'exceptions_sync (system events, null actor) and exception_occurrence_act '
  '(acknowledged, note). No API role may insert, update or delete; readable '
  'wherever the parent occurrence is.';

-- A replayed client action (the phone's offline retry) finds its first event.
create unique index if not exists exc_occ_events_client_event_uniq
  on public.exception_occurrence_events (organization_id, client_event_id)
  where client_event_id is not null;
create index if not exists exc_occ_events_occurrence_idx
  on public.exception_occurrence_events (occurrence_id, created_at);
create index if not exists exc_occ_events_cycle_count_idx
  on public.exception_occurrence_events (cycle_count_id) where cycle_count_id is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. exception_occurrence_counters (the 0358 counter pattern)
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.exception_occurrence_counters (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  last_number     bigint not null check (last_number >= 0),
  updated_at      timestamptz not null default now()
);

comment on table public.exception_occurrence_counters is
  'Last EX number handed out per organization (0370). Written only by '
  'exceptions_sync; no API role can read or write it.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. exception_sync_state
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.exception_sync_state (
  organization_id      uuid primary key references public.organizations(id) on delete cascade,
  -- The first applied sync. A row first seen at this moment is "Already
  -- present when tracking began".
  tracking_started_at  timestamptz not null,
  -- The evaluation the store reflects (monotonic; compared to a recount's
  -- completed_at for the "Re-checking" state).
  last_evaluated_at    timestamptz not null,
  last_synced_at       timestamptz not null,
  complete_rules       text[] not null default '{}',
  failed_rules         text[] not null default '{}',
  truncated_rules      text[] not null default '{}',
  constraint exc_sync_state_order check (tracking_started_at <= last_evaluated_at)
);

comment on table public.exception_sync_state is
  'Per-org Exception Center sync state (0370): when tracking began, the last '
  'evaluation applied, and which rules it could vouch for. Written only by '
  'exceptions_sync; readable by org members.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Privileges and RLS
-- ═══════════════════════════════════════════════════════════════════════════
-- The Supabase default privileges hand every new table to anon and
-- authenticated with full DML. Close all four, then open SELECT where a user
-- reads. service_role keeps exactly what exceptions_sync (SECURITY INVOKER)
-- needs: events are append-only even for it.
revoke all on table public.exception_occurrences         from public, anon, authenticated, service_role;
revoke all on table public.exception_occurrence_events   from public, anon, authenticated, service_role;
revoke all on table public.exception_occurrence_counters from public, anon, authenticated, service_role;
revoke all on table public.exception_sync_state          from public, anon, authenticated, service_role;

grant select on table public.exception_occurrences       to authenticated;
grant select on table public.exception_occurrence_events to authenticated;
grant select on table public.exception_sync_state        to authenticated;

grant select, insert, update on table public.exception_occurrences         to service_role;
grant select, insert         on table public.exception_occurrence_events   to service_role;
grant select, insert, update on table public.exception_occurrence_counters to service_role;
grant select, insert, update on table public.exception_sync_state          to service_role;

alter table public.exception_occurrences         enable row level security;
alter table public.exception_occurrence_events   enable row level security;
alter table public.exception_occurrence_counters enable row level security;
alter table public.exception_sync_state          enable row level security;

-- ── The one visibility rule ────────────────────────────────────────────────
-- An occurrence is visible to a member who can read its item (warehouse,
-- charter and category scoping: caller_can_read_item is the
-- inventory_items_select predicate) and, for a holding rule, who can see that
-- holding: the item_stock_levels_select rule (a manager, or a location with no
-- warehouse, or one in the caller's warehouses).
--
-- It is written twice, and a pgTAP test holds the two equal for every reader
-- and every row (pattern #26: two copies are allowed only with a test that
-- they agree):
--   * _exc_occurrence_visible(): one row at a time, for the RPC re-checks
--     (exception_occurrence_act locks one row, so per-row cost is nothing).
--     SECURITY DEFINER so the location read is not itself filtered; it
--     answers only for the caller (auth.uid() inside every helper).
--   * the SELECT policy: the same rule as hashed sets the planner computes
--     ONCE per query (pattern #19). A policy that called the function per row
--     cost about 0.65 ms a row, since a SECURITY DEFINER function cannot be
--     inlined: with 5,000 open rows each 1,000-row page of the Open list took
--     about 3 s (the Seq Scan ran the function on every row before the sort),
--     and the list reads five pages. The hashed form reads the same page in
--     a few milliseconds (under 100 ms through PostgREST with the list's
--     embeds, measured locally at 1,000, 3,000 and 5,000 open rows).
create or replace function public._exc_occurrence_visible(p_org uuid, p_item uuid, p_location uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_member(p_org)
     and public.caller_can_read_item(p_item)
     and (p_location is null
          or public.has_org_role(p_org, 'manager')
          or exists (
               select 1
                 from public.locations l
                where l.id = p_location
                  and (l.warehouse_id is null
                       or l.warehouse_id in (select mw.warehouse_id from public.my_warehouse_ids() mw))));
$$;

revoke all on function public._exc_occurrence_visible(uuid, uuid, uuid) from public, anon;
grant execute on function public._exc_occurrence_visible(uuid, uuid, uuid) to authenticated, service_role;

comment on function public._exc_occurrence_visible(uuid, uuid, uuid) is
  'Whether the CALLER may see an exception occurrence (0370): org member, can '
  'read the item (caller_can_read_item), and for a holding rule can see the '
  'holding (manager, org-level location, or a location in my_warehouse_ids). '
  'Mirrors inventory_items_select and item_stock_levels_select. The SELECT '
  'policy on exception_occurrences states the same rule as hashed sets.';

-- The locations whose holdings the caller may see under
-- item_stock_levels_select, other than through the manager role: a location
-- in one of the caller's warehouses, or an org-level location (no warehouse)
-- in an org the caller belongs to. Archived locations included (orphaned
-- stock sits at them). Ids only, and only in the caller's own orgs, whose
-- locations locations_select already shows to every member.
create or replace function public.rls_exc_holding_location_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select l.id
    from public.locations l
   where (select auth.uid()) is not null
     and l.warehouse_id in (select mw.warehouse_id from public.my_warehouse_ids() mw)
  union all
  select l.id
    from public.locations l
   where (select auth.uid()) is not null
     and l.warehouse_id is null
     and l.organization_id in (select public.rls_member_org_ids());
$$;

revoke all on function public.rls_exc_holding_location_ids() from public, anon;
grant execute on function public.rls_exc_holding_location_ids() to authenticated;

comment on function public.rls_exc_holding_location_ids() is
  'RLS helper (0370): location ids whose holdings the caller may see without '
  'the manager role (item_stock_levels_select): locations in my_warehouse_ids, '
  'and org-level locations in the caller''s orgs. For a hashed IN probe in the '
  'exception_occurrences SELECT policy.';

-- _exc_occurrence_visible, as sets computed once per query:
--   is_org_member(org)        -> organization_id in rls_member_org_ids()
--   caller_can_read_item(item) -> EXISTS on inventory_items under ITS OWN
--                                 policy (inventory_items_select is the only
--                                 SELECT policy there, and caller_can_read_item
--                                 is that policy's predicate; the rls_* sets
--                                 inside it are hashed once)
--   has_org_role(org,manager) -> organization_id in rls_manager_org_ids()
--   the location branch       -> location_id in rls_exc_holding_location_ids()
drop policy if exists exception_occurrences_select on public.exception_occurrences;
create policy exception_occurrences_select on public.exception_occurrences
  for select to authenticated
  using (
    organization_id in (select public.rls_member_org_ids())
    and exists (
      select 1 from public.inventory_items i where i.id = exception_occurrences.item_id)
    and (location_id is null
         or organization_id in (select public.rls_manager_org_ids())
         or location_id in (select public.rls_exc_holding_location_ids())));

-- Events are visible exactly where their occurrence is: the subquery on
-- exception_occurrences is itself filtered by the policy above.
drop policy if exists exception_occurrence_events_select on public.exception_occurrence_events;
create policy exception_occurrence_events_select on public.exception_occurrence_events
  for select to authenticated
  using (exists (
    select 1
      from public.exception_occurrences o
     where o.id = exception_occurrence_events.occurrence_id
       and o.organization_id = exception_occurrence_events.organization_id));

drop policy if exists exception_sync_state_select on public.exception_sync_state;
create policy exception_sync_state_select on public.exception_sync_state
  for select to authenticated
  using ((select public.is_org_member(exception_sync_state.organization_id)));

-- exception_occurrence_counters: RLS on, no policies, no API grants.

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. exceptions_sync: the only writer that opens or resolves
-- ═══════════════════════════════════════════════════════════════════════════
-- p_present: jsonb array of
--   {"rule": text, "itemId": uuid, "locationId": uuid|null,
--    "facts": object|null, "conditionSince": timestamptz|null,
--    "warehouseId": ignored}
-- p_hold: jsonb array of {"rule": text, "itemId": uuid, "locationId": uuid|null}
-- Holding rules (orphaned_stock, stale_staging, long_unplaced) must carry a
-- locationId; every other rule must not. A malformed payload is refused
-- whole (P0001, hint exceptions_sync_bad_payload): nothing is applied.
--
-- Returns {"skipped": true, "lastEvaluatedAt": ...} when an evaluation at or
-- after p_evaluated_at was already applied, else
-- {"skipped": false, "raised": n, "seen": n, "resolved": n,
--  "recountsClosed": n, "dropped": n, "factsOmitted": n}.
-- factsOmitted counts present entries whose facts were too large to store
-- (see step 2); their rows are applied with empty facts.
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
  with p as (
    select * from jsonb_to_recordset(v_present) as x(rule text, item_id uuid, location_id uuid)
  ),
  h as (
    select * from jsonb_to_recordset(v_hold) as x(rule text, item_id uuid, location_id uuid)
  ),
  gone as (
    update public.exception_occurrences o
       set resolved_at     = p_evaluated_at,
           resolved_reason = case
             -- Deleted or ARCHIVED only. A discontinued item still exists,
             -- can hold stock and is evaluated like any other, so its
             -- condition ending means it cleared.
             when i.deleted_at is not null or i.status = 'archived' then 'subject_gone'
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
       and o.organization_id = p_org
       and o.resolved_at is null
       and o.rule = any (v_complete)
       and not exists (
         select 1 from p
          where p.rule = o.rule and p.item_id = o.item_id
            and p.location_id is not distinct from o.location_id)
       and not exists (
         select 1 from h
          where h.rule = o.rule and h.item_id = o.item_id
            and h.location_id is not distinct from o.location_id)
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
  '(0370): closes finished recount pointers, raises numbered occurrences for '
  'new conditions (linking recurrences), refreshes open ones, and resolves '
  'absent ones only for complete rules and never for held identities. '
  'Per-org advisory lock; an evaluation at or before the last applied one is '
  'skipped. SECURITY INVOKER; EXECUTE to service_role only.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. exception_occurrence_act: acknowledge / note
-- ═══════════════════════════════════════════════════════════════════════════
-- p_action 'acknowledge': the first stamps acknowledged_at/by and writes an
--   'acknowledged' event (with the note, if any); a later one only adds its
--   note as a 'note' event (nothing when there is no note).
-- p_action 'note': a 'note' event; a note is required.
-- p_client_event_id: a replay (same id, same occurrence, same note, and an
--   action that could have written the stored event) adds nothing and returns
--   the row. The same id with anything else is refused, never answered as a
--   success: the same id on another occurrence, a different note, or
--   'note' against a stored acknowledgement. Otherwise a client that kept its
--   id after a lost answer, then edited the note and sent again, was told
--   "saved" while the edit was silently dropped.
-- Refusals: 42501 not signed in / not allowed; P0002 not found or not visible
-- (existence is not leaked); P0001 hint occurrence_resolved for a resolved
-- row, hint client_event_id_conflict for a reused id that does not match
-- what it recorded; 22023 for a bad
-- argument (hints invalid_action, note_required, note_too_long,
-- client_event_id_too_long).
create or replace function public.exception_occurrence_act(
  p_id               uuid,
  p_action           text,
  p_note             text default null,
  p_client_event_id  text default null
)
returns public.exception_occurrences
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_occ    public.exception_occurrences%rowtype;
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_key    text := nullif(btrim(coalesce(p_client_event_id, '')), '');
  v_charter uuid;
  v_prev   uuid;
  v_prev_kind text;
  v_prev_note text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('acknowledge', 'note') then
    raise exception 'invalid_action' using errcode = '22023', hint = 'invalid_action';
  end if;
  if p_action = 'note' and v_note is null then
    raise exception 'note_required' using errcode = '22023', hint = 'note_required';
  end if;
  if char_length(v_note) > 1000 then
    raise exception 'note_too_long' using errcode = '22023', hint = 'note_too_long';
  end if;
  if char_length(v_key) > 200 then
    raise exception 'client_event_id_too_long' using errcode = '22023', hint = 'client_event_id_too_long';
  end if;

  -- Only a row the caller can see is found (and locked). The visibility rule
  -- includes an accepted, unexpired, not-disabled membership of the row's
  -- org, so an outsider, a disabled account and an invisible row all read as
  -- "not found".
  select o.* into v_occ
    from public.exception_occurrences o
   where o.id = p_id
     and public._exc_occurrence_visible(o.organization_id, o.item_id, o.location_id)
   for update;
  if not found then
    raise exception 'occurrence_not_found' using errcode = 'P0002';
  end if;

  -- Acting needs stock:adjust AND write access to the occurrence's warehouse
  -- (the stamp exceptions_sync keeps: the location's warehouse for a holding
  -- rule, the item's otherwise), or the manager role when it has none.
  -- Viewers read only.
  if not public.has_permission(v_occ.organization_id, 'stock:adjust') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_occ.warehouse_id is null then
    if not public.has_org_role(v_occ.organization_id, 'manager') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  else
    select i.charter_id into v_charter
      from public.inventory_items i
     where i.id = v_occ.item_id;
    if not public.user_can_access_inventory(v_uid, v_occ.warehouse_id, v_charter, 'write') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  -- A replay of an action that already landed changes nothing, even if the
  -- row has since been resolved (the phone may retry long after). It is a
  -- replay only if it asks for what the stored event records: the same
  -- occurrence, the same (trimmed) note, and an action that writes that
  -- kind. 'acknowledged' comes only from 'acknowledge'; 'note' comes from
  -- 'note' or from a later 'acknowledge' with a note, so either matches it.
  if v_key is not null then
    select e.occurrence_id, e.kind, e.note into v_prev, v_prev_kind, v_prev_note
      from public.exception_occurrence_events e
     where e.organization_id = v_occ.organization_id
       and e.client_event_id = v_key;
    if found then
      if v_prev is distinct from v_occ.id
         or v_prev_note is distinct from v_note
         or (v_prev_kind = 'acknowledged' and p_action <> 'acknowledge') then
        raise exception 'client_event_id_conflict'
          using errcode = 'P0001', hint = 'client_event_id_conflict';
      end if;
      return v_occ;
    end if;
  end if;

  if v_occ.resolved_at is not null then
    raise exception 'occurrence_resolved'
      using errcode = 'P0001', hint = 'occurrence_resolved';
  end if;

  if p_action = 'acknowledge' and v_occ.acknowledged_at is null then
    update public.exception_occurrences
       set acknowledged_at = now(),
           acknowledged_by = v_uid,
           updated_at      = now()
     where id = v_occ.id
    returning * into v_occ;

    insert into public.exception_occurrence_events
      (organization_id, occurrence_id, kind, actor_user_id, note, client_event_id)
    values
      (v_occ.organization_id, v_occ.id, 'acknowledged', v_uid, v_note, v_key);
  elsif v_note is not null then
    insert into public.exception_occurrence_events
      (organization_id, occurrence_id, kind, actor_user_id, note, client_event_id)
    values
      (v_occ.organization_id, v_occ.id, 'note', v_uid, v_note, v_key);
  end if;
  -- A repeat acknowledgement with no note records nothing.

  return v_occ;
end;
$$;

revoke all on function public.exception_occurrence_act(uuid, text, text, text) from public, anon;
grant execute on function public.exception_occurrence_act(uuid, text, text, text) to authenticated;

comment on function public.exception_occurrence_act(uuid, text, text, text) is
  'Acknowledge an exception occurrence or add a note (0370). Staff and above '
  'with stock:adjust and write access to its warehouse (manager when it has '
  'none); P0002 when not visible; P0001 occurrence_resolved when resolved; '
  'idempotent on p_client_event_id. Never resolves. Returns the row.';

reset lock_timeout;
