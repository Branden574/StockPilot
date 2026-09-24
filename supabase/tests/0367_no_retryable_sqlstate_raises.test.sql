-- supabase/tests/0367_no_retryable_sqlstate_raises.test.sql
-- Proves migration 0367: no function this project owns raises a SQLSTATE that
-- PostgREST (before v16) retries forever, and the receipt idempotency refusal
-- still says idempotency_conflict, now as 55000.
--
-- 1     CLASS GUARD: no plpgsql/sql function in public or ledger raises 40001
--       (serialization_failure) or 40P01 (deadlock_detected), by code or by
--       condition name. PostgREST re-runs a transaction that fails with 40001
--       without limit, so a deterministic refusal with it never answers and
--       pins a pool connection (0366 po_not_draft, 0013..0365
--       idempotency_conflict). 40P01 is held to the same rule: it is a code
--       Postgres raises for real deadlocks, never one to fake.
-- 2-3   The two rewritten functions raise idempotency_conflict as 55000 and
--       kept their SECURITY INVOKER / search_path properties.
-- 4-7   post_receipt_v2 end to end as a manager: first post lands, the same
--       key and hash replays the same receipt, the same key with an edited
--       line is refused with 55000 'idempotency_conflict' and writes nothing.
--
-- Roles: `set local role` with request.jwt.claim.sub, as the house tests do.

begin;
select plan(7);

\set org   '\'03670000-0000-0000-0000-00000000000a\''
\set mgr   '\'03670000-0000-0000-0000-0000000000a1\''
\set wh    '\'03670000-0000-0000-0000-0000000000b1\''
\set item  '\'03670000-0000-0000-0000-0000000000c1\''
\set po    '\'03670000-0000-0000-0000-0000000000e1\''
\set line  '\'03670000-0000-0000-0000-0000000000f1\''

-- ═══ 1: the class guard ═════════════════════════════════════════════════════
select is(
  (select coalesce(string_agg(n.nspname || '.' || p.proname, ', ' order by 1), '')
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join pg_language l on l.oid = p.prolang
    where n.nspname in ('public', 'ledger')
      and l.lanname in ('plpgsql', 'sql')
      and (p.prosrc ~* $re$errcode\s*=\s*'(40001|40p01|serialization_failure|deadlock_detected)'$re$
           or p.prosrc ~* $re$raise\s+(exception\s+)?(serialization_failure|deadlock_detected)\M$re$
           or p.prosrc ~* $re$raise\s+(exception\s+)?sqlstate\s+'40(001|p01)'$re$)),
  '',
  '1: no function in public or ledger raises 40001/40P01 (PostgREST < 16 retries 40001 forever)');

-- ═══ 2-3: the rewritten functions ══════════════════════════════════════════
select ok(
  (select bool_and(p.prosrc ~ $re$raise exception 'idempotency_conflict' using errcode = '55000'$re$)
     from pg_proc p
    where p.oid in ('ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)'::regprocedure,
                    'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'::regprocedure)),
  '2: post_receipt_v2 and distribute_bundle raise idempotency_conflict as 55000');
select ok(
  (select bool_and(not p.prosecdef and p.proconfig is not null
                   and pg_get_userbyid(p.proowner) = 'postgres')
     from pg_proc p
    where p.oid in ('ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)'::regprocedure,
                    'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'::regprocedure)),
  '3: both are still SECURITY INVOKER with their search_path, owned by postgres');

-- ═══ 4-7: post_receipt_v2 end to end ═══════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data)
  values (:mgr, 'mgr-0367@test.local', '{}'::jsonb) on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values (:org, 'Retry Org 0367', 'retry-org-0367');
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :mgr, 'manager', now());
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'Retry WH 0367', 'R0367', 'active');
insert into public.inventory_items
  (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status, tracking_type)
  values (:item, :org, :wh, 'Retry item 0367', 'R0367-1', 0, 'active', 'none');
insert into public.purchase_orders (id, organization_id, po_number, status)
  values (:po, :org, 'R0367-PO', 'ordered');
insert into public.purchase_order_items
  (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost)
  values (:line, :org, :po, :item, 10, 0, 5);

create temp table posted (tag text primary key, receipt_id uuid) on commit drop;
grant all on posted to authenticated;

set local "request.jwt.claim.sub" to :mgr;
set local role to 'authenticated';
select lives_ok(
  format($$insert into posted
           select 'first', (public.post_receipt_v2(%L, %L,
             '[{"po_line_id": "03670000-0000-0000-0000-0000000000f1", "qty_received": 2, "qty_accepted": 2, "qty_rejected": 0, "unit_cost": 5}]'::jsonb,
             'key-0367', 'hash-A')).id$$, :po, :wh),
  '4: the first post lands');
select lives_ok(
  format($$insert into posted
           select 'replay', (public.post_receipt_v2(%L, %L,
             '[{"po_line_id": "03670000-0000-0000-0000-0000000000f1", "qty_received": 2, "qty_accepted": 2, "qty_rejected": 0, "unit_cost": 5}]'::jsonb,
             'key-0367', 'hash-A')).id$$, :po, :wh),
  '5: the same key and request replays');
select throws_ok(
  format($$select public.post_receipt_v2(%L, %L,
             '[{"po_line_id": "03670000-0000-0000-0000-0000000000f1", "qty_received": 3, "qty_accepted": 3, "qty_rejected": 0, "unit_cost": 5}]'::jsonb,
             'key-0367', 'hash-B')$$, :po, :wh),
  '55000', 'idempotency_conflict',
  '6: the same key with an edited line is refused as 55000 idempotency_conflict (was 40001: PostgREST never answered)');
reset role;
select is(
  (select (select count(distinct receipt_id) from posted)::text
          || '|' || (select count(*) from public.receipts where purchase_order_id = :po)::text
          || '|' || (select trim_scale(quantity_received)::text from public.purchase_order_items where id = :line)
          || '|' || (select trim_scale(quantity_on_hand)::text from public.inventory_items where id = :item)),
  '1|1|2|2',
  '7: one receipt, replayed once, and the refused edit wrote nothing');

select * from finish();
rollback;
