-- supabase/tests/0429_member_removal_releases_open_work.test.sql
-- pgTAP proof for migration 0429 (B94; the number is provisional until the
-- kit assigns it): removing a member releases their open work in the
-- organization they leave, the way account deletion already does (0393's
-- tg_auth_users_before_delete), and nowhere else.
--
-- F.  The fixture: S holds, in organization A, a count in progress, a claimed
--     pick, a staged and an in-transit delivery, a scheduled event, an open
--     maintenance request, an escalation claim and warehouse A; closed work
--     in A, one row for each closed state the release must skip (a completed
--     count, pick and event; a completed, a cancelled and a denied delivery;
--     a resolved, a cancelled and an archived maintenance request; a
--     resolved escalation claim); a count, a pick and warehouse B in
--     organization B. A platform admin's Act-as seat in A holds a claimed
--     pick. Invitations: S sent, in A, a pending one, an expired one never
--     revoked, an accepted one and one revoked earlier, and a pending one in
--     B; two other admins of A and the Act-as seat each sent a pending one.
-- R.  The release, for each path that deletes a membership row: an admin
--     through the API (Team), the member leaving on their own (0140's delete
--     policy), the admin client with no subject, and an Act-as seat ended
--     (the stop and the sweep). Only organization A is touched; closed rows
--     keep S; leaving B releases only B's.
-- I.  Invitations the person sent that are not accepted and not revoked are
--     withdrawn on every path but an ended Act-as seat, in THAT organization
--     only, the way account deletion withdraws them (0393: revoked_at now,
--     expires_at no later than a minute ago): another admin's, the same
--     person's in another organization, an accepted one and one revoked
--     earlier are untouched.
-- A.  The audit rows: one per released count, pick, delivery and maintenance
--     request and one summary, actor = the caller, cause member_removed,
--     member_left or act_as_seat_ended, reason null (K1: the order page
--     prints any string reason as "Reason: ..."), acting_as_platform; none
--     when nothing was open.
-- C.  member_open_work, the Remove dialog's read: what R1 releases, per kind
--     (the closed rows above not counted), invitations included; refused for a manager, a manager
--     granted members:remove (the admin floor), staff, an admin without
--     members:remove, an outsider, anon and no subject.
-- P.  Posture: the trigger (AFTER DELETE FOR EACH ROW, enabled), both
--     functions (SECURITY DEFINER, postgres, search_path pinned; the trigger
--     function lock_timeout 5s and no EXECUTE for anyone; member_open_work
--     STABLE and EXECUTE for authenticated only), no 40001/40P01, the trigger
--     body raises nothing and writes only the seven released tables and
--     audit_logs, and the comments name the parity obligation.
-- PAR. Removal from A and account deletion leave the same released set in A.
--     Closed rows are pinned on the release paths (R1-R3, R5) and in C1, not
--     here: deleting the account nulls them through their foreign keys
--     whatever 0393's predicates say.
-- M, O, D, N, G. Controls: without the trigger the count stays (today's
--     behaviour); organization deletion and account deletion go through and
--     this trigger writes nothing; no notification; the owner row is still
--     refused; a delete RLS refuses releases nothing, also for a manager
--     granted members:remove (the app's gate passes; the row policy does not).
--
-- Roles: fixtures as the test superuser. Attempts run through
-- pg_temp.attempt, which switches to the API role with a JWT subject and
-- always undoes what it did (sentinel XXB94), so every test starts from the
-- fixture.
begin;
select plan(40);

\set orgA    '\'94940000-0000-0000-0000-00000000000a\''
\set orgB    '\'94940000-0000-0000-0000-00000000000b\''
\set orgC    '\'94940000-0000-0000-0000-00000000000c\''
\set own     '\'94940000-0000-0000-0000-0000000000a0\''
\set adm     '\'94940000-0000-0000-0000-0000000000a1\''
\set mgr     '\'94940000-0000-0000-0000-0000000000a2\''
\set sub     '\'94940000-0000-0000-0000-0000000000a3\''
\set adm2    '\'94940000-0000-0000-0000-0000000000a4\''
\set idle    '\'94940000-0000-0000-0000-0000000000a5\''
\set pa      '\'94940000-0000-0000-0000-0000000000a6\''
\set mgr2    '\'94940000-0000-0000-0000-0000000000a7\''
\set outB    '\'94940000-0000-0000-0000-0000000000b1\''
\set ownC    '\'94940000-0000-0000-0000-0000000000c0\''
\set cs      '\'94940000-0000-0000-0000-0000000000c1\''
\set whA     '\'94940000-0000-0000-0000-0000000000d1\''
\set whB     '\'94940000-0000-0000-0000-0000000000d2\''
\set whC     '\'94940000-0000-0000-0000-0000000000d3\''
\set itA     '\'94940000-0000-0000-0000-0000000000e1\''
\set chA     '\'94940000-0000-0000-0000-0000000000e2\''
\set ccOpen  '\'94940000-0000-0000-0000-000000000101\''
\set ccDone  '\'94940000-0000-0000-0000-000000000102\''
\set ccB     '\'94940000-0000-0000-0000-000000000103\''
\set ccC     '\'94940000-0000-0000-0000-000000000104\''
\set oPick   '\'94940000-0000-0000-0000-000000000201\''
\set oDrv    '\'94940000-0000-0000-0000-000000000202\''
\set oTrans  '\'94940000-0000-0000-0000-000000000203\''
\set oDone   '\'94940000-0000-0000-0000-000000000204\''
\set oPickB  '\'94940000-0000-0000-0000-000000000205\''
\set oPickPA '\'94940000-0000-0000-0000-000000000206\''
\set oDrvDone '\'94940000-0000-0000-0000-000000000207\''
\set oDrvCanc '\'94940000-0000-0000-0000-000000000208\''
\set oDrvDen  '\'94940000-0000-0000-0000-000000000209\''
\set seOpen  '\'94940000-0000-0000-0000-000000000301\''
\set seDone  '\'94940000-0000-0000-0000-000000000302\''
\set mrOpen  '\'94940000-0000-0000-0000-000000000401\''
\set mrDone  '\'94940000-0000-0000-0000-000000000402\''
\set mrCanc  '\'94940000-0000-0000-0000-000000000403\''
\set mrArch  '\'94940000-0000-0000-0000-000000000404\''
\set exOpen  '\'94940000-0000-0000-0000-000000000501\''
\set exDone  '\'94940000-0000-0000-0000-000000000502\''
\set mSubA   '\'94940000-0000-0000-0000-000000000601\''
\set mSubB   '\'94940000-0000-0000-0000-000000000602\''
\set mPaA    '\'94940000-0000-0000-0000-000000000603\''
\set mIdleA  '\'94940000-0000-0000-0000-000000000604\''
\set mOwnA   '\'94940000-0000-0000-0000-000000000605\''
\set mAdmA   '\'94940000-0000-0000-0000-000000000606\''
\set invSub    '\'94940000-0000-0000-0000-000000000701\''
\set invSubOld '\'94940000-0000-0000-0000-000000000702\''
\set invSubAcc '\'94940000-0000-0000-0000-000000000703\''
\set invSubRev '\'94940000-0000-0000-0000-000000000704\''
\set invSubB   '\'94940000-0000-0000-0000-000000000705\''
\set invAdm    '\'94940000-0000-0000-0000-000000000706\''
\set invAdm2   '\'94940000-0000-0000-0000-000000000707\''
\set invPa     '\'94940000-0000-0000-0000-000000000708\''
\set nobody  '\'94940000-0000-0000-0000-000000000699\''

-- ══ Fixture ════════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,  'b94-own@b94.test',  '{}'::jsonb),
  (:adm,  'b94-adm@b94.test',  '{}'::jsonb),
  (:mgr,  'b94-mgr@b94.test',  '{}'::jsonb),
  (:sub,  'b94-sub@b94.test',  '{}'::jsonb),
  (:adm2, 'b94-adm2@b94.test', '{}'::jsonb),
  (:idle, 'b94-idle@b94.test', '{}'::jsonb),
  (:pa,   'b94-pa@b94.test',   '{}'::jsonb),
  (:mgr2, 'b94-mgr2@b94.test', '{}'::jsonb),
  (:outB, 'b94-outb@b94.test', '{}'::jsonb),
  (:ownC, 'b94-ownc@b94.test', '{}'::jsonb),
  (:cs,   'b94-cs@b94.test',   '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, 'B94 A', 'b94-a'), (:orgB, 'B94 B', 'b94-b'), (:orgC, 'B94 C', 'b94-c');
insert into public.organization_members (id, organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:mOwnA,  :orgA, :own,  'owner',   now(), null),
  (:mAdmA,  :orgA, :adm,  'admin',   now(), null),
  (:mSubA,  :orgA, :sub,  'staff',   now(), null),
  (:mIdleA, :orgA, :idle, 'staff',   now(), null),
  -- A platform admin's Act-as seat: a real, temporary owner row (0176).
  (:mPaA,   :orgA, :pa,   'owner',   now(), now() + interval '45 minutes'),
  (:mSubB,  :orgB, :sub,  'staff',   now(), null);
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :adm2, 'admin', now()), (:orgA, :mgr, 'manager', now()),
  (:orgA, :mgr2, 'manager', now()),
  (:orgB, :outB, 'owner', now()),
  (:orgC, :ownC, 'owner', now()), (:orgC, :cs, 'staff', now());
-- An admin whose Remove members permission is revoked, and a manager granted
-- it (the app's gate; 0207 lets an admin grant it to anyone).
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :adm2, 'members:remove', false),
  (:orgA, :mgr2, 'members:remove', true);
insert into public.warehouses (id, organization_id, name, code, status, manager_user_id) values
  (:whA, :orgA, 'B94 A', 'WH-B94A', 'active', :sub),
  (:whB, :orgB, 'B94 B', 'WH-B94B', 'active', :sub),
  (:whC, :orgC, 'B94 C', 'WH-B94C', 'active', :cs);
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :sub, :whA, true), (:orgB, :sub, :whB, true), (:orgC, :cs, :whC, true);
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:itA, :orgA, :whA, 'B94-I', 'B94 item', 10, 'active', 'none');
insert into public.charters (id, organization_id, name, code, status) values (:chA, :orgA, 'B94 Charter', 'CH-B94A', 'active');
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, delivery_charter_id,
   approved_by, approved_at, pick_slip_generated_by, pick_slip_generated_at,
   assigned_picker_id, picking_claimed_by, picking_claimed_at,
   assigned_delivery_user_id, assigned_delivery_by, assigned_delivery_at, in_transit_at, in_transit_by,
   completed_at, completed_by) values
  (:oPick,   :orgA, :whA, 'picking_in_progress', 'internal', :mgr, 'pickup', null,
   :mgr, now(), :mgr, now(), :sub, :sub, now(), null, null, null, null, null, null, null),
  (:oDrv,    :orgA, :whA, 'staged_for_delivery', 'internal', :mgr, 'delivery', :chA,
   :mgr, now(), :mgr, now(), null, null, null, :sub, :mgr, now(), null, null, null, null),
  (:oTrans,  :orgA, :whA, 'in_transit', 'internal', :mgr, 'delivery', :chA,
   :mgr, now(), :mgr, now(), null, null, null, :sub, :mgr, now(), now(), :mgr, null, null),
  (:oDone,   :orgA, :whA, 'completed', 'internal', :mgr, 'pickup', null,
   :mgr, now(), :mgr, now(), :sub, :sub, now(), null, null, null, null, null, now(), :mgr),
  (:oPickB,  :orgB, :whB, 'picking_in_progress', 'internal', :outB, 'pickup', null,
   :outB, now(), :outB, now(), :sub, :sub, now(), null, null, null, null, null, null, null),
  (:oPickPA, :orgA, :whA, 'picking_in_progress', 'internal', :mgr, 'pickup', null,
   :mgr, now(), :mgr, now(), :pa, :pa, now(), null, null, null, null, null, null, null),
  -- S's closed deliveries: one per status the release skips.
  (:oDrvDone, :orgA, :whA, 'completed', 'internal', :mgr, 'delivery', :chA,
   :mgr, now(), :mgr, now(), null, null, null, :sub, :mgr, now(), now(), :mgr, now(), :mgr),
  (:oDrvCanc, :orgA, :whA, 'cancelled', 'internal', :mgr, 'delivery', :chA,
   :mgr, now(), :mgr, now(), null, null, null, :sub, :mgr, now(), null, null, null, null),
  (:oDrvDen,  :orgA, :whA, 'denied', 'internal', :mgr, 'delivery', :chA,
   null, null, null, null, null, null, null, :sub, :mgr, now(), null, null, null, null);
insert into public.cycle_counts
  (id, organization_id, warehouse_id, status, scope, started_by, started_at, assigned_to, assignment_claimed_at,
   assignment_claimed_by, assignment_version, completed_by, completed_at) values
  (:ccOpen, :orgA, :whA, 'in_progress', 'warehouse', :mgr, now(), :sub, now(), :mgr, 1, null, null),
  (:ccDone, :orgA, :whA, 'completed',   'warehouse', :mgr, now(), :sub, now(), :mgr, 1, :mgr, now()),
  (:ccB,    :orgB, :whB, 'in_progress', 'warehouse', :outB, now(), :sub, now(), :outB, 1, null, null),
  (:ccC,    :orgC, :whC, 'in_progress', 'warehouse', :ownC, now(), :cs, now(), :ownC, 1, null, null);
insert into public.schedule_events (id, organization_id, title, starts_at, status, assigned_user_id, created_by, updated_by) values
  (:seOpen, :orgA, 'B94 scheduled', now() + interval '1 day', 'scheduled', :sub, :mgr, :mgr),
  (:seDone, :orgA, 'B94 done',      now() - interval '1 day', 'completed', :sub, :mgr, :mgr);
-- The open request, then one closed request per closed state (each with only
-- its own timestamp set, so each predicate is pinned on its own).
insert into public.maintenance_requests
  (id, organization_id, requester_user_id, requester_name_snapshot, subject, description, priority, status, local_owner_user_id,
   resolved_at, resolved_by, resolved_by_name_snapshot, cancelled_at, archived_at) values
  (:mrOpen, :orgA, :mgr, 'Mgr', 'B94 door', 'Sticks', 'normal', 'saved',     :sub, null,  null, null,       null,  null),
  (:mrDone, :orgA, :mgr, 'Mgr', 'B94 lamp', 'Fixed',  'normal', 'resolved',  :sub, now(), :mgr, 'Resolver', null,  null),
  (:mrCanc, :orgA, :mgr, 'Mgr', 'B94 sink', 'Gone',   'normal', 'cancelled', :sub, null,  null, null,       now(), null),
  (:mrArch, :orgA, :mgr, 'Mgr', 'B94 vent', 'Old',    'normal', 'archived',  :sub, null,  null, null,       null,  now());
insert into public.exception_occurrences
  (id, organization_id, occurrence_number, rule, item_id, warehouse_id, first_seen_at, last_seen_at, resolved_at, resolved_reason,
   escalation_claimed_by, escalation_claimed_at) values
  (:exOpen, :orgA, 1, 'label_mismatch', :itA, :whA, now(), now(), null,  null,      :sub, now()),
  (:exDone, :orgA, 2, 'label_mismatch', :itA, :whA, now(), now(), now(), 'cleared', :sub, now());
-- Invitations (0393's columns): S's pending, expired-but-never-revoked,
-- accepted and earlier-revoked ones in A, S's pending one in B, and one
-- pending each from the other two admins of A and the Act-as seat.
insert into public.organization_invites (id, organization_id, email, role, token, expires_at, invited_by, accepted_at, revoked_at) values
  (:invSub,    :orgA, 'b94-new1@b94.test', 'staff', 'b94-token-sub',     now() + interval '7 days', :sub,  null,  null),
  (:invSubOld, :orgA, 'b94-new2@b94.test', 'staff', 'b94-token-sub-old', now() - interval '1 day',  :sub,  null,  null),
  (:invSubAcc, :orgA, 'b94-new3@b94.test', 'staff', 'b94-token-sub-acc', now() + interval '7 days', :sub,  now(), null),
  (:invSubRev, :orgA, 'b94-new4@b94.test', 'staff', 'b94-token-sub-rev', now() - interval '2 days', :sub,  null,  now() - interval '2 days'),
  (:invSubB,   :orgB, 'b94-new5@b94.test', 'staff', 'b94-token-sub-b',   now() + interval '7 days', :sub,  null,  null),
  (:invAdm,    :orgA, 'b94-new6@b94.test', 'staff', 'b94-token-adm',     now() + interval '7 days', :adm,  null,  null),
  (:invAdm2,   :orgA, 'b94-new7@b94.test', 'staff', 'b94-token-adm2',    now() + interval '7 days', :adm2, null,  null),
  (:invPa,     :orgA, 'b94-new8@b94.test', 'staff', 'b94-token-pa',      now() + interval '7 days', :pa,   null,  null);

-- Short names for the fixture's ids, so the pinned values read as words.
create temp table b94_names (id uuid primary key, n text not null unique);
insert into pg_temp.b94_names values
  (:orgA, 'orgA'), (:orgB, 'orgB'), (:orgC, 'orgC'),
  (:own, 'own'), (:adm, 'adm'), (:mgr, 'mgr'), (:sub, 'sub'), (:adm2, 'adm2'), (:idle, 'idle'), (:pa, 'pa'), (:mgr2, 'mgr2'),
  (:outB, 'outB'), (:ownC, 'ownC'), (:cs, 'cs'),
  (:whA, 'whA'), (:whB, 'whB'), (:whC, 'whC'),
  (:ccOpen, 'ccOpen'), (:ccDone, 'ccDone'), (:ccB, 'ccB'), (:ccC, 'ccC'),
  (:oPick, 'oPick'), (:oDrv, 'oDrv'), (:oTrans, 'oTrans'), (:oDone, 'oDone'), (:oPickB, 'oPickB'), (:oPickPA, 'oPickPA'),
  (:oDrvDone, 'oDrvDone'), (:oDrvCanc, 'oDrvCanc'), (:oDrvDen, 'oDrvDen'),
  (:seOpen, 'seOpen'), (:seDone, 'seDone'), (:mrOpen, 'mrOpen'), (:mrDone, 'mrDone'), (:mrCanc, 'mrCanc'), (:mrArch, 'mrArch'),
  (:exOpen, 'exOpen'), (:exDone, 'exDone'),
  (:mSubA, 'mSubA'), (:mSubB, 'mSubB'), (:mPaA, 'mPaA'), (:mIdleA, 'mIdleA'), (:mOwnA, 'mOwnA'), (:mAdmA, 'mAdmA'),
  (:invSub, 'invSub'), (:invSubOld, 'invSubOld'), (:invSubAcc, 'invSubAcc'), (:invSubRev, 'invSubRev'), (:invSubB, 'invSubB'),
  (:invAdm, 'invAdm'), (:invAdm2, 'invAdm2'), (:invPa, 'invPa');

-- ══ Helpers (the 0393 helpers, sentinel XXB94) ═════════════════════════════
create function pg_temp.who(p uuid) returns text language sql stable as $$
  select coalesce((select n.n from pg_temp.b94_names n where n.id = p),
                  case when p is null then 'null' else 'other' end)
$$;
create function pg_temp.id(p text) returns uuid language sql stable as $$
  select n.id from pg_temp.b94_names n where n.n = p
$$;
create function pg_temp.at(p timestamptz) returns text language sql immutable as $$
  select case when p is null then 'null' else 'set' end
$$;
create function pg_temp.hint(p_hint text) returns text language sql immutable as $$
  select case when p_hint is null or p_hint = ''
                or p_hint like 'Grant the required privileges to the current role with:%'
              then '-' else p_hint end
$$;
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
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', '', true);
    if p_check is not null then
      execute p_check into v_seen;
    end if;
    raise exception using errcode = 'XXB94', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XXB94' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
end $$;
-- A read as an API role: its value, or the refusal.
create function pg_temp.call_as(p_as text, p_sub uuid, p_sql text)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', '', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
    return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
  end;
  return coalesce(v, 'null');
end $$;

-- Organization A's open work, as one string: the count (assignee/claimer/
-- claimed at/version), S's pick (picker/claimer/claimed at), the two
-- deliveries (status/driver/assigned by/assigned at), the scheduled event,
-- the maintenance request's local owner, the escalation claim (claimer/at),
-- warehouse A's manager, and the Act-as seat's pick (picker/claimer).
create function pg_temp.work() returns text language sql stable as $$
  select concat_ws(' | ',
    (select concat_ws('/', pg_temp.who(c.assigned_to), pg_temp.who(c.assignment_claimed_by),
                      pg_temp.at(c.assignment_claimed_at), c.assignment_version)
       from public.cycle_counts c where c.id = pg_temp.id('ccOpen')),
    (select concat_ws('/', pg_temp.who(o.assigned_picker_id), pg_temp.who(o.picking_claimed_by), pg_temp.at(o.picking_claimed_at))
       from public.order_requests o where o.id = pg_temp.id('oPick')),
    (select string_agg(concat_ws('/', o.status, pg_temp.who(o.assigned_delivery_user_id), pg_temp.who(o.assigned_delivery_by),
                                 pg_temp.at(o.assigned_delivery_at)), ' ' order by o.id)
       from public.order_requests o where o.id in (pg_temp.id('oDrv'), pg_temp.id('oTrans'))),
    (select pg_temp.who(e.assigned_user_id) from public.schedule_events e where e.id = pg_temp.id('seOpen')),
    (select pg_temp.who(q.local_owner_user_id) from public.maintenance_requests q where q.id = pg_temp.id('mrOpen')),
    (select concat_ws('/', pg_temp.who(x.escalation_claimed_by), pg_temp.at(x.escalation_claimed_at))
       from public.exception_occurrences x where x.id = pg_temp.id('exOpen')),
    (select pg_temp.who(w.manager_user_id) from public.warehouses w where w.id = pg_temp.id('whA')),
    (select concat_ws('/', pg_temp.who(o.assigned_picker_id), pg_temp.who(o.picking_claimed_by))
       from public.order_requests o where o.id = pg_temp.id('oPickPA')))
$$;
-- What must never move: A's closed rows (the completed count, the completed
-- order's picker, the completed event; the completed, cancelled and denied
-- deliveries' driver/assigned by/at; the resolved, cancelled and archived
-- maintenance requests' local owner; the resolved escalation claim's
-- claimer/at), all of B (count/version, pick, warehouse) and C's count.
create function pg_temp.kept() returns text language sql stable as $$
  select concat_ws(' | ',
    (select pg_temp.who(c.assigned_to) from public.cycle_counts c where c.id = pg_temp.id('ccDone')),
    (select pg_temp.who(o.assigned_picker_id) from public.order_requests o where o.id = pg_temp.id('oDone')),
    (select pg_temp.who(e.assigned_user_id) from public.schedule_events e where e.id = pg_temp.id('seDone')),
    (select string_agg(concat_ws('/', o.status, pg_temp.who(o.assigned_delivery_user_id), pg_temp.who(o.assigned_delivery_by),
                                 pg_temp.at(o.assigned_delivery_at)), ' ' order by o.id)
       from public.order_requests o where o.id in (pg_temp.id('oDrvDone'), pg_temp.id('oDrvCanc'), pg_temp.id('oDrvDen'))),
    (select string_agg(q.status || '/' || pg_temp.who(q.local_owner_user_id), ' ' order by q.id)
       from public.maintenance_requests q where q.id in (pg_temp.id('mrDone'), pg_temp.id('mrCanc'), pg_temp.id('mrArch'))),
    (select concat_ws('/', pg_temp.who(x.escalation_claimed_by), pg_temp.at(x.escalation_claimed_at))
       from public.exception_occurrences x where x.id = pg_temp.id('exDone')),
    (select concat_ws('/', pg_temp.who(c.assigned_to), c.assignment_version) from public.cycle_counts c where c.id = pg_temp.id('ccB')),
    (select pg_temp.who(o.assigned_picker_id) from public.order_requests o where o.id = pg_temp.id('oPickB')),
    (select pg_temp.who(w.manager_user_id) from public.warehouses w where w.id = pg_temp.id('whB')),
    (select pg_temp.who(c.assigned_to) from public.cycle_counts c where c.id = pg_temp.id('ccC')))
$$;
-- The release's audit rows in one organization: event/entity@actor:cause.
create function pg_temp.audit(p_org uuid) returns text language sql stable as $$
  select coalesce(string_agg(a.event || '/' || pg_temp.who((a.metadata ->> 'entity_id')::uuid) || '@'
                             || pg_temp.who(a.user_id) || ':' || coalesce(a.metadata ->> 'cause', '?'),
                             ',' order by a.event collate "C", pg_temp.who((a.metadata ->> 'entity_id')::uuid) collate "C"), '')
    from public.audit_logs a
   where a.organization_id = p_org and a.metadata ? 'released_user_id'
$$;
-- The fixture's invitations (in one organization, or all): name=revoked
-- state/expiry[/accepted]. withdrawn = revoked by this transaction (0393 sets
-- revoked_at to now()); revoked = revoked before it; live = not revoked.
create function pg_temp.invites(p_org uuid default null) returns text language sql stable as $$
  select string_agg(pg_temp.who(i.id) || '='
                    || case when i.revoked_at is null then 'live' when i.revoked_at = now() then 'withdrawn' else 'revoked' end
                    || '/' || case when i.expires_at > now() then 'valid' else 'expired' end
                    || case when i.accepted_at is not null then '/accepted' else '' end,
                    ' ' order by pg_temp.who(i.id) collate "C")
    from public.organization_invites i
   where i.id in (select n.id from pg_temp.b94_names n where n.n like 'inv%')
     and (p_org is null or i.organization_id = p_org)
$$;
-- The trigger's rows anywhere, for one released person.
create function pg_temp.released_rows(p_user uuid) returns bigint language sql stable as $$
  select count(*) from public.audit_logs a where a.metadata ->> 'released_user_id' = p_user::text
$$;

-- ══ F. The fixture ═════════════════════════════════════════════════════════
select is(pg_temp.work(),
  'sub/mgr/set/1 | sub/sub/set | staged_for_delivery/sub/mgr/set in_transit/sub/mgr/set | sub | sub | sub/set | sub | pa/pa',
  'F1: in A, S holds a count, a pick, two deliveries, a scheduled event, a maintenance request, an escalation claim and warehouse A; the Act-as seat holds a pick');
select is(pg_temp.kept(),
  'sub | sub | sub | completed/sub/mgr/set cancelled/sub/mgr/set denied/sub/mgr/set | resolved/sub cancelled/sub archived/sub | sub/set | sub/1 | sub | sub | cs',
  'F2: S''s closed work in A (a count, a pick, an event, three deliveries, three maintenance requests and a claim), all of S''s work in B and C''s count');
select is(pg_temp.invites(),
  'invAdm=live/valid invAdm2=live/valid invPa=live/valid invSub=live/valid invSubAcc=live/valid/accepted invSubB=live/valid '
  || 'invSubOld=live/expired invSubRev=revoked/expired',
  'F3: the invitations: S''s pending, accepted, expired and earlier-revoked ones in A and pending one in B; the other admins'' and the Act-as seat''s pending ones in A');

-- ══ R. The release ═════════════════════════════════════════════════════════
select is(
  pg_temp.attempt('authenticated', :adm, format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :sub),
                  null, 'select pg_temp.work() || '' # '' || pg_temp.kept()'),
  'ok:1:null/null/null/2 | null/null/null | staged_for_delivery/null/null/null in_transit/null/null/null | null | null | null/null | null | pa/pa # '
  || 'sub | sub | sub | completed/sub/mgr/set cancelled/sub/mgr/set denied/sub/mgr/set | resolved/sub cancelled/sub archived/sub | sub/set | sub/1 | sub | sub | cs',
  'R1: an admin removes S from A (Team''s delete): all seven kinds are released in A (the count''s assignee, claimer and claim time cleared, version + 1; the pick''s picker and claim; both deliveries'' driver, assigned by and at; the event, the local owner, the escalation claim and the manager); closed rows keep S; nothing in B or C moves; the Act-as seat''s pick stays');
select is(
  pg_temp.attempt('authenticated', :sub, format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :sub),
                  null, format('select pg_temp.work() || '' # '' || pg_temp.kept() || '' # '' || pg_temp.audit(%L)', :orgA)),
  'ok:1:null/null/null/2 | null/null/null | staged_for_delivery/null/null/null in_transit/null/null/null | null | null | null/null | null | pa/pa # '
  || 'sub | sub | sub | completed/sub/mgr/set cancelled/sub/mgr/set denied/sub/mgr/set | resolved/sub cancelled/sub archived/sub | sub/set | sub/1 | sub | sub | cs # '
  || 'cycle_count.released/ccOpen@sub:member_left,maintenance_request.owner_assigned/mrOpen@sub:member_left,'
  || 'order.delivery_unassigned/oDrv@sub:member_left,order.delivery_unassigned/oTrans@sub:member_left,'
  || 'order.picking_released/oPick@sub:member_left,user.open_work_released/mSubA@sub:member_left',
  'R2: S leaving A on their own (0140''s delete policy) releases the same set, with S as the actor and cause member_left');
select is(
  pg_temp.attempt('service_role', null, format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :sub),
                  null, format('select pg_temp.work() || '' # '' || pg_temp.kept() || '' # '' || pg_temp.audit(%L)', :orgA)),
  'ok:1:null/null/null/2 | null/null/null | staged_for_delivery/null/null/null in_transit/null/null/null | null | null | null/null | null | pa/pa # '
  || 'sub | sub | sub | completed/sub/mgr/set cancelled/sub/mgr/set denied/sub/mgr/set | resolved/sub cancelled/sub archived/sub | sub/set | sub/1 | sub | sub | cs # '
  || 'cycle_count.released/ccOpen@null:member_removed,maintenance_request.owner_assigned/mrOpen@null:member_removed,'
  || 'order.delivery_unassigned/oDrv@null:member_removed,order.delivery_unassigned/oTrans@null:member_removed,'
  || 'order.picking_released/oPick@null:member_removed,user.open_work_released/mSubA@null:member_removed',
  'R3: the admin client with no subject (service_role) releases the same set, with no actor and cause member_removed; closed rows keep S');
select is(
  pg_temp.attempt('service_role', null, format('delete from public.organization_members where id = %L and impersonation_expires_at is not null', :mPaA),
                  null, format('select pg_temp.work() || '' # '' || pg_temp.audit(%L)', :orgA)),
  'ok:1:sub/mgr/set/1 | sub/sub/set | staged_for_delivery/sub/mgr/set in_transit/sub/mgr/set | sub | sub | sub/set | sub | null/null # '
  || 'order.picking_released/oPickPA@null:act_as_seat_ended,user.open_work_released/mPaA@null:act_as_seat_ended',
  'R4: an Act-as seat deleted by the stop or the sweep (admin client) releases the platform admin''s pick, cause act_as_seat_ended, no actor; S''s work stays');
select is(
  pg_temp.attempt('authenticated', :outB, format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgB, :sub),
                  null, format('select pg_temp.work() || '' # '' || pg_temp.kept() || '' # '' || pg_temp.audit(%L) || '' # '' || pg_temp.audit(%L)', :orgA, :orgB)),
  'ok:1:sub/mgr/set/1 | sub/sub/set | staged_for_delivery/sub/mgr/set in_transit/sub/mgr/set | sub | sub | sub/set | sub | pa/pa # '
  || 'sub | sub | sub | completed/sub/mgr/set cancelled/sub/mgr/set denied/sub/mgr/set | resolved/sub cancelled/sub archived/sub | sub/set | null/2 | null | null | cs #  # '
  || 'cycle_count.released/ccB@outB:member_removed,order.picking_released/oPickB@outB:member_removed,user.open_work_released/mSubB@outB:member_removed',
  'R5: removing S from B releases only B''s count, pick and warehouse, audited in B; nothing in A moves');

-- ══ I. Invitations the person sent ═════════════════════════════════════════
select is(
  pg_temp.attempt('authenticated', :adm, format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :sub),
                  null, 'select pg_temp.invites()'),
  'ok:1:invAdm=live/valid invAdm2=live/valid invPa=live/valid invSub=withdrawn/expired invSubAcc=live/valid/accepted invSubB=live/valid '
  || 'invSubOld=withdrawn/expired invSubRev=revoked/expired',
  'I1: an admin removes S from A: S''s pending and expired-but-never-revoked invitations in A are withdrawn (revoked now, expired); the accepted one, the one revoked earlier, S''s pending one in B and the other admins'' are untouched');
select is(
  pg_temp.attempt('authenticated', :sub, format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :sub),
                  null, 'select pg_temp.invites()'),
  'ok:1:invAdm=live/valid invAdm2=live/valid invPa=live/valid invSub=withdrawn/expired invSubAcc=live/valid/accepted invSubB=live/valid '
  || 'invSubOld=withdrawn/expired invSubRev=revoked/expired',
  'I2: S leaving A on their own withdraws the same invitations');
select is(
  pg_temp.attempt('authenticated', :own, format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :adm),
                  null, 'select pg_temp.invites()'),
  'ok:1:invAdm=withdrawn/expired invAdm2=live/valid invPa=live/valid invSub=live/valid invSubAcc=live/valid/accepted invSubB=live/valid '
  || 'invSubOld=live/expired invSubRev=revoked/expired',
  'I3: the owner removes an admin with a pending invitation: it is withdrawn; another admin''s pending invitation in A and S''s are untouched');
select is(
  pg_temp.attempt('authenticated', :outB, format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgB, :sub),
                  null, 'select pg_temp.invites()'),
  'ok:1:invAdm=live/valid invAdm2=live/valid invPa=live/valid invSub=live/valid invSubAcc=live/valid/accepted invSubB=withdrawn/expired '
  || 'invSubOld=live/expired invSubRev=revoked/expired',
  'I4: removing S from B withdraws only S''s invitation in B; S''s invitations in A stay');
select is(
  pg_temp.attempt('service_role', null, format('delete from public.organization_members where id = %L and impersonation_expires_at is not null', :mPaA),
                  null, 'select pg_temp.invites()'),
  'ok:1:invAdm=live/valid invAdm2=live/valid invPa=live/valid invSub=live/valid invSubAcc=live/valid/accepted invSubB=live/valid '
  || 'invSubOld=live/expired invSubRev=revoked/expired',
  'I5: an ended Act-as seat withdraws nothing: a platform admin''s invitation sent while acting stays valid');

-- ══ A. The audit rows ══════════════════════════════════════════════════════
select is(
  pg_temp.attempt('authenticated', :adm, format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :sub),
                  null, format('select pg_temp.audit(%L) || '' # '' || (select count(*) from public.audit_logs a where a.metadata ->> ''released_user_id'' = %L and a.organization_id is distinct from %L)', :orgA, :sub, :orgA)),
  'ok:1:cycle_count.released/ccOpen@adm:member_removed,maintenance_request.owner_assigned/mrOpen@adm:member_removed,'
  || 'order.delivery_unassigned/oDrv@adm:member_removed,order.delivery_unassigned/oTrans@adm:member_removed,'
  || 'order.picking_released/oPick@adm:member_removed,user.open_work_released/mSubA@adm:member_removed # 0',
  'A1: one row per released count, pick, delivery and maintenance request, and one summary, all in A with the admin as actor and cause member_removed; none outside A');
select is(
  pg_temp.attempt('authenticated', :adm, format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :sub),
                  null, format($q$select (a.metadata = jsonb_build_object(
                                     'entity_type', 'organization_member', 'entity_id', %L::uuid, 'warehouse_id', null,
                                     'before', null, 'after', null, 'reason', null, 'cause', 'member_removed',
                                     'released_user_id', %L::uuid, 'membership_id', %L::uuid,
                                     'cycle_counts', 1, 'picks', 1, 'deliveries', 2, 'schedule_events', 1,
                                     'maintenance_requests', 1, 'escalation_claims', 1, 'warehouses', 1,
                                     'pending_invites', 2, 'acting_as_platform', false))::text
                                 from public.audit_logs a
                                where a.organization_id = %L and a.event = 'user.open_work_released'$q$, :mSubA, :sub, :mSubA, :orgA)),
  'ok:1:true',
  'A1b: the summary row holds all eight numbers (1 count, 1 pick, 2 deliveries, 1 event, 1 maintenance request, 1 claim, 1 warehouse, 2 invitations withdrawn), the membership, the person released, reason null and cause member_removed');
select is(
  pg_temp.attempt('authenticated', :adm, format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :sub),
                  null, format($q$select string_agg(a.event || '=' || (a.metadata = case a.event
                                     when 'cycle_count.released' then jsonb_build_object(
                                       'entity_type', 'cycle_count', 'entity_id', %L::uuid, 'warehouse_id', %L::uuid,
                                       'before', jsonb_build_object('assigned_to', %L::uuid), 'after', jsonb_build_object('assigned_to', null),
                                       'reason', null, 'cause', 'member_removed', 'released_user_id', %L::uuid,
                                       'membership_id', %L::uuid, 'acting_as_platform', false)
                                     when 'order.delivery_unassigned' then jsonb_build_object(
                                       'entity_type', 'order_request', 'entity_id', %L::uuid, 'warehouse_id', %L::uuid,
                                       'before', jsonb_build_object('assigned_delivery_user_id', %L::uuid),
                                       'after', jsonb_build_object('assigned_delivery_user_id', null), 'status', 'in_transit',
                                       'reason', null, 'cause', 'member_removed', 'released_user_id', %L::uuid,
                                       'membership_id', %L::uuid, 'acting_as_platform', false)
                                     when 'order.picking_released' then jsonb_build_object(
                                       'entity_type', 'order_request', 'entity_id', %L::uuid, 'warehouse_id', %L::uuid,
                                       'before', jsonb_build_object('assigned_picker_id', %L::uuid), 'after', jsonb_build_object('assigned_picker_id', null),
                                       'reason', null, 'cause', 'member_removed', 'released_user_id', %L::uuid,
                                       'membership_id', %L::uuid, 'acting_as_platform', false)
                                     when 'maintenance_request.owner_assigned' then jsonb_build_object(
                                       'entity_type', 'maintenance_request', 'entity_id', %L::uuid, 'warehouse_id', null,
                                       'before', jsonb_build_object('local_owner_user_id', %L::uuid), 'after', jsonb_build_object('local_owner_user_id', null),
                                       'local_owner_user_id', null,
                                       'reason', null, 'cause', 'member_removed', 'released_user_id', %L::uuid,
                                       'membership_id', %L::uuid, 'acting_as_platform', false)
                                     end)::text, ',' order by a.event collate "C")
                                 from public.audit_logs a
                                where a.organization_id = %L and a.metadata ? 'released_user_id'
                                  and a.event <> 'user.open_work_released'
                                  and (a.event <> 'order.delivery_unassigned' or a.metadata ->> 'entity_id' = %L)$q$,
                               :ccOpen, :whA, :sub, :sub, :mSubA,
                               :oTrans, :whA, :sub, :sub, :mSubA,
                               :oPick, :whA, :sub, :sub, :mSubA,
                               :mrOpen, :sub, :sub, :mSubA,
                               :orgA, :oTrans)),
  'ok:1:cycle_count.released=true,maintenance_request.owner_assigned=true,order.delivery_unassigned=true,order.picking_released=true',
  'A1c: each per-object row: entity, warehouse, before and after (the person, then null), the in-transit delivery''s status, reason null, cause, the person released, the membership and acting_as_platform');
select is(
  pg_temp.attempt('authenticated', :adm, format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :sub),
                  null, format($q$select count(*) || '/' || count(*) filter (where a.metadata -> 'reason' = 'null'::jsonb)
                                 from public.audit_logs a where a.organization_id = %L and a.metadata ? 'released_user_id'$q$, :orgA)),
  'ok:1:6/6',
  'K1: every row the release writes carries reason as JSON null, never a string (the order page prints a string reason as "Reason: ...")');
select is(
  pg_temp.attempt('service_role', null, format('delete from public.organization_members where id = %L', :mPaA),
                  null, format($q$select count(*) || '/' || count(*) filter (where a.metadata -> 'reason' = 'null'::jsonb)
                                 from public.audit_logs a where a.organization_id = %L and a.metadata ? 'released_user_id'$q$, :orgA)),
  'ok:1:2/2',
  'K1b: so does every row of an ended Act-as seat');
select is(
  pg_temp.attempt('authenticated', :adm, format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :idle),
                  null, format('select pg_temp.released_rows(%L) || ''/'' || (select count(*) from public.audit_logs where organization_id = %L and event = ''user.open_work_released'')', :idle, :orgA)),
  'ok:1:0/0',
  'A2: removing a member who holds no open work writes no audit row, not even the summary');
select is(
  pg_temp.attempt('authenticated', :own, format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :adm),
                  null, format($q$select string_agg(pg_temp.who(a.user_id) || ':' || (a.metadata ->> 'cause') || ':' || (a.metadata ->> 'pending_invites')
                                                    || ':' || ((a.metadata ->> 'cycle_counts')::int + (a.metadata ->> 'picks')::int
                                                               + (a.metadata ->> 'deliveries')::int + (a.metadata ->> 'schedule_events')::int
                                                               + (a.metadata ->> 'maintenance_requests')::int + (a.metadata ->> 'escalation_claims')::int
                                                               + (a.metadata ->> 'warehouses')::int), ',')
                                 from public.audit_logs a
                                where a.organization_id = %L and a.metadata ->> 'released_user_id' = %L$q$, :orgA, :adm)),
  'ok:1:own:member_removed:1:0',
  'A2b: removing an admin whose only open item is one pending invitation writes the summary alone, with 1 invitation withdrawn and 0 of everything else');
select is(
  pg_temp.attempt('authenticated', :pa, format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :sub),
                  null, format($q$select pg_temp.audit(%L) || ' # ' || count(*) filter (where (a.metadata ->> 'acting_as_platform')::boolean)
                                 from public.audit_logs a where a.organization_id = %L and a.metadata ? 'released_user_id'$q$, :orgA, :orgA)),
  'ok:1:cycle_count.released/ccOpen@pa:member_removed,maintenance_request.owner_assigned/mrOpen@pa:member_removed,'
  || 'order.delivery_unassigned/oDrv@pa:member_removed,order.delivery_unassigned/oTrans@pa:member_removed,'
  || 'order.picking_released/oPick@pa:member_removed,user.open_work_released/mSubA@pa:member_removed # 6',
  'A3: a platform admin acting as A who removes S is the actor, and every row says acting_as_platform true');

-- ══ C. member_open_work (the Remove dialog's read) ═════════════════════════
select is(
  pg_temp.call_as('authenticated', :adm, format('select public.member_open_work(%L)::text', :mSubA)),
  '{"picks": 1, "deliveries": 2, "warehouses": 1, "cycleCounts": 1, "pendingInvites": 2, "scheduleEvents": 1, "escalationClaims": 1, "maintenanceRequests": 1}',
  'C1: the admin reads S''s open work in A per kind (1 count, 1 pick, 2 deliveries, 1 event, 1 maintenance request, 1 claim, 1 warehouse, 2 invitations not accepted or revoked); S''s closed deliveries, maintenance requests and claim, accepted and revoked invitations and B''s invitation are not counted');
select is(
  pg_temp.attempt('authenticated', :adm, format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :sub),
                  null, format($q$select jsonb_build_object(
                                   'cycleCounts', m -> 'cycle_counts', 'picks', m -> 'picks', 'deliveries', m -> 'deliveries',
                                   'scheduleEvents', m -> 'schedule_events', 'maintenanceRequests', m -> 'maintenance_requests',
                                   'escalationClaims', m -> 'escalation_claims', 'warehouses', m -> 'warehouses',
                                   'pendingInvites', m -> 'pending_invites')::text
                                 from (select a.metadata m from public.audit_logs a
                                        where a.organization_id = %L and a.event = 'user.open_work_released') s$q$, :orgA)),
  'ok:1:' || pg_temp.call_as('authenticated', :adm, format('select public.member_open_work(%L)::text', :mSubA)),
  'C1b: what the read says before the press is exactly what the removal releases, per kind (the summary row)');
select is(
  pg_temp.call_as('authenticated', :mgr,  format('select public.member_open_work(%L)::text', :mSubA)) || ' | '
  || pg_temp.call_as('authenticated', :mgr2, format('select public.member_open_work(%L)::text', :mSubA)) || ' | '
  || pg_temp.call_as('authenticated', :sub,  format('select public.member_open_work(%L)::text', :mSubA)) || ' | '
  || pg_temp.call_as('authenticated', :adm2, format('select public.member_open_work(%L)::text', :mSubA)) || ' | '
  || pg_temp.call_as('authenticated', :outB, format('select public.member_open_work(%L)::text', :mSubA)) || ' | '
  || pg_temp.call_as('authenticated', :adm,  format('select public.member_open_work(%L)::text', :nobody)) || ' | '
  || pg_temp.call_as('authenticated', :adm,  format('select public.member_open_work(%L)::text', :mSubB)) || ' | '
  || pg_temp.call_as('anon', null,           format('select public.member_open_work(%L)::text', :mSubA)) || ' | '
  || pg_temp.call_as('authenticated', null,  format('select public.member_open_work(%L)::text', :mSubA)),
  '42501:-:forbidden | 42501:-:forbidden | 42501:-:forbidden | 42501:-:forbidden | P0002:-:member_not_found | P0002:-:member_not_found | '
  || 'P0002:-:member_not_found | 42501:-:permission denied for function member_open_work | 42501:-:unauthenticated',
  'C2: refused for a manager, a manager granted members:remove (the admin floor: the removal''s row policy refuses them too, G3), S (staff), an admin whose members:remove is revoked (42501 forbidden), an outsider, an unknown id and A''s admin asking about a membership in B (P0002), anon (no EXECUTE) and no subject (42501 unauthenticated)');
select is(
  pg_temp.call_as('authenticated', :own, format('select (public.member_open_work(%L) ->> ''deliveries'')', :mSubA)) || ' | '
  || pg_temp.call_as('authenticated', :pa, format('select (public.member_open_work(%L) ->> ''deliveries'')', :mSubA)) || ' | '
  || pg_temp.call_as('authenticated', :adm, format('select (public.member_open_work(%L) ->> ''cycleCounts'')', :mIdleA)),
  '2 | 2 | 0',
  'C3: the owner and an Act-as seat (an owner row) read it too; a member with nothing open reads 0');
select is(
  pg_temp.call_as('authenticated', :own, format('select (public.member_open_work(%L) ->> ''pendingInvites'')', :mAdmA)) || ' | '
  || pg_temp.call_as('authenticated', :adm, format('select (public.member_open_work(%L) ->> ''pendingInvites'')', :mIdleA)) || ' | '
  || pg_temp.call_as('authenticated', :adm, format('select (public.member_open_work(%L) ->> ''pendingInvites'')', :mPaA)),
  '1 | 0 | 0',
  'C4: the read counts an admin''s one pending invitation, 0 for a member who sent none, and 0 for an Act-as seat (its invitations stay, I5)');

-- ══ P. Posture ═════════════════════════════════════════════════════════════
select is(
  (select t.tgtype::text || '/' || t.tgenabled::text || '/' || t.tgfoid::regproc::text
     from pg_trigger t
    where t.tgrelid = 'public.organization_members'::regclass and t.tgname = 'trg_organization_members_release_open_work'),
  '9/O/tg_organization_members_release_open_work',
  'P1: the trigger is AFTER DELETE FOR EACH ROW (tgtype 9) on organization_members, enabled, and runs the release function');
select is(
  (select p.prosecdef::text || '|' || pg_get_userbyid(p.proowner) || '|' || coalesce(p.proconfig::text, '') || '|' || p.provolatile::text
          || '|' || has_function_privilege('public', p.oid, 'EXECUTE')::text
          || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
          || '|' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
          || '|' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
     from pg_proc p where p.oid = to_regprocedure('public.tg_organization_members_release_open_work()')),
  'true|postgres|{"search_path=public, pg_temp",lock_timeout=5s}|v|false|false|false|false',
  'P1b: the trigger function is SECURITY DEFINER, owned by postgres, search_path and lock_timeout 5s pinned, and nobody may EXECUTE it (a trigger needs none)');
select is(
  (select p.prosecdef::text || '|' || pg_get_userbyid(p.proowner) || '|' || coalesce(p.proconfig::text, '') || '|' || p.provolatile::text
          || '|' || has_function_privilege('public', p.oid, 'EXECUTE')::text
          || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
          || '|' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
          || '|' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
     from pg_proc p where p.oid = to_regprocedure('public.member_open_work(uuid)')),
  'true|postgres|{"search_path=public, pg_temp"}|s|false|false|true|false',
  'P1c: member_open_work is STABLE SECURITY DEFINER, owned by postgres, search_path pinned, EXECUTE for authenticated only');
select is(
  (select string_agg(p.proname || '=' || (p.prosrc !~* '40001|40P01')::text
                     || case when p.proname = 'tg_organization_members_release_open_work'
                             then '/' || (p.prosrc !~* '\mraise\M')::text else '' end, ',' order by p.proname)
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('tg_organization_members_release_open_work', 'member_open_work')),
  'member_open_work=true,tg_organization_members_release_open_work=true/true',
  'P2: neither body names 40001 or 40P01, and the trigger body raises nothing of its own');
select is(
  (select string_agg(distinct lower(m[2]), ',' order by lower(m[2]))
     from pg_proc p, regexp_matches(p.prosrc, '\m(update|insert\s+into|delete\s+from|merge\s+into)\s+(?:only\s+)?public\.(\w+)', 'gi') m
    where p.oid = to_regprocedure('public.tg_organization_members_release_open_work()'))
  || ' / ' ||
  (select count(*)::text
     from pg_proc p, regexp_matches(p.prosrc, '\m(delete\s+from|merge\s+into|truncate)\M', 'gi') m
    where p.oid = to_regprocedure('public.tg_organization_members_release_open_work()')),
  'audit_logs,cycle_counts,exception_occurrences,maintenance_requests,order_requests,organization_invites,schedule_events,warehouses / 0',
  'P3: the trigger writes only the seven released tables, organization_invites and audit_logs, and deletes nothing (no stock, no records)');
select is(
  (select (obj_description(to_regprocedure('public.tg_organization_members_release_open_work()'), 'pg_proc') ~ 'tg_auth_users_before_delete')::text
          || '/' || (obj_description(to_regprocedure('public.tg_organization_members_release_open_work()'), 'pg_proc') ~ 'member_open_work')::text
          || '/' || (obj_description(to_regprocedure('public.member_open_work(uuid)'), 'pg_proc') ~ 'tg_auth_users_before_delete')::text
          || '/' || (obj_description(to_regprocedure('public.member_open_work(uuid)'), 'pg_proc') ~ 'tg_organization_members_release_open_work')::text
          || '/' || (select (obj_description(t.oid, 'pg_trigger') is not null)::text from pg_trigger t
                      where t.tgname = 'trg_organization_members_release_open_work')),
  'true/true/true/true/true',
  'P4: both functions'' comments name the other two copies of the same predicates (the parity obligation), and the trigger has a comment');

-- ══ PAR. Removal and account deletion release the same set in A ════════════
select is(
  pg_temp.attempt('authenticated', :adm, format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :sub),
                  null, format('select pg_temp.work() || '' # '' || pg_temp.invites(%L)', :orgA)),
  pg_temp.attempt('postgres', null, format('delete from auth.users where id = %L', :sub), null,
                  format('select pg_temp.work() || '' # '' || pg_temp.invites(%L)', :orgA)),
  'PAR: removing S from A and deleting S''s account leave A''s open work and A''s invitations in the same state (rule #26: the copies of the predicates agree)');

-- ══ Controls ═══════════════════════════════════════════════════════════════
select is(
  pg_temp.attempt('authenticated', :adm, format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :sub),
                  $p$do $d$ begin
                       if exists (select 1 from pg_trigger where tgname = 'trg_organization_members_release_open_work') then
                         alter table public.organization_members disable trigger trg_organization_members_release_open_work;
                       end if;
                     end $d$$p$,
                  'select split_part(pg_temp.work(), '' | '', 1) || '' # '' || split_part(pg_temp.work(), '' | '', 3)'),
  'ok:1:sub/mgr/set/1 # staged_for_delivery/sub/mgr/set in_transit/sub/mgr/set',
  'M1: with the trigger off (production before 0429) the same removal leaves the count and both deliveries on S');
select is(
  pg_temp.attempt('postgres', null, format('delete from public.organizations where id = %L', :orgC), null,
                  format('select count(*)::text from public.audit_logs where organization_id = %L or metadata ->> ''released_user_id'' = %L', :orgC, :cs)),
  'ok:1:0',
  'O1: deleting an organization whose member holds work goes through, and the release writes no row (the organization is gone first)');
select is(
  pg_temp.attempt('postgres', null, format('delete from auth.users where id = %L', :sub), null,
                  format('select split_part(pg_temp.work(), '' | '', 1) || '' # '' || pg_temp.released_rows(%L)', :sub)),
  'ok:1:null/null/null/2 # 0',
  'D1: deleting S''s account still goes through, 0393 releases the count, and this trigger writes nothing (the account is gone first)');
select count(*)::int as nbase from public.notifications \gset
select is(
  pg_temp.attempt('authenticated', :adm, format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :sub),
                  null, format('select (count(*) - %s)::text from public.notifications', :nbase)),
  'ok:1:0',
  'N1: the release sends no notification');
select is(
  pg_temp.attempt('authenticated', :adm, format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :own),
                  null, 'select pg_temp.work()'),
  '42501:-:cannot remove the owner via direct delete',
  'G1: the role guard still refuses an API delete of the owner row, and with it the whole statement');
select is(
  pg_temp.attempt('authenticated', :mgr, format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :sub),
                  null, format('select split_part(pg_temp.work(), '' | '', 1) || '' # '' || pg_temp.released_rows(%L)', :sub)),
  'ok:0:sub/mgr/set/1 # 0',
  'G2: a delete the row policy refuses (a manager) removes no row and releases nothing (the app reads this 0 as a refusal)');
select is(
  pg_temp.attempt('authenticated', :mgr2, format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :sub),
                  null, format('select split_part(pg_temp.work(), '' | '', 1) || '' # '' || pg_temp.released_rows(%L)', :sub)),
  'ok:0:sub/mgr/set/1 # 0',
  'G3: so does a manager granted members:remove (the app''s gate passes; 0140''s delete policy needs admin): 0 rows, nothing released');

select * from finish();
rollback;
