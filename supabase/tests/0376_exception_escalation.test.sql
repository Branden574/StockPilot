-- supabase/tests/0376_exception_escalation.test.sql
-- pgTAP proof for migration 0376 (F1-5: escalate an exception occurrence to a
-- maintenance request). "Mutation: X" names a deliberate break of the code
-- that the preceding assertion catches (scripts: stockpilot-work/f1-5/
-- mutate-0376.py applies each one and re-runs this file).
--
-- S. Structure: seven nullable columns with no default; the three foreign
--    keys are ON DELETE SET NULL; the CHECKs hold; the partial index exists;
--    claim and finish are SECURITY DEFINER, search_path and lock_timeout
--    pinned, executable by authenticated and not anon; the gate helper is
--    executable by no client role; no retryable SQLSTATE; ONE gate (both call
--    _exc_escalation_refusal and neither restates it); authenticated still
--    cannot write the occurrence table directly; the 0362 guard is still on
--    maintenance_requests.
-- C. exception_escalation_claim: signed out 42501; another org, another
--    warehouse's holding and a disabled account P0002 (visibility in the
--    body); module off 42501 module_disabled; submit revoked 42501
--    not_permitted; a viewer (who holds submit by default) may claim; a
--    resolved occurrence occurrence_resolved; a claim stamps the caller and
--    the time; a second claim within 2 minutes is refused (anyone's claim,
--    the caller's own included); an expired claim is free; an occurrence
--    linked to a request that is not cancelled answers {linked, id, number}
--    and claims nothing; once that request is cancelled a new claim is
--    allowed.
-- F. exception_escalation_finish: release clears only the caller's own
--    claim (not_held otherwise, never an error, never "not found"); link
--    refuses another user's request, a different item, a stale request (over
--    5 minutes), a cancelled request, another org's request, a request
--    linked elsewhere, a caller who does not hold the claim, a resolved
--    occurrence and a disabled module; the link copies the number and the
--    created_at, stamps who and when, clears the claim, writes exactly one
--    escalated event and never acknowledges or resolves; a replay returns the
--    same link with no second event; a re-escalation after a cancel replaces
--    the link; a request made through the real API path (0362 guard) links.
--
-- Roles: fixtures as the test superuser; claims and finishes as
-- `authenticated` with request.jwt.claim.sub. begin/rollback: nothing leaks.
-- Namespace 03760000.

begin;

select plan(77);

\set orgA    03760000-0000-0000-0000-00000000000a
\set orgB    03760000-0000-0000-0000-00000000000b
\set orgC    03760000-0000-0000-0000-00000000000c
\set mgr     03760000-0000-0000-0000-0000000000a1
\set stf     03760000-0000-0000-0000-0000000000a2
\set stf2    03760000-0000-0000-0000-0000000000a3
\set vwr     03760000-0000-0000-0000-0000000000a4
\set noSub   03760000-0000-0000-0000-0000000000a5
\set stfW2   03760000-0000-0000-0000-0000000000a6
\set dis     03760000-0000-0000-0000-0000000000a7
\set mgrB    03760000-0000-0000-0000-0000000000b1
\set mgrC    03760000-0000-0000-0000-0000000000c1
\set whA     03760000-0000-0000-0000-0000000000d1
\set whA2    03760000-0000-0000-0000-0000000000d2
\set whB     03760000-0000-0000-0000-0000000000d3
\set whC     03760000-0000-0000-0000-0000000000d4
\set locA    03760000-0000-0000-0000-0000000000e1
\set i1      03760000-0000-0000-0000-000000000f01
\set i2      03760000-0000-0000-0000-000000000f02
\set i3      03760000-0000-0000-0000-000000000f03
\set i4      03760000-0000-0000-0000-000000000f04
\set i5      03760000-0000-0000-0000-000000000f05
\set i6      03760000-0000-0000-0000-000000000f06
\set i7      03760000-0000-0000-0000-000000000f07
\set i8      03760000-0000-0000-0000-000000000f08
\set i9      03760000-0000-0000-0000-000000000f09
\set iB      03760000-0000-0000-0000-000000000f0b
\set iC      03760000-0000-0000-0000-000000000f0c
\set occ1    03760000-0000-0000-0000-000000000001
\set occH    03760000-0000-0000-0000-000000000002
\set occR    03760000-0000-0000-0000-000000000003
\set occ2    03760000-0000-0000-0000-000000000004
\set occ3    03760000-0000-0000-0000-000000000005
\set occ4    03760000-0000-0000-0000-000000000006
\set occ5    03760000-0000-0000-0000-000000000007
\set occ7    03760000-0000-0000-0000-000000000008
\set occ8    03760000-0000-0000-0000-000000000009
\set occ9    03760000-0000-0000-0000-000000000010
\set occB    03760000-0000-0000-0000-0000000000bb
\set occC    03760000-0000-0000-0000-0000000000cc
\set occX    03760000-0000-0000-0000-0000000000ff
\set rqOther 03760000-0000-0000-0000-000000000101
\set rqItem  03760000-0000-0000-0000-000000000102
\set rqStale 03760000-0000-0000-0000-000000000103
\set rqCanc  03760000-0000-0000-0000-000000000104
\set rqOrg   03760000-0000-0000-0000-000000000105
\set rqOk    03760000-0000-0000-0000-000000000106
\set rqX     03760000-0000-0000-0000-000000000107
\set rqA     03760000-0000-0000-0000-000000000108
\set rqB     03760000-0000-0000-0000-000000000109
\set rq7     03760000-0000-0000-0000-000000000110
\set rq8     03760000-0000-0000-0000-000000000111

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:'mgr',   '0376-mgr@test.local',   '{}'::jsonb),
  (:'stf',   '0376-stf@test.local',   '{}'::jsonb),
  (:'stf2',  '0376-stf2@test.local',  '{}'::jsonb),
  (:'vwr',   '0376-vwr@test.local',   '{}'::jsonb),
  (:'noSub', '0376-nosub@test.local', '{}'::jsonb),
  (:'stfW2', '0376-stfw2@test.local', '{}'::jsonb),
  (:'dis',   '0376-dis@test.local',   '{}'::jsonb),
  (:'mgrB',  '0376-mgrb@test.local',  '{}'::jsonb),
  (:'mgrC',  '0376-mgrc@test.local',  '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:'orgA', '0376 Escalation A', '0376-escalation-a'),
  (:'orgB', '0376 Escalation B', '0376-escalation-b'),
  (:'orgC', '0376 Escalation C', '0376-escalation-c');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:'orgA', :'mgr',   'manager', now()),
  (:'orgA', :'stf',   'staff',   now()),
  (:'orgA', :'stf2',  'staff',   now()),
  (:'orgA', :'vwr',   'viewer',  now()),
  (:'orgA', :'noSub', 'staff',   now()),
  (:'orgA', :'stfW2', 'staff',   now()),
  (:'orgA', :'dis',   'staff',   now()),
  (:'orgB', :'mgrB',  'manager', now()),
  (:'orgC', :'mgrC',  'manager', now());
update public.user_profiles set disabled_at = now() where id = :'dis';
-- The module is on for A and B, off for C (new orgs are seeded with it off).
insert into public.organization_modules (organization_id, module_id, enabled, tier) values
  (:'orgA', 'maintenance_requests', true,  'optional'),
  (:'orgB', 'maintenance_requests', true,  'optional'),
  (:'orgC', 'maintenance_requests', false, 'optional')
on conflict (organization_id, module_id) do update set enabled = excluded.enabled;
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:'orgA', :'noSub', 'maintenance_requests:submit', false);
insert into public.warehouses (id, organization_id, name, code, status) values
  (:'whA',  :'orgA', '0376 Main',  'WH-0376A',  'active'),
  (:'whA2', :'orgA', '0376 Annex', 'WH-0376A2', 'active'),
  (:'whB',  :'orgB', '0376 Other', 'WH-0376B',  'active'),
  (:'whC',  :'orgC', '0376 Off',   'WH-0376C',  'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:'orgA', :'stf',   :'whA',  true),
  (:'orgA', :'stf2',  :'whA',  true),
  (:'orgA', :'vwr',   :'whA',  true),
  (:'orgA', :'noSub', :'whA',  true),
  (:'orgA', :'stfW2', :'whA2', true),
  (:'orgA', :'dis',   :'whA',  true);
insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:'locA', :'orgA', :'whA', '76-A', 'shelf', 'rack');
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status) values
  (:'i1', :'orgA', :'whA', 'X0376-1', 'Escalated item',  0, 'active'),
  (:'i2', :'orgA', :'whA', 'X0376-2', 'Staged item',     0, 'active'),
  (:'i3', :'orgA', :'whA', 'X0376-3', 'Resolved item',   0, 'active'),
  (:'i4', :'orgA', :'whA', 'X0376-4', 'Viewer item',     0, 'active'),
  (:'i5', :'orgA', :'whA', 'X0376-5', 'Re-escalated',    0, 'active'),
  (:'i6', :'orgA', :'whA', 'X0376-6', 'Two rules item',  0, 'active'),
  (:'i7', :'orgA', :'whA', 'X0376-7', 'Module item',     0, 'active'),
  (:'i8', :'orgA', :'whA', 'X0376-8', 'Racing item',     0, 'active'),
  (:'i9', :'orgA', :'whA', 'X0376-9', 'Real path item',  0, 'active'),
  (:'iB', :'orgB', :'whB', 'X0376-B', 'Other org item',  0, 'active'),
  (:'iC', :'orgC', :'whC', 'X0376-C', 'Module off item', 0, 'active');
-- Occurrences as exceptions_sync would store them. occH is a holding rule (orphaned stock) at
-- a whA location (a whA2-only member cannot see it); occR is resolved.
insert into public.exception_occurrences
  (id, organization_id, occurrence_number, rule, item_id, location_id, warehouse_id,
   first_seen_at, last_seen_at, resolved_at, resolved_reason) values
  (:'occ1', :'orgA', 1,  'label_mismatch', :'i1', null,    :'whA', now(), now(), null,  null),
  (:'occH', :'orgA', 2,  'orphaned_stock', :'i2', :'locA', :'whA', now(), now(), null,  null),
  (:'occR', :'orgA', 3,  'label_mismatch', :'i3', null,    :'whA', now(), now(), now(), 'cleared'),
  (:'occ2', :'orgA', 4,  'label_mismatch', :'i4', null,    :'whA', now(), now(), null,  null),
  (:'occ3', :'orgA', 5,  'label_mismatch', :'i5', null,    :'whA', now(), now(), null,  null),
  (:'occ4', :'orgA', 6,  'label_mismatch', :'i6', null,    :'whA', now(), now(), null,  null),
  (:'occ5', :'orgA', 7,  'over_reserved',  :'i6', null,    :'whA', now(), now(), null,  null),
  (:'occ7', :'orgA', 8,  'label_mismatch', :'i7', null,    :'whA', now(), now(), null,  null),
  (:'occ8', :'orgA', 9,  'label_mismatch', :'i8', null,    :'whA', now(), now(), null,  null),
  (:'occ9', :'orgA', 10, 'label_mismatch', :'i9', null,    :'whA', now(), now(), null,  null),
  (:'occB', :'orgB', 1,  'label_mismatch', :'iB', null,    :'whB', now(), now(), null,  null),
  (:'occC', :'orgC', 1,  'label_mismatch', :'iC', null,    :'whC', now(), now(), null,  null);
-- Requests, as the owner (the 0362 guard applies to API roles only; F18
-- makes one the real way). rqStale is 6 minutes old; rqCanc is cancelled;
-- rqOrg sits in org B but names stf and i1, so only its org is wrong.
insert into public.maintenance_requests
  (id, organization_id, requester_user_id, requester_name_snapshot, subject, description,
   related_item_id, created_at, status, cancelled_at) values
  (:'rqOther', :'orgA', :'stf2', 'Staff Two', 'Inventory issue', 'Label mismatch detail', :'i1', now(), 'saved', null),
  (:'rqItem',  :'orgA', :'stf',  'Staff',     'Inventory issue', 'Label mismatch detail', :'i4', now(), 'saved', null),
  (:'rqStale', :'orgA', :'stf',  'Staff',     'Inventory issue', 'Label mismatch detail', :'i1',
     now() - interval '6 minutes', 'saved', null),
  (:'rqCanc',  :'orgA', :'stf',  'Staff',     'Inventory issue', 'Label mismatch detail', :'i1', now(), 'cancelled', now()),
  (:'rqOrg',   :'orgB', :'stf',  'Staff',     'Inventory issue', 'Label mismatch detail', :'i1', now(), 'saved', null),
  (:'rqOk',    :'orgA', :'stf',  'Staff',     'Inventory issue', 'Label mismatch detail', :'i1', now(), 'saved', null),
  (:'rqX',     :'orgA', :'stf',  'Staff',     'Inventory issue', 'Two rules detail',      :'i6', now(), 'saved', null),
  (:'rqA',     :'orgA', :'stf',  'Staff',     'Inventory issue', 'First escalation',      :'i5', now(), 'saved', null),
  (:'rqB',     :'orgA', :'stf2', 'Staff Two', 'Inventory issue', 'Second escalation',     :'i5', now(), 'saved', null),
  (:'rq7',     :'orgA', :'stf',  'Staff',     'Inventory issue', 'Module detail',         :'i7', now(), 'saved', null),
  (:'rq8',     :'orgA', :'stf',  'Staff',     'Inventory issue', 'Racing detail',         :'i8', now(), 'saved', null);

-- Claim as p_uid; 'claimed', 'linked:<number>', or SQLSTATE[:hint]. A
-- refusal rolls back only its own subtransaction.
create function pg_temp.claim(p_uid uuid, p_occ uuid) returns text language plpgsql as $$
declare v jsonb; v_state text; v_hint text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  v := public.exception_escalation_claim(p_occ);
  return (v->>'state') || coalesce(':' || (v->>'number'), '');
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
  return v_state || coalesce(':' || nullif(v_hint, ''), '');
end $$;

-- Finish as p_uid; 'released', 'not_held', 'linked:<number>', or SQLSTATE[:hint].
create function pg_temp.fin(p_uid uuid, p_occ uuid, p_req uuid) returns text language plpgsql as $$
declare v jsonb; v_state text; v_hint text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  v := public.exception_escalation_finish(p_occ, p_req);
  return (v->>'state') || coalesce(':' || (v->>'number'), '');
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
  return v_state || coalesce(':' || nullif(v_hint, ''), '');
end $$;

-- The request_number each fixture request was given, read once as the owner
-- (a requester's own RLS would hide another person's request).
select (select request_number from public.maintenance_requests where id = :'rqOk') as "nOk",
       (select request_number from public.maintenance_requests where id = :'rqX')  as "nX",
       (select request_number from public.maintenance_requests where id = :'rqA')  as "nA",
       (select request_number from public.maintenance_requests where id = :'rqB')  as "nB"
\gset

-- An occurrence's escalated events.
create function pg_temp.escalated_events(p_occ uuid) returns int language sql as $$
  select count(*)::int from public.exception_occurrence_events where occurrence_id = p_occ and kind = 'escalated'
$$;

-- ═══ S. Structure ═════════════════════════════════════════════════════════
select is(
  (select string_agg(column_name || ':' || is_nullable || ':' || coalesce(column_default, 'none'), ' ' order by column_name)
     from information_schema.columns
    where table_schema = 'public' and table_name = 'exception_occurrences'
      and column_name in ('maintenance_request_id', 'escalation_number', 'escalation_request_created_at',
                          'escalated_at', 'escalated_by', 'escalation_claimed_at', 'escalation_claimed_by')),
  'escalated_at:YES:none escalated_by:YES:none escalation_claimed_at:YES:none escalation_claimed_by:YES:none '
  || 'escalation_number:YES:none escalation_request_created_at:YES:none maintenance_request_id:YES:none',
  'S1: the seven new columns are nullable with no default (a catalog-only add)');
select is(
  (select string_agg(a.attname || '->' || c.confrelid::regclass::text || ':' || c.confdeltype::text, ' ' order by a.attname)
     from pg_constraint c
     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.conrelid = 'public.exception_occurrences'::regclass and c.contype = 'f'
      and a.attname in ('maintenance_request_id', 'escalated_by', 'escalation_claimed_by')),
  'escalated_by->user_profiles:n escalation_claimed_by->user_profiles:n maintenance_request_id->maintenance_requests:n',
  'S2: the three foreign keys are ON DELETE SET NULL');
select is(
  (select string_agg(conname || ':' || convalidated, ' ' order by conname) from pg_constraint
    where conrelid = 'public.exception_occurrences'::regclass and contype = 'c'
      and conname in ('exc_occ_escalation_link', 'exc_occ_escalated_pair',
                      'exc_occ_escalation_claim_pair', 'exc_occ_escalation_number_positive')),
  'exc_occ_escalated_pair:true exc_occ_escalation_claim_pair:true exc_occ_escalation_link:true exc_occ_escalation_number_positive:true',
  'S3: the four CHECKs exist and are validated');
select throws_ok(
  format($$update public.exception_occurrences set maintenance_request_id = %L where id = %L$$, :'rqOk', :'occ9'),
  '23514', null,
  'S4: a link without its number and times is refused by the CHECK, even for the owner');
select ok(
  exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'exception_occurrences'
                                     and indexname = 'exc_occ_maintenance_request_idx'),
  'S5: the maintenance_request_id index exists');
select ok(
  has_function_privilege('authenticated', 'public.exception_escalation_claim(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.exception_escalation_claim(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.exception_escalation_finish(uuid, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.exception_escalation_finish(uuid, uuid)', 'EXECUTE'),
  'S6: claim and finish are executable by authenticated, not anon');
select ok(
  not has_function_privilege('authenticated', 'public._exc_escalation_refusal(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public._exc_escalation_refusal(uuid)', 'EXECUTE')
  and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                   where p.oid = 'public._exc_escalation_refusal(uuid)'::regprocedure and a.grantee = 0),
  'S7: the gate helper is executable by no client role (no PUBLIC grant)');
select is(
  (select string_agg(p.proname || ':' || case when p.prosecdef then 'definer' else 'invoker' end
                     || ':' || coalesce(array_to_string(p.proconfig, ';'), ''), ' ' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('exception_escalation_claim', 'exception_escalation_finish', '_exc_escalation_refusal')),
  '_exc_escalation_refusal:definer:search_path=public '
  || 'exception_escalation_claim:definer:search_path=public;lock_timeout=5s '
  || 'exception_escalation_finish:definer:search_path=public;lock_timeout=5s',
  'S8: security mode, pinned search_path and lock_timeout of the three new functions');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('exception_escalation_claim', 'exception_escalation_finish', '_exc_escalation_refusal')
      and p.prosrc ~ '40001|40P01'),
  0,
  'S9: no escalation function raises a retryable SQLSTATE (40001/40P01)');
select ok(
  (select bool_and(p.prosrc ~ '_exc_escalation_refusal\(' and p.prosrc !~ 'has_permission\('
                   and p.prosrc !~ 'module_enabled\(' and p.prosrc ~ '_exc_occurrence_visible\(')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('exception_escalation_claim', 'exception_escalation_finish')),
  'S10: claim and finish both check visibility and call the one gate, and neither restates it. Mutation: inline the gate');
select ok(
  (select bool_and(p.prosrc ~* 'from public\.exception_occurrences o\s+where o\.id = p_id\s+and public\._exc_occurrence_visible\([^)]*\)\s+for update')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('exception_escalation_claim', 'exception_escalation_finish')),
  'S11: claim and finish lock the occurrence row (FOR UPDATE) before deciding. Mutation: drop a FOR UPDATE');
select ok(
  exists (select 1 from pg_trigger t
           where t.tgrelid = 'public.maintenance_requests'::regclass
             and t.tgname = 'trg_aa_maintenance_requests_guard' and not t.tgisinternal),
  'S12: the 0362 guard is still on maintenance_requests');

set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to :'stf';
set local role to 'authenticated';
select throws_ok(
  format($$update public.exception_occurrences set escalation_claimed_by = %L, escalation_claimed_at = now() where id = %L$$,
         :'stf', :'occ1'),
  '42501', null,
  'S13: authenticated still cannot write the occurrence table directly (no UPDATE grant)');

-- ═══ C. Claim ═════════════════════════════════════════════════════════════
select is(pg_temp.claim(null, :'occ1'), '42501', 'C1: signed out is refused');
select is(pg_temp.claim(:'mgrB', :'occ1'), 'P0002', 'C2: a manager of another org reads "not found"');
select is(pg_temp.claim(:'stfW2', :'occH'), 'P0002',
  'C3: staff of another warehouse cannot see the holding, so "not found". Mutation: drop the visibility check');
select is(pg_temp.claim(:'dis', :'occ1'), 'P0002', 'C4: a disabled account reads "not found"');
select is(pg_temp.claim(:'mgrC', :'occC'), '42501:module_disabled',
  'C5: the maintenance module off refuses (module_disabled). Mutation: drop the gate');
select is(pg_temp.claim(:'noSub', :'occ1'), '42501:not_permitted',
  'C6: without maintenance_requests:submit, refused (not_permitted)');
select is(pg_temp.claim(:'stf', :'occR'), 'P0001:occurrence_resolved',
  'C7: a resolved occurrence cannot be escalated. Mutation: drop the resolved check');
select is(pg_temp.claim(:'stf', :'occ1'), 'claimed', 'C8: staff claims an open, visible occurrence');
reset role;
select is(
  (select escalation_claimed_by::text || ':' || (escalation_claimed_at = now())::text
     from public.exception_occurrences where id = :'occ1'),
  :'stf' || ':true',
  'C9: the claim stamps the caller and the time');
set local role to 'authenticated';
select is(pg_temp.claim(:'stf2', :'occ1'), 'P0001:escalation_in_progress',
  'C10: a second claim within 2 minutes is refused. Mutation: drop the 2-minute window');
select is(pg_temp.claim(:'stf', :'occ1'), 'P0001:escalation_in_progress',
  'C11: the caller''s own fresh claim refuses a second one too (two tabs, a double tap). Mutation: exempt the caller');
select is(pg_temp.claim(:'vwr', :'occ2'), 'claimed',
  'C12: a viewer holds maintenance_requests:submit by default and may escalate (the plan''s gate: module + submit)');
select is(pg_temp.claim(:'mgrB', :'occB'), 'claimed', 'C13: another org''s member claims their own org''s occurrence');
reset role;
-- occ1's claim ages past 2 minutes.
update public.exception_occurrences set escalation_claimed_at = now() - interval '121 seconds' where id = :'occ1';
set local role to 'authenticated';
select is(pg_temp.claim(:'stf2', :'occ1'), 'claimed', 'C14: an expired claim is free. Mutation: let an expired claim still block');
reset role;
select is(
  (select escalation_claimed_by::text from public.exception_occurrences where id = :'occ1'), :'stf2',
  'C15: the new claim is stf2''s');
-- Hand occ1 back to stf for the finish tests (as the owner, like an expiry).
update public.exception_occurrences
   set escalation_claimed_by = :'stf', escalation_claimed_at = now() where id = :'occ1';

-- ═══ F. Finish ════════════════════════════════════════════════════════════
set local role to 'authenticated';
-- Release.
select is(pg_temp.fin(:'stf2', :'occ1', null), 'not_held',
  'F1: release by someone who does not hold the claim changes nothing and is not an error');
reset role;
select is((select escalation_claimed_by::text from public.exception_occurrences where id = :'occ1'), :'stf',
  'F2: the holder''s claim is untouched by another user''s release. Mutation: release anyone''s claim');
set local role to 'authenticated';
select is(pg_temp.fin(:'stf', :'occX', null), 'not_held', 'F3: release of an unknown id is not_held, not "not found"');
select is(pg_temp.fin(:'vwr', :'occ2', null), 'released', 'F4: the holder releases their own claim');
reset role;
select ok(
  (select escalation_claimed_by is null and escalation_claimed_at is null
     from public.exception_occurrences where id = :'occ2'),
  'F5: release clears the claim');
set local role to 'authenticated';

-- Link refusals (stf holds occ1's claim).
select is(pg_temp.fin(null, :'occ1', :'rqOk'), '42501', 'F6: signed out is refused');
select is(pg_temp.fin(:'mgrB', :'occ1', :'rqOk'), 'P0002', 'F7: another org reads "not found"');
select is(pg_temp.fin(:'stf', :'occ1', :'rqOther'), 'P0001:request_not_eligible',
  'F8: another user''s request is refused. Mutation: drop the requester check');
select is(pg_temp.fin(:'stf', :'occ1', :'rqItem'), 'P0001:request_not_eligible',
  'F9: a request for a different item is refused. Mutation: drop the item check');
select is(pg_temp.fin(:'stf', :'occ1', :'rqStale'), 'P0001:request_not_eligible',
  'F10: a request older than 5 minutes is refused. Mutation: drop the 5-minute check');
select is(pg_temp.fin(:'stf', :'occ1', :'rqCanc'), 'P0001:request_not_eligible',
  'F11: a cancelled request is refused. Mutation: drop the cancelled check');
select is(pg_temp.fin(:'stf', :'occ1', :'rqOrg'), 'P0001:request_not_eligible',
  'F12: a request in another org is refused. Mutation: drop the org check');
select is(pg_temp.fin(:'stf', :'occ1', gen_random_uuid()), 'P0001:request_not_eligible',
  'F13: an unknown request is refused');
select is(pg_temp.fin(:'stf2', :'occ1', :'rqOther'), 'P0001:escalation_not_claimed',
  'F14: a caller who does not hold the claim cannot link, even their own request. Mutation: drop the claim-holder check');
select is(pg_temp.fin(:'stf', :'occ4', :'rqX'), 'P0001:escalation_not_claimed',
  'F15: with no claim at all, nothing links');
reset role;
select is(
  (select count(*)::int from public.exception_occurrences where maintenance_request_id is not null), 0,
  'F16: none of the refused finishes linked anything');
select is(pg_temp.escalated_events(:'occ1'), 0, 'F17: and none wrote an event');

-- The link.
set local role to 'authenticated';
select is(pg_temp.fin(:'stf', :'occ1', :'rqOk'), 'linked:' || :'nOk',
  'F18: stf links their own fresh request for this item and gets its number back');
reset role;
select is(
  (select format('%s|%s|%s|%s|%s|%s',
                 maintenance_request_id, escalation_number, (escalation_request_created_at = r.created_at)::text,
                 escalated_by, (escalated_at is not null)::text,
                 (escalation_claimed_by is null and escalation_claimed_at is null)::text)
     from public.exception_occurrences o
     join public.maintenance_requests r on r.id = :'rqOk'
    where o.id = :'occ1'),
  format('%s|%s|true|%s|true|true', :'rqOk', :'nOk', :'stf'),
  'F19: the link, a copy of its number and created_at, who and when, and the claim cleared. Mutation: keep the claim');
select is(
  (select format('%s|%s|%s', count(*), min(actor_user_id::text), min(maintenance_request_id::text))
     from public.exception_occurrence_events where occurrence_id = :'occ1' and kind = 'escalated'),
  format('1|%s|%s', :'stf', :'rqOk'),
  'F20: exactly one escalated event, with the actor and the request. Mutation: forget the event');
select ok(
  (select acknowledged_at is null and acknowledged_by is null and resolved_at is null and resolved_reason is null
     from public.exception_occurrences where id = :'occ1'),
  'F21: escalating neither acknowledges nor resolves. Mutation: acknowledge on link');
select is(
  (select count(*)::int from public.exception_occurrence_events
    where occurrence_id = :'occ1' and kind in ('acknowledged', 'resolved')), 0,
  'F22: and writes no acknowledged or resolved event');
set local role to 'authenticated';
select is(pg_temp.fin(:'stf', :'occ1', :'rqOk'), 'linked:' || :'nOk',
  'F23: a replay of the same link (a lost answer) returns the same link. Mutation: drop the replay check');
reset role;
select is(pg_temp.escalated_events(:'occ1'), 1, 'F24: with no second event');
set local role to 'authenticated';
select is(pg_temp.claim(:'stf2', :'occ1'), 'linked:' || :'nOk',
  'F25: a claim on a linked occurrence answers the linked request (id and number) instead of claiming');
reset role;
select ok(
  (select escalation_claimed_by is null from public.exception_occurrences where id = :'occ1'),
  'F26: and claims nothing');

-- A request links to one occurrence: rqX (item i6) linked to occ4 cannot also
-- link to occ5 (the same item, another rule).
set local role to 'authenticated';
select is(pg_temp.claim(:'stf', :'occ4'), 'claimed', 'F27: claim occ4');
select is(pg_temp.fin(:'stf', :'occ4', :'rqX'), 'linked:' || :'nX', 'F28: link rqX to occ4');
select is(pg_temp.claim(:'stf', :'occ5'), 'claimed', 'F29: claim occ5 (same item, another rule)');
select is(pg_temp.fin(:'stf', :'occ5', :'rqX'), 'P0001:request_not_eligible',
  'F30: rqX is already linked to occ4, so it cannot link to occ5. Mutation: drop the linked-elsewhere check');
select is(pg_temp.fin(:'stf', :'occ5', null), 'released', 'F31: release occ5');

-- Re-escalation after a cancel: occ3 linked to rqA; rqA is cancelled; stf2
-- escalates again with rqB.
select is(pg_temp.claim(:'stf', :'occ3'), 'claimed', 'F32: claim occ3');
select is(pg_temp.fin(:'stf', :'occ3', :'rqA'), 'linked:' || :'nA', 'F33: link rqA');
select is(pg_temp.claim(:'stf2', :'occ3'), 'linked:' || :'nA',
  'F34: while rqA is not cancelled, a new claim gets rqA back');
reset role;
update public.maintenance_requests set status = 'cancelled', cancelled_at = now() where id = :'rqA';
set local role to 'authenticated';
select is(pg_temp.claim(:'stf2', :'occ3'), 'claimed',
  'F35: after rqA is cancelled, a new escalation may start. Mutation: count a cancelled request as linked');
select is(pg_temp.fin(:'stf2', :'occ3', :'rqB'), 'linked:' || :'nB', 'F36: stf2 links rqB');
reset role;
select is(
  (select format('%s|%s|%s', maintenance_request_id, escalation_number, escalated_by)
     from public.exception_occurrences where id = :'occ3'),
  format('%s|%s|%s', :'rqB', :'nB', :'stf2'),
  'F37: the new link replaces the old one');
select is(
  (select string_agg(maintenance_request_id::text, ',' order by created_at, id)
     from public.exception_occurrence_events where occurrence_id = :'occ3' and kind = 'escalated'),
  :'rqA' || ',' || :'rqB',
  'F38: both escalations stay in the timeline');
-- Archiving the cancelled request keeps cancelled_at, so it still frees the row.
update public.maintenance_requests set status = 'cancelled', cancelled_at = now() where id = :'rqB';
update public.maintenance_requests set status = 'archived', archived_at = now() where id = :'rqB';
set local role to 'authenticated';
select is(pg_temp.claim(:'stf', :'occ3'), 'claimed',
  'F39: a cancelled-then-archived request (status archived, cancelled_at kept) still frees the occurrence');
select is(pg_temp.fin(:'stf', :'occ3', null), 'released', 'F40: release occ3');

-- The module turned off between claim and finish.
select is(pg_temp.claim(:'stf', :'occ7'), 'claimed', 'F41: claim occ7');
reset role;
update public.organization_modules set enabled = false
 where organization_id = :'orgA' and module_id = 'maintenance_requests';
set local role to 'authenticated';
select is(pg_temp.fin(:'stf', :'occ7', :'rq7'), '42501:module_disabled',
  'F42: finish re-checks the gate: the module off refuses the link. Mutation: drop the gate from finish');
reset role;
update public.organization_modules set enabled = true
 where organization_id = :'orgA' and module_id = 'maintenance_requests';

-- Resolved between claim and finish.
set local role to 'authenticated';
select is(pg_temp.claim(:'stf', :'occ8'), 'claimed', 'F43: claim occ8');
reset role;
update public.exception_occurrences set resolved_at = now(), resolved_reason = 'cleared' where id = :'occ8';
set local role to 'authenticated';
select is(pg_temp.fin(:'stf', :'occ8', :'rq8'), 'P0001:occurrence_resolved',
  'F44: an occurrence resolved after the claim is not linked. Mutation: drop the resolved check from finish');
reset role;
select ok(
  (select maintenance_request_id is null from public.exception_occurrences where id = :'occ8'),
  'F45: and stays unlinked');

-- The real path: a request inserted as the signed-in requester (the 0362
-- guard stamps created_at and the requester snapshot), then linked.
set local role to 'authenticated';
select is(pg_temp.claim(:'stf', :'occ9'), 'claimed', 'F46: claim occ9');
set local "request.jwt.claim.sub" to :'stf';
select lives_ok(
  format($$insert into public.maintenance_requests
             (organization_id, requester_user_id, requester_name_snapshot, subject, description, priority, related_item_id)
           values (%L, %L, 'x', 'Inventory issue: Real path item (X0376-9)', 'Label will not lead to the stock: labelled 9-Z. Ref EX-000010.', 'normal', %L)$$,
         :'orgA', :'stf', :'i9'),
  'F47: stf creates a request for i9 through the API role (the 0362 guard runs)');
select is(
  pg_temp.fin(:'stf', :'occ9', (select id from public.maintenance_requests where related_item_id = :'i9')),
  'linked:' || (select request_number::text from public.maintenance_requests where related_item_id = :'i9'),
  'F48: the request made through the real API path links');
reset role;

-- Nothing here touched maintenance_requests beyond the fixtures and F48.
select is(
  (select count(*)::int from public.maintenance_requests where organization_id in (:'orgA', :'orgB', :'orgC')),
  12,
  'F49: escalation writes no maintenance request of its own (11 fixtures + the one F48 made)');

select * from finish();
rollback;
