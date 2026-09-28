-- 0375_exception_evidence.sql
--
-- F1-4: photo evidence on exception occurrences, web and phone.
--
-- Staff attach photos (with an optional note) to an OPEN exception
-- occurrence. A photo cannot be altered once recorded, and removing one leaves
-- a trace: removal is SOFT (the row stays, the stored file is kept) and writes
-- an evidence_removed event.
--
-- ── WHAT IT ADDS ───────────────────────────────────────────────────────────
--   1. Table exception_evidence: one row per recorded photo. Signed-in users
--      hold SELECT only, visible exactly where the parent occurrence is. ONE
--      UPLOAD NAME, ONE PHOTO: an upload's uuid is recorded at most once in
--      the org (whatever its extension), and each thumbnail belongs to one
--      row.
--   2. _exc_occurrence_can_act(): THE act gate (stock:adjust, and write
--      access to the occurrence's warehouse for the item's charter, or the
--      manager role when it has no warehouse), lifted out of
--      exception_occurrence_act so acknowledge, note, add photo and remove
--      photo share one copy. exception_occurrence_act is re-created to call
--      it; nothing else in its body changes.
--   3. exception_evidence_record(): the ONLY writer of a photo row.
--      service_role only: the web server calls it after it has checked the
--      bytes (sniffed type, size, re-encoded without metadata). Under a row
--      lock on the occurrence it re-checks the path shape, that the upload
--      is not already recorded (23505 already_recorded, before any other
--      refusal), that the occurrence is open, that the UPLOADER passes the
--      act gate, and that fewer than 8 live photos exist; then it inserts the
--      row and an evidence_added event.
--   4. exception_evidence_remove(): soft remove, for signed-in users. The
--      uploader or a manager, both through the act gate, while the occurrence
--      is open. Writes an evidence_removed event; the stored file is kept.
--   5. exception_occurrence_events.evidence_id gets its foreign key (0370 left
--      the column waiting for this table), added NOT VALID and then
--      VALIDATEd, and a CHECK that evidence events, and only they, name a
--      photo.
--   6. Bucket `exception-evidence` (private; PNG, JPEG, WEBP; 10 MB), cloned
--      from 0315: ONE INSERT policy (the first folder is one of the caller's
--      accepted orgs, plus the inline disabled-account guard; and only the
--      name a mint hands out, {org}/{occurrence}/{uuid}.{ext}) and NO select,
--      update or delete policy. Every read is a 1-hour signed link minted by
--      the server after an RLS-visible read of the row. LAST in the file:
--      see LOCKS.
--
-- ── FILE NAMES ─────────────────────────────────────────────────────────────
--   {org}/{occurrence}/{uuid}.{ext}        the upload (the client PUTs it to
--                                          a mint's signed URL; the server
--                                          re-encodes it in place)
--   {org}/{occurrence}/{uuid2}-thumb.webp  the thumbnail, written by the
--                                          server under a FRESH uuid of its
--                                          own at finalize
-- A thumbnail is never named from the upload: {uuid}.jpg and {uuid}.png
-- would share it, so a second upload could reach a recorded photo's
-- thumbnail (review finding 2026-09-27). No client may create a thumbnail
-- name at all (the INSERT policy admits only the upload shape).
--
-- ── WHY THE RECORD RPC IS service_role ONLY ────────────────────────────────
-- A row says "the server looked at these bytes". If a signed-in user could
-- write it, they could record a row for an object the server never checked
-- (F1 plan, correction 2: maintenance-attachments finalize inserts
-- verified_at as the caller, so a direct PostgREST insert could fake it). So
-- authenticated has no INSERT on the table and no EXECUTE on the RPC.
--
-- ── HOW A service_role FUNCTION JUDGES THE UPLOADER ────────────────────────
-- Every helper the act gate uses (has_permission, has_org_role,
-- user_can_access_inventory through my_warehouse_ids, caller_can_read_item,
-- is_org_member) answers for auth.uid(). Under service_role auth.uid() is
-- null, so the record RPC sets request.jwt.claim.sub (and .role) to the
-- uploader, transaction-locally, for exactly the two gate calls, and puts
-- both settings back before it writes anything. That is how the SAME gate
-- judges the uploader without restating it. The uploader id comes from the
-- server's authenticated context, never from the client, and the function is
-- not executable by any client role.
--
-- ── THE CAP OF 8 ───────────────────────────────────────────────────────────
-- Counted live (removed_at is null) under a FOR UPDATE lock on the
-- occurrence row, so two concurrent records for one occurrence serialize:
-- the second waits, then counts the first. Without the lock both would count
-- 7 and both insert (scripts/db-concurrency/0375_evidence_cap.sh shows it,
-- against a lock-less copy). Removing a photo frees its slot.
--
-- ── RETRYABLE SQLSTATES ────────────────────────────────────────────────────
-- Never 40001/40P01 (0367). Refusals: 42501 not allowed, P0002 not found or
-- not visible (existence is not leaked), P0001 with a hint for a state
-- conflict (occurrence_resolved, evidence_limit_reached), 22023 for a bad
-- argument (hint names it). A lock wait past lock_timeout is 55P03.
--
-- ── DATA SAFETY ────────────────────────────────────────────────────────────
-- Additive only: a new table, new functions, a re-created function body
-- (exception_occurrence_act, same signature and behaviour), two constraints
-- plus an index on exception_occurrence_events, a new bucket row and a new
-- storage policy. No existing row is updated or deleted. The events FK and
-- CHECK are added NOT VALID and then validated.
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────
-- The CLI applies this file as ONE implicit transaction (the batch is
-- atomic), so every lock a statement takes is held until the whole file
-- commits. In particular, NOT VALID followed by VALIDATE only avoids a table
-- scan under the heavier lock: the ACCESS EXCLUSIVE lock that ADD CONSTRAINT
-- takes on exception_occurrence_events is still held to the end.
-- storage.objects is the table that matters: every attachment render in
-- every org reads it (0312/0315), and CREATE POLICY takes ACCESS EXCLUSIVE on
-- it. So the storage DDL is the LAST thing in the file: storage.objects is
-- locked only for that statement and the commit, never while this file waits
-- up to lock_timeout for another lock (organizations, user_profiles and
-- exception_occurrences for the new foreign keys, exception_occurrence_events
-- for its constraints). apps/web/src/server/services/storage-policy-order.guard.test.ts
-- pins that order for this and every later migration.

-- PLAIN `set`, not `set local` (0303/0358): the CLI batch is atomic but is not
-- a transaction block. Reset at the end. Fail fast (and retry in a quiet
-- window) rather than queue readers behind a lock this file waits for.
set lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. exception_evidence
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.exception_evidence (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  occurrence_id   uuid not null references public.exception_occurrences(id) on delete cascade,
  -- Always set by the record RPC. ON DELETE SET NULL like every *_by column
  -- in F1: a deleted account reads "Former member".
  uploaded_by     uuid references public.user_profiles(id) on delete set null,
  storage_path    text not null,
  thumbnail_path  text,
  content_type    text not null check (content_type in ('image/png', 'image/jpeg', 'image/webp')),
  byte_size       bigint not null check (byte_size between 1 and 10485760),
  -- The DEVICE's clock when the photo was taken (as the client reported it),
  -- or null when it did not say. created_at is the SERVER's upload time.
  captured_at     timestamptz,
  note            text check (note is null or char_length(note) between 1 and 500),
  created_at      timestamptz not null default now(),
  removed_at      timestamptz,
  removed_by      uuid references public.user_profiles(id) on delete set null,

  -- The 0323 traversal floor, on both path columns (validated now: the table
  -- is new and empty).
  constraint exception_evidence_storage_path_safe check (
    length(storage_path) between 1 and 400
    and position('..' in storage_path) = 0
    and position('%' in storage_path) = 0
    and position(E'\\' in storage_path) = 0
    and position('//' in storage_path) = 0
    and storage_path not like '/%'
    and storage_path !~ '[[:cntrl:]]'
  ),
  constraint exception_evidence_thumbnail_path_safe check (
    thumbnail_path is null
    or (
      length(thumbnail_path) between 1 and 400
      and position('..' in thumbnail_path) = 0
      and position('%' in thumbnail_path) = 0
      and position(E'\\' in thumbnail_path) = 0
      and position('//' in thumbnail_path) = 0
      and thumbnail_path not like '/%'
      and thumbnail_path !~ '[[:cntrl:]]'
    )
  ),
  -- A photo lives in its own occurrence's folder. Both ids render as
  -- lowercase hex and hyphens, so neither can carry a LIKE wildcard.
  constraint exception_evidence_path_in_occurrence check (
    storage_path like organization_id::text || '/' || occurrence_id::text || '/%'),
  constraint exception_evidence_thumbnail_in_occurrence check (
    thumbnail_path is null
    or thumbnail_path like organization_id::text || '/' || occurrence_id::text || '/%'),
  -- A removal always records its time (the account can later be deleted).
  constraint exception_evidence_removed_pair check (removed_by is null or removed_at is not null),
  -- A device clock may run a little ahead of the server; a capture time far
  -- in the future is not a capture time.
  constraint exception_evidence_captured_not_future check (
    captured_at is null or captured_at <= created_at + interval '5 minutes')
);

comment on table public.exception_evidence is
  'Photo evidence on exception occurrences (0375). Written only by '
  'exception_evidence_record (service_role, after the server checked and '
  're-encoded the bytes); soft-removed only by exception_evidence_remove. '
  'Signed-in users hold SELECT only, visible where the occurrence is. The '
  'files live in the private exception-evidence bucket, read through 1-hour '
  'signed links.';
comment on column public.exception_evidence.captured_at is
  'When the photo was taken by the DEVICE''s clock, as the client reported it '
  '(null when it did not). created_at is the server''s upload time.';
comment on column public.exception_evidence.removed_at is
  'Soft removal (0375): the row and the stored file are kept; an '
  'evidence_removed event records who removed it and why.';

create unique index if not exists exception_evidence_org_path_uniq
  on public.exception_evidence (organization_id, storage_path);
-- ONE UPLOAD NAME, ONE PHOTO: the upload's uuid, whatever its extension, is
-- recorded once in the org ({uuid}.jpg and {uuid}.png are one name). The
-- record RPC checks the same expression first, under its lock, so a retried
-- finalize is told "already recorded" before any other refusal; this index
-- settles anything that check cannot see.
create unique index if not exists exception_evidence_org_stem_uniq
  on public.exception_evidence
     (organization_id, (regexp_replace(storage_path, '\.(jpg|jpeg|png|webp)$', '')));
-- A thumbnail belongs to one photo.
create unique index if not exists exception_evidence_org_thumb_uniq
  on public.exception_evidence (organization_id, thumbnail_path)
  where thumbnail_path is not null;
create index if not exists exception_evidence_occurrence_idx
  on public.exception_evidence (occurrence_id, created_at);

revoke all on table public.exception_evidence from public, anon, authenticated, service_role;
grant select on table public.exception_evidence to authenticated;
-- The record RPC runs as service_role (SECURITY INVOKER): it reads the live
-- count and inserts. Nobody updates or deletes through the API; the soft
-- remove is SECURITY DEFINER.
grant select, insert on table public.exception_evidence to service_role;

alter table public.exception_evidence enable row level security;

-- Visible exactly where the occurrence is (the subquery is itself filtered by
-- exception_occurrences_select), the same form as the events policy.
create policy exception_evidence_select on public.exception_evidence
  for select to authenticated
  using (exists (
    select 1
      from public.exception_occurrences o
     where o.id = exception_evidence.occurrence_id
       and o.organization_id = exception_evidence.organization_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. The act gate, in one place
-- ═══════════════════════════════════════════════════════════════════════════
-- Byte for byte the rule exception_occurrence_act applied inline in 0370:
-- stock:adjust in the org, and then
--   * no warehouse on the occurrence: the manager role;
--   * otherwise: write access to that warehouse for the item's charter
--     (user_can_access_inventory, which refuses viewers).
-- It answers for auth.uid(). Visibility is NOT part of it: every caller
-- checks _exc_occurrence_visible first, so an invisible row reads as "not
-- found" and never as "not allowed".
--
-- No client role may call it: it is a building block of the three RPCs
-- below (SECURITY DEFINER bodies run as the owner) and of the service_role
-- record RPC, so EXECUTE goes to service_role only.
create or replace function public._exc_occurrence_can_act(
  p_org        uuid,
  p_warehouse  uuid,
  p_item       uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_charter uuid;
begin
  if v_uid is null or p_org is null then
    return false;
  end if;
  if not public.has_permission(p_org, 'stock:adjust') then
    return false;
  end if;
  if p_warehouse is null then
    return public.has_org_role(p_org, 'manager');
  end if;
  select i.charter_id into v_charter
    from public.inventory_items i
   where i.id = p_item;
  return public.user_can_access_inventory(v_uid, p_warehouse, v_charter, 'write');
end;
$$;

revoke all on function public._exc_occurrence_can_act(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public._exc_occurrence_can_act(uuid, uuid, uuid) to service_role;

comment on function public._exc_occurrence_can_act(uuid, uuid, uuid) is
  'The act gate for exception occurrences (0375), for auth.uid(): stock:adjust, '
  'and write access to the occurrence''s warehouse for the item''s charter, or '
  'the manager role when it has no warehouse. One copy, used by '
  'exception_occurrence_act (acknowledge, note), exception_evidence_record '
  '(for the uploader) and exception_evidence_remove. Callers check '
  '_exc_occurrence_visible first. No client role may execute it.';

-- exception_occurrence_act, re-created to use the gate above. Everything else
-- is the 0370 body unchanged: argument checks, the visibility lock (P0002),
-- the replay rules, occurrence_resolved, and never touching resolved_at.
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

  -- The act gate (0375: one copy, shared with the photo RPCs). Viewers read
  -- only.
  if not public._exc_occurrence_can_act(v_occ.organization_id, v_occ.warehouse_id, v_occ.item_id) then
    raise exception 'forbidden' using errcode = '42501';
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

-- CREATE OR REPLACE keeps the 0370 grants; restated so this file reads whole.
revoke all on function public.exception_occurrence_act(uuid, text, text, text) from public, anon;
grant execute on function public.exception_occurrence_act(uuid, text, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. exception_evidence_record: the only writer of a photo row
-- ═══════════════════════════════════════════════════════════════════════════
-- Called by the web server (service role) after it has:
--   * checked the path against this occurrence's folder,
--   * sniffed the bytes against the declared type and the size cap,
--   * re-encoded the master without metadata and written the thumbnail.
-- Everything a caller could get wrong is re-checked here under the lock.
--
-- p_thumbnail_path is null or a server thumbnail name in the same folder,
-- {uuid}-thumb.webp, under a uuid the server chose for it (see FILE NAMES).
-- p_content_type must agree with the master's extension.
--
-- Refusals: 42501 not a server call, or the uploader may not act; P0002 the
-- occurrence does not exist or the uploader cannot see it; P0001
-- occurrence_resolved, evidence_limit_reached; 22023 bad_argument,
-- invalid_path, invalid_thumbnail_path, invalid_content_type,
-- byte_size_out_of_range, note_too_long, captured_at_in_future; 23505 (hint
-- already_recorded) the upload name is already recorded: a second finalize
-- of the same upload. That answer comes BEFORE the gate, open and cap
-- checks, because the server deletes an upload it was refused, and for a
-- recorded upload that file is the recorded photo's (review finding
-- 2026-09-27: at the cap a retried finalize got evidence_limit_reached and
-- the server deleted the recorded photo's file). A 23505 with no hint is
-- the unique thumbnail index.
create or replace function public.exception_evidence_record(
  p_occurrence_id   uuid,
  p_uploaded_by     uuid,
  p_storage_path    text,
  p_thumbnail_path  text,
  p_content_type    text,
  p_byte_size       bigint,
  p_captured_at     timestamptz default null,
  p_note            text default null
)
returns public.exception_evidence
language plpgsql
security invoker
set search_path = public
set lock_timeout = '5s'
as $$
declare
  c_max_live  constant integer := 8;
  c_uuid      constant text := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  v_note      text := nullif(btrim(coalesce(p_note, '')), '');
  v_occ       public.exception_occurrences%rowtype;
  v_prefix    text;
  v_ext       text;
  v_prev_sub  text;
  v_prev_role text;
  v_visible   boolean;
  v_can       boolean;
  v_live      integer;
  v_row       public.exception_evidence%rowtype;
begin
  -- EXECUTE is service_role only; the body states the same rule where a
  -- future grant mistake would meet it.
  if current_user in ('authenticated', 'anon') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- ── Arguments ────────────────────────────────────────────────────────────
  if p_occurrence_id is null or p_uploaded_by is null or p_storage_path is null
     or p_content_type is null or p_byte_size is null then
    raise exception 'bad_argument' using errcode = '22023', hint = 'bad_argument';
  end if;
  if p_content_type not in ('image/png', 'image/jpeg', 'image/webp') then
    raise exception 'invalid_content_type' using errcode = '22023', hint = 'invalid_content_type';
  end if;
  if p_byte_size < 1 or p_byte_size > 10485760 then
    raise exception 'byte_size_out_of_range' using errcode = '22023', hint = 'byte_size_out_of_range';
  end if;
  if char_length(v_note) > 500 then
    raise exception 'note_too_long' using errcode = '22023', hint = 'note_too_long';
  end if;
  if p_captured_at is not null and p_captured_at > now() + interval '5 minutes' then
    raise exception 'captured_at_in_future' using errcode = '22023', hint = 'captured_at_in_future';
  end if;

  -- ── The occurrence, locked ──────────────────────────────────────────────
  -- The lock is what makes the cap hold: a second record for this occurrence
  -- waits here until the first commits, then counts it.
  select o.* into v_occ
    from public.exception_occurrences o
   where o.id = p_occurrence_id
   for update;
  if not found then
    raise exception 'occurrence_not_found' using errcode = 'P0002';
  end if;

  -- ── Path shape: {org}/{occurrence}/{uuid}.{ext} ─────────────────────────
  -- Both ids render as lowercase hex and hyphens, which carry no regex
  -- meaning, so the prefix is embedded as is.
  v_prefix := v_occ.organization_id::text || '/' || v_occ.id::text || '/';
  if p_storage_path !~ ('^' || v_prefix || c_uuid || '\.(jpg|jpeg|png|webp)$') then
    raise exception 'invalid_path' using errcode = '22023', hint = 'invalid_path';
  end if;
  v_ext := substring(p_storage_path from '\.([a-z]+)$');
  if (v_ext in ('jpg', 'jpeg') and p_content_type <> 'image/jpeg')
     or (v_ext = 'png' and p_content_type <> 'image/png')
     or (v_ext = 'webp' and p_content_type <> 'image/webp') then
    raise exception 'invalid_content_type' using errcode = '22023', hint = 'invalid_content_type';
  end if;
  if p_thumbnail_path is not null
     and p_thumbnail_path !~ ('^' || v_prefix || c_uuid || '-thumb\.webp$') then
    raise exception 'invalid_thumbnail_path' using errcode = '22023', hint = 'invalid_thumbnail_path';
  end if;

  -- ── One upload name, one photo ──────────────────────────────────────────
  -- Under the lock, and before every other refusal (see the header). The
  -- expression is exception_evidence_org_stem_uniq's, so the index answers.
  if exists (
       select 1 from public.exception_evidence e
        where e.organization_id = v_occ.organization_id
          and regexp_replace(e.storage_path, '\.(jpg|jpeg|png|webp)$', '')
              = regexp_replace(p_storage_path, '\.(jpg|jpeg|png|webp)$', '')) then
    raise exception 'already_recorded' using errcode = '23505', hint = 'already_recorded';
  end if;

  -- ── The uploader, judged by the act gate as themselves ──────────────────
  -- See the header: the helpers answer for auth.uid(), so the uploader's id
  -- is put in the request claims for these two calls only and the previous
  -- settings are restored before anything is written. Each setting is made
  -- with is_local = true, so it is transaction-local, and an error anywhere
  -- below rolls it back too. (The setting names are literals: the 0359
  -- census refuses any function that lets a caller choose one.)
  v_prev_sub  := current_setting('request.jwt.claim.sub', true);
  v_prev_role := current_setting('request.jwt.claim.role', true);
  perform set_config('request.jwt.claim.sub', p_uploaded_by::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  v_visible := public._exc_occurrence_visible(v_occ.organization_id, v_occ.item_id, v_occ.location_id);
  v_can := v_visible
           and public._exc_occurrence_can_act(v_occ.organization_id, v_occ.warehouse_id, v_occ.item_id);
  perform set_config('request.jwt.claim.sub', coalesce(v_prev_sub, ''), true);
  perform set_config('request.jwt.claim.role', coalesce(v_prev_role, ''), true);

  -- Invisible to the uploader (another warehouse, another org, a disabled
  -- account): not found, as for acknowledge.
  if not v_visible then
    raise exception 'occurrence_not_found' using errcode = 'P0002';
  end if;
  if not v_can then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_occ.resolved_at is not null then
    raise exception 'occurrence_resolved' using errcode = 'P0001', hint = 'occurrence_resolved';
  end if;

  -- ── At most 8 live photos ───────────────────────────────────────────────
  select count(*) into v_live
    from public.exception_evidence e
   where e.occurrence_id = v_occ.id
     and e.removed_at is null;
  if v_live >= c_max_live then
    raise exception 'evidence_limit_reached' using errcode = 'P0001', hint = 'evidence_limit_reached';
  end if;

  insert into public.exception_evidence (
    organization_id, occurrence_id, uploaded_by, storage_path, thumbnail_path,
    content_type, byte_size, captured_at, note)
  values (
    v_occ.organization_id, v_occ.id, p_uploaded_by, p_storage_path, p_thumbnail_path,
    p_content_type, p_byte_size, p_captured_at, v_note)
  returning * into v_row;

  insert into public.exception_occurrence_events
    (organization_id, occurrence_id, kind, actor_user_id, evidence_id, note)
  values
    (v_occ.organization_id, v_occ.id, 'evidence_added', p_uploaded_by, v_row.id, v_note);

  return v_row;
end;
$$;

revoke all on function public.exception_evidence_record(uuid, uuid, text, text, text, bigint, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.exception_evidence_record(uuid, uuid, text, text, text, bigint, timestamptz, text)
  to service_role;

comment on function public.exception_evidence_record(uuid, uuid, text, text, text, bigint, timestamptz, text) is
  'Records one photo on an exception occurrence (0375), after the web server '
  'checked and re-encoded the bytes. service_role only. Under a lock on the '
  'occurrence it re-checks: open, the uploader sees it and passes the act '
  'gate (_exc_occurrence_can_act, judged as the uploader), the path shape, '
  'and fewer than 8 live photos. Inserts the row and an evidence_added event.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. exception_evidence_remove: soft remove
-- ═══════════════════════════════════════════════════════════════════════════
-- The uploader or a manager, both through the act gate, while the
-- occurrence is open. Sets removed_at/removed_by and writes an
-- evidence_removed event carrying the reason; the row and the stored file are
-- kept. A photo already removed is returned as it is, with no second event
-- (a double tap, or the phone retrying).
--
-- Lock order is the record RPC's: the occurrence first, then the photo.
--
-- Refusals: 42501 not signed in, not allowed, or neither the uploader nor a
-- manager; P0002 not found or not visible; P0001 occurrence_resolved; 22023
-- reason_too_long.
create or replace function public.exception_evidence_remove(
  p_id      uuid,
  p_reason  text default null
)
returns public.exception_evidence
language plpgsql
security definer
set search_path = public
set lock_timeout = '5s'
as $$
declare
  v_uid    uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_occ_id uuid;
  v_occ    public.exception_occurrences%rowtype;
  v_ev     public.exception_evidence%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if char_length(v_reason) > 500 then
    raise exception 'reason_too_long' using errcode = '22023', hint = 'reason_too_long';
  end if;

  select e.occurrence_id into v_occ_id
    from public.exception_evidence e
   where e.id = p_id;
  if not found then
    raise exception 'evidence_not_found' using errcode = 'P0002';
  end if;

  -- Visible occurrence, locked; anything else reads as not found.
  select o.* into v_occ
    from public.exception_occurrences o
   where o.id = v_occ_id
     and public._exc_occurrence_visible(o.organization_id, o.item_id, o.location_id)
   for update;
  if not found then
    raise exception 'evidence_not_found' using errcode = 'P0002';
  end if;

  select e.* into v_ev
    from public.exception_evidence e
   where e.id = p_id
     and e.occurrence_id = v_occ.id
     and e.organization_id = v_occ.organization_id
   for update;
  if not found then
    raise exception 'evidence_not_found' using errcode = 'P0002';
  end if;

  -- The act gate, then: your own photo, or a manager.
  if not public._exc_occurrence_can_act(v_occ.organization_id, v_occ.warehouse_id, v_occ.item_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_ev.uploaded_by is distinct from v_uid
     and not public.has_org_role(v_occ.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_ev.removed_at is not null then
    return v_ev;
  end if;

  if v_occ.resolved_at is not null then
    raise exception 'occurrence_resolved' using errcode = 'P0001', hint = 'occurrence_resolved';
  end if;

  update public.exception_evidence
     set removed_at = now(),
         removed_by = v_uid
   where id = v_ev.id
  returning * into v_ev;

  insert into public.exception_occurrence_events
    (organization_id, occurrence_id, kind, actor_user_id, evidence_id, note)
  values
    (v_occ.organization_id, v_occ.id, 'evidence_removed', v_uid, v_ev.id, v_reason);

  return v_ev;
end;
$$;

revoke all on function public.exception_evidence_remove(uuid, text) from public, anon;
grant execute on function public.exception_evidence_remove(uuid, text) to authenticated;

comment on function public.exception_evidence_remove(uuid, text) is
  'Soft-removes one photo from an exception occurrence (0375): the uploader '
  'or a manager, both through the act gate, while the occurrence is open. '
  'Keeps the row and the stored file; writes an evidence_removed event with '
  'the reason. Idempotent on an already removed photo. P0002 when not '
  'visible; P0001 occurrence_resolved.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. The timeline's evidence reference
-- ═══════════════════════════════════════════════════════════════════════════
-- 0370 left exception_occurrence_events.evidence_id as a bare uuid. It gets
-- its foreign key now, NOT VALID first and then VALIDATEd, so the table is
-- not scanned under the ACCESS EXCLUSIVE lock that ADD CONSTRAINT takes. In
-- this single-transaction file that lock is still held until the commit
-- (see LOCKS); the table is small. No row names a photo yet, so validation
-- cannot fail. NO ACTION on delete: a photo row is never deleted on its own
-- (removal is soft); it goes only with its occurrence or org, in the same
-- statement as the events that name it.
alter table public.exception_occurrence_events
  add constraint exception_occurrence_events_evidence_id_fkey
  foreign key (evidence_id) references public.exception_evidence(id)
  not valid;
alter table public.exception_occurrence_events
  validate constraint exception_occurrence_events_evidence_id_fkey;

-- Evidence events, and only they, name a photo.
alter table public.exception_occurrence_events
  add constraint exc_occ_events_evidence_kind check (
    (kind in ('evidence_added', 'evidence_removed')) = (evidence_id is not null))
  not valid;
alter table public.exception_occurrence_events
  validate constraint exc_occ_events_evidence_kind;

create index if not exists exc_occ_events_evidence_idx
  on public.exception_occurrence_events (evidence_id) where evidence_id is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Bucket exception-evidence (cloned from 0315). LAST: see LOCKS.
-- ═══════════════════════════════════════════════════════════════════════════
-- Nothing may follow the policy below but the lock_timeout reset
-- (storage-policy-order.guard.test.ts).
--
-- The server re-encodes the upload (dropping EXIF, including GPS) and writes
-- the thumbnail itself, both with the service role; the INSERT policy is the
-- floor for the client's signed-upload PUT of the original.
insert into storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
values (
  'exception-evidence', 'exception-evidence', false,
  array['image/png','image/jpeg','image/webp'],
  10 * 1024 * 1024
)
on conflict (id) do nothing;

-- Org-prefix write with the 0312/0315 INLINE disabled-account guard
-- (account_is_disabled() is EXECUTE-revoked from authenticated, so only the
-- inlined form works inside a storage policy). Two differences from 0315:
--   * the first folder is compared as TEXT, so a first folder that is not a
--     uuid is a plain RLS refusal (42501) instead of a 22P02 cast error;
--   * the WHOLE name must be the shape a mint hands out,
--     {uuid}/{uuid}/{uuid}.(jpg|jpeg|png|webp). A thumbnail name
--     ({uuid}-thumb.webp) is the server's alone: no member can create one, so
--     no member can ever put their own bytes where a thumbnail is read from.
create policy "exception-evidence org write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'exception-evidence'
    and name ~ ('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                || '\.(jpg|jpeg|png|webp)$')
    and (storage.foldername(name))[1] in (
      select m.organization_id::text
        from public.organization_members m
       where m.user_id = (select auth.uid()) and m.accepted_at is not null
    )
    and not exists (
      select 1 from public.user_profiles up
       where up.id = (select auth.uid()) and up.disabled_at is not null
    )
  );

reset lock_timeout;
