-- supabase/tests/0274_edit_movement_note.test.sql
-- Proves migration 0274: public.edit_movement_note(uuid, text) — the only
-- sanctioned mutation path into the append-only stock_movements ledger.
--
-- Proves:
--   (a) a viewer WITHOUT the permission is denied (42501);
--   (b) a viewer GRANTED movements:edit_notes via a user_permission_overrides
--       row succeeds, and ONLY the notes column changes;
--   (c) a manager succeeds (additive role gate) AND the ledger's
--       previous_quantity / new_quantity / quantity_change / movement_type /
--       user_id / created_at are all UNCHANGED — only notes moved;
--   (d) a cross-org movement (org1 manager reaching into org2) is denied.
--
-- Run via `supabase test db`. Users are "become"d via request.jwt.claim.sub so
-- auth.uid() resolves inside the SECURITY DEFINER RPC + has_permission().
-- begin/rollback so nothing leaks.

begin;

select plan(8);

\set org1     '\'fe000000-0000-0000-0000-0000000000f1\''
\set org2     '\'fe000000-0000-0000-0000-0000000000f2\''
\set mgr_id   '\'fe000000-0000-0000-0000-0000000000c1\''
\set nogrant  '\'fe000000-0000-0000-0000-0000000000d1\''
\set grant_id '\'fe000000-0000-0000-0000-0000000000d2\''
\set item1    '\'fe000000-0000-0000-0000-000000000011\''
\set item2    '\'fe000000-0000-0000-0000-000000000012\''
\set mov1     '\'fe000000-0000-0000-0000-0000000000a1\''
\set mov2     '\'fe000000-0000-0000-0000-0000000000a2\''

-- ── Fixtures (seeded as superuser — RLS bypassed) ──────────────────────────
-- auth.users insert fires on_auth_user_created → creates user_profiles rows
-- (needed by stock_movements.user_id + user_permission_overrides.user_id FKs).
insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr_id,   'mgr@mne.test',     '{}'::jsonb),
  (:nogrant,  'nogrant@mne.test', '{}'::jsonb),
  (:grant_id, 'grant@mne.test',   '{}'::jsonb);

insert into public.organizations (id, name, slug) values
  (:org1, 'MNE Test Org',  'mne-test-org'),
  (:org2, 'MNE Other Org', 'mne-other-org');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org1, :mgr_id,   'manager', now()),
  (:org1, :nogrant,  'viewer',  now()),
  (:org1, :grant_id, 'viewer',  now());
-- None of the three are members of org2 (cross-org guard fixture).

-- Items (minimal — all other columns default). item1 in org1, item2 in org2.
insert into public.inventory_items (id, organization_id, sku, name) values
  (:item1, :org1, 'MNE-1', 'MNE Item 1'),
  (:item2, :org2, 'MNE-2', 'MNE Item 2 (other org)');

-- Ledger rows with EXPLICIT, known values so the immutability assertion can
-- compare each non-notes column against a literal after the edits.
insert into public.stock_movements
  (id, organization_id, item_id, movement_type, quantity_change,
   previous_quantity, new_quantity, user_id, notes, created_at)
values
  (:mov1, :org1, :item1, 'add', 5, 10, 15, :mgr_id, 'seed note',
   '2026-01-01 00:00:00+00');

insert into public.stock_movements
  (id, organization_id, item_id, movement_type, quantity_change,
   previous_quantity, new_quantity, notes)
values
  (:mov2, :org2, :item2, 'add', 1, 0, 1, 'other org note');

-- Grant the movements:edit_notes permission to the granted viewer (user-level).
insert into public.user_permission_overrides (organization_id, user_id, permission, granted)
  values (:org1, :grant_id, 'movements:edit_notes', true);

-- ── (a) Viewer WITHOUT the permission → denied (42501) ─────────────────────
set local "request.jwt.claim.sub" to 'fe000000-0000-0000-0000-0000000000d1'; -- nogrant viewer
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  $$ select public.edit_movement_note('fe000000-0000-0000-0000-0000000000a1', 'hacker note') $$,
  '42501', null,
  'viewer WITHOUT movements:edit_notes is denied (42501)'
);
reset role;

-- ── (b) Granted viewer → succeeds; only notes changes ──────────────────────
set local "request.jwt.claim.sub" to 'fe000000-0000-0000-0000-0000000000d2'; -- granted viewer
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  $$ select public.edit_movement_note('fe000000-0000-0000-0000-0000000000a1', '  viewer-corrected  ') $$,
  'granted viewer CAN edit the movement note'
);
reset role;

-- Note was trimmed + persisted (superuser read, RLS bypassed).
select is(
  (select notes from public.stock_movements where id = :mov1),
  'viewer-corrected',
  'granted viewer edit: notes trimmed + persisted'
);

-- ── (c) Manager → succeeds (additive role gate) ────────────────────────────
set local "request.jwt.claim.sub" to 'fe000000-0000-0000-0000-0000000000c1'; -- manager
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  $$ select public.edit_movement_note('fe000000-0000-0000-0000-0000000000a1', 'manager-final') $$,
  'manager CAN edit the movement note (role gate)'
);
reset role;

-- Notes moved…
select is(
  (select notes from public.stock_movements where id = :mov1),
  'manager-final',
  'manager edit: notes updated'
);

-- …but NOTHING else did. Every quantity/type/actor/timestamp column still equals
-- its seeded literal — the append-only ledger's integrity is intact.
select ok(
  (select previous_quantity = 10
      and new_quantity = 15
      and quantity_change = 5
      and movement_type = 'add'
      and user_id = 'fe000000-0000-0000-0000-0000000000c1'::uuid
      and created_at = '2026-01-01 00:00:00+00'::timestamptz
     from public.stock_movements where id = :mov1),
  'ledger immutability: qty/type/actor/timestamp UNCHANGED — only notes moved'
);

-- ── (d) Cross-org movement → denied ────────────────────────────────────────
-- org1's manager is NOT a member of org2, so both gate terms fail → 42501.
set local "request.jwt.claim.sub" to 'fe000000-0000-0000-0000-0000000000c1'; -- org1 manager
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  $$ select public.edit_movement_note('fe000000-0000-0000-0000-0000000000a2', 'reach across orgs') $$,
  '42501', null,
  'cross-org movement is denied — no role/permission in the movement''s org'
);
reset role;

-- Cross-org row's note was never touched.
select is(
  (select notes from public.stock_movements where id = :mov2),
  'other org note',
  'cross-org denial left the other org''s movement note unchanged'
);

select * from finish();
rollback;
