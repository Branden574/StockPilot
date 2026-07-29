-- supabase/tests/0307_edit_movement_note_sentinel_guard.test.sql
-- Proves migration 0307: edit_movement_note's system-managed guard keys on what
-- the row IS (a bare-UUID sentinel in `notes`), not on the pre-0231
-- `reason = 'receipt_line'` string.
--
-- 0274's suite already covers the permission gate, ledger immutability and the
-- cross-org denial; this file covers only the widened guard.
--
-- Proves:
--   (a) a pre-0231 'receipt_line' row is STILL refused (22023) — nothing that
--       was refused before this migration becomes allowed;
--   (b) a post-0231 `PO {number}` row whose note is the bare-UUID sentinel is
--       NOW refused. This is the gap 0307 closes: against the pre-0307 function
--       this assertion FAILS (the edit succeeds and the receipt link is gone);
--   (c) a `receipt_reversal` row with a sentinel note is refused, same reason;
--   (d) a sentinel padded with NON-SPACE whitespace (newline/tab) is refused.
--       This pins SQL/TS parity rather than asserting it in prose: the display
--       layer trims with JS `.trim()` (all whitespace), so a DB-side trim that
--       only handled spaces — Postgres' one-argument `btrim()` — would mask the
--       note in every UI while still letting the RPC overwrite it, which is the
--       exact hole this migration exists to close;
--   (e) an ORDINARY movement carrying a real user note is STILL editable — the
--       regression that matters, since the guard must not lock operators out of
--       their own notes;
--   (f) a note that merely CONTAINS a uuid inside a sentence is still editable —
--       the anchored shape test must not swallow prose.
--
-- Every refusal is paired with a read proving the sentinel survived, and every
-- success with a read proving the new note landed.
--
-- Run via `supabase test db`. Users are "become"d via request.jwt.claim.sub so
-- auth.uid() resolves inside the SECURITY DEFINER RPC. begin/rollback so
-- nothing leaks.

begin;

select plan(12);

\set org      '\'fd070000-0000-0000-0000-0000000000f1\''
\set mgr_id   '\'fd070000-0000-0000-0000-0000000000c1\''
\set item1    '\'fd070000-0000-0000-0000-000000000011\''
\set m_legacy '\'fd070000-0000-0000-0000-0000000000a1\''
\set m_po     '\'fd070000-0000-0000-0000-0000000000a2\''
\set m_rev    '\'fd070000-0000-0000-0000-0000000000a3\''
\set m_pad    '\'fd070000-0000-0000-0000-0000000000a4\''
\set m_plain  '\'fd070000-0000-0000-0000-0000000000a5\''
\set m_prose  '\'fd070000-0000-0000-0000-0000000000a6\''
-- The machine sentinels the receiving RPCs stash in `notes` (receipt ids).
\set rcpt1    '\'fd070000-0000-0000-0000-0000000000b1\''
\set rcpt2    '\'fd070000-0000-0000-0000-0000000000b2\''
\set rcpt3    '\'fd070000-0000-0000-0000-0000000000b3\''

-- ── Fixtures (seeded as superuser — RLS bypassed) ──────────────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr_id, 'mgr@mns.test', '{}'::jsonb);

insert into public.organizations (id, name, slug) values
  (:org, 'MNS Test Org', 'mns-test-org');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :mgr_id, 'manager', now());

insert into public.inventory_items (id, organization_id, sku, name) values
  (:item1, :org, 'MNS-1', 'MNS Item 1');

insert into public.stock_movements
  (id, organization_id, item_id, movement_type, quantity_change,
   previous_quantity, new_quantity, user_id, reason, notes)
values
  -- (a) pre-0231 writer: reason 'receipt_line', sentinel note.
  (:m_legacy, :org, :item1, 'receive_po', 3, 0, 3, :mgr_id, 'receipt_line', :rcpt1),
  -- (b) post-0231 writer (post_receipt_v2 since 0231/0296): reason is the PO
  --     display string, `notes` is STILL the receipt id. 0274's guard misses it.
  (:m_po,     :org, :item1, 'receive_po', 4, 3, 7, :mgr_id, 'PO 1042',    :rcpt2),
  -- (c) reverse_receipt: reason 'receipt_reversal', sentinel note.
  (:m_rev,    :org, :item1, 'remove',    -4, 7, 3, :mgr_id, 'receipt_reversal', :rcpt3),
  -- (d) a sentinel padded with a LEADING NEWLINE and a TRAILING TAB — not a
  --     space in sight. The TS side masks this (packages/core
  --     movement-note-sentinel.test.ts pins it), so the SQL side must refuse it.
  (:m_pad,    :org, :item1, 'receive_po', 2, 3, 5, :mgr_id, 'PO 1043',
   E'\n' || 'fd070000-0000-0000-0000-0000000000b4' || E'\t'),
  -- (e) an ordinary hand-written note — must stay editable.
  (:m_plain,  :org, :item1, 'adjust',     1, 3, 4, :mgr_id, 'manual_adjust',
   'counted short on the top shelf'),
  -- (f) prose that happens to contain a uuid — must stay editable.
  (:m_prose,  :org, :item1, 'adjust',     1, 4, 5, :mgr_id, 'manual_adjust',
   'swapped for fd070000-0000-0000-0000-0000000000b9 per Dana');

-- Become the manager for every case below (the permission gate is 0274's
-- business; here it must always PASS so the guard is what we are measuring).
set local "request.jwt.claim.sub" to 'fd070000-0000-0000-0000-0000000000c1';
set local "request.jwt.claim.role" to 'authenticated';

-- ── (a) pre-0231 'receipt_line' row → still refused ────────────────────────
set local role to 'authenticated';
select throws_ok(
  $$ select public.edit_movement_note('fd070000-0000-0000-0000-0000000000a1', 'overwrite the receipt ref') $$,
  '22023', null,
  'pre-0231 receipt_line note is STILL system-managed (22023)'
);
reset role;

select is(
  (select notes from public.stock_movements where id = :m_legacy),
  'fd070000-0000-0000-0000-0000000000b1',
  'receipt_line denial left the machine receipt reference UNCHANGED'
);

-- ── (b) post-0231 `PO {number}` row with a sentinel note → NOW refused ─────
-- THE GAP. Against the pre-0307 function this call SUCCEEDS (its guard only
-- tests reason = 'receipt_line'), so this assertion and the next one both fail
-- there — which is the point.
set local role to 'authenticated';
select throws_ok(
  $$ select public.edit_movement_note('fd070000-0000-0000-0000-0000000000a2', 'my own note') $$,
  '22023', null,
  'post-0231 PO row carrying a bare-uuid sentinel is NOW refused (22023)'
);
reset role;

select is(
  (select notes from public.stock_movements where id = :m_po),
  'fd070000-0000-0000-0000-0000000000b2',
  'PO row denial preserved the receipt link the sentinel carries'
);

-- ── (c) 'receipt_reversal' row with a sentinel note → refused ──────────────
set local role to 'authenticated';
select throws_ok(
  $$ select public.edit_movement_note('fd070000-0000-0000-0000-0000000000a3', 'reversal note') $$,
  '22023', null,
  'receipt_reversal row carrying a bare-uuid sentinel is refused (22023)'
);
reset role;

select is(
  (select notes from public.stock_movements where id = :m_rev),
  'fd070000-0000-0000-0000-0000000000b3',
  'receipt_reversal denial preserved its sentinel'
);

-- ── (d) sentinel padded with newline/tab → refused (SQL/TS trim parity) ────
-- Postgres' ONE-ARGUMENT btrim() strips spaces ONLY, while JS `.trim()` strips
-- all whitespace. A guard written with the one-arg form passes this row through
-- while every UI masks it — masked on screen, overwritable over the wire. This
-- assertion is what stops that from being true again.
set local role to 'authenticated';
select throws_ok(
  $$ select public.edit_movement_note('fd070000-0000-0000-0000-0000000000a4', 'sneak past the trim') $$,
  '22023', null,
  'sentinel padded with newline/tab (no spaces) is refused — SQL trim matches JS .trim()'
);
reset role;

select is(
  (select notes from public.stock_movements where id = :m_pad),
  E'\n' || 'fd070000-0000-0000-0000-0000000000b4' || E'\t',
  'whitespace-padded sentinel survived the denial byte-for-byte'
);

-- ── (e) ORDINARY movement with a real note → still editable ────────────────
-- The regression guard: widening to a shape test must not lock operators out of
-- notes they wrote themselves.
set local role to 'authenticated';
select lives_ok(
  $$ select public.edit_movement_note('fd070000-0000-0000-0000-0000000000a5', 'recounted — 4 on hand') $$,
  'ordinary movement with a user note is STILL editable'
);
reset role;

select is(
  (select notes from public.stock_movements where id = :m_plain),
  'recounted — 4 on hand',
  'ordinary note edit persisted'
);

-- ── (f) a uuid INSIDE a sentence → still editable ──────────────────────────
-- The shape test is anchored at both ends, so prose that mentions an id is not
-- a sentinel.
set local role to 'authenticated';
select lives_ok(
  $$ select public.edit_movement_note('fd070000-0000-0000-0000-0000000000a6', 'swapped again per Dana') $$,
  'note containing a uuid inside a sentence is STILL editable'
);
reset role;

select is(
  (select notes from public.stock_movements where id = :m_prose),
  'swapped again per Dana',
  'embedded-uuid note edit persisted'
);

select * from finish();
rollback;
