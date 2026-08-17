-- supabase/tests/0338_export_presets.test.sql
-- Proves migration 0338 — org-shared Export Builder presets:
--
--   • STRUCTURE: table, case-insensitive name uniqueness index, config
--     shape-floor CHECK.
--   • CHECK FLOOR: a non-object config and a config missing its fieldKeys
--     array are refused (the NULL-propagation trap is coalesced closed); a
--     well-shaped config is admitted. (Field VALIDITY is deliberately not
--     tested here — the TS registry sanitizer is the gate; the CHECK is a
--     shape floor, the 0337 posture.)
--   • RLS READ: any accepted member (even viewer-rank staff) reads the org's
--     presets; an org outsider sees zero rows.
--   • RLS INSERT: an items:export holder (manager) inserts; a non-holder
--     (staff) is refused; a forged created_by is refused even for an admin;
--     an outsider is refused.
--   • RLS DELETE, pinned by STATE where the statement "succeeds" (pattern
--     #22 mindset — DELETE under RLS is a silent 0-row no-op): a non-creator
--     non-admin member deletes 0 rows and the row survives; the CREATOR
--     deletes their own; an ADMIN deletes someone else's; an outsider
--     deletes 0 rows.
--   • DUP NAME: same org + case-differing name is a 23505; the SAME name in
--     a DIFFERENT org is admitted (uniqueness is per-org).
--
-- HOW THE ROLES ARE SIMULATED — house convention (0191/0282/0322/0331/0337):
-- `set local role` + request.jwt.claim.sub. Namespace: 03380000. Wrapped in
-- begin/rollback — nothing leaks.

begin;

-- Plan hand-count: 3 structure + 3 check-floor + 2 rls-read + 4 rls-insert
-- + 5 rls-delete + 2 dup-name = 19.
select plan(19);

\set orgA  '\'03380000-0000-0000-0000-000000000001\''
\set orgB  '\'03380000-0000-0000-0000-000000000002\''
\set u_adm '\'03380000-0000-0000-0000-0000000000a1\''
\set u_mgr '\'03380000-0000-0000-0000-0000000000a2\''
\set u_stf '\'03380000-0000-0000-0000-0000000000a3\''
\set u_out '\'03380000-0000-0000-0000-0000000000a4\''
\set pA1   '\'03380000-0000-0000-0000-0000000000b1\''
\set pA2   '\'03380000-0000-0000-0000-0000000000b2\''
\set pA3   '\'03380000-0000-0000-0000-0000000000b3\''

-- ── Fixtures (superuser: RLS bypassed) ───────────────────────────────────────

insert into auth.users (id, email, raw_user_meta_data) values
  (:u_adm, 'admin-0338@test.local',    '{}'::jsonb),
  (:u_mgr, 'manager-0338@test.local',  '{}'::jsonb),
  (:u_stf, 'staff-0338@test.local',    '{}'::jsonb),
  (:u_out, 'outsider-0338@test.local', '{}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgA, 'Presets Org 0338',         'presets-org-0338'),
  (:orgB, 'Presets Foreign Org 0338', 'presets-foreign-org-0338')
on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :u_adm, 'admin',   now()),
  (:orgA, :u_mgr, 'manager', now()),
  (:orgA, :u_stf, 'staff',   now()),
  (:orgB, :u_out, 'admin',   now())
on conflict do nothing;

-- ══════════════════════════════════════════════════════════════════════════
-- 1. STRUCTURE
-- ══════════════════════════════════════════════════════════════════════════

select has_table('public', 'export_presets', '0338: export_presets exists');

select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename  = 'export_presets'
      and indexname  = 'export_presets_org_name_uniq'
      and indexdef like '%lower(name)%'
  ),
  '0338: the per-org case-insensitive name uniqueness index exists'
);

select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.export_presets'::regclass
      and conname  = 'export_presets_config_shape'
      and contype  = 'c'
  ),
  '0338: the config shape-floor CHECK constraint exists'
);

-- ══════════════════════════════════════════════════════════════════════════
-- 2. CHECK FLOOR (superuser writes: RLS out of the way, the CHECK on trial)
-- ══════════════════════════════════════════════════════════════════════════

select throws_ok(
  format($$insert into public.export_presets (organization_id, name, config, created_by)
           values (%L, 'Broken scalar', '"just a string"'::jsonb, %L)$$, :orgA, :u_mgr),
  '23514', null,
  '0338 CHECK: a non-object config is refused'
);

select throws_ok(
  format($$insert into public.export_presets (organization_id, name, config, created_by)
           values (%L, 'No field list', '{"itemTypeKind":"book"}'::jsonb, %L)$$, :orgA, :u_mgr),
  '23514', null,
  '0338 CHECK: a config missing its fieldKeys array is refused (the NULL-propagation trap, coalesced closed)'
);

-- The admitted insert doubles as fixture pA1 (created by the MANAGER) for
-- the read/delete pins below; pA2 is seeded silently alongside it.
select lives_ok(
  format($$insert into public.export_presets (id, organization_id, name, config, created_by)
           values (%L, %L, 'Fixture Alpha',
                   '{"itemTypeKind":"book","format":"pdf","fieldKeys":["name","isbn","quantity_on_hand"]}'::jsonb,
                   %L)$$, :pA1, :orgA, :u_mgr),
  '0338 CHECK: a well-shaped config is admitted'
);

insert into public.export_presets (id, organization_id, name, config, created_by)
values (:pA2, :orgA, 'Fixture Beta',
        '{"itemTypeKind":"other","fieldKeys":["name","sku"]}'::jsonb, :u_mgr);

-- ══════════════════════════════════════════════════════════════════════════
-- 3. RLS READ — every accepted member; outsiders see nothing
-- ══════════════════════════════════════════════════════════════════════════

set local "request.jwt.claim.sub" to :u_stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*) from public.export_presets where organization_id = :orgA),
  2::bigint,
  '0338 RLS: a plain MEMBER (staff, no items:export) reads the org''s presets'
);
reset role;

set local "request.jwt.claim.sub" to :u_out;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*) from public.export_presets where organization_id = :orgA),
  0::bigint,
  '0338 RLS: an org OUTSIDER sees zero rows'
);
reset role;

-- ══════════════════════════════════════════════════════════════════════════
-- 4. RLS INSERT — items:export is the gate, authorship cannot be forged
-- ══════════════════════════════════════════════════════════════════════════

-- A manager holds items:export by default (0207 seed) — the same permission
-- POST /api/inventory/export checks.
set local "request.jwt.claim.sub" to :u_mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  format($$insert into public.export_presets (id, organization_id, name, config, created_by)
           values (%L, %L, 'Manager saved',
                   '{"itemTypeKind":"book","fieldKeys":["name","isbn"]}'::jsonb, %L)$$,
         :pA3, :orgA, :u_mgr),
  '0338 RLS: an items:export HOLDER (manager) saves a preset'
);
reset role;

-- Staff holds no items:export (0207 seeds it to admin+manager only).
set local "request.jwt.claim.sub" to :u_stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  format($$insert into public.export_presets (organization_id, name, config, created_by)
           values (%L, 'Staff smuggle', '{"itemTypeKind":"book","fieldKeys":["name"]}'::jsonb, %L)$$,
         :orgA, :u_stf),
  '42501', null,
  '0338 RLS: a NON-HOLDER member (staff) cannot save a preset'
);
reset role;

-- Even an admin cannot attribute a preset to someone else.
set local "request.jwt.claim.sub" to :u_adm;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  format($$insert into public.export_presets (organization_id, name, config, created_by)
           values (%L, 'Forged author', '{"itemTypeKind":"book","fieldKeys":["name"]}'::jsonb, %L)$$,
         :orgA, :u_stf),
  '42501', null,
  '0338 RLS: a FORGED created_by is refused even for an admin'
);
reset role;

set local "request.jwt.claim.sub" to :u_out;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  format($$insert into public.export_presets (organization_id, name, config, created_by)
           values (%L, 'Cross-org smuggle', '{"itemTypeKind":"book","fieldKeys":["name"]}'::jsonb, %L)$$,
         :orgA, :u_out),
  '42501', null,
  '0338 RLS: an org OUTSIDER cannot insert into a foreign org'
);
reset role;

-- ══════════════════════════════════════════════════════════════════════════
-- 5. RLS DELETE — creator or admin; everyone else is a silent 0-row no-op
--    pinned by STATE (pattern #22 mindset)
-- ══════════════════════════════════════════════════════════════════════════

set local "request.jwt.claim.sub" to :u_stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
with attempt as (
  delete from public.export_presets where id = :pA1 returning id
)
select is((select count(*) from attempt), 0::bigint,
  '0338 RLS: a NON-CREATOR non-admin member''s DELETE affects 0 rows');
reset role;

select is(
  (select count(*) from public.export_presets where id = :pA1),
  1::bigint,
  '0338 RLS: ...and the row is STILL THERE (the delete really was refused)'
);

set local "request.jwt.claim.sub" to :u_mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
with attempt as (
  delete from public.export_presets where id = :pA1 returning id
)
select is((select count(*) from attempt), 1::bigint,
  '0338 RLS: the CREATOR deletes their own preset');
reset role;

set local "request.jwt.claim.sub" to :u_adm;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
with attempt as (
  delete from public.export_presets where id = :pA2 returning id
)
select is((select count(*) from attempt), 1::bigint,
  '0338 RLS: an ADMIN deletes another member''s preset');
reset role;

set local "request.jwt.claim.sub" to :u_out;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
with attempt as (
  delete from public.export_presets where id = :pA3 returning id
)
select is((select count(*) from attempt), 0::bigint,
  '0338 RLS: an org OUTSIDER''s DELETE affects 0 rows');
reset role;

-- ══════════════════════════════════════════════════════════════════════════
-- 6. DUP NAME — per-org, case-insensitive (superuser: the INDEX on trial)
-- ══════════════════════════════════════════════════════════════════════════

insert into public.export_presets (organization_id, name, config, created_by)
values (:orgA, 'Fixture Gamma',
        '{"itemTypeKind":"book","fieldKeys":["name"]}'::jsonb, :u_mgr);

select throws_ok(
  format($$insert into public.export_presets (organization_id, name, config, created_by)
           values (%L, 'fixture GAMMA', '{"itemTypeKind":"book","fieldKeys":["name"]}'::jsonb, %L)$$,
         :orgA, :u_adm),
  '23505', null,
  '0338 UNIQUE: a case-differing duplicate name in the SAME org is refused'
);

select lives_ok(
  format($$insert into public.export_presets (organization_id, name, config, created_by)
           values (%L, 'Fixture Gamma', '{"itemTypeKind":"book","fieldKeys":["name"]}'::jsonb, %L)$$,
         :orgB, :u_out),
  '0338 UNIQUE: the SAME name in a DIFFERENT org is admitted (uniqueness is per-org)'
);

select * from finish();
rollback;
