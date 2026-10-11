-- supabase/tests/0399_ungroup_shared_sku.test.sql
-- pgTAP proof for migration 0399 (Ungroup, slice G1): split_item_sku gives a
-- record that shares its SKU a fresh SKU of its own, changing that record only.
--
-- NOT RUN at the authoring stage (desk only: the local stack is held by
-- another job). It runs at the test stage with `supabase test db`.
--
-- Personas (real `authenticated` calls with request.jwt.claim.sub):
--   own    owner                 mgr    manager
--   stf    staff, whA (no charter: reads whA's no-charter records)
--   stfCh  staff, whA + charter chA (reads no-charter and chA records of whA)
--   stfNo  staff, whA, items:update revoked (user override false)
--   vwr    viewer, whA (no items:update by default)
--   vwrUp  viewer, whA, items:update granted (reads, cannot write whA)
--   dis    a disabled manager    mgrB   a manager of another org
--   nobody signed in, in no org; anon and service_role hold no EXECUTE.
--
-- G.  Grants and shape: the table (RLS on, no policy, no API privilege, its
--     keys and checks); every function's posture (DEFINER only for the entry
--     point and caller_can_write_item, search_path, lock_timeout, EXECUTE to
--     authenticated only for those two, none for the private steps), owner;
--     no 40001/40P01 raise (0367), the INV-25 token, no dynamic SQL.
-- S.  The owner's case (two no-charter records of one SKU on two racks): one
--     is split; its new SKU has generateSku's shape and is unused; the other
--     is untouched; the answer's exact shape; the audit row's shape; only sku,
--     updated_by, updated_at and the search vector changed on the split row.
-- I.  Idempotency: the same key and body replays (replay true, nothing
--     written, same SKU); another body under the key is idempotency_conflict;
--     one request row per applied key.
-- A.  Every record of a SKU selected: the named anchor keeps the SKU; with
--     no anchor the oldest (created_at, then id) keeps it; an anchor named
--     for a SKU that still has unselected readable records is
--     sku_siblings_changed.
-- H.  Hidden siblings never change the answer: staff who sees one record of
--     a three-charter SKU gets not_shared; charter staff who sees two of
--     three gets the same answer as on a SKU with no hidden record; a hidden
--     id is item_not_found, the same answer as an unknown id.
-- R.  Refusals: not_shared (alone; a deleted sibling and another
--     organization's row do not count), family_member_sku, not_groupable
--     (kit), item_changed, item_not_found (unknown, deleted, other org),
--     every shape case (grouping_invalid with its field), the key cases.
-- P.  Permission: viewer and revoked staff are refused (the role floor is not
--     enough), a viewer granted items:update cannot write whA
--     (item_not_writable), actor_mismatch, signed out, not a member, a
--     disabled member, another org's manager; anon and service_role cannot
--     execute.
-- K.  caller_can_write_item keeps step with a real RLS update for each
--     persona (the revoked staff member is the documented difference, V5).
-- F.  Failure injection: a planted raise on the audit insert, on the request
--     insert and on the 2nd SKU update each leaves nothing changed.
-- Z.  The fresh-SKU helper (shape, distinct, unused, bounded count); 0234
--     holds; no stock movement and no holding changed; nothing outside the
--     split rows changed; the other organization is untouched.
--
-- NOWAIT busy (55P03) needs two sessions: scripts/db-concurrency/
-- 0399_split_sku_race.sh.
--
-- Roles: fixtures as the test superuser (RLS bypassed, the API-role guards
-- exempt). begin/rollback: nothing leaks. Namespace 03990000.

begin;

select plan(49);

\set orgA   '\'03990000-0000-0000-0000-00000000000a\''
\set orgB   '\'03990000-0000-0000-0000-00000000000b\''
\set own    '\'03990000-0000-0000-0000-0000000000a0\''
\set mgr    '\'03990000-0000-0000-0000-0000000000a1\''
\set stf    '\'03990000-0000-0000-0000-0000000000a2\''
\set stfCh  '\'03990000-0000-0000-0000-0000000000a3\''
\set stfNo  '\'03990000-0000-0000-0000-0000000000a4\''
\set vwr    '\'03990000-0000-0000-0000-0000000000a5\''
\set vwrUp  '\'03990000-0000-0000-0000-0000000000a6\''
\set dis    '\'03990000-0000-0000-0000-0000000000a7\''
\set mgrB   '\'03990000-0000-0000-0000-0000000000b1\''
\set nobody '\'03990000-0000-0000-0000-0000000000c1\''
\set whA    '\'03990000-0000-0000-0000-0000000000d1\''
\set whB    '\'03990000-0000-0000-0000-0000000000d2\''
\set chA    '\'03990000-0000-0000-0000-0000000000e1\''
\set chB    '\'03990000-0000-0000-0000-0000000000e2\''
\set catA   '\'03990000-0000-0000-0000-0000000000e8\''
\set grp    '\'03990000-0000-0000-0000-0000000000e9\''
-- The owner's case: one product on two racks, no charter.
\set pa1    '\'03990000-0000-0000-0000-000000000101\''
\set pa2    '\'03990000-0000-0000-0000-000000000102\''
-- Three charters: no charter, chA, chB.
\set t1     '\'03990000-0000-0000-0000-000000000111\''
\set t2     '\'03990000-0000-0000-0000-000000000112\''
\set t3     '\'03990000-0000-0000-0000-000000000113\''
-- A SKU charter staff sees two of three (q3 in chB), and its control with no
-- hidden record.
\set q1     '\'03990000-0000-0000-0000-000000000121\''
\set q2     '\'03990000-0000-0000-0000-000000000122\''
\set q3     '\'03990000-0000-0000-0000-000000000123\''
\set c1     '\'03990000-0000-0000-0000-000000000131\''
\set c2     '\'03990000-0000-0000-0000-000000000132\''
-- Every record selected: with an anchor, and without (oldest keeps).
\set n1     '\'03990000-0000-0000-0000-000000000141\''
\set n2     '\'03990000-0000-0000-0000-000000000142\''
\set n3     '\'03990000-0000-0000-0000-000000000143\''
\set o1     '\'03990000-0000-0000-0000-000000000152\''
\set o2     '\'03990000-0000-0000-0000-000000000151\''
-- Anchor on a SKU not fully selected.
\set s1     '\'03990000-0000-0000-0000-000000000161\''
\set s2     '\'03990000-0000-0000-0000-000000000162\''
\set s3     '\'03990000-0000-0000-0000-000000000163\''
-- Refusals.
\set solo   '\'03990000-0000-0000-0000-000000000171\''
\set dl     '\'03990000-0000-0000-0000-000000000172\''
\set dd     '\'03990000-0000-0000-0000-000000000173\''
\set f1     '\'03990000-0000-0000-0000-000000000174\''
\set f2     '\'03990000-0000-0000-0000-000000000175\''
\set k1     '\'03990000-0000-0000-0000-000000000176\''
\set k2     '\'03990000-0000-0000-0000-000000000177\''
\set m1     '\'03990000-0000-0000-0000-000000000178\''
\set m2     '\'03990000-0000-0000-0000-000000000179\''
\set x1     '\'03990000-0000-0000-0000-00000000017a\''
-- Failure injection, one pair each (the third uses three records).
\set j1     '\'03990000-0000-0000-0000-000000000181\''
\set j2     '\'03990000-0000-0000-0000-000000000182\''
\set j3     '\'03990000-0000-0000-0000-000000000183\''
\set j4     '\'03990000-0000-0000-0000-000000000184\''
\set j5     '\'03990000-0000-0000-0000-000000000185\''
\set j6     '\'03990000-0000-0000-0000-000000000186\''
\set j7     '\'03990000-0000-0000-0000-000000000187\''
-- Charter pair (same charter chA, two racks) for charter staff.
\set h1     '\'03990000-0000-0000-0000-000000000191\''
\set h2     '\'03990000-0000-0000-0000-000000000192\''
-- Another organization: one row with the owner's-case SKU, one with x1's.
\set bp     '\'03990000-0000-0000-0000-0000000001b1\''
\set bx     '\'03990000-0000-0000-0000-0000000001b2\''
\set gone   '\'03990000-0000-0000-0000-0000000001ff\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,    '0399-own@test.local',    '{}'::jsonb),
  (:mgr,    '0399-mgr@test.local',    '{}'::jsonb),
  (:stf,    '0399-stf@test.local',    '{}'::jsonb),
  (:stfCh,  '0399-stfch@test.local',  '{}'::jsonb),
  (:stfNo,  '0399-stfno@test.local',  '{}'::jsonb),
  (:vwr,    '0399-vwr@test.local',    '{}'::jsonb),
  (:vwrUp,  '0399-vwrup@test.local',  '{}'::jsonb),
  (:dis,    '0399-dis@test.local',    '{}'::jsonb),
  (:mgrB,   '0399-mgrb@test.local',   '{}'::jsonb),
  (:nobody, '0399-nobody@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, '0399 Ungroup A', '0399-ungroup-a'),
  (:orgB, '0399 Ungroup B', '0399-ungroup-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,   'owner',   now()),
  (:orgA, :mgr,   'manager', now()),
  (:orgA, :stf,   'staff',   now()),
  (:orgA, :stfCh, 'staff',   now()),
  (:orgA, :stfNo, 'staff',   now()),
  (:orgA, :vwr,   'viewer',  now()),
  (:orgA, :vwrUp, 'viewer',  now()),
  (:orgA, :dis,   'manager', now()),
  (:orgB, :mgrB,  'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, '0399 Main',  'WH-0399A', 'active'),
  (:whB, :orgB, '0399 Other', 'WH-0399B', 'active');
insert into public.charters (id, organization_id, name, code, status) values
  (:chA, :orgA, '0399 North', 'C0399N', 'active'),
  (:chB, :orgA, '0399 South', 'C0399S', 'active');
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values
  (:orgA, :whA, :chA),
  (:orgA, :whA, :chB);
insert into public.categories (id, organization_id, name) values (:catA, :orgA, '0399 Gear');
insert into public.product_groups (id, organization_id, name, group_key, default_counting_unit)
  values (:grp, :orgA, '0399 Family', '0399|family', 'each');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, charter_id, is_primary) values
  (:orgA, :stf,   :whA, null, true),
  (:orgA, :stfCh, :whA, :chA, true),
  (:orgA, :stfNo, :whA, null, true),
  (:orgA, :vwr,   :whA, null, true),
  (:orgA, :vwrUp, :whA, null, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :stfNo, 'items:update', false),
  (:orgA, :vwrUp, 'items:update', true);

-- created_at is set so the "oldest keeps" rule is decided by it, not by id:
-- o1's id sorts AFTER o2's, and o1 is the older record.
insert into public.inventory_items
  (id, organization_id, warehouse_id, charter_id, category_id, sku, name, barcode, bin_location,
   quantity_on_hand, status, is_bundle, group_id, created_at, deleted_at) values
  (:pa1,  :orgA, :whA, null, :catA, 'X0399-PAIR',  'Mouse pad',       null,            '22-A', 9, 'active', false, null, '2026-01-01T00:00:00Z', null),
  (:pa2,  :orgA, :whA, null, :catA, 'X0399-PAIR',  'Mouse pad',       null,            '22-C', 4, 'active', false, null, '2026-01-02T00:00:00Z', null),
  (:t1,   :orgA, :whA, null, :catA, 'X0399-TRIO',  'Trio',            null,            '1-A',  1, 'active', false, null, '2026-01-01T00:00:00Z', null),
  (:t2,   :orgA, :whA, :chA, :catA, 'X0399-TRIO',  'Trio',            null,            '2-A',  1, 'active', false, null, '2026-01-02T00:00:00Z', null),
  (:t3,   :orgA, :whA, :chB, :catA, 'X0399-TRIO',  'Trio',            null,            '3-A',  1, 'active', false, null, '2026-01-03T00:00:00Z', null),
  (:q1,   :orgA, :whA, null, :catA, 'X0399-QUAD',  'Quad',            null,            '1-B',  1, 'active', false, null, '2026-01-01T00:00:00Z', null),
  (:q2,   :orgA, :whA, :chA, :catA, 'X0399-QUAD',  'Quad',            null,            '2-B',  1, 'active', false, null, '2026-01-02T00:00:00Z', null),
  (:q3,   :orgA, :whA, :chB, :catA, 'X0399-QUAD',  'Quad',            null,            '3-B',  1, 'active', false, null, '2026-01-03T00:00:00Z', null),
  (:c1,   :orgA, :whA, null, :catA, 'X0399-CTRL',  'Control',         null,            '1-C',  1, 'active', false, null, '2026-01-01T00:00:00Z', null),
  (:c2,   :orgA, :whA, :chA, :catA, 'X0399-CTRL',  'Control',         null,            '2-C',  1, 'active', false, null, '2026-01-02T00:00:00Z', null),
  (:n1,   :orgA, :whA, null, :catA, 'X0399-ANCH',  'Anchored',        '9780000000001', '1-D',  1, 'active', false, null, '2026-01-01T00:00:00Z', null),
  (:n2,   :orgA, :whA, null, :catA, 'X0399-ANCH',  'Anchored',        '9780000000001', '2-D',  1, 'active', false, null, '2026-01-02T00:00:00Z', null),
  (:n3,   :orgA, :whA, null, :catA, 'X0399-ANCH',  'Anchored',        '9780000000001', '3-D',  1, 'active', false, null, '2026-01-03T00:00:00Z', null),
  (:o1,   :orgA, :whA, null, :catA, 'X0399-OLD',   'Oldest keeps',    null,            '1-E',  1, 'active', false, null, '2026-01-01T00:00:00Z', null),
  (:o2,   :orgA, :whA, null, :catA, 'X0399-OLD',   'Oldest keeps',    null,            '2-E',  1, 'active', false, null, '2026-01-05T00:00:00Z', null),
  (:s1,   :orgA, :whA, null, :catA, 'X0399-SIB',   'Siblings',        null,            '1-F',  1, 'active', false, null, '2026-01-01T00:00:00Z', null),
  (:s2,   :orgA, :whA, null, :catA, 'X0399-SIB',   'Siblings',        null,            '2-F',  1, 'active', false, null, '2026-01-02T00:00:00Z', null),
  (:s3,   :orgA, :whA, null, :catA, 'X0399-SIB',   'Siblings',        null,            '3-F',  1, 'active', false, null, '2026-01-03T00:00:00Z', null),
  (:solo, :orgA, :whA, null, :catA, 'X0399-SOLO',  'Alone',           null,            '1-G',  1, 'active', false, null, '2026-01-01T00:00:00Z', null),
  (:dl,   :orgA, :whA, null, :catA, 'X0399-DEL',   'Live',            null,            '1-H',  1, 'active', false, null, '2026-01-01T00:00:00Z', null),
  (:dd,   :orgA, :whA, null, :catA, 'X0399-DEL',   'Deleted',         null,            '2-H',  0, 'active', false, null, '2026-01-02T00:00:00Z', '2026-02-01T00:00:00Z'),
  (:f1,   :orgA, :whA, null, :catA, 'X0399-FAM',   'Family member',   null,            '1-J',  1, 'active', false, :grp, '2026-01-01T00:00:00Z', null),
  (:f2,   :orgA, :whA, null, :catA, 'X0399-FAM',   'Family member',   null,            '2-J',  1, 'active', false, :grp, '2026-01-02T00:00:00Z', null),
  (:k1,   :orgA, :whA, null, :catA, 'X0399-KIT',   'Kit',             null,            '1-K',  1, 'active', true,  null, '2026-01-01T00:00:00Z', null),
  (:k2,   :orgA, :whA, null, :catA, 'X0399-KIT',   'Kit',             null,            '2-K',  1, 'active', false, null, '2026-01-02T00:00:00Z', null),
  (:m1,   :orgA, :whA, null, :catA, 'X0399-MOVED', 'Moved',           null,            '1-L',  1, 'active', false, null, '2026-01-01T00:00:00Z', null),
  (:m2,   :orgA, :whA, null, :catA, 'X0399-MOVED', 'Moved',           null,            '2-L',  1, 'active', false, null, '2026-01-02T00:00:00Z', null),
  (:x1,   :orgA, :whA, null, :catA, 'X0399-CROSS', 'Cross org',       null,            '1-M',  1, 'active', false, null, '2026-01-01T00:00:00Z', null),
  (:j1,   :orgA, :whA, null, :catA, 'X0399-INJ1',  'Inject one',      null,            '1-N',  1, 'active', false, null, '2026-01-01T00:00:00Z', null),
  (:j2,   :orgA, :whA, null, :catA, 'X0399-INJ1',  'Inject one',      null,            '2-N',  1, 'active', false, null, '2026-01-02T00:00:00Z', null),
  (:j3,   :orgA, :whA, null, :catA, 'X0399-INJ2',  'Inject two',      null,            '1-P',  1, 'active', false, null, '2026-01-01T00:00:00Z', null),
  (:j4,   :orgA, :whA, null, :catA, 'X0399-INJ2',  'Inject two',      null,            '2-P',  1, 'active', false, null, '2026-01-02T00:00:00Z', null),
  (:j5,   :orgA, :whA, null, :catA, 'X0399-INJ3',  'Inject three',    null,            '1-Q',  1, 'active', false, null, '2026-01-01T00:00:00Z', null),
  (:j6,   :orgA, :whA, null, :catA, 'X0399-INJ3',  'Inject three',    null,            '2-Q',  1, 'active', false, null, '2026-01-02T00:00:00Z', null),
  (:j7,   :orgA, :whA, null, :catA, 'X0399-INJ3',  'Inject three',    null,            '3-Q',  1, 'active', false, null, '2026-01-03T00:00:00Z', null),
  (:h1,   :orgA, :whA, :chA, :catA, 'X0399-CHART', 'Charter pair',    null,            '1-R',  1, 'active', false, null, '2026-01-01T00:00:00Z', null),
  (:h2,   :orgA, :whA, :chA, :catA, 'X0399-CHART', 'Charter pair',    null,            '2-R',  1, 'active', false, null, '2026-01-02T00:00:00Z', null),
  (:bp,   :orgB, :whB, null, null,  'X0399-PAIR',  'Org B mouse pad', null,            '22-A', 5, 'active', false, null, '2026-01-01T00:00:00Z', null),
  (:bx,   :orgB, :whB, null, null,  'X0399-CROSS', 'Org B cross',     null,            '1-M',  5, 'active', false, null, '2026-01-01T00:00:00Z', null);

-- The disabled manager, disabled the way the service does it.
set local role to 'service_role';
update public.user_profiles set disabled_at = now(), disabled_reason = 'policy_violation' where id = :dis;
reset role;

-- One call as a role and a user. Answers the result as text, or
-- ERR:<sqlstate>:<hint>:<detail> (a failed call's subtransaction is rolled
-- back, so it wrote nothing).
create function pg_temp.run(p_as text, p_sub uuid, p_sql text) returns text language plpgsql as $$
declare v_state text; v_hint text; v_detail text; v text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('role', p_as, true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint, v_detail = pg_exception_detail;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    return 'ERR:' || v_state || ':' || coalesce(v_hint, '') || ':' || coalesce(v_detail, '');
  end;
  return coalesce(v, 'null');
end $$;
-- The SKUs the caller sees now, for a request (read as the superuser).
create function pg_temp.exp(p_ids uuid[]) returns jsonb language sql as $$
  select coalesce(jsonb_object_agg(i.id::text, i.sku), '{}'::jsonb) from public.inventory_items i where i.id = any (p_ids)
$$;
-- A split request (snake_case, as core toSplitSkuRpcRequest builds it).
create function pg_temp.req(p_actor uuid, p_ids uuid[], p_anchors uuid[] default null,
                            p_org uuid default '03990000-0000-0000-0000-00000000000a', p_exp jsonb default null)
returns jsonb language sql as $$
  select jsonb_build_object('action', 'split_sku', 'organization_id', p_org, 'actor_user_id', p_actor,
                            'surface', 'web', 'item_ids', to_jsonb(p_ids),
                            'expected_skus', coalesce(p_exp, pg_temp.exp(p_ids)))
         || case when p_anchors is null then '{}'::jsonb else jsonb_build_object('anchor_item_ids', to_jsonb(p_anchors)) end
$$;
-- Key n.
create function pg_temp.k(p_n integer) returns text language sql as $$
  select '03999000-0000-4000-8000-' || lpad(to_hex(p_n), 12, '0')
$$;
create function pg_temp.split(p_sub uuid, p_req jsonb, p_key text) returns text language sql as $$
  select pg_temp.run('authenticated', p_sub, format('select public.split_item_sku(%L::jsonb, %L)::text', p_req, p_key))
$$;
-- sqlstate:hint of an ERR answer, or the answer's item states as id-suffix=kept.
create function pg_temp.brief(p text) returns text language sql as $$
  select case when p like 'ERR:%' then split_part(p, ':', 2) || ':' || split_part(p, ':', 3)
    else (select string_agg(right(e->>'id', 3) || '=' || (e->>'kept'), ',' order by e->>'id')
            from jsonb_array_elements(p::jsonb->'items') e) || '/' || coalesce(p::jsonb->>'replay', '-') end
$$;
-- The itemIds of an ERR answer's detail, as id suffixes.
create function pg_temp.ids_of(p text) returns text language sql as $$
  select string_agg(right(v, 3), ',' order by v)
    from jsonb_array_elements_text(substr(p, length(split_part(p, ':', 1) || split_part(p, ':', 2) || split_part(p, ':', 3)) + 4)::jsonb->'itemIds') x(v)
$$;
-- The real RLS update answer for a persona: rows an inventory_items UPDATE
-- reaches (rolled back: the probe raises its count).
create function pg_temp.rls_updates(p_sub uuid, p_item uuid) returns integer language plpgsql as $$
declare v_n integer; v_msg text;
begin
  begin
    perform set_config('request.jwt.claim.sub', p_sub::text, true);
    perform set_config('role', 'authenticated', true);
    update public.inventory_items set description = coalesce(description, '') where id = p_item;
    get diagnostics v_n = row_count;
    raise exception '%', v_n using errcode = 'P0001', hint = 'probe';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    if v_msg ~ '^\d+$' then return v_msg::integer; end if;
    return -1;
  end;
end $$;
-- Row fingerprints of an organization: full, and without the columns a split
-- may change.
create function pg_temp.fp_full(p_org uuid) returns table (id uuid, j jsonb) language sql as $$
  select i.id, to_jsonb(i) from public.inventory_items i where i.organization_id = p_org
$$;

create temp table ans (tag text primary key, r text);
create temp table before_items as select * from pg_temp.fp_full(:orgA) union all select * from pg_temp.fp_full(:orgB);
create temp table before_stock as
  select (select md5(coalesce(string_agg(to_jsonb(s)::text, ',' order by s.item_id, s.location_id), ''))
            from public.item_stock_levels s where s.organization_id in (:orgA, :orgB)) as levels,
         (select md5(coalesce(string_agg(to_jsonb(m)::text, ',' order by m.id), ''))
            from public.stock_movements m where m.organization_id in (:orgA, :orgB)) as movements;
grant all on ans to authenticated;

-- Guard the fixtures: a silently missing row would let an assertion pass for
-- the wrong reason.
do $$ begin
  if (select count(*) from public.inventory_items where id::text like '03990000-%') <> 39 then
    raise exception 'fixture: items (%)', (select count(*) from public.inventory_items where id::text like '03990000-%');
  end if;
  if (select count(*) from public.user_profiles where id::text like '03990000-%' and disabled_at is not null) <> 1 then
    raise exception 'fixture: disabled member';
  end if;
end $$;

-- ═══ G. Grants and shape ══════════════════════════════════════════════════
select is(
  (select c.relrowsecurity::text || '|' || c.relforcerowsecurity::text from pg_class c where c.oid = 'public.item_grouping_requests'::regclass)
  || '|' || (select string_agg(r.r || '=' || coalesce((select string_agg(p.p, ',' order by p.p)
                                                    from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p(p)
                                                   where has_table_privilege(r.r, 'public.item_grouping_requests', p.p)), '-'), ' ' order by r.r)
               from unnest(array['anon', 'authenticated', 'service_role']) r(r))
  || '|' || (select count(*) from pg_class c, aclexplode(c.relacl) a where c.oid = 'public.item_grouping_requests'::regclass and a.grantee = 0)::text
  || '|' || (select count(*) from pg_policy pol where pol.polrelid = 'public.item_grouping_requests'::regclass)::text,
  'true|false|anon=- authenticated=- service_role=-|0|0',
  'G1: item_grouping_requests has RLS on, no policy, and no privilege for anon, authenticated, service_role or PUBLIC');
select is(
  (select string_agg(pg_get_constraintdef(c.oid), E'\n' order by pg_get_constraintdef(c.oid))
     from pg_constraint c where c.conrelid = 'public.item_grouping_requests'::regclass),
  E'CHECK ((action = ANY (ARRAY[''group''::text, ''remove''::text, ''rename''::text, ''split_sku''::text])))\n'
  'CHECK ((jsonb_typeof(outcome) = ''object''::text))\n'
  'CHECK ((request_hash ~ ''^[0-9a-f]{32}$''::text))\n'
  'FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE\n'
  'FOREIGN KEY (user_id) REFERENCES user_profiles(id) ON DELETE CASCADE\n'
  'PRIMARY KEY (organization_id, user_id, key)',
  'G2: the action check admits every grouping action (G2 only adds rows); the organization and the person''s account cascade; one row per (org, user, key)');
select is(
  (select string_agg(p.proname || '=' || p.prosecdef || '/' || p.provolatile::text || '/' || coalesce(array_to_string(p.proconfig, ';'), '')
                     || '/' || has_function_privilege('authenticated', p.oid, 'EXECUTE')
                     || '/' || has_function_privilege('anon', p.oid, 'EXECUTE')
                     || '/' || has_function_privilege('service_role', p.oid, 'EXECUTE')
                     || '/' || pg_get_userbyid(p.proowner), E'\n' order by p.proname)
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and (p.proname like '\_item\_grouping\_%' or p.proname in ('split_item_sku', 'caller_can_write_item'))),
  E'_item_grouping_claim=false/v/search_path=public, pg_temp/false/false/false/postgres\n'
  '_item_grouping_new_sku=false/v/search_path=public, pg_temp/false/false/false/postgres\n'
  '_item_grouping_record=false/v/search_path=public, pg_temp/false/false/false/postgres\n'
  '_item_grouping_split_apply=false/v/search_path=public, pg_temp/false/false/false/postgres\n'
  '_item_grouping_split_request=false/i/search_path=public, pg_temp/false/false/false/postgres\n'
  'caller_can_write_item=true/s/search_path=public/true/false/false/postgres\n'
  'split_item_sku=true/v/search_path=public, pg_temp;lock_timeout=5s/true/false/false/postgres',
  'G3: only the entry point and caller_can_write_item are SECURITY DEFINER and executable (by authenticated alone); the private steps run as their owner with no API EXECUTE; every one pins search_path; the entry point carries lock_timeout 5s');
select is(
  (select coalesce(string_agg(p.proname, ',' order by p.proname), '')
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and (p.proname like '\_item\_grouping\_%' or p.proname in ('split_item_sku', 'caller_can_write_item'))
      and (p.prosrc ~* $re$errcode\s*=\s*'(40001|40p01|serialization_failure|deadlock_detected)'$re$
           or p.prosrc ~* $re$raise\s+(exception\s+)?(serialization_failure|deadlock_detected)\M$re$
           or regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\mexecute\M'
           or (p.prosecdef and p.prosrc !~* '(auth\.uid|has_org_role|has_permission|is_org_member)'))),
  '',
  'G4: no grouping function raises 40001/40P01 (0367), none runs dynamic SQL, and every DEFINER one gates in its own body (INV-25)');
select is(
  (select (p.prosrc ~ 'for update nowait')::text || '/' || (p.prosrc ~* 'exception when lock_not_available')::text
          || '/' || (p.prosrc !~* 'for update(?! nowait)')::text
     from pg_proc p where p.oid = 'public._item_grouping_split_apply(uuid,uuid,jsonb,uuid,text,text)'::regprocedure),
  'true/true/true',
  'G5: the split takes its row locks only with FOR UPDATE NOWAIT and answers a held row as busy: it never waits on an item row (design 3.2)');

-- ═══ S. The owner's case ══════════════════════════════════════════════════
insert into ans select 's1', pg_temp.split(:mgr, pg_temp.req(:mgr, array[:pa2]::uuid[]), pg_temp.k(1));
select is(pg_temp.brief((select r from ans where tag = 's1')), '102=false/false',
  'S1: the manager splits one of the two mouse-pad records; it is not kept, and it is not a replay');
select is(
  (select (i.sku ~ '^SP-[0-9A-Z]{5}-[0-9A-Z]{7}$')::text || '/'
          || (i.sku = ((select r from ans where tag = 's1')::jsonb #>> '{items,0,after_sku}'))::text || '/'
          || ((select r from ans where tag = 's1')::jsonb #>> '{items,0,before_sku}') || '/'
          || (select count(*) from public.inventory_items x where x.sku = i.sku)::text || '/'
          || (select sku from public.inventory_items where id = :pa1) || '/'
          || (select sku from public.inventory_items where id = :bp)
     from public.inventory_items i where i.id = :pa2),
  'true/true/X0399-PAIR/1/X0399-PAIR/X0399-PAIR',
  'S2: the split record has a fresh SKU in generateSku''s shape that no other row carries; the answer names it and the SKU it left; the other record and the other organization''s row keep X0399-PAIR');
select is(
  (select jsonb_object_keys_sorted from (
     select string_agg(k, ',' order by k) as jsonb_object_keys_sorted
       from jsonb_object_keys((select r from ans where tag = 's1')::jsonb) k) z)
  || '|' || (select string_agg(k, ',' order by k)
               from jsonb_object_keys((select r from ans where tag = 's1')::jsonb #> '{items,0}') k),
  'action,items,replay|after_sku,anchor_item_id,before_sku,id,kept',
  'S3: the answer is exactly {action, items, replay}, each item {id, before_sku, after_sku, kept, anchor_item_id}');
select is(
  (select count(*)::text || '|' || string_agg(
            a.user_id::text || '/' || (a.metadata->>'entity_type') || '/' || (a.metadata->>'entity_id') || '/'
            || (a.metadata->>'warehouse_id') || '/' || (a.metadata#>>'{before,sku}') || '/'
            || ((a.metadata#>>'{after,sku}') = (select sku from public.inventory_items where id = :pa2))::text || '/'
            || (a.metadata->>'left_sku') || '/' || coalesce(a.metadata->>'anchor_item_id', 'null') || '/'
            || (a.metadata->>'barcode_kept') || '/' || (a.metadata->'changed_keys')::text || '/'
            || (a.metadata->>'request_key') || '/' || (a.metadata->>'request_hash' ~ '^[0-9a-f]{32}$')::text || '/'
            || (a.metadata->>'surface') || '/' || (a.metadata->>'source') || '/' || coalesce(a.metadata->>'reason', 'null')
            || '/' || coalesce(a.ip::text, 'null') || '/' || coalesce(a.user_agent, 'null'), ',')
     from public.audit_logs a
    where a.organization_id = :orgA and a.event = 'inventory.item.ungrouped'),
  '1|' || '03990000-0000-0000-0000-0000000000a1/inventory_item/03990000-0000-0000-0000-000000000102/'
  || '03990000-0000-0000-0000-0000000000d1/X0399-PAIR/true/X0399-PAIR/null/false/["sku"]/'
  || '03999000-0000-4000-8000-000000000001/true/web/split_item_sku/null/null/null',
  'S4: one inventory.item.ungrouped row for the split record, as the manager: before/after SKU, left_sku, anchor null (not every record was selected), barcode_kept, changed_keys, the key, the hash, the surface; no ip or user agent (written in SQL, design R9)');
select is(
  (select (a.j - 'sku' - 'updated_by' - 'updated_at' - 'search_vector') = (b.j - 'sku' - 'updated_by' - 'updated_at' - 'search_vector')
          and (a.j->>'updated_by') = '03990000-0000-0000-0000-0000000000a1'
          and (a.j->>'search_vector') is distinct from (b.j->>'search_vector')
     from pg_temp.fp_full(:orgA) a join before_items b on b.id = a.id where a.id = :pa2)::text
  || '/' || (select a.j = b.j from pg_temp.fp_full(:orgA) a join before_items b on b.id = a.id where a.id = :pa1)::text,
  'true/true',
  'S5: on the split record only sku, updated_by (the caller), updated_at and the search vector changed: name, barcode, cost, category, charter, rack and stock are as they were; the record that kept the SKU is byte-identical');
select is(
  (select count(*)::text || '/' || string_agg(r.action || '/' || (r.request_hash ~ '^[0-9a-f]{32}$')::text || '/'
                                              || (r.outcome ? 'replay')::text || '/' || (r.outcome->>'action'), ',')
     from public.item_grouping_requests r where r.organization_id = :orgA and r.user_id = :mgr and r.key = pg_temp.k(1)::uuid),
  '1/split_sku/true/false/split_sku',
  'S6: one request row under the key: the action, the hash and the outcome as answered (without the replay flag)');

-- ═══ I. Idempotency ═══════════════════════════════════════════════════════
-- The resend carries the SKU the caller SAW (X0399-PAIR), as a lost answer's
-- retry does.
insert into ans select 'i1', pg_temp.split(:mgr, pg_temp.req(:mgr, array[:pa2]::uuid[], null, :orgA,
                                                              jsonb_build_object(:pa2::text, 'X0399-PAIR')), pg_temp.k(1));
select is(
  pg_temp.brief((select r from ans where tag = 'i1')) || '/'
  || (((select r from ans where tag = 'i1')::jsonb - 'replay') = ((select r from ans where tag = 's1')::jsonb - 'replay'))::text || '/'
  || (select count(*) from public.audit_logs where organization_id = :orgA and event = 'inventory.item.ungrouped')::text || '/'
  || (select count(*) from public.item_grouping_requests where organization_id = :orgA)::text,
  '102=false/true/true/1/1',
  'I1: the same key and body replays the first answer (replay true), after the SKU changed: no new audit row, no new request row, no second SKU');
select is(
  pg_temp.brief(pg_temp.split(:mgr, pg_temp.req(:mgr, array[:pa1]::uuid[]), pg_temp.k(1))),
  'P0001:idempotency_conflict',
  'I2: another body under a spent key is idempotency_conflict, and nothing is written');
select is(
  pg_temp.brief(pg_temp.split(:mgr, pg_temp.req(:mgr, array[:pa1]::uuid[]), pg_temp.k(2))),
  'P0001:not_shared',
  'I3: a new key on the record left alone is not_shared: the pair is already split');

-- ═══ A. Every record of a SKU selected ════════════════════════════════════
insert into ans select 'a1', pg_temp.split(:mgr, pg_temp.req(:mgr, array[:n1, :n2, :n3]::uuid[], array[:n3]::uuid[]), pg_temp.k(10));
select is(pg_temp.brief((select r from ans where tag = 'a1')), '141=false,142=false,143=true/false',
  'A1: all three selected with n3 as the anchor: n3 keeps the SKU, n1 and n2 get fresh SKUs');
select is(
  (select string_agg(right(i.id::text, 3) || '=' || (i.sku = 'X0399-ANCH')::text || '/' || i.barcode, ',' order by i.id)
     from public.inventory_items i where i.id in (:n1, :n2, :n3))
  || '|' || (select count(distinct sku)::text from public.inventory_items where id in (:n1, :n2, :n3))
  || '|' || (select string_agg((a.metadata->>'anchor_item_id') || '/' || (a.metadata->>'barcode_kept'), ',' order by a.metadata->>'entity_id')
               from public.audit_logs a where a.organization_id = :orgA and a.event = 'inventory.item.ungrouped'
                and a.metadata->>'entity_id' in (:n1::text, :n2::text)),
  '141=false/9780000000001,142=false/9780000000001,143=true/9780000000001|3'
  || '|03990000-0000-0000-0000-000000000143/true,03990000-0000-0000-0000-000000000143/true',
  'A2: three distinct SKUs now; every record keeps its barcode/ISBN (owner decision 2); the audit names the anchor and barcode_kept');
insert into ans select 'a3', pg_temp.split(:mgr, pg_temp.req(:mgr, array[:o1, :o2]::uuid[]), pg_temp.k(11));
select is(pg_temp.brief((select r from ans where tag = 'a3')) || '/' || (select sku from public.inventory_items where id = :o1),
  '151=false,152=true/false/X0399-OLD',
  'A3: every record selected and no anchor: the OLDEST by created_at (o1, whose id sorts last) keeps the SKU');
select is(
  pg_temp.brief(pg_temp.split(:mgr, pg_temp.req(:mgr, array[:s1]::uuid[], array[:s1]::uuid[]), pg_temp.k(12)))
  || '|' || (select string_agg(sku, ',' order by id) from public.inventory_items where id in (:s1, :s2, :s3)),
  'P0001:sku_siblings_changed|X0399-SIB,X0399-SIB,X0399-SIB',
  'A4: an anchor named for a SKU that still has unselected readable records is sku_siblings_changed (never silently ignored), and nothing changes');

-- ═══ H. Hidden siblings never change the answer ═══════════════════════════
select is(
  pg_temp.brief(pg_temp.split(:stf, pg_temp.req(:stf, array[:t1]::uuid[]), pg_temp.k(20)))
  || '|' || (select string_agg(sku, ',' order by id) from public.inventory_items where id in (:t1, :t2, :t3)),
  'P0001:not_shared|X0399-TRIO,X0399-TRIO,X0399-TRIO',
  'H1: staff who reads only the no-charter record of a three-charter SKU gets not_shared, as if the other two did not exist');
insert into ans select 'h2', pg_temp.split(:stfCh, pg_temp.req(:stfCh, array[:q1, :q2]::uuid[]), pg_temp.k(21));
insert into ans select 'h3', pg_temp.split(:stfCh, pg_temp.req(:stfCh, array[:c1, :c2]::uuid[]), pg_temp.k(22));
select is(
  pg_temp.brief((select r from ans where tag = 'h2')) || '|' || pg_temp.brief((select r from ans where tag = 'h3'))
  || '|' || (select sku from public.inventory_items where id = :q3),
  '121=true,122=false/false|131=true,132=false/false|X0399-QUAD',
  'H2: charter staff selecting the two records they can read gets the same answer with a hidden third record (QUAD) as without one (CTRL): the oldest visible keeps the SKU; the hidden record is untouched');
select is(
  pg_temp.brief(pg_temp.split(:stfCh, pg_temp.req(:stfCh, array[:t3]::uuid[]), pg_temp.k(23))) || '|'
  || pg_temp.ids_of(pg_temp.split(:stfCh, pg_temp.req(:stfCh, array[:t3]::uuid[]), pg_temp.k(23))) || '|'
  || pg_temp.brief(pg_temp.split(:stfCh, pg_temp.req(:stfCh, array[:gone]::uuid[], null, :orgA,
                                                      jsonb_build_object(:gone::text, 'X0399-TRIO')), pg_temp.k(24))),
  'P0002:item_not_found|113|P0002:item_not_found',
  'H3: a record charter staff cannot read is item_not_found naming only the id sent, the same answer as an id that does not exist');
insert into ans select 'h4', pg_temp.split(:stfCh, pg_temp.req(:stfCh, array[:h2]::uuid[]), pg_temp.k(25));
select is(pg_temp.brief((select r from ans where tag = 'h4')) || '|' || (select sku from public.inventory_items where id = :h1),
  '192=false/false|X0399-CHART',
  'H4: two records of one SKU in the SAME charter on two racks: charter staff splits one; the other keeps the SKU');

-- ═══ R. Refusals ══════════════════════════════════════════════════════════
select is(pg_temp.brief(pg_temp.split(:mgr, pg_temp.req(:mgr, array[:solo]::uuid[]), pg_temp.k(30))),
  'P0001:not_shared', 'R1: a record alone on its SKU is not_shared');
select is(pg_temp.brief(pg_temp.split(:mgr, pg_temp.req(:mgr, array[:dl]::uuid[]), pg_temp.k(31))),
  'P0001:not_shared', 'R2: a deleted record with the same SKU is not a sibling: not_shared');
select is(pg_temp.brief(pg_temp.split(:mgr, pg_temp.req(:mgr, array[:x1]::uuid[]), pg_temp.k(32))),
  'P0001:not_shared', 'R3: another organization''s row with the same SKU is not a sibling: not_shared');
select is(pg_temp.brief(pg_temp.split(:mgr, pg_temp.req(:mgr, array[:f1]::uuid[]), pg_temp.k(33))),
  'P0001:family_member_sku', 'R4: a product-family member (group_id set) is family_member_sku');
select is(
  (select split_part(r, ':', 2) || ':' || split_part(r, ':', 3) || '|'
          || (substr(r, length('ERR:P0001:not_groupable:') + 1)::jsonb->>'reason')
     from (select pg_temp.split(:mgr, pg_temp.req(:mgr, array[:k1]::uuid[]), pg_temp.k(34)) as r) z),
  'P0001:not_groupable|kit', 'R5: a kit is not_groupable with reason kit (owner decision 4)');
select is(
  pg_temp.brief(pg_temp.split(:mgr, pg_temp.req(:mgr, array[:m1]::uuid[], null, :orgA,
                                                 jsonb_build_object(:m1::text, 'X0399-WAS')), pg_temp.k(35)))
  || '|' || (select sku from public.inventory_items where id = :m1),
  'P0001:item_changed|X0399-MOVED',
  'R6: a SKU that is not the one the caller saw is item_changed, and nothing changes');
select is(
  pg_temp.brief(pg_temp.split(:mgr, pg_temp.req(:mgr, array[:dd]::uuid[]), pg_temp.k(36))) || '|'
  || pg_temp.brief(pg_temp.split(:mgr, pg_temp.req(:mgr, array[:bp]::uuid[]), pg_temp.k(37))),
  'P0002:item_not_found|P0002:item_not_found',
  'R7: a deleted record and another organization''s record are item_not_found');
-- Every shape case: 22023 grouping_invalid with its field.
select is(
  (select string_agg(c.tag || '=' || split_part(c.r, ':', 2) || ':' || split_part(c.r, ':', 3) || ':' || split_part(c.r, ':', 4), ',' order by c.tag)
     from (values
       ('a_action',   pg_temp.split(:mgr, pg_temp.req(:mgr, array[:m1]::uuid[]) || '{"action":"group"}', pg_temp.k(40))),
       ('b_surface',  pg_temp.split(:mgr, pg_temp.req(:mgr, array[:m1]::uuid[]) || '{"surface":"fax"}', pg_temp.k(40))),
       ('c_empty',    pg_temp.split(:mgr, pg_temp.req(:mgr, array[]::uuid[]), pg_temp.k(40))),
       ('d_dup',      pg_temp.split(:mgr, pg_temp.req(:mgr, array[:m1]::uuid[]) || jsonb_build_object('item_ids', jsonb_build_array(:m1, upper(:m1::text))), pg_temp.k(40))),
       ('e_notuuid',  pg_temp.split(:mgr, pg_temp.req(:mgr, array[:m1]::uuid[]) || '{"item_ids":["nope"]}', pg_temp.k(40))),
       ('f_many',     pg_temp.split(:mgr, pg_temp.req(:mgr, array(select gen_random_uuid() from generate_series(1, 101)))
                                           || '{"expected_skus":{}}', pg_temp.k(40))),
       ('g_expmiss',  pg_temp.split(:mgr, pg_temp.req(:mgr, array[:m1, :m2]::uuid[]) || jsonb_build_object('expected_skus', jsonb_build_object(:m1::text, 'X0399-MOVED')), pg_temp.k(40))),
       ('h_expblank', pg_temp.split(:mgr, pg_temp.req(:mgr, array[:m1]::uuid[], null, :orgA, jsonb_build_object(:m1::text, '  ')), pg_temp.k(40))),
       ('i_expextra', pg_temp.split(:mgr, pg_temp.req(:mgr, array[:m1]::uuid[], null, :orgA, jsonb_build_object(:m1::text, 'X0399-MOVED', :m2::text, 'X0399-MOVED')), pg_temp.k(40))),
       ('j_ancnot',   pg_temp.split(:mgr, pg_temp.req(:mgr, array[:m1]::uuid[], array[:m2]::uuid[]), pg_temp.k(40))),
       ('k_anctwo',   pg_temp.split(:mgr, pg_temp.req(:mgr, array[:m1, :m2]::uuid[], array[:m1, :m2]::uuid[]), pg_temp.k(40))),
       ('l_expnum',   pg_temp.split(:mgr, pg_temp.req(:mgr, array[:m1]::uuid[], null, :orgA, jsonb_build_object(:m1::text, 7)), pg_temp.k(40)))
     ) c(tag, r)),
  'a_action=22023:grouping_invalid:action,b_surface=22023:grouping_invalid:surface,c_empty=22023:grouping_invalid:item_ids,'
  'd_dup=22023:grouping_invalid:item_ids,e_notuuid=22023:grouping_invalid:item_ids,f_many=22023:grouping_invalid:item_ids,'
  'g_expmiss=22023:grouping_invalid:expected_skus,h_expblank=22023:grouping_invalid:expected_skus,'
  'i_expextra=22023:grouping_invalid:expected_skus,j_ancnot=22023:grouping_invalid:anchor_item_ids,'
  'k_anctwo=22023:grouping_invalid:anchor_item_ids,l_expnum=22023:grouping_invalid:expected_skus',
  'R8: every shape case is 22023 grouping_invalid naming its field (two anchors on one SKU included)');
select is(
  pg_temp.brief(pg_temp.split(:mgr, pg_temp.req(:mgr, array[:m1]::uuid[]), null)) || '|'
  || pg_temp.brief(pg_temp.split(:mgr, pg_temp.req(:mgr, array[:m1]::uuid[]), '  ')) || '|'
  || pg_temp.brief(pg_temp.split(:mgr, pg_temp.req(:mgr, array[:m1]::uuid[]), 'not-a-key')),
  '22023:idempotency_key_required|22023:idempotency_key_required|22023:idempotency_key_invalid',
  'R9: a missing or blank key is idempotency_key_required, a malformed one idempotency_key_invalid');
select is(
  (select count(*) from public.item_grouping_requests where organization_id = :orgA)::text || '/'
  || (select count(*) from public.audit_logs where organization_id = :orgA and event = 'inventory.item.ungrouped')::text,
  '6/7',
  'R10: refusals record nothing: six applied requests (S1, A1, A3, H2 QUAD, H2 CTRL, H4) and seven audit rows (pa2; n1, n2; o2; q2; c2; h2)');

-- ═══ P. Permission ════════════════════════════════════════════════════════
select is(
  (select string_agg(c.tag || '=' || pg_temp.brief(c.r), ',' order by c.tag)
     from (values
       ('a_vwr',     pg_temp.split(:vwr,   pg_temp.req(:vwr,   array[:s2]::uuid[]), pg_temp.k(50))),
       ('b_stfNo',   pg_temp.split(:stfNo, pg_temp.req(:stfNo, array[:s2]::uuid[]), pg_temp.k(51))),
       ('c_vwrUp',   pg_temp.split(:vwrUp, pg_temp.req(:vwrUp, array[:s2]::uuid[]), pg_temp.k(52))),
       ('d_actor',   pg_temp.split(:stf,   pg_temp.req(:mgr,   array[:s2]::uuid[]), pg_temp.k(53))),
       ('e_signout', pg_temp.split(null,   pg_temp.req(:mgr,   array[:s2]::uuid[]), pg_temp.k(54))),
       ('f_nobody',  pg_temp.split(:nobody, pg_temp.req(:nobody, array[:s2]::uuid[]), pg_temp.k(55))),
       ('g_dis',     pg_temp.split(:dis,   pg_temp.req(:dis,   array[:s2]::uuid[]), pg_temp.k(56))),
       ('h_mgrB',    pg_temp.split(:mgrB,  pg_temp.req(:mgrB,  array[:s2]::uuid[]), pg_temp.k(57))),
       ('i_mgrBown', pg_temp.split(:mgrB,  pg_temp.req(:mgrB,  array[:s2]::uuid[], null, :orgB), pg_temp.k(58)))
     ) c(tag, r)),
  'a_vwr=42501:permission,b_stfNo=42501:permission,c_vwrUp=42501:item_not_writable,d_actor=42501:actor_mismatch,'
  'e_signout=42501:unauthenticated,f_nobody=42501:not_member,g_dis=42501:not_member,h_mgrB=42501:not_member,'
  'i_mgrBown=P0002:item_not_found',
  'P1: viewer and staff whose items:update is revoked are refused (the role floor is not enough, V5); a viewer granted items:update cannot write the warehouse; actor mismatch, signed out, outsider, disabled member and another org''s manager are refused; naming another org''s item from your own is item_not_found');
select is(
  (select string_agg(r.r || '=' || split_part(pg_temp.run(r.r, :mgr, format('select public.split_item_sku(%L::jsonb, %L)::text',
                                                     pg_temp.req(:mgr, array[:s2]::uuid[]), pg_temp.k(59))), ':', 2), ',' order by r.r)
     from unnest(array['anon', 'service_role']) r(r)),
  'anon=42501,service_role=42501',
  'P2: anon and service_role hold no EXECUTE on split_item_sku');
select is(
  (select string_agg(sku, ',' order by id) from public.inventory_items where id in (:s1, :s2, :s3)),
  'X0399-SIB,X0399-SIB,X0399-SIB',
  'P3: every refused caller left the records as they were');

-- ═══ K. caller_can_write_item keeps step with RLS ═════════════════════════
select is(
  (select string_agg(c.tag || '=' || c.rls::text || '/'
                     || pg_temp.run('authenticated', c.sub, format('select public.caller_can_write_item(%L)::text', c.item)), ',' order by c.tag)
     from (values
       ('a_mgr',   :mgr::uuid,   :s3::uuid, pg_temp.rls_updates(:mgr, :s3)),
       ('b_stf',   :stf::uuid,   :s3::uuid, pg_temp.rls_updates(:stf, :s3)),
       ('c_stfCh', :stfCh::uuid, :t2::uuid, pg_temp.rls_updates(:stfCh, :t2)),
       ('d_stfT3', :stfCh::uuid, :t3::uuid, pg_temp.rls_updates(:stfCh, :t3)),
       ('e_vwrUp', :vwrUp::uuid, :s3::uuid, pg_temp.rls_updates(:vwrUp, :s3)),
       ('f_stfNo', :stfNo::uuid, :s3::uuid, pg_temp.rls_updates(:stfNo, :s3)),
       ('g_mgrB',  :mgrB::uuid,  :s3::uuid, pg_temp.rls_updates(:mgrB, :s3)),
       ('h_del',   :mgr::uuid,   :dd::uuid, pg_temp.rls_updates(:mgr, :dd))
     ) c(tag, sub, item, rls)),
  'a_mgr=1/true,b_stf=1/true,c_stfCh=1/true,d_stfT3=0/false,e_vwrUp=0/false,f_stfNo=1/false,g_mgrB=0/false,h_del=1/false',
  'K1: caller_can_write_item answers as a real RLS update does for every persona, except where it is stricter on purpose: staff whose items:update is revoked (the policy''s role floor lets them through, V5) and a deleted record');

-- ═══ F. Failure injection: nothing half-written ═══════════════════════════
create function public._zz0399_probe_audit() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.event = 'inventory.item.ungrouped' and new.metadata->>'entity_id' like '03990000-0000-0000-0000-00000000018%' then
    raise exception 'probe: audit' using errcode = 'P0001', hint = 'probe_audit';
  end if;
  return new;
end $$;
create trigger trg_aa_0399_probe_audit before insert on public.audit_logs
  for each row execute function public._zz0399_probe_audit();
select is(
  pg_temp.brief(pg_temp.split(:mgr, pg_temp.req(:mgr, array[:j2]::uuid[]), pg_temp.k(60)))
  || '|' || (select sku from public.inventory_items where id = :j2)
  || '|' || (select count(*) from public.item_grouping_requests where key = pg_temp.k(60)::uuid)::text,
  'P0001:probe_audit|X0399-INJ1|0',
  'F1: a failure on the audit insert rolls the whole split back: the SKU, and no request row');
drop trigger trg_aa_0399_probe_audit on public.audit_logs;
drop function public._zz0399_probe_audit();

create function public._zz0399_probe_request() returns trigger language plpgsql security definer set search_path = public as $$
begin
  raise exception 'probe: request' using errcode = 'P0001', hint = 'probe_request';
end $$;
create trigger trg_aa_0399_probe_request before insert on public.item_grouping_requests
  for each row execute function public._zz0399_probe_request();
select is(
  pg_temp.brief(pg_temp.split(:mgr, pg_temp.req(:mgr, array[:j4]::uuid[]), pg_temp.k(61)))
  || '|' || (select sku from public.inventory_items where id = :j4)
  || '|' || (select count(*) from public.audit_logs where event = 'inventory.item.ungrouped' and metadata->>'entity_id' = :j4::text)::text,
  'P0001:probe_request|X0399-INJ2|0',
  'F2: a failure on the request insert rolls the split and its audit row back');
drop trigger trg_aa_0399_probe_request on public.item_grouping_requests;
drop function public._zz0399_probe_request();

create function public._zz0399_probe_sku() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.id = '03990000-0000-0000-0000-000000000187' and new.sku is distinct from old.sku then
    raise exception 'probe: second sku' using errcode = 'P0001', hint = 'probe_sku';
  end if;
  return new;
end $$;
create trigger trg_aa_0399_probe_sku before update on public.inventory_items
  for each row execute function public._zz0399_probe_sku();
select is(
  pg_temp.brief(pg_temp.split(:mgr, pg_temp.req(:mgr, array[:j6, :j7]::uuid[]), pg_temp.k(62)))
  || '|' || (select string_agg(sku, ',' order by id) from public.inventory_items where id in (:j5, :j6, :j7)),
  'P0001:probe_sku|X0399-INJ3,X0399-INJ3,X0399-INJ3',
  'F3: a failure on the 2nd SKU update leaves the 1st unwritten too: one statement, all or nothing');
drop trigger trg_aa_0399_probe_sku on public.inventory_items;
drop function public._zz0399_probe_sku();
select is(
  pg_temp.brief(pg_temp.split(:mgr, pg_temp.req(:mgr, array[:j6, :j7]::uuid[]), pg_temp.k(62))),
  '186=false,187=false/false',
  'F4: with the probe gone the same key applies (a rolled-back call recorded nothing under it)');

-- ═══ Z. The helper, 0234, stock, and everything else ══════════════════════
select is(
  (select (cardinality(s) = 100)::text || '/' || (select count(distinct x) = 100 from unnest(s) x)::text || '/'
          || (select bool_and(x ~ '^SP-[0-9A-Z]{5}-[0-9A-Z]{7}$') from unnest(s) x)::text || '/'
          || (not exists (select 1 from public.inventory_items i, unnest(s) x where i.sku = x))::text
     from (select public._item_grouping_new_sku(:orgA, 100) as s) z),
  'true/true/true/true',
  'Z1: the helper answers 100 distinct fresh SKUs in generateSku''s shape that no row carries');
select is(
  (select pg_temp.run('postgres', null, format('select array_length(public._item_grouping_new_sku(%L, %s), 1)::text', :orgA, c.n))
     from (values (0)) c(n))
  || '|' || pg_temp.run('postgres', null, format('select array_length(public._item_grouping_new_sku(%L, 101), 1)::text', :orgA))
  || '|' || pg_temp.run('postgres', null, 'select array_length(public._item_grouping_new_sku(null, 1), 1)::text'),
  'ERR:22023:grouping_invalid:count|ERR:22023:grouping_invalid:count|ERR:22023:grouping_invalid:count',
  'Z2: the helper refuses a count outside 1 to 100 and a missing organization');
select is(
  (select (regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~ 'i\.organization_id = p_org\s+and i\.sku = any \(v_cand\)')::text || '/'
          || (regexp_replace(p.prosrc, '--[^\n]*', '', 'g') !~* 'deleted_at')::text || '/'
          || (p.prosrc ~ 'v_round > 5')::text
     from pg_proc p where p.oid = 'public._item_grouping_new_sku(uuid,integer)'::regprocedure),
  'true/true/true',
  'Z3: the uniqueness probe reads every row of the organization, live AND deleted (no deleted_at filter), and the retry is bounded at 5 rounds');
select is(
  (select count(*)::text from (
     select organization_id, sku, charter_id, bin_location from public.inventory_items
      where deleted_at is null and organization_id in (:orgA, :orgB)
      group by 1, 2, 3, 4 having count(*) > 1) d),
  '0',
  'Z4: 0234 holds: no two live rows share (organization, sku, charter, bin)');
select is(
  (select levels = (select md5(coalesce(string_agg(to_jsonb(s)::text, ',' order by s.item_id, s.location_id), ''))
                      from public.item_stock_levels s where s.organization_id in (:orgA, :orgB))
          and movements = (select md5(coalesce(string_agg(to_jsonb(m)::text, ',' order by m.id), ''))
                             from public.stock_movements m where m.organization_id in (:orgA, :orgB))
     from before_stock)::text,
  'true',
  'Z5: no stock movement and no holding was written or changed');
select is(
  (select coalesce(string_agg(right(a.id::text, 3), ',' order by a.id), '')
     from (select * from pg_temp.fp_full(:orgA) union all select * from pg_temp.fp_full(:orgB)) a
     join before_items b on b.id = a.id
    where a.j <> b.j
      and ((a.j - 'sku' - 'updated_by' - 'updated_at' - 'search_vector') <> (b.j - 'sku' - 'updated_by' - 'updated_at' - 'search_vector')
           or (a.j->>'sku') = (b.j->>'sku'))),
  '',
  'Z6: every row that changed at all changed its SKU, and only sku, updated_by, updated_at and the search vector');
select is(
  (select string_agg(right(a.id::text, 3), ',' order by a.id)
     from pg_temp.fp_full(:orgA) a join before_items b on b.id = a.id where (a.j->>'sku') <> (b.j->>'sku')),
  '102,122,132,141,142,151,186,187,192',
  'Z7: exactly the records split above have a new SKU');
select is(
  (select count(*)::text from public.audit_logs where organization_id = :orgA and event = 'inventory.item.ungrouped')
  || '/' || (select count(*)::text from public.audit_logs where organization_id = :orgB),
  '9/0',
  'Z8: one audit row per changed record (nine), none for a kept record, none in the other organization');
select is(
  (select string_agg(a.j::text, ',' order by a.id) from pg_temp.fp_full(:orgB) a)
  = (select string_agg(b.j::text, ',' order by b.id) from before_items b where b.id in (:bp, :bx)),
  true,
  'Z9: the other organization''s rows (one with the owner''s-case SKU) are byte-identical');

select * from finish();
rollback;
