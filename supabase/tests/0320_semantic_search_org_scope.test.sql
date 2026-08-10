-- supabase/tests/0320_semantic_search_org_scope.test.sql
-- Proves migration 0320: match_inventory_items_by_embedding filters by
-- organization INSIDE the database, the org-blind 0094 signature is gone, and
-- anon cannot execute the replacement.
--
-- WHY THE ORG ASSERTIONS RUN AS SUPERUSER (this is the point of the file):
-- the function is SECURITY INVOKER, so under a real `authenticated` session RLS
-- would ALSO be filtering, and a passing test could not tell us which control
-- did the work. Running as the test's default superuser role bypasses RLS
-- entirely, which isolates the NEW org predicate as the only thing that can
-- exclude org B's row. If the `where i.organization_id = p_org_id` line is
-- removed, assertions 3-5 fail here even though the app would still look fine
-- for a single-org user — which is exactly the blind spot that let this ship in
-- 0094.
--
-- Fixtures: two orgs, one warehouse each, one embedded item each, both
-- embeddings IDENTICAL. Identical vectors matter: it removes similarity ranking
-- as an explanation for any row that is or isn't returned, so the only variable
-- left is the org filter.
--
-- 8 assertions:
--   1     the old org-blind 3-argument signature no longer exists
--   2     the new 4-argument signature exists
--   3-4   searching org A returns org A's item and NOT org B's
--   5     searching org B returns only org B's item (filter is a real
--         parameter, not a hardcoded org)
--   6     a null p_org_id raises rather than returning everything
--   7     anon holds no EXECUTE
--   8     no PUBLIC execute grant survives in the ACL
--
-- Wrapped in begin/rollback -- nothing leaks.

begin;

select plan(8);

\set orgA   '\'fa200000-0000-0000-0000-000000000001\''
\set orgB   '\'fa200000-0000-0000-0000-000000000002\''
\set usr    '\'fa200000-0000-0000-0000-000000000003\''
\set whA    '\'fa200000-0000-0000-0000-000000000004\''
\set whB    '\'fa200000-0000-0000-0000-000000000005\''
\set itemA  '\'fa200000-0000-0000-0000-000000000006\''
\set itemB  '\'fa200000-0000-0000-0000-000000000007\''

-- ── Fixtures ─────────────────────────────────────────────────────────────────

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'semantic-org-scope@test.local', '{}'::jsonb) on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values
    (:orgA, 'Semantic Scope Org A', 'semantic-scope-org-a-0320'),
    (:orgB, 'Semantic Scope Org B', 'semantic-scope-org-b-0320')
  on conflict (id) do nothing;

-- The user is a member of BOTH orgs. This is the exact condition that made the
-- 0094 function leak: RLS admits both memberships, so only an explicit org
-- parameter can narrow to the org the request is acting in.
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values
    (:orgA, :usr, 'admin', now()),
    (:orgB, :usr, 'admin', now())
  on conflict do nothing;

insert into public.warehouses (id, organization_id, name, code, status)
  values
    (:whA, :orgA, 'Scope WH A', 'WH-SCA', 'active'),
    (:whB, :orgB, 'Scope WH B', 'WH-SCB', 'active')
  on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values
    (:itemA, :orgA, :whA, 'SCOPE-0320-A', 'Org A Embedded Widget', 5, 'active', 'none'),
    (:itemB, :orgB, :whB, 'SCOPE-0320-B', 'Org B Embedded Widget', 7, 'active', 'none')
  on conflict (id) do nothing;

-- IDENTICAL embeddings, so similarity cannot explain any difference in results.
update public.inventory_items
   set embedding = array_fill(0.05::real, array[1536])::extensions.vector(1536)
 where id in (:itemA, :itemB);

-- ── 1-2. The old signature is gone; the new one is present ───────────────────

-- Matched on pg_proc.pronargs + the first argument's type rather than on a
-- pg_get_function_identity_arguments() string. That function renders parameter
-- NAMES and an unqualified type ('p_query vector', not 'extensions.vector'), so
-- a literal comparison is easy to get silently wrong -- and a wrong string in a
-- `not exists` assertion passes VACUOUSLY, proving nothing. (That is exactly
-- what the first draft of this file did; the negative control below is what
-- caught it.) Argument count and type are format-independent.

select ok(
  not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'match_inventory_items_by_embedding'
       and p.pronargs = 3
  ),
  'the org-blind 3-argument signature from 0094 is DROPPED (no callable overload keeps the leak reachable over PostgREST)'
);

select ok(
  exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'match_inventory_items_by_embedding'
       and p.pronargs = 4
       and format_type(p.proargtypes[0], null) = 'uuid'
  ),
  'the org-scoped 4-argument signature exists and takes the org id FIRST'
);

-- ── 3-5. The org filter actually excludes the other org's rows ───────────────

select is(
  (select count(*)::int
     from public.match_inventory_items_by_embedding(
            :orgA,
            array_fill(0.05::real, array[1536])::extensions.vector(1536),
            50,
            0.0)),
  1,
  'searching org A returns exactly ONE row (RLS is bypassed here, so this counts the org filter alone)'
);

-- array_agg, not a bare scalar subquery: when the org filter is missing the
-- function returns BOTH rows, and a scalar subquery would die with "more than
-- one row returned" instead of reporting a readable diff. Aggregating also makes
-- the assertion stronger -- it pins the entire result set, not just its first row.

select is(
  (select array_agg(id order by id)
     from public.match_inventory_items_by_embedding(
            :orgA,
            array_fill(0.05::real, array[1536])::extensions.vector(1536),
            50,
            0.0)),
  array[:itemA::uuid],
  'org A''s search returns EXACTLY org A''s item -- org B''s identically-embedded item is excluded'
);

select is(
  (select array_agg(id order by id)
     from public.match_inventory_items_by_embedding(
            :orgB,
            array_fill(0.05::real, array[1536])::extensions.vector(1536),
            50,
            0.0)),
  array[:itemB::uuid],
  'org B''s search returns EXACTLY org B''s item -- the filter follows the parameter, it is not a hardcoded org'
);

-- ── 6. A null org id must RAISE, never fall through to "all orgs" ────────────

select throws_ok(
  format(
    'select * from public.match_inventory_items_by_embedding(null::uuid, array_fill(0.05::real, array[1536])::extensions.vector(1536), 50, 0.0)'
  ),
  'p_org_id is required',
  'a null p_org_id raises instead of silently returning every org''s rows'
);

-- ── 7-8. anon cannot execute (0318 precedent) ────────────────────────────────

select ok(
  not has_function_privilege(
    'anon',
    'public.match_inventory_items_by_embedding(uuid, extensions.vector(1536), int, float)',
    'execute'
  ),
  'anon holds no EXECUTE (has_function_privilege resolves inherited PUBLIC grants too)'
);

select ok(
  (select bool_and(p.proacl is not null
                   and not exists (select 1 from unnest(p.proacl) a where a::text like '=%'))
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'match_inventory_items_by_embedding'),
  'no PUBLIC execute grant survives in the ACL (Postgres defaults new functions to EXECUTE TO PUBLIC -- 0318)'
);

select * from finish();
rollback;
