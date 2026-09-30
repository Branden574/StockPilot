-- supabase/tests/0386_exception_confirm_count.test.sql
-- pgTAP proof for migration 0386 (count differences, R2: confirm the counted
-- number of a count_variance exception, and exceptions_sync's step 2b).
--
-- S. Schema and grants: the six columns, their types and foreign keys (ON
--    DELETE SET NULL); the reason and kind CHECKs accept the new values and
--    still refuse unknown ones; exc_occ_confirmed_reason refuses a confirm
--    time on an open row (the "=" form would not); the other confirmation
--    CHECKs; the UNIQUE index; the RPC is SECURITY DEFINER with
--    search_path=public and lock_timeout=5s, EXECUTE to authenticated only;
--    signed-in users can read the new columns and write none of them;
--    neither function raises 40001/40P01; the RPC's text: the act gate with
--    the item's warehouse, the advisory lock before the row lock, no inline
--    has_permission.
-- F. Frozen: the md5 of act, _latest_count_lines, _exc_occurrence_can_act,
--    _exc_occurrence_visible, item_verification_summaries,
--    start_targeted_recount, _exc_link_recount and cycle_count_line_rechecks;
--    G9 restated; exceptions_sync minus its lines tagged 0386 is the 0372 body
--    (md5), and the tagged lines are exactly step 2b, its declare and its key.
-- C. The confirm: counter, manager, manager who counted; not_counter,
--    not_permitted (manager without stock:adjust, viewer), P0002 (another
--    warehouse, another org); counted_by null; resolved rows and replay;
--    count_changed (another count, another number, a newer posted count);
--    recount_in_progress, and a cancelled recount whose pointer is closed
--    first; not_confirmable; not_countable (rental, archived); stock_moved,
--    and a transfer that nets to zero; no stock written; the item's live
--    warehouse; already_confirmed (never 23505); count_in_progress and the
--    lines that do not block; the check order.
-- Y. exceptions_sync step 2b: settled after a confirm (raised 0, settled 1);
--    a stale evaluation applied after it; a later differing count raises a
--    recurrence; a later matching count raises nothing (also after a
--    receipt); a malformed or missing id is not settled; per item; a settled
--    entry never resolves an open row; another org's confirmation never
--    settles; `dropped` and `settled`.
-- X. EX-000059's shape (the owner's case), start to end.
-- M. The gate agreement (pattern #26): the reader x state table of
--    packages/core/src/warehouse/exception-confirm.fixture.ts, restated here
--    cell by cell with GATE_REASON_TO_RPC's answers.
--
-- TIME. now() is the transaction start for the whole file; counts completed
-- here carry it. Records stamp baseline_at with clock_timestamp(), so a later
-- record is a later observation. Syncs run as service_role at now() plus an
-- increasing number of seconds.
--
-- Roles: fixtures as the test superuser; RPCs as `authenticated` with
-- request.jwt.claim.sub (pg_temp.as_user); syncs as service_role. Refusals are
-- captured as 'SQLSTATE:hint'. Closed function grants are asserted from the
-- catalog only (a denied function call is never executed here; see 0351).
-- begin/rollback: nothing leaks. Namespace 03860000.

begin;

select plan(72);

\set orgA  '\'03860000-0000-0000-0000-00000000000a\''
\set orgB  '\'03860000-0000-0000-0000-00000000000b\''
\set orgM  '\'03860000-0000-0000-0000-00000000000c\''
\set orgE  '\'03860000-0000-0000-0000-00000000000e\''
\set own   '\'03860000-0000-0000-0000-0000000000a0\''
\set mgr   '\'03860000-0000-0000-0000-0000000000a1\''
\set mgrNA '\'03860000-0000-0000-0000-0000000000a2\''
\set stA   '\'03860000-0000-0000-0000-0000000000a3\''
\set stB   '\'03860000-0000-0000-0000-0000000000a4\''
\set stC   '\'03860000-0000-0000-0000-0000000000a5\''
\set vwr   '\'03860000-0000-0000-0000-0000000000a6\''
\set mgrB  '\'03860000-0000-0000-0000-0000000000b1\''
\set w1    '\'03860000-0000-0000-0000-0000000000d1\''
\set w2    '\'03860000-0000-0000-0000-0000000000d2\''
\set wB    '\'03860000-0000-0000-0000-0000000000d3\''
\set wM    '\'03860000-0000-0000-0000-0000000000d4\''
\set wE    '\'03860000-0000-0000-0000-0000000000d5\''
\set r1    '\'03860000-0000-0000-0000-0000000000e1\''
\set r2    '\'03860000-0000-0000-0000-0000000000e2\''
\set rE    '\'03860000-0000-0000-0000-0000000000e3\''
-- org A items
\set c1    '\'03860000-0000-0000-0000-000000000f01\''
\set c2    '\'03860000-0000-0000-0000-000000000f02\''
\set c3    '\'03860000-0000-0000-0000-000000000f03\''
\set c4    '\'03860000-0000-0000-0000-000000000f04\''
\set c5    '\'03860000-0000-0000-0000-000000000f05\''
\set c8    '\'03860000-0000-0000-0000-000000000f08\''
\set c10a  '\'03860000-0000-0000-0000-000000000f0a\''
\set c10b  '\'03860000-0000-0000-0000-000000000f0b\''
\set c11a  '\'03860000-0000-0000-0000-000000000f11\''
\set c11b  '\'03860000-0000-0000-0000-000000000f12\''
\set c12   '\'03860000-0000-0000-0000-000000000f1c\''
\set c13a  '\'03860000-0000-0000-0000-000000000f13\''
\set c13b  '\'03860000-0000-0000-0000-000000000f14\''
\set c14a  '\'03860000-0000-0000-0000-000000000f15\''
\set c14b  '\'03860000-0000-0000-0000-000000000f16\''
\set c16   '\'03860000-0000-0000-0000-000000000f17\''
\set c18a  '\'03860000-0000-0000-0000-000000000f18\''
\set c18b  '\'03860000-0000-0000-0000-000000000f19\''
\set c18c  '\'03860000-0000-0000-0000-000000000f1a\''
\set c18d  '\'03860000-0000-0000-0000-000000000f1b\''
-- org E item (EX-000059's shape)
\set e59   '\'03860000-0000-0000-0000-000000000f59\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,   '0386-own@test.local',   '{}'::jsonb),
  (:mgr,   '0386-mgr@test.local',   '{}'::jsonb),
  (:mgrNA, '0386-mgrna@test.local', '{}'::jsonb),
  (:stA,   '0386-sta@test.local',   '{}'::jsonb),
  (:stB,   '0386-stb@test.local',   '{}'::jsonb),
  (:stC,   '0386-stc@test.local',   '{}'::jsonb),
  (:vwr,   '0386-vwr@test.local',   '{}'::jsonb),
  (:mgrB,  '0386-mgrb@test.local',  '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, '0386 Confirm A', '0386-confirm-a'),
  (:orgB, '0386 Confirm B', '0386-confirm-b'),
  (:orgM, '0386 Confirm Matrix', '0386-confirm-m'),
  (:orgE, '0386 Confirm EX59', '0386-confirm-e');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,   'owner',   now()),
  (:orgA, :mgr,   'manager', now()),
  (:orgA, :mgrNA, 'manager', now()),
  (:orgA, :stA,   'staff',   now()),
  (:orgA, :stB,   'staff',   now()),
  (:orgA, :stC,   'staff',   now()),
  (:orgA, :vwr,   'viewer',  now()),
  (:orgB, :mgrB,  'manager', now()),
  (:orgM, :own,   'owner',   now()),
  (:orgM, :mgr,   'manager', now()),
  (:orgM, :mgrNA, 'manager', now()),
  (:orgM, :stA,   'staff',   now()),
  (:orgM, :stB,   'staff',   now()),
  (:orgM, :vwr,   'viewer',  now()),
  (:orgE, :own,   'owner',   now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:w1, :orgA, '0386 Main',   'WH-0386-1', 'active'),
  (:w2, :orgA, '0386 Annex',  'WH-0386-2', 'active'),
  (:wB, :orgB, '0386 Other',  'WH-0386-B', 'active'),
  (:wM, :orgM, '0386 Matrix', 'WH-0386-M', 'active'),
  (:wE, :orgE, '0386 EX59',   'WH-0386-E', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :stA, :w1, true),
  (:orgA, :stB, :w1, true),
  (:orgA, :stC, :w2, true),
  (:orgA, :vwr, :w1, true),
  (:orgM, :stA, :wM, true),
  (:orgM, :stB, :wM, true),
  (:orgM, :vwr, :wM, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :mgrNA, 'stock:adjust', false),
  (:orgM, :mgrNA, 'stock:adjust', false);
insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:r1, :orgA, :w1, 'Rack 1-A', 'shelf', 'rack'),
  (:r2, :orgA, :w1, 'Rack 2-A', 'shelf', 'rack'),
  (:rE, :orgE, :wE, 'Rack 36-A', 'shelf', 'rack');
select id as "stgE" from public.locations where warehouse_id = :wE and kind = 'staging' and deleted_at is null \gset

insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status) values
  (:c1,   :orgA, :w1, 'X0386-C1',   'Confirm by counter',     10, 'active'),
  (:c2,   :orgA, :w1, 'X0386-C2',   'Confirm by manager',     10, 'active'),
  (:c3,   :orgA, :w1, 'X0386-C3',   'Manager counted',        10, 'active'),
  (:c4,   :orgA, :w1, 'X0386-C4',   'Stays open',             10, 'active'),
  (:c5,   :orgA, :w1, 'X0386-C5',   'Recurs later',           10, 'active'),
  (:c8,   :orgA, :w1, 'X0386-C8',   'No recorder',            10, 'active'),
  (:c10a, :orgA, :w1, 'X0386-C10A', 'Wrong count asked',      10, 'active'),
  (:c10b, :orgA, :w1, 'X0386-C10B', 'Newer count posted',     10, 'active'),
  (:c11a, :orgA, :w1, 'X0386-C11A', 'Recount running',        10, 'active'),
  (:c11b, :orgA, :w1, 'X0386-C11B', 'Recount cancelled',      10, 'active'),
  (:c12,  :orgA, :w1, 'X0386-C12',  'Over reserved',          10, 'active'),
  (:c13a, :orgA, :w1, 'X0386-C13A', 'Made rental',            10, 'active'),
  (:c13b, :orgA, :w1, 'X0386-C13B', 'Archived later',         10, 'active'),
  (:c14a, :orgA, :w1, 'X0386-C14A', 'Adjusted after',         10, 'active'),
  (:c14b, :orgA, :w1, 'X0386-C14B', 'Moved between racks',     0, 'active'),
  (:c16,  :orgA, :w1, 'X0386-C16',  'Moved warehouse',        10, 'active'),
  (:c18a, :orgA, :w1, 'X0386-C18A', 'Other count differs',    10, 'active'),
  (:c18b, :orgA, :w1, 'X0386-C18B', 'Other count matches',    10, 'active'),
  (:c18c, :orgA, :w1, 'X0386-C18C', 'Other count uncounted',  10, 'active'),
  (:c18d, :orgA, :w1, 'X0386-C18D', 'Other count older',      10, 'active'),
  (:e59,  :orgE, :wE, 'X0386-E59',  'Economy umbrella',        0, 'active');

-- The matrix org: three counters (staff A, the manager, nobody) x eight
-- states, one item each, all counted 7 where 10 was on record.
create temp table mx (
  variant text not null, state text not null, item_id uuid primary key, occ_id uuid,
  unique (variant, state));
insert into mx (variant, state, item_id)
select v.variant, s.state,
       ('03860000-0000-0000-0001-' || lpad(to_hex(v.n * 16 + s.n), 12, '0'))::uuid
  from (values ('A', 1), ('M', 2), ('N', 3)) v(variant, n),
       (values ('recount_in_progress', 1), ('count_in_progress', 2), ('rechecking', 3),
               ('count_changed', 4), ('not_countable', 5), ('stock_moved', 6),
               ('already_confirmed', 7), ('confirmable', 8)) s(state, n);
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status)
select m.item_id, :orgM, :wM, 'X0386-M-' || m.variant || '-' || m.state, 'Matrix ' || m.variant || ' ' || m.state, 10, 'active'
  from mx m;
grant select, update on mx to authenticated, service_role;

-- ── Helpers ──────────────────────────────────────────────────────────────
create function pg_temp.as_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
end $$;
create function pg_temp.as_owner() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- A refusal as 'SQLSTATE:hint' (the statement's effects roll back).
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
declare v_state text; v_hint text; v_msg text;
begin
  execute p_sql;
  return 'no error';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint, v_msg = message_text;
  return v_state || ':' || coalesce(v_hint, '') || ':' || v_msg;
end $$;

-- A confirm as a persona, KEPT: 'ok:<as>' | 'replay:<as>' | 'SQLSTATE:hint'.
create function pg_temp.confirm_as(p_user uuid, p_occ uuid, p_cc uuid, p_qty numeric, p_note text default null)
returns text language plpgsql as $$
declare v jsonb; v_state text; v_hint text;
begin
  perform pg_temp.as_user(p_user);
  begin
    v := public.exception_confirm_count(p_occ, p_cc, p_qty, p_note);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    perform pg_temp.as_owner();
    return v_state || ':' || coalesce(v_hint, '');
  end;
  perform pg_temp.as_owner();
  return case when (v->>'replay')::boolean then 'replay:' else 'ok:' end || coalesce(v->>'confirmedAs', '-')
         || case when (v->>'occurrenceId')::uuid = p_occ then '' else ':wrong-id' end;
end $$;

-- A confirm as a persona, ALWAYS ROLLED BACK (the matrix probes).
create function pg_temp.probe_as(p_user uuid, p_occ uuid, p_cc uuid, p_qty numeric)
returns text language plpgsql as $$
declare v jsonb; v_out text; v_state text; v_hint text;
begin
  perform pg_temp.as_user(p_user);
  begin
    v := public.exception_confirm_count(p_occ, p_cc, p_qty, null);
    v_out := 'ok:' || coalesce(v->>'confirmedAs', '-');
    raise exception 'probe rollback' using errcode = 'P0999';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    perform pg_temp.as_owner();
    if v_state = 'P0999' then return v_out; end if;
    return v_state || ':' || coalesce(v_hint, '');
  end;
end $$;

-- Record a line as a persona (the app's record: counted, by, at).
create function pg_temp.rec(p_user uuid, p_cc uuid, p_item uuid, p_qty numeric) returns void language plpgsql as $$
begin
  perform pg_temp.as_user(p_user);
  update public.cycle_count_lines
     set counted_quantity = p_qty, counted_by = p_user, counted_at = now()
   where cycle_count_id = p_cc and item_id = p_item;
  if not found then raise exception 'record found no line %/%', p_cc, p_item; end if;
  perform pg_temp.as_owner();
end $$;

-- Start a plain selection count as a manager; its id.
create function pg_temp.start(p_user uuid, p_org uuid, p_wh uuid, p_items uuid[]) returns uuid language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.as_user(p_user);
  select s.cycle_count_id into v from public.start_cycle_count(p_org, 'selection', p_wh, null, p_items, null) s;
  perform pg_temp.as_owner();
  return v;
end $$;

-- Post a count as a manager.
create function pg_temp.post(p_user uuid, p_cc uuid) returns void language plpgsql as $$
begin
  perform pg_temp.as_user(p_user);
  perform public.post_cycle_count(p_cc);
  perform pg_temp.as_owner();
end $$;

-- A targeted recount as a manager; the new count's id.
create function pg_temp.recount(p_user uuid, p_org uuid, p_occ uuid, p_key text) returns uuid language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(p_user);
  v := public.start_targeted_recount(p_org, array[p_occ], null, null, p_key);
  perform pg_temp.as_owner();
  return (v->>'cycleCountId')::uuid;
end $$;

-- A ledger adjustment or transfer as a persona.
create function pg_temp.adjust(p_user uuid, p_item uuid, p_qty numeric, p_loc uuid) returns void language plpgsql as $$
begin
  perform pg_temp.as_user(p_user);
  perform public.adjust_stock(p_item, p_qty, case when p_qty >= 0 then 'add' else 'remove' end, p_loc, 'probe');
  perform pg_temp.as_owner();
end $$;
create function pg_temp.transfer(p_user uuid, p_item uuid, p_from uuid, p_to uuid, p_qty numeric) returns void language plpgsql as $$
begin
  perform pg_temp.as_user(p_user);
  perform public.transfer_stock(p_item, p_from, p_to, p_qty);
  perform pg_temp.as_owner();
end $$;

-- The count_variance rule exactly as the evaluator states it
-- (services/exceptions.ts countVariance over _latest_count_lines as of the
-- evaluation): countable items only; a line whose numbers or completion
-- time cannot be read is HELD; a zero variance is absent; older than 30 days
-- is HELD; otherwise PRESENT with the evaluator's facts.
create function pg_temp.cv_eval(p_org uuid, p_as_of timestamptz)
returns table (state text, entry jsonb) language sql as $$
  select case
           when l.counted_quantity is null or l.expected_quantity is null or l.completed_at is null
                or l.completed_at < now() - interval '30 days' then 'hold'
           else 'present'
         end,
         case
           when l.counted_quantity is null or l.expected_quantity is null or l.completed_at is null
                or l.completed_at < now() - interval '30 days'
             then jsonb_build_object('rule', 'count_variance', 'itemId', l.item_id, 'locationId', null)
           else jsonb_build_object(
             'rule', 'count_variance', 'itemId', l.item_id, 'locationId', null,
             'warehouseId', l.item_warehouse_id,
             'facts', jsonb_build_object(
               'itemName', left(coalesce(l.item_name, 'Item'), 200),
               'sku', left(l.item_sku, 100),
               'cycleCountId', l.cycle_count_id,
               'countNumber', l.count_number,
               'observedAt', coalesce(l.baseline_at, l.counted_at),
               'completedAt', l.completed_at,
               'expected', trim_scale(l.expected_quantity),
               'counted', trim_scale(l.counted_quantity),
               'variance', trim_scale(l.counted_quantity - l.expected_quantity),
               'countedLocationName', left(l.counted_location_name, 100),
               'aiAssisted', l.ai_assisted,
               'capturedOfflineAt', null),
             'conditionSince', coalesce(l.baseline_at, l.counted_at))
         end
    from public._latest_count_lines(p_org, null, p_as_of) l
   where l.item_countable
     and (l.counted_quantity is null or l.expected_quantity is null
          or l.counted_quantity <> l.expected_quantity)
$$;

-- Hand-made present entries for the other rules.
create temp table cur_present (ord serial primary key, org uuid not null, entry jsonb not null);
grant all on cur_present to service_role;
grant usage on sequence cur_present_ord_seq to service_role;

-- One evaluation's payload {present, hold}, as of p_at.
create function pg_temp.payload(p_org uuid, p_at timestamptz) returns jsonb language sql as $$
  select jsonb_build_object(
    'present',
    (select coalesce(jsonb_agg(c.entry order by c.ord), '[]'::jsonb) from cur_present c where c.org = p_org)
      || (select coalesce(jsonb_agg(v.entry order by v.entry->>'itemId'), '[]'::jsonb)
            from pg_temp.cv_eval(p_org, p_at) v where v.state = 'present'),
    'hold',
    (select coalesce(jsonb_agg(v.entry order by v.entry->>'itemId'), '[]'::jsonb)
       from pg_temp.cv_eval(p_org, p_at) v where v.state = 'hold'))
$$;

-- Apply a payload as the cron does (service_role, every rule complete).
create function pg_temp.apply(p_org uuid, p_at timestamptz, p_payload jsonb) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  v := public.exceptions_sync(
    p_org, p_at,
    array['orphaned_stock', 'over_reserved', 'stale_staging', 'long_unplaced', 'label_mismatch', 'count_variance'],
    '{}', '{}', p_payload->'present', p_payload->'hold');
  perform set_config('role', 'none', true);
  return v;
end $$;

-- Evaluate now and apply (the system sync), at now() + p_sec seconds.
create function pg_temp.sync(p_org uuid, p_sec int) returns jsonb language sql as $$
  select pg_temp.apply(p_org, now() + make_interval(secs => p_sec),
                       pg_temp.payload(p_org, now() + make_interval(secs => p_sec)))
$$;

-- The timeline of one occurrence: kind:count:actor, in order.
create function pg_temp.tl(p_occ uuid) returns text[] language sql as $$
  select coalesce(array_agg(e.kind || ':' || coalesce(e.cycle_count_id::text, '-') || ':'
                            || coalesce(e.actor_user_id::text, 'system') order by e.created_at, e.id), '{}')
    from public.exception_occurrence_events e where e.occurrence_id = p_occ
$$;

-- The one open occurrence of an item's count difference.
create function pg_temp.open_occ(p_item uuid) returns uuid language sql as $$
  select o.id from public.exception_occurrences o
   where o.item_id = p_item and o.rule = 'count_variance' and o.resolved_at is null
$$;

-- ═══ S. Schema and grants ══════════════════════════════════════════════════
select is(
  (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' order by a.attname)
     from pg_attribute a
    where a.attrelid = 'public.exception_occurrences'::regclass and a.attname like 'confirmed%' and not a.attisdropped),
  'confirmed_as:text,confirmed_at:timestamp with time zone,confirmed_by:uuid,confirmed_cycle_count_id:uuid,confirmed_on_record:numeric(14,4),confirmed_quantity:numeric(14,4)',
  'S1a: the six confirmation columns exist with their types');
select is(
  (select string_agg(c.conname || '>' || c.confrelid::regclass::text || ':' || c.confdeltype::text, ',' order by c.conname)
     from pg_constraint c
    where c.conrelid = 'public.exception_occurrences'::regclass and c.contype = 'f'
      and c.conname in ('exception_occurrences_confirmed_by_fkey', 'exception_occurrences_confirmed_cycle_count_id_fkey')),
  'exception_occurrences_confirmed_by_fkey>user_profiles:n,exception_occurrences_confirmed_cycle_count_id_fkey>cycle_counts:n',
  'S1b: confirmed_by and confirmed_cycle_count_id reference user_profiles and cycle_counts, ON DELETE SET NULL, under the names the embeds use');

-- One planted row per shape, as the superuser (numbers far from the syncs').
create function pg_temp.plant(p_num bigint, p_rule text, p_reason text, p_extra jsonb default '{}') returns text language plpgsql as $$
declare v_state text; v_msg text;
begin
  insert into public.exception_occurrences (
    organization_id, occurrence_number, rule, item_id, location_id, warehouse_id, facts,
    first_seen_at, last_seen_at, resolved_at, resolved_reason,
    confirmed_at, confirmed_by, confirmed_cycle_count_id, confirmed_quantity, confirmed_on_record, confirmed_as)
  values (
    '03860000-0000-0000-0000-00000000000b', p_num, p_rule, '03860000-0000-0000-0000-000000000f04', null, null, '{}',
    now(), now(), case when p_reason is null then null else now() end, p_reason,
    (p_extra->>'at')::timestamptz, (p_extra->>'by')::uuid, (p_extra->>'cc')::uuid,
    (p_extra->>'qty')::numeric, (p_extra->>'onRecord')::numeric, p_extra->>'as');
  return 'ok';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return v_state || ':' || coalesce(substring(v_msg from 'constraint "([^"]+)"'), v_msg);
end $$;

select is(
  pg_temp.plant(9101, 'count_variance', 'confirmed', jsonb_build_object('at', now(), 'qty', 7, 'onRecord', 7, 'as', 'counter'))
  || '|' || pg_temp.plant(9102, 'count_variance', 'cleared')
  || '|' || pg_temp.plant(9103, 'count_variance', 'forgotten'),
  'ok|ok|23514:exception_occurrences_resolved_reason_check',
  'S2a: the reason CHECK accepts confirmed (and the old reasons) and still refuses an unknown one');
select is(
  (select pg_temp.err(format($$insert into public.exception_occurrence_events (organization_id, occurrence_id, kind, actor_user_id)
                               select organization_id, id, 'count_confirmed', null from public.exception_occurrences where occurrence_number = 9101 and organization_id = %L$$, :orgB)))
  || '|' || split_part(pg_temp.err(format($$insert into public.exception_occurrence_events (organization_id, occurrence_id, kind)
                               select organization_id, id, 'count_reverted' from public.exception_occurrences where occurrence_number = 9101 and organization_id = %L$$, :orgB)), ':', 1),
  'no error|23514',
  'S2b: the kind CHECK accepts count_confirmed and still refuses an unknown kind');
select is(
  pg_temp.plant(9104, 'count_variance', null, jsonb_build_object('at', now(), 'qty', 7, 'onRecord', 7, 'as', 'counter')),
  '23514:exc_occ_confirmed_reason',
  'S3: exc_occ_confirmed_reason refuses a confirm time on an open row (the "=" form would pass it: NULL = true is NULL)');
select is(
  pg_temp.plant(9105, 'over_reserved', 'confirmed', jsonb_build_object('at', now(), 'qty', 7, 'onRecord', 7, 'as', 'counter'))
  || '|' || pg_temp.plant(9106, 'count_variance', 'confirmed', jsonb_build_object('at', now(), 'onRecord', 7, 'as', 'counter'))
  || '|' || pg_temp.plant(9107, 'count_variance', 'confirmed', jsonb_build_object('at', now(), 'qty', 7, 'onRecord', 7))
  || '|' || pg_temp.plant(9108, 'count_variance', 'confirmed', jsonb_build_object('at', now(), 'qty', 7, 'onRecord', 7, 'as', 'owner'))
  || '|' || pg_temp.plant(9109, 'count_variance', 'confirmed', null)
  || '|' || pg_temp.plant(9110, 'count_variance', 'cleared', jsonb_build_object('by', :own))
  || '|' || pg_temp.plant(9111, 'count_variance', 'cleared', jsonb_build_object('cc', '03860000-0000-0000-0000-000000000c01'))
  || '|' || pg_temp.plant(9112, 'count_variance', null, '{}'::jsonb),
  '23514:exc_occ_confirmed_rule|23514:exc_occ_confirmed_shape|23514:exc_occ_confirmed_shape|23514:exception_occurrences_confirmed_as_check|23514:exc_occ_confirmed_reason|23514:exc_occ_confirmed_by_pair|23514:exc_occ_confirmed_count_pair|ok',
  'S4: a confirmation on another rule, without its number, without its role, with a role outside counter/manager, a confirmed reason without a time, a confirmer without a time and a count without a time are all refused');
select is(
  pg_temp.plant(9113, 'count_variance', 'confirmed',
    jsonb_build_object('at', now(), 'qty', 7, 'onRecord', 7, 'as', 'counter', 'cc', '03860000-0000-0000-0000-000000000c01'))
  || '|' || pg_temp.plant(9114, 'count_variance', 'confirmed',
    jsonb_build_object('at', now(), 'qty', 7, 'onRecord', 7, 'as', 'manager', 'cc', '03860000-0000-0000-0000-000000000c01')),
  '23503:exception_occurrences_confirmed_cycle_count_id_fkey|23503:exception_occurrences_confirmed_cycle_count_id_fkey',
  'S5 (setup): a confirmation must name a real count (the foreign key)');
-- S5 proper once a real count exists (below, after the fixtures' count).
delete from public.exception_occurrence_events where organization_id = :orgB;
delete from public.exception_occurrences where organization_id = :orgB;

select is(
  (select p.prosecdef::text || '|' || p.proconfig::text || '|' || pg_get_function_result(p.oid)
     from pg_proc p where p.oid = 'public.exception_confirm_count(uuid, uuid, numeric, text)'::regprocedure),
  'true|{search_path=public,lock_timeout=5s}|jsonb',
  'S6a: exception_confirm_count is SECURITY DEFINER with search_path=public and lock_timeout=5s, returning jsonb');
select ok(
  has_function_privilege('authenticated', 'public.exception_confirm_count(uuid, uuid, numeric, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.exception_confirm_count(uuid, uuid, numeric, text)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.exception_confirm_count(uuid, uuid, numeric, text)', 'EXECUTE')
  and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                   where p.oid = 'public.exception_confirm_count(uuid, uuid, numeric, text)'::regprocedure and a.grantee = 0),
  'S6b: EXECUTE goes to authenticated only (not anon, not service_role, not PUBLIC): an anonymous call is refused before the body runs (C7)');
select is(
  (select string_agg(c.col || '=' || has_column_privilege('authenticated', 'public.exception_occurrences', c.col, 'SELECT')::text
                     || '/' || has_column_privilege('authenticated', 'public.exception_occurrences', c.col, 'UPDATE')::text
                     || '/' || has_column_privilege('authenticated', 'public.exception_occurrences', c.col, 'INSERT')::text
                     || '/' || has_column_privilege('anon', 'public.exception_occurrences', c.col, 'SELECT')::text, ',' order by c.col)
     from (values ('confirmed_at'), ('confirmed_by'), ('confirmed_cycle_count_id'), ('confirmed_quantity'),
                  ('confirmed_on_record'), ('confirmed_as')) c(col)),
  'confirmed_as=true/false/false/false,confirmed_at=true/false/false/false,confirmed_by=true/false/false/false,confirmed_cycle_count_id=true/false/false/false,confirmed_on_record=true/false/false/false,confirmed_quantity=true/false/false/false',
  'S6c: signed-in users read the new columns and can write none of them (no column grant; the 0384 lesson); anon reads none');
select is(
  (select string_agg(p.proname, ',' order by p.proname) from pg_proc p
    where p.oid in ('public.exception_confirm_count(uuid, uuid, numeric, text)'::regprocedure,
                    'public.exceptions_sync(uuid, timestamptz, text[], text[], text[], jsonb, jsonb)'::regprocedure)
      and p.prosrc ~* '40001|40P01|serialization_failure|deadlock_detected'),
  null,
  'S7: neither function raises 40001 or 40P01 (0367)');
select ok(
  (select p.prosrc ~ 'public\._exc_occurrence_can_act\(v_org, v_item_wh, v_occ\.item_id\)'
          and p.prosrc ~ 'select i\.warehouse_id into v_item_wh'
          and p.prosrc !~ 'v_occ\.warehouse_id'
          and position('pg_advisory_xact_lock(hashtextextended(''exc_sync:''' in p.prosrc) > 0
          and position('pg_advisory_xact_lock(hashtextextended(''exc_sync:''' in p.prosrc) < position('for update' in p.prosrc)
          and p.prosrc !~ 'has_permission\('
     from pg_proc p where p.oid = 'public.exception_confirm_count(uuid, uuid, numeric, text)'::regprocedure),
  'S8: the RPC calls the act gate with the item''s live warehouse (never the occurrence''s stamp), takes the exc_sync: advisory lock before its FOR UPDATE, and has no inline has_permission');
select is(
  (select c.convalidated::text || ':' || pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.exception_occurrences'::regclass and c.conname = 'exc_occ_confirmed_reason'),
  'true:CHECK (((NOT (resolved_reason IS DISTINCT FROM ''confirmed''::text)) = (confirmed_at IS NOT NULL)))',
  'S9: exc_occ_confirmed_reason is VALID and in the "is not distinct from" form');

-- ═══ F. Frozen ════════════════════════════════════════════════════════════
select is(
  (select string_agg(v.fn || '=' || (md5(p.prosrc) = v.want)::text, ',' order by v.fn)
     from (values
       ('act',       'public.exception_occurrence_act(uuid, text, text, text)',            '0bc9284d1235b3d351a0874a2737e6e3'),
       ('can_act',   'public._exc_occurrence_can_act(uuid, uuid, uuid)',                   '26d986400027c5bbc655c0fba07376e3'),
       ('latest',    'public._latest_count_lines(uuid, uuid[], timestamptz)',              'fbf8501a3022fe84a9209c3ddfe1dd09'),
       ('link',      'public._exc_link_recount(uuid, uuid)',                               'aca3114bc8688ca7f6b2de032bc57d8f'),
       ('rechecks',  'public.cycle_count_line_rechecks(public.cycle_count_lines)',         'd9b450a79b8b516c891fa79db1a021e7'),
       ('recount',   'public.start_targeted_recount(uuid, uuid[], uuid[], text, text)',    'b22850a25b3b92d9a5f1ed02aa717aad'),
       ('summaries', 'public.item_verification_summaries(uuid, uuid[])',                   '833809196500b7846ce7999e37e6e144'),
       ('visible',   'public._exc_occurrence_visible(uuid, uuid, uuid)',                   '62662f8300373203ad06b7a64d147c0c')
     ) v(fn, sig, want)
     join pg_proc p on p.oid = v.sig::regprocedure),
  'act=true,can_act=true,latest=true,link=true,rechecks=true,recount=true,summaries=true,visible=true',
  'F1: act, the gate and visibility helpers, the latest-count read, the summaries, the recount, the link and the re-check predicate are byte for byte what they were (md5, as in production)');
select ok(
  (select p.prosrc !~* 'resolved_(at|reason)\s*=[^=]' from pg_proc p
    where p.oid = 'public.exception_occurrence_act(uuid, text, text, text)'::regprocedure),
  'F2 (G9): the act RPC body never assigns resolved_at or resolved_reason');
select is(
  (select md5(regexp_replace(p.prosrc, '\n[^\n]*-- 0386[^\n]*', '', 'g')) from pg_proc p
    where p.oid = 'public.exceptions_sync(uuid, timestamptz, text[], text[], text[], jsonb, jsonb)'::regprocedure),
  'bfe81bfdb1b8a2582b65c92ba03ed0cc',
  'F3a: exceptions_sync minus its lines tagged 0386 IS the 0372 body (md5)');
select is(
  (select string_agg(btrim(regexp_replace(m[1], '\s+$', '')), E'\n' order by o)
     from pg_proc p, regexp_matches(p.prosrc, '\n([^\n]*)-- 0386[^\n]*', 'g') with ordinality r(m, o)
    where p.oid = 'public.exceptions_sync(uuid, timestamptz, text[], text[], text[], jsonb, jsonb)'::regprocedure),
  $x$v_settled     integer := 0;
-- ── 2b. (0386) Settled: a count_variance entry whose line was confirmed ──
-- The line is the entry's facts.cycleCountId for its item (the evaluator's
-- latest line). A confirmed line is HELD: it neither opens nor resolves
-- anything (exception_confirm_count resolved its row). A missing or
-- malformed id is NOT settled: it fails toward showing the difference,
-- never toward hiding it (the CASE keeps the uuid cast behind the pattern
-- test). Runs under the sync lock exception_confirm_count also takes, so a
-- stale evaluation applied after a confirm still sees it.
with s as (
select x.e, x.ord,
case
when (x.e->>'rule') = 'count_variance'
and coalesce(x.e->'facts'->>'cycleCountId', '') ~ c_uuid then exists (
select 1 from public.exception_occurrences c
where c.organization_id = p_org
and c.item_id = (x.e->>'item_id')::uuid
and c.confirmed_cycle_count_id = (x.e->'facts'->>'cycleCountId')::uuid
and c.resolved_reason = 'confirmed')
else false
end as settled
from jsonb_array_elements(v_present) with ordinality as x(e, ord)
)
select coalesce(jsonb_agg(s.e order by s.ord) filter (where not s.settled), '[]'::jsonb),
v_hold || coalesce(jsonb_agg(jsonb_build_object(
'rule', s.e->>'rule', 'item_id', s.e->'item_id', 'location_id', s.e->'location_id'))
filter (where s.settled), '[]'::jsonb),
count(*) filter (where s.settled)
into v_present, v_hold, v_settled
from s;
'settled',        v_settled,$x$,
  'F3b: the tagged lines are exactly the declare, step 2b and the settled key, in order');
select is(
  (select p.prosecdef::text || '|' || p.proconfig::text || '|' || coalesce(p.proacl::text, '')
     from pg_proc p where p.oid = 'public.exceptions_sync(uuid, timestamptz, text[], text[], text[], jsonb, jsonb)'::regprocedure),
  'false|{search_path=public,lock_timeout=5s}|{postgres=X/postgres,service_role=X/postgres}',
  'F4: exceptions_sync keeps SECURITY INVOKER, its settings and its service_role-only EXECUTE');

-- ═══ The org A fixture: one count, most lines by staff A ══════════════════
-- X18d is a count that recorded C18D BEFORE the main count did, so once the
-- main count is posted its line can no longer re-check the item.
select pg_temp.start(:mgr, :orgA, :w1, array[:c18d]::uuid[]) as "x18d" \gset
select pg_temp.rec(:mgr, :'x18d', :c18d, 12);
-- c14b's stock on Rack 1-A (so the count attributes its difference there).
select pg_temp.adjust(:mgr, :c14b, 10, :r1);
select pg_temp.start(:mgr, :orgA, :w1,
  array[:c1, :c2, :c3, :c4, :c5, :c8, :c10a, :c10b, :c11a, :c11b, :c13a, :c13b, :c14a, :c14b, :c16,
        :c18a, :c18b, :c18c, :c18d]::uuid[]) as "cca" \gset
select pg_temp.rec(:stA, :'cca', i, 7)
  from unnest(array[:c1, :c2, :c4, :c5, :c10a, :c10b, :c11a, :c11b, :c13a, :c13b, :c14a, :c14b, :c16,
                    :c18a, :c18b, :c18c, :c18d]::uuid[]) i;
select pg_temp.rec(:mgr, :'cca', :c3, 7);
select pg_temp.rec(:mgr, :'cca', :c8, 7);
-- A line with no recorder (a legacy line, or a direct write).
update public.cycle_count_lines set counted_by = null where cycle_count_id = :'cca' and item_id = :c8;
-- C16's line names staff C (Annex only) as its recorder (a direct write), so
-- the counter can write the item's warehouse only once the item moves there.
update public.cycle_count_lines set counted_by = :stC where cycle_count_id = :'cca' and item_id = :c16;
select pg_temp.post(:mgr, :'cca');
insert into cur_present (org, entry) values
  (:orgA, jsonb_build_object('rule', 'over_reserved', 'itemId', :c12::uuid, 'locationId', null, 'facts', '{}'::jsonb));
select pg_temp.sync(:orgA, 1) as "sync1" \gset

select is(
  row((:'sync1'::jsonb)->'raised', (select count(*) from public.exception_occurrences o where o.organization_id = :orgA and o.resolved_at is null),
      (select string_agg(distinct (o.facts->>'variance'), ',') from public.exception_occurrences o where o.organization_id = :orgA and o.rule = 'count_variance'),
      (select bool_and(o.facts->>'cycleCountId' = :'cca') from public.exception_occurrences o where o.organization_id = :orgA and o.rule = 'count_variance'))::text,
  row('20'::jsonb, 20::bigint, '-3', true)::text,
  'setup: the post and the sync raise 19 count differences (all -3, all naming the count) and the over_reserved row');

select pg_temp.open_occ(:c1) as "o1", pg_temp.open_occ(:c2) as "o2", pg_temp.open_occ(:c3) as "o3",
       pg_temp.open_occ(:c4) as "o4", pg_temp.open_occ(:c5) as "o5", pg_temp.open_occ(:c8) as "o8",
       pg_temp.open_occ(:c10a) as "o10a", pg_temp.open_occ(:c10b) as "o10b",
       pg_temp.open_occ(:c11a) as "o11a", pg_temp.open_occ(:c11b) as "o11b",
       pg_temp.open_occ(:c13a) as "o13a", pg_temp.open_occ(:c13b) as "o13b",
       pg_temp.open_occ(:c14a) as "o14a", pg_temp.open_occ(:c14b) as "o14b", pg_temp.open_occ(:c16) as "o16",
       pg_temp.open_occ(:c18a) as "o18a", pg_temp.open_occ(:c18b) as "o18b",
       pg_temp.open_occ(:c18c) as "o18c", pg_temp.open_occ(:c18d) as "o18d" \gset
select o.id as "o12" from public.exception_occurrences o where o.item_id = :c12 and o.rule = 'over_reserved' \gset

-- ═══ C. The confirm ═══════════════════════════════════════════════════════
-- Y2's stale evaluation is read BEFORE the confirm and applied after it.
select pg_temp.payload(:orgA, now() + interval '1500 milliseconds') as "stale" \gset

select is(pg_temp.confirm_as(:stA, :'o1', :'cca', 7, '  Counted twice on the floor  '), 'ok:counter',
  'C1a: staff A confirms the line they counted (answered as the counter)');
select is(
  (select row(o.resolved_reason, o.resolved_at = now(), o.confirmed_at = now(), o.confirmed_by, o.confirmed_cycle_count_id,
              o.confirmed_quantity, o.confirmed_on_record, o.confirmed_as, o.recount_cycle_count_id)::text
     from public.exception_occurrences o where o.id = :'o1'),
  row('confirmed', true, true, :stA::uuid, :'cca'::uuid, 7.0000::numeric(14,4), 7.0000::numeric(14,4), 'counter', null::uuid)::text,
  'C1b: the row is resolved as confirmed, with who, which count, the number, the stock on record and the role');
select is(
  (select string_agg(e.kind || ':' || coalesce(e.actor_user_id::text, 'system') || ':' || coalesce(e.cycle_count_id::text, '-')
                     || ':' || coalesce(e.note, '-') || ':' || coalesce(e.client_event_id, 'no-id'), '|' order by e.created_at, e.id)
     from public.exception_occurrence_events e where e.occurrence_id = :'o1'),
  'raised:system:-:-:no-id|count_confirmed:' || :stA || ':' || :'cca' || ':Counted twice on the floor:no-id',
  'C1c: exactly one count_confirmed event (the confirmer, the count, the trimmed note, no client event id) and no resolved event');

-- ═══ Y1, Y9, Y6: the sync after the confirm ═══════════════════════════════
select pg_temp.sync(:orgA, 2) as "y1" \gset
select is(
  row((:'y1'::jsonb)->'raised', (:'y1'::jsonb)->'settled', (:'y1'::jsonb)->'resolved', (:'y1'::jsonb)->'dropped',
      (select resolved_reason from public.exception_occurrences where id = :'o1'),
      (select count(*) from public.exception_occurrences where item_id = :c1))::text,
  row('0'::jsonb, '1'::jsonb, '0'::jsonb, '0'::jsonb, 'confirmed', 1::bigint)::text,
  'Y1 + Y9: a sync with the confirmed line still present raises 0, settles 1, resolves 0, drops 0, and the row stays confirmed');
select is(
  (select o.resolved_at is null and o.last_seen_at = now() + interval '2 seconds' from public.exception_occurrences o where o.id = :'o4'),
  true,
  'Y6: the settled key is per item: C4''s differing line in the SAME count is not settled (its row is seen and stays open)');
select is(
  row((pg_temp.apply(:orgA, now() + interval '3 seconds', :'stale'::jsonb))->'raised',
      (select count(*) from public.exception_occurrences where item_id = :c1))::text,
  row('0'::jsonb, 1::bigint)::text,
  'Y2: a STALE evaluation (read before the confirm, applied after it) raises nothing for the confirmed line');

-- ═══ C2, C15, C3 ══════════════════════════════════════════════════════════
select coalesce(sum(quantity), 0) || '/' as "stockA",
       (select coalesce(sum(quantity_on_hand), 0) from public.inventory_items where organization_id = :orgA) as "ohA",
       (select count(*) from public.stock_movements) as "mvA"
  from public.item_stock_levels s join public.inventory_items i on i.id = s.item_id where i.organization_id = :orgA \gset
select is(pg_temp.confirm_as(:mgr, :'o2', :'cca', 7), 'ok:manager',
  'C2: the manager, who did not count it, confirms (recorded as a manager)');
select is(
  row((select coalesce(sum(quantity), 0) || '/' from public.item_stock_levels s join public.inventory_items i on i.id = s.item_id where i.organization_id = :orgA),
      (select coalesce(sum(quantity_on_hand), 0) from public.inventory_items where organization_id = :orgA),
      (select count(*) from public.stock_movements))::text,
  row(:'stockA', :'ohA'::numeric, :'mvA'::bigint)::text,
  'C15: a confirm writes no stock (holdings, the stock on record and the movements are unchanged)');
select is(pg_temp.confirm_as(:mgr, :'o3', :'cca', 7), 'ok:counter',
  'C3: a manager who counted the line confirms it as the counter');

-- ═══ C4 to C8 ═════════════════════════════════════════════════════════════
select is(pg_temp.confirm_as(:stB, :'o4', :'cca', 7), '42501:not_counter',
  'C4: staff B (write access, did not count) on a confirmable row: 42501 not_counter');
select is(pg_temp.confirm_as(:mgrNA, :'o4', :'cca', 7), '42501:not_permitted',
  'C5: a manager without stock:adjust: 42501 not_permitted');
select is(pg_temp.confirm_as(:vwr, :'o4', :'cca', 7), '42501:not_permitted',
  'C6: a viewer: 42501 not_permitted');
select is(pg_temp.confirm_as(:stC, :'o4', :'cca', 7) || '|' || pg_temp.confirm_as(:mgrB, :'o4', :'cca', 7),
  'P0002:occurrence_not_found|P0002:occurrence_not_found',
  'C7: staff of another warehouse and a member of another org: not found (existence is not leaked)');
select is(pg_temp.confirm_as(:stA, :'o8', :'cca', 7) || '|' || pg_temp.confirm_as(:mgr, :'o8', :'cca', 7),
  '42501:not_counter|ok:manager',
  'C8: with counted_by null only a manager can confirm: staff A gets not_counter, the manager confirms');

-- ═══ C9: resolved rows and replay ═════════════════════════════════════════
select count(*) as "ev1" from public.exception_occurrence_events where occurrence_id = :'o1' \gset
select is(pg_temp.confirm_as(:stA, :'o1', :'cca', 7, 'Counted twice on the floor'), 'replay:counter',
  'C9a: the same person, count, number and note again: a replay (a lost answer resent)');
select is(
  row((select count(*) from public.exception_occurrence_events where occurrence_id = :'o1'),
      (select confirmed_at = now() from public.exception_occurrences where id = :'o1'))::text,
  row(:'ev1'::bigint, true)::text,
  'C9b: the replay writes nothing');
select is(
  pg_temp.confirm_as(:stA, :'o1', :'cca', 7, 'Another note')
  || '|' || pg_temp.confirm_as(:mgr, :'o1', :'cca', 7, 'Counted twice on the floor')
  || '|' || pg_temp.confirm_as(:stA, :'o1', :'cca', 7.5, 'Counted twice on the floor'),
  'P0001:occurrence_resolved|P0001:occurrence_resolved|P0001:occurrence_resolved',
  'C9c: another note, another person or another number on a resolved row: occurrence_resolved');

-- ═══ C10: count_changed ═══════════════════════════════════════════════════
select is(
  pg_temp.confirm_as(:stA, :'o10a', :'x18d', 7) || '|' || pg_temp.confirm_as(:stA, :'o10a', :'cca', 8),
  'P0001:count_changed|P0001:count_changed',
  'C10a: a count that is not the row''s, or a number that is not the line''s: count_changed');
select pg_temp.start(:mgr, :orgA, :w1, array[:c10b]::uuid[]) as "z10" \gset
select pg_temp.rec(:mgr, :'z10', :c10b, 7);
select pg_temp.post(:mgr, :'z10');
select is(pg_temp.confirm_as(:stA, :'o10b', :'cca', 7) || '|' || pg_temp.confirm_as(:stA, :'o10b', :'z10', 7),
  'P0001:count_changed|P0001:count_changed',
  'C10b: a newer count of the item was posted and no sync has applied it: count_changed, also for a request that names the newer count (the row''s facts still name the old one)');

-- ═══ C11: linked recounts ═════════════════════════════════════════════════
select pg_temp.recount(:mgr, :orgA, :'o11a', 'k-0386-11a') as "rc11a" \gset
select is(pg_temp.confirm_as(:stA, :'o11a', :'cca', 7), 'P0001:recount_in_progress',
  'C11a: a linked recount in progress that can still re-check the item: recount_in_progress');
select pg_temp.recount(:mgr, :orgA, :'o11b', 'k-0386-11b') as "rc11b" \gset
select pg_temp.as_user(:mgr);
update public.cycle_counts set status = 'canceled', canceled_by = :mgr, canceled_at = now() where id = :'rc11b';
select pg_temp.as_owner();
select is(pg_temp.confirm_as(:stA, :'o11b', :'cca', 7), 'ok:counter',
  'C11b: a linked recount that was cancelled (pointer not yet closed by a sync) does not block');
select is(
  row(pg_temp.tl(:'o11b'), (select recount_cycle_count_id from public.exception_occurrences where id = :'o11b'))::text,
  row(array['raised:-:system', 'recount_linked:' || :'rc11b' || ':' || :mgr, 'recount_closed:' || :'rc11b' || ':system',
            'count_confirmed:' || :'cca' || ':' || :stA], null::uuid)::text,
  'C11c: its pointer is closed first: raised, recount linked, recount closed (system), count confirmed');

-- ═══ C12, C13 ═════════════════════════════════════════════════════════════
select is(pg_temp.confirm_as(:stA, :'o12', :'cca', 7), 'P0001:not_confirmable',
  'C12: an over_reserved row: not_confirmable');
update public.inventory_items set is_rental = true where id = :c13a;
update public.inventory_items set status = 'archived' where id = :c13b;
select is(pg_temp.confirm_as(:stA, :'o13a', :'cca', 7) || '|' || pg_temp.confirm_as(:stA, :'o13b', :'cca', 7),
  'P0001:not_countable|P0001:not_countable',
  'C13: an item made rental equipment, or archived, after the count: not_countable');

-- ═══ C14, C19: stock moved ════════════════════════════════════════════════
select pg_temp.adjust(:mgr, :c14a, 2, null);
select is(pg_temp.confirm_as(:stA, :'o14a', :'cca', 7), 'P0001:stock_moved',
  'C14a: an adjustment after the post (net +2): stock_moved');
select pg_temp.transfer(:mgr, :c14b, :r1, :r2, 3);
select is(
  row((select quantity_on_hand from public.inventory_items where id = :c14b),
      (select string_agg(l.name || '=' || s.quantity::int, ',' order by l.name) from public.item_stock_levels s join public.locations l on l.id = s.location_id where s.item_id = :c14b and s.quantity <> 0),
      pg_temp.confirm_as(:stA, :'o14b', :'cca', 7))::text,
  row(7.0000::numeric(14,4), 'Rack 1-A=4,Rack 2-A=3', 'ok:counter')::text,
  'C14b: a transfer between racks nets to zero (the stock on record is still the counted 7): the confirm goes through');
select is(
  pg_temp.confirm_as(:vwr, :'o14a', :'cca', 7) || '|' || pg_temp.confirm_as(:stB, :'o14a', :'cca', 7)
  || '|' || pg_temp.confirm_as(:stB, :'o4', :'cca', 7),
  '42501:not_permitted|P0001:stock_moved|42501:not_counter',
  'C19: the order: the act gate first (viewer on a stock-moved row), then the state (staff B reads stock_moved), then counter or manager (staff B on a confirmable row)');

-- ═══ C16: the item's live warehouse ═══════════════════════════════════════
-- The counter is staff C (Annex only). Before the move C cannot see the row;
-- once the item is in the Annex, C passes the act gate against the item's
-- LIVE warehouse, although the row's stamp still says Main, which C cannot
-- write (the stamp would refuse C: not_permitted). Staff A can write Main
-- (the stamp) but can no longer see the item: read and write access to a
-- warehouse are the same for staff (user_can_access_inventory differs only
-- for viewers), so losing the item's warehouse means not found, never a
-- stamp-based pass.
select is(pg_temp.confirm_as(:stC, :'o16', :'cca', 7), 'P0002:occurrence_not_found',
  'C16a: before the item moves, staff C (the recorded counter, Annex only) cannot see the row');
update public.inventory_items set warehouse_id = :w2 where id = :c16;
select is(
  row(pg_temp.confirm_as(:stA, :'o16', :'cca', 7),
      (select warehouse_id from public.exception_occurrences where id = :'o16'),
      pg_temp.confirm_as(:stC, :'o16', :'cca', 7))::text,
  row('P0002:occurrence_not_found', :w1::uuid, 'ok:counter')::text,
  'C16b: after the item moves to the Annex (the row''s stamp still says Main): staff A (Main) gets not found, staff C, the counter, confirms through the gate on the item''s live warehouse');

-- ═══ C17: already confirmed (a row the sync would never leave) ════════════
insert into public.exception_occurrences
  (id, organization_id, occurrence_number, rule, item_id, location_id, warehouse_id, facts, first_seen_at, last_seen_at)
values ('03860000-0000-0000-0000-00000000c170', :orgA, 9170, 'count_variance', :c1, null, :w1,
        jsonb_build_object('cycleCountId', :'cca'::uuid, 'counted', 7, 'expected', 10, 'variance', -3),
        now(), now());
select is(pg_temp.confirm_as(:stA, '03860000-0000-0000-0000-00000000c170', :'cca', 7), 'P0001:already_confirmed',
  'C17: an open row naming a count line already confirmed on another row: already_confirmed (never 23505)');

-- ═══ C18: another count in progress ═══════════════════════════════════════
select pg_temp.start(:mgr, :orgA, :w1, array[:c18a, :c18b, :c18c]::uuid[]) as "y18" \gset
select pg_temp.rec(:mgr, :'y18', :c18a, 9);
select pg_temp.rec(:mgr, :'y18', :c18b, 7);
select is(
  pg_temp.confirm_as(:stA, :'o18a', :'cca', 7) || '|' || pg_temp.confirm_as(:stA, :'o18b', :'cca', 7)
  || '|' || pg_temp.confirm_as(:stA, :'o18c', :'cca', 7) || '|' || pg_temp.confirm_as(:stA, :'o18d', :'cca', 7),
  'P0001:count_in_progress|ok:counter|ok:counter|ok:counter',
  'C18: an unlinked count in progress that recorded a different number blocks; one that recorded the same number, an uncounted line, and a differing line counted before the posted count do not');

-- ═══ S5: the UNIQUE index, on a real count ════════════════════════════════
select is(
  pg_temp.err(format($$insert into public.exception_occurrences
      (organization_id, occurrence_number, rule, item_id, first_seen_at, last_seen_at, resolved_at, resolved_reason,
       confirmed_at, confirmed_cycle_count_id, confirmed_quantity, confirmed_on_record, confirmed_as)
      values (%L, 9180, 'count_variance', %L, now(), now(), now(), 'confirmed', now(), %L, 7, 7, 'manager')$$, :orgA, :c2, :'cca')),
  '23505::duplicate key value violates unique constraint "exc_occ_confirmed_line_uniq"',
  'S5: the UNIQUE index refuses a second confirmation of the same (org, item, count)');

-- ═══ Y. The sync after the confirms ═══════════════════════════════════════
select last_seen_at as "c170seen" from public.exception_occurrences where id = '03860000-0000-0000-0000-00000000c170' \gset
select pg_temp.sync(:orgA, 10) as "y7" \gset
select is(
  (select row(o.resolved_at, o.last_seen_at = :'c170seen'::timestamptz)::text from public.exception_occurrences o
    where o.id = '03860000-0000-0000-0000-00000000c170'),
  row(null::timestamptz, true)::text,
  'Y7: a settled entry never resolves (nor refreshes) an open row of the same identity');
select is(
  (select resolved_reason from public.exception_occurrences where id = :'o10b') || '|' || pg_temp.confirm_as(:stA, :'o10b', :'cca', 7),
  'cleared|P0001:occurrence_resolved',
  'C9d: a row the system check resolved (its newer count matched) answers occurrence_resolved');

-- Y3: a later count that differs raises a recurrence.
select is(pg_temp.confirm_as(:stA, :'o5', :'cca', 7), 'ok:counter', 'Y3 (setup): C5 is confirmed');
select pg_temp.start(:mgr, :orgA, :w1, array[:c5]::uuid[]) as "z5" \gset
select pg_temp.rec(:stA, :'z5', :c5, 5);
select pg_temp.post(:mgr, :'z5');
select pg_temp.sync(:orgA, 11) as "y3" \gset
select is(
  row((:'y3'::jsonb)->'raised',
      (select row(o.previous_occurrence_id, o.recurrence_index, o.facts->>'cycleCountId', o.facts->>'variance')::text
         from public.exception_occurrences o where o.item_id = :c5 and o.resolved_at is null))::text,
  row('1'::jsonb, row(:'o5'::uuid, 1, :'z5', '-2')::text)::text,
  'Y3: a later count that differs from the stock on record raises ONE new occurrence, linked to the confirmed one (recurrence 1), naming the new count');

-- Y4: later counts that match raise nothing, also after a receipt.
select pg_temp.start(:mgr, :orgA, :w1, array[:c2]::uuid[]) as "z2" \gset
select pg_temp.rec(:stA, :'z2', :c2, 7);
select pg_temp.post(:mgr, :'z2');
select pg_temp.adjust(:mgr, :c3, 5, null);
select pg_temp.start(:mgr, :orgA, :w1, array[:c3]::uuid[]) as "z3" \gset
select pg_temp.rec(:stA, :'z3', :c3, 12);
select pg_temp.post(:mgr, :'z3');
select pg_temp.sync(:orgA, 12) as "y4" \gset
select is(
  row((:'y4'::jsonb)->'raised', (:'y4'::jsonb)->'resolved',
      (select count(*) from public.exception_occurrences where item_id in (:c2, :c3)),
      (select string_agg(resolved_reason, ',' order by item_id) from public.exception_occurrences where item_id in (:c2, :c3)))::text,
  row('0'::jsonb, '0'::jsonb, 2::bigint, 'confirmed,confirmed')::text,
  'Y4: a later count that matches the stock on record raises and resolves nothing, also when a receipt changed the stock on record first (5, not the confirmed 7)');

-- Y5: a malformed or missing count id is never settled. Applied with no
-- rule complete, so nothing else resolves; both items have a confirmed row
-- (C2 on the count, C8 on the count), so a settle that ignored the id would
-- hold them.
create function pg_temp.apply_incomplete(p_org uuid, p_at timestamptz, p_present jsonb) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  v := public.exceptions_sync(p_org, p_at, '{}', '{}', '{}', p_present, '[]'::jsonb);
  perform set_config('role', 'none', true);
  return v;
end $$;
select pg_temp.apply_incomplete(:orgA, now() + interval '13 seconds', jsonb_build_array(
  jsonb_build_object('rule', 'count_variance', 'itemId', :c2::uuid, 'locationId', null,
                     'facts', jsonb_build_object('cycleCountId', 'not-a-count', 'counted', 7, 'expected', 10, 'variance', -3)),
  jsonb_build_object('rule', 'count_variance', 'itemId', :c8::uuid, 'locationId', null,
                     'facts', jsonb_build_object('counted', 7, 'expected', 10, 'variance', -3)))) as "y5" \gset
select is(
  row((:'y5'::jsonb)->'raised', (:'y5'::jsonb)->'settled',
      (select count(*) from public.exception_occurrences where item_id in (:c2, :c8) and resolved_at is null))::text,
  row('2'::jsonb, '0'::jsonb, 2::bigint)::text,
  'Y5: an entry whose facts.cycleCountId is malformed, or missing, is not settled: it is raised (never hidden), and the sync does not fail on the cast');

-- Y8: a confirmation stored in another org never settles this org's entry.
insert into public.exception_occurrences
  (organization_id, occurrence_number, rule, item_id, first_seen_at, last_seen_at, resolved_at, resolved_reason,
   confirmed_at, confirmed_cycle_count_id, confirmed_quantity, confirmed_on_record, confirmed_as)
values (:orgB, 9190, 'count_variance', :c4, now(), now(), now(), 'confirmed', now(), :'cca', 7, 7, 'manager');
select pg_temp.sync(:orgA, 14) as "y8" \gset
select is(
  (select row(o.resolved_at, o.last_seen_at = now() + interval '14 seconds')::text from public.exception_occurrences o where o.id = :'o4'),
  row(null::timestamptz, true)::text,
  'Y8: a confirmation of the same item and count stored in ANOTHER org does not settle this org''s entry (still seen, still open)');

-- ═══ X. EX-000059's shape, start to end (org E, the owner) ════════════════
select pg_temp.adjust(:own, :e59, 100, null);
select pg_temp.start(:own, :orgE, :wE, array[:e59]::uuid[]) as "cce" \gset
select pg_temp.rec(:own, :'cce', :e59, 2);
select pg_temp.post(:own, :'cce');
select pg_temp.sync(:orgE, 20) as "x1" \gset
select pg_temp.open_occ(:e59) as "ex59" \gset
select is(
  row((:'x1'::jsonb)->'raised',
      (select row(o.facts->'expected', o.facts->'counted', o.facts->'variance')::text from public.exception_occurrences o where o.id = :'ex59'),
      (select quantity_on_hand from public.inventory_items where id = :e59))::text,
  row('1'::jsonb, row('100'::jsonb, '2'::jsonb, '-98'::jsonb)::text, 2.0000::numeric(14,4))::text,
  'X1: 100 on record, the owner counts 2 and posts it: the sync raises the exception (expected 100, counted 2, -98) and the stock on record is 2');
select pg_temp.transfer(:own, :e59, :'stgE', :rE, 2);
select pg_temp.as_user(:own);
select public.exception_occurrence_act(:'ex59', 'acknowledge', 'Items recounted', null);
select pg_temp.as_owner();
select is(
  row((select quantity_on_hand from public.inventory_items where id = :e59),
      (select resolved_at from public.exception_occurrences where id = :'ex59'),
      (select acknowledged_by from public.exception_occurrences where id = :'ex59'))::text,
  row(2.0000::numeric(14,4), null::timestamptz, :own::uuid)::text,
  'X2: the owner puts the 2 units on Rack 36-A (the total stays 2) and acknowledges with "Items recounted": still open (G9)');
select is(pg_temp.confirm_as(:own, :'ex59', :'cce', 2), 'ok:counter',
  'X3: the owner confirms the count they made: recorded as the counter');
select is(
  row((pg_temp.sync(:orgE, 21))->'raised',
      (select string_agg(e.kind || ':' || coalesce(e.note, '-'), '|' order by e.created_at, e.id)
         from public.exception_occurrence_events e where e.occurrence_id = :'ex59'),
      (select resolved_reason || ':' || confirmed_as from public.exception_occurrences where id = :'ex59'))::text,
  row('0'::jsonb, 'raised:-|acknowledged:Items recounted|count_confirmed:-', 'confirmed:counter')::text,
  'X4: the next sync raises nothing; the timeline reads raised, acknowledged (with its note), count confirmed; resolved as confirmed by the counter');

-- ═══ M. The gate agreement: exception-confirm.fixture.ts, cell by cell ════
-- One count in org M over 24 items (three counters x eight states), each
-- counted 7 where 10 was on record, then each state made for real.
select pg_temp.start(:mgr, :orgM, :wM, (select array_agg(item_id order by item_id) from mx)) as "ccm" \gset
select pg_temp.rec(:stA, :'ccm', m.item_id, 7) from mx m where m.variant = 'A';
select pg_temp.rec(:mgr, :'ccm', m.item_id, 7) from mx m where m.variant in ('M', 'N');
update public.cycle_count_lines set counted_by = null
 where cycle_count_id = :'ccm' and item_id in (select item_id from mx where variant = 'N');
select pg_temp.post(:mgr, :'ccm');
select is((pg_temp.sync(:orgM, 30))->'raised', '24'::jsonb, 'M (setup): 24 count differences raised in org M');
update mx set occ_id = pg_temp.open_occ(mx.item_id);

-- recount_in_progress: a linked recount, uncounted.
select pg_temp.recount(:mgr, :orgM, m.occ_id, 'k-0386-m-rip-' || m.variant) from mx m where m.state = 'recount_in_progress';
-- count_in_progress: an unlinked count that recorded 9 (7 on record).
select pg_temp.start(:mgr, :orgM, :wM, (select array_agg(item_id) from mx where state = 'count_in_progress')) as "mcip" \gset
select pg_temp.rec(:mgr, :'mcip', m.item_id, 9) from mx m where m.state = 'count_in_progress';
-- rechecking: a linked recount, posted, not yet applied by a sync.
create temp table mrc as
select m.item_id, pg_temp.recount(:mgr, :orgM, m.occ_id, 'k-0386-m-rck-' || m.variant) as cc from mx m where m.state = 'rechecking';
select pg_temp.rec(:mgr, r.cc, r.item_id, 7) from mrc r;
select pg_temp.post(:mgr, r.cc) from mrc r;
-- count_changed: a newer, unlinked count, posted, not yet applied.
select pg_temp.start(:mgr, :orgM, :wM, (select array_agg(item_id) from mx where state = 'count_changed')) as "mcc" \gset
select pg_temp.rec(:mgr, :'mcc', m.item_id, 7) from mx m where m.state = 'count_changed';
select pg_temp.post(:mgr, :'mcc');
-- not_countable: made rental equipment.
update public.inventory_items set is_rental = true where id in (select item_id from mx where state = 'not_countable');
-- stock_moved: +2 after the post.
select pg_temp.adjust(:mgr, m.item_id, 2, null) from mx m where m.state = 'stock_moved';
-- already_confirmed: the count line already confirmed on another row.
insert into public.exception_occurrences
  (organization_id, occurrence_number, rule, item_id, first_seen_at, last_seen_at, resolved_at, resolved_reason,
   confirmed_at, confirmed_cycle_count_id, confirmed_quantity, confirmed_on_record, confirmed_as)
select :orgM, 9500 + row_number() over (order by m.item_id), 'count_variance', m.item_id, now(), now(), now(), 'confirmed',
       now(), :'ccm', 7, 7, 'manager'
  from mx m where m.state = 'already_confirmed';

-- The fixture (GATE_READERS x GATE_EXPECTATIONS, 'unavailable' is app-only),
-- and GATE_REASON_TO_RPC.
create temp table gate_cell (reader text, state text, cell text, primary key (reader, state));
insert into gate_cell
select r.reader, s.state,
       case
         when r.reader in ('viewer', 'manager without stock:adjust') then 'not_permitted'
         when s.state <> 'confirmable' then s.state
         when r.reader in ('counter (staff)', 'counter (manager)') then 'counter'
         when r.reader in ('manager who did not count', 'manager, counted_by null') then 'manager'
         else 'not_counter'
       end
  from (values ('counter (staff)'), ('counter (manager)'), ('manager who did not count'), ('staff who did not count'),
               ('viewer'), ('manager without stock:adjust'), ('staff, counted_by null'), ('manager, counted_by null')) r(reader),
       (values ('recount_in_progress'), ('count_in_progress'), ('rechecking'), ('count_changed'), ('not_countable'),
               ('stock_moved'), ('already_confirmed'), ('confirmable')) s(state);
create temp table gate_rpc (cell text primary key, answer text not null);
insert into gate_rpc values
  ('not_permitted', '42501:not_permitted'), ('not_counter', '42501:not_counter'),
  ('recount_in_progress', 'P0001:recount_in_progress'), ('count_in_progress', 'P0001:count_in_progress'),
  ('rechecking', 'P0001:count_changed'), ('count_changed', 'P0001:count_changed'),
  ('not_countable', 'P0001:not_countable'), ('stock_moved', 'P0001:stock_moved'),
  ('already_confirmed', 'P0001:already_confirmed'), ('counter', 'ok:counter'), ('manager', 'ok:manager');
create temp table gate_reader (reader text primary key, uid uuid not null, variant text not null);
insert into gate_reader values
  ('counter (staff)', :stA, 'A'), ('counter (manager)', :mgr, 'M'), ('manager who did not count', :mgr, 'A'),
  ('staff who did not count', :stB, 'A'), ('viewer', :vwr, 'A'), ('manager without stock:adjust', :mgrNA, 'A'),
  ('staff, counted_by null', :stA, 'N'), ('manager, counted_by null', :mgr, 'N');
grant select on gate_cell, gate_rpc, gate_reader, mrc to authenticated, service_role;

create function pg_temp.matrix_row(p_reader text, p_cc uuid) returns table (got text, want text) language sql as $$
  select string_agg(c.state || '=' || pg_temp.probe_as(g.uid, m.occ_id, p_cc, 7), ',' order by c.state),
         string_agg(c.state || '=' || a.answer, ',' order by c.state)
    from gate_cell c
    join gate_reader g on g.reader = c.reader
    join mx m on m.variant = g.variant and m.state = c.state
    join gate_rpc a on a.cell = c.cell
   where c.reader = p_reader
$$;

select is(got, want, 'M1: counter (staff): every state answers as the fixture says') from pg_temp.matrix_row('counter (staff)', :'ccm');
select is(got, want, 'M2: counter (manager)') from pg_temp.matrix_row('counter (manager)', :'ccm');
select is(got, want, 'M3: manager who did not count') from pg_temp.matrix_row('manager who did not count', :'ccm');
select is(got, want, 'M4: staff who did not count') from pg_temp.matrix_row('staff who did not count', :'ccm');
select is(got, want, 'M5: viewer') from pg_temp.matrix_row('viewer', :'ccm');
select is(got, want, 'M6: manager without stock:adjust') from pg_temp.matrix_row('manager without stock:adjust', :'ccm');
select is(got, want, 'M7: staff, counted_by null') from pg_temp.matrix_row('staff, counted_by null', :'ccm');
select is(got, want, 'M8: manager, counted_by null') from pg_temp.matrix_row('manager, counted_by null', :'ccm');
select is(
  (select count(*) from public.exception_occurrences o join mx m on m.occ_id = o.id where o.resolved_at is not null),
  0::bigint,
  'M9: every probe rolled back (no matrix row was resolved)');

select * from finish();
rollback;
