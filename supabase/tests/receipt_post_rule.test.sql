-- supabase/tests/receipt_post_rule.test.sql
--
-- Who the database lets post a receipt on a purchase order, for every role and
-- for the permission overrides that could change it: the member's own and the
-- organization-wide override for the member's role.
--
-- post_receipt_v2 (the wrapper, then ledger.post_receipt_v2) admits a caller
-- only when all of these hold:
--   - stock:adjust (the wrapper's has_permission check, 42501 hint permission);
--   - the body's SELECT ... FOR UPDATE of the order: purchase_orders_write's
--     USING (manager, or purchase_orders:manage; the row is filtered
--     otherwise, P0002). That policy is FOR ALL, so it also lets a manager
--     read the order without purchase_orders:read;
--   - manager or above (the body's own has_org_role check, 42501 forbidden),
--     which a grant of purchase_orders:manage does not pass.
-- So: manager, admin or owner, with stock:adjust.
--
-- The app asks the same rule (core canPostReceipt). The case table below is
-- read line by line by apps/web/src/server/services/lib/
-- receipt-post-rule.parity.test.ts, which checks canPostReceipt against
-- every row, so the two cannot drift: change a row here and that test
-- changes with it.
--
-- Each attempt runs inside an undone subtransaction (pg_temp.attempt), so
-- no attempt sees another's receipt. Made-up data only. Wrapped in
-- begin/rollback.

begin;
select plan(22);

\set org  '\'7ece1700-0000-4000-8000-00000000000a\''
\set wh   '\'7ece1700-0000-4000-8000-0000000000c1\''
\set it   '\'7ece1700-0000-4000-8000-0000000000d1\''
\set po   '\'7ece1700-0000-4000-8000-0000000000e1\''
\set ln   '\'7ece1700-0000-4000-8000-0000000000e2\''

-- ══ The case table ════════════════════════════════════════════════════════
-- grants and revokes are the member's own overrides (user_permission_overrides);
-- role_grants and role_revokes are organization-wide overrides for the
-- member's role (role_permission_overrides), written inside that case's
-- undone attempt only, so no other case sees them. All comma separated.
-- posts: the receipt is recorded. answer: 'ok:1', or the refusal's SQLSTATE
-- and hint ('-' for none).
create temp table rule_cases (
  n           int primary key,
  who         text not null,
  role        text not null,
  grants      text not null,
  revokes     text not null,
  role_grants  text not null,
  role_revokes text not null,
  posts       boolean not null,
  answer      text not null
);
-- RULE CASES BEGIN
insert into rule_cases (n, who, role, grants, revokes, role_grants, role_revokes, posts, answer) values
  ( 1, 'owner', 'owner', '', '', '', '', true, 'ok:1'),
  ( 2, 'admin', 'admin', '', '', '', '', true, 'ok:1'),
  ( 3, 'manager', 'manager', '', '', '', '', true, 'ok:1'),
  ( 4, 'staff', 'staff', '', '', '', '', false, 'P0002:-'),
  ( 5, 'viewer', 'viewer', '', '', '', '', false, '42501:permission'),
  ( 6, 'staff granted purchase_orders:manage', 'staff', 'purchase_orders:manage', '', '', '', false, '42501:-'),
  ( 7, 'staff granted purchase_orders:manage without stock:adjust', 'staff', 'purchase_orders:manage', 'stock:adjust', '', '', false, '42501:permission'),
  ( 8, 'viewer granted stock:adjust', 'viewer', 'stock:adjust', '', '', '', false, 'P0002:-'),
  ( 9, 'viewer granted stock:adjust and purchase_orders:manage', 'viewer', 'stock:adjust,purchase_orders:manage', '', '', '', false, '42501:-'),
  (10, 'manager without stock:adjust', 'manager', '', 'stock:adjust', '', '', false, '42501:permission'),
  (11, 'manager without purchase_orders:read', 'manager', '', 'purchase_orders:read', '', '', true, 'ok:1'),
  (12, 'manager without purchase_orders:manage', 'manager', '', 'purchase_orders:manage', '', '', true, 'ok:1'),
  (13, 'admin without stock:adjust', 'admin', '', 'stock:adjust', '', '', false, '42501:permission'),
  (14, 'owner without stock:adjust', 'owner', '', 'stock:adjust', '', '', true, 'ok:1'),
  (15, 'manager whose role has stock:adjust taken away for the organization', 'manager', '', '', '', 'stock:adjust', false, '42501:permission'),
  (16, 'manager whose role lost stock:adjust, given it back as a member', 'manager', 'stock:adjust', '', '', 'stock:adjust', true, 'ok:1'),
  (17, 'staff whose role is granted purchase_orders:manage for the organization', 'staff', '', '', 'purchase_orders:manage', '', false, '42501:-');
-- RULE CASES END

-- ══ Fixtures ══════════════════════════════════════════════════════════════
-- One member per case: 7ece1700-0000-4000-8000-0000000000NN (NN = the case).
create function pg_temp.member(p_n int) returns uuid language sql immutable as $$
  select format('7ece1700-0000-4000-8000-%s', lpad(p_n::text, 12, '0'))::uuid
$$;
insert into auth.users (id, email, raw_user_meta_data)
  select pg_temp.member(n), format('receipt-rule-%s@test.local', n), '{}'::jsonb from rule_cases
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:org, 'Receipt Rule Test Co', 'receipt-rule-test-co');
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  select :org::uuid, pg_temp.member(n), role, now() from rule_cases;
insert into public.user_permission_overrides (organization_id, user_id, permission, granted)
  select :org::uuid, pg_temp.member(c.n), g.p, true
    from rule_cases c, unnest(string_to_array(nullif(c.grants, ''), ',')) as g(p)
  union all
  select :org::uuid, pg_temp.member(c.n), r.p, false
    from rule_cases c, unnest(string_to_array(nullif(c.revokes, ''), ',')) as r(p);
insert into public.warehouses (id, organization_id, name, code, status) values
  (:wh, :org, 'Receipt Rule Main', 'WH-RRT', 'active');
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, is_bundle) values
  (:it, :org, :wh, 'RRT-1', 'Receipt rule part', 0, 'active', 'none', false);
-- No destination: the order is visible to every member who holds
-- purchase_orders:read, so warehouse scope never decides a case here.
insert into public.purchase_orders (id, organization_id, po_number, status) values
  (:po, :org, 'PO-RRT-1', 'ordered');
insert into public.purchase_order_items
  (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost) values
  (:ln, :org, :po, :it, 100, 0, 1);

-- ══ Helpers ═══════════════════════════════════════════════════════════════
-- supautils' generic hint on privilege errors depends on the image: dropped.
create function pg_temp.hint(p_hint text) returns text language sql immutable as $$
  select case when p_hint is null or p_hint = ''
                or p_hint like 'Grant the required privileges to the current role with:%'
              then '-' else p_hint end
$$;
-- One statement as an authenticated p_sub, then ALWAYS undone: 'ok:<rows>',
-- else '<sqlstate>:<hint or ->:<message>'.
-- p_prep runs first, as the superuser, inside the same undone subtransaction.
create function pg_temp.attempt(p_sub uuid, p_sql text, p_prep text default null)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v_n bigint;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    perform set_config('request.jwt.claim.sub', p_sub::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    perform set_config('role', 'authenticated', true);
    execute p_sql;
    get diagnostics v_n = row_count;
    perform set_config('role', 'none', true);
    raise exception using errcode = 'XX404', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  if v_state = 'XX404' then
    return 'ok:' || v_n::text;
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
end $$;
-- One line of the order, 2 accepted, with a key of the case's own.
create function pg_temp.rcpt_sql(p_n int) returns text language sql stable as $$
  select format($q$select (public.post_receipt_v2(%L, %L, jsonb_build_array(jsonb_build_object(
                    'po_line_id', %L, 'qty_received', 2, 'qty_accepted', 2, 'qty_rejected', 0, 'unit_cost', 1)),
                    %L, %L, null)).id$q$,
                '7ece1700-0000-4000-8000-0000000000e1', '7ece1700-0000-4000-8000-0000000000c1',
                '7ece1700-0000-4000-8000-0000000000e2', 'rule-' || p_n, 'rule-hash-' || p_n)
$$;
-- The case's organization-wide overrides for its role, as one statement (or none).
create function pg_temp.role_prep(p_role text, p_grants text, p_revokes text) returns text language sql stable as $$
  select case when p_grants = '' and p_revokes = '' then null else
    'insert into public.role_permission_overrides (organization_id, role, permission, granted) values '
    || (select string_agg(format('(%L, %L, %L, %L)', '7ece1700-0000-4000-8000-00000000000a', p_role, x.p, x.g), ', ')
          from (select g.p, true as g from unnest(string_to_array(nullif(p_grants, ''), ',')) as g(p)
                union all
                select r.p, false from unnest(string_to_array(nullif(p_revokes, ''), ',')) as r(p)) x)
  end
$$;
create temp table results (n int primary key, raw text not null);
insert into results (n, raw)
  select n, pg_temp.attempt(pg_temp.member(n), pg_temp.rcpt_sql(n), pg_temp.role_prep(role, role_grants, role_revokes))
    from rule_cases;

-- ══ T. The table covers the rule ══════════════════════════════════════════
select is(
  (select string_agg(distinct role, ',' order by role) from rule_cases),
  'admin,manager,owner,staff,viewer',
  'T1: the case table has a row for every role');
select is(
  (select count(*)::int from rule_cases
    where role in ('staff', 'viewer')
      and (string_to_array(grants, ',') @> array['purchase_orders:manage']
           or string_to_array(role_grants, ',') @> array['purchase_orders:manage'])),
  4,
  'T2: the case table grants purchase_orders:manage below manager, with and without stock:adjust, to the member and to the role');
select is(
  (select count(*)::int from rule_cases where role_grants <> '' or role_revokes <> ''),
  3,
  'T3: the case table has organization-wide role overrides, a revoke and a grant');
select is(
  (select count(*)::int from public.role_permission_overrides where organization_id = :org),
  0,
  'T4: no organization-wide override outlives its case');

-- ══ R. Each case: the database's answer is the table's ════════════════════
select is(
  split_part(r.raw, ':', 1) || ':' || split_part(r.raw, ':', 2),
  c.answer,
  format('R%s: %s %s', c.n, c.who, case when c.posts then 'posts a receipt' else 'is refused' end))
  from rule_cases c join results r using (n)
  order by c.n;

-- ══ N. Nothing stayed ═════════════════════════════════════════════════════
select is(
  (select count(*)::int from public.receipts where organization_id = :org)
  || '|' || (select quantity_received from public.purchase_order_items where id = :ln)::int
  || '|' || (select quantity_on_hand from public.inventory_items where id = :it)::int,
  '0|0|0',
  'N1: every attempt was undone: no receipt, nothing received, no stock');

select * from finish();
rollback;
