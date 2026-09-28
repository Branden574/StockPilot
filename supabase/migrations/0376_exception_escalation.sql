-- 0376_exception_escalation.sql
--
-- F1-5: "Escalate to maintenance" on an exception occurrence, web and phone
-- (Outlook rule 3).
--
-- A person taps "Escalate to maintenance" on an open occurrence. The server
-- creates ONE ordinary maintenance request for the occurrence's item (and
-- location, when it has one) through MaintenanceRequestsService.create(), the
-- same path the request form uses, and links it here. Nothing is emailed: the
-- review screen's Outlook, mailto or copy handoff opens only when the person
-- taps it there. Escalating neither acknowledges nor resolves the occurrence.
--
-- ── WHAT IT ADDS ───────────────────────────────────────────────────────────
--   1. Nullable columns on exception_occurrences:
--        maintenance_request_id          the linked request (ON DELETE SET NULL)
--        escalation_number               a copy of its request_number
--        escalation_request_created_at   a copy of its created_at: the MR
--                                        handle's year is derived from it
--                                        (MR-2026-000014; core
--                                        formatMaintenanceRequestNumber), so a
--                                        reader who cannot open the request
--                                        still sees the exact handle
--        escalated_at, escalated_by      when and by whom it was linked
--        escalation_claimed_at, _by      a short claim while one escalation is
--                                        being created (see THE CLAIM)
--      All six are written ONLY by the two functions below. Signed-in users
--      keep SELECT only on the table (0370), so they read them wherever they
--      read the occurrence.
--   2. _exc_escalation_refusal(): THE escalate gate, in one place (the
--      maintenance_requests module is on for the org, and the caller holds
--      maintenance_requests:submit), answering for auth.uid(). No client role
--      may execute it; the two functions below call it in their own bodies.
--   3. exception_escalation_claim(p_id): SECURITY DEFINER, locks the row.
--   4. exception_escalation_finish(p_id, p_request_id): SECURITY DEFINER,
--      links the request (or, with a null request, releases the caller's own
--      claim).
--
-- ── THE FLOW (apps/web/src/server/services/exception-escalation.ts) ─────────
--   claim -> MaintenanceRequestsService.create() with the item and location
--   taken from the occurrence ON THE SERVER -> finish(p_id, request id).
--   On any failure after the claim, the server releases it (finish with
--   null) and, when the request was created but not linked, cancels it as
--   its requester. The endpoint is online only and never queued: there is no
--   outbox kind for it, so an offline replay cannot create a request or open
--   a composer.
--
-- ── THE CLAIM ──────────────────────────────────────────────────────────────
-- Between the claim and the link the server creates the request in a separate
-- transaction, so the row cannot stay locked across it. The claim stands in
-- for the lock: while a claim is under 2 minutes old nobody else starts an
-- escalation of this occurrence (P0001, hint escalation_in_progress). That
-- includes the CALLER'S OWN fresh claim: two tabs or a double tap would
-- otherwise both create a request, and each request sends the new-request
-- notification, so a duplicate would reach the maintenance team before the
-- loser could be cancelled. A claim older than 2 minutes is free (the server
-- crashed between the steps); nothing sweeps it. finish() links only for the
-- caller who holds the claim, so a slow escalation that lost its claim
-- cannot overwrite a newer one.
--
-- ── ONE LINKED REQUEST ─────────────────────────────────────────────────────
-- An occurrence linked to a request that is not cancelled answers the claim
-- with {state:'linked', id, number}: the client opens that request instead of
-- creating another. "Not cancelled" means cancelled_at is null (a cancelled
-- request that was later archived keeps cancelled_at: 0362). Once the linked
-- request is cancelled, a new escalation is allowed and replaces the link;
-- both stay in the timeline as 'escalated' events. A request links to at
-- most one occurrence.
--
-- ── WHAT finish() REQUIRES OF THE REQUEST ──────────────────────────────────
-- The same org, related_item_id = the occurrence's item, requester_user_id =
-- the caller, created within the last 5 minutes (created_at is the database's
-- own time: the 0362 guard stamps it on every API-role insert), and not
-- cancelled. So the link can only name a request the caller has just made
-- for this item; it cannot attach someone else's request, or an old one.
-- maintenance_requests and its 0362 guard are unchanged.
--
-- ── RETRYABLE SQLSTATES ────────────────────────────────────────────────────
-- Never 40001/40P01 (0367). Refusals: 42501 not signed in or not allowed
-- (hint module_disabled or not_permitted for the gate), P0002 not found or not
-- visible (existence is not leaked), P0001 with a hint for a state conflict
-- (occurrence_resolved, escalation_in_progress, escalation_not_claimed,
-- request_not_eligible, already_escalated), 22023 bad_argument. A lock wait
-- past lock_timeout is 55P03.
--
-- ── DATA SAFETY ────────────────────────────────────────────────────────────
-- Additive only: seven nullable columns with no default (a catalog change,
-- no table rewrite), four CHECK constraints and three foreign keys on those
-- new, all-null columns, one partial index, three new functions. No existing
-- row is updated or deleted, nothing is dropped, no column type changes.
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────
-- The CLI applies this file as ONE implicit transaction, so every lock is
-- held until the file commits. ALTER TABLE takes ACCESS EXCLUSIVE on
-- exception_occurrences (tens to hundreds of rows in prod; the CHECKs and
-- foreign keys scan them once, all null); the foreign keys take SHARE ROW
-- EXCLUSIVE on maintenance_requests and user_profiles, which blocks writes to
-- those two tables (not reads) until the commit. The file does nothing slow,
-- and lock_timeout makes the push fail fast rather than queue behind a long
-- transaction (retry in a quiet window). No storage DDL.

-- PLAIN `set`, not `set local` (0303/0358): the CLI batch is atomic but is not
-- a transaction block. Reset at the end.
set lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Columns
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.exception_occurrences
  add column if not exists maintenance_request_id uuid
    references public.maintenance_requests(id) on delete set null,
  add column if not exists escalation_number bigint,
  add column if not exists escalation_request_created_at timestamptz,
  add column if not exists escalated_at timestamptz,
  add column if not exists escalated_by uuid
    references public.user_profiles(id) on delete set null,
  add column if not exists escalation_claimed_at timestamptz,
  add column if not exists escalation_claimed_by uuid
    references public.user_profiles(id) on delete set null,
  -- One direction only, like exc_occ_ack_pair: an account or a request can
  -- be deleted (ON DELETE SET NULL) and the time or the number stays.
  add constraint exc_occ_escalation_link check (
    maintenance_request_id is null
    or (escalation_number is not null
        and escalation_request_created_at is not null
        and escalated_at is not null)),
  add constraint exc_occ_escalated_pair check (escalated_by is null or escalated_at is not null),
  add constraint exc_occ_escalation_claim_pair check (
    escalation_claimed_by is null or escalation_claimed_at is not null),
  add constraint exc_occ_escalation_number_positive check (
    escalation_number is null or escalation_number > 0);

comment on column public.exception_occurrences.maintenance_request_id is
  'The maintenance request this occurrence was escalated to (0376), written '
  'only by exception_escalation_finish. A cancelled request frees the '
  'occurrence for a new escalation, which replaces the link.';
comment on column public.exception_occurrences.escalation_number is
  'request_number of the linked request, copied when it was linked (0376), so '
  'every reader of the occurrence can show "Escalated: MR-..." even when they '
  'cannot open the request.';
comment on column public.exception_occurrences.escalation_request_created_at is
  'created_at of the linked request, copied when it was linked (0376): the '
  'year in the MR handle is derived from it (UTC).';
comment on column public.exception_occurrences.escalation_claimed_at is
  'While an escalation is being created (0376): a claim under 2 minutes old '
  'refuses every other claim. Cleared on link or release; an older claim is free.';

-- The link lookups (a request links to at most one occurrence) and the
-- foreign key's ON DELETE SET NULL.
create index if not exists exc_occ_maintenance_request_idx
  on public.exception_occurrences (maintenance_request_id)
  where maintenance_request_id is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. The escalate gate, in one place
-- ═══════════════════════════════════════════════════════════════════════════
-- For auth.uid(): null when the caller may escalate in p_org, else the reason:
--   'module_disabled'  the maintenance_requests module is off for the org
--                      (module_enabled: an enabled row, or the org's comp);
--   'not_permitted'    signed out, or no maintenance_requests:submit
--                      (has_permission: role defaults with the org's and the
--                      user's overrides; false for a disabled account).
-- The app gate mirrors it (assertModuleEnabled + assertPermission in
-- ExceptionEscalationService). Visibility is NOT part of it: both callers
-- check _exc_occurrence_visible first, so an invisible row reads "not found".
-- No client role may execute it (the callers are SECURITY DEFINER bodies,
-- which run as the owner).
create or replace function public._exc_escalation_refusal(p_org uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or p_org is null then
    return 'not_permitted';
  end if;
  if not public.module_enabled(p_org, 'maintenance_requests') then
    return 'module_disabled';
  end if;
  if not public.has_permission(p_org, 'maintenance_requests:submit') then
    return 'not_permitted';
  end if;
  return null;
end;
$$;

revoke all on function public._exc_escalation_refusal(uuid) from public, anon, authenticated;

comment on function public._exc_escalation_refusal(uuid) is
  'The escalate gate for exception occurrences (0376), for auth.uid(): null '
  'when allowed, else module_disabled or not_permitted. Used by '
  'exception_escalation_claim and exception_escalation_finish. No client role '
  'may execute it.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. exception_escalation_claim
-- ═══════════════════════════════════════════════════════════════════════════
-- Returns {state:'claimed', claimedAt} or {state:'linked', id, number,
-- createdAt} (already escalated to a request that is not cancelled: the
-- client opens it). Refusals, in this order: 42501 signed out; 22023 no id;
-- P0002 not found or not visible; 42501 the gate (hint module_disabled or
-- not_permitted); P0001 occurrence_resolved; P0001 escalation_in_progress (a
-- claim under 2 minutes old, anyone's).
create or replace function public.exception_escalation_claim(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
set lock_timeout = '5s'
as $$
declare
  v_uid      uuid := auth.uid();
  v_occ      public.exception_occurrences%rowtype;
  v_refusal  text;
  v_req_id   uuid;
  v_req_no   bigint;
  v_req_at   timestamptz;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_id is null then
    raise exception 'bad_argument' using errcode = '22023', hint = 'bad_argument';
  end if;

  -- Only a row the caller can see is found (and locked): an outsider, a
  -- disabled account and an invisible row all read "not found".
  select o.* into v_occ
    from public.exception_occurrences o
   where o.id = p_id
     and public._exc_occurrence_visible(o.organization_id, o.item_id, o.location_id)
   for update;
  if not found then
    raise exception 'occurrence_not_found' using errcode = 'P0002';
  end if;

  v_refusal := public._exc_escalation_refusal(v_occ.organization_id);
  if v_refusal is not null then
    raise exception 'escalation_not_allowed' using errcode = '42501', hint = v_refusal;
  end if;

  if v_occ.resolved_at is not null then
    raise exception 'occurrence_resolved' using errcode = 'P0001', hint = 'occurrence_resolved';
  end if;

  -- Already escalated to a request that is not cancelled: that one, never a
  -- second. Its id and number are on the occurrence row already, which the
  -- caller can read, so answering with them discloses nothing new.
  if v_occ.maintenance_request_id is not null then
    select r.id, r.request_number, r.created_at into v_req_id, v_req_no, v_req_at
      from public.maintenance_requests r
     where r.id = v_occ.maintenance_request_id
       and r.cancelled_at is null;
    if found then
      return jsonb_build_object(
        'state', 'linked', 'id', v_req_id, 'number', v_req_no, 'createdAt', v_req_at);
    end if;
  end if;

  -- A live claim, whoever holds it (see THE CLAIM in the header).
  if v_occ.escalation_claimed_by is not null
     and v_occ.escalation_claimed_at > now() - interval '2 minutes' then
    raise exception 'escalation_in_progress'
      using errcode = 'P0001', hint = 'escalation_in_progress';
  end if;

  update public.exception_occurrences
     set escalation_claimed_at = now(),
         escalation_claimed_by = v_uid
   where id = v_occ.id;

  return jsonb_build_object('state', 'claimed', 'claimedAt', now());
end;
$$;

revoke all on function public.exception_escalation_claim(uuid) from public, anon;
grant execute on function public.exception_escalation_claim(uuid) to authenticated;

comment on function public.exception_escalation_claim(uuid) is
  'Start escalating an exception occurrence to a maintenance request (0376). '
  'Visible row, maintenance module on and maintenance_requests:submit; refuses '
  'a resolved row and a claim under 2 minutes old; answers {state:linked} '
  'when a request that is not cancelled is already linked; otherwise claims '
  'the row for the caller. Never acknowledges or resolves.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. exception_escalation_finish
-- ═══════════════════════════════════════════════════════════════════════════
-- p_request_id null: RELEASE. Clears the caller's own claim on the row and
--   nothing else; returns {state:'released'}, or {state:'not_held'} when the
--   caller holds no claim there (never an error, never "not found": the
--   server calls this on its failure path, and the answer says nothing about
--   rows the caller did not claim).
-- p_request_id set: LINK. Returns {state:'linked', id, number, createdAt}.
--   The same request again (a lost answer, resent) returns the same, with no
--   second event. Refusals, in this order: 42501 signed out; 22023 no id;
--   P0002 not found or not visible; 42501 the gate; P0001
--   occurrence_resolved; P0001 escalation_not_claimed (the caller does not
--   hold the claim); P0001 already_escalated (a request that is not
--   cancelled is linked); P0001 request_not_eligible (see WHAT finish()
--   REQUIRES in the header, or the request is already linked to another
--   occurrence).
create or replace function public.exception_escalation_finish(
  p_id          uuid,
  p_request_id  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
set lock_timeout = '5s'
as $$
declare
  v_uid      uuid := auth.uid();
  v_occ      public.exception_occurrences%rowtype;
  v_req      public.maintenance_requests%rowtype;
  v_refusal  text;
  v_released uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_id is null then
    raise exception 'bad_argument' using errcode = '22023', hint = 'bad_argument';
  end if;

  -- ── Release ─────────────────────────────────────────────────────────────
  if p_request_id is null then
    update public.exception_occurrences o
       set escalation_claimed_at = null,
           escalation_claimed_by = null
     where o.id = p_id
       and o.escalation_claimed_by = v_uid
    returning o.id into v_released;
    return jsonb_build_object('state', case when v_released is null then 'not_held' else 'released' end);
  end if;

  -- ── Link ────────────────────────────────────────────────────────────────
  select o.* into v_occ
    from public.exception_occurrences o
   where o.id = p_id
     and public._exc_occurrence_visible(o.organization_id, o.item_id, o.location_id)
   for update;
  if not found then
    raise exception 'occurrence_not_found' using errcode = 'P0002';
  end if;

  v_refusal := public._exc_escalation_refusal(v_occ.organization_id);
  if v_refusal is not null then
    raise exception 'escalation_not_allowed' using errcode = '42501', hint = v_refusal;
  end if;

  -- The link already landed (the server lost the answer and asked again).
  if v_occ.maintenance_request_id = p_request_id then
    return jsonb_build_object(
      'state', 'linked', 'id', p_request_id, 'number', v_occ.escalation_number,
      'createdAt', v_occ.escalation_request_created_at);
  end if;

  if v_occ.resolved_at is not null then
    raise exception 'occurrence_resolved' using errcode = 'P0001', hint = 'occurrence_resolved';
  end if;

  if v_occ.escalation_claimed_by is distinct from v_uid then
    raise exception 'escalation_not_claimed'
      using errcode = 'P0001', hint = 'escalation_not_claimed';
  end if;

  -- Holding the claim means no live link existed when it was taken, and a
  -- cancellation is never undone (0362), so this is a backstop.
  if v_occ.maintenance_request_id is not null and exists (
       select 1 from public.maintenance_requests r
        where r.id = v_occ.maintenance_request_id
          and r.cancelled_at is null) then
    raise exception 'already_escalated' using errcode = 'P0001', hint = 'already_escalated';
  end if;

  select r.* into v_req
    from public.maintenance_requests r
   where r.id = p_request_id;
  if not found
     or v_req.organization_id <> v_occ.organization_id
     or v_req.related_item_id is distinct from v_occ.item_id
     or v_req.requester_user_id is distinct from v_uid
     or v_req.created_at < now() - interval '5 minutes'
     or v_req.cancelled_at is not null
     or exists (
          select 1 from public.exception_occurrences o2
           where o2.maintenance_request_id = p_request_id
             and o2.id <> v_occ.id) then
    raise exception 'request_not_eligible' using errcode = 'P0001', hint = 'request_not_eligible';
  end if;

  -- Link, and nothing else: acknowledged_* and resolved_* are not touched.
  update public.exception_occurrences
     set maintenance_request_id        = v_req.id,
         escalation_number             = v_req.request_number,
         escalation_request_created_at = v_req.created_at,
         escalated_at                  = now(),
         escalated_by                  = v_uid,
         escalation_claimed_at         = null,
         escalation_claimed_by         = null,
         updated_at                    = now()
   where id = v_occ.id;

  insert into public.exception_occurrence_events
    (organization_id, occurrence_id, kind, actor_user_id, maintenance_request_id)
  values
    (v_occ.organization_id, v_occ.id, 'escalated', v_uid, v_req.id);

  return jsonb_build_object(
    'state', 'linked', 'id', v_req.id, 'number', v_req.request_number,
    'createdAt', v_req.created_at);
end;
$$;

revoke all on function public.exception_escalation_finish(uuid, uuid) from public, anon;
grant execute on function public.exception_escalation_finish(uuid, uuid) to authenticated;

comment on function public.exception_escalation_finish(uuid, uuid) is
  'Finish escalating an exception occurrence (0376). A null request releases '
  'the caller''s own claim. Otherwise links a request the caller holds the '
  'claim for: same org, related to the occurrence''s item, requested by the '
  'caller within the last 5 minutes, not cancelled, linked nowhere else; '
  'copies its number and writes an escalated event. Never acknowledges or '
  'resolves.';

reset lock_timeout;
