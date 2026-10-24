-- supabase/tests/0397_returns_followups.test.sql
-- pgTAP proof for migration 0397 (returns and exchanges, slice RX-4, part 1:
-- the follow-ups). Written at the RX-4 desk stage (2026-10-11) and RUN AT THE
-- TEST STAGE (no local stack was available to the author); the offline parse
-- (rx-tools/pgtap_parse.py) is the only check it has had so far.
--
--   A.  Shape: close_return_replacement_rest and order_id_for_return_token
--       postures; the two restated 0396 bodies minus their `-- RX-4` lines
--       ARE 0396's (md5); replacement_closed is a non-head kind; plpgsql_check
--       finds no error in the four functions.
--   B.  "Close the rest" gates (3.3.1 order): unauthenticated, foreign and
--       missing, Returns or Orders off, returns:manage, orders:approve,
--       warehouse write, reason, expected revision.
--   C.  "Close the rest" states: the RMA must be received or closed; only a
--       backorder handed over in part; stale revision and shown status; the
--       close itself (completed, holds released, nothing moved, the
--       decision, the revision unchanged, the flag restored, the requester's
--       ping), the replay, close_partial still refused without the flag, a
--       closed RMA, and a rest resumed into picking (out of scope).
--   D.  The requester token lookup (service role only).
--   E.  The requester tier's lock set (finding 2): behaviour unchanged (one
--       generic refusal for a non-sibling and a foreign item), and the lock
--       query filters a requester's ids to the line's own options. The
--       two-session proof (a requester body naming an item another session
--       holds FOR UPDATE does not wait) is race R5 of
--       scripts/db-concurrency/0397_returns_followups_races.sh.
--   F.  Used-up lines (F5): a line whose unit was replaced under a cancelled
--       RMA offers no sizes; a sibling line still does.
--   G.  RX-3 L4: a discontinued group offers nothing and refuses a sibling; a
--       requester-tier item of another organization gets the one generic
--       refusal.
--   H.  The decision shape check, and the frozen bodies.
--
-- MUTATION TABLE (each must fail the named lines; run with the test stage's
-- mutate-0397.py):
--   M1  close-the-rest drops the orders:approve gate                   -> B4
--   M2  close-the-rest drops the warehouse write gate                  -> B5
--   M3  close-the-rest accepts an approved RMA                         -> C1
--   M4  close-the-rest accepts a backorder that handed nothing over    -> C2
--   M5  close-the-rest ignores the shown status                        -> C3
--   M6  the close_partial helper leaves the flag raised, or is granted
--       to an API role                                                 -> C4, A1b
--   M7  close-the-rest writes a head decision (a revision)             -> C4, H1
--   M8  close-the-rest skips the replay                                -> C5
--   M9  the requester lock set takes every named id again              -> E2
--   M10 return_exchange_options keeps used-up lines again              -> F1
--   M11 the replacement's warehouse is not asked (verification V-1)    -> B7
--
-- Roles: fixtures as the test superuser; every attempt through the 0387
-- helpers (pg_temp.attempt / try_rpc undone; rpc / call_as / write_as kept),
-- which switch role and claims inside a subtransaction. begin/rollback:
-- nothing leaks. Namespace 03977000.

begin;

select plan(30);

\set orgA    '\'03977000-0000-0000-0000-00000000000a\''
\set orgZ    '\'03977000-0000-0000-0000-00000000000b\''
\set own     '\'03977000-0000-0000-0000-0000000000a0\''
\set mgr     '\'03977000-0000-0000-0000-0000000000a1\''
\set req     '\'03977000-0000-0000-0000-0000000000a2\''
\set stfRm   '\'03977000-0000-0000-0000-0000000000a3\''
\set stfB    '\'03977000-0000-0000-0000-0000000000a4\''
\set vwr     '\'03977000-0000-0000-0000-0000000000a5\''
\set outZ    '\'03977000-0000-0000-0000-0000000000b1\''
\set whA     '\'03977000-0000-0000-0000-0000000000d1\''
\set whB     '\'03977000-0000-0000-0000-0000000000d2\''
\set whZ     '\'03977000-0000-0000-0000-0000000000d3\''
\set r31C    '\'03977000-0000-0000-0000-000000000c31\''
\set r12B    '\'03977000-0000-0000-0000-000000000c12\''
\set grp     '\'03977000-0000-0000-0000-000000000a01\''
\set grpD    '\'03977000-0000-0000-0000-000000000a02\''
\set grpZ    '\'03977000-0000-0000-0000-000000000a03\''
\set gS      '\'03977000-0000-0000-0000-000000000e01\''
\set gM      '\'03977000-0000-0000-0000-000000000e02\''
\set gL      '\'03977000-0000-0000-0000-000000000e03\''
\set dM      '\'03977000-0000-0000-0000-000000000e04\''
\set dL      '\'03977000-0000-0000-0000-000000000e05\''
\set zM      '\'03977000-0000-0000-0000-000000000e06\''
\set zL      '\'03977000-0000-0000-0000-000000000e07\''
\set pY      '\'03977000-0000-0000-0000-000000000e08\''
\set pZ      '\'03977000-0000-0000-0000-000000000e09\''
\set pW      '\'03977000-0000-0000-0000-000000000e0a\''
\set itNo    '\'03977000-0000-0000-0000-000000000e0b\''
\set oK1     '\'03977000-0000-0000-0000-000000000101\''
\set oK2     '\'03977000-0000-0000-0000-000000000102\''
\set oK3     '\'03977000-0000-0000-0000-000000000103\''
\set oQ      '\'03977000-0000-0000-0000-000000000104\''
\set oF      '\'03977000-0000-0000-0000-000000000105\''
\set oY      '\'03977000-0000-0000-0000-000000000106\''
\set oR      '\'03977000-0000-0000-0000-000000000107\''
\set oZ      '\'03977000-0000-0000-0000-000000000108\''
\set lK1     '\'03977000-0000-0000-0000-000000000201\''
\set lK2     '\'03977000-0000-0000-0000-000000000202\''
\set lK3     '\'03977000-0000-0000-0000-000000000203\''
\set lQ      '\'03977000-0000-0000-0000-000000000204\''
\set lF      '\'03977000-0000-0000-0000-000000000205\''
\set lF2     '\'03977000-0000-0000-0000-000000000206\''
\set lY      '\'03977000-0000-0000-0000-000000000207\''
\set lR      '\'03977000-0000-0000-0000-000000000208\''
\set lZ      '\'03977000-0000-0000-0000-000000000209\''
\set tok     '\'03977000-0000-0000-0000-00000000f00d\''
\set nobody  '\'03977000-0000-0000-0000-0000000009ff\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,   '0397-own@test.local',   '{}'::jsonb),
  (:mgr,   '0397-mgr@test.local',   '{}'::jsonb),
  (:req,   '0397-req@test.local',   '{}'::jsonb),
  (:stfRm, '0397-stfrm@test.local', '{}'::jsonb),
  (:stfB,  '0397-stfb@test.local',  '{}'::jsonb),
  (:vwr,   '0397-vwr@test.local',   '{}'::jsonb),
  (:outZ,  '0397-outz@test.local',  '{}'::jsonb)
  on conflict (id) do nothing;
-- An org insert enables the default modules (orders among them); returns is
-- off by default and is turned on here.
insert into public.organizations (id, name, slug) values
  (:orgA, '0397 Followups A', '0397-followups-a'),
  (:orgZ, '0397 Followups Z', '0397-followups-z');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,   'owner',   now()),
  (:orgA, :mgr,   'manager', now()),
  (:orgA, :req,   'staff',   now()),
  (:orgA, :stfRm, 'staff',   now()),
  (:orgA, :stfB,  'staff',   now()),
  (:orgA, :vwr,   'viewer',  now()),
  (:orgZ, :outZ,  'manager', now());
insert into public.organization_modules (organization_id, module_id, enabled, tier, settings) values
  (:orgA, 'returns', true, 'optional', '{}'::jsonb),
  (:orgZ, 'returns', true, 'optional', '{}'::jsonb)
on conflict (organization_id, module_id) do update set enabled = true;
-- The 0188 trigger creates Staging and Unplaced per warehouse.
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, '0397 Main',   'WH-0397A', 'active'),
  (:whB, :orgA, '0397 Second', 'WH-0397B', 'active'),
  (:whZ, :orgZ, '0397 Zed',    'WH-0397Z', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary, charter_id) values
  (:orgA, :req,   :whA, true, null),
  (:orgA, :stfRm, :whA, true, null),
  (:orgA, :stfB,  :whB, true, null),
  (:orgA, :vwr,   :whA, true, null);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :stfRm, 'returns:manage', true),
  (:orgA, :stfB,  'returns:manage', true),
  (:orgA, :stfB,  'orders:approve', true);

insert into public.locations (id, organization_id, warehouse_id, name, type, kind, created_at) values
  (:r31C, :orgA, :whA, '31-C', 'shelf', 'rack', now() - interval '60 minutes'),
  (:r12B, :orgA, :whA, '12-B', 'shelf', 'rack', now() - interval '59 minutes');

insert into public.product_groups (id, organization_id, name, group_key, default_counting_unit, status) values
  (:grp,  :orgA, 'Walk Followup Shirt',  '0397|walk followup shirt',  'each', 'active'),
  (:grpD, :orgA, 'Walk Retired Shirt',   '0397|walk retired shirt',   'each', 'discontinued');
insert into public.product_groups (id, organization_id, name, group_key, default_counting_unit, status) values
  (:grpZ, :orgZ, 'Zed Followup Shirt', '0397|zed followup shirt', 'each', 'active');

-- Single-rack items seed their holding at primary_location_id (the seed
-- trigger). No item carries a reorder point (walk safety, C-7).
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, unit_cost, status, tracking_type,
   primary_location_id, group_id, variant_size, variant_key) values
  (:gS,  :orgA, :whA, '0397-S',   'Walk Followup Shirt', 5, 7, 'active', 'none', :r12B, :grp,  'S', 'S'),
  (:gM,  :orgA, :whA, '0397-M',   'Walk Followup Shirt', 5, 7, 'active', 'none', :r31C, :grp,  'M', 'M'),
  (:gL,  :orgA, :whA, '0397-L',   'Walk Followup Shirt', 5, 7, 'active', 'none', :r12B, :grp,  'L', 'L'),
  (:dM,  :orgA, :whA, '0397-D-M', 'Walk Retired Shirt',  2, 7, 'active', 'none', :r12B, :grpD, 'M', 'M'),
  (:dL,  :orgA, :whA, '0397-D-L', 'Walk Retired Shirt',  2, 7, 'active', 'none', :r12B, :grpD, 'L', 'L'),
  (:pY,  :orgA, :whA, '0397-PY',  'Walk Part Shirt Y',   1, 7, 'active', 'none', :r12B, null,  null, null),
  (:pZ,  :orgA, :whA, '0397-PZ',  'Walk Part Shirt Z',   1, 7, 'active', 'none', :r12B, null,  null, null),
  (:pW,  :orgA, :whA, '0397-PW',  'Walk Part Shirt W',   1, 7, 'active', 'none', :r12B, null,  null, null),
  (:itNo,:orgA, :whA, '0397-NO',  'Walk Plain Shirt',    2, 7, 'active', 'none', :r12B, null,  null, null);
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, unit_cost, status, tracking_type, group_id, variant_size, variant_key) values
  (:zM, :orgZ, :whZ, '0397-Z-M', 'Zed Followup Shirt', 2, 7, 'active', 'none', :grpZ, 'M', 'M'),
  (:zL, :orgZ, :whZ, '0397-Z-L', 'Zed Followup Shirt', 2, 7, 'active', 'none', :grpZ, 'L', 'L');

-- Handed-over originals, by the superuser (the insert guard holds API roles
-- only; the transition trigger fires on UPDATE only).
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, requester_name, fulfillment_type) values
  (:oK1, :orgA, :whA, 'completed', 'internal', :req,  'Req Person', 'pickup'),
  (:oK2, :orgA, :whA, 'completed', 'internal', :req,  'Req Person', 'pickup'),
  (:oK3, :orgA, :whA, 'completed', 'internal', :req,  'Req Person', 'pickup'),
  (:oQ,  :orgA, :whA, 'completed', 'internal', :req,  'Req Person', 'pickup'),
  (:oF,  :orgA, :whA, 'completed', 'internal', :req,  'Req Person', 'pickup'),
  (:oY,  :orgA, :whA, 'completed', 'internal', :req,  'Req Person', 'pickup'),
  (:oR,  :orgA, :whA, 'completed', 'internal', :req,  'Req Person', 'pickup'),
  (:oZ,  :orgZ, :whZ, 'completed', 'internal', :outZ, null,         'pickup');
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, quantity_fulfilled) values
  (:lK1, :oK1, :gM, 4, 4),
  (:lK2, :oK2, :gM, 4, 4),
  (:lK3, :oK3, :gM, 4, 4),
  (:lQ,  :oQ,  :gM, 2, 2),
  (:lF,  :oF,  :gM, 1, 1),
  (:lF2, :oF,  :gS, 1, 1),
  (:lY,  :oY,  :dM, 1, 1),
  (:lR,  :oR,  :gM, 1, 1),
  (:lZ,  :oZ,  :zM, 1, 1);
-- A return token for oR (D), in the service-only side table (0389).
insert into public.order_request_secrets (order_request_id, organization_id, return_token)
values (:oR, :orgA, :tok);

-- ══ Helpers (the 0396 file's, unchanged in shape) ═════════════════════════
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
    raise exception using errcode = 'XX397', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX397' then
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
    return jsonb_build_object('error', v_state, 'hint', pg_temp.hint(v_hint), 'message', v_msg, 'detail', v_detail);
  end;
  return coalesce(v, 'null'::jsonb);
end $$;
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
    raise exception using errcode = 'XX397', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text,
                            v_hint = pg_exception_hint, v_detail = pg_exception_detail;
  end;
  if v_state = 'XX397' then
    return coalesce(v, 'null'::jsonb);
  end if;
  return jsonb_build_object('error', v_state, 'hint', pg_temp.hint(v_hint), 'message', v_msg, 'detail', v_detail);
end $$;
create function pg_temp.err(j jsonb) returns text language sql immutable as $$
  select case when j ? 'error' then (j->>'error') || ':' || coalesce(j->>'hint', '-') else 'ok' end
$$;
create function pg_temp.balanced(p_item uuid) returns boolean language sql as $$
  select (select quantity_on_hand from public.inventory_items where id = p_item)
       = (select coalesce(sum(quantity), 0) from public.item_stock_levels where item_id = p_item)
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
create function pg_temp.xs(p_rma uuid, p_as uuid) returns text language sql as $$
  select pg_temp.call_as('authenticated', p_as, format('select exchange_status from public.return_overview where id = %L', p_rma))
$$;
create function pg_temp.approve(p_sub uuid, p_rma uuid, p_dec jsonb) returns jsonb language plpgsql as $$
begin
  return pg_temp.rpc('authenticated', p_sub,
                     format('select public.approve_return(%L, %s, %L::jsonb, false)', p_rma, pg_temp.rev(p_rma), p_dec));
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
-- +1 on 12-B through the ledger (the manager's adjust).
create function pg_temp.restock(p_item uuid) returns text language plpgsql as $$
declare v_prev text := coalesce(current_setting('request.jwt.claim.sub', true), '');
begin
  perform set_config('request.jwt.claim.sub', '03977000-0000-0000-0000-0000000000a1', true);
  perform public.adjust_stock(p_item, 1, 'add', '03977000-0000-0000-0000-000000000c12'::uuid, 'Walk restock', null);
  perform set_config('request.jwt.claim.sub', v_prev, true);
  return 'ok';
end $$;
-- An exchange of 2 of a line's units for p_item (1 in stock): approved on
-- backorder (1 held), released early, picked, staged and signed: the
-- replacement is backordered with 1 handed over and 1 never held. The RMA
-- stays approved. Answers the RMA id.
create function pg_temp.part_handed_over(p_order uuid, p_line uuid, p_item uuid) returns text language plpgsql as $$
declare v_rma text; v_live uuid; v_out text;
begin
  v_rma := pg_temp.mk('03977000-0000-0000-0000-0000000000a1', p_order, pg_temp.xbody(p_line, 2, jsonb_build_object('itemId', p_item)));
  perform pg_temp.approve('03977000-0000-0000-0000-0000000000a1', v_rma::uuid,
                          pg_temp.xdec(v_rma::uuid, 'approve', '{}'::jsonb, '{"whenShort":"backorder"}'::jsonb));
  perform pg_temp.rpc('authenticated', '03977000-0000-0000-0000-0000000000a1',
                      format($q$select public.release_return_replacement_early(%L, %L, 'Customer is completing an in-person exchange today.')$q$, v_rma, pg_temp.live(v_rma::uuid)));
  v_live := pg_temp.live(v_rma::uuid);
  v_out := pg_temp.pick('03977000-0000-0000-0000-0000000000a1', v_live) || '/' || pg_temp.stage('03977000-0000-0000-0000-0000000000a1', v_live)
        || '/' || pg_temp.call_as('authenticated', '03977000-0000-0000-0000-0000000000a1',
                                  format($q$select (public.confirm_physical_signature(%L, 'Walk tester')).status$q$, v_live));
  if v_out <> 'picking_complete/ok:1/backordered' then
    raise exception 'part_handed_over setup: %', v_out;
  end if;
  return v_rma;
end $$;
-- The call under test, as p_sub (kept when it succeeds).
create function pg_temp.rest_sql(p_rma uuid, p_rev integer, p_reason text, p_shown text default null)
returns text language sql immutable as $$
  select format('select public.close_return_replacement_rest(%L, %s, %L, %L)', p_rma,
                coalesce(p_rev::text, 'null'), p_reason, p_shown)
$$;

-- Statement discipline (as 0396): a write a later check depends on runs in
-- its OWN statement, and every check reads in a later statement.

-- ══ A. Shape ══════════════════════════════════════════════════════════════
select is(
  (select string_agg(p.proname || ':' || p.prosecdef::text || ':' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
                     || ':' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
                     || ':' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
                     || ':' || coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a)::text, 'false')
                     || ':' || pg_get_userbyid(p.proowner)
                     || ':' || coalesce((select string_agg(c, ';' order by c) from unnest(p.proconfig) c), ''),
                     ',' order by p.proname collate "C")
     from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname in ('close_return_replacement_rest', 'order_id_for_return_token', 'return_exchange_options', '_return_exchange_create',
                        '_return_replacement_close_partial')),
  '_return_exchange_create:false:false:false:false:false:postgres:search_path=public, pg_temp,'
  || '_return_replacement_close_partial:false:false:false:false:false:postgres:search_path=public, pg_temp,'
  || 'close_return_replacement_rest:true:true:false:false:false:postgres:lock_timeout=5s;search_path=public, pg_temp,'
  || 'order_id_for_return_token:true:false:false:true:false:postgres:search_path=public, pg_temp,'
  || 'return_exchange_options:true:false:false:true:false:postgres:search_path=public, pg_temp',
  'A1: Close the rest is SECURITY DEFINER for authenticated only (5 s lock timeout); the token lookup and the requester options are the service role''s alone; the create hook and the flagged close_partial helper are INVOKER with no EXECUTE for any role; none for anon or PUBLIC');
-- Security review F-5: the exchange flag is raised only inside functions no
-- API role may execute, around one call of their own.
select is(
  (select string_agg(p.proname || ':' || (has_function_privilege('anon', p.oid, 'EXECUTE')
                                          or has_function_privilege('authenticated', p.oid, 'EXECUTE')
                                          or has_function_privilege('service_role', p.oid, 'EXECUTE')
                                          or coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a), false))::text,
                     ',' order by p.proname collate "C")
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'ledger') and p.prosrc ~ 'set_config\(\s*''stockpilot\.return_exchange'''),
  '_return_exchange_on_cancel:false,_return_replacement_cancel_order:false,_return_replacement_close_partial:false',
  'A1b: exactly three functions set the exchange flag, none executable by any API role (security review F-5; RX-4 added the close_partial helper, Mutation M6)');
select is(
  (select string_agg(p.proname || '=' || md5(regexp_replace(p.prosrc, '\n[^\n]*-- RX-4[^\n]*', '', 'g')), ',' order by p.proname collate "C")
     from pg_proc p where p.oid in ('public._return_exchange_create(uuid,uuid,jsonb,jsonb)'::regprocedure,
                                    'public.return_exchange_options(uuid)'::regprocedure)),
  '_return_exchange_create=7d70d30499d6c5f0cfca77dd77749eb0,return_exchange_options=7935b669804dcc975f049327ec7a2759',
  'A2: each restated 0396 body minus its `-- RX-4` lines IS 0396''s body (md5): RX-4 only added lines');
select is(
  (select pg_get_constraintdef(c.oid) ~ '''replacement_closed''::text' from pg_constraint c
    where c.conrelid = 'public.return_decisions'::regclass and c.conname = 'return_decisions_kind_check')::text
  || ':' || (select pg_get_indexdef('public.return_decisions_revision_uniq'::regclass) ~ 'replacement_closed')::text
  || ':' || (select pg_get_constraintdef(c.oid) ~ 'replacement_closed' from pg_constraint c
              where c.conrelid = 'public.return_decisions'::regclass and c.conname = 'return_decisions_kind_shape_chk')::text
  || ':' || (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
              and p.prosrc ~ 'd\.kind in \(''approved'', ''replacement_changed'', ''replacement_cancelled'', ''cancelled''\)'
              and p.prosrc ~ 'replacement_closed''\)')::text,
  'true:false:false:0',
  'A3: replacement_closed is a decision kind but not a head kind: the revision index, the head shape check and every revision read leave it out');
create extension if not exists plpgsql_check with schema extensions;
select is(
  (select coalesce(string_agg(p.proname || ' line ' || coalesce(c.lineno::text, '?') || ': ' || c.message, '; '
                              order by p.proname, c.lineno), 'none')
     from pg_proc p
     cross join lateral extensions.plpgsql_check_function_tb(
        p.oid, fatal_errors => false, other_warnings => false, extra_warnings => false, performance_warnings => false) c
    where p.oid in ('public.close_return_replacement_rest(uuid,integer,text,text)'::regprocedure,
                    'public._return_replacement_close_partial(uuid)'::regprocedure,
                    'public.order_id_for_return_token(uuid)'::regprocedure,
                    'public._return_exchange_create(uuid,uuid,jsonb,jsonb)'::regprocedure,
                    'public.return_exchange_options(uuid)'::regprocedure)
      and c.level = 'error'),
  'none',
  'A4: plpgsql_check finds no error in the five functions this file creates or restates');

-- ══ B. Close the rest: gates ══════════════════════════════════════════════
-- rK1: a replacement handed over in part, rest on backorder, RMA received.
select pg_temp.part_handed_over(:oK1, :lK1, :pY) as "rK1" \gset
select pg_temp.call_as('authenticated', :mgr, format('select (public.receive_return(%L))->>''status''', :'rK1')) as "k1Recv" \gset
select coalesce(pg_temp.live(:'rK1'), '00000000-0000-0000-0000-000000000000'::uuid) as "oK1R" \gset
select is(
  :'k1Recv' || ':' || (select status from public.order_requests where id = :'oK1R') || ':'
  || (select trim_scale(sum(quantity_fulfilled))::text || '/' || trim_scale(sum(quantity_requested))::text
        from public.order_request_lines where order_request_id = :'oK1R') || ':' || pg_temp.xs(:'rK1', :mgr),
  'received:backordered:1/2:partly_handed_over',
  'B0: the fixture: the RMA received, its replacement backordered with 1 of 2 handed over (partly_handed_over)');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', null, pg_temp.rest_sql(:'rK1', pg_temp.rev(:'rK1'), 'No longer needed')))
  || ',' || pg_temp.err(pg_temp.try_rpc('authenticated', :outZ, pg_temp.rest_sql(:'rK1', pg_temp.rev(:'rK1'), 'No longer needed')))
  || ',' || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, pg_temp.rest_sql(:nobody, 0, 'No longer needed')))
  || ',' || pg_temp.err(pg_temp.try_rpc('anon', null, pg_temp.rest_sql(:'rK1', pg_temp.rev(:'rK1'), 'No longer needed'))),
  '42501:unauthenticated,P0002:return_not_found,P0002:return_not_found,42501:-',
  'B1: unauthenticated is refused; a foreign RMA answers like a missing one (no oracle); anon holds no EXECUTE');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, pg_temp.rest_sql(:'rK1', pg_temp.rev(:'rK1'), 'No longer needed'),
    format($q$update public.organization_modules set enabled = false where organization_id = %L and module_id = 'returns'$q$, :orgA)))
  || ',' || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, pg_temp.rest_sql(:'rK1', pg_temp.rev(:'rK1'), 'No longer needed'),
    format($q$update public.organization_modules set enabled = false where organization_id = %L and module_id = 'orders'$q$, :orgA))),
  'P0001:module_disabled,P0001:module_disabled',
  'B2: with Returns or Orders off it is refused before any lock (plan 3.3.1 step 3)');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :vwr, pg_temp.rest_sql(:'rK1', pg_temp.rev(:'rK1'), 'No longer needed')))
  || ',' || pg_temp.err(pg_temp.try_rpc('authenticated', :req, pg_temp.rest_sql(:'rK1', pg_temp.rev(:'rK1'), 'No longer needed'))),
  '42501:returns_manage,42501:returns_manage',
  'B3: a viewer and a staff member without returns:manage are refused');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :stfRm, pg_temp.rest_sql(:'rK1', pg_temp.rev(:'rK1'), 'No longer needed')))
  || ',' || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, pg_temp.rest_sql(:'rK1', pg_temp.rev(:'rK1'), 'No longer needed'),
    format($q$insert into public.user_permission_overrides (organization_id, user_id, permission, granted)
              values (%L, %L, 'orders:approve', false)$q$, :orgA, :mgr))),
  '42501:orders_approve,42501:orders_approve',
  'B4: returns:manage alone is not enough: closing a replacement order needs orders:approve, and a manager revoked by override is refused (Mutation M1)');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :stfB, pg_temp.rest_sql(:'rK1', pg_temp.rev(:'rK1'), 'No longer needed'))),
  '42501:warehouse_write',
  'B5: staff with both permissions for another warehouse only are refused (Mutation M2)');
-- case: close_rest_reason_blank
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, pg_temp.rest_sql(:'rK1', pg_temp.rev(:'rK1'), '   ')))
  || ',' || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, pg_temp.rest_sql(:'rK1', null, 'No longer needed')))
  || ',' || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, pg_temp.rest_sql(:'rK1', pg_temp.rev(:'rK1'), repeat('x', 1001)))),
  'P0001:reason_required,22023:return_invalid,22023:return_invalid',
  'B6: a reason (1 to 1,000 characters) and the revision the caller saw are required');
-- Verification V-1: an original moved to whB by a raw PATCH (here as the
-- superuser, inside the undone attempt) leaves the replacement in whA. stfB
-- (whB only) then passes the original's warehouse but not the replacement's.
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :stfB, pg_temp.rest_sql(:'rK1', pg_temp.rev(:'rK1'), 'No longer needed'),
    format('update public.order_requests set warehouse_id = %L where id = %L', :whB, :oK1))),
  '42501:warehouse_write',
  'B7: the replacement''s own warehouse is asked too, so moving the original does not hand its replacement to the other warehouse (verification V-1; Mutation M11)');

-- ══ C. Close the rest: states and the close ════════════════════════════════
-- rK2: the same shape, the RMA still approved.
select pg_temp.part_handed_over(:oK2, :lK2, :pZ) as "rK2" \gset
select coalesce(pg_temp.live(:'rK2'), '00000000-0000-0000-0000-000000000000'::uuid) as "oK2R" \gset
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, pg_temp.rest_sql(:'rK2', pg_temp.rev(:'rK2'), 'No longer needed')))
  || ':' || (pg_temp.try_rpc('authenticated', :mgr, pg_temp.rest_sql(:'rK2', pg_temp.rev(:'rK2'), 'No longer needed'))->>'detail'),
  'P0001:invalid_status_transition:approved',
  'C1: an approved RMA keeps its own path (cancel_return closes the backorder there): Close the rest needs received or closed (Mutation M3)');
-- rQ: an exchange approved and waiting (nothing handed over), RMA received.
select pg_temp.mk(:mgr, :oQ, pg_temp.xbody(:lQ, 1, jsonb_build_object('itemId', :gL))) as "rQ" \gset
select pg_temp.approve(:mgr, :'rQ', pg_temp.xdec(:'rQ')) as "jQ" \gset
select pg_temp.call_as('authenticated', :mgr, format('select (public.receive_return(%L))->>''status''', :'rQ')) as "qRecv" \gset
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, pg_temp.rest_sql(:'rQ', pg_temp.rev(:'rQ'), 'No longer needed')))
  || ':' || (pg_temp.try_rpc('authenticated', :mgr, pg_temp.rest_sql(:'rQ', pg_temp.rev(:'rQ'), 'No longer needed'))->>'detail')
  || ' | ' || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, pg_temp.rest_sql(:'rK1', pg_temp.rev(:'rK1'), 'No longer needed'),
    format($q$update public.order_request_lines set quantity_fulfilled = 0 where order_request_id = %L$q$, :'oK1R'))),
  'P0001:replacement_not_backordered:approved | P0001:replacement_not_backordered',
  'C2: only a backorder that handed something over is closed here: a replacement still waiting, and a backorder that handed nothing over, are refused (Mutation M4)');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, pg_temp.rest_sql(:'rK1', pg_temp.rev(:'rK1') + 1, 'No longer needed')))
  || ',' || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, pg_temp.rest_sql(:'rK1', pg_temp.rev(:'rK1'), 'No longer needed', 'pick_slip_generated'))),
  'P0001:return_changed,P0001:return_changed',
  'C3: a stale revision, or a replacement status other than the one the screen showed, is return_changed (the screen reloads; Mutation M5)');
-- The close itself. A hold planted on the rest (stock restocked first, so
-- the hold is within stock on record) proves every hold is released.
select pg_temp.restock(:pY) as "k1Restock" \gset
insert into public.stock_reservations (organization_id, item_id, warehouse_id, order_request_id, quantity)
values (:orgA, :pY, :whA, :'oK1R', 1);
select pg_temp.rev(:'rK1') as "k1Rev",
       (select count(*) from public.stock_movements where item_id = :pY) as "k1Moves",
       (select count(*) from public.notifications where user_id = :req and type = 'order_request.completed') as "k1Pings" \gset
select pg_temp.rpc('authenticated', :mgr, pg_temp.rest_sql(:'rK1', :'k1Rev'::integer, 'Customer no longer needs the rest', 'backordered')) as "jK1" \gset
select is(
  ((:'jK1'::jsonb)->>'changed') || ':' || ((:'jK1'::jsonb)->>'replay') || ':' || ((:'jK1'::jsonb)->>'status') || ':'
  || ((:'jK1'::jsonb)->>'revision') || ':' || (((:'jK1'::jsonb)->>'closedOrderId') = :'oK1R')::text || ' | '
  || (select status from public.order_requests where id = :'oK1R') || ':' || pg_temp.holds(:'oK1R')::text || ':'
  || (select trim_scale(sum(quantity_fulfilled))::text from public.order_request_lines where order_request_id = :'oK1R') || ':'
  || ((select count(*) from public.stock_movements where item_id = :pY) = :'k1Moves'::integer)::text || ':'
  || pg_temp.balanced(:pY)::text || ':' || (pg_temp.rev(:'rK1') = :'k1Rev'::integer)::text || ':'
  || coalesce(nullif(current_setting('stockpilot.return_exchange', true), ''), 'clear') || ' | '
  || (select string_agg(d.kind || '/' || d.channel || '/' || coalesce(d.revision::text, 'null') || '/'
                        || (d.order_request_id = :'oK1R')::text || '/' || d.reason, ',' order by d.seq)
        from public.return_decisions d where d.return_id = :'rK1' and d.kind = 'replacement_closed') || ' | '
  || pg_temp.xs(:'rK1', :mgr) || ':'
  || ((select count(*) from public.notifications where user_id = :req and type = 'order_request.completed') - :'k1Pings'::integer)::text || ':'
  || (select n.title from public.notifications n where n.user_id = :req and n.type = 'order_request.completed'
        and (n.metadata->>'order_request_id') = :'oK1R' order by n.created_at desc limit 1),
  'true:false:received:' || :'k1Rev'::integer || ':true | completed:0:1:true:true:true:clear | replacement_closed/staff/null/true/Customer no longer needs the rest'
  || ' | handed_over_return_open:1:Your replacement order was closed',
  'C4: Close the rest completes the replacement as delivered-partial: every hold released, the handed-over 1 kept, no movement, holdings equal stock on record; a non-head replacement_closed decision with the reason; the revision unchanged; the flag cleared; the requester told the rest will not be sent (Mutations M6, M7)');
select pg_temp.rpc('authenticated', :mgr, pg_temp.rest_sql(:'rK1', :'k1Rev'::integer, 'Customer no longer needs the rest', 'backordered')) as "jK1b" \gset
select is(
  ((:'jK1b'::jsonb)->>'changed') || ':' || ((:'jK1b'::jsonb)->>'replay') || ':'
  || (select count(*) from public.return_decisions d where d.return_id = :'rK1' and d.kind = 'replacement_closed')::text || ':'
  || ((select count(*) from public.notifications where user_id = :req and type = 'order_request.completed') - :'k1Pings'::integer)::text,
  'false:true:1:1',
  'C5: the same call again (a lost answer resent, or a second click) replays: no second decision, no second ping (Mutation M8)');
-- rK3: closed RMA. Before the close: close_partial straight from the order
-- path is still refused (the header guard; no flag).
select pg_temp.part_handed_over(:oK3, :lK3, :pW) as "rK3" \gset
select coalesce(pg_temp.live(:'rK3'), '00000000-0000-0000-0000-000000000000'::uuid) as "oK3R" \gset
select pg_temp.call_as('authenticated', :mgr, format('select (public.receive_return(%L))->>''status''', :'rK3')) as "k3Recv" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rK3')) as "jK3Close" \gset
-- The refusal is tried (and undone) and Close the rest runs in statements of
-- their own: a statement never sees what a function it calls wrote, so the
-- replacement's status is read in the assertion after them (test stage,
-- 2026-10-12: read in the same statement it still showed backordered).
select pg_temp.attempt('authenticated', :mgr, format('select (public.close_partial(%L)).status', :'oK3R')) as "k3Partial",
       (select status from public.returns where id = :'rK3') as "k3RmaStatus" \gset
select pg_temp.rpc('authenticated', :mgr, pg_temp.rest_sql(:'rK3', pg_temp.rev(:'rK3'), 'Rest cancelled by the customer')) as "jK3Rest" \gset
select is(
  :'k3Partial'
  || ' | ' || :'k3RmaStatus' || ':'
  || pg_temp.err(:'jK3Rest'::jsonb)
  || ':' || (select status from public.order_requests where id = :'oK3R') || ':' || pg_temp.xs(:'rK3', :mgr),
  '42501:replacement_cancel_via_return:replacement_cancel_via_return | closed:ok:completed:completed',
  'C6: close_partial from the order path is still refused without the flag; on a CLOSED RMA Close the rest completes the replacement and the exchange reads completed');
-- rK2 again: received, then the rest resumed into picking (stock arrives,
-- the released replacement is resumed): out of scope.
select pg_temp.call_as('authenticated', :mgr, format('select (public.receive_return(%L))->>''status''', :'rK2')) as "k2Recv" \gset
select pg_temp.restock(:pZ) as "k2Restock" \gset
select pg_temp.call_as('authenticated', :mgr, format('select (public.resume_fulfillment(%L)).status', :'oK2R')) as "k2Resume" \gset
select is(
  :'k2Resume' || ':' || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, pg_temp.rest_sql(:'rK2', pg_temp.rev(:'rK2'), 'No longer needed')))
  || ':' || (pg_temp.try_rpc('authenticated', :mgr, pg_temp.rest_sql(:'rK2', pg_temp.rev(:'rK2'), 'No longer needed'))->>'detail'),
  'pick_slip_generated:P0001:replacement_not_backordered:pick_slip_generated',
  'C7: a rest already resumed into picking is out of scope (the order''s own paths end it): replacement_not_backordered');

-- ══ D. The requester token lookup (finding 1) ═════════════════════════════
select is(
  pg_temp.call_as('service_role', null, format('select public.order_id_for_return_token(%L)::text', :tok))
  || ',' || pg_temp.call_as('service_role', null, format('select public.order_id_for_return_token(%L)::text', :nobody))
  || ',' || pg_temp.call_as('service_role', null, 'select public.order_id_for_return_token(null)::text')
  || ',' || split_part(pg_temp.call_as('authenticated', :mgr, format('select public.order_id_for_return_token(%L)::text', :tok)), ':', 1)
  || ',' || split_part(pg_temp.call_as('anon', null, format('select public.order_id_for_return_token(%L)::text', :tok)), ':', 1),
  :oR || ',null,null,42501,42501',
  'D1: the service role resolves a return token to its one order (null for an unknown or missing token); no API role may call it');

-- ══ E. The requester tier's lock set (finding 2) ═══════════════════════════
select is(
  (select string_agg(pg_temp.err(pg_temp.try_rpc('service_role', null,
             format($q$select public.create_requester_return_request(%L, %L::jsonb, gen_random_uuid(), '{"channel":"token"}'::jsonb)$q$, :oR,
                    jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('orderRequestLineId', :lR, 'quantity', 1, 'exchange', x.ex)))::text))),
                     ',' order by x.n)
     from (values (1, jsonb_build_object('itemId', :gL)), (2, jsonb_build_object('itemId', upper(:gL))),
                  (3, jsonb_build_object('itemId', :itNo)), (4, jsonb_build_object('itemId', :zL)),
                  (5, jsonb_build_object('itemId', :nobody))) x(n, ex)),
  'ok,ok,P0001:exchange_item_not_eligible,P0001:exchange_item_not_eligible,P0001:exchange_item_not_eligible',
  'E1: behaviour unchanged: an offered size is accepted (its id in any case), and a non-sibling, an item of another organization and an unknown id all get the one generic refusal (brief 6, 32)');
select is(
  (select (p.prosrc ~ 'v_lockable := array\(select o\.item_id\s+-- RX-4'
           and p.prosrc ~ 'from public\._return_exchange_requester_options\(p_order_id, false\) o\s+-- RX-4'
           and p.prosrc ~ 'and \(v_tier = ''staff'' or ii\.id = any \(coalesce\(v_lockable, ''\{\}''::uuid\[\]\)\)\)\s+-- RX-4\s+order by ii\.id\s+for key share;'
           and strpos(p.prosrc, 'v_lockable := array(') < strpos(p.prosrc, 'for key share')
           and strpos(p.prosrc, 'for key share') < strpos(p.prosrc, 'public._return_lock_exchange_budget('))::text
     from pg_proc p where p.oid = 'public._return_exchange_create(uuid,uuid,jsonb,jsonb)'::regprocedure),
  'true',
  'E2: the requester''s key-share set is the named ids that are options of their own line (the same predicate the eligibility check asks), taken in id order before the budget lock; the two-session proof is race R5 (Mutation M9)');

-- ══ F. Used-up lines (F5) ═════════════════════════════════════════════════
-- rF1: lF's only unit exchanged for L, released, picked, staged and signed
-- (handed over in full), then the RMA cancelled with the original not back:
-- the customer kept that unit, so lF has nothing left to exchange.
select pg_temp.mk(:mgr, :oF, pg_temp.xbody(:lF, 1, jsonb_build_object('itemId', :gL))) as "rF1" \gset
select pg_temp.approve(:mgr, :'rF1', pg_temp.xdec(:'rF1')) as "jF1" \gset
select pg_temp.rpc('authenticated', :mgr,
         format($q$select public.release_return_replacement_early(%L, %L, 'Customer is completing an in-person exchange today.')$q$,
                :'rF1', pg_temp.live(:'rF1'))) as "jF1Rel" \gset
select coalesce(pg_temp.live(:'rF1'), '00000000-0000-0000-0000-000000000000'::uuid) as "oF1R" \gset
select pg_temp.pick(:mgr, :'oF1R') || '/' || pg_temp.stage(:mgr, :'oF1R') || '/'
       || pg_temp.call_as('authenticated', :mgr, format($q$select (public.confirm_physical_signature(%L, 'Walk tester')).status$q$, :'oF1R')) as "f1Out" \gset
select pg_temp.rpc('authenticated', :mgr, format($q$select public.cancel_return(%L, %s, 'Original not returned')$q$, :'rF1', pg_temp.rev(:'rF1'))) as "jF1Cancel" \gset
select pg_temp.call_as('service_role', null, format('select public.return_exchange_options(%L)::text', :oF)) as "fOpts" \gset
select is(
  :'f1Out' || ':' || ((:'jF1Cancel'::jsonb)->>'status') || ' | '
  || (select string_agg(case (g->>'orderRequestLineId') when :lF then 'lF' when :lF2 then 'lF2' else 'other' end || '='
                        || (select string_agg(o->>'variantKey', '/' order by o->>'variantKey') from jsonb_array_elements(g->'options') o),
                        ',' order by g->>'orderRequestLineId')
        from jsonb_array_elements(:'fOpts'::jsonb) g)
  || ' | ' || pg_temp.err(pg_temp.try_rpc('service_role', null,
       format($q$select public.create_requester_return_request(%L, %L::jsonb, gen_random_uuid(), '{"channel":"token"}'::jsonb)$q$, :oF,
              jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('orderRequestLineId', :lF, 'quantity', 1,
                                                                               'exchange', jsonb_build_object('note', 'Bigger please'))))::text))),
  'picking_complete/ok:1/completed:cancelled | lF2=L/M | P0001:exchange_already_sent',
  'F1: a line whose only unit was replaced under a cancelled RMA offers no sizes any more (it can only be returned), while the order''s other line still offers its sizes; a request on it is still refused exchange_already_sent (Mutation M10)');

-- ══ G. RX-3 L4: a discontinued group, and an item of another organization ═
select is(
  pg_temp.call_as('service_role', null, format('select public.return_exchange_options(%L)::text', :oY))
  || '|' || pg_temp.err(pg_temp.try_rpc('service_role', null,
       format($q$select public.create_requester_return_request(%L, %L::jsonb, gen_random_uuid(), '{"channel":"token"}'::jsonb)$q$, :oY,
              jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('orderRequestLineId', :lY, 'quantity', 1,
                                                                               'exchange', jsonb_build_object('itemId', :dL))))::text)))
  || '|' || pg_temp.err(pg_temp.try_rpc('service_role', null,
       format($q$select public.create_requester_return_request(%L, %L::jsonb, gen_random_uuid(), '{"channel":"token"}'::jsonb)$q$, :oY,
              jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('orderRequestLineId', :lY, 'quantity', 1,
                                                                               'exchange', jsonb_build_object('note', 'Any size up'))))::text))),
  '[]|P0001:exchange_item_not_eligible|ok',
  'G1 (RX-3 L4, Y2b): a discontinued group offers no sizes (D20) and refuses its sibling with the one generic answer; the warehouse-review request still goes through');
select is(
  pg_temp.err(pg_temp.try_rpc('service_role', null,
       format($q$select public.create_requester_return_request(%L, %L::jsonb, gen_random_uuid(), '{"channel":"portal","userId":"03977000-0000-0000-0000-0000000000a2"}'::jsonb)$q$, :oR,
              jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('orderRequestLineId', :lR, 'quantity', 1,
                                                                               'exchange', jsonb_build_object('itemId', :zM))))::text)))
  || ',' || pg_temp.err(pg_temp.try_rpc('service_role', null,
       format($q$select public.create_requester_return_request(%L, %L::jsonb, gen_random_uuid(), '{"channel":"member","userId":"03977000-0000-0000-0000-0000000000a2"}'::jsonb)$q$, :oR,
              jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('orderRequestLineId', :lR, 'quantity', 1,
                                                                               'exchange', jsonb_build_object('itemId', :zL))))::text))),
  'P0001:exchange_item_not_eligible,P0001:exchange_item_not_eligible',
  'G2 (RX-3 L4, Y3b): a requester-tier exchange naming an item of another organization gets the one generic refusal on every channel, never a foreign-key error');

-- ══ H. The decision shape, and what stays frozen ══════════════════════════
select is(
  pg_temp.attempt('postgres', null,
    format($q$insert into public.return_decisions (organization_id, return_id, kind, channel, order_request_id, actor_kind)
              values (%L, %L, 'replacement_closed', 'staff', %L, 'staff')$q$, :orgA, :'rK1', :'oK1R'))
  || ' | ' || pg_temp.attempt('postgres', null,
    format($q$insert into public.return_decisions (organization_id, return_id, kind, channel, order_request_id, reason, revision, actor_kind)
              values (%L, %L, 'replacement_closed', 'staff', %L, 'x', 9, 'staff')$q$, :orgA, :'rK1', :'oK1R'))
  || ' | ' || pg_temp.attempt('postgres', null,
    format($q$insert into public.return_decisions (organization_id, return_id, kind, channel, reason, actor_kind)
              values (%L, %L, 'replacement_closed', 'staff', 'x', 'staff')$q$, :orgA, :'rK1')),
  '23514:-:new row for relation "return_decisions" violates check constraint "return_decisions_replacement_closed_chk"'
  || ' | 23514:-:new row for relation "return_decisions" violates check constraint "return_decisions_replacement_closed_chk"'
  || ' | 23514:-:new row for relation "return_decisions" violates check constraint "return_decisions_replacement_closed_chk"',
  'H1: a replacement_closed decision needs a reason and the order, and never carries a revision, for every writer (Mutation M7)');
select is(
  (select coalesce(string_agg(x.sig, ','), '')
     from (values
       -- Re-pinned by 0405 (was a519c3e58fb577c3ff1b30fb3a6cc0ad): slice E refuses an
       -- approver who may not write to the order's warehouse before the body changes
       -- anything (0405 R3: removing that block gives this body exactly); for everyone else
       -- the body is unchanged. The RMA cancel and the rest-close call it only after the
       -- RMA's own write check on the original order's warehouse, where the replacement is
       -- placed and the header guard keeps it.
       ('public.close_partial(uuid)',                             '44852737eedc1959e887b8621925d157'),
       ('public.tg_order_requests_replacement_header()',          'b7220c36c4f78792f698adfbd8da79ea'),
       ('public.cancel_return_replacement(uuid,integer,text,text)', '9e42b480d4a77b1ccde60f10fc858d44'),
       ('public._return_exchange_requester_options(uuid,boolean)', 'c9a8b3ff98fa7e53e1befaeb39b52c55'),
       ('public._return_exchange_item_ok(uuid,uuid,text,uuid)',   '60a9e392712860018a5c3d814aa285eb'),
       ('public._return_exchange_line_budget(uuid,uuid)',         'a19c4994d724a227dfbb5d35b7f0d7c0'),
       ('public._return_replacement_class(uuid)',                 'fb118357c2024c55f80c095f783c68f1'),
       ('public.create_requester_return_request(uuid,jsonb,uuid,jsonb)', '157aebbe26a7baff32dd56755ab9025d'),
       ('public.process_return_disposition(uuid)',                '7ec76cc98b9cefc31707590071ac14d9'),
       -- Fix round 1 (desk check stock S2): the two gates the close calls
       -- and the order_requests trigger bodies it relies on.
       ('public.is_org_member(uuid)',                             '76492a6556e9f6a7c33d942aa9726f9f'),
       ('public.module_enabled(uuid,text)',                       'df3260cbcd15f986798e5377d1e95dce'),
       ('public._notify_replacement_order_changes()',             '543131721dbd9c04bb954b447e389972'),
       ('public.tg_order_requests_replacement_status()',          '38b9236c6e628e63f39eac5d8d1c83ff'),
       ('public._validate_order_request_status_transition()',     'dee8cd4782ec83abdb31a2b48fcd4ef2'),
       ('public.tg_order_requests_workflow_guard()',              '55bceafc13d599f8d77d6a4180c28140')
     ) x(sig, want)
     left join pg_proc p on p.oid = to_regprocedure(x.sig)
    where md5(p.prosrc) is distinct from x.want),
  '',
  'H2: the bodies RX-4 calls or relies on keep their md5 (close_partial, the header guard, the replacement cancel, the requester predicate, the item check, the line budget, the class, the requester create, the frozen wrapper, the member and module gates, the replacement ping, the replacement status rule, the transition table, the workflow guard)');
select is(
  (select coalesce(string_agg(i.sku, ',' order by i.sku collate "C"), '')
     from public.inventory_items i where i.organization_id = :orgA and not pg_temp.balanced(i.id)),
  '',
  'H3: holdings equal stock on record for every item of the organization after every scenario (no stock moved by RX-4)');
select is(
  (select count(*)::int from public.order_requests o
    where o.organization_id = :orgA and o.replacement_for_return_id is not null
      and (select count(*) from public.order_requests o2
            where o2.replacement_for_return_id = o.replacement_for_return_id and o2.status not in ('cancelled', 'denied')) > 1),
  0,
  'H4: never two live replacements for one RMA');

select * from finish();
rollback;
