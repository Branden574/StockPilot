-- supabase/tests/0294_category_tracking_profiles.test.sql
--
-- Proves 0294: category tracking profiles + size scales.
--
-- Fixture map: org 5c294000-...-01, admin user ...-02, parent category ...-03
-- (Sports, QUANTITY_BY_VARIANT), child category ...-04 (Shoes, NULL mode ->
-- inherits), unrelated category ...-05 (NULL mode, NULL parent -> QUANTITY).
-- For the RLS block: a second org ...-06 with its own manager ...-07, a staff
-- member ...-08 in the first org, and an org-private scale ...-09 owned by the
-- SECOND org.
--
-- Anti-vacuity: assertion 6 proves the child really has a NULL tracking_mode,
-- so the inheritance assertions are not passing on a stamped value.
--
-- Assertion map (39):
--    1-5   the five new categories columns exist
--    6     fixture check: the child's tracking_mode really is NULL
--    7-9   the tracking-mode inheritance resolver (own / inherited / default)
--   10-11  the counting-unit resolver (inherited / default)
--   12-13  neither SECURITY DEFINER resolver is callable by anon
--   14-16  the resolvers' TENANT GUARD: a member of another org reads NULL from
--          both, and the org's own member still resolves (the guard refuses
--          strangers, not everyone)
--   17-18  the two CHECK constraints reject nonsense
--   19-28  the seeded system scales: exact row counts AND exact printed labels
--          at pinned sort_orders, so a regression in the label expression
--          cannot slide past a >= check
--   29-34  RLS (system scale readable, its values readable through the
--          composed policy, cross-org invisible, only a manager+ may write,
--          and nobody may forge a system scale)
--   35-39  size_scale_values WRITE is the SAME predicate as size_scales:
--          refused without sports:manage, allowed with it (insert AND update),
--          and still refused on a built-in SYSTEM scale
--
-- Namespace: 5c294000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(39);

\set org    '\'5c294000-0000-0000-0000-000000000001\''
\set admin  '\'5c294000-0000-0000-0000-000000000002\''
\set parent '\'5c294000-0000-0000-0000-000000000003\''
\set child  '\'5c294000-0000-0000-0000-000000000004\''
\set plain  '\'5c294000-0000-0000-0000-000000000005\''
\set orgB   '\'5c294000-0000-0000-0000-000000000006\''
\set mgrB   '\'5c294000-0000-0000-0000-000000000007\''
\set stf    '\'5c294000-0000-0000-0000-000000000008\''
\set scaleB '\'5c294000-0000-0000-0000-000000000009\''
\set scaleA '\'5c294000-0000-0000-0000-00000000000a\''
\set sysAp  '\'5ca1e000-0000-0000-0000-000000000001\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:admin, 'admin-0294@test.local', '{}'::jsonb),
  (:mgrB,  'mgrB-0294@test.local',  '{}'::jsonb),
  (:stf,   'staff-0294@test.local', '{}'::jsonb) on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:org,  'Sports 0294 Org', 'sports-0294-org'),
  (:orgB, 'Other 0294 Org',  'other-0294-org') on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org,  :admin, 'admin',   now()),
  (:org,  :stf,   'staff',   now()),
  (:orgB, :mgrB,  'manager', now()) on conflict do nothing;

insert into public.categories (id, organization_id, name, tracking_mode, default_unit_of_measure)
  values (:parent, :org, 'Sports', 'QUANTITY_BY_VARIANT', 'pair')
  on conflict (id) do nothing;
insert into public.categories (id, organization_id, parent_id, name, sports_subcategory_key)
  values (:child, :org, :parent, 'Shoes', 'shoes')
  on conflict (id) do nothing;
insert into public.categories (id, organization_id, name)
  values (:plain, :org, 'Office Supplies')
  on conflict (id) do nothing;

-- An org-PRIVATE scale owned by the OTHER org. Only used by the RLS block.
insert into public.size_scales (id, organization_id, key, name, kind)
  values (:scaleB, :orgB, 'orgb_private', 'Org B private scale', 'custom')
  on conflict (id) do nothing;

-- An org-A scale with a KNOWN id, so the size_scale_values write block can aim
-- at it. Seeded as superuser: the point under test is who may put VALUES in a
-- scale, not who may create the scale (that is assertions 32-34).
insert into public.size_scales (id, organization_id, key, name, kind)
  values (:scaleA, :org, 'org_a_values', 'Org A values scale', 'apparel_alpha')
  on conflict (id) do nothing;

-- ── Schema shape ────────────────────────────────────────────────────────────
select has_column('public', 'categories', 'tracking_mode', 'categories.tracking_mode exists');
select has_column('public', 'categories', 'size_scale_id', 'categories.size_scale_id exists');
select has_column('public', 'categories', 'default_unit_of_measure', 'categories.default_unit_of_measure exists');
select has_column('public', 'categories', 'sports_subcategory_key', 'categories.sports_subcategory_key exists');
select has_column('public', 'categories', 'tracking_profile', 'categories.tracking_profile exists');

-- ── Anti-vacuity: the child genuinely has no mode of its own ────────────────
select is(
  (select tracking_mode from public.categories where id = :child),
  null,
  'fixture check: the child category has a NULL tracking_mode (inheritance is really under test)');

-- ── Inheritance resolver ────────────────────────────────────────────────────
-- Both resolvers now carry a tenant guard (`is_org_member(c.organization_id)`),
-- so they need a real identity to resolve anything at all — a claim-less caller
-- reads NULL, by design. Adopt the org-A admin for the rest of the file; the
-- blocks below override the claim where they need a different actor. The DB role
-- stays superuser here: the guard is inside the function body, not an RLS
-- policy, so it binds regardless of role and this block is testing the body.
set local "request.jwt.claim.sub" to '5c294000-0000-0000-0000-000000000002';

select is(
  public.category_tracking_mode(:parent),
  'QUANTITY_BY_VARIANT',
  'a category with its own mode resolves to that mode');

select is(
  public.category_tracking_mode(:child),
  'QUANTITY_BY_VARIANT',
  'a child with NULL mode inherits its parent (subcategories via the dormant parent_id)');

select is(
  public.category_tracking_mode(:plain),
  'QUANTITY',
  'a category with no mode and no parent reads as QUANTITY — today''s behaviour, unchanged');

select is(
  public.category_default_uom(:child),
  'pair',
  'the child inherits the parent''s counting unit (PAIR rides the existing uom)');

select is(
  public.category_default_uom(:plain),
  'unit',
  'an unconfigured category still counts in ''unit'' — existing orgs unaffected');

-- ── The resolvers are NOT reachable by an unauthenticated caller ────────────
-- Both are SECURITY DEFINER, so they read `categories` with the owner's rights
-- and RLS never applies. PostgreSQL grants EXECUTE to PUBLIC by default and
-- PostgREST publishes anything executable as an RPC, so without the explicit
-- REVOKE in 0294 an anon POST to /rest/v1/rpc/category_tracking_mode would
-- return a FOREIGN org's tracking policy. anon inherits PUBLIC, so these two
-- assertions prove the revoke from BOTH grantees landed.
select ok(
  not has_function_privilege('anon', 'public.category_tracking_mode(uuid)', 'execute'),
  'anon holds no EXECUTE on category_tracking_mode (SECURITY DEFINER not exposed as a public RPC)');

select ok(
  not has_function_privilege('anon', 'public.category_default_uom(uuid)', 'execute'),
  'anon holds no EXECUTE on category_default_uom (SECURITY DEFINER not exposed as a public RPC)');

-- ── 14-16. The resolvers' TENANT GUARD ──────────────────────────────────────
-- The revoke proved above stops an UNAUTHENTICATED caller. It does nothing about
-- an authenticated one: `authenticated` is ONE shared database role for every
-- tenant in the system, and PostgREST publishes both functions as RPCs, so org
-- B's manager can POST /rest/v1/rpc/category_tracking_mode with a guessed uuid.
-- SECURITY DEFINER means the RLS on `categories` that would normally stop that
-- read is bypassed, so the org boundary has to live inside the function body.
--
-- A stranger gets NULL — byte-identical to a nonexistent or soft-deleted
-- category — so nothing about org A's category is disclosed, not even that it
-- exists.
set local "request.jwt.claim.sub" to '5c294000-0000-0000-0000-000000000007'; -- org B's manager

select is(
  public.category_tracking_mode(:parent),
  null,
  'a member of ANOTHER org reads NULL from category_tracking_mode (no foreign tracking policy)');

select is(
  public.category_default_uom(:parent),
  null,
  'a member of ANOTHER org reads NULL from category_default_uom (no foreign counting unit)');

-- Anti-vacuity for the two above: the guard refuses STRANGERS, not everyone. If
-- it were simply broken (always NULL) this assertion fails and the pair above
-- would have been passing for the wrong reason.
set local "request.jwt.claim.sub" to '5c294000-0000-0000-0000-000000000002'; -- back to org A

select is(
  public.category_tracking_mode(:parent),
  'QUANTITY_BY_VARIANT',
  'the org''s OWN member still resolves the mode (the tenant guard is not a blanket refusal)');

-- ── CHECK constraints reject nonsense ───────────────────────────────────────
select throws_ok(
  $$ update public.categories
       set tracking_mode = 'TOTALLY_MADE_UP'
     where id = '5c294000-0000-0000-0000-000000000005' $$,
  '23514',
  null,
  'an unknown tracking_mode is rejected by the CHECK');

select throws_ok(
  $$ update public.categories
       set default_unit_of_measure = 'furlong'
     where id = '5c294000-0000-0000-0000-000000000005' $$,
  '23514',
  null,
  'an unknown counting unit is rejected by the CHECK');

-- ── Seeded system scales ────────────────────────────────────────────────────
select is(
  (select count(*)::int from public.size_scales where organization_id is null),
  4,
  'four built-in system size scales are seeded');

select ok(
  (select count(*) from public.size_scale_values v
     join public.size_scales s on s.id = v.size_scale_id
    where s.key = 'apparel_alpha') >= 14,
  'the apparel scale carries every letter size the app can render today');

select ok(
  (select count(*) from public.size_scale_values v
     join public.size_scales s on s.id = v.size_scale_id
    where s.key = 'us_mens_shoe' and v.is_half) > 0,
  'numeric shoe scales include half sizes');

-- ── Exact seed shape ────────────────────────────────────────────────────────
-- The counts above are open-ended (>=, >0) and would survive a generate_series
-- that produced the wrong span. These pin the real numbers: US Men's / Women's
-- run 4.0-18.0 in half steps = 29 values; US Youth runs 1.0-7.0 = 13.
-- Men's is 31 rather than 29 since migration 0319 added 3 and 3.5 at the owner's
-- request (L4L stocks small adult sizes; the Shoes category maps to this scale).
-- Women's still runs 4.0-18.0 = 29 — no category uses it today, so it was left
-- alone rather than widened on speculation.
select is(
  (select count(*)::int from public.size_scale_values v
     join public.size_scales s on s.id = v.size_scale_id
    where s.organization_id is null and s.key = 'us_mens_shoe'),
  31,
  'US Men''s shoe seeds exactly 31 values (3.0-18.0 in half steps, incl. 0319''s 3/3.5)');

select is(
  (select count(*)::int from public.size_scale_values v
     join public.size_scales s on s.id = v.size_scale_id
    where s.organization_id is null and s.key = 'us_womens_shoe'),
  29,
  'US Women''s shoe seeds exactly 29 values (4.0-18.0 in half steps)');

select is(
  (select count(*)::int from public.size_scale_values v
     join public.size_scales s on s.id = v.size_scale_id
    where s.organization_id is null and s.key = 'us_youth_shoe'),
  13,
  'US Youth shoe seeds exactly 13 values (1.0-7.0 in half steps)');

-- LABEL FIDELITY. 0294 builds the printed value by integer division precisely
-- because to_char(size,'FM990.9') renders every WHOLE size as '9.' — a trailing
-- dot on the sticker. A count-only assertion passes with that bug intact, so
-- pin the exact text at known sort_orders (sort_order = size * 10).
select is(
  (select v.value from public.size_scale_values v
     join public.size_scales s on s.id = v.size_scale_id
    where s.organization_id is null and s.key = 'us_mens_shoe' and v.sort_order = 100),
  '10',
  'a whole size prints as ''10'' — no trailing dot (the to_char regression)');

select is(
  (select v.value from public.size_scale_values v
     join public.size_scales s on s.id = v.size_scale_id
    where s.organization_id is null and s.key = 'us_mens_shoe' and v.sort_order = 95),
  '9.5',
  'a half size prints as ''9.5''');

select is(
  (select v.value from public.size_scale_values v
     join public.size_scales s on s.id = v.size_scale_id
    where s.organization_id is null and s.key = 'us_youth_shoe' and v.sort_order = 70),
  '7',
  'the youth scale tops out at a bare ''7'' — the values carry no ''Y'' suffix');

select is(
  (select count(*)::int from public.size_scale_values v
     join public.size_scales s on s.id = v.size_scale_id
    where s.organization_id is null
      and (v.value like '%.' or v.normalized like '%.')),
  0,
  'not one seeded system size value ends in a trailing dot');

-- ── RLS on size_scales ──────────────────────────────────────────────────────
-- As the org-A ADMIN (rank 80, so has_org_role(org,'manager') is true).
set local "request.jwt.claim.sub" to '5c294000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select is(
  (select count(*)::int from public.size_scales where organization_id is null),
  4,
  'a member sees every built-in system scale (organization_id is null)');

select is(
  (select count(*)::int from public.size_scales where id = :scaleB),
  0,
  'a member cannot see ANOTHER org''s private scale (RLS isolation)');

-- The values must be readable too, not just the scale header. size_scale_values
-- has no organization_id of its own, so its SELECT policy re-derives visibility
-- through size_scales — and that inner lookup is itself under size_scales' RLS.
-- If that composition ever stops resolving, every size picker 403s.
select is(
  (select count(*)::int from public.size_scale_values v
     join public.size_scales s on s.id = v.size_scale_id
    where s.key = 'apparel_alpha'),
  14,
  'a member can read the values of a system scale (size_scale_values RLS composes through size_scales)');

select lives_ok(
  $$ insert into public.size_scales (organization_id, key, name, kind)
     values ('5c294000-0000-0000-0000-000000000001', 'org_a_custom', 'Org A custom', 'custom') $$,
  'a manager+ can create a scale owned by their own org');

select throws_ok(
  $$ insert into public.size_scales (organization_id, key, name, kind)
     values (null, 'forged_system', 'Forged system scale', 'custom') $$,
  '42501',
  null,
  'not even an admin can forge a SYSTEM scale (organization_id must be non-null)');

-- As a STAFF member of the same org (rank 40 — below manager, and no
-- sports:manage grant exists yet, so the write must be refused).
set local "request.jwt.claim.sub" to '5c294000-0000-0000-0000-000000000008';

select throws_ok(
  $$ insert into public.size_scales (organization_id, key, name, kind)
     values ('5c294000-0000-0000-0000-000000000001', 'staff_scale', 'Staff scale', 'custom') $$,
  '42501',
  null,
  'a staff member cannot create a size scale');

-- ── 35-39. size_scale_values WRITE uses the SAME predicate as size_scales ────
-- The defect this block pins: size_scales_insert / size_scales_update accept
-- `manager OR sports:manage`, but size_scale_values_write required manager. A
-- sports:manage grantee could therefore CREATE a size scale and never put a
-- single value in it — and a scale with no values is not a scale (the size
-- pickers read size_scale_values, not size_scales).
--
-- 35 is the baseline: plain staff, no sports:manage yet, refused.
select throws_ok(
  $$ insert into public.size_scale_values (size_scale_id, value, normalized, sort_order)
     values ('5c294000-0000-0000-0000-00000000000a', 'XS', 'XS', 10) $$,
  '42501',
  null,
  'plain staff cannot add a value to an org scale (the write gate is real)');

-- Grant sports:manage to the STAFF role in org A. Written as superuser because
-- role_permission_overrides_insert is admin+ and the actor here is staff — the
-- grant is the setup, not the thing under test.
reset role;
insert into public.role_permission_overrides (organization_id, role, permission, granted)
  values (:org, 'staff', 'sports:manage', true);

set local "request.jwt.claim.sub" to '5c294000-0000-0000-0000-000000000008';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 36. Anti-vacuity for the whole block: the grant really took effect, proved on
-- the size_scales side that already accepted sports:manage before this fix.
select lives_ok(
  $$ insert into public.size_scales (organization_id, key, name, kind)
     values ('5c294000-0000-0000-0000-000000000001', 'sports_mgr_scale', 'Sports manager scale', 'custom') $$,
  'a sports:manage grantee can create a size scale (unchanged behaviour)');

-- 37. THE FIX: the same grantee can now populate one.
select lives_ok(
  $$ insert into public.size_scale_values (size_scale_id, value, normalized, sort_order)
     values ('5c294000-0000-0000-0000-00000000000a', 'XS', 'XS', 10) $$,
  'a sports:manage grantee can add a value to their org''s scale (create AND populate)');

-- 38. FOR ALL means UPDATE too — fixing a mistyped size is part of populating.
select lives_ok(
  $$ update public.size_scale_values set sort_order = 5
     where size_scale_id = '5c294000-0000-0000-0000-00000000000a' and normalized = 'XS' $$,
  'a sports:manage grantee can correct a value they own');

-- 39. The org boundary is UNCHANGED by the widening: no rank and no permission
-- writes a value onto a built-in SYSTEM scale (organization_id is null). '7XL' is
-- deliberately outside the seeded apparel set so a pass cannot come from the
-- (size_scale_id, normalized) unique index instead of RLS.
select throws_ok(
  $$ insert into public.size_scale_values (size_scale_id, value, normalized, sort_order)
     values ('5ca1e000-0000-0000-0000-000000000001', '7XL', '7XL', 110) $$,
  '42501',
  null,
  'not even a sports:manage grantee can add a value to a built-in SYSTEM scale');

reset role;
select * from finish();
rollback;
