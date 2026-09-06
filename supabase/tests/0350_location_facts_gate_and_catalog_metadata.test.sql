-- supabase/tests/0350_location_facts_gate_and_catalog_metadata.test.sql
-- Proves migration 0350.
--
-- WHY THIS TEST EXISTS
--   On the 0347 head, _cycle_count_location_facts was a SECURITY DEFINER
--   function that `authenticated` could execute at POST /rest/v1/rpc with no
--   auth.uid() / membership check in its body. A manager of org A — or a user
--   with NO org membership at all — could hand it a location uuid belonging to
--   org B and get back that org's id, its warehouse id, its kind and whether it
--   is archived, a read RLS on public.locations (is_org_member) denies.
--   Assertions 5, 6 and 7 FAIL on that head and pass after 0350.
--
--   Assertions 8-11 are the counterweight: they pin the reasons the function is
--   SECURITY DEFINER in the first place (0342) and 0346's note that a foreign
--   location must be refused LOUDLY. They must pass BEFORE and AFTER 0350 — if
--   the gate had broken the legitimate post path, they would go red.
--
--   Assertions 12-14 cover the two catalog-comment corrections and the
--   next_po_number search_path pin. 12 and 14 FAIL on the 0347 head.
--
-- HOW THE ROLES ARE SIMULATED
--   The gate reads auth.uid() only, never RLS, so these run as the test
--   superuser with `set local "request.jwt.claim.sub"` — the same form 0331,
--   0346 and 0342 use. An EMPTY sub claim makes auth.uid() null, i.e. the
--   service_role / postgres path.
--
-- Run via `supabase test db` after `supabase db reset`.

begin;
select plan(14);

\set orgA   '\'03500000-0000-0000-0000-00000000000a\''
\set orgB   '\'03500000-0000-0000-0000-00000000000b\''
\set u_mgrA '\'03500000-0000-0000-0000-0000000000a1\''
\set u_mgrB '\'03500000-0000-0000-0000-0000000000b1\''
\set u_none '\'03500000-0000-0000-0000-0000000000c1\''
\set whB    '\'03500000-0000-0000-0000-0000000000d1\''
\set rackA  '\'03500000-0000-0000-0000-0000000000d2\''
\set rackB  '\'03500000-0000-0000-0000-0000000000d3\''

-- ── Fixtures (superuser: RLS bypassed) ──────────────────────────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  (:u_mgrA, 'mgra-0350@test.local', '{}'::jsonb),
  (:u_mgrB, 'mgrb-0350@test.local', '{}'::jsonb),
  (:u_none, 'none-0350@test.local', '{}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgA, 'Facts Org A 0350', 'facts-org-a-0350'),
  (:orgB, 'Facts Org B 0350', 'facts-org-b-0350')
on conflict (id) do nothing;

-- u_none is deliberately a member of NOTHING: a signed-in user with no org.
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :u_mgrA, 'manager', now()),
  (:orgB, :u_mgrB, 'manager', now())
on conflict do nothing;

insert into public.warehouses (id, organization_id, name, code, status) values
  (:whB, :orgB, 'Facts WH B 0350', 'WH-0350-B', 'active')
on conflict (id) do nothing;

insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:rackA, :orgA, null, 'Rack A 0350', 'bin', 'rack'),
  (:rackB, :orgB, :whB, 'Rack B 0350', 'bin', 'rack')
on conflict (id) do nothing;

-- ── 1. Structure: the EXECUTE posture is UNCHANGED, the gate is in the body ─
select ok(
  has_function_privilege('authenticated', 'public._cycle_count_location_facts(uuid)', 'execute'),
  '0350/1: authenticated RETAINS EXECUTE (post_cycle_count is SECURITY INVOKER and reaches this helper as the calling user)');
select ok(
  not has_function_privilege('anon', 'public._cycle_count_location_facts(uuid)', 'execute'),
  '0350/2: anon still holds no EXECUTE');
select ok(
  (select p.prosecdef and 'search_path=public' = any(p.proconfig)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_cycle_count_location_facts'),
  '0350/3: still SECURITY DEFINER with a pinned search_path (the DEFINER read is the point — see 0342)');
select ok(
  (select p.prosrc ~* 'has_org_role'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_cycle_count_location_facts'),
  '0350/4: the body authorizes itself rather than trusting the grant');

-- ── 2. The oracle is closed ────────────────────────────────────────────────
set local "request.jwt.claim.sub" to :u_mgrA;
select is(
  (select count(*)::int from public._cycle_count_location_facts(:rackB)),
  0,
  '0350/5: a MANAGER of another org resolves nothing for a foreign location (the reproduced leak)');

set local "request.jwt.claim.sub" to :u_none;
select is(
  (select count(*)::int from public._cycle_count_location_facts(:rackB)),
  0,
  '0350/6: a signed-in user with NO org membership resolves nothing');
select is(
  (select count(*)::int from public._cycle_count_location_facts(:rackA)),
  0,
  '0350/7: ... for either org — there is no uuid it can turn into a tenant identity');

-- ── 3. The legitimate reads still work (0342's whole reason for DEFINER) ────
set local "request.jwt.claim.sub" to :u_mgrB;
select is(
  (select organization_id from public._cycle_count_location_facts(:rackB)),
  :orgB::uuid,
  '0350/8: a manager of the OWNING org still resolves the location');
select is(
  (select warehouse_id || '|' || kind || '|' || coalesce(deleted_at::text, 'null')
     from public._cycle_count_location_facts(:rackB)),
  :whB || '|rack|null',
  '0350/9: ... with every attribute post_cycle_count validates against, unchanged');

set local "request.jwt.claim.sub" to :u_mgrA;
select is(
  (select coalesce(warehouse_id::text, 'null') || '|' || kind
     from public._cycle_count_location_facts(:rackA)),
  'null|rack'::text,
  '0350/10: an ORG-LEVEL location (warehouse_id null, the 0343 shape) still resolves for its own manager');

-- The service_role / postgres path (no sub claim) is deliberately unchanged,
-- the same shape 0331/0341/0346 use. A null subject already reaches
-- public.locations directly, so passing it through here grants nothing.
set local "request.jwt.claim.sub" to '';
select is(
  (select organization_id from public._cycle_count_location_facts(:rackB)),
  :orgB::uuid,
  '0350/11: a service connection (no sub claim) keeps the historical unfiltered read');

-- ── 4. Catalog comments stop lying ─────────────────────────────────────────
select unalike(
  obj_description('public._cycle_count_org_stock_sum(uuid,uuid)'::regprocedure, 'pg_proc'),
  '%remains blocked%',
  '0350/12: _cycle_count_org_stock_sum''s comment no longer tells a reviewer AR-2 is still blocked');
select alike(
  obj_description('public._cycle_count_org_stock_sum(uuid,uuid)'::regprocedure, 'pg_proc'),
  '%SECURITY DEFINER since 0331%',
  '0350/13: ... it records why AR-2 is resolved instead');

-- ── 5. next_po_number: the pin 0329 missed ─────────────────────────────────
select ok(
  (select 'search_path=public' = any(p.proconfig)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'next_po_number')
  and not has_function_privilege('anon', 'public.next_po_number(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.next_po_number(uuid)', 'execute'),
  '0350/14: next_po_number pins search_path=public, loses anon, and KEEPS authenticated (the PO approve path calls it as the user)');

select * from finish();
rollback;
