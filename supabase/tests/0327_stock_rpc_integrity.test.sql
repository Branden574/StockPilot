-- supabase/tests/0327_stock_rpc_integrity.test.sql
-- Proves migration 0327 — the stock-RPC integrity wave — in BOTH directions:
--
--   • transfer_stock: an over-transfer raises the SAME P0001
--     'insufficient_stock' the app maps (NOT a 23514 check_violation from the
--     new constraint firing first) and leaves both holdings untouched; a
--     covered transfer and the exact-drain boundary (quantity == p_quantity)
--     still work. The error-message pin is the point: 0231's post-write check
--     would have started 23514-ing the moment the constraint landed.
--
--   • item_stock_levels_quantity_nonneg: the direct write route (the
--     PostgREST PATCH shape from 0322 s.1) is refused at the row.
--
--   • _cycle_count_org_stock_sum: SECURITY DEFINER with a pinned search_path,
--     closed to PUBLIC/anon, open to authenticated; self-authorizes with
--     post_cycle_count's own manager gate (outsider and staff both refused);
--     returns the literal org-wide sum; and its org filter makes a
--     cross-tenant sum impossible (a foreign item id sums the CALLER's org's
--     empty holdings, not the foreign org's stock).
--
--     HONEST NOTE on the definer property: at 0327 time
--     item_stock_levels_select was still the org-wide predicate (deferred in
--     0322 s.4), so NO caller who passed the helper's manager gate could be
--     blinded by RLS, and an "RLS hides a holding from the assignee" fixture
--     could not be constructed. The property that makes the sum future-proof
--     was therefore asserted structurally (prosecdef = true, search_path
--     pinned) rather than behaviourally. (0331 has since warehouse-narrowed
--     the policy — managers remain unnarrowed by its privileged disjunct, so
--     these assertions and fixtures hold unchanged; 0331's own test carries
--     the scoped-caller behavioral proofs.)
--
--   • post_cycle_count end-to-end THROUGH the wired helper, as an
--     authenticated manager: negative variance reconciles the (NULL-kind,
--     0292-shaped) placed holding and the on-hand to the counted number.
--
-- HOW THE ROLES ARE SIMULATED — house convention (0191/0282/0322): `set local
-- role` + request.jwt.claim.sub. RPC-guard assertions that do not depend on
-- RLS set only the jwt claim (0322's adjust_stock block does the same).
--
-- Namespace: 03270000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(25);

\set orgT    '\'03270000-0000-0000-0000-000000000001\''
\set orgU    '\'03270000-0000-0000-0000-000000000002\''
\set t_mgr   '\'03270000-0000-0000-0000-0000000000a1\''
\set t_stf   '\'03270000-0000-0000-0000-0000000000a2\''
\set u_mgr   '\'03270000-0000-0000-0000-0000000000a3\''
\set whT     '\'03270000-0000-0000-0000-0000000000b1\''
\set locFrom '\'03270000-0000-0000-0000-0000000000e1\''
\set locTo   '\'03270000-0000-0000-0000-0000000000e2\''
\set itemT   '\'03270000-0000-0000-0000-0000000000c1\''
\set itemH   '\'03270000-0000-0000-0000-0000000000c2\''
\set itemC   '\'03270000-0000-0000-0000-0000000000c3\''
\set ccT     '\'03270000-0000-0000-0000-0000000000d1\''

-- ── Fixtures (superuser: RLS bypassed) ───────────────────────────────────────

insert into auth.users (id, email, raw_user_meta_data) values
  (:t_mgr, 'mgr-0327@test.local',   '{}'::jsonb),
  (:t_stf, 'staff-0327@test.local', '{}'::jsonb),
  (:u_mgr, 'outsider-0327@test.local', '{}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgT, 'Integrity Org T 0327', 'integrity-org-t-0327'),
  (:orgU, 'Integrity Org U 0327', 'integrity-org-u-0327')
on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgT, :t_mgr, 'manager', now()),
  (:orgT, :t_stf, 'staff',   now()),
  (:orgU, :u_mgr, 'manager', now())
on conflict do nothing;

-- The 0188 trigger auto-creates Staging + Unplaced for the warehouse.
insert into public.warehouses (id, organization_id, name, code, status)
  values (:whT, :orgT, 'Integrity WH 0327', 'WH-0327', 'active')
  on conflict (id) do nothing;

-- Both bins are deliberately kind = NULL: the 0292-shaped placed bin that the
-- draw-down paths must keep seeing (`is distinct from 'staging'`).
insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:locFrom, :orgT, :whT, 'Bin From 0327', 'bin', null),
  (:locTo,   :orgT, :whT, 'Bin To 0327',   'bin', null)
on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:itemT, :orgT, :whT, 'INT-0327-T', 'Transfer Item 0327', 10, 'active', 'none'),
  (:itemH, :orgT, :whT, 'INT-0327-H', 'Helper Sum Item 0327', 7, 'active', 'none'),
  (:itemC, :orgT, :whT, 'INT-0327-C', 'Count Item 0327', 9, 'active', 'none')
on conflict (id) do nothing;

-- The 0199 trigger seeds an Unplaced row per item; clear and place explicitly
-- so every quantity below is a literal this file controls.
delete from public.item_stock_levels where item_id in (:itemT, :itemH, :itemC);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values
  (:orgT, :itemT, :locFrom, 10),
  (:orgT, :itemH, :locFrom, 3),
  (:orgT, :itemH, :locTo,   4),
  (:orgT, :itemC, :locFrom, 9)
on conflict (item_id, location_id) do nothing;

-- An in-progress count over itemC: expected 9 (snapshot), counted 5 → −4.
insert into public.cycle_counts
  (id, organization_id, warehouse_id, status, scope, started_by, started_at)
  values (:ccT, :orgT, :whT, 'in_progress', 'warehouse', :t_mgr, now())
  on conflict (id) do nothing;
insert into public.cycle_count_lines
  (cycle_count_id, item_id, expected_quantity, counted_quantity, warehouse_id)
  values (:ccT, :itemC, 9, 5, :whT)
  on conflict do nothing;


-- ══════════════════════════════════════════════════════════════════════════
-- 1. transfer_stock — guard IN the draw, error class preserved.
-- Run as the authenticated manager so the RPC's writes also clear RLS (the
-- outage half a superuser-only test would miss).
-- ══════════════════════════════════════════════════════════════════════════

-- CONTROL (superuser): the source holding genuinely holds 10, so the refusals
-- below are not vacuous.
select is(
  (select quantity from public.item_stock_levels
    where item_id = :itemT and location_id = :locFrom),
  10::numeric,
  'CONTROL: the transfer item''s source holding starts at exactly 10'
);

set local "request.jwt.claim.sub" to :t_mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ATTACKER/FAILURE PATH: over-transfer. The pinned MESSAGE is the assertion
-- that the new CHECK constraint did NOT fire first — a 23514 check_violation
-- here means the guard regressed to 0231's write-then-inspect shape.
select throws_ok(
  format($$select public.transfer_stock(%L, %L, %L, 15, 'wc0327 over')$$,
         :itemT, :locFrom, :locTo),
  'P0001',
  'insufficient_stock',
  '0327: an over-transfer raises insufficient_stock (P0001), NOT a 23514 from the constraint'
);
select is(
  (select quantity from public.item_stock_levels
    where item_id = :itemT and location_id = :locFrom),
  10::numeric,
  '0327: the refused over-transfer left the source holding untouched at 10'
);
select is(
  (select count(*) from public.item_stock_levels
    where item_id = :itemT and location_id = :locTo),
  0::bigint,
  '0327: the refused over-transfer left NO destination row behind (seed rolled back)'
);

-- LEGITIMATE CASE STILL WORKS: a covered transfer...
select lives_ok(
  format($$select public.transfer_stock(%L, %L, %L, 4, 'wc0327 move')$$,
         :itemT, :locFrom, :locTo),
  '0327 legit: a covered transfer still works'
);
select is(
  (select quantity from public.item_stock_levels
    where item_id = :itemT and location_id = :locFrom),
  6::numeric,
  '0327: source decremented 10 -> 6'
);
select is(
  (select quantity from public.item_stock_levels
    where item_id = :itemT and location_id = :locTo),
  4::numeric,
  '0327: destination incremented 0 -> 4'
);

-- ...and the exact-drain BOUNDARY (quantity == p_quantity). `quantity >=
-- p_quantity` must admit equality or every drain-the-bin transfer breaks.
select lives_ok(
  format($$select public.transfer_stock(%L, %L, %L, 6, 'wc0327 drain')$$,
         :itemT, :locFrom, :locTo),
  '0327 legit: transferring EXACTLY the source holding (boundary) still works'
);
select is(
  (select quantity from public.item_stock_levels
    where item_id = :itemT and location_id = :locFrom),
  0::numeric,
  '0327: exact drain left the source at exactly 0'
);
select is(
  (select quantity from public.item_stock_levels
    where item_id = :itemT and location_id = :locTo),
  10::numeric,
  '0327: exact drain left the destination holding all 10'
);

reset role;

-- ══════════════════════════════════════════════════════════════════════════
-- 2. The constraint bites on the DIRECT write route (0322 s.1's PostgREST
-- PATCH shape). Superuser on purpose: a CHECK constraint binds every role,
-- so this is the strongest form of the refusal.
-- ══════════════════════════════════════════════════════════════════════════

select throws_ok(
  format($$update public.item_stock_levels set quantity = -1
            where item_id = %L and location_id = %L$$, :itemT, :locTo),
  '23514',
  null,
  '0327: a direct negative item_stock_levels write is refused (check_violation)'
);

-- ══════════════════════════════════════════════════════════════════════════
-- 3. _cycle_count_org_stock_sum — structure, grants, gate, sum.
-- ══════════════════════════════════════════════════════════════════════════

-- Structural definer property (see header for why no behavioural RLS-blinded
-- fixture is constructible today).
select ok(
  (select p.prosecdef from pg_proc p
    where p.oid = 'public._cycle_count_org_stock_sum(uuid, uuid)'::regprocedure),
  '0327: _cycle_count_org_stock_sum is SECURITY DEFINER (the sum cannot be narrowed by the caller''s RLS)'
);
select ok(
  (select p.proconfig::text like '%search_path=public%' from pg_proc p
    where p.oid = 'public._cycle_count_org_stock_sum(uuid, uuid)'::regprocedure),
  '0327: _cycle_count_org_stock_sum pins search_path=public (secdef hygiene)'
);

-- Grant posture (0318 style: PUBLIC and anon both named-closed; authenticated
-- kept because post_cycle_count is SECURITY INVOKER and reaches it as the user).
select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a
    where p.oid = 'public._cycle_count_org_stock_sum(uuid, uuid)'::regprocedure
      and a.grantee = 0                 -- grantee 0 is PUBLIC
      and a.privilege_type = 'EXECUTE'
  ),
  '0327: PUBLIC holds no EXECUTE on _cycle_count_org_stock_sum'
);
select ok(
  not has_function_privilege('anon', 'public._cycle_count_org_stock_sum(uuid, uuid)', 'execute'),
  '0327: anon holds no EXECUTE on _cycle_count_org_stock_sum'
);
select ok(
  has_function_privilege('authenticated', 'public._cycle_count_org_stock_sum(uuid, uuid)', 'execute'),
  '0327: authenticated RETAINS EXECUTE (post_cycle_count is SECURITY INVOKER and calls it as the user)'
);

-- WIRING PIN. The behavioral fixture for "posting sees the whole org even
-- when the caller's RLS is narrower" was unconstructible at 0327 time while
-- item_stock_levels_select stayed org-wide (AR-2, since closed by 0331 —
-- managers remain unnarrowed, so it is STILL unconstructible here), so a
-- revert of post_cycle_count's body to the bare 0196 SELECT would pass every
-- behavioral test above. This structural pin closes that surviving
-- mutation: the reconciliation sum must flow through the definer helper.
select ok(
  (select p.prosrc like '%_cycle_count_org_stock_sum%' from pg_proc p
    where p.oid = 'public.post_cycle_count(uuid)'::regprocedure),
  '0327: post_cycle_count computes its reconciliation sum via _cycle_count_org_stock_sum (wiring pin)'
);

-- The manager gets the TRUE org-wide sum, literal-pinned: 3 (locFrom) + 4
-- (locTo) = 7. The fixture places the holdings; the test does not recompute.
set local "request.jwt.claim.sub" to :t_mgr;
select is(
  public._cycle_count_org_stock_sum(:itemH, :orgT),
  7::numeric,
  '0327: an org manager gets the full org-wide sum (3 + 4 = 7, literal)'
);

-- Gate: a manager of ANOTHER org is refused outright...
set local "request.jwt.claim.sub" to :u_mgr;
select throws_ok(
  format($$select public._cycle_count_org_stock_sum(%L, %L)$$, :itemH, :orgT),
  '42501',
  'forbidden',
  '0327: a caller outside the org is refused (forbidden), definer rights notwithstanding'
);
-- ...and passing their OWN org with the foreign item sums that org's (empty)
-- holdings — the org filter makes a cross-tenant sum unreachable.
select is(
  public._cycle_count_org_stock_sum(:itemH, :orgU),
  0::numeric,
  '0327: a foreign item id against the caller''s own org sums to 0 — no cross-tenant leak through the definer read'
);

-- Gate mirrors post_cycle_count exactly: staff (who cannot POST a count)
-- cannot invoke the privileged sum either.
set local "request.jwt.claim.sub" to :t_stf;
select throws_ok(
  format($$select public._cycle_count_org_stock_sum(%L, %L)$$, :itemH, :orgT),
  '42501',
  'forbidden',
  '0327: org staff are refused — the helper mirrors post_cycle_count''s manager gate, not a looser one'
);

-- ══════════════════════════════════════════════════════════════════════════
-- 4. post_cycle_count end-to-end THROUGH the wired helper, as an
-- authenticated manager: counted 5 vs expected 9 → on-hand and the NULL-kind
-- placed holding both reconcile to the counted number.
-- ══════════════════════════════════════════════════════════════════════════

set local "request.jwt.claim.sub" to :t_mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select lives_ok(
  format($$select public.post_cycle_count(%L)$$, :ccT),
  '0327 legit: post_cycle_count posts a negative variance through the definer sum'
);

reset role;

select is(
  (select quantity_on_hand from public.inventory_items where id = :itemC),
  5::numeric,
  '0327: posted on-hand equals the counted quantity (9 -> 5)'
);
select is(
  (select quantity from public.item_stock_levels
    where item_id = :itemC and location_id = :locFrom),
  5::numeric,
  '0327: the NULL-kind placed holding reconciled 9 -> 5 (Σ levels = on-hand invariant holds)'
);
select is(
  (select status from public.cycle_counts where id = :ccT),
  'completed',
  '0327: the count session completed'
);

select * from finish();
rollback;
