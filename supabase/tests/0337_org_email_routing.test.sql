-- supabase/tests/0337_org_email_routing.test.sql
-- Proves migration 0337 — per-org compose-email routing:
--
--   • STRUCTURE: the column and its shape-floor CHECK exist.
--   • CHECK FLOOR: unknown top-level keys, a feature entry missing 'cc', and
--     a non-object value are refused; NULL, '{}' and a full valid object are
--     admitted. (Address VALIDITY is deliberately not tested here — it is
--     enforced in TS at the branded factories; the CHECK is a shape floor.)
--   • RLS, inherited from organizations (zero new policies): a member reads
--     the column; an outsider sees zero rows. Write denial is pinned by
--     STATE, not by error (pattern #22 mindset): a non-admin member's UPDATE
--     succeeds as a statement but affects 0 rows and the value is unchanged;
--     an admin's UPDATE lands; an admin targeting a FOREIGN org affects 0
--     rows.
--   • SEED SHAPE: the exact jsonb_build_object expressions the migration
--     seeds prod with are admitted by the CHECK against fixture orgs. (The
--     PROD seed rows themselves cannot exist on a local reset; they are
--     verified post-push by a read-only SELECT against the linked db —
--     recorded in the PR as the deploy-verification step.)
--
-- HOW THE ROLES ARE SIMULATED — house convention (0191/0282/0322/0331):
-- `set local role` + request.jwt.claim.sub. Namespace: 03370000. Wrapped in
-- begin/rollback — nothing leaks.

begin;

-- Plan hand-count: 2 structure + 7 check-floor + 3 rls-read + 5 rls-write
-- + 2 seed-shape = 19.
select plan(19);

\set orgA   '\'03370000-0000-0000-0000-000000000001\''
\set orgB   '\'03370000-0000-0000-0000-000000000002\''
\set u_adm  '\'03370000-0000-0000-0000-0000000000a1\''
\set u_mem  '\'03370000-0000-0000-0000-0000000000a2\''
\set u_out  '\'03370000-0000-0000-0000-0000000000a3\''

-- ── Fixtures (superuser: RLS bypassed) ───────────────────────────────────────

insert into auth.users (id, email, raw_user_meta_data) values
  (:u_adm, 'admin-0337@test.local',    '{}'::jsonb),
  (:u_mem, 'member-0337@test.local',   '{}'::jsonb),
  (:u_out, 'outsider-0337@test.local', '{}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgA, 'Routing Org 0337',         'routing-org-0337'),
  (:orgB, 'Routing Foreign Org 0337', 'routing-foreign-org-0337')
on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :u_adm, 'admin',  now()),
  (:orgA, :u_mem, 'viewer', now()),
  (:orgB, :u_out, 'admin',  now())
on conflict do nothing;

-- A known starting value on orgA so write-denial pins have a literal to
-- assert against.
update public.organizations
   set email_routing = jsonb_build_object(
     'delivery_request', jsonb_build_object('to', 'seeded@fixture-0337.invalid',
                                            'cc', 'seeded-cc@fixture-0337.invalid'))
 where id = :orgA;

-- ══════════════════════════════════════════════════════════════════════════
-- 1. STRUCTURE
-- ══════════════════════════════════════════════════════════════════════════

select has_column('public', 'organizations', 'email_routing',
  '0337: organizations.email_routing exists');

select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.organizations'::regclass
      and conname  = 'organizations_email_routing_shape'
      and contype  = 'c'
  ),
  '0337: the shape-floor CHECK constraint exists'
);

-- ══════════════════════════════════════════════════════════════════════════
-- 2. CHECK FLOOR (superuser writes: RLS out of the way, the CHECK on trial)
-- ══════════════════════════════════════════════════════════════════════════

select throws_ok(
  format($$update public.organizations
             set email_routing = '{"purchasing": {"to":"a@b.invalid","cc":"c@d.invalid"}}'::jsonb
           where id = %L$$, :orgA),
  '23514', null,
  '0337 CHECK: an unknown top-level key is refused'
);

select throws_ok(
  format($$update public.organizations
             set email_routing = '{"delivery_request": {"to":"a@b.invalid"}}'::jsonb
           where id = %L$$, :orgA),
  '23514', null,
  '0337 CHECK: delivery_request missing "cc" is refused (the mandatory copy is not optional)'
);

select throws_ok(
  format($$update public.organizations
             set email_routing = '{"delivery_request": {"to":"a@b.invalid","cc":5}}'::jsonb
           where id = %L$$, :orgA),
  '23514', null,
  '0337 CHECK: a non-string cc is refused (the NULL-propagation trap, coalesced closed)'
);

select throws_ok(
  format($$update public.organizations
             set email_routing = '"just a string"'::jsonb
           where id = %L$$, :orgA),
  '23514', null,
  '0337 CHECK: a non-object column value is refused'
);

select lives_ok(
  format($$update public.organizations set email_routing = null where id = %L$$, :orgB),
  '0337 CHECK: NULL is admitted (unconfigured org)'
);

select lives_ok(
  format($$update public.organizations set email_routing = '{}'::jsonb where id = %L$$, :orgB),
  '0337 CHECK: an empty object is admitted (both features unset)'
);

select lives_ok(
  format($$update public.organizations
             set email_routing = '{"delivery_request":    {"to":"a@b.invalid","cc":"c@d.invalid","toName":"A","ccName":"C"},
                                   "maintenance_request": {"to":"a@b.invalid","cc":"c@d.invalid"}}'::jsonb
           where id = %L$$, :orgB),
  '0337 CHECK: a full two-feature object with optional names is admitted'
);

-- Reset orgB to NULL so the RLS pins below control every value they read.
update public.organizations set email_routing = null where id = :orgB;

-- ══════════════════════════════════════════════════════════════════════════
-- 3. RLS READ — inherited organizations_select (is_org_member)
-- ══════════════════════════════════════════════════════════════════════════

set local "request.jwt.claim.sub" to :u_mem;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select email_routing -> 'delivery_request' ->> 'to'
     from public.organizations where id = :orgA),
  'seeded@fixture-0337.invalid',
  '0337 RLS: an accepted MEMBER (viewer) reads the org''s routing through the new column'
);
select is(
  (select count(*) from public.organizations where id = :orgB),
  0::bigint,
  '0337 RLS: that member sees zero rows of a FOREIGN org'
);
reset role;

set local "request.jwt.claim.sub" to :u_out;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*) from public.organizations where id = :orgA),
  0::bigint,
  '0337 RLS: an org OUTSIDER sees zero rows (cannot read the routing at all)'
);
reset role;

-- ══════════════════════════════════════════════════════════════════════════
-- 4. RLS WRITE — pinned by STATE, not by error (pattern #22 mindset):
--    .update() under RLS "succeeds" with 0 rows; only the end state proves
--    anything.
-- ══════════════════════════════════════════════════════════════════════════

-- A non-admin member's update is a 0-row no-op.
set local "request.jwt.claim.sub" to :u_mem;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
with attempt as (
  update public.organizations
     set email_routing = jsonb_build_object(
       'delivery_request', jsonb_build_object('to', 'hijack@member-0337.invalid',
                                              'cc', 'hijack-cc@member-0337.invalid'))
   where id = :orgA
   returning id
)
select is((select count(*) from attempt), 0::bigint,
  '0337 RLS: a NON-ADMIN member''s UPDATE affects 0 rows');
reset role;

select is(
  (select email_routing -> 'delivery_request' ->> 'to'
     from public.organizations where id = :orgA),
  'seeded@fixture-0337.invalid',
  '0337 RLS: ...and the stored value is UNCHANGED (member write really was refused)'
);

-- An admin's update lands.
set local "request.jwt.claim.sub" to :u_adm;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
with attempt as (
  update public.organizations
     set email_routing = jsonb_build_object(
       'delivery_request', jsonb_build_object('to', 'admin-set@fixture-0337.invalid',
                                              'cc', 'admin-set-cc@fixture-0337.invalid'))
   where id = :orgA
   returning id
)
select is((select count(*) from attempt), 1::bigint,
  '0337 RLS: an ADMIN''s UPDATE affects exactly 1 row');

-- The same admin targeting the FOREIGN org is a 0-row no-op.
with attempt as (
  update public.organizations
     set email_routing = jsonb_build_object(
       'delivery_request', jsonb_build_object('to', 'cross-org@fixture-0337.invalid',
                                              'cc', 'cross-org-cc@fixture-0337.invalid'))
   where id = :orgB
   returning id
)
select is((select count(*) from attempt), 0::bigint,
  '0337 RLS: that admin targeting a FOREIGN org affects 0 rows');
reset role;

select is(
  (select email_routing -> 'delivery_request' ->> 'to'
     from public.organizations where id = :orgA),
  'admin-set@fixture-0337.invalid',
  '0337 RLS: the admin write is the value at rest'
);

-- ══════════════════════════════════════════════════════════════════════════
-- 5. SEED SHAPE — the migration's exact prod expressions pass the CHECK.
--    (Local resets have no prod orgs; the prod rows are verified post-push
--    by read-only SELECT against the linked db.)
-- ══════════════════════════════════════════════════════════════════════════

select lives_ok(
  format($$update public.organizations set email_routing = jsonb_build_object(
    'delivery_request', jsonb_build_object(
      'to', 'dc4@learn4life.org',
      'cc', 'arosas@cvwest.org',
      'toName', 'Fresno Warehouse DC4',
      'ccName', 'Andrew Rosas'),
    'maintenance_request', jsonb_build_object(
      'to', 'dc4@learn4life.org',
      'cc', 'arosas@cvwest.org',
      'toName', 'Fresno Warehouse DC4',
      'ccName', 'Andrew Rosas'))
  where id = %L$$, :orgA),
  '0337 seed: the L4L seed expression is admitted by the CHECK'
);

select lives_ok(
  format($$update public.organizations set email_routing = jsonb_build_object(
    'delivery_request', jsonb_build_object(
      'to', 'warehouse-demo@stockpilot-demo.invalid',
      'cc', 'manager-demo@stockpilot-demo.invalid',
      'toName', 'Demo Warehouse Intake',
      'ccName', 'Demo Warehouse Manager'),
    'maintenance_request', jsonb_build_object(
      'to', 'warehouse-demo@stockpilot-demo.invalid',
      'cc', 'manager-demo@stockpilot-demo.invalid',
      'toName', 'Demo Warehouse Intake',
      'ccName', 'Demo Warehouse Manager'))
  where id = %L$$, :orgB),
  '0337 seed: the Demo Co reserved-TLD seed expression is admitted by the CHECK'
);

select * from finish();
rollback;
