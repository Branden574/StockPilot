-- 0389_order_secrets_expand.sql
--
-- SECURITY (slice B, "order secrets, expand"): from this migration on, a newly
-- minted order signature token is stored in order_requests.signature_token as
-- its SHA-256 digest; the raw token lives only in a new service-only table.
-- One table (order_request_secrets), two SECURITY DEFINER functions
-- (generate_order_packing_slips, order_return_token_ensure), grants and
-- comments. No existing row is written, no existing function body changes
-- (confirm_order_signature keeps md5(prosrc) 8afdbb68f11dd4e8dcff3283b42f3b13,
-- and so does every other order RPC and the 0387 guard), and no policy,
-- trigger or column on order_requests is added or dropped.
--
-- ── THE HOLE (pre-existing; read on production 2026-10-03) ─────────────────
-- order_requests_select admits every accepted member (viewers included) and
-- authenticated holds column SELECT on every order_requests column. So every
-- member reads every order's raw signature_token (the bearer credential of
-- the public hand-over: one POST to /api/v1/orders/sign with it, any name,
-- email and image completes the order), its return_token and its
-- public_track_token, through PostgREST, through the supabase_realtime
-- publication (the UPDATE that mints the token carries it to every member
-- subscribed), through GET /api/v1/orders/[id] (the whole row) and through the
-- warehouse packing-slip PDF (a QR of the token, for any member). Production
-- 2026-10-03: 81 signature tokens, 2 of them signable now; 48 return and 49
-- track tokens.
--
-- A column SELECT revoke is not the fix: it fails `select *`, the INVOKER
-- create_order_request (`returning *`) and every installed phone's order
-- screen, which names signature_token (audit-tokens section 6).
--
-- ── WHAT THIS MIGRATION DOES ───────────────────────────────────────────────
--   1. order_request_secrets: the raw signature token of the current mint,
--      the requester return token, the public track token, and (empty until
--      slice C moves them) the stored signature image. RLS on, no policy, no
--      privilege for anon or authenticated, never in supabase_realtime: only
--      the admin client (service_role) and SECURITY DEFINER bodies reach it.
--      Shaped like order_email_log. FK to order_requests ON DELETE CASCADE
--      (the unconfirmed-order cleanup and the portal and public submit
--      rollbacks delete orders) and to organizations ON DELETE CASCADE.
--   2. generate_order_packing_slips(order): the packing-slip mint, moved off
--      the user client. Under the order's row lock it checks the status and
--      that the order is unsigned, mints 32 random bytes, upserts the raw
--      token into the side table and writes the digest, the status
--      packing_slip_generated, the stamps and a 30-day expiry onto the order,
--      in ONE transaction, so the raw token and the digest always agree.
--   3. order_return_token_ensure(order): the return-token mint for the admin
--      client (service_role only). Atomic and never rotating: an existing
--      side token wins, else the legacy column value (already emailed) is
--      reused, else a new uuid.
--
-- What it does NOT do (slice C, after the 12-hour skew window): hash the
-- tokens minted before this migration, move the return and track tokens and
-- the signature images, revoke UPDATE on the token columns. Until C the app
-- reads the side table first and the order column second, and the sign route
-- accepts a raw column value only when no side row hashes to it (a token
-- minted before this migration, or by a pre-deploy tab in the skew window).
--
-- ── WHO READS THE DIGEST ───────────────────────────────────────────────────
-- confirm_order_signature (frozen) compares order_requests.signature_token
-- with its p_signature_token argument. The sign route passes the DIGEST:
-- sha256(presented) for a link (the raw token from a QR or the panel), or the
-- presented value itself for an entitled signed-in member (installed phones
-- read the column and post it with their bearer) or a legacy raw column. A
-- member who reads a digest completes nothing without that entitled session.
--
-- ── LOCK FOOTPRINT (scripts/db-concurrency/0389_migration_lock_footprint.sh)
-- The push runs this file as one transaction. CREATE TABLE's foreign keys add
-- RI triggers to order_requests and organizations: SHARE ROW EXCLUSIVE on
-- both until commit. COMMENT ON COLUMN takes SHARE UPDATE EXCLUSIVE on
-- order_requests. Neither blocks a read (ACCESS SHARE) or SELECT ... FOR
-- UPDATE (ROW SHARE); writes to those two tables wait while the file runs
-- (milliseconds: no row is written here, so no row lock is ever waited on and
-- no deadlock with an order RPC is possible). lock_timeout 5s bounds the wait
-- to acquire them (55P03 then, never 40001/40P01): retry the push.
--
-- ── ERRORS ─────────────────────────────────────────────────────────────────
-- generate_order_packing_slips: 42501 unauthenticated; P0002
-- order_request_not_found (also for a non-member: existence is not
-- disclosed); P0001 module_disabled; 42501 forbidden hint orders_approve;
-- 42501 forbidden hint warehouse_write; P0001 packing_slips_not_ready (detail
-- = the status); P0001 order_already_signed; 55P03 on a lock wait over 5 s.
-- Never 40001 or 40P01 (0367; PostgREST retries 40001 forever).

set lock_timeout = '5s';

-- ── 1. The side table ──────────────────────────────────────────────────────
create table public.order_request_secrets (
  order_request_id   uuid primary key references public.order_requests(id) on delete cascade,
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  signature_token    text unique check (signature_token ~ '^[0-9a-f]{64}$'),
  return_token       uuid unique,
  public_track_token text unique check (public_track_token ~ '^[0-9a-f]{64}$'),
  signature_data_url text check (signature_data_url is null or length(signature_data_url) <= 524288),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index order_request_secrets_org_idx on public.order_request_secrets (organization_id);
alter table public.order_request_secrets enable row level security;
-- Supabase's default privileges grant every new public table to anon,
-- authenticated and service_role (arwdDxtm): take them back, then give the
-- admin client exactly the four DML privileges it uses.
revoke all on table public.order_request_secrets from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.order_request_secrets to service_role;

comment on table public.order_request_secrets is
  'Raw order bearer secrets (0389): the signature token of the current packing-slip mint, the '
  'requester return token, the public track token, and (from slice C) the stored signature image. '
  'Read and written only by the admin client (service_role) and SECURITY DEFINER functions: RLS on, '
  'no policy, no grant to anon or authenticated, never in supabase_realtime. '
  'order_requests.signature_token holds encode(digest(signature_token, ''sha256''), ''hex'') for every '
  'token minted since 0389; a side token whose digest no longer equals the order column (cleared by '
  'reopen_picking or resume_fulfillment, or re-minted) is stale and every reader ignores it.';
comment on column public.order_request_secrets.organization_id is
  'The order''s organization, copied from the order row by every writer (0389); for the cascade and '
  'per-organization reads only.';
comment on column public.order_request_secrets.signature_token is
  'Raw signature token (64 hex) of the latest generate_order_packing_slips mint (0389). Valid only while '
  'its sha256 equals order_requests.signature_token.';
comment on column public.order_request_secrets.return_token is
  'Requester return token (/returns/request/<token>), minted once by order_return_token_ensure and never '
  'rotated (0389). Until slice C an older value may still sit in order_requests.return_token; readers '
  'take this one first.';
comment on column public.order_request_secrets.public_track_token is
  'Public tracking token (/r/track &t=), written by the public submit since 0389. Until slice C older '
  'values sit in order_requests.public_track_token; readers take this one first.';
comment on column public.order_request_secrets.signature_data_url is
  'The captured digital signature image. Empty until slice C moves images off the member-readable '
  'order row (owner decision O1); added in 0389 so the signature route already reads it first.';

-- ── 2. The packing-slip mint ───────────────────────────────────────────────
create or replace function public.generate_order_packing_slips(p_id uuid)
returns public.order_requests
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_row public.order_requests%rowtype;
  v_raw text;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  -- Gates answered from an UNLOCKED read: a caller who may not mint never
  -- waits on, or holds, the order row.
  select o.organization_id into v_org from public.order_requests o where o.id = p_id;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if not public.module_enabled(v_org, 'orders') then
    raise exception 'module_disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;
  if not public.has_permission(v_org, 'orders:approve') then
    raise exception 'forbidden' using errcode = '42501', hint = 'orders_approve';
  end if;

  -- FOR NO KEY UPDATE, the lock the UPDATE below takes anyway: it serializes
  -- this mint with every other writer of the order (two mints, reopen,
  -- resume, cancel, stage), so the status and signed checks below read the
  -- row the write will change. It does NOT conflict with FOR KEY SHARE, the
  -- lock a child-row insert's foreign-key check takes, so the side-table
  -- insert of order_return_token_ensure or the public submit can never wait
  -- on this mint while it waits on them (no deadlock, no 40P01).
  select * into v_row from public.order_requests o where o.id = p_id for no key update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if not public.user_can_access_inventory(v_uid, v_row.warehouse_id, null, 'write') then
    raise exception 'forbidden' using errcode = '42501', hint = 'warehouse_write';
  end if;
  if v_row.status not in ('picking_complete', 'packing_slip_generated') then
    raise exception 'packing_slips_not_ready'
      using errcode = 'P0001', hint = 'packing_slips_not_ready', detail = v_row.status;
  end if;
  if v_row.signed_at is not null then
    raise exception 'order_already_signed' using errcode = 'P0001', hint = 'order_already_signed';
  end if;

  -- 32 CSPRNG bytes as 64 lowercase hex, the format every reader expects.
  -- Regenerating re-mints (a printed QR is voided; today's intended behaviour).
  v_raw := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.order_request_secrets (order_request_id, organization_id, signature_token)
  values (p_id, v_row.organization_id, v_raw)
  on conflict (order_request_id) do update
    set signature_token = excluded.signature_token,
        updated_at      = now();

  update public.order_requests o
     set status                     = 'packing_slip_generated',
         packing_slip_generated_at  = now(),
         packing_slip_generated_by  = v_uid,
         signature_token            = encode(extensions.digest(v_raw, 'sha256'), 'hex'),
         signature_token_expires_at = now() + interval '30 days'
   where o.id = p_id
  returning o.* into v_row;

  return v_row;
end;
$$;

comment on function public.generate_order_packing_slips(uuid) is
  'Packing-slip mint (0389), called by OrderRequestsService.generatePackingSlips through the user '
  'client. SECURITY DEFINER; gates in its own body: signed in (42501), an accepted member of the '
  'order''s organization (else P0002 order_request_not_found), the orders module (P0001 '
  'module_disabled), effective orders:approve (42501 hint orders_approve), write access to the order''s '
  'warehouse (42501 hint warehouse_write). Under the order row lock (FOR NO KEY UPDATE): status '
  'picking_complete or packing_slip_generated (else P0001 packing_slips_not_ready, detail = status), '
  'unsigned (else P0001 order_already_signed). Writes the raw token to order_request_secrets and its '
  'sha256 hex, the status, the stamps and a 30-day expiry to the order in one transaction. Returns the '
  'order row, which carries the digest, never the raw token.';

revoke all on function public.generate_order_packing_slips(uuid) from public, anon, service_role;
grant execute on function public.generate_order_packing_slips(uuid) to authenticated;

-- ── 3. The return-token mint (admin client only) ───────────────────────────
create or replace function public.order_return_token_ensure(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_org    uuid;
  v_legacy uuid;
  v_tok    uuid;
begin
  select o.organization_id, o.return_token into v_org, v_legacy
    from public.order_requests o
   where o.id = p_order_id;
  if v_org is null then
    return null;
  end if;

  -- Never rotates: an existing side token wins; else the token already in
  -- the order column (it may be in someone's inbox) moves over unchanged;
  -- else a new one. Two concurrent calls: the second waits on the first's
  -- row, then takes the ON CONFLICT branch and returns the same token.
  insert into public.order_request_secrets (order_request_id, organization_id, return_token)
  values (p_order_id, v_org, coalesce(v_legacy, gen_random_uuid()))
  on conflict (order_request_id) do update
    set return_token = coalesce(public.order_request_secrets.return_token, excluded.return_token),
        updated_at   = now()
  returning return_token into v_tok;

  return v_tok;
end;
$$;

comment on function public.order_return_token_ensure(uuid) is
  'The order''s requester return token (0389), minted at most once and never rotated: the side-table '
  'token if one exists, else the legacy order_requests.return_token value, else a new uuid. '
  'service_role only (the return prompt, server/email/return-prompt.ts). Null for an unknown order.';

revoke all on function public.order_return_token_ensure(uuid) from public, anon, authenticated;
grant execute on function public.order_return_token_ensure(uuid) to service_role;

-- ── 4. The order column says what it now holds ─────────────────────────────
comment on column public.order_requests.signature_token is
  'Since 0389: sha256 hex of the raw signature token, which lives only in order_request_secrets '
  '(written by generate_order_packing_slips). Tokens minted before 0389 are still raw here until '
  'slice C hashes them. confirm_order_signature compares this column with its argument, so the sign '
  'route passes the digest. Cleared by reopen_picking and resume_fulfillment.';

reset lock_timeout;
