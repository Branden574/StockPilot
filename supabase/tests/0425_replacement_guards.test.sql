-- supabase/tests/0425_replacement_guards.test.sql
-- pgTAP proof for the replacement guards migration (docket S7, slice S7a;
-- returns-exchange plan section 13 items 14 and 18). Written to fail against
-- the head before it (S2's 0416 with main) everywhere the section list below
-- says "red"; the M section shows each new term is the one that refuses. The
-- migration number is fixed at push time: no check here reads it (the restated
-- lines are tagged "-- S7", never with the file's number).
--
-- Personas (one organization, two warehouses A and B):
--   mgr    manager (every warehouse by role); builds every fixture
--   req    staff (A), the requester of the originals
--   stfA   staff assigned to A, granted returns:manage and orders:approve
--   stfB   staff assigned to B only, the same grants: the V-1 caller
--   stfAB  staff assigned to A and B, the same grants: may act on both
--   pkr    staff (A), a picker whose account is deleted (V7 control)
--
-- F.   The personas' write access is what the matrices assume.
-- V7.  The lines guard holds for every role (red: the service role and
--      postgres wrote a replacement's lines). An update of the workflow
--      columns within the four value rules passes with no lookup; anything
--      else on a replacement's line is 42501 replacement_lines_fixed unless
--      the RMA flag holds this transaction's id for a writer that is not an
--      API role, or it is the issue's own insert while the replacement is
--      pending approval. Controls: the issue, picking, the hand-over, Close
--      the rest, a flagged data fix, ordinary orders, the account deletion's
--      SET NULL. The 12 writers of the table and the columns each writes are
--      pinned (a new writer fails here and is reviewed against the guard;
--      deliver_order_request, which the plan's offline count included, was
--      dropped by 0115).
-- FR.  The RMA flag is never enough for an API role (the binding flag-role
--      rule): anon, authenticated and the service role setting the correct
--      transaction id are still refused by the lines guard and the header
--      guard, and the header guard now also covers a replacement's move into
--      cancelled or denied, the status trigger's flagged edge (that trigger is
--      SECURITY DEFINER, so it always sees postgres and cannot ask the role).
--      Red: the forged flag let the service role and a manager through.
--      Controls: every SECURITY DEFINER path that raises the flag still
--      passes (Cancel replacement, the RMA cancel's close of a backorder, a
--      change, Close the rest above) and so does a postgres data fix. The
--      lines guard's pending-approval exemption asks the role too (FR5): the
--      requester, a manager and the service role may not add a line to a
--      replacement still pending approval; the issue (postgres) still may.
-- V.   V-1 and S4 / 13.18: after the original moves to warehouse B (by the
--      superuser, inside the undone attempt, as 0397 B7), staff of B alone
--      are refused 42501 warehouse_write by the replacement's own warehouse,
--      before any lock, in release early, Cancel replacement, Change, the RMA
--      cancel and Close the rest, and again under the replacement's lock (the
--      RMA cancel's under-lock check is in its hook). Red: release early went
--      through, Change answered exchange_item_not_eligible, and Cancel
--      replacement and the RMA cancel were refused only inside
--      cancel_order_request (0416), after both row locks. Controls: someone
--      who writes both warehouses passes all five; an RMA with no exchange
--      cancels as before; nothing changes without a move. The gate asks the
--      live replacement only (V-1-8, V-1-9): a cancelled one left in A
--      neither refuses staff of B a new replacement or the RMA cancel, nor
--      lets staff of A act on the live one re-issued in B. The two-session
--      proof that a refused caller never waits on the RMA or the replacement
--      row is scripts/db-concurrency/0425_replacement_warehouse_gate_race.sh.
-- M.   Mutations, each inside an undone attempt: the role term out of the
--      lines guard's flag exemption, the header guard or the lines guard's
--      pending-approval exemption (M6), the header trigger without its new
--      edge, each function's first gate out (the second still refuses), and
--      the gate helper without its live filter (M7).
-- R.   The six restated bodies minus their "-- S7" lines, and the header
--      guard minus its two S7 blocks, are the bodies before (md5); the new
--      bodies are pinned.
-- P.   Posture: the new helper is SECURITY INVOKER with search_path pinned
--      and EXECUTE for nobody; the five functions keep SECURITY DEFINER, the
--      5 s lock timeout and EXECUTE for authenticated only; the hook and both
--      guards stay INVOKER with no EXECUTE; still exactly three functions set
--      the flag; each comment says the rule.
--
-- Roles: fixtures as the test superuser; every attempt through the 0397
-- helpers (attempt / try_rpc undone; rpc / call_as / write_as kept), which
-- switch role and claims inside a subtransaction. begin/rollback: nothing
-- leaks. Namespace 04250000.

begin;

select plan(43);

\set orgA    '\'04250000-0000-0000-0000-00000000000a\''
\set own     '\'04250000-0000-0000-0000-0000000000a0\''
\set mgr     '\'04250000-0000-0000-0000-0000000000a1\''
\set req     '\'04250000-0000-0000-0000-0000000000a2\''
\set stfA    '\'04250000-0000-0000-0000-0000000000a3\''
\set stfB    '\'04250000-0000-0000-0000-0000000000a4\''
\set stfAB   '\'04250000-0000-0000-0000-0000000000a5\''
\set pkr     '\'04250000-0000-0000-0000-0000000000a6\''
\set whA     '\'04250000-0000-0000-0000-0000000000d1\''
\set whB     '\'04250000-0000-0000-0000-0000000000d2\''
\set r31C    '\'04250000-0000-0000-0000-000000000c31\''
\set r12B    '\'04250000-0000-0000-0000-000000000c12\''
\set rB1     '\'04250000-0000-0000-0000-000000000c41\''
\set grp     '\'04250000-0000-0000-0000-000000000a01\''
\set gS      '\'04250000-0000-0000-0000-000000000e01\''
\set gM      '\'04250000-0000-0000-0000-000000000e02\''
\set gL      '\'04250000-0000-0000-0000-000000000e03\''
\set pY      '\'04250000-0000-0000-0000-000000000e08\''
\set pZ      '\'04250000-0000-0000-0000-000000000e09\''
\set pW      '\'04250000-0000-0000-0000-000000000e0a\''
\set bL      '\'04250000-0000-0000-0000-000000000e11\''
\set oK1     '\'04250000-0000-0000-0000-000000000101\''
\set oK2     '\'04250000-0000-0000-0000-000000000102\''
\set oK3     '\'04250000-0000-0000-0000-000000000103\''
\set oK4     '\'04250000-0000-0000-0000-000000000104\''
\set oK5     '\'04250000-0000-0000-0000-000000000105\''
\set oK6     '\'04250000-0000-0000-0000-000000000106\''
\set oK7     '\'04250000-0000-0000-0000-000000000107\''
\set oK8     '\'04250000-0000-0000-0000-000000000108\''
\set oK9     '\'04250000-0000-0000-0000-000000000109\''
\set oK10    '\'04250000-0000-0000-0000-00000000010a\''
\set oK11    '\'04250000-0000-0000-0000-00000000010b\''
\set oK12    '\'04250000-0000-0000-0000-00000000010c\''
\set oOrd    '\'04250000-0000-0000-0000-000000000120\''
\set oPend   '\'04250000-0000-0000-0000-000000000901\''
\set lK1     '\'04250000-0000-0000-0000-000000000201\''
\set lK2     '\'04250000-0000-0000-0000-000000000202\''
\set lK3     '\'04250000-0000-0000-0000-000000000203\''
\set lK4     '\'04250000-0000-0000-0000-000000000204\''
\set lK5     '\'04250000-0000-0000-0000-000000000205\''
\set lK6     '\'04250000-0000-0000-0000-000000000206\''
\set lK7     '\'04250000-0000-0000-0000-000000000207\''
\set lK8     '\'04250000-0000-0000-0000-000000000208\''
\set lK9     '\'04250000-0000-0000-0000-000000000209\''
\set lK10    '\'04250000-0000-0000-0000-00000000020a\''
\set lK11    '\'04250000-0000-0000-0000-00000000020b\''
\set lK12    '\'04250000-0000-0000-0000-00000000020c\''
\set lOrd    '\'04250000-0000-0000-0000-000000000220\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,   '0425-own@0425.test',   '{}'::jsonb),
  (:mgr,   '0425-mgr@0425.test',   '{}'::jsonb),
  (:req,   '0425-req@0425.test',   '{}'::jsonb),
  (:stfA,  '0425-stfa@0425.test',  '{}'::jsonb),
  (:stfB,  '0425-stfb@0425.test',  '{}'::jsonb),
  (:stfAB, '0425-stfab@0425.test', '{}'::jsonb),
  (:pkr,   '0425-pkr@0425.test',   '{}'::jsonb)
  on conflict (id) do nothing;
-- An org insert enables the default modules (orders among them); returns is
-- off by default and is turned on here.
insert into public.organizations (id, name, slug) values (:orgA, '0425 Replacement Guards', '0425-replacement-guards');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,   'owner',   now()),
  (:orgA, :mgr,   'manager', now()),
  (:orgA, :req,   'staff',   now()),
  (:orgA, :stfA,  'staff',   now()),
  (:orgA, :stfB,  'staff',   now()),
  (:orgA, :stfAB, 'staff',   now()),
  (:orgA, :pkr,   'staff',   now());
insert into public.organization_modules (organization_id, module_id, enabled, tier, settings) values
  (:orgA, 'returns', true, 'optional', '{}'::jsonb)
on conflict (organization_id, module_id) do update set enabled = true;
-- The 0188 trigger creates Staging and Unplaced per warehouse.
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, '0425 Main',   'WH-0425A', 'active'),
  (:whB, :orgA, '0425 Second', 'WH-0425B', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary, charter_id) values
  (:orgA, :req,   :whA, true,  null),
  (:orgA, :stfA,  :whA, true,  null),
  (:orgA, :stfB,  :whB, true,  null),
  (:orgA, :stfAB, :whA, true,  null),
  (:orgA, :stfAB, :whB, false, null),
  (:orgA, :pkr,   :whA, true,  null);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :stfA,  'returns:manage', true),
  (:orgA, :stfA,  'orders:approve', true),
  (:orgA, :stfB,  'returns:manage', true),
  (:orgA, :stfB,  'orders:approve', true),
  (:orgA, :stfAB, 'returns:manage', true),
  (:orgA, :stfAB, 'orders:approve', true);
insert into public.locations (id, organization_id, warehouse_id, name, type, kind, created_at) values
  (:r31C, :orgA, :whA, '31-C', 'shelf', 'rack', now() - interval '60 minutes'),
  (:r12B, :orgA, :whA, '12-B', 'shelf', 'rack', now() - interval '59 minutes'),
  (:rB1,  :orgA, :whB, '41-A', 'shelf', 'rack', now() - interval '58 minutes');
insert into public.product_groups (id, organization_id, name, group_key, default_counting_unit, status) values
  (:grp, :orgA, 'Guard Shirt', '0425|guard shirt', 'each', 'active');
-- Single-rack items seed their holding at primary_location_id (the seed
-- trigger). The part items hold 1 each: an exchange of 2 goes on backorder.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, unit_cost, status, tracking_type,
   primary_location_id, group_id, variant_size, variant_key) values
  (:gS, :orgA, :whA, '0425-S',  'Guard Shirt',    10, 7, 'active', 'none', :r12B, :grp, 'S', 'S'),
  (:gM, :orgA, :whA, '0425-M',  'Guard Shirt',    10, 7, 'active', 'none', :r31C, :grp, 'M', 'M'),
  (:gL, :orgA, :whA, '0425-L',  'Guard Shirt',    10, 7, 'active', 'none', :r12B, :grp, 'L', 'L'),
  (:pY, :orgA, :whA, '0425-PY', 'Guard Part Y',    1, 7, 'active', 'none', :r12B, null, null, null),
  (:pZ, :orgA, :whA, '0425-PZ', 'Guard Part Z',    1, 7, 'active', 'none', :r12B, null, null, null),
  (:pW, :orgA, :whA, '0425-PW', 'Guard Part W',    1, 7, 'active', 'none', :r12B, null, null, null),
  (:bL, :orgA, :whB, '0425-BL', 'Guard Shirt B',   5, 7, 'active', 'none', :rB1,  null, null, null);
-- Handed-over originals and one approved ordinary order, by the superuser
-- (the insert guard holds API roles only).
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, requester_name, fulfillment_type) values
  (:oK1,  :orgA, :whA, 'completed', 'internal', :req, 'Req Person', 'pickup'),
  (:oK2,  :orgA, :whA, 'completed', 'internal', :req, 'Req Person', 'pickup'),
  (:oK3,  :orgA, :whA, 'completed', 'internal', :req, 'Req Person', 'pickup'),
  (:oK4,  :orgA, :whA, 'completed', 'internal', :req, 'Req Person', 'pickup'),
  (:oK5,  :orgA, :whA, 'completed', 'internal', :req, 'Req Person', 'pickup'),
  (:oK6,  :orgA, :whA, 'completed', 'internal', :req, 'Req Person', 'pickup'),
  (:oK7,  :orgA, :whA, 'completed', 'internal', :req, 'Req Person', 'pickup'),
  (:oK8,  :orgA, :whA, 'completed', 'internal', :req, 'Req Person', 'pickup'),
  (:oK9,  :orgA, :whA, 'completed', 'internal', :req, 'Req Person', 'pickup'),
  (:oK10, :orgA, :whA, 'completed', 'internal', :req, 'Req Person', 'pickup'),
  (:oK11, :orgA, :whA, 'completed', 'internal', :req, 'Req Person', 'pickup'),
  (:oK12, :orgA, :whA, 'completed', 'internal', :req, 'Req Person', 'pickup'),
  (:oOrd, :orgA, :whA, 'approved',  'internal', :req, 'Req Person', 'pickup');
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, quantity_fulfilled) values
  (:lK1,  :oK1,  :gM, 4, 4),
  (:lK2,  :oK2,  :gM, 4, 4),
  (:lK3,  :oK3,  :gM, 4, 4),
  (:lK4,  :oK4,  :gM, 4, 4),
  (:lK5,  :oK5,  :gM, 4, 4),
  (:lK6,  :oK6,  :gM, 4, 4),
  (:lK7,  :oK7,  :gM, 4, 4),
  (:lK8,  :oK8,  :gM, 4, 4),
  (:lK9,  :oK9,  :gM, 4, 4),
  (:lK10, :oK10, :gM, 4, 4),
  (:lK11, :oK11, :gM, 4, 4),
  (:lK12, :oK12, :gM, 4, 4),
  (:lOrd, :oOrd, :gS, 2, 0);

-- ══ Helpers (the 0397 file's, unchanged in shape) ═════════════════════════
create function pg_temp.hint(p_hint text) returns text language sql immutable as $$
  select case when p_hint is null or p_hint = ''
                or p_hint like 'Grant the required privileges to the current role with:%'
              then '-' else p_hint end
$$;
-- One statement as p_as with p_sub's claims, then ALWAYS undone.
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
    raise exception using errcode = 'XX425', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  perform set_config('role', 'none', true);
  if v_state = 'XX425' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
end $$;
create function pg_temp.write_as(p_as text, p_sub uuid, p_sql text)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v_n bigint;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql;
    get diagnostics v_n = row_count;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', '', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
    perform set_config('role', 'none', true);
    return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
  end;
  return 'ok:' || v_n::text;
end $$;
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
    perform set_config('role', 'none', true);
    return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
  end;
  return coalesce(v, 'null');
end $$;
create function pg_temp.rpc(p_as text, p_sub uuid, p_sql text)
returns jsonb language plpgsql as $$
declare v jsonb; v_state text; v_msg text; v_hint text; v_detail text;
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
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text,
                            v_hint = pg_exception_hint, v_detail = pg_exception_detail;
    perform set_config('role', 'none', true);
    return jsonb_build_object('error', v_state, 'hint', pg_temp.hint(v_hint), 'message', v_msg, 'detail', v_detail);
  end;
  return coalesce(v, 'null'::jsonb);
end $$;
-- The call as p_sub after p_prep (run as the superuser), then ALWAYS undone.
create function pg_temp.try_rpc(p_as text, p_sub uuid, p_sql text, p_prep text default null)
returns jsonb language plpgsql as $$
declare v jsonb; v_state text; v_msg text; v_hint text; v_detail text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    raise exception using errcode = 'XX425', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text,
                            v_hint = pg_exception_hint, v_detail = pg_exception_detail;
  end;
  perform set_config('role', 'none', true);
  if v_state = 'XX425' then
    return coalesce(v, 'null'::jsonb);
  end if;
  return jsonb_build_object('error', v_state, 'hint', pg_temp.hint(v_hint), 'message', v_msg, 'detail', v_detail);
end $$;
create function pg_temp.err(j jsonb) returns text language sql immutable as $$
  select case when j ? 'error' then (j->>'error') || ':' || coalesce(j->>'hint', '-') else 'ok' end
$$;
-- sqlstate:hint:message of a refusal (the message tells which check refused:
-- the S7 gate says warehouse_write, 0416's order check says forbidden), or
-- changed=<changed> when the call went through.
create function pg_temp.e3(j jsonb) returns text language sql immutable as $$
  select case when j ? 'error' then (j->>'error') || ':' || coalesce(j->>'hint', '-') || ':' || coalesce(j->>'message', '-')
              else 'changed=' || coalesce(j->>'changed', '-') end
$$;
create function pg_temp.xbody(p_line uuid, p_qty numeric, p_exchange jsonb default null)
returns jsonb language sql immutable as $$
  select jsonb_build_object('reasonCode', 'other', 'itemIsHere', false,
           'lines', jsonb_build_array(jsonb_build_object('orderRequestLineId', p_line, 'quantity', p_qty, 'disposition', 'restock')
                                      || case when p_exchange is null then '{}'::jsonb
                                              else jsonb_build_object('exchange', p_exchange) end))
$$;
create function pg_temp.mk(p_sub uuid, p_order uuid, p_body jsonb) returns text language plpgsql as $$
declare j jsonb;
begin
  j := pg_temp.rpc('authenticated', p_sub,
                   format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', p_order, p_body));
  return coalesce(j->>'returnId', pg_temp.err(j));
end $$;
create function pg_temp.xdec(p_rma uuid, p_action text default 'approve', p_extra jsonb default '{}'::jsonb,
                             p_repl jsonb default null)
returns jsonb language sql as $$
  select jsonb_build_object(
           'lines', (select jsonb_agg(jsonb_build_object('returnLineId', rl.id, 'disposition', 'restock',
                                                         'restock', jsonb_build_object('target', 'staging')))
                       from public.return_lines rl where rl.return_id = p_rma),
           'exchange', coalesce((select jsonb_agg(jsonb_build_object('exchangeLineId', xl.id, 'action', p_action) || p_extra)
                                   from public.return_exchange_lines xl
                                  where xl.return_id = p_rma and xl.status = 'requested' and p_action is not null), '[]'::jsonb))
         || case when p_repl is null then '{}'::jsonb else jsonb_build_object('replacement', p_repl) end
$$;
create function pg_temp.rev(p_rma uuid) returns integer language sql as $$
  select coalesce(max(d.revision), 0)::integer from public.return_decisions d
   where d.return_id = p_rma and d.kind in ('approved', 'replacement_changed', 'replacement_cancelled', 'cancelled')
$$;
create function pg_temp.live(p_rma uuid) returns uuid language sql as $$
  select o.id from public.order_requests o
   where o.replacement_for_return_id = p_rma and o.status not in ('cancelled', 'denied')
$$;
create function pg_temp.holds(p_order uuid) returns numeric language sql as $$
  select coalesce(trim_scale(sum(sr.quantity)), 0) from public.stock_reservations sr
   where sr.order_request_id = p_order and sr.released_at is null
$$;
create function pg_temp.approve(p_sub uuid, p_rma uuid, p_dec jsonb) returns jsonb language plpgsql as $$
begin
  return pg_temp.rpc('authenticated', p_sub,
                     format('select public.approve_return(%L, %s, %L::jsonb, false)', p_rma, pg_temp.rev(p_rma), p_dec));
end $$;
-- An exchange of 1 of p_line's units for p_item, approved (held once).
create function pg_temp.exchange(p_order uuid, p_line uuid, p_item uuid) returns text language plpgsql as $$
declare v_rma text; v_j jsonb;
begin
  v_rma := pg_temp.mk('04250000-0000-0000-0000-0000000000a1', p_order, pg_temp.xbody(p_line, 1, jsonb_build_object('itemId', p_item)));
  v_j := pg_temp.approve('04250000-0000-0000-0000-0000000000a1', v_rma::uuid, pg_temp.xdec(v_rma::uuid));
  if v_j ? 'error' or pg_temp.live(v_rma::uuid) is null then
    raise exception 'exchange setup: % %', v_rma, v_j;
  end if;
  return v_rma;
end $$;
create function pg_temp.pick(p_sub uuid, p_order uuid) returns text language plpgsql as $$
declare v text;
begin
  v := pg_temp.write_as('authenticated', p_sub,
         format($q$update public.order_requests set status = 'pick_slip_generated', pick_slip_generated_by = %L where id = %L$q$,
                p_sub, p_order));
  if v <> 'ok:1' then
    return v;
  end if;
  return pg_temp.call_as('authenticated', p_sub, format('select (public.complete_picking(%L)).status', p_order));
end $$;
create function pg_temp.stage(p_sub uuid, p_order uuid) returns text language plpgsql as $$
declare v text;
begin
  v := pg_temp.call_as('authenticated', p_sub, format('select (public.generate_order_packing_slips(%L)).status', p_order));
  if v <> 'packing_slip_generated' then
    return v;
  end if;
  return pg_temp.write_as('authenticated', p_sub,
           format($q$update public.order_requests set status = 'staged_for_pickup', staged_by = %L where id = %L$q$, p_sub, p_order));
end $$;
-- An exchange of 2 of a line's units for p_item (1 in stock): approved on
-- backorder (1 held), released early, picked, staged and signed: the
-- replacement is backordered with 1 handed over and 1 never held. The RMA
-- stays approved. Answers the RMA id.
create function pg_temp.part_handed_over(p_order uuid, p_line uuid, p_item uuid) returns text language plpgsql as $$
declare v_rma text; v_live uuid; v_out text;
begin
  v_rma := pg_temp.mk('04250000-0000-0000-0000-0000000000a1', p_order, pg_temp.xbody(p_line, 2, jsonb_build_object('itemId', p_item)));
  perform pg_temp.approve('04250000-0000-0000-0000-0000000000a1', v_rma::uuid,
                          pg_temp.xdec(v_rma::uuid, 'approve', '{}'::jsonb, '{"whenShort":"backorder"}'::jsonb));
  perform pg_temp.rpc('authenticated', '04250000-0000-0000-0000-0000000000a1',
                      format($q$select public.release_return_replacement_early(%L, %L, 'Customer is completing an in-person exchange today.')$q$, v_rma, pg_temp.live(v_rma::uuid)));
  v_live := pg_temp.live(v_rma::uuid);
  v_out := pg_temp.pick('04250000-0000-0000-0000-0000000000a1', v_live) || '/' || pg_temp.stage('04250000-0000-0000-0000-0000000000a1', v_live)
        || '/' || pg_temp.call_as('authenticated', '04250000-0000-0000-0000-0000000000a1',
                                  format($q$select (public.confirm_physical_signature(%L, 'Guard tester')).status$q$, v_live));
  if v_out <> 'picking_complete/ok:1/backordered' then
    raise exception 'part_handed_over setup: %', v_out;
  end if;
  return v_rma;
end $$;
-- Rewrite one live function inside an undone attempt (the M section): the
-- named text must be in its definition exactly once.
create function pg_temp.repatch(p_sig text, p_from text, p_to text) returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(to_regprocedure(p_sig));
begin
  if v_def is null or (length(v_def) - length(replace(v_def, p_from, ''))) / greatest(length(p_from), 1) <> 1 then
    raise exception 'repatch: the text to replace is not in % exactly once', p_sig;
  end if;
  execute replace(v_def, p_from, p_to);
end $$;
-- The columns each function's body writes on order_request_lines: an insert's
-- column list, an update's assignment targets (V7-9).
create function pg_temp.line_writes(p_src text) returns text language plpgsql immutable as $$
declare
  m      text[];
  v_out  text := '';
  v_cols text;
begin
  for m in
    select regexp_matches(p_src,
      $re$((insert\s+into|update|merge\s+into|delete\s+from)\s+(only\s+)?("?public"?\s*\.\s*)?"?order_request_lines\M[^;]*)$re$, 'gi')
  loop
    if m[1] ~* '^insert' then
      v_cols := regexp_replace(substring(m[1] from '\(([^)]*)\)'), '\s+', '', 'g');
      v_out := v_out || ';insert(' || coalesce(v_cols, '?') || ')';
    elsif m[1] ~* '^update' then
      select string_agg(x.m[1], ',' order by x.n) into v_cols
        from regexp_matches(substring(m[1] from '(?i)\mset\M(.*)\mwhere\M'), '(?:^|,)\s*([a-z_]+)\s*=', 'g')
             with ordinality as x(m, n);
      v_out := v_out || ';update(' || coalesce(v_cols, '?') || ')';
    else
      v_out := v_out || ';' || lower(split_part(m[1], ' ', 1));
    end if;
  end loop;
  return substr(v_out, 2);
end $$;

-- Statement discipline (as 0396): a write a later check depends on runs in
-- its OWN statement, and every check reads in a later statement.

-- The flag as an API role would set it: inside its own statement, then the write.
\set forge '\'select set_config(\'\'stockpilot.return_exchange\'\', pg_current_xact_id()::text, true); \''

-- rA: an exchange approved (the replacement oA, approved, one line); rF and
-- rK: a replacement handed over in part, the rest on backorder (RMA
-- approved); rP: a replacement released early and on its pick slip.
select pg_temp.mk(:mgr, :oK1, pg_temp.xbody(:lK1, 1, jsonb_build_object('itemId', :gL))) as "rA" \gset
select pg_temp.err(pg_temp.approve(:mgr, :'rA', pg_temp.xdec(:'rA'))) as "rAok" \gset
select coalesce(pg_temp.live(:'rA'), '00000000-0000-0000-0000-000000000000'::uuid) as "oA" \gset
select pg_temp.part_handed_over(:oK2, :lK2, :pY) as "rF" \gset
select coalesce(pg_temp.live(:'rF'), '00000000-0000-0000-0000-000000000000'::uuid) as "oF" \gset
select pg_temp.part_handed_over(:oK3, :lK3, :pZ) as "rK" \gset
select coalesce(pg_temp.live(:'rK'), '00000000-0000-0000-0000-000000000000'::uuid) as "oKr" \gset
select pg_temp.exchange(:oK9, :lK9, :gL) as "rP" \gset
select coalesce(pg_temp.live(:'rP'), '00000000-0000-0000-0000-000000000000'::uuid) as "oP" \gset
select pg_temp.err(pg_temp.rpc('authenticated', :mgr,
         format($q$select public.release_return_replacement_early(%L, %L, 'Customer is here today.')$q$, :'rP', :'oP'))) as "rPrel" \gset
select pg_temp.write_as('authenticated', :mgr,
         format($q$update public.order_requests set status = 'pick_slip_generated', pick_slip_generated_by = %L where id = %L$q$,
                :mgr, :'oP')) as "oPslip" \gset
-- rX: a return with no exchange, so no live replacement (FR3 gives it one
-- at pending approval inside an undone attempt).
select pg_temp.mk(:mgr, :oK10, pg_temp.xbody(:lK10, 1)) as "rX" \gset

-- ══ F. The fixture is what the matrices assume ═════════════════════════════
select is(
  (select string_agg(p.who || '=' || public.user_can_access_inventory(p.id, :whA, null, 'write')::text
                     || '/' || public.user_can_access_inventory(p.id, :whB, null, 'write')::text, ' ' order by p.who)
     from (values ('mgr', :mgr::uuid), ('stfA', :stfA::uuid), ('stfAB', :stfAB::uuid), ('stfB', :stfB::uuid)) p(who, id))
  || ' | ' || :'rAok' || ':' || (select status from public.order_requests where id = :'oA')
  || ':' || (select count(*)::text from public.order_request_lines where order_request_id = :'oA')
  || ' | ' || (select string_agg(o.status, ',' order by o.id) from public.order_requests o where o.id in (:'oF', :'oKr'))
  || ' | ' || :'rPrel' || ':' || :'oPslip' || ':' || (select status from public.order_requests where id = :'oP'),
  'mgr=true/true stfA=true/false stfAB=true/true stfB=false/true | ok:approved:1 | backordered,backordered | ok:ok:1:pick_slip_generated',
  'F1: write access by warehouse is as assumed; the exchange approval issues its replacement with one line (the issue''s insert at pending_approval passes the guard); two replacements wait on backorder after a hand-over in part; one is on its pick slip');

-- ══ V7. The lines guard, every role ═══════════════════════════════════════
select is(
  pg_temp.attempt('service_role', null,
    format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 5)', :'oA', :gS))
  || ' | ' || pg_temp.attempt('service_role', null,
    format('update public.order_request_lines set quantity_requested = 9 where order_request_id = %L', :'oA')),
  '42501:replacement_lines_fixed:replacement_lines_fixed | 42501:replacement_lines_fixed:replacement_lines_fixed',
  'V7-1, V7-2 (red: ok:1 each): the service role may no longer add a line to an approved replacement or raise a line''s quantity');
select is(
  pg_temp.attempt('postgres', null, format('update public.order_request_lines set item_id = %L where order_request_id = %L', :gS, :'oA'))
  || ' | ' || pg_temp.attempt('postgres', null, format($q$update public.order_request_lines set notes = 'x' where order_request_id = %L$q$, :'oA'))
  || ' | ' || pg_temp.attempt('postgres', null, format('update public.order_request_lines set unit_cost_at_request = 99 where order_request_id = %L', :'oA')),
  '42501:replacement_lines_fixed:replacement_lines_fixed | 42501:replacement_lines_fixed:replacement_lines_fixed'
  || ' | 42501:replacement_lines_fixed:replacement_lines_fixed',
  'V7-3 (red: ok:1 each): definer code (postgres) may no longer change a replacement line''s item, notes or cost');
select is(
  pg_temp.attempt('postgres', null,
    format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 5)', :'oA', :gS))
  || ' | ' || pg_temp.attempt('postgres', null,
    format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 5)', :'oF', :gS))
  || ' | ' || pg_temp.attempt('postgres', null,
    format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 5)', :'oP', :gS)),
  '42501:replacement_lines_fixed:replacement_lines_fixed | 42501:replacement_lines_fixed:replacement_lines_fixed'
  || ' | 42501:replacement_lines_fixed:replacement_lines_fixed',
  'V7-4 (red: ok:1 each): definer code (postgres) may no longer add a line to an approved, a backordered or a pick-slip replacement');
select is(
  pg_temp.attempt('service_role', null,
    format('update public.order_request_lines set quantity_fulfilled = 2 where order_request_id = %L', :'oA'))
  || ' | ' || pg_temp.attempt('postgres', null,
    format($q$update public.order_request_lines set quantity_fulfilled = 1 where order_request_id = %L;
              update public.order_request_lines set quantity_fulfilled = 0 where order_request_id = %L$q$, :'oA', :'oA'))
  || ' | ' || pg_temp.attempt('postgres', null,
    format($q$update public.order_request_lines set quantity_fulfilled = 1 where order_request_id = %L;
              update public.order_request_lines set returned_quantity = 2 where order_request_id = %L$q$, :'oA', :'oA'))
  || ' | ' || pg_temp.attempt('postgres', null,
    format($q$update public.order_request_lines set quantity_fulfilled = 1 where order_request_id = %L;
              update public.order_request_lines set returned_quantity = 1 where order_request_id = %L;
              update public.order_request_lines set returned_quantity = 0 where order_request_id = %L$q$, :'oA', :'oA', :'oA')),
  '42501:replacement_lines_fixed:replacement_lines_fixed | 42501:replacement_lines_fixed:replacement_lines_fixed'
  || ' | 42501:replacement_lines_fixed:replacement_lines_fixed | 42501:replacement_lines_fixed:replacement_lines_fixed',
  'V7-5 (red): on a replacement, handed over above the quantity requested, a lowered hand-over, returned above handed over and a lowered return are refused (a lower hand-over would reopen Cancel and Change and let a re-issue send those units again)');
select is(
  pg_temp.attempt('service_role', null, format('update public.order_request_lines set order_request_id = %L where id = %L', :'oA', :lOrd))
  || ' | ' || pg_temp.attempt('service_role', null,
    format('update public.order_request_lines set order_request_id = %L where order_request_id = %L', :oOrd, :'oA')),
  '42501:replacement_lines_fixed:replacement_lines_fixed | 42501:replacement_lines_fixed:replacement_lines_fixed',
  'V7-6 (red: ok:1 each): a line may not move into or out of a replacement');
select is(
  pg_temp.attempt('service_role', null, format('update public.order_request_lines set quantity_fulfilled = 1 where order_request_id = %L', :'oA'))
  || ' | ' || pg_temp.attempt('service_role', null,
    format('update public.order_request_lines set quantity_picked = 1, picked_at = now() where order_request_id = %L', :'oA'))
  || ' | ' || pg_temp.attempt('postgres', null,
    format($q$select set_config('stockpilot.return_exchange', pg_current_xact_id()::text, true);
              update public.order_request_lines set item_id = %L where order_request_id = %L$q$, :gS, :'oA'))
  || ' | ' || pg_temp.attempt('service_role', null, format('update public.order_request_lines set quantity_requested = 3 where id = %L', :lOrd))
  || ' | ' || pg_temp.attempt('postgres', null,
    format($q$update public.order_request_lines set quantity_fulfilled = 2 where id = %L;
              update public.order_request_lines set quantity_fulfilled = 0 where id = %L$q$, :lOrd, :lOrd)),
  'ok:1 | ok:1 | ok:1 | ok:1 | ok:1',
  'V7-7 controls: the workflow columns stay writable within their rules (handed over up to the quantity requested; picking); a data fix under the RMA flag by postgres still changes a replacement line; an ordinary order''s lines are unaffected, a lowered hand-over included');
-- The picker's account deletion: ON DELETE SET NULL of picked_by and
-- packed_by is an update of two workflow columns (run as the table owner).
select pg_temp.write_as('postgres', null,
         format('update public.order_request_lines set picked_by = %L, packed_by = %L where order_request_id = %L', :pkr, :pkr, :'oA')) as "pkrSet" \gset
select is(
  :'pkrSet' || ' | ' || pg_temp.attempt('postgres', null, format('delete from auth.users where id = %L', :pkr), null,
    format($q$select coalesce(picked_by::text, 'null') || '/' || coalesce(packed_by::text, 'null')
                from public.order_request_lines where order_request_id = %L$q$, :'oA')),
  'ok:1 | ok:1:null/null',
  'V7-7 control: deleting a picker''s account still sets picked_by and packed_by to null on a replacement line');
select is(
  split_part(pg_temp.attempt('service_role', null, format('delete from public.order_request_lines where order_request_id = %L', :'oA')), ':', 1)
  || ',' || split_part(pg_temp.attempt('postgres', null, format('delete from public.order_request_lines where order_request_id = %L', :'oA')), ':', 1),
  '23503,23503',
  'V7-8 regression pin: deleting a line the RMA names stays refused by the foreign key, for the service role and postgres (no DELETE arm needed)');
-- The full flow through the guard on rF: approved on backorder, released,
-- picked, staged, signed (1 of 2 handed over; above), received, Close the rest.
select pg_temp.call_as('authenticated', :mgr, format('select (public.receive_return(%L))->>''status''', :'rF')) as "rFrecv" \gset
select pg_temp.rpc('authenticated', :mgr,
    format($q$select public.close_return_replacement_rest(%L, %s, 'No longer needed', null)$q$, :'rF', pg_temp.rev(:'rF'))) as "jF" \gset
select is(
  :'rFrecv' || ':' || coalesce((:'jF'::jsonb)->>'changed', pg_temp.err(:'jF'::jsonb)) || ':'
  || (select status from public.order_requests where id = :'oF') || ':' || pg_temp.holds(:'oF')::text || ':'
  || (select trim_scale(sum(quantity_fulfilled))::text from public.order_request_lines where order_request_id = :'oF'),
  'received:true:completed:0:1',
  'V7-7 control: picking, staging, the signature and Close the rest (close_partial under the flag) still run end to end on a replacement');

-- V7-9. The census of every function whose body writes order_request_lines
-- (every schema but the catalogs, extension members and session temp
-- schemas), with what each writes. On a replacement each of these writes
-- only the workflow columns within the value rules, or inserts while the
-- replacement is pending approval (_return_replacement_issue), or refuses a
-- replacement first (_order_request_line_top_up, add_order_request_lines); a
-- new writer fails here and is reviewed against the guard.
create temp view s7_fn_scope as
select n.nspname || '.' || p.proname as fn, p.prosrc
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname not in ('pg_catalog', 'information_schema')
   and n.nspname !~ '^pg_(toast_)?temp_'
   and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e');
select is(
  (select string_agg(f.fn || ':' || pg_temp.line_writes(f.prosrc), E'\n' order by f.fn collate "C")
     from s7_fn_scope f
    where f.prosrc ~* $re$(insert\s+into|update|merge\s+into|delete\s+from)\s+(only\s+)?("?public"?\s*\.\s*)?"?order_request_lines\M$re$),
  'ledger.process_return_disposition:update(returned_quantity)' || E'\n'
  || 'public._order_request_line_top_up:update(quantity_requested)' || E'\n'
  || 'public._return_replacement_issue:insert(order_request_id,item_id,quantity_requested,unit_cost_at_request,unit_price_at_request)' || E'\n'
  || 'public.add_order_request_lines:insert(order_request_id,item_id,quantity_requested,unit_cost_at_request)' || E'\n'
  || 'public.cancel_order_request:update(quantity_picked)' || E'\n'
  || 'public.complete_picking:update(quantity_picked)' || E'\n'
  || 'public.confirm_order_signature:update(quantity_fulfilled,quantity_picked)' || E'\n'
  || 'public.confirm_physical_signature:update(quantity_fulfilled,quantity_picked)' || E'\n'
  || 'public.create_order_request:insert(order_request_id,item_id,quantity_requested,notes)' || E'\n'
  || 'public.insert_order_request_with_lines:insert(order_request_id,item_id,quantity_requested,unit_cost_at_request,unit_price_at_request,notes)' || E'\n'
  || 'public.partial_pick_line:update(quantity_picked,picked_at,picked_by)' || E'\n'
  || 'public.resume_fulfillment:update(quantity_picked)',
  'V7-9: the 12 writers of order_request_lines and what each writes, as pinned (the lines guard''s allow-list covers every update here; a new writer fails here)');
select is(
  (select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgname = 'trg_zz_order_request_lines_replacement_guard'),
  'CREATE TRIGGER trg_zz_order_request_lines_replacement_guard BEFORE INSERT OR UPDATE ON public.order_request_lines FOR EACH ROW EXECUTE FUNCTION tg_order_request_lines_replacement_guard()',
  'V7-9 (red: BEFORE INSERT): the lines guard fires on insert and update, same name and sort position');

-- ══ FR. The RMA flag is never enough for an API role ══════════════════════
select is(
  pg_temp.attempt('authenticated', :mgr,
    :forge || format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 1)', :'oA', :gS))
  || ' | ' || pg_temp.attempt('service_role', null,
    :forge || format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 1)', :'oA', :gS))
  || ' | ' || pg_temp.attempt('service_role', null,
    :forge || format('update public.order_request_lines set quantity_requested = 9 where order_request_id = %L', :'oA')),
  '42501:replacement_lines_fixed:replacement_lines_fixed | 42501:replacement_lines_fixed:replacement_lines_fixed'
  || ' | 42501:replacement_lines_fixed:replacement_lines_fixed',
  'FR1 (red for the service role: ok:1 each): a manager (authenticated) and the service role that set the flag to this transaction''s id are still refused a replacement''s lines');
select is(
  pg_temp.attempt('authenticated', :mgr, :forge || format('update public.order_requests set warehouse_id = %L where id = %L', :whB, :'oA'))
  || ' | ' || pg_temp.attempt('service_role', null, :forge || format('update public.order_requests set warehouse_id = %L where id = %L', :whB, :'oA')),
  '42501:replacement_cancel_via_return:replacement_cancel_via_return | 42501:replacement_cancel_via_return:replacement_cancel_via_return',
  'FR2 (red: ok:1 each): the header guard: a manager and the service role that set the flag are still refused moving a replacement to another warehouse');
select is(
  pg_temp.attempt('service_role', null, :forge || format($q$update public.order_requests set status = 'cancelled' where id = %L$q$, :'oA'))
  || ' | ' || pg_temp.attempt('authenticated', :mgr,
    :forge || format($q$update public.order_requests set status = 'denied', denied_reason = 'Not needed' where id = %L$q$, :oPend),
    format($q$insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type,
                                                 replacement_for_return_id)
              values (%L, %L, %L, 'pending_approval', 'internal', %L, 'pickup',
                      %L)$q$, :oPend, :orgA, :whA, :req, :'rX'),
    null)
  || ' | ' || pg_temp.attempt('authenticated', :mgr, :forge || format($q$update public.order_requests set status = 'cancelled' where id = %L$q$, :'oA')),
  '42501:replacement_cancel_via_return:replacement_cancel_via_return | 42501:replacement_cancel_via_return:replacement_cancel_via_return'
  || ' | 42501:status_through_rpc_only:order_status_through_rpc_only',
  'FR3 (red: ok:1, ok:1): the status trigger''s flagged edge is asked of the role too: the service role cancelling an approved replacement and a manager denying a pending one, each with the flag set, are refused (the header guard, SECURITY INVOKER, now also fires on a move into cancelled or denied); a manager''s raw cancel stays refused by the 0387 workflow guard');
-- rC: Cancel replacement; rS: a change (substitution); rK: the RMA cancel
-- closes its backorder. Each a SECURITY DEFINER path that raises the flag.
select pg_temp.exchange(:oK6, :lK6, :gL) as "rC" \gset
select coalesce(pg_temp.live(:'rC'), '00000000-0000-0000-0000-000000000000'::uuid) as "oC" \gset
select pg_temp.exchange(:oK7, :lK7, :gL) as "rS" \gset
select coalesce(pg_temp.live(:'rS'), '00000000-0000-0000-0000-000000000000'::uuid) as "oS" \gset
select pg_temp.e3(pg_temp.rpc('authenticated', :mgr,
         format($q$select public.cancel_return_replacement(%L, %s, 'Not needed any more', null)$q$, :'rC', pg_temp.rev(:'rC')))) as "jC" \gset
select pg_temp.e3(pg_temp.rpc('authenticated', :mgr,
         format($q$select public.change_return_replacement(%L, %s, %L::jsonb, 'Size swap', 'refuse', null)$q$, :'rS', pg_temp.rev(:'rS'),
                jsonb_build_array(jsonb_build_object('exchangeLineId', (select xl.id from public.return_exchange_lines xl where xl.return_id = :'rS'),
                                                     'itemId', :gS))))) as "jS" \gset
select pg_temp.rpc('authenticated', :mgr,
         format($q$select public.cancel_return(%L, %s, 'Original kept')$q$, :'rK', pg_temp.rev(:'rK'))) as "jK" \gset
select is(
  pg_temp.attempt('postgres', null,
    format($q$select set_config('stockpilot.return_exchange', pg_current_xact_id()::text, true);
              update public.order_requests set warehouse_id = %L where id = %L$q$, :whB, :'oA'))
  || ' | ' || :'jC' || ':' || (select status from public.order_requests where id = :'oC') || ':' || pg_temp.holds(:'oC')::text
  || ' | ' || :'jS' || ':' || (select status from public.order_requests where id = :'oS')
  || ':' || (select o.status || '/' || (select l.item_id = :gS from public.order_request_lines l where l.order_request_id = o.id)::text
               from public.order_requests o where o.id = pg_temp.live(:'rS'))
  || ' | ' || coalesce((:'jK'::jsonb)->>'status', pg_temp.err(:'jK'::jsonb)) || ':' || (select status from public.order_requests where id = :'oKr')
  || ':' || pg_temp.holds(:'oKr')::text,
  'ok:1 | changed=true:cancelled:0 | changed=true:cancelled:approved/true | cancelled:completed:0',
  'FR4 controls: a postgres data fix under the flag still moves a replacement; every SECURITY DEFINER path that raises the flag still passes the role-asking guards: Cancel replacement (cancelled, holds released), a change (the old one cancelled, the new one approved), and the RMA cancel closing a part-handed-over backorder (close_partial: completed, holds released)');
-- FR5. The lines guard's other way through, the issue's own insert while the
-- replacement is pending approval, asks the role as well. Reachable without
-- the issue: the service role may insert a replacement order at any status
-- (0392 refuses it only a token, 0396's link trigger only anon and
-- authenticated), and the insert policy then lets its requester add a line
-- before it ships (0395). The pending replacement for rX is FR3's prep.
select format($q$insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type,
                                                    replacement_for_return_id)
                 values (%L, %L, %L, 'pending_approval', 'internal', %L, 'pickup', %L)$q$, :oPend, :orgA, :whA, :req, :'rX') as "pendPrep" \gset
select format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 1)', :oPend, :gL) as "pendLine" \gset
select is(
  pg_temp.attempt('authenticated', :req, :'pendLine', :'pendPrep')
  || ' | ' || pg_temp.attempt('authenticated', :mgr, :'pendLine', :'pendPrep')
  || ' | ' || pg_temp.attempt('service_role', null, :'pendLine', :'pendPrep')
  || ' | ' || pg_temp.attempt('postgres', null, :'pendLine', :'pendPrep'),
  '42501:replacement_lines_fixed:replacement_lines_fixed | 42501:replacement_lines_fixed:replacement_lines_fixed'
  || ' | 42501:replacement_lines_fixed:replacement_lines_fixed | ok:1',
  'FR5: the requester, a manager and the service role may not add a line to a replacement still pending approval; a writer that is not an API role (the issue, as postgres) still may');

-- ══ V. V-1 and S4 / 13.18: the replacement's own warehouse ═════════════════
-- rV: an exchange approved (oV, approved in A). rV2: a replacement handed
-- over in part, the RMA received. rN: a return with no exchange. Each move of
-- an original to B happens inside the undone attempt, as the superuser.
select pg_temp.exchange(:oK4, :lK4, :gL) as "rV" \gset
select coalesce(pg_temp.live(:'rV'), '00000000-0000-0000-0000-000000000000'::uuid) as "oV" \gset
select pg_temp.part_handed_over(:oK5, :lK5, :pW) as "rV2" \gset
select pg_temp.call_as('authenticated', :mgr, format('select (public.receive_return(%L))->>''status''', :'rV2')) as "rV2recv" \gset
select pg_temp.mk(:mgr, :oK8, pg_temp.xbody(:lK8, 1)) as "rN" \gset
\set moveV  '\'update public.order_requests set warehouse_id = \'\'04250000-0000-0000-0000-0000000000d2\'\' where id = \'\'04250000-0000-0000-0000-000000000104\'\'\''
\set moveV2 '\'update public.order_requests set warehouse_id = \'\'04250000-0000-0000-0000-0000000000d2\'\' where id = \'\'04250000-0000-0000-0000-000000000105\'\'\''
\set moveN  '\'update public.order_requests set warehouse_id = \'\'04250000-0000-0000-0000-0000000000d2\'\' where id = \'\'04250000-0000-0000-0000-000000000108\'\'\''
create function pg_temp.v_sql(p_fn text, p_rma uuid) returns text language sql as $$
  select case p_fn
    when 'release' then format($q$select public.release_return_replacement_early(%L, %L, 'Customer is here today.')$q$, p_rma, pg_temp.live(p_rma))
    when 'cancel_repl' then format($q$select public.cancel_return_replacement(%L, %s, 'Not needed any more', null)$q$, p_rma, pg_temp.rev(p_rma))
    when 'change_s' then format($q$select public.change_return_replacement(%L, %s, %L::jsonb, 'Size swap', 'refuse', null)$q$, p_rma, pg_temp.rev(p_rma),
                                jsonb_build_array(jsonb_build_object('exchangeLineId', (select xl.id from public.return_exchange_lines xl where xl.return_id = p_rma),
                                                                     'itemId', '04250000-0000-0000-0000-000000000e01')))
    when 'change_b' then format($q$select public.change_return_replacement(%L, %s, %L::jsonb, 'Size swap', 'refuse', null)$q$, p_rma, pg_temp.rev(p_rma),
                                jsonb_build_array(jsonb_build_object('exchangeLineId', (select xl.id from public.return_exchange_lines xl where xl.return_id = p_rma),
                                                                     'itemId', '04250000-0000-0000-0000-000000000e11')))
    when 'cancel_rma' then format($q$select public.cancel_return(%L, %s, 'Swap')$q$, p_rma, pg_temp.rev(p_rma))
    when 'rest' then format($q$select public.close_return_replacement_rest(%L, %s, 'No longer needed', null)$q$, p_rma, pg_temp.rev(p_rma))
  end
$$;
select is(
  :'rV2recv' || ' | '
  || pg_temp.e3(pg_temp.try_rpc('authenticated', :stfB, pg_temp.v_sql('release', :'rV'), :moveV)),
  'received | 42501:warehouse_write:warehouse_write',
  'V-1-1 (red: changed=true): after the original moves to B, staff of B alone may not release the replacement in A early');
select is(
  pg_temp.e3(pg_temp.try_rpc('authenticated', :stfB, pg_temp.v_sql('cancel_repl', :'rV'), :moveV)),
  '42501:warehouse_write:warehouse_write',
  'V-1-2 (red: 42501:warehouse_write:forbidden, refused only inside cancel_order_request after both row locks): Cancel replacement asks the replacement''s warehouse itself');
select is(
  pg_temp.e3(pg_temp.try_rpc('authenticated', :stfB, pg_temp.v_sql('change_s', :'rV'), :moveV)),
  '42501:warehouse_write:warehouse_write',
  'V-1-3 (red: P0001:exchange_item_not_eligible, a refusal for the wrong reason): Change asks the replacement''s warehouse');
select is(
  pg_temp.e3(pg_temp.try_rpc('authenticated', :stfB, pg_temp.v_sql('cancel_rma', :'rV'), :moveV))
  || ' | ' || pg_temp.e3(pg_temp.try_rpc('postgres', :stfB,
    format($q$select '{"called":true}'::jsonb from public._return_exchange_on_cancel(%L, %L, 'Swap')$q$, :'rV', :stfB), :moveV)),
  '42501:warehouse_write:warehouse_write | 42501:warehouse_write:warehouse_write',
  'V-1-4 (red: 42501:warehouse_write:forbidden each): the RMA cancel asks the replacement''s warehouse before its lock, and its hook asks again under the replacement''s lock');
select is(
  pg_temp.e3(pg_temp.try_rpc('authenticated', :stfB, pg_temp.v_sql('rest', :'rV2'), :moveV2)),
  '42501:warehouse_write:warehouse_write',
  'V-1-5 control (0397 B7): Close the rest still refuses staff of B alone, now before its locks (S4 / 13.18)');
select is(
  pg_temp.e3(pg_temp.try_rpc('authenticated', :stfAB, pg_temp.v_sql('release', :'rV'), :moveV))
  || ',' || pg_temp.e3(pg_temp.try_rpc('authenticated', :stfAB, pg_temp.v_sql('cancel_repl', :'rV'), :moveV))
  || ',' || pg_temp.e3(pg_temp.try_rpc('authenticated', :stfAB, pg_temp.v_sql('change_b', :'rV'), :moveV))
  || ',' || pg_temp.e3(pg_temp.try_rpc('authenticated', :stfAB, pg_temp.v_sql('cancel_rma', :'rV'), :moveV))
  || ',' || pg_temp.e3(pg_temp.try_rpc('authenticated', :stfAB, pg_temp.v_sql('rest', :'rV2'), :moveV2)),
  'changed=true,changed=true,changed=true,changed=true,changed=true',
  'V-1-5 control: someone who writes both warehouses still releases, cancels, changes (to an item of B, where the original now is), cancels the RMA and closes the rest after the move');
select is(
  pg_temp.e3(pg_temp.try_rpc('authenticated', :stfB, pg_temp.v_sql('cancel_rma', :'rN'), :moveN))
  || ' | ' || pg_temp.e3(pg_temp.try_rpc('authenticated', :stfA, pg_temp.v_sql('release', :'rV')))
  || ' | ' || pg_temp.e3(pg_temp.try_rpc('authenticated', :stfA, pg_temp.v_sql('cancel_repl', :'rV')))
  || ' | ' || pg_temp.e3(pg_temp.try_rpc('authenticated', :stfB, pg_temp.v_sql('release', :'rV'))),
  'changed=true | changed=true | changed=true | 42501:warehouse_write:warehouse_write',
  'V-1-5 controls: an RMA with no exchange still cancels after a move; with no move, staff of A act on their replacement as before and staff of B are refused by the original''s warehouse as before');
select is(
  (select status from public.returns where id = :'rV') || ':' || (select status from public.order_requests where id = :'oV')
  || ':' || pg_temp.holds(:'oV')::text || ':' || (select warehouse_id = :whA from public.order_requests where id = :oK4)::text
  || ':' || (select count(*) from public.return_decisions where return_id = :'rV' and kind in ('released_early', 'replacement_cancelled', 'replacement_changed', 'cancelled'))::text,
  'approved:approved:1:true:0',
  'V-1: every refused call left the RMA, its replacement, the hold and the original as they were (each attempt is undone; a refusal writes nothing)');
select is(
  (select string_agg(p.proname || '=' || (strpos(p.prosrc, '_return_replacement_warehouse_gate(') between 1 and strpos(lower(p.prosrc), 'for update'))::text,
                     ',' order by p.proname collate "C")
     from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname in ('cancel_return', 'cancel_return_replacement', 'change_return_replacement', 'close_return_replacement_rest',
                        'release_return_replacement_early')),
  'cancel_return=true,cancel_return_replacement=true,change_return_replacement=true,close_return_replacement_rest=true,release_return_replacement_early=true',
  'V-1-7 (red: false each): in each of the five, the replacement-warehouse gate comes before the first FOR UPDATE (S4 / 13.18 for Close the rest)');
-- The gate reads only the LIVE replacement. rQ: an exchange approved in A,
-- its replacement cancelled (Cancel replacement keeps the RMA approved), so
-- a cancelled replacement in A and none live; its original moves to B inside
-- each undone attempt. rR: the same cancel and then, with its original moved
-- to B (kept, by the superuser), a new replacement issued there by Change (an
-- item of B): a cancelled replacement in A and the live one in B. A gate that
-- read any replacement would take whichever row came first (a non-STRICT
-- SELECT INTO); with no live replacement rQ leaves it only the cancelled one.
select pg_temp.exchange(:oK11, :lK11, :gL) as "rQ" \gset
select coalesce(pg_temp.live(:'rQ'), '00000000-0000-0000-0000-000000000000'::uuid) as "oQ" \gset
select pg_temp.e3(pg_temp.rpc('authenticated', :mgr, pg_temp.v_sql('cancel_repl', :'rQ'))) as "jQ" \gset
select pg_temp.exchange(:oK12, :lK12, :gL) as "rR" \gset
select coalesce(pg_temp.live(:'rR'), '00000000-0000-0000-0000-000000000000'::uuid) as "oR1" \gset
select pg_temp.write_as('postgres', null, format('update public.order_requests set warehouse_id = %L where id = %L', :whB, :oK12)) as "rRmove" \gset
select pg_temp.e3(pg_temp.rpc('authenticated', :stfAB, pg_temp.v_sql('cancel_repl', :'rR'))) as "jR1" \gset
select pg_temp.e3(pg_temp.rpc('authenticated', :stfAB, pg_temp.v_sql('change_b', :'rR'))) as "jR2" \gset
select coalesce(pg_temp.live(:'rR'), '00000000-0000-0000-0000-000000000000'::uuid) as "oR2" \gset
\set moveQ  '\'update public.order_requests set warehouse_id = \'\'04250000-0000-0000-0000-0000000000d2\'\' where id = \'\'04250000-0000-0000-0000-00000000010b\'\'\''
\set backR  '\'update public.order_requests set warehouse_id = \'\'04250000-0000-0000-0000-0000000000d1\'\' where id = \'\'04250000-0000-0000-0000-00000000010c\'\'\''
select is(
  :'jQ' || ':' || (select status from public.order_requests where id = :'oQ') || ':' || coalesce(pg_temp.live(:'rQ')::text, 'none')
  || ' | ' || pg_temp.e3(pg_temp.try_rpc('authenticated', :stfB, pg_temp.v_sql('change_b', :'rQ'), :moveQ))
  || ' | ' || pg_temp.e3(pg_temp.try_rpc('authenticated', :stfB, pg_temp.v_sql('cancel_rma', :'rQ'), :moveQ)),
  'changed=true:cancelled:none | changed=true | changed=true',
  'V-1-8: with its replacement cancelled in A and none live, after the original moves to B staff of B alone still issue a new one (Change, an item of B) and cancel the RMA: a cancelled replacement refuses nobody');
select is(
  :'rRmove' || ' | ' || :'jR1' || ' | ' || :'jR2'
  || ' | ' || (select o.status || '/' || (o.warehouse_id = :whA)::text from public.order_requests o where o.id = :'oR1')
  || ' | ' || coalesce((select o.status || '/' || (o.warehouse_id = :whB)::text from public.order_requests o where o.id = :'oR2'), 'none')
  || ' | ' || pg_temp.e3(pg_temp.try_rpc('authenticated', :stfB, pg_temp.v_sql('release', :'rR')))
  || ' | ' || pg_temp.e3(pg_temp.try_rpc('authenticated', :stfB, pg_temp.v_sql('cancel_repl', :'rR')))
  || ' | ' || pg_temp.e3(pg_temp.try_rpc('authenticated', :stfA, pg_temp.v_sql('release', :'rR'), :backR))
  || ' | ' || pg_temp.e3(pg_temp.try_rpc('authenticated', :stfA, pg_temp.v_sql('cancel_repl', :'rR'), :backR)),
  'ok:1 | changed=true | changed=true | cancelled/true | approved/true | changed=true | changed=true'
  || ' | 42501:warehouse_write:warehouse_write | 42501:warehouse_write:warehouse_write',
  'V-1-9: with a cancelled replacement in A and the live one re-issued in B, staff of B alone release and cancel the live one; with the original moved back to A, staff of A alone are refused it by its own warehouse, not let through by the cancelled one in A');

-- ══ M. Mutations (each inside an undone attempt) ══════════════════════════
select is(
  pg_temp.attempt('authenticated', :mgr,
    :forge || format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 1)', :'oA', :gS),
    $p$select pg_temp.repatch('public.tg_order_request_lines_replacement_guard()',
         E'pg_current_xact_id()::text\n     and current_user not in (''authenticated'', ''anon'', ''service_role'') then\n    return new;',
         E'pg_current_xact_id()::text then\n    return new;')$p$),
  'ok:1',
  'M1: the lines guard without its role term lets a manager who set the flag add a line to a replacement: FR1 rests on the role term');
select is(
  pg_temp.attempt('authenticated', :mgr, :forge || format('update public.order_requests set warehouse_id = %L where id = %L', :whB, :'oA'),
    $p$select pg_temp.repatch('public.tg_order_requests_replacement_header()',
         E'\n     and current_user not in (''authenticated'', ''anon'', ''service_role'')', '')$p$),
  'ok:1',
  'M2: the header guard without its role term lets a manager who set the flag move a replacement: FR2 rests on the role term');
select is(
  pg_temp.attempt('service_role', null, :forge || format($q$update public.order_requests set status = 'cancelled' where id = %L$q$, :'oA'),
    $p$create or replace trigger trg_order_requests_zz_replacement_header
         before update on public.order_requests
         for each row
         when (new.replacement_for_return_id is not null
               and (old.warehouse_id is distinct from new.warehouse_id
                    or old.delivery_charter_id is distinct from new.delivery_charter_id
                    or old.created_at is distinct from new.created_at
                    or (old.status = 'backordered' and new.status = 'completed')))
         execute function public.tg_order_requests_replacement_header()$p$),
  'ok:1',
  'M3: the header trigger without its cancel and deny edge lets the service role that set the flag cancel a replacement (the DEFINER status trigger sees postgres): FR3 rests on the new edge');
select is(
  pg_temp.e3(pg_temp.try_rpc('authenticated', :stfB, pg_temp.v_sql('release', :'rV'),
    :moveV || '; ' || $p$select pg_temp.repatch('public.release_return_replacement_early(uuid,uuid,text)',
         E'\n  perform public._return_replacement_warehouse_gate(p_return_id, v_user);  -- S7: before any lock', '')$p$))
  || ',' || pg_temp.e3(pg_temp.try_rpc('authenticated', :stfB, pg_temp.v_sql('cancel_repl', :'rV'),
    :moveV || '; ' || $p$select pg_temp.repatch('public.cancel_return_replacement(uuid,integer,text,text)',
         E'\n  perform public._return_replacement_warehouse_gate(p_return_id, v_user);  -- S7: before any lock', '')$p$))
  || ',' || pg_temp.e3(pg_temp.try_rpc('authenticated', :stfB, pg_temp.v_sql('change_s', :'rV'),
    :moveV || '; ' || $p$select pg_temp.repatch('public.change_return_replacement(uuid,integer,jsonb,text,text,jsonb)',
         E'\n  perform public._return_replacement_warehouse_gate(p_return_id, v_user);  -- S7: before any lock', '')$p$))
  || ',' || pg_temp.e3(pg_temp.try_rpc('authenticated', :stfB, pg_temp.v_sql('cancel_rma', :'rV'),
    :moveV || '; ' || $p$select pg_temp.repatch('public.cancel_return(uuid,integer,text)',
         E'\n  perform public._return_replacement_warehouse_gate(p_return_id, v_user);  -- S7: before any lock', '')$p$))
  || ',' || pg_temp.e3(pg_temp.try_rpc('authenticated', :stfB, pg_temp.v_sql('rest', :'rV2'),
    :moveV2 || '; ' || $p$select pg_temp.repatch('public.close_return_replacement_rest(uuid,integer,text,text)',
         E'\n  perform public._return_replacement_warehouse_gate(p_return_id, v_user);  -- S7: before any lock', '')$p$)),
  '42501:warehouse_write:warehouse_write,42501:warehouse_write:warehouse_write,42501:warehouse_write:warehouse_write,'
  || '42501:warehouse_write:warehouse_write,42501:warehouse_write:warehouse_write',
  'M4: without its gate before the locks, each function still refuses staff of B under the replacement''s lock (release, cancel and change by their own second gate, the RMA cancel by its hook''s, Close the rest by its 0397 check)');
select is(
  pg_temp.e3(pg_temp.try_rpc('authenticated', :stfB, pg_temp.v_sql('release', :'rV'),
    :moveV || '; ' || $p$select pg_temp.repatch('public.release_return_replacement_early(uuid,uuid,text)',
         E'\n  perform public._return_replacement_warehouse_gate(p_return_id, v_user);  -- S7: before any lock', '');
       select pg_temp.repatch('public.release_return_replacement_early(uuid,uuid,text)',
         E'\n  perform public._return_replacement_warehouse_gate(p_return_id, v_user);  -- S7: under the replacement''s lock', '')$p$))
  || ',' || pg_temp.e3(pg_temp.try_rpc('authenticated', :stfB, pg_temp.v_sql('cancel_rma', :'rV'),
    :moveV || '; ' || $p$select pg_temp.repatch('public.cancel_return(uuid,integer,text)',
         E'\n  perform public._return_replacement_warehouse_gate(p_return_id, v_user);  -- S7: before any lock', '');
       select pg_temp.repatch('public._return_exchange_on_cancel(uuid,uuid,text)',
         E'\n      perform public._return_replacement_warehouse_gate(p_return_id, p_user);  -- S7: under the replacement''s lock', '')$p$)),
  'changed=true,42501:warehouse_write:forbidden',
  'M5: with both gates out, release early goes through again and the RMA cancel is refused only inside cancel_order_request (0416), after the locks: V-1-1 and V-1-4 rest on the gates');
-- The pending-approval role term is matched from the text before it: the flag
-- exemption above it ends with the same role term (M1).
select :'pendPrep' || '; ' || $p$select pg_temp.repatch('public.tg_order_request_lines_replacement_guard()',
         E'v_status = ''pending_approval''\n     and current_user not in (''authenticated'', ''anon'', ''service_role'') then',
         E'v_status = ''pending_approval'' then')$p$ as "m6Prep" \gset
select is(
  pg_temp.attempt('authenticated', :req, :'pendLine', :'m6Prep')
  || ' | ' || pg_temp.attempt('service_role', null, :'pendLine', :'m6Prep'),
  'ok:1 | ok:1',
  'M6: the lines guard without the role term on its pending-approval exemption lets the requester and the service role add a line to a replacement still pending approval: FR5 rests on that term');
select :moveQ || '; ' || $p$select pg_temp.repatch('public._return_replacement_warehouse_gate(uuid,uuid)',
         ' and o.status not in (''cancelled'', ''denied'');', ';')$p$ as "m7Prep" \gset
select is(
  pg_temp.e3(pg_temp.try_rpc('authenticated', :stfB, pg_temp.v_sql('change_b', :'rQ'), :'m7Prep'))
  || ',' || pg_temp.e3(pg_temp.try_rpc('authenticated', :stfB, pg_temp.v_sql('cancel_rma', :'rQ'), :'m7Prep')),
  '42501:warehouse_write:warehouse_write,42501:warehouse_write:warehouse_write',
  'M7: the gate helper without its live filter reads the cancelled replacement in A and refuses staff of B the new replacement and the RMA cancel: V-1-8 rests on the filter');

-- ══ R. The restated bodies ═════════════════════════════════════════════════
select is(
  (select string_agg(p.proname || '=' || md5(regexp_replace(p.prosrc, '\n[^\n]*-- S7[^\n]*', '', 'g')), ',' order by p.proname collate "C")
     from pg_proc p where p.oid in (to_regprocedure('public.cancel_return_replacement(uuid,integer,text,text)'),
                                    to_regprocedure('public.release_return_replacement_early(uuid,uuid,text)'),
                                    to_regprocedure('public.change_return_replacement(uuid,integer,jsonb,text,text,jsonb)'),
                                    to_regprocedure('public.close_return_replacement_rest(uuid,integer,text,text)'),
                                    to_regprocedure('public.cancel_return(uuid,integer,text)'),
                                    to_regprocedure('public._return_exchange_on_cancel(uuid,uuid,text)')))
  || ' | ' || (select md5(replace(replace(p.prosrc,
       E'  -- S7: the flag counts only for a writer that is not an API role. An RMA\n'
       || E'  -- function raises it as postgres (SECURITY DEFINER); anon, authenticated\n'
       || E'  -- or the service role setting it themselves are refused like anyone else.\n', ''),
       E'\n     and current_user not in (''authenticated'', ''anon'', ''service_role'')', ''))
     from pg_proc p where p.oid = to_regprocedure('public.tg_order_requests_replacement_header()')),
  '_return_exchange_on_cancel=a4ed07269153c41f8203d375ab2f7acc,cancel_return=11e8be3e7f3fe7899c6c919311fbf9c1,'
  || 'cancel_return_replacement=9e42b480d4a77b1ccde60f10fc858d44,change_return_replacement=b19cb3718a8e51b74caaecc1281b7aaa,'
  || 'close_return_replacement_rest=9a0a83770e971f617777b9231a7eb0ca,release_return_replacement_early=c125bab4cea1572430b53b7bb5bd3ceb'
  || ' | b7220c36c4f78792f698adfbd8da79ea',
  'R1: each restated body minus its "-- S7" lines IS the body before (md5), and the header guard minus its two S7 blocks IS 0396''s: S7 only added the gates and the role term');
select is(
  (select string_agg(p.proname || '=' || md5(p.prosrc), ',' order by p.proname collate "C")
     from pg_proc p where p.oid in (to_regprocedure('public.cancel_return_replacement(uuid,integer,text,text)'),
                                    to_regprocedure('public.release_return_replacement_early(uuid,uuid,text)'),
                                    to_regprocedure('public.change_return_replacement(uuid,integer,jsonb,text,text,jsonb)'),
                                    to_regprocedure('public.close_return_replacement_rest(uuid,integer,text,text)'),
                                    to_regprocedure('public.cancel_return(uuid,integer,text)'),
                                    to_regprocedure('public._return_exchange_on_cancel(uuid,uuid,text)'),
                                    to_regprocedure('public.tg_order_requests_replacement_header()'),
                                    to_regprocedure('public.tg_order_request_lines_replacement_guard()'),
                                    to_regprocedure('public._return_replacement_warehouse_gate(uuid,uuid)'))),
  '_return_exchange_on_cancel=01835cfd5a07a666afb26eb203cb9ff4,_return_replacement_warehouse_gate=57ad2ae472885c43bc1eba1c664efc78,'
  || 'cancel_return=d3c2d9348a85d9be74aa55b8a8c5f783,'
  || 'cancel_return_replacement=18760fd58c4f2445acaa930d2896ea33,change_return_replacement=eb49035fe40a6f441fde039e0f0ecc18,'
  || 'close_return_replacement_rest=6b0a7f57789b7adcd03233e9bf98c058,release_return_replacement_early=00fcc95f02e36c7be40db0deedd2c691,'
  || 'tg_order_request_lines_replacement_guard=126e56113d8878330e48ded218cdab3f,tg_order_requests_replacement_header=437f91dc9d1037c01233c62a79885689',
  'R2 (red: the bodies before, the helper missing): the eight bodies S7 replaces and the new helper are as written (the kit''s post-check values)');

-- ══ P. Posture ═════════════════════════════════════════════════════════════
select is(
  (select p.prosecdef::text || ':' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
          || ':' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
          || ':' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
          || ':' || coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a)::text, 'false')
          || ':' || pg_get_userbyid(p.proowner) || ':' || coalesce(array_to_string(p.proconfig, ';'), '')
          || ':' || p.provolatile::text || ':' || pg_get_function_result(p.oid) || ':' || pg_get_function_identity_arguments(p.oid)
     from pg_proc p where p.oid = to_regprocedure('public._return_replacement_warehouse_gate(uuid,uuid)')),
  'false:false:false:false:false:postgres:search_path=public, pg_temp:v:void:p_return_id uuid, p_user uuid',
  'P1 (red: missing): the gate helper is SECURITY INVOKER (it runs inside the DEFINER functions, as postgres), search_path pinned, EXECUTE for nobody');
select is(
  (select string_agg(p.proname || ':' || p.prosecdef::text || ':' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
                     || ':' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
                     || ':' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
                     || ':' || coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a)::text, 'false')
                     || ':' || pg_get_userbyid(p.proowner)
                     || ':' || coalesce((select string_agg(c, ';' order by c) from unnest(p.proconfig) c), ''),
                     ',' order by p.proname collate "C")
     from pg_proc p where p.oid in (to_regprocedure('public.cancel_return_replacement(uuid,integer,text,text)'),
                                    to_regprocedure('public.release_return_replacement_early(uuid,uuid,text)'),
                                    to_regprocedure('public.change_return_replacement(uuid,integer,jsonb,text,text,jsonb)'),
                                    to_regprocedure('public.close_return_replacement_rest(uuid,integer,text,text)'),
                                    to_regprocedure('public.cancel_return(uuid,integer,text)'),
                                    to_regprocedure('public._return_exchange_on_cancel(uuid,uuid,text)'),
                                    to_regprocedure('public.tg_order_requests_replacement_header()'),
                                    to_regprocedure('public.tg_order_request_lines_replacement_guard()'))),
  '_return_exchange_on_cancel:false:false:false:false:false:postgres:search_path=public, pg_temp,'
  || 'cancel_return:true:true:false:false:false:postgres:lock_timeout=5s;search_path=public, pg_temp,'
  || 'cancel_return_replacement:true:true:false:false:false:postgres:lock_timeout=5s;search_path=public, pg_temp,'
  || 'change_return_replacement:true:true:false:false:false:postgres:lock_timeout=5s;search_path=public, pg_temp,'
  || 'close_return_replacement_rest:true:true:false:false:false:postgres:lock_timeout=5s;search_path=public, pg_temp,'
  || 'release_return_replacement_early:true:true:false:false:false:postgres:lock_timeout=5s;search_path=public, pg_temp,'
  || 'tg_order_request_lines_replacement_guard:false:false:false:false:false:postgres:search_path=public, pg_temp,'
  || 'tg_order_requests_replacement_header:false:false:false:false:false:postgres:search_path=public, pg_temp',
  'P2: the five functions keep SECURITY DEFINER, the 5 s lock timeout and EXECUTE for authenticated only; the hook and both guards stay SECURITY INVOKER with no EXECUTE; all owned by postgres');
select is(
  (select string_agg(p.proname || ':' || (has_function_privilege('anon', p.oid, 'EXECUTE')
                                          or has_function_privilege('authenticated', p.oid, 'EXECUTE')
                                          or has_function_privilege('service_role', p.oid, 'EXECUTE')
                                          or coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a), false))::text,
                     ',' order by p.proname collate "C")
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'ledger') and p.prosrc ~ 'set_config\(\s*''stockpilot\.return_exchange''')
  || ' | ' || (select string_agg(p.proname || ':' || p.prosecdef::text, ',' order by p.proname collate "C")
                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname in ('public', 'ledger')
                  and p.prosrc ~ $re$current_setting\(\s*'stockpilot\.return_exchange'$re$
                  and p.prosrc !~ 'set_config\(\s*''stockpilot\.return_exchange'''),
  '_return_exchange_on_cancel:false,_return_replacement_cancel_order:false,_return_replacement_close_partial:false'
  || ' | tg_order_request_lines_replacement_guard:false,tg_order_requests_replacement_header:false,tg_order_requests_replacement_status:true',
  'P3: still exactly three functions set the flag, none executable by an API role; it is read by the two INVOKER guards, which ask the role, and by the DEFINER status trigger, whose flagged edge the header guard now covers (red: the lines guard did not read it)');
select is(
  (select string_agg(p.proname || '=' || coalesce(obj_description(p.oid, 'pg_proc') ~ '\mS7\M', false)::text, ',' order by p.proname collate "C")
     from pg_proc p where p.oid in (to_regprocedure('public.cancel_return_replacement(uuid,integer,text,text)'),
                                    to_regprocedure('public.release_return_replacement_early(uuid,uuid,text)'),
                                    to_regprocedure('public.change_return_replacement(uuid,integer,jsonb,text,text,jsonb)'),
                                    to_regprocedure('public.close_return_replacement_rest(uuid,integer,text,text)'),
                                    to_regprocedure('public.cancel_return(uuid,integer,text)'),
                                    to_regprocedure('public._return_exchange_on_cancel(uuid,uuid,text)'),
                                    to_regprocedure('public.tg_order_requests_replacement_header()'),
                                    to_regprocedure('public.tg_order_requests_replacement_status()'),
                                    to_regprocedure('public.tg_order_request_lines_replacement_guard()'),
                                    to_regprocedure('public._return_replacement_warehouse_gate(uuid,uuid)'))),
  '_return_exchange_on_cancel=true,_return_replacement_warehouse_gate=true,cancel_return=true,cancel_return_replacement=true,'
  || 'change_return_replacement=true,close_return_replacement_rest=true,release_return_replacement_early=true,'
  || 'tg_order_request_lines_replacement_guard=true,tg_order_requests_replacement_header=true,tg_order_requests_replacement_status=true',
  'P4 (red: false each): every comment S7 restates says the rule it adds');
select is(
  (select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgname = 'trg_order_requests_zz_replacement_header'),
  'CREATE TRIGGER trg_order_requests_zz_replacement_header BEFORE UPDATE ON public.order_requests FOR EACH ROW WHEN (((new.replacement_for_return_id IS NOT NULL) AND ((old.warehouse_id IS DISTINCT FROM new.warehouse_id) OR (old.delivery_charter_id IS DISTINCT FROM new.delivery_charter_id) OR (old.created_at IS DISTINCT FROM new.created_at) OR ((old.status = ''backordered''::text) AND (new.status = ''completed''::text)) OR ((old.status IS DISTINCT FROM new.status) AND (new.status = ANY (ARRAY[''cancelled''::text, ''denied''::text])))))) EXECUTE FUNCTION tg_order_requests_replacement_header()',
  'P5 (red: no cancel or deny edge): the header trigger keeps its name and position and adds the status trigger''s flagged edge (a move into cancelled or denied)');

-- The extension is created inside this file's transaction (in schema
-- extensions) and leaves with its rollback, as in the 0396 and 0397 files.
create extension if not exists plpgsql_check with schema extensions;
select is(
  (select coalesce(string_agg(p.proname || ' line ' || coalesce(c.lineno::text, '?') || ': ' || c.message, '; '
                              order by p.proname, c.lineno), 'none')
     from pg_proc p
     left join lateral (select min(t.tgrelid::regclass::text) as rel from pg_trigger t
                         where t.tgfoid = p.oid and not t.tgisinternal) tr on true
     cross join lateral extensions.plpgsql_check_function_tb(
        p.oid, case when tr.rel is null then 0::oid::regclass else tr.rel::regclass end,
        fatal_errors => false, other_warnings => false, extra_warnings => false, performance_warnings => false) c
    where p.oid in (to_regprocedure('public._return_replacement_warehouse_gate(uuid,uuid)'),
                    to_regprocedure('public.cancel_return_replacement(uuid,integer,text,text)'),
                    to_regprocedure('public.release_return_replacement_early(uuid,uuid,text)'),
                    to_regprocedure('public.change_return_replacement(uuid,integer,jsonb,text,text,jsonb)'),
                    to_regprocedure('public.close_return_replacement_rest(uuid,integer,text,text)'),
                    to_regprocedure('public.cancel_return(uuid,integer,text)'),
                    to_regprocedure('public._return_exchange_on_cancel(uuid,uuid,text)'),
                    to_regprocedure('public.tg_order_requests_replacement_header()'),
                    to_regprocedure('public.tg_order_request_lines_replacement_guard()'))
      and c.level = 'error')
  || ' | ' || (select count(*)::text from pg_proc p where p.oid in (to_regprocedure('public._return_replacement_warehouse_gate(uuid,uuid)'),
                    to_regprocedure('public.cancel_return_replacement(uuid,integer,text,text)'),
                    to_regprocedure('public.release_return_replacement_early(uuid,uuid,text)'),
                    to_regprocedure('public.change_return_replacement(uuid,integer,jsonb,text,text,jsonb)'),
                    to_regprocedure('public.close_return_replacement_rest(uuid,integer,text,text)'),
                    to_regprocedure('public.cancel_return(uuid,integer,text)'),
                    to_regprocedure('public._return_exchange_on_cancel(uuid,uuid,text)'),
                    to_regprocedure('public.tg_order_requests_replacement_header()'),
                    to_regprocedure('public.tg_order_request_lines_replacement_guard()'))),
  'none | 9',
  'P6 (red: 8, the helper missing): plpgsql_check finds no error in the nine functions S7 creates or restates (the guards checked against their tables)');

select * from finish();
rollback;
