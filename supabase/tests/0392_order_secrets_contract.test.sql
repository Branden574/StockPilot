-- supabase/tests/0392_order_secrets_contract.test.sql
-- pgTAP proof for migration 0392 (slice C "order secrets, contract", slice E
-- "delivery write cleanup", plan section 10 item 14).
--
-- R. The replay. The data steps are the migration's own statements, read back
--    from supabase_migrations.schema_migrations (the CLI records every
--    statement it applied) and run again here on fixtures: what is tested is
--    the text that ran, not a copy. R0: each of the two blocks is recorded
--    exactly once. R1: the lock prelude takes EXCLUSIVE (never ACCESS
--    EXCLUSIVE) on order_requests, order_request_secrets and shipments.
-- X. The abort-on-mismatch checks, each proven to raise on a planted
--    mismatch, run in a self-undoing subtransaction BEFORE the real replay:
--    an off-format token; a live raw token already in another order's side
--    row; a raw token whose digest is another order's column; a side copy
--    altered on the way in, or skipped; a hash altered, or skipped; an
--    updated_at bumped; a return token lost on the way in; a null-out
--    skipped, or undone; an off-format track token; a side return token that
--    differs from the column; a link token in another order's side row; a
--    shipments column changed, or a shipments row skipped; a signature token
--    moved after steps 1 and 2; a 0389 digest or another side token moved;
--    (test stage) a side copy that stops verifying after the hash; a dead
--    order that turns live without a side token; a token that appears on an
--    order; a link row that never lands; a return or a track token changed
--    in the side table after the null-out; (review stage) a live 0389 digest
--    that lost its side token (it cannot be told from a raw token); one track
--    token in two orders' columns; an error the block does not foresee (a
--    NOT VALID check), which aborts with its SQLSTATE and constraint name and
--    never prints a token. Every one of the data block's 29 check sites is
--    covered: 27 by a planted mismatch here, and the two that cannot be
--    planted without editing the block (the classification count, which is a
--    tautology, and the trigger-state check) by the mutation driver
--    (sec-orders/mutate-0392.py D10, D11); the unforeseen-error wrapper by
--    X28 and D20.
--    X0: after all of them the fixtures are byte for byte as before.
-- D. The data steps on fixtures covering every shape: live raw tokens at
--    each of the four live statuses (one expired, one in a second
--    organization), dead raw tokens (signed and completed, cancelled), a 0389
--    digest, a stale side token under a live and under a dead raw column,
--    orders with only a return token, only a track token, both, both plus a
--    0389 side row, a return token already copied to the side table, an order
--    with no secret, and shipments with an expired, a live and no token.
--    Digests stay; live raw tokens are copied and hashed; dead ones are
--    hashed and not copied; return and track tokens move with the same value
--    and the columns are null; every other column, updated_at and the image
--    included, is unchanged; the untouched order is byte-identical; the
--    shipments step nulls only the expired token and keeps updated_at; both
--    updated_at triggers are on again; no notification is written; a printed
--    QR (the raw token) still completes the hand-over through its digest,
--    the raw value no longer does; a viewer reads digests and nulls.
-- G. The write side and the guard, as `authenticated`, each attempt undone:
--    the packing slip and in transit are refused raw (status edge); the nine
--    revoked columns are 42501 permission denied, and with each granted back
--    the guard alone refuses a change (column_through_rpc_only); a raw PATCH
--    cannot name a driver (the 0384 follow-up) nor rewrite a signed order's
--    token; item 14: the pick slip and the staging stamp the caller only on
--    their own edge, at the database's clock, and refuse a forged or missing
--    *_by and any rewrite off the edge; a pickup order is staged only for
--    pickup and a delivery order only for delivery; denied_reason only with
--    the deny; notes save at every status; the owner questions' columns stay
--    writable (pins current behaviour); the order RPCs (mint, assignment, in
--    transit) still work, and an assigned staff driver without
--    orders:approve is refused in transit (O3 default); service_role is not
--    held. Account deletion (desk check F5): deleting a requester, an
--    approver who stamped every edge, and a driver still succeeds through
--    the restated guard (the FK actions run as the table owner, even when the
--    deleting session is authenticated), nulls exactly their columns, and
--    changes nothing else on the order. (Review stage) the admin client
--    (service_role) may neither insert an order carrying a return token, a
--    track token or an image, nor put a return or track token on a row; a
--    value already on a row may stay or be cleared.
-- P. Posture: the guard's body, INVOKER, search_path, owner, no EXECUTE, its
--    trigger, its errcodes (42501 only) and hints, comments; authenticated's
--    UPDATE columns are exactly the ten; the frozen bodies keep their md5.
--
-- Mutation table (sec-orders/mutate-0392.py, --db): each row names what
-- turns red.
--   M1  step 2 hashes every token, digests included (no digest exclusion)  -> R2 (hash_count raises; nothing applied)
--   M2  step 1 skipped with its checks                                      -> R2 (live_unverified), D2
--   M3  updated_at trigger left enabled                                     -> R2 (other_columns_changed raises; nothing applied)
--   M4  dead tokens copied too                                              -> D3
--   M5  return/track nulled before the presence check, check removed       -> X7
--   M6  the guard keeps the packing-slip edge                               -> G1, 0387 A7 13
--   M7  the guard keeps the in-transit edge (and the grants back)           -> G2, 0384 KO7
--   M8  the guard without the stamp-by-caller rule                          -> G5, G10
--   M9  the guard without the off-edge stamp rule                           -> G8, G12, G13b
--   M10 the guard without the fulfillment rule                              -> G9
--   M11 the guard without the RPC-owned column rule (revokes undone)        -> G4
--   M12 the guard checks *_at against the caller's value (no now())         -> G6, G11
--   M13 skip the revoke of the token columns                                -> G3, 0384 KO5, P2
--   M14 the lock prelude takes ACCESS EXCLUSIVE                             -> R1
--   M15 the shipments step without disabling its updated_at trigger        -> R2 (shipments_changed), D8
--   M16 the guard keyed on the JWT role instead of current_user             -> G21 (the FK action carries the deleting session's JWT)
--   (review stage; driver keys D18-D20, G11, G12)
--   M17 the live-orphan refusal dropped                                     -> X26
--   M18 the duplicate-track precheck dropped                                -> X27
--   M19 the unexpected-error wrapper re-raises every error as is           -> X28
--   M20 the guard without the link-token rule                               -> G24a, 0387 AL7
--   M21 the insert guard without the admin-client secret rule               -> G23
--
-- Roles: fixtures as the test superuser. Attempts run through pg_temp.attempt
-- (always undone) or pg_temp.call_as (kept), the 0387 helpers. begin/rollback:
-- nothing leaks. Namespace 03920000.

begin;

select plan(81);

\set orgA   '\'03920000-0000-0000-0000-00000000000a\''
\set orgB   '\'03920000-0000-0000-0000-00000000000b\''
\set own    '\'03920000-0000-0000-0000-0000000000a0\''
\set mgr    '\'03920000-0000-0000-0000-0000000000a1\''
\set req    '\'03920000-0000-0000-0000-0000000000a2\''
\set stf    '\'03920000-0000-0000-0000-0000000000a3\''
\set stfAp  '\'03920000-0000-0000-0000-0000000000a4\''
\set drv    '\'03920000-0000-0000-0000-0000000000a5\''
\set vwr    '\'03920000-0000-0000-0000-0000000000a6\''
\set mgrB   '\'03920000-0000-0000-0000-0000000000b1\''
\set outsider '\'03920000-0000-0000-0000-0000000000c9\''
\set whA    '\'03920000-0000-0000-0000-0000000000d1\''
\set whA2   '\'03920000-0000-0000-0000-0000000000d2\''
\set whB    '\'03920000-0000-0000-0000-0000000000d3\''
\set chA    '\'03920000-0000-0000-0000-0000000000e1\''
\set chB    '\'03920000-0000-0000-0000-0000000000e2\''
-- Data-step orders.
\set dLivePick   '\'03920000-0000-0000-0000-000000000101\''
\set dLiveTrans  '\'03920000-0000-0000-0000-000000000102\''
\set dLivePack   '\'03920000-0000-0000-0000-000000000103\''
\set dLiveSD     '\'03920000-0000-0000-0000-000000000104\''
\set dDeadSigned '\'03920000-0000-0000-0000-000000000105\''
\set dDeadCancel '\'03920000-0000-0000-0000-000000000106\''
\set dDigest     '\'03920000-0000-0000-0000-000000000107\''
\set dStaleLive  '\'03920000-0000-0000-0000-000000000108\''
\set dStaleDead  '\'03920000-0000-0000-0000-000000000109\''
\set dRetOnly    '\'03920000-0000-0000-0000-000000000110\''
\set dTrkOnly    '\'03920000-0000-0000-0000-000000000111\''
\set dBoth       '\'03920000-0000-0000-0000-000000000112\''
\set dSideSame   '\'03920000-0000-0000-0000-000000000113\''
\set dNone       '\'03920000-0000-0000-0000-000000000114\''
-- Shipments.
\set shExp  '\'03920000-0000-0000-0000-000000000201\''
\set shLive '\'03920000-0000-0000-0000-000000000202\''
\set shNone '\'03920000-0000-0000-0000-000000000203\''
-- Guard orders (inserted after the replay).
\set gApproved  '\'03920000-0000-0000-0000-000000000301\''
\set gPickSlip  '\'03920000-0000-0000-0000-000000000302\''
\set gPackP     '\'03920000-0000-0000-0000-000000000303\''
\set gPackD     '\'03920000-0000-0000-0000-000000000304\''
\set gStaged    '\'03920000-0000-0000-0000-000000000305\''
\set gPending   '\'03920000-0000-0000-0000-000000000306\''
\set gDenied    '\'03920000-0000-0000-0000-000000000307\''
\set gPickComp  '\'03920000-0000-0000-0000-000000000308\''
\set gSFD       '\'03920000-0000-0000-0000-000000000309\''
\set gSFD2      '\'03920000-0000-0000-0000-000000000310\''
\set gSignedDone '\'03920000-0000-0000-0000-000000000311\''
\set gDelR      '\'03920000-0000-0000-0000-000000000312\''
\set gDelA      '\'03920000-0000-0000-0000-000000000313\''
\set delReq     '\'03920000-0000-0000-0000-0000000000f1\''
\set delApr     '\'03920000-0000-0000-0000-0000000000f2\''
\set delDrv     '\'03920000-0000-0000-0000-0000000000f3\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,      '0392-own@test.local',      '{}'::jsonb),
  (:mgr,      '0392-mgr@test.local',      '{}'::jsonb),
  (:req,      '0392-req@test.local',      '{}'::jsonb),
  (:stf,      '0392-stf@test.local',      '{}'::jsonb),
  (:stfAp,    '0392-stfap@test.local',    '{}'::jsonb),
  (:drv,      '0392-drv@test.local',      '{}'::jsonb),
  (:vwr,      '0392-vwr@test.local',      '{}'::jsonb),
  (:mgrB,     '0392-mgrb@test.local',     '{}'::jsonb),
  (:outsider, '0392-outsider@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, '0392 Contract A', '0392-contract-a'),
  (:orgB, '0392 Contract B', '0392-contract-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,   'owner',   now()),
  (:orgA, :mgr,   'manager', now()),
  (:orgA, :req,   'staff',   now()),
  (:orgA, :stf,   'staff',   now()),
  (:orgA, :stfAp, 'staff',   now()),
  (:orgA, :drv,   'staff',   now()),
  (:orgA, :vwr,   'viewer',  now()),
  (:orgB, :mgrB,  'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA,  :orgA, '0392 Main',  'WH-0392A',  'active'),
  (:whA2, :orgA, '0392 Annex', 'WH-0392A2', 'active'),
  (:whB,  :orgB, '0392 Bee',   'WH-0392B',  'active');
insert into public.charters (id, organization_id, name, code, status) values
  (:chA, :orgA, '0392 Charter A', 'CH-0392A', 'active'),
  (:chB, :orgB, '0392 Charter B', 'CH-0392B', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :req,   :whA, true),
  (:orgA, :stf,   :whA, true),
  (:orgA, :stfAp, :whA, true),
  (:orgA, :drv,   :whA, true),
  (:orgA, :vwr,   :whA, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :stfAp, 'orders:approve', true);

-- The secrets, by name (64 lowercase hex, uuids for return tokens).
create temp table k (n text primary key, v text not null);
insert into k values
  ('T1', repeat('a1', 32)), ('T2', repeat('a2', 32)), ('T3', repeat('a3', 32)), ('T4', repeat('a4', 32)),
  ('T5', repeat('a5', 32)), ('T6', repeat('a6', 32)), ('T7', repeat('a7', 32)), ('T8', repeat('a8', 32)),
  ('T9', repeat('a9', 32)), ('T10', repeat('b0', 32)), ('T11', repeat('b1', 32)), ('T12', repeat('b2', 32)),
  ('K1', repeat('c1', 32)), ('K2', repeat('c2', 32)), ('K3', repeat('c3', 32)),
  ('R1', '03920000-0000-4000-8000-0000000000f1'), ('R2', '03920000-0000-4000-8000-0000000000f2'),
  ('R3', '03920000-0000-4000-8000-0000000000f3'), ('R4', '03920000-0000-4000-8000-0000000000f4'),
  ('S1', repeat('d1', 32)), ('S2', repeat('d2', 32)),
  ('IMG', 'data:image/png;base64,' || repeat('Q', 400));
create function pg_temp.k(p text) returns text language sql stable as $$ select v from k where n = p $$;
create function pg_temp.sha(p text) returns text language sql immutable as $$
  select encode(extensions.digest(p, 'sha256'), 'hex')
$$;

insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, delivery_charter_id,
   approved_by, approved_at, signed_at, signature_method, signature_data_url,
   signature_token, signature_token_expires_at, return_token, public_track_token, assigned_delivery_user_id,
   internal_notes, updated_at) values
  (:dLivePick,   :orgA, :whA, 'staged_for_pickup',      'internal', :req, 'pickup',   null, :mgr, now(), null,  null, null,
   pg_temp.k('T1'), now() + interval '1 day', null, null, null, 'n1', now() - interval '3 days'),
  (:dLiveTrans,  :orgA, :whA, 'in_transit',             'internal', :req, 'delivery', :chA, :mgr, now(), null,  null, null,
   pg_temp.k('T2'), now() - interval '1 day', null, null, :drv, null, now() - interval '3 days'),
  (:dLivePack,   :orgA, :whA, 'packing_slip_generated', 'internal', :req, 'delivery', :chA, :mgr, now(), null,  null, null,
   pg_temp.k('T3'), now() + interval '1 day', null, null, null, null, now() - interval '3 days'),
  (:dLiveSD,     :orgB, :whB, 'staged_for_delivery',    'internal', :mgrB, 'delivery', :chB, :mgrB, now(), null, null, null,
   pg_temp.k('T4'), now() + interval '1 day', null, null, null, null, now() - interval '3 days'),
  (:dDeadSigned, :orgA, :whA, 'completed',              'internal', :req, 'pickup',   null, :mgr, now(), now(), 'digital', pg_temp.k('IMG'),
   pg_temp.k('T5'), now() - interval '1 day', pg_temp.k('R1')::uuid, pg_temp.k('K1'), null, null, now() - interval '3 days'),
  (:dDeadCancel, :orgA, :whA, 'cancelled',              'internal', :req, 'pickup',   null, :mgr, now(), null,  null, null,
   pg_temp.k('T6'), now() - interval '9 days', null, null, null, null, now() - interval '3 days'),
  (:dDigest,     :orgA, :whA, 'staged_for_pickup',      'internal', :req, 'pickup',   null, :mgr, now(), null,  null, null,
   pg_temp.sha(pg_temp.k('T7')), now() + interval '1 day', null, null, null, null, now() - interval '3 days'),
  (:dStaleLive,  :orgA, :whA, 'staged_for_pickup',      'internal', :req, 'pickup',   null, :mgr, now(), null,  null, null,
   pg_temp.k('T8'), now() + interval '1 day', null, null, null, null, now() - interval '3 days'),
  (:dStaleDead,  :orgA, :whA, 'completed',              'internal', :req, 'pickup',   null, :mgr, now(), now(), 'physical', null,
   pg_temp.k('T10'), now() - interval '1 day', null, null, null, null, now() - interval '3 days'),
  (:dRetOnly,    :orgA, :whA, 'completed',              'internal', :req, 'pickup',   null, :mgr, now(), now(), 'physical', null,
   null, null, pg_temp.k('R2')::uuid, null, null, null, now() - interval '3 days'),
  (:dTrkOnly,    :orgA, :whA, 'denied',                 'internal', :req, 'pickup',   null, null, null,  null,  null, null,
   null, null, null, pg_temp.k('K2'), null, null, now() - interval '3 days'),
  (:dBoth,       :orgA, :whA, 'completed',              'internal', :req, 'pickup',   null, :mgr, now(), now(), 'digital', null,
   pg_temp.sha(pg_temp.k('T12')), now() - interval '1 day', pg_temp.k('R3')::uuid, pg_temp.k('K3'), null, null, now() - interval '3 days'),
  (:dSideSame,   :orgA, :whA, 'completed',              'internal', :req, 'pickup',   null, :mgr, now(), now(), 'physical', null,
   null, null, pg_temp.k('R4')::uuid, null, null, null, now() - interval '3 days'),
  (:dNone,       :orgA, :whA, 'approved',               'internal', :req, 'pickup',   null, :mgr, now(), null,  null, null,
   null, null, null, null, null, 'untouched', now() - interval '3 days');
-- The side rows 0389 (or a return prompt since 0389) left behind.
insert into public.order_request_secrets (order_request_id, organization_id, signature_token, return_token) values
  (:dDigest,    :orgA, pg_temp.k('T7'),  null),
  (:dStaleLive, :orgA, pg_temp.k('T9'),  null),
  (:dStaleDead, :orgA, pg_temp.k('T11'), null),
  (:dBoth,      :orgA, pg_temp.k('T12'), null),
  (:dSideSame,  :orgA, null,             pg_temp.k('R4')::uuid);
insert into public.shipments
  (id, organization_id, source_warehouse_id, work_order_number, destination_charter_id, notes,
   signature_token, signature_token_expires_at, updated_at) values
  (:shExp,  :orgA, :whA, 'ISR-0392-1', :chA, 'expired', pg_temp.k('S1'), now() - interval '30 days', now() - interval '40 days'),
  (:shLive, :orgA, :whA, 'ISR-0392-2', :chA, 'live',    pg_temp.k('S2'), now() + interval '5 days',  now() - interval '2 days'),
  (:shNone, :orgA, :whA, 'ISR-0392-3', :chA, 'none',    null,            null,                       now() - interval '2 days');

create temp table data_ids (id uuid primary key);
insert into data_ids values
  (:dLivePick), (:dLiveTrans), (:dLivePack), (:dLiveSD), (:dDeadSigned), (:dDeadCancel), (:dDigest),
  (:dStaleLive), (:dStaleDead), (:dRetOnly), (:dTrkOnly), (:dBoth), (:dSideSame), (:dNone);

-- ══ Helpers (the 0387 shapes) ═════════════════════════════════════════════
create function pg_temp.hint(p_hint text) returns text language sql immutable as $$
  select case when p_hint is null or p_hint = ''
                or p_hint like 'Grant the required privileges to the current role with:%'
              then '-' else p_hint end
$$;
-- One statement as p_as with p_sub's claims, then ALWAYS undone.
-- 'ok:<rows>[:<p_check>]', else '<sqlstate>:<hint or ->:<message>'.
create function pg_temp.attempt(p_as text, p_sub uuid, p_sql text, p_prep text default null, p_check text default null)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v_n bigint; v_seen text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql;
    get diagnostics v_n = row_count;
    perform set_config('role', 'none', true);
    if p_check is not null then
      execute p_check into v_seen;
    end if;
    raise exception using errcode = 'XX392', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX392' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
end $$;
-- One statement that returns a value, as p_as, KEPT when it succeeds.
create function pg_temp.call_as(p_as text, p_sub uuid, p_sql text, p_check text default null)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v text; v_seen text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', '', true);
    if p_check is not null then
      execute p_check into v_seen;
    end if;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
    return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
  end;
  return coalesce(v, 'null') || coalesce('|' || v_seen, '');
end $$;
-- The statements the CLI recorded for a migration that contain p_tag.
create function pg_temp.mig(p_version text, p_tag text) returns text language sql stable as $$
  select coalesce(string_agg(st, E';\n'), '')
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.version = p_version and position(p_tag in st) > 0
$$;
create function pg_temp.mig_count(p_version text, p_tag text) returns bigint language sql stable as $$
  select count(*)
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.version = p_version and position(p_tag in st) > 0
$$;
-- The data block run again after p_prep, ALWAYS undone: 'ok', or
-- '<sqlstate>:<message>' of what it raised.
create function pg_temp.try_move(p_prep text) returns text language plpgsql as $$
declare v_state text; v_msg text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    execute pg_temp.mig('0392', '$c392_move$');
    raise exception using errcode = 'XX392', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state = 'XX392' then
    return 'ok';
  end if;
  return v_state || ':' || v_msg;
end $$;
-- The same, returning '<sqlstate>:<message>:<detail>' (several checks share
-- a message and differ in their detail).
create function pg_temp.try_move_d(p_prep text) returns text language plpgsql as $$
declare v_state text; v_msg text; v_detail text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    execute pg_temp.mig('0392', '$c392_move$');
    raise exception using errcode = 'XX392', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_detail = pg_exception_detail;
  end;
  if v_state = 'XX392' then
    return 'ok';
  end if;
  return v_state || ':' || v_msg || ':' || coalesce(v_detail, '');
end $$;
-- Every fixture order and shipment, every column, as the superuser.
create function pg_temp.fixture_state() returns text language sql stable as $$
  select md5(coalesce((select string_agg(to_jsonb(o)::text, E'\n' order by o.id)
                         from public.order_requests o where o.id in (select id from data_ids)), ''))
         || md5(coalesce((select string_agg(to_jsonb(s)::text, E'\n' order by s.order_request_id)
                            from public.order_request_secrets s where s.order_request_id in (select id from data_ids)), ''))
         || md5(coalesce((select string_agg(to_jsonb(s)::text, E'\n' order by s.id)
                            from public.shipments s where s.organization_id = '03920000-0000-0000-0000-00000000000a'), ''))
$$;

-- Planted mismatches: trigger functions in a probe schema (gone with the
-- rollback); each test creates its trigger inside the undone subtransaction.
create schema zz_probe_0392;
create function zz_probe_0392.side_before() returns trigger language plpgsql as $$
begin
  if tg_argv[0] = 'hash_sig' and new.signature_token is not null then
    new.signature_token := encode(extensions.digest(new.signature_token, 'sha256'), 'hex');
  elsif tg_argv[0] = 'skip_sig' and new.signature_token is not null then
    return null;
  elsif tg_argv[0] = 'null_return' then
    new.return_token := null;
  elsif tg_argv[0] = 'skip_link' and new.signature_token is null
        and (new.return_token is not null or new.public_track_token is not null) then
    return null;
  end if;
  return new;
end $$;
create function zz_probe_0392.side_after() returns trigger language plpgsql as $$
begin
  if tg_argv[0] = 'touch_order' then
    update public.order_requests
       set signature_token = encode(extensions.digest('zz' || id::text, 'sha256'), 'hex')
     where id = tg_argv[1]::uuid;
  elsif tg_argv[0] = 'touch_side' then
    update public.order_request_secrets
       set signature_token = encode(extensions.digest('zz' || order_request_id::text, 'sha256'), 'hex')
     where order_request_id = tg_argv[1]::uuid;
  end if;
  return null;
end $$;
create function zz_probe_0392.order_before() returns trigger language plpgsql as $$
begin
  if tg_argv[0] = 'double_hash' and new.signature_token is distinct from old.signature_token then
    new.signature_token := md5(new.signature_token) || md5(new.id::text);
  elsif tg_argv[0] = 'skip_hash' and new.signature_token is distinct from old.signature_token then
    return null;
  elsif tg_argv[0] = 'bump_updated' then
    new.updated_at := old.updated_at + interval '1 second';
  elsif tg_argv[0] = 'skip_null_out' and old.return_token is not null and new.return_token is null then
    return null;
  elsif tg_argv[0] = 'keep_return' and old.return_token is not null and new.return_token is null then
    new.return_token := old.return_token;
  elsif tg_argv[0] = 'late_sig' and old.return_token is not null and new.return_token is null
        and new.signature_token is not null then
    new.signature_token := md5(new.signature_token) || md5(new.id::text);
  elsif tg_argv[0] = 'turn_live' and new.id = tg_argv[1]::uuid
        and new.signature_token is distinct from old.signature_token then
    new.status := 'staged_for_pickup';
  end if;
  return new;
end $$;
-- AFTER UPDATE on order_requests (test stage): a write that lands while the
-- data block updates orders, at the step tg_argv[0] names.
create function zz_probe_0392.order_after() returns trigger language plpgsql as $$
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  if tg_argv[0] = 'side_after_hash' and new.signature_token is distinct from old.signature_token then
    update public.order_request_secrets
       set signature_token = encode(extensions.digest('zz' || order_request_id::text, 'sha256'), 'hex')
     where order_request_id = tg_argv[1]::uuid;
  elsif tg_argv[0] = 'token_appears' and new.signature_token is distinct from old.signature_token then
    update public.order_requests set signature_token = repeat('ab', 32)
     where id = tg_argv[1]::uuid and signature_token is null;
  elsif tg_argv[0] = 'return_after_null' and old.return_token is not null and new.return_token is null then
    update public.order_request_secrets set return_token = gen_random_uuid() where order_request_id = new.id;
  elsif tg_argv[0] = 'track_after_null' and old.public_track_token is not null and new.public_track_token is null then
    update public.order_request_secrets
       set public_track_token = encode(extensions.digest('zz' || order_request_id::text, 'sha256'), 'hex')
     where order_request_id = new.id;
  end if;
  return null;
end $$;
create function zz_probe_0392.ship_before() returns trigger language plpgsql as $$
begin
  if tg_argv[0] = 'notes' then
    new.notes := coalesce(new.notes, '') || ' changed';
  elsif tg_argv[0] = 'skip' then
    return null;
  end if;
  return new;
end $$;

create temp table snap (k text primary key, v text);
insert into snap values ('fixtures', pg_temp.fixture_state());
-- Every column the data steps do not own, per fixture order.
create temp table other_before as
select o.id, (to_jsonb(o) - 'signature_token' - 'return_token' - 'public_track_token') as other, to_jsonb(o) as whole
  from public.order_requests o where o.id in (select id from data_ids);
create temp table ship_before as select s.id, to_jsonb(s) as whole from public.shipments s
 where s.organization_id = :orgA;
insert into snap values ('notifications',
  (select count(*)::text from public.notifications where organization_id in (:orgA, :orgB)));

-- ══ R. The recorded statements ════════════════════════════════════════════
select is(
  pg_temp.mig_count('0392', '$c392_lock$')::text || '/' || pg_temp.mig_count('0392', '$c392_move$')::text,
  '1/1',
  'R0: the CLI recorded the lock prelude and the data block of 0392 exactly once each (this suite replays that text)');

-- ══ X. Each abort-on-mismatch check raises on a planted mismatch ══════════
select is(
  pg_temp.try_move(format($q$update public.order_requests set signature_token = 'zz-not-hex-0392' where id = %L$q$, :dDeadCancel)),
  'P0001:order_secrets_contract_token_off_format',
  'X1: a signature token that is not 64 lowercase hex: refused before any write');
select is(
  pg_temp.try_move(format($q$update public.order_request_secrets set signature_token = %L where order_request_id = %L$q$,
                          pg_temp.k('T1'), :dStaleDead)),
  'P0001:order_secrets_contract_token_collision',
  'X2: a live raw token that already sits in another order''s side row: refused before any write');
select is(
  pg_temp.try_move(format($q$update public.order_requests set signature_token = %L where id = %L$q$,
                          pg_temp.sha(pg_temp.k('T5')), :dNone)),
  'P0001:order_secrets_contract_token_collision',
  'X3: a raw token whose digest is another order''s column (the unique index would stop step 2 half way): refused up front');
select is(
  pg_temp.try_move('create trigger zz_probe_0392_side before insert or update on public.order_request_secrets
                      for each row execute function zz_probe_0392.side_before(''hash_sig'')'),
  'P0001:order_secrets_contract_copy_mismatch',
  'X4: a side copy that is not the column value (altered on the way in): the copy checksum raises');
select is(
  pg_temp.try_move('create trigger zz_probe_0392_side before insert or update on public.order_request_secrets
                      for each row execute function zz_probe_0392.side_before(''skip_sig'')'),
  'P0001:order_secrets_contract_copy_count',
  'X5: a side copy that never lands: rows copied <> live raw tokens');
select is(
  pg_temp.try_move('create trigger zz_probe_0392_order before update on public.order_requests
                      for each row execute function zz_probe_0392.order_before(''double_hash'')'),
  'P0001:order_secrets_contract_hash_mismatch',
  'X6: a hashed column that is not sha256 of its old value: the hash checksum raises');
select is(
  pg_temp.try_move('create trigger zz_probe_0392_order before update on public.order_requests
                      for each row execute function zz_probe_0392.order_before(''skip_hash'')'),
  'P0001:order_secrets_contract_hash_count',
  'X7: a raw token left unhashed: rows hashed <> raw tokens');
select is(
  pg_temp.try_move(format('create trigger zz_probe_0392_after after insert on public.order_request_secrets
                             for each row execute function zz_probe_0392.side_after(''touch_order'', %L)', :dDigest)),
  'P0001:order_secrets_contract_digest_moved',
  'X8: a 0389 digest that moves while the tokens are copied: raises');
select is(
  pg_temp.try_move(format('create trigger zz_probe_0392_after after insert on public.order_request_secrets
                             for each row execute function zz_probe_0392.side_after(''touch_side'', %L)', :dStaleDead)),
  'P0001:order_secrets_contract_digest_moved',
  'X9: a side token outside the live set that moves: raises');
select is(
  pg_temp.try_move('create trigger zz_probe_0392_order before update on public.order_requests
                      for each row execute function zz_probe_0392.order_before(''late_sig'')'),
  'P0001:order_secrets_contract_signature_moved',
  'X10: a signature token that moves after steps 1 and 2 (while the return and track tokens are nulled): raises');
select is(
  pg_temp.try_move(format($q$do $p$ begin
                               alter table public.order_requests drop constraint order_requests_public_track_token_check;
                               update public.order_requests set public_track_token = 'short' where id = %L;
                             end $p$$q$, :dTrkOnly)),
  'P0001:order_secrets_contract_track_off_format',
  'X11: a track token that is not 64 hex (its column CHECK dropped for the test): refused before step 3 writes');
select is(
  pg_temp.try_move(format($q$insert into public.order_request_secrets (order_request_id, organization_id, return_token)
                             values (%L, %L, gen_random_uuid())$q$, :dRetOnly, :orgA)),
  'P0001:order_secret_copy_mismatch',
  'X12: a side return token that differs from the order''s column: refused before step 3 writes');
select is(
  pg_temp.try_move(format($q$insert into public.order_request_secrets (order_request_id, organization_id, return_token)
                             values (%L, %L, %L)$q$, :dNone, :orgA, pg_temp.k('R2'))),
  'P0001:order_secrets_contract_link_collision',
  'X13: a return token already in another order''s side row: refused before step 3 writes');
select is(
  pg_temp.try_move('create trigger zz_probe_0392_side before insert or update on public.order_request_secrets
                      for each row execute function zz_probe_0392.side_before(''null_return'')'),
  'P0001:order_secret_copy_mismatch',
  'X14: a return token that does not land in the side table: raises BEFORE any column is nulled');
select is(
  pg_temp.try_move('create trigger zz_probe_0392_order before update on public.order_requests
                      for each row execute function zz_probe_0392.order_before(''skip_null_out'')'),
  'P0001:order_secrets_contract_link_count',
  'X15: a column that is not nulled: rows nulled <> orders holding a return or track token');
select is(
  pg_temp.try_move('create trigger zz_probe_0392_order before update on public.order_requests
                      for each row execute function zz_probe_0392.order_before(''keep_return'')'),
  'P0001:order_secrets_contract_link_left',
  'X16: a return token still on the row after the null-out: raises');
select is(
  pg_temp.try_move('create trigger zz_probe_0392_order before update on public.order_requests
                      for each row execute function zz_probe_0392.order_before(''bump_updated'')'),
  'P0001:order_secrets_contract_other_columns_changed',
  'X17: an updated_at re-stamped by the data steps: the other-columns checksum raises');
select is(
  pg_temp.try_move('create trigger zz_probe_0392_ship before update on public.shipments
                      for each row execute function zz_probe_0392.ship_before(''notes'')'),
  'P0001:order_secrets_contract_shipments_changed',
  'X18: a shipments column other than the tokens changed: raises');
select is(
  pg_temp.try_move('create trigger zz_probe_0392_ship before update on public.shipments
                      for each row execute function zz_probe_0392.ship_before(''skip'')'),
  'P0001:order_secrets_contract_shipments_count',
  'X19: an expired shipment token left in place: rows nulled <> expired tokens');
-- Test stage: the raise sites the build's 19 did not reach.
select matches(
  pg_temp.try_move_d(format('create trigger zz_probe_0392_oafter after update on public.order_requests
                               for each row execute function zz_probe_0392.order_after(''side_after_hash'', %L)', :dLivePick)),
  '^P0001:order_secrets_contract_live_unverified:1 of \d+ copied tokens do not verify',
  'X20: a side copy that stops verifying once its column is hashed (changed after the copy checksum): the copied-tokens check raises');
select matches(
  pg_temp.try_move_d(format('create trigger zz_probe_0392_order before update on public.order_requests
                               for each row execute function zz_probe_0392.order_before(''turn_live'', %L)', :dDeadCancel)),
  '^P0001:order_secrets_contract_live_unverified:1 unsigned orders at a live status have no side token',
  'X21: a dead order that turns live while it is hashed (so it has no side token): the every-live-order check raises');
select matches(
  pg_temp.try_move_d(format('create trigger zz_probe_0392_oafter after update on public.order_requests
                               for each row execute function zz_probe_0392.order_after(''token_appears'', %L)', :dNone)),
  '^P0001:order_secrets_contract_token_count:\d+ tokens after \(\d+ before\)',
  'X22: a signature token that appears on another order while the tokens are hashed: the after-count raises');
select matches(
  pg_temp.try_move_d('create trigger zz_probe_0392_side before insert or update on public.order_request_secrets
                        for each row execute function zz_probe_0392.side_before(''skip_link'')'),
  '^P0001:order_secrets_contract_link_count:\d+ side rows written for \d+ orders',
  'X23: a link-token side row that never lands: rows written <> orders holding a return or track token');
select matches(
  pg_temp.try_move_d('create trigger zz_probe_0392_oafter after update on public.order_requests
                        for each row execute function zz_probe_0392.order_after(''return_after_null'')'),
  '^P0001:order_secret_copy_mismatch:The side table does not hold the \d+ return tokens',
  'X24: a return token changed in the side table after its column was nulled: the return checksum raises');
select matches(
  pg_temp.try_move_d('create trigger zz_probe_0392_oafter after update on public.order_requests
                        for each row execute function zz_probe_0392.order_after(''track_after_null'')'),
  '^P0001:order_secret_copy_mismatch:The side table does not hold the \d+ track tokens',
  'X25: a track token changed in the side table after its column was nulled: the track checksum raises');
-- Review stage: three more refusals.
select is(
  pg_temp.try_move(format($q$update public.order_requests set signature_token = %L where id = %L;
                             insert into public.order_request_secrets (order_request_id, organization_id, public_track_token)
                             values (%L, %L, %L)$q$,
                          pg_temp.sha(pg_temp.k('T1')), :dLivePick, :dLivePick, :orgA, repeat('e1', 32))),
  'P0001:order_secrets_contract_live_orphan',
  'X26: a live order whose column is a 0389 digest that lost its side token (its side row holds only a track token) is refused: copying it would make the member-readable digest a session-free link and stop the printed QR (it cannot be told from a raw token)');
select is(
  (select split_part(r, ':', 1) || ':' || split_part(r, ':', 2) || '|'
          || exists (select 1 from k where position(k.v in r) > 0)::text
     from (select pg_temp.try_move_d(format('update public.order_requests set public_track_token = %L where id = %L',
                                            pg_temp.k('K2'), :dBoth)) as r) x),
  'P0001:order_secrets_contract_link_collision|false',
  'X27: one track token held by two orders'' columns is refused before step 3 writes, with counts only (the side table''s unique index would stop the insert with the raw token in its error detail)');
select is(
  (select split_part(r, ':', 1) || ':' || split_part(r, ':', 2) || '|'
          || (r ~ '23514') || '|' || (r ~ 'zz_probe_0392_chk') || '|'
          || exists (select 1 from k where position(k.v in r) > 0)::text
     from (select pg_temp.try_move_d(
             'alter table public.order_requests add constraint zz_probe_0392_chk
                check (return_token is null or signature_token = ''x'') not valid') as r) x),
  'P0001:order_secrets_contract_unexpected_error|true|true|false',
  'X28: an error the block does not foresee (a NOT VALID check that a row breaks once its token is hashed; production holds one NOT VALID check) aborts with its SQLSTATE and constraint name only: the row the error would print (raw return and track tokens, the image) never reaches the output or the log');
select is(
  pg_temp.fixture_state(),
  (select v from snap where k = 'fixtures'),
  'X0: after the 28 refused runs every fixture order, side row and shipment is byte for byte as before (each raise undid everything)');

-- ══ The replay (kept) ═════════════════════════════════════════════════════
select lives_ok(pg_temp.mig('0392', '$c392_lock$'), 'R1a: the lock prelude replays');
select is(
  (select string_agg(c.relname || '=' || l.mode, ',' order by c.relname)
     from pg_locks l join pg_class c on c.oid = l.relation
    where l.pid = pg_backend_pid() and l.granted and l.locktype = 'relation'
      and c.relname in ('order_requests', 'order_request_secrets', 'shipments') and l.mode = 'ExclusiveLock')
  || '|' || (select count(*)::text
               from pg_locks l join pg_class c on c.oid = l.relation
              where l.pid = pg_backend_pid() and l.granted and l.locktype = 'relation'
                and c.relname in ('order_requests', 'order_request_secrets', 'shipments') and l.mode = 'AccessExclusiveLock'),
  'order_request_secrets=ExclusiveLock,order_requests=ExclusiveLock,shipments=ExclusiveLock|0',
  'R1: the prelude holds EXCLUSIVE on order_requests, order_request_secrets and shipments (K3: blocks writes and FOR UPDATE, never a read) and no ACCESS EXCLUSIVE');
select lives_ok(pg_temp.mig('0392', '$c392_move$'), 'R2: the data block runs on every fixture shape without raising');

-- ══ D. What the data steps did ════════════════════════════════════════════
select is(
  (select o.signature_token = pg_temp.sha(pg_temp.k('T7')) and s.signature_token = pg_temp.k('T7')
     from public.order_requests o join public.order_request_secrets s on s.order_request_id = o.id where o.id = :dDigest)::text
  || '/' ||
  (select o.signature_token = pg_temp.sha(pg_temp.k('T12')) and s.signature_token = pg_temp.k('T12')
     from public.order_requests o join public.order_request_secrets s on s.order_request_id = o.id where o.id = :dBoth)::text,
  'true/true',
  'D1: a 0389 digest stays exactly as it was, column and side token (a live one, and a dead one that also carries link tokens)');
select is(
  (select string_agg((o.signature_token = pg_temp.sha(r.raw) and s.signature_token = r.raw
                      and s.organization_id = o.organization_id)::text, ',' order by o.id)
     from (values (:dLivePick::uuid, pg_temp.k('T1')), (:dLiveTrans::uuid, pg_temp.k('T2')),
                  (:dLivePack::uuid, pg_temp.k('T3')), (:dLiveSD::uuid, pg_temp.k('T4'))) r(id, raw)
     join public.order_requests o on o.id = r.id
     left join public.order_request_secrets s on s.order_request_id = r.id),
  'true,true,true,true',
  'D2: each live raw token (staged for pickup, in transit and expired, packing slip, staged for delivery in another organization) is copied to the side table with its order''s organization, and its column is sha256 of it');
select is(
  (select string_agg((o.signature_token = pg_temp.sha(r.raw))::text || ':' || coalesce(s.signature_token is not null, false)::text,
                     ',' order by o.id)
     from (values (:dDeadSigned::uuid, pg_temp.k('T5')), (:dDeadCancel::uuid, pg_temp.k('T6'))) r(id, raw)
     join public.order_requests o on o.id = r.id
     left join public.order_request_secrets s on s.order_request_id = r.id),
  'true:false,true:false',
  'D3: a dead raw token (signed and completed; cancelled) is hashed in place and NOT copied: its raw value is left nowhere');
select is(
  (select (o.signature_token = pg_temp.sha(pg_temp.k('T8')) and s.signature_token = pg_temp.k('T8'))::text
     from public.order_requests o join public.order_request_secrets s on s.order_request_id = o.id where o.id = :dStaleLive)
  || '/' ||
  (select (o.signature_token = pg_temp.sha(pg_temp.k('T10')) and s.signature_token = pg_temp.k('T11'))::text
     from public.order_requests o join public.order_request_secrets s on s.order_request_id = o.id where o.id = :dStaleDead),
  'true/true',
  'D4: under a live raw column a stale side token is replaced by the raw one (the QR a pre-deploy tab printed); under a dead one it is left, and only the column is hashed');
select is(
  (select count(*)::text from public.order_requests
    where id in (select id from data_ids) and (return_token is not null or public_track_token is not null)),
  '0',
  'D5a: no fixture order holds a return or track token in its columns');
select is(
  (select string_agg(coalesce(s.return_token::text, '-') || '|' || coalesce(s.public_track_token, '-'), ',' order by r.n)
     from (values (1, :dDeadSigned::uuid), (2, :dRetOnly::uuid), (3, :dTrkOnly::uuid), (4, :dBoth::uuid), (5, :dSideSame::uuid)) r(n, id)
     left join public.order_request_secrets s on s.order_request_id = r.id),
  pg_temp.k('R1') || '|' || pg_temp.k('K1') || ',' || pg_temp.k('R2') || '|-,' || '-|' || pg_temp.k('K2') || ','
  || pg_temp.k('R3') || '|' || pg_temp.k('K3') || ',' || pg_temp.k('R4') || '|-',
  'D5b: the side table holds every return and track token with the same value (only a return token, only a track token, both, both on a row 0389 made, a return token already copied): emailed links keep working');
select is(
  (select count(*)::text from other_before b join public.order_requests o on o.id = b.id
    where (to_jsonb(o) - 'signature_token' - 'return_token' - 'public_track_token') is distinct from b.other),
  '0',
  'D6: every other column of every fixture order, updated_at and the stored image included, is unchanged');
select is(
  (select (to_jsonb(o) = b.whole)::text from other_before b join public.order_requests o on o.id = b.id where b.id = :dNone),
  'true',
  'D7: an order with no secret is byte for byte untouched');
select is(
  (select string_agg(r.n || '=' || coalesce(s.signature_token is not null, false)::text || ':'
                     || ((to_jsonb(s) - 'signature_token' - 'signature_token_expires_at')
                         = (b.whole - 'signature_token' - 'signature_token_expires_at'))::text, ',' order by r.n)
     from (values ('exp', :shExp::uuid), ('live', :shLive::uuid), ('none', :shNone::uuid)) r(n, id)
     join public.shipments s on s.id = r.id join ship_before b on b.id = r.id),
  'exp=false:true,live=true:true,none=false:true',
  'D8: the shipments step nulls only the expired token, and every other shipments column, updated_at included, is unchanged (K12)');
select is(
  (select string_agg(t.tgname || '=' || t.tgenabled::text, ',' order by t.tgname)
     from pg_trigger t
    where (t.tgrelid = 'public.order_requests'::regclass and t.tgname = 'order_requests_set_updated_at')
       or (t.tgrelid = 'public.shipments'::regclass and t.tgname = 'shipments_set_updated_at')),
  'order_requests_set_updated_at=O,shipments_set_updated_at=O',
  'D9: both updated_at triggers are enabled again');
select is(
  (select count(*)::text from public.notifications where organization_id in (:orgA, :orgB)),
  (select v from snap where k = 'notifications'),
  'D10: the data steps wrote no notification (no status changed, so no push)');
select is(
  pg_temp.call_as('service_role', null,
                  format($q$select coalesce(public.confirm_order_signature(%L, %L, 'Pat Signer', 'pat@example.com', 'data:image/png;base64,AAAA')::text, 'null')$q$,
                         :dLivePick, pg_temp.k('T1')))
  || '/' ||
  pg_temp.call_as('service_role', null,
                  format($q$select coalesce(public.confirm_order_signature(%L, %L, 'Pat Signer', 'pat@example.com', 'data:image/png;base64,AAAA')::text, 'null')$q$,
                         :dLivePick, pg_temp.sha(pg_temp.k('T1'))),
                  format('select status from public.order_requests where id = %L', :dLivePick)),
  'null/' || :orgA || '|completed',
  'D11: a QR printed before 0389 still completes the hand-over: the sign route hashes its raw token and the digest matches; the raw value itself no longer does');
select is(
  pg_temp.call_as('authenticated', :vwr,
    format($q$select string_agg(coalesce(o.signature_token ~ '^[0-9a-f]{64}$', true)::text || ':' || (o.return_token is null)::text
                                || ':' || (o.public_track_token is null)::text, ',' order by o.id)
                from public.order_requests o where o.id in (%L, %L, %L, %L)$q$, :dLiveTrans, :dDeadSigned, :dRetOnly, :dTrkOnly)),
  'true:true:true,true:true:true,true:true:true,true:true:true',
  'D12: a viewer reads only digests and null link columns');

-- ══ G. The write side and the guard ═══════════════════════════════════════
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, delivery_charter_id,
   approved_by, approved_at, pick_slip_generated_at, pick_slip_generated_by, staged_at, staged_by, denied_reason,
   signed_at, signature_method, signature_token, assigned_delivery_user_id, assigned_delivery_by, assigned_delivery_at) values
  (:gApproved,   :orgA, :whA, 'approved',               'internal', :req, 'pickup',   null, :mgr, now(), null, null, null, null, null, null, null, null, null, null, null),
  (:gPickSlip,   :orgA, :whA, 'pick_slip_generated',    'internal', :req, 'pickup',   null, :mgr, now(), now() - interval '1 hour', :stfAp, null, null, null, null, null, null, null, null, null),
  (:gPackP,      :orgA, :whA, 'packing_slip_generated', 'internal', :req, 'pickup',   null, :mgr, now(), null, null, null, null, null, null, null, null, null, null, null),
  (:gPackD,      :orgA, :whA, 'packing_slip_generated', 'internal', :req, 'delivery', :chA, :mgr, now(), null, null, null, null, null, null, null, null, null, null, null),
  (:gStaged,     :orgA, :whA, 'staged_for_pickup',      'internal', :req, 'pickup',   null, :mgr, now(), null, null, now() - interval '1 hour', :stfAp, null, null, null, null, null, null, null),
  (:gPending,    :orgA, :whA, 'pending_approval',       'internal', :req, 'pickup',   null, null, null,  null, null, null, null, null, null, null, null, null, null, null),
  (:gDenied,     :orgA, :whA, 'denied',                 'internal', :req, 'pickup',   null, null, null,  null, null, null, null, 'Out of season', null, null, null, null, null, null),
  (:gPickComp,   :orgA, :whA, 'picking_complete',       'internal', :req, 'pickup',   null, :mgr, now(), null, null, null, null, null, null, null, null, null, null, null),
  (:gSFD,        :orgA, :whA, 'staged_for_delivery',    'internal', :req, 'delivery', :chA, :mgr, now(), null, null, null, null, null, null, null, null, :drv, :mgr, now()),
  (:gSFD2,       :orgA, :whA, 'staged_for_delivery',    'internal', :req, 'delivery', :chA, :mgr, now(), null, null, null, null, null, null, null, null, null, null, null),
  (:gSignedDone, :orgA, :whA, 'completed',              'internal', :req, 'pickup',   null, :mgr, now(), null, null, null, null, null, now(), 'physical',
   pg_temp.sha('0392 signed'), null, null, null);

-- Edges an order RPC owns since 0389 and 0390.
select is(
  pg_temp.attempt('authenticated', :mgr, format($q$update public.order_requests set status = 'packing_slip_generated' where id = %L$q$, :gPickComp)),
  '42501:status_through_rpc_only:order_status_through_rpc_only',
  'G1: a raw packing slip (picking_complete -> packing_slip_generated) is refused: generate_order_packing_slips makes it');
select is(
  pg_temp.attempt('authenticated', :mgr, format($q$update public.order_requests set status = 'in_transit' where id = %L$q$, :gSFD)),
  '42501:status_through_rpc_only:order_status_through_rpc_only',
  'G2: a raw in-transit mark (staged_for_delivery -> in_transit) is refused: mark_order_in_transit makes it (slice E)');

-- The nine columns slices C and E revoke.
select is(
  (select string_agg(c || '=' || pg_temp.attempt('authenticated', :mgr, format('update public.order_requests set %I = %I where id = %L', c, c, :gApproved)),
                     E'\n' order by c collate "C")
     from unnest(array['signature_token', 'signature_token_expires_at', 'packing_slip_generated_at', 'packing_slip_generated_by',
                       'assigned_delivery_user_id', 'assigned_delivery_by', 'assigned_delivery_at', 'in_transit_at', 'in_transit_by']) c),
  (select string_agg(c || '=42501:-:permission denied for table order_requests', E'\n' order by c collate "C")
     from unnest(array['signature_token', 'signature_token_expires_at', 'packing_slip_generated_at', 'packing_slip_generated_by',
                       'assigned_delivery_user_id', 'assigned_delivery_by', 'assigned_delivery_at', 'in_transit_at', 'in_transit_by']) c),
  'G3: a raw write of each of the nine columns only order RPCs write since 0389/0390 is 42501 permission denied');
select is(
  (select string_agg(c.col || '=' || pg_temp.attempt('authenticated', :mgr,
                                        format('update public.order_requests set %I = %s where id = %L', c.col, c.val, :gApproved),
                                        format('grant update (%I) on table public.order_requests to authenticated', c.col)),
                     E'\n' order by c.col collate "C")
     from (values ('signature_token', quote_literal(repeat('e', 64))), ('signature_token_expires_at', 'now()'),
                  ('packing_slip_generated_at', 'now()'), ('packing_slip_generated_by', quote_literal(:mgr)),
                  ('assigned_delivery_user_id', quote_literal(:mgr)), ('assigned_delivery_by', quote_literal(:mgr)),
                  ('assigned_delivery_at', 'now()'), ('in_transit_at', 'now()'), ('in_transit_by', quote_literal(:mgr))) c(col, val)),
  (select string_agg(c || '=42501:column_through_rpc_only:order_column_through_rpc_only', E'\n' order by c collate "C")
     from unnest(array['signature_token', 'signature_token_expires_at', 'packing_slip_generated_at', 'packing_slip_generated_by',
                       'assigned_delivery_user_id', 'assigned_delivery_by', 'assigned_delivery_at', 'in_transit_at', 'in_transit_by']) c),
  'G4: with each column''s UPDATE granted back (inside the undone subtransaction), the guard alone still refuses changing it: column_through_rpc_only (defence in depth)');
select is(
  pg_temp.attempt('authenticated', :mgr,
    format('update public.order_requests set assigned_delivery_user_id = %L, assigned_delivery_by = %L, assigned_delivery_at = now() where id = %L',
           :outsider, :mgr, :gSFD2)),
  '42501:-:permission denied for table order_requests',
  'G5a: a raw PATCH can no longer name a driver, a non-member included (the 0384 follow-up): assign_order_delivery checks membership');
select is(
  pg_temp.attempt('authenticated', :mgr,
    format('update public.order_requests set signature_token = %L, signature_token_expires_at = null where id = %L', repeat('f', 64), :gSignedDone)),
  '42501:-:permission denied for table order_requests',
  'G5b: a manager can no longer rewrite the signature token of a completed, signed order (item 14 review case)');

-- Item 14: the pick slip.
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$update public.order_requests set status = 'pick_slip_generated', pick_slip_generated_at = now(), pick_slip_generated_by = %L where id = %L$q$, :stfAp, :gApproved))
  || ' / ' ||
  pg_temp.attempt('authenticated', :mgr,
    format($q$update public.order_requests set status = 'pick_slip_generated', pick_slip_generated_at = now() where id = %L$q$, :gApproved)),
  '42501:stamp_by_caller_only:order_stamp_not_caller / 42501:stamp_by_caller_only:order_stamp_not_caller',
  'G6: a pick slip stamped with someone else''s id, or with none, is refused (stamp_by_caller_only)');
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$update public.order_requests set status = 'pick_slip_generated', pick_slip_generated_at = '2020-01-01T00:00Z', pick_slip_generated_by = %L where id = %L returning *$q$, :mgr, :gApproved),
    null,
    format($q$select (pick_slip_generated_at = now())::text || '/' || (pick_slip_generated_by = %L)::text from public.order_requests where id = %L$q$, :mgr, :gApproved)),
  'ok:1:true/true',
  'G7: the pick slip in the app''s shape goes through for its caller, and a forged time is replaced by the database''s clock');
select is(
  pg_temp.attempt('authenticated', :stfAp,
    format($q$update public.order_requests set status = 'pick_slip_generated', pick_slip_generated_at = now(), pick_slip_generated_by = %L where id = %L$q$, :stfAp, :gApproved)),
  'ok:1',
  'G8: a staff member granted orders:approve makes the pick slip in the app''s shape (0384 KO4)');
select is(
  pg_temp.attempt('authenticated', :mgr, format('update public.order_requests set pick_slip_generated_by = %L where id = %L', :mgr, :gPickSlip))
  || ' / ' ||
  pg_temp.attempt('authenticated', :mgr, format($q$update public.order_requests set pick_slip_generated_at = now() - interval '9 days' where id = %L$q$, :gPickSlip))
  || ' / ' ||
  pg_temp.attempt('authenticated', :mgr,
    format($q$update public.order_requests set internal_notes = 'x', pick_slip_generated_at = now(), pick_slip_generated_by = %L where id = %L$q$, :mgr, :gApproved)),
  '42501:stamp_through_edge_only:order_stamp_through_edge_only / 42501:stamp_through_edge_only:order_stamp_through_edge_only / 42501:stamp_through_edge_only:order_stamp_through_edge_only',
  'G9: the pick-slip stamps cannot be rewritten after the edge (re-attributed, backdated) nor written without it');

-- Item 14: staging.
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$update public.order_requests set status = 'staged_for_delivery', staged_at = now(), staged_by = %L where id = %L$q$, :mgr, :gPackP))
  || ' / ' ||
  pg_temp.attempt('authenticated', :mgr,
    format($q$update public.order_requests set status = 'staged_for_pickup', staged_at = now(), staged_by = %L where id = %L$q$, :mgr, :gPackD)),
  '42501:stage_fulfillment_mismatch:order_stage_fulfillment_mismatch / 42501:stage_fulfillment_mismatch:order_stage_fulfillment_mismatch',
  'G10: a pickup order is not staged for delivery, nor a delivery order for pickup (the service''s rule, now in the database)');
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$update public.order_requests set status = 'staged_for_pickup', staged_at = now(), staged_by = %L where id = %L$q$, :stfAp, :gPackP))
  || ' / ' ||
  pg_temp.attempt('authenticated', :mgr,
    format($q$update public.order_requests set status = 'staged_for_pickup' where id = %L$q$, :gPackP)),
  '42501:stamp_by_caller_only:order_stamp_not_caller / 42501:stamp_by_caller_only:order_stamp_not_caller',
  'G11: staging stamped with someone else''s id, or with none, is refused (stamp_by_caller_only)');
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$update public.order_requests set status = 'staged_for_pickup', staged_at = '2020-01-01T00:00Z', staged_by = %L where id = %L returning *$q$, :mgr, :gPackP),
    null,
    format($q$select (staged_at = now())::text || '/' || (staged_by = %L)::text from public.order_requests where id = %L$q$, :mgr, :gPackP))
  || ' / ' ||
  pg_temp.attempt('authenticated', :stfAp,
    format($q$update public.order_requests set status = 'staged_for_delivery', staged_at = now(), staged_by = %L where id = %L$q$, :stfAp, :gPackD)),
  'ok:1:true/true / ok:1',
  'G12: staging in the app''s shape goes through (pickup by a manager, delivery by a granted staff member), and a forged time is replaced by the database''s clock');
select is(
  pg_temp.attempt('authenticated', :mgr, format('update public.order_requests set staged_by = %L where id = %L', :mgr, :gStaged))
  || ' / ' ||
  pg_temp.attempt('authenticated', :mgr, format('update public.order_requests set staged_at = now() where id = %L', :gStaged)),
  '42501:stamp_through_edge_only:order_stamp_through_edge_only / 42501:stamp_through_edge_only:order_stamp_through_edge_only',
  'G13: the staging stamps cannot be rewritten after the edge');

-- Item 14: deny.
select is(
  pg_temp.attempt('authenticated', :stfAp,
    format($q$update public.order_requests set status = 'denied', denied_reason = 'Out of season' where id = %L and status = 'pending_approval' returning *$q$, :gPending)),
  'ok:1',
  'G14a: deny with its reason (a staff approver, the app''s shape) goes through (0384 KO3)');
select is(
  pg_temp.attempt('authenticated', :mgr, format($q$update public.order_requests set denied_reason = 'Typed later' where id = %L$q$, :gPending))
  || ' / ' ||
  pg_temp.attempt('authenticated', :mgr, format($q$update public.order_requests set denied_reason = 'Rewritten' where id = %L$q$, :gDenied)),
  '42501:stamp_through_edge_only:order_stamp_through_edge_only / 42501:stamp_through_edge_only:order_stamp_through_edge_only',
  'G14b: a denial reason is written only with the denial: not on a pending order, not rewritten afterwards');

-- What stays writable.
select is(
  (select string_agg(pg_temp.attempt('authenticated', :mgr,
                       format($q$update public.order_requests set internal_notes = 'Gate 0392' where id = %L returning *$q$, x)), ',' order by x)
     from unnest(array[:gApproved::uuid, :gPickSlip::uuid, :gStaged::uuid, :gDenied::uuid, :gSignedDone::uuid, :gSFD::uuid]) x),
  'ok:1,ok:1,ok:1,ok:1,ok:1,ok:1',
  'G15: an internal-notes save goes through at every status (0384 KO2)');
select is(
  pg_temp.attempt('authenticated', :mgr, format($q$update public.order_requests set created_at = created_at - interval '1 day' where id = %L$q$, :gApproved))
  || ' / ' ||
  pg_temp.attempt('authenticated', :mgr, format('update public.order_requests set warehouse_id = %L where id = %L', :whA2, :gApproved))
  || ' / ' ||
  pg_temp.attempt('authenticated', :mgr, format('update public.order_requests set delivery_charter_id = %L where id = %L', :chA, :gSFD2)),
  'ok:1 / ok:1 / ok:1',
  'G16: pins current behaviour (owner questions Q4 and Q7, unchanged by 0392): created_at, warehouse_id and delivery_charter_id stay writable');
select is(
  pg_temp.attempt('service_role', null, format($q$update public.order_requests set status = 'staged_for_pickup' where id = %L$q$, :gPackP)),
  'ok:1',
  'G17: the guard holds the API roles only: service_role (the admin client) is not held to the stamp rules');

-- Review stage: the order row never carries a link token or an image again,
-- for the admin client too (postgres, the order RPCs' and FK actions' owner,
-- is not held: its writers are pinned DEFINER bodies, 0387 AL9c/AL9d).
select is(
  (select string_agg(c.n || '=' || pg_temp.attempt('service_role', null,
             format('insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, %I)
                     values (gen_random_uuid(), %L, %L, %L, %L, %L, %L, %s)',
                    c.col, :orgA, :whA, 'pending_approval', 'internal', :req, 'pickup', c.val)), ' / ' order by c.n)
     from (values (1, 'return_token', 'gen_random_uuid()'), (2, 'public_track_token', quote_literal(repeat('e3', 32))),
                  (3, 'signature_data_url', quote_literal('data:image/png;base64,AAAA'))) c(n, col, val))
  || ' / 4=' ||
  pg_temp.attempt('service_role', null,
    format('insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, internal_notes)
            values (gen_random_uuid(), %L, %L, %L, %L, %L, %L, %L)', :orgA, :whA, 'pending_approval', 'internal', :req, 'pickup', 'plain')),
  '1=42501:secret_through_side_table_only:order_secret_through_side_table_only / '
  '2=42501:secret_through_side_table_only:order_secret_through_side_table_only / '
  '3=42501:secret_through_side_table_only:order_secret_through_side_table_only / 4=ok:1',
  'G23: an admin-client INSERT carrying a return token, a track token or a signature image on the order row is refused (they live in order_request_secrets); the same insert without one goes through');
select is(
  pg_temp.attempt('service_role', null, format('update public.order_requests set return_token = gen_random_uuid() where id = %L', :dNone))
  || ' / ' ||
  pg_temp.attempt('service_role', null, format('update public.order_requests set public_track_token = %L where id = %L', repeat('e4', 32), :dNone)),
  '42501:secret_through_side_table_only:order_secret_through_side_table_only / 42501:secret_through_side_table_only:order_secret_through_side_table_only',
  'G24a: an admin-client UPDATE that puts a return or a track token on the order row is refused (the pre-0389 return-prompt mint shape)');
select is(
  pg_temp.attempt('service_role', null, format($q$update public.order_requests set internal_notes = 'kept' where id = %L$q$, :gApproved),
                  format('update public.order_requests set return_token = %L, public_track_token = %L where id = %L',
                         '03920000-0000-4000-8000-0000000000f9', repeat('e5', 32), :gApproved))
  || ' / ' ||
  pg_temp.attempt('service_role', null, format('update public.order_requests set return_token = null, public_track_token = null where id = %L', :gApproved),
                  format('update public.order_requests set return_token = %L, public_track_token = %L where id = %L',
                         '03920000-0000-4000-8000-0000000000f9', repeat('e5', 32), :gApproved)),
  'ok:1 / ok:1',
  'G24b: a value already on the row (planted here as postgres: only rows from before 0392 held one) may stay through another write, or be cleared');

-- The order RPCs still make what the user client no longer may.
select is(
  pg_temp.attempt('authenticated', :mgr, format('select 1 from public.generate_order_packing_slips(%L)', :gPickComp), null,
                  format('select status from public.order_requests where id = %L', :gPickComp))
  || ' / ' ||
  pg_temp.attempt('authenticated', :mgr, format('select 1 from public.assign_order_delivery(%L, %L)', :gSFD2, :drv), null,
                  format('select (assigned_delivery_user_id = %L)::text from public.order_requests where id = %L', :drv, :gSFD2))
  || ' / ' ||
  pg_temp.attempt('authenticated', :mgr, format('select 1 from public.mark_order_in_transit(%L)', :gSFD), null,
                  format('select status from public.order_requests where id = %L', :gSFD)),
  'ok:1:packing_slip_generated / ok:1:true / ok:1:in_transit',
  'G18: generate_order_packing_slips, assign_order_delivery and mark_order_in_transit (a manager) still make the packing slip, the assignment and the in-transit mark');
select is(
  pg_temp.attempt('authenticated', :drv, format('select 1 from public.mark_order_in_transit(%L)', :gSFD)),
  '42501:orders_approve:forbidden',
  'G19: the order''s assigned staff driver without orders:approve is refused in transit (owner decision O3 default; plan item 14 asks for this case)');

-- Account deletion through the restated guard (desk check F5). The six user
-- columns the guard now holds (pick_slip_generated_by, staged_by,
-- packing_slip_generated_by, assigned_delivery_user_id, assigned_delivery_by,
-- in_transit_by) and approved_by are ON DELETE SET NULL; the FK action runs
-- as the table owner, which the guard lets through.
insert into auth.users (id, email, raw_user_meta_data) values
  (:delReq, '0392-delreq@test.local', '{}'::jsonb),
  (:delApr, '0392-delapr@test.local', '{}'::jsonb),
  (:delDrv, '0392-deldrv@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :delReq, 'staff',   now()),
  (:orgA, :delApr, 'manager', now()),
  (:orgA, :delDrv, 'staff',   now());
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, requester_email, fulfillment_type, delivery_charter_id,
   approved_by, approved_at, pick_slip_generated_at, pick_slip_generated_by, packing_slip_generated_at, packing_slip_generated_by,
   staged_at, staged_by, assigned_delivery_user_id, assigned_delivery_by, assigned_delivery_at, in_transit_at, in_transit_by,
   signature_token, signature_token_expires_at, internal_notes, updated_at) values
  (:gDelR, :orgA, :whA, 'staged_for_pickup', 'internal', :delReq, null, 'pickup', null,
   :mgr, now() - interval '3 days', now() - interval '3 days', :mgr, now() - interval '2 days', :mgr,
   now() - interval '2 days', :mgr, null, null, null, null, null,
   pg_temp.sha('0392 delete requester'), now() + interval '9 days', 'requester leaves', now() - interval '2 days'),
  (:gDelA, :orgA, :whA, 'in_transit', 'internal', :req, null, 'delivery', :chA,
   :delApr, now() - interval '3 days', now() - interval '3 days', :delApr, now() - interval '2 days', :delApr,
   now() - interval '2 days', :delApr, :delDrv, :delApr, now() - interval '2 days', now() - interval '1 day', :delApr,
   pg_temp.sha('0392 delete approver'), now() + interval '9 days', 'approver and driver leave', now() - interval '2 days');
create temp table del_before as
select o.id, to_jsonb(o) as whole from public.order_requests o where o.id in (:gDelR, :gDelA);

select is(
  pg_temp.call_as('postgres', null, format('delete from auth.users where id = %L returning id::text', :delReq),
    format($q$select o.status || '/' || coalesce(o.requester_user_id::text, 'null') || '/' || coalesce(o.requester_email, 'null') || '/'
                     || coalesce((o.requester_deleted_at = now())::text, 'null') || '/'
                     || ((to_jsonb(o) - array['requester_user_id', 'requester_deleted_at', 'updated_at'])
                         = (b.whole - array['requester_user_id', 'requester_deleted_at', 'updated_at']))::text
                from public.order_requests o join del_before b on b.id = o.id where o.id = %L$q$, :gDelR)),
  :delReq || '|staged_for_pickup/null/null/true/true',
  'G20: deleting a requester''s account (delete from auth.users, as the 0388 suite does) succeeds through the restated guard: the staged order keeps its status, stamps and token, loses only the requester, and is marked (0388)');
select is(
  pg_temp.attempt('authenticated', :mgr, format('delete from public.user_profiles where id = %L', :delApr),
    format('create policy zz_0392_probe on public.user_profiles for delete to authenticated using (id = %L)', :delApr),
    format($q$select concat_ws('/', o.status, coalesce(o.approved_by::text, 'null'), coalesce(o.pick_slip_generated_by::text, 'null'),
                               coalesce(o.packing_slip_generated_by::text, 'null'), coalesce(o.staged_by::text, 'null'),
                               coalesce(o.assigned_delivery_by::text, 'null'), coalesce(o.in_transit_by::text, 'null'),
                               (o.assigned_delivery_user_id = %L)::text,
                               ((to_jsonb(o) - array['approved_by', 'pick_slip_generated_by', 'packing_slip_generated_by', 'staged_by',
                                                     'assigned_delivery_by', 'in_transit_by', 'updated_at'])
                                = (b.whole - array['approved_by', 'pick_slip_generated_by', 'packing_slip_generated_by', 'staged_by',
                                                   'assigned_delivery_by', 'in_transit_by', 'updated_at']))::text)
                from public.order_requests o join del_before b on b.id = o.id where o.id = %L$q$, :delDrv, :gDelA)),
  'ok:1:in_transit/null/null/null/null/null/null/true/true',
  'G21: deleting the profile of an approver who approved, made the pick slip, the packing slip and the staging, assigned the driver and marked in transit, with the DELETING session authenticated (a probe policy lets it delete), still succeeds: approved_by and the five stamp columns are nulled by the FK action (run as the table owner, not the caller) and nothing else on the order changes');
-- Re-pinned by 0393 (was: only assigned_delivery_user_id nulled, the
-- assigner and the assignment time kept): 0393's account trigger releases the
-- deleted driver's open deliveries before the cascade (A3 6.1, as the
-- account-deletion path itself, never through assign_order_delivery), so the
-- order reads unassigned: driver, assigned-at and assigned-by are null.
select is(
  pg_temp.call_as('postgres', null, format('delete from auth.users where id = %L returning id::text', :delDrv),
    format($q$select o.status || '/' || coalesce(o.assigned_delivery_user_id::text, 'null') || '/'
                     || coalesce(o.assigned_delivery_by::text, 'null') || '/' || coalesce(o.assigned_delivery_at::text, 'null') || '/'
                     || ((to_jsonb(o) - array['assigned_delivery_user_id', 'assigned_delivery_by', 'assigned_delivery_at', 'updated_at'])
                         = (b.whole - array['assigned_delivery_user_id', 'assigned_delivery_by', 'assigned_delivery_at', 'updated_at']))::text
                from public.order_requests o join del_before b on b.id = o.id where o.id = %L$q$, :gDelA)),
  :delDrv || '|in_transit/null/null/null/true',
  'G22: deleting the assigned driver''s account succeeds through the restated guard: since 0393 the in-transit order is released (driver, assigned-by and assigned-at null: unassigned), everything else (the stamps, the token, the status) unchanged');

-- ══ P. Posture ════════════════════════════════════════════════════════════
select is(
  (select md5(p.prosrc) || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner) || '|'
          || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text || '|'
          || coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a)::text, 'false')
     from pg_proc p where p.oid = to_regprocedure('public.tg_order_requests_workflow_guard()')),
  '55bceafc13d599f8d77d6a4180c28140|false|{search_path=public}|postgres|false|false|false',
  'P1: the guard is 0392''s body, SECURITY INVOKER, search_path pinned, owned by postgres, not executable by PUBLIC, anon or authenticated');
select is(
  (select t.tgtype::text || '|' || t.tgenabled::text || '|' || t.tgfoid::regproc::text
     from pg_trigger t where t.tgrelid = 'public.order_requests'::regclass and t.tgname = 'trg_order_requests_workflow_guard'),
  '19|O|tg_order_requests_workflow_guard',
  'P2: the guard''s trigger is unchanged: BEFORE UPDATE FOR EACH ROW, every column, enabled');
select is(
  (select string_agg(distinct m[1], ',')
     from pg_proc p, regexp_matches(p.prosrc, $re$errcode\s*=\s*'([^']+)'$re$, 'g') m
    where p.oid = 'public.tg_order_requests_workflow_guard()'::regprocedure)
  || '/' ||
  (select string_agg(distinct m[1], ',' order by m[1])
     from pg_proc p, regexp_matches(p.prosrc, $re$hint\s*=\s*'([^']+)'$re$, 'g') m
    where p.oid = 'public.tg_order_requests_workflow_guard()'::regprocedure)
  || '/' ||
  (select (p.prosrc !~* '40001|40p01|serialization_failure|deadlock_detected')::text
     from pg_proc p where p.oid = 'public.tg_order_requests_workflow_guard()'::regprocedure),
  '42501/approval_through_rpc_only,column_through_rpc_only,secret_through_side_table_only,stage_fulfillment_mismatch,stamp_by_caller_only,stamp_through_edge_only,status_through_rpc_only/true',
  'P3: the guard raises 42501 only, with its seven hints, never 40001 or 40P01');
select is(
  (select string_agg(a.attname, ',' order by a.attname)
     from pg_attribute a
    where a.attrelid = 'public.order_requests'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('authenticated', 'public.order_requests', a.attname, 'UPDATE')),
  'created_at,delivery_charter_id,denied_reason,internal_notes,pick_slip_generated_at,pick_slip_generated_by,'
  'staged_at,staged_by,status,warehouse_id',
  'P4: authenticated may UPDATE exactly ten order columns: the four user-client writes (deny, pick slip, staging, notes) and the owner questions'' three');
select is(
  (select string_agg(p || '=' || has_table_privilege('authenticated', 'public.order_request_secrets', p)::text, ',' order by p)
     from unnest(array['DELETE', 'INSERT', 'SELECT', 'UPDATE']) p)
  || '|' || has_any_column_privilege('anon', 'public.order_requests', 'UPDATE')::text,
  'DELETE=false,INSERT=false,SELECT=false,UPDATE=false|false',
  'P5: the side table stays service-only, and anon still holds nothing on order_requests');
select is(
  (coalesce(obj_description('public.tg_order_requests_workflow_guard()'::regprocedure, 'pg_proc'), '') ~ '0392')::text || ','
  || (coalesce(obj_description('public.tg_order_requests_workflow_guard()'::regprocedure, 'pg_proc'), '') ~ '0387')::text || ','
  || (select string_agg((coalesce(col_description('public.order_requests'::regclass, a.attnum), '') ~ '0392')::text, ',' order by a.attname)
        from pg_attribute a
       where a.attrelid = 'public.order_requests'::regclass and a.attname in ('public_track_token', 'return_token', 'signature_token'))
  || ',' || (coalesce(col_description('public.order_requests'::regclass,
               (select a.attnum from pg_attribute a where a.attrelid = 'public.order_requests'::regclass and a.attname = 'signature_token')), '') ~ 'sha256')::text,
  'true,true,true,true,true,true',
  'P6: the guard''s comment names 0387 and 0392, and the three token columns say what 0392 did (signature_token still says sha256: 0389 P2)');
select is(
  (select string_agg(p.oid::regprocedure::text || '|' || md5(p.prosrc), E'\n' order by p.oid::regprocedure::text collate "C")
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('confirm_order_signature', 'confirm_physical_signature', 'reopen_picking', 'resume_fulfillment',
                        'generate_order_packing_slips', 'order_return_token_ensure', 'assign_order_delivery',
                        'mark_order_in_transit', '_validate_order_request_status_transition', 'tg_order_requests_insert_guard')),
  E'_validate_order_request_status_transition()|dee8cd4782ec83abdb31a2b48fcd4ef2\n'
  'assign_order_delivery(uuid,uuid)|3bd4ed4b94ab65777457512f88eaa033\n'
  'confirm_order_signature(uuid,text,text,text,text)|8afdbb68f11dd4e8dcff3283b42f3b13\n'
  -- Re-pinned by 0396 (was f7a14a46d2c70f635c3da844c786ce67): the driver branch also
  -- requires a member with Orders on (0396 R3); the hand-over accounting is unchanged.
  'confirm_physical_signature(uuid,text)|09d4c2fb10d31a55d97c5a1070d02f3d\n'
  'generate_order_packing_slips(uuid)|76aa4e4375745a86180c5118e2be0300\n'
  'mark_order_in_transit(uuid)|c81e72528cb5899e9ed1f9ca2928f88f\n'
  'order_return_token_ensure(uuid)|bb1b6bd6103c3e2289c93bc914c91aeb\n'
  -- Re-pinned by 0396 (was 293ce0e76d195bb13105cfd1c067de82): its movements carry the order
  -- (0396 R2); the draw reversal and the holds it restores are unchanged.
  'reopen_picking(uuid,text)|4d5508df23b02c7dde2db2ac13c859e9\n'
  'resume_fulfillment(uuid)|2e2d5aab1db5392250879bfa9ff4bccd\n'
  'tg_order_requests_insert_guard()|caf69f8a23d03b9bfa6ea87a9cf94077',
  'P7: 0392 changes no function body but the two guards: the hand-over, the clears, the mint, the return-token mint, the delivery RPCs and the transition trigger keep their md5; the insert guard is 0392''s (0365 plus the admin-client secret rule, G23)');
select is(
  (pg_temp.mig('0392', '$c392_move$') !~* '40001|40p01|serialization_failure|deadlock_detected')::text || '/'
  || (pg_temp.mig('0392', '$c392_move$') !~* 'raise\s+(notice|info|log|warning|debug)')::text || '/'
  || (select string_agg(distinct m[1], ',') from regexp_matches(pg_temp.mig('0392', '$c392_move$'), $re$errcode\s*=\s*'([^']+)'$re$, 'g') m),
  'true/true/P0001',
  'P8: the data block raises P0001 only (never 40001 or 40P01), and logs nothing (no token can reach a log)');

select * from finish();
rollback;
