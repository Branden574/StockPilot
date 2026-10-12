-- supabase/tests/0400_item_display_groups.test.sql
-- pgTAP proof for migration 0400 (Group selected, slice G2): explicit display
-- groups on Items and Books, written only by apply_item_grouping, read under
-- the caller's RLS, never touching an item row, a SKU, a charter or stock.
--
-- NOT RUN at the authoring stage (desk only: the local stack is held by
-- another job). It runs at the test stage with `supabase test db`.
--
-- Personas (real `authenticated` calls with request.jwt.claim.sub), as 0399:
--   own    owner                 mgr    manager
--   stf    staff, whA with NO charter on the assignment = every charter there
--   stfCh  staff, whA + charter chA (reads whA's no-charter and chA records)
--   stfC   staff, whA + charter chC, which no record carries (reads whA's
--          no-charter records only)
--   stfNo  staff, whA, items:update revoked (user override false)
--   vwr    viewer, whA           vwrUp  viewer, whA, items:update granted
--   vwrCat viewer, whA, items:update granted, category-restricted to catA
--   dis    a disabled manager    mgrB   a manager of another org
--   nobody signed in, in no org; anon and service_role hold no EXECUTE.
--
-- G.  Grants and shape: both tables RLS on, SELECT only (authenticated and
--     service_role), no PUBLIC; the two SELECT policies; the keys (no person
--     key); every function's posture; no 40001/40P01, no dynamic SQL, the
--     INV-25 token, INV-33 (the INVOKER preview never names item_stock_levels);
--     the locks are NOWAIT only; the only functions that name the new tables
--     are 0400's own three (so no consumer: exchange, PO import, reports, Book
--     Order Totals, exports); apply writes only the two tables and audit_logs.
-- A.  The owner's case: two no-charter records on rack 15-A with DIFFERENT
--     SKUs (they cannot share a SKU there: 0234) are grouped without changing
--     either SKU; the answer's shape; the audit rows' shape; the request row;
--     both item rows byte-identical.
-- I.  Idempotency: the same key and body replays; another body under the key
--     is idempotency_conflict; a NEW key repeating the grouping (fresh or
--     stale screen) is a no-op naming the same group: never a second group.
-- C.  Charters and books: same SKU + same charter on two racks; chA + chB +
--     no charter together; two books on the same empty rack with different
--     ISBNs (a book group; barcodes untouched).
-- H.  Hidden records: a persona control; memberships and groups are readable
--     exactly as the records are; a group made only of records a persona
--     cannot read is invisible to it, name included; a hidden id is
--     item_not_found, the same answer as an unknown id; the preview names only
--     readable records and counts the rest; a category-restricted member.
-- P.  Permission: viewer, revoked staff, a viewer with items:update but no
--     write scope, actor mismatch, signed out, outsider, disabled member,
--     another org's manager; anon and service_role cannot execute.
-- E.  An existing group: add with the version, stale version, the no-op,
--     another item type, a group that is unknown, invisible or in another
--     organization; the 200-record bound.
-- M.  Moves: a record in another group is never moved silently
--     (membership_conflict); a stale screen is membership_changed; an
--     explicit per-record move moves it, bumps the source, records the
--     previous group, and closes a source left empty (and a closed group is
--     invisible and no target).
-- Y.  A product-family member joins only with the acknowledgement, and its
--     family and size are untouched.
-- R.  Refusals: kit, rental, mixed types, deleted, another org's record, every
--     shape case (duplicate ids included: two rack rows of one record are one
--     id), the key cases.
-- X.  Remove: one record (the group stays), a stale screen, a record no
--     longer in a group (no-op), the last records (the group closes and is
--     empty); charter staff removing what they can see leaves a hidden member
--     and its group in place.
-- N.  Rename: refused to someone who cannot edit every record (the words say
--     nothing about hidden ones); staff who can; a stale version; the same
--     name (no-op); trimming; invisible and other-org groups.
-- T.  The consistency trigger refuses a direct row of another item type, a
--     deleted record, or a closed group.
-- F.  Failure injection: a planted raise on the 3rd membership row, on the
--     audit insert, on the request insert, and on the source group's closing
--     each leaves NOTHING (no group, no membership, no audit row, no request
--     row); the first key then applies.
-- Z.  No inventory_items row changed (every column), no stock, reservation,
--     order line, return line or product family changed; 0234 holds and is
--     unchanged; refusals recorded nothing; every audit row belongs to a
--     recorded request; no open group without a live record, no row in a
--     closed group; the other organization is untouched.
--
-- NOWAIT busy (55P03) and two sessions grouping the same records need two
-- sessions: scripts/db-concurrency/0400_item_display_groups_races.sh.
--
-- Roles: fixtures as the test superuser (RLS bypassed, the API-role guards
-- exempt). begin/rollback: nothing leaks. Namespace 04000000.

begin;

select plan(68);

\set orgA   '\'04000000-0000-0000-0000-00000000000a\''
\set orgB   '\'04000000-0000-0000-0000-00000000000b\''
\set own    '\'04000000-0000-0000-0000-0000000000a0\''
\set mgr    '\'04000000-0000-0000-0000-0000000000a1\''
\set stf    '\'04000000-0000-0000-0000-0000000000a2\''
\set stfCh  '\'04000000-0000-0000-0000-0000000000a3\''
\set stfNo  '\'04000000-0000-0000-0000-0000000000a4\''
\set vwr    '\'04000000-0000-0000-0000-0000000000a5\''
\set vwrUp  '\'04000000-0000-0000-0000-0000000000a6\''
\set dis    '\'04000000-0000-0000-0000-0000000000a7\''
\set stfC   '\'04000000-0000-0000-0000-0000000000a8\''
\set vwrCat '\'04000000-0000-0000-0000-0000000000a9\''
\set mgrB   '\'04000000-0000-0000-0000-0000000000b1\''
\set nobody '\'04000000-0000-0000-0000-0000000000c1\''
\set whA    '\'04000000-0000-0000-0000-0000000000d1\''
\set whB    '\'04000000-0000-0000-0000-0000000000d2\''
\set chA    '\'04000000-0000-0000-0000-0000000000e1\''
\set chB    '\'04000000-0000-0000-0000-0000000000e2\''
\set chC    '\'04000000-0000-0000-0000-0000000000e3\''
\set catA   '\'04000000-0000-0000-0000-0000000000e8\''
\set catB   '\'04000000-0000-0000-0000-0000000000e7\''
\set grp    '\'04000000-0000-0000-0000-0000000000e9\''
-- Groups made by the fixtures (as the superuser): 200 records, and one in orgB.
\set gBig   '\'04000000-0000-0000-0000-0000000003b1\''
\set gB     '\'04000000-0000-0000-0000-0000000003b2\''
\set gNone  '\'04000000-0000-0000-0000-0000000003ff\''
-- The owner's case: same (no) charter, same rack 15-A, different SKUs.
\set d1     '\'04000000-0000-0000-0000-000000000101\''
\set d2     '\'04000000-0000-0000-0000-000000000102\''
-- Same SKU, same charter (chA), two racks.
\set s1     '\'04000000-0000-0000-0000-000000000111\''
\set s2     '\'04000000-0000-0000-0000-000000000112\''
-- Three charters: chA, chB, none.
\set c1     '\'04000000-0000-0000-0000-000000000121\''
\set c2     '\'04000000-0000-0000-0000-000000000122\''
\set c3     '\'04000000-0000-0000-0000-000000000123\''
-- Two books, same title, different ISBNs, both on an empty rack ('').
\set e1     '\'04000000-0000-0000-0000-000000000131\''
\set e2     '\'04000000-0000-0000-0000-000000000132\''
-- Two chB records (invisible to charter staff on chA or chC).
\set hb1    '\'04000000-0000-0000-0000-000000000141\''
\set hb2    '\'04000000-0000-0000-0000-000000000142\''
\set k1     '\'04000000-0000-0000-0000-000000000151\''
\set k2     '\'04000000-0000-0000-0000-000000000152\''
\set r1     '\'04000000-0000-0000-0000-000000000153\''
-- A product family (XS, S) and a plain record.
\set f1     '\'04000000-0000-0000-0000-000000000161\''
\set f2     '\'04000000-0000-0000-0000-000000000162\''
\set f3     '\'04000000-0000-0000-0000-000000000163\''
\set m1     '\'04000000-0000-0000-0000-000000000171\''
\set m2     '\'04000000-0000-0000-0000-000000000172\''
\set m3     '\'04000000-0000-0000-0000-000000000173\''
\set m4     '\'04000000-0000-0000-0000-000000000174\''
\set v1     '\'04000000-0000-0000-0000-000000000181\''
\set v2     '\'04000000-0000-0000-0000-000000000182\''
\set v3     '\'04000000-0000-0000-0000-000000000183\''
\set rm1    '\'04000000-0000-0000-0000-000000000191\''
\set rm2    '\'04000000-0000-0000-0000-000000000192\''
\set rm3    '\'04000000-0000-0000-0000-000000000193\''
-- Two categories (catA, catB) for the category-restricted member.
\set q1     '\'04000000-0000-0000-0000-0000000001a1\''
\set q2     '\'04000000-0000-0000-0000-0000000001a2\''
-- Rename: one no-charter record, one chB record.
\set n1     '\'04000000-0000-0000-0000-0000000001b1\''
\set n2     '\'04000000-0000-0000-0000-0000000001b2\''
-- Failure injection.
\set j1     '\'04000000-0000-0000-0000-0000000001c1\''
\set j2     '\'04000000-0000-0000-0000-0000000001c2\''
\set j3     '\'04000000-0000-0000-0000-0000000001c3\''
\set j4     '\'04000000-0000-0000-0000-0000000001c4\''
\set j5     '\'04000000-0000-0000-0000-0000000001c5\''
\set j6     '\'04000000-0000-0000-0000-0000000001c6\''
\set j7     '\'04000000-0000-0000-0000-0000000001c7\''
\set j8     '\'04000000-0000-0000-0000-0000000001c8\''
\set j9     '\'04000000-0000-0000-0000-0000000001c9\''
\set del    '\'04000000-0000-0000-0000-0000000001d1\''
\set dl2    '\'04000000-0000-0000-0000-0000000001d2\''
\set bx     '\'04000000-0000-0000-0000-0000000001f1\''
\set gone   '\'04000000-0000-0000-0000-0000000001ff\''
-- An order on s2 with a reservation and a return: grouping must leave them
-- byte-identical.
\set ord    '\'04000000-0000-0000-0000-0000000002a1\''
\set ordl   '\'04000000-0000-0000-0000-0000000002a2\''
\set ret    '\'04000000-0000-0000-0000-0000000002a4\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,    '0400-own@test.local',    '{}'::jsonb),
  (:mgr,    '0400-mgr@test.local',    '{}'::jsonb),
  (:stf,    '0400-stf@test.local',    '{}'::jsonb),
  (:stfCh,  '0400-stfch@test.local',  '{}'::jsonb),
  (:stfC,   '0400-stfc@test.local',   '{}'::jsonb),
  (:stfNo,  '0400-stfno@test.local',  '{}'::jsonb),
  (:vwr,    '0400-vwr@test.local',    '{}'::jsonb),
  (:vwrUp,  '0400-vwrup@test.local',  '{}'::jsonb),
  (:dis,    '0400-dis@test.local',    '{}'::jsonb),
  (:vwrCat, '0400-vwrcat@test.local', '{}'::jsonb),
  (:mgrB,   '0400-mgrb@test.local',   '{}'::jsonb),
  (:nobody, '0400-nobody@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, '0400 Groups A', '0400-groups-a'),
  (:orgB, '0400 Groups B', '0400-groups-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,    'owner',   now()),
  (:orgA, :mgr,    'manager', now()),
  (:orgA, :stf,    'staff',   now()),
  (:orgA, :stfCh,  'staff',   now()),
  (:orgA, :stfC,   'staff',   now()),
  (:orgA, :stfNo,  'staff',   now()),
  (:orgA, :vwr,    'viewer',  now()),
  (:orgA, :vwrUp,  'viewer',  now()),
  (:orgA, :dis,    'manager', now()),
  (:orgA, :vwrCat, 'viewer',  now()),
  (:orgB, :mgrB,   'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, '0400 Main',  'WH-0400A', 'active'),
  (:whB, :orgB, '0400 Other', 'WH-0400B', 'active');
insert into public.charters (id, organization_id, name, code, status) values
  (:chA, :orgA, '0400 North', 'C0400N', 'active'),
  (:chB, :orgA, '0400 South', 'C0400S', 'active'),
  (:chC, :orgA, '0400 East',  'C0400E', 'active');
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values
  (:orgA, :whA, :chA),
  (:orgA, :whA, :chB),
  (:orgA, :whA, :chC);
insert into public.categories (id, organization_id, name) values
  (:catA, :orgA, '0400 Gear'),
  (:catB, :orgA, '0400 Other gear');
insert into public.product_groups (id, organization_id, name, group_key, default_counting_unit)
  values (:grp, :orgA, '0400 Family', '0400|family', 'each');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, charter_id, is_primary) values
  (:orgA, :stf,    :whA, null, true),
  (:orgA, :stfCh,  :whA, :chA, true),
  (:orgA, :stfC,   :whA, :chC, true),
  (:orgA, :stfNo,  :whA, null, true),
  (:orgA, :vwr,    :whA, null, true),
  (:orgA, :vwrUp,  :whA, null, true),
  (:orgA, :vwrCat, :whA, null, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :stfNo,  'items:update', false),
  (:orgA, :vwrUp,  'items:update', true),
  (:orgA, :vwrCat, 'items:update', true);
insert into public.user_category_assignments (organization_id, user_id, category_id) values
  (:orgA, :vwrCat, :catA);

insert into public.inventory_items
  (id, organization_id, warehouse_id, charter_id, category_id, item_type, sku, name, barcode, bin_location,
   quantity_on_hand, status, is_bundle, is_rental, group_id, variant_size, created_at, deleted_at) values
  (:d1,  :orgA, :whA, null, :catA, 'product', 'X0400-POLO-A', 'Polo XXXL',     null,            '15-A', 3, 'active', false, false, null, null, '2026-01-01T00:00:00Z', null),
  (:d2,  :orgA, :whA, null, :catA, 'product', 'X0400-POLO-B', 'Polo XXXL',     null,            '15-A', 2, 'active', false, false, null, null, '2026-01-02T00:00:00Z', null),
  (:s1,  :orgA, :whA, :chA, :catA, 'product', 'X0400-SAME',   'Same SKU',      null,            '1-A',  4, 'active', false, false, null, null, '2026-01-01T00:00:00Z', null),
  (:s2,  :orgA, :whA, :chA, :catA, 'product', 'X0400-SAME',   'Same SKU',      null,            '2-A',  5, 'active', false, false, null, null, '2026-01-02T00:00:00Z', null),
  (:c1,  :orgA, :whA, :chA, :catA, 'product', 'X0400-C1',     'Charter north', null,            '1-B',  1, 'active', false, false, null, null, '2026-01-01T00:00:00Z', null),
  (:c2,  :orgA, :whA, :chB, :catA, 'product', 'X0400-C2',     'Charter south', null,            '2-B',  1, 'active', false, false, null, null, '2026-01-02T00:00:00Z', null),
  (:c3,  :orgA, :whA, null, :catA, 'product', 'X0400-C3',     'No charter',    null,            '3-B',  1, 'active', false, false, null, null, '2026-01-03T00:00:00Z', null),
  (:e1,  :orgA, :whA, null, :catA, 'book',    'X0400-E1',     'Earth Science', '9780000000017', '',     6, 'active', false, false, null, null, '2026-01-01T00:00:00Z', null),
  (:e2,  :orgA, :whA, null, :catA, 'book',    'X0400-E2',     'Earth Science', '9780000000024', '',     7, 'active', false, false, null, null, '2026-01-02T00:00:00Z', null),
  (:hb1, :orgA, :whA, :chB, :catA, 'product', 'X0400-HB1',    'South one',     null,            '1-C',  1, 'active', false, false, null, null, '2026-01-01T00:00:00Z', null),
  (:hb2, :orgA, :whA, :chB, :catA, 'product', 'X0400-HB2',    'South two',     null,            '2-C',  1, 'active', false, false, null, null, '2026-01-02T00:00:00Z', null),
  (:k1,  :orgA, :whA, null, :catA, 'product', 'X0400-KIT',    'Kit',           null,            '1-D',  1, 'active', true,  false, null, null, '2026-01-01T00:00:00Z', null),
  (:k2,  :orgA, :whA, null, :catA, 'product', 'X0400-K2',     'Plain',         null,            '2-D',  1, 'active', false, false, null, null, '2026-01-02T00:00:00Z', null),
  (:r1,  :orgA, :whA, null, :catA, 'product', 'X0400-RENT',   'Rental',        null,            '3-D',  1, 'active', false, true,  null, null, '2026-01-03T00:00:00Z', null),
  (:f1,  :orgA, :whA, null, :catA, 'product', 'X0400-F-XS',   'Limits Tee - XS', null,          '1-E',  2, 'active', false, false, :grp, 'XS', '2026-01-01T00:00:00Z', null),
  (:f2,  :orgA, :whA, null, :catA, 'product', 'X0400-F-S',    'Limits Tee - S',  null,          '2-E',  2, 'active', false, false, :grp, 'S',  '2026-01-02T00:00:00Z', null),
  (:f3,  :orgA, :whA, null, :catA, 'product', 'X0400-F3',     'Plain tee',     null,            '3-E',  2, 'active', false, false, null, null, '2026-01-03T00:00:00Z', null),
  (:m1,  :orgA, :whA, null, :catA, 'product', 'X0400-M1',     'Move one',      null,            '1-F',  1, 'active', false, false, null, null, '2026-01-01T00:00:00Z', null),
  (:m2,  :orgA, :whA, null, :catA, 'product', 'X0400-M2',     'Move two',      null,            '2-F',  1, 'active', false, false, null, null, '2026-01-02T00:00:00Z', null),
  (:m3,  :orgA, :whA, null, :catA, 'product', 'X0400-M3',     'Move three',    null,            '3-F',  1, 'active', false, false, null, null, '2026-01-03T00:00:00Z', null),
  (:m4,  :orgA, :whA, null, :catA, 'product', 'X0400-M4',     'Move four',     null,            '4-F',  1, 'active', false, false, null, null, '2026-01-04T00:00:00Z', null),
  (:v1,  :orgA, :whA, null, :catA, 'product', 'X0400-V1',     'Version one',   null,            '1-G',  1, 'active', false, false, null, null, '2026-01-01T00:00:00Z', null),
  (:v2,  :orgA, :whA, null, :catA, 'product', 'X0400-V2',     'Version two',   null,            '2-G',  1, 'active', false, false, null, null, '2026-01-02T00:00:00Z', null),
  (:v3,  :orgA, :whA, null, :catA, 'product', 'X0400-V3',     'Version three', null,            '3-G',  1, 'active', false, false, null, null, '2026-01-03T00:00:00Z', null),
  (:rm1, :orgA, :whA, null, :catA, 'product', 'X0400-RM1',    'Remove one',    null,            '1-H',  1, 'active', false, false, null, null, '2026-01-01T00:00:00Z', null),
  (:rm2, :orgA, :whA, null, :catA, 'product', 'X0400-RM2',    'Remove two',    null,            '2-H',  1, 'active', false, false, null, null, '2026-01-02T00:00:00Z', null),
  (:rm3, :orgA, :whA, null, :catA, 'product', 'X0400-RM3',    'Remove three',  null,            '3-H',  1, 'active', false, false, null, null, '2026-01-03T00:00:00Z', null),
  (:q1,  :orgA, :whA, null, :catA, 'product', 'X0400-Q1',     'Category A',    null,            '1-J',  1, 'active', false, false, null, null, '2026-01-01T00:00:00Z', null),
  (:q2,  :orgA, :whA, null, :catB, 'product', 'X0400-Q2',     'Category B',    null,            '2-J',  1, 'active', false, false, null, null, '2026-01-02T00:00:00Z', null),
  (:n1,  :orgA, :whA, null, :catA, 'product', 'X0400-N1',     'Rename one',    null,            '1-K',  1, 'active', false, false, null, null, '2026-01-01T00:00:00Z', null),
  (:n2,  :orgA, :whA, :chB, :catA, 'product', 'X0400-N2',     'Rename two',    null,            '2-K',  1, 'active', false, false, null, null, '2026-01-02T00:00:00Z', null),
  (:j1,  :orgA, :whA, null, :catA, 'product', 'X0400-J1',     'Inject 1',      null,            '1-L',  1, 'active', false, false, null, null, '2026-01-01T00:00:00Z', null),
  (:j2,  :orgA, :whA, null, :catA, 'product', 'X0400-J2',     'Inject 2',      null,            '2-L',  1, 'active', false, false, null, null, '2026-01-02T00:00:00Z', null),
  (:j3,  :orgA, :whA, null, :catA, 'product', 'X0400-J3',     'Inject 3',      null,            '3-L',  1, 'active', false, false, null, null, '2026-01-03T00:00:00Z', null),
  (:j4,  :orgA, :whA, null, :catA, 'product', 'X0400-J4',     'Inject 4',      null,            '4-L',  1, 'active', false, false, null, null, '2026-01-04T00:00:00Z', null),
  (:j5,  :orgA, :whA, null, :catA, 'product', 'X0400-J5',     'Inject 5',      null,            '5-L',  1, 'active', false, false, null, null, '2026-01-05T00:00:00Z', null),
  (:j6,  :orgA, :whA, null, :catA, 'product', 'X0400-J6',     'Inject 6',      null,            '6-L',  1, 'active', false, false, null, null, '2026-01-06T00:00:00Z', null),
  (:j7,  :orgA, :whA, null, :catA, 'product', 'X0400-J7',     'Inject 7',      null,            '7-L',  1, 'active', false, false, null, null, '2026-01-07T00:00:00Z', null),
  (:j8,  :orgA, :whA, null, :catA, 'product', 'X0400-J8',     'Inject 8',      null,            '8-L',  1, 'active', false, false, null, null, '2026-01-08T00:00:00Z', null),
  (:j9,  :orgA, :whA, null, :catA, 'product', 'X0400-J9',     'Inject 9',      null,            '9-L',  1, 'active', false, false, null, null, '2026-01-09T00:00:00Z', null),
  (:del, :orgA, :whA, null, :catA, 'product', 'X0400-DEL',    'Deleted',       null,            '1-M',  0, 'active', false, false, null, null, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  (:dl2, :orgA, :whA, null, :catA, 'product', 'X0400-DL2',    'Live',          null,            '2-M',  1, 'active', false, false, null, null, '2026-01-02T00:00:00Z', null),
  (:bx,  :orgB, :whB, null, null,  'product', 'X0400-BX',     'Org B record',  null,            '1-N',  5, 'active', false, false, null, null, '2026-01-01T00:00:00Z', null);
-- 200 records in one group (the 200-record bound).
insert into public.inventory_items
  (id, organization_id, warehouse_id, charter_id, category_id, item_type, sku, name, bin_location, quantity_on_hand, status, created_at)
select ('04000000-0000-0000-0001-' || lpad(to_hex(n), 12, '0'))::uuid, :orgA, :whA, null, :catA, 'product',
       'X0400-BIG-' || n, 'Big ' || n, 'B-' || n, 1, 'active', '2026-01-01T00:00:00Z'
  from generate_series(1, 200) n;
insert into public.item_display_groups (id, organization_id, item_type, name) values
  (:gBig, :orgA, 'product', '0400 Big group'),
  (:gB,   :orgB, 'product', '0400 Org B group');
insert into public.item_display_group_members (item_id, organization_id, group_id)
select ('04000000-0000-0000-0001-' || lpad(to_hex(n), 12, '0'))::uuid, :orgA, :gBig from generate_series(1, 200) n;
insert into public.item_display_group_members (item_id, organization_id, group_id) values (:bx, :orgB, :gB);

-- An order on s2 with a reservation and a return.
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, requester_name, fulfillment_type) values
  (:ord, :orgA, :whA, 'approved', 'internal', :own, 'Own Person', 'pickup');
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, quantity_fulfilled) values
  (:ordl, :ord, :s2, 2, 1);
insert into public.stock_reservations (organization_id, item_id, warehouse_id, order_request_id, quantity) values
  (:orgA, :s2, :whA, :ord, 1);
insert into public.returns (id, organization_id, order_request_id, status) values
  (:ret, :orgA, :ord, 'requested');
insert into public.return_lines (return_id, organization_id, order_request_line_id, item_id, quantity, disposition) values
  (:ret, :orgA, :ordl, :s2, 1, 'restock');

-- The disabled manager, disabled the way the service does it.
set local role to 'service_role';
update public.user_profiles set disabled_at = now(), disabled_reason = 'policy_violation' where id = :dis;
reset role;

-- One call as a role and a user. Answers the result as text, or
-- ERR:<sqlstate>:<hint>:<detail> (a failed call's subtransaction is rolled
-- back, so it wrote nothing).
create function pg_temp.run(p_as text, p_sub uuid, p_sql text) returns text language plpgsql as $$
declare v_state text; v_hint text; v_detail text; v text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('role', p_as, true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint, v_detail = pg_exception_detail;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    return 'ERR:' || v_state || ':' || coalesce(v_hint, '') || ':' || coalesce(v_detail, '');
  end;
  return coalesce(v, 'null');
end $$;
-- The memberships now, for a request's expected_groups (read as the superuser).
create function pg_temp.cur(p_ids uuid[]) returns jsonb language sql as $$
  select coalesce(jsonb_object_agg(u.id::text, m.group_id), '{}'::jsonb)
    from unnest(p_ids) u(id) left join public.item_display_group_members m on m.item_id = u.id
$$;
create function pg_temp.new_t(p_name text) returns jsonb language sql as $$
  select jsonb_build_object('kind', 'new', 'name', p_name)
$$;
create function pg_temp.old_t(p_gid uuid, p_ver integer default null) returns jsonb language sql as $$
  select jsonb_build_object('kind', 'existing', 'group_id', p_gid,
                            'expected_version', coalesce(p_ver, (select g.version from public.item_display_groups g where g.id = p_gid)))
$$;
-- A group request (snake_case, as core toGroupingRpcRequest builds it).
create function pg_temp.greq(p_actor uuid, p_ids uuid[], p_target jsonb, p_move uuid[] default null,
                             p_ack boolean default null, p_org uuid default '04000000-0000-0000-0000-00000000000a',
                             p_exp jsonb default null)
returns jsonb language sql as $$
  select jsonb_build_object('action', 'group', 'organization_id', p_org, 'actor_user_id', p_actor, 'surface', 'web',
                            'item_ids', to_jsonb(p_ids), 'target', p_target,
                            'expected_groups', coalesce(p_exp, pg_temp.cur(p_ids)))
         || case when p_move is null then '{}'::jsonb else jsonb_build_object('move_item_ids', to_jsonb(p_move)) end
         || case when p_ack is null then '{}'::jsonb else jsonb_build_object('acknowledge_product_family', p_ack) end
$$;
create function pg_temp.rreq(p_actor uuid, p_ids uuid[], p_exp jsonb default null) returns jsonb language sql as $$
  select jsonb_build_object('action', 'remove', 'organization_id', '04000000-0000-0000-0000-00000000000a',
                            'actor_user_id', p_actor, 'surface', 'app', 'item_ids', to_jsonb(p_ids),
                            'expected_groups', coalesce(p_exp, pg_temp.cur(p_ids)))
$$;
create function pg_temp.nreq(p_actor uuid, p_gid uuid, p_name text, p_ver integer default null) returns jsonb language sql as $$
  select jsonb_build_object('action', 'rename', 'organization_id', '04000000-0000-0000-0000-00000000000a',
                            'actor_user_id', p_actor, 'surface', 'web', 'group_id', p_gid,
                            'expected_version', coalesce(p_ver, (select g.version from public.item_display_groups g where g.id = p_gid)),
                            'name', p_name)
$$;
-- Key n.
create function pg_temp.k(p_n integer) returns text language sql as $$
  select '04009000-0000-4000-8000-' || lpad(to_hex(p_n), 12, '0')
$$;
create function pg_temp.ap(p_sub uuid, p_req jsonb, p_key text) returns text language sql as $$
  select pg_temp.run('authenticated', p_sub, format('select public.apply_item_grouping(%L::jsonb, %L)::text', p_req, p_key))
$$;
create function pg_temp.pv(p_sub uuid, p_ids uuid[], p_gid uuid default null) returns text language sql as $$
  select pg_temp.run('authenticated', p_sub, format('select public.item_grouping_preview(%L::jsonb)::text',
           jsonb_build_object('organization_id', '04000000-0000-0000-0000-00000000000a', 'item_ids', to_jsonb(p_ids))
           || case when p_gid is null then '{}'::jsonb else jsonb_build_object('group_id', p_gid) end))
$$;
-- sqlstate:hint of an ERR answer, or outcome/new-or-old/number of changes/replay.
create function pg_temp.brief(p text) returns text language sql as $$
  select case when p like 'ERR:%' then split_part(p, ':', 2) || ':' || split_part(p, ':', 3)
    else (p::jsonb->>'outcome') || '/' || case when (p::jsonb->>'created')::boolean then 'new' else 'old' end
         || '/' || jsonb_array_length(p::jsonb->'changes') || '/' || coalesce(p::jsonb->>'replay', '-') end
$$;
-- The itemIds of an ERR answer's detail, as id suffixes.
create function pg_temp.ids_of(p text) returns text language sql as $$
  select string_agg(right(v, 3), ',' order by v)
    from jsonb_array_elements_text(substr(p, length(split_part(p, ':', 1) || split_part(p, ':', 2) || split_part(p, ':', 3)) + 4)::jsonb->'itemIds') x(v)
$$;
-- The detail's reason of an ERR answer.
create function pg_temp.reason_of(p text) returns text language sql as $$
  select substr(p, length(split_part(p, ':', 1) || split_part(p, ':', 2) || split_part(p, ':', 3)) + 4)::jsonb->>'reason'
$$;
-- A record's group now (superuser), and a group by name.
create function pg_temp.gid(p_item uuid) returns uuid language sql as $$
  select m.group_id from public.item_display_group_members m where m.item_id = p_item
$$;
create function pg_temp.gnamed(p_name text) returns uuid language sql as $$
  select g.id from public.item_display_groups g where g.organization_id = '04000000-0000-0000-0000-00000000000a' and g.name = p_name
$$;
-- What a persona reads of these records (RLS), as id suffixes.
create function pg_temp.sees(p_sub uuid, p_ids uuid[]) returns text language sql as $$
  select pg_temp.run('authenticated', p_sub, format(
           'select string_agg(right(i.id::text, 3), %L order by i.id) from public.inventory_items i where i.id = any (%L::uuid[])',
           ',', p_ids))
$$;
-- How many of these records' memberships, and whether the group, a persona
-- reads (RLS): '<memberships>/<groups>'.
create function pg_temp.vis(p_sub uuid, p_ids uuid[], p_gid uuid) returns text language sql as $$
  select pg_temp.run('authenticated', p_sub, format(
           'select (select count(*) from public.item_display_group_members m where m.item_id = any (%L::uuid[]))::text'
           || ' || ''/'' || (select count(*) from public.item_display_groups g where g.id = %L)::text', p_ids, p_gid))
$$;
create function pg_temp.fp_full(p_org uuid) returns table (id uuid, j jsonb) language sql as $$
  select i.id, to_jsonb(i) from public.inventory_items i where i.organization_id = p_org
$$;

create temp table ans (tag text primary key, r text);
create temp table reqs (tag text primary key, r jsonb);
create temp table before_items as select * from pg_temp.fp_full(:orgA) union all select * from pg_temp.fp_full(:orgB);
create temp table before_stock as
  select (select md5(coalesce(string_agg(to_jsonb(s)::text, ',' order by s.item_id, s.location_id), ''))
            from public.item_stock_levels s where s.organization_id in (:orgA, :orgB)) as levels,
         (select md5(coalesce(string_agg(to_jsonb(m)::text, ',' order by m.id), ''))
            from public.stock_movements m where m.organization_id in (:orgA, :orgB)) as movements;
create temp table before_other as
  select (select md5(coalesce(string_agg(to_jsonb(r)::text, ',' order by r.id), ''))
            from public.stock_reservations r where r.organization_id in (:orgA, :orgB)) as reservations,
         (select md5(coalesce(string_agg(to_jsonb(l)::text, ',' order by l.id), ''))
            from public.order_request_lines l join public.order_requests o on o.id = l.order_request_id
           where o.organization_id in (:orgA, :orgB)) as order_lines,
         (select md5(coalesce(string_agg(to_jsonb(l)::text, ',' order by l.id), ''))
            from public.return_lines l where l.organization_id in (:orgA, :orgB)) as return_lines,
         (select md5(coalesce(string_agg(to_jsonb(g)::text, ',' order by g.id), ''))
            from public.product_groups g where g.organization_id in (:orgA, :orgB)) as product_groups,
         (select count(*) from public.stock_reservations r where r.organization_id = :orgA) as n_res,
         (select count(*) from public.return_lines l where l.organization_id = :orgA) as n_retl,
         pg_get_indexdef('public.inventory_items_org_sku_charter_bin_unique'::regclass) as idx0234;
create temp table before_b as
  select (select version from public.item_display_groups where id = :gB) as gb_version,
         (select count(*) from public.item_display_group_members where group_id = :gB) as gb_members,
         (select count(*) from public.audit_logs where organization_id = :orgB) as b_audit;
grant all on ans, reqs to authenticated;

-- Guard the fixtures: a silently missing row would let an assertion pass for
-- the wrong reason.
do $$ begin
  if (select count(*) from public.inventory_items where id::text like '04000000-%') <> 243 then
    raise exception 'fixture: items (%)', (select count(*) from public.inventory_items where id::text like '04000000-%');
  end if;
  if (select count(*) from public.item_display_group_members where group_id = '04000000-0000-0000-0000-0000000003b1') <> 200 then
    raise exception 'fixture: big group';
  end if;
  if (select count(*) from public.user_profiles where id::text like '04000000-%' and disabled_at is not null) <> 1 then
    raise exception 'fixture: disabled member';
  end if;
end $$;

-- ═══ G. Grants and shape ══════════════════════════════════════════════════
select is(
  (select string_agg(c.relname || '=' || c.relrowsecurity::text || '/' || c.relforcerowsecurity::text || '/'
                     || (select string_agg(r.r || ':' || coalesce((select string_agg(p.p, ',' order by p.p)
                                                                     from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p(p)
                                                                    where has_table_privilege(r.r, c.oid, p.p)), '-'), ' ' order by r.r)
                           from unnest(array['anon', 'authenticated', 'service_role']) r(r))
                     || '/' || (select count(*) from aclexplode(c.relacl) a where a.grantee = 0)::text, E'\n' order by c.relname)
     from pg_class c where c.oid in ('public.item_display_groups'::regclass, 'public.item_display_group_members'::regclass)),
  E'item_display_group_members=true/false/anon:- authenticated:SELECT service_role:SELECT/0\n'
  'item_display_groups=true/false/anon:- authenticated:SELECT service_role:SELECT/0',
  'G1: both tables have RLS on; authenticated and service_role (the manager''s cached loader) may only SELECT; anon and PUBLIC hold nothing; no API role can write');
select is(
  (select string_agg(pol.polrelid::regclass::text || ':' || pol.polname || ':' || pol.polcmd::text || ':' || pol.polpermissive::text
                     || ':' || (select string_agg(r.rolname, ',' order by r.rolname) from pg_roles r where r.oid = any (pol.polroles)), E'\n'
                     order by (pol.polrelid::regclass::text || ':' || pol.polname) collate "C")
     from pg_policy pol where pol.polrelid in ('public.item_display_groups'::regclass, 'public.item_display_group_members'::regclass)),
  E'item_display_group_members:item_display_group_members_select:r:true:authenticated\n'
  'item_display_groups:item_display_groups_select:r:true:authenticated',
  'G2: exactly one policy per table, a permissive SELECT for authenticated (no write policy)');
select is(
  (select string_agg(c.conrelid::regclass::text || ':' || pg_get_constraintdef(c.oid), E'\n'
                     order by (c.conrelid::regclass::text || ':' || pg_get_constraintdef(c.oid)) collate "C")
     from pg_constraint c
    where c.conrelid in ('public.item_display_groups'::regclass, 'public.item_display_group_members'::regclass)
      and c.contype in ('p', 'f', 'u'))
  || '|' || (select count(*) from pg_constraint c where c.conrelid = 'public.item_display_groups'::regclass and c.contype = 'c')::text,
  E'item_display_group_members:FOREIGN KEY (item_id) REFERENCES inventory_items(id) ON DELETE CASCADE\n'
  'item_display_group_members:FOREIGN KEY (organization_id, group_id) REFERENCES item_display_groups(organization_id, id) ON DELETE CASCADE\n'
  'item_display_group_members:PRIMARY KEY (item_id)\n'
  'item_display_groups:FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE\n'
  'item_display_groups:PRIMARY KEY (id)\n'
  'item_display_groups:UNIQUE (organization_id, id)|3',
  'G3: a record is in at most one group (the primary key is the item id); the group key carries the organization; everything cascades from the organization and the record; no key to a person (who did what is in audit_logs); three checks on a group (item type, name, version)');
select is(
  (select string_agg(p.proname || '=' || p.prosecdef || '/' || p.provolatile::text || '/' || coalesce(array_to_string(p.proconfig, ';'), '')
                     || '/' || has_function_privilege('authenticated', p.oid, 'EXECUTE')
                     || '/' || has_function_privilege('anon', p.oid, 'EXECUTE')
                     || '/' || has_function_privilege('service_role', p.oid, 'EXECUTE')
                     || '/' || pg_get_userbyid(p.proowner), E'\n' order by p.proname)
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('apply_item_grouping', 'item_grouping_preview', '_display_grouping_request',
                        '_display_grouping_apply', 'tg_item_display_group_members_consistency')),
  E'_display_grouping_apply=false/v/search_path=public, pg_temp/false/false/false/postgres\n'
  '_display_grouping_request=false/i/search_path=public, pg_temp/false/false/false/postgres\n'
  'apply_item_grouping=true/v/search_path=public, pg_temp;lock_timeout=5s/true/false/false/postgres\n'
  'item_grouping_preview=false/s/search_path=public, pg_temp/true/false/false/postgres\n'
  'tg_item_display_group_members_consistency=false/v/search_path=public, pg_temp/false/false/false/postgres',
  'G4: only the entry point is SECURITY DEFINER; it and the INVOKER preview are executable by authenticated alone; the private steps and the trigger function have no API EXECUTE; every one pins search_path; the entry point carries lock_timeout 5s');
select is(
  (select coalesce(string_agg(p.proname, ',' order by p.proname), '')
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('apply_item_grouping', 'item_grouping_preview', '_display_grouping_request',
                        '_display_grouping_apply', 'tg_item_display_group_members_consistency')
      and (p.prosrc ~* $re$errcode\s*=\s*'(40001|40p01|serialization_failure|deadlock_detected)'$re$
           or p.prosrc ~* $re$raise\s+(exception\s+)?(serialization_failure|deadlock_detected)\M$re$
           or regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\mexecute\M'
           or (p.prosecdef and p.prosrc !~* '(auth\.uid|has_org_role|has_permission|is_org_member)')
           or (not p.prosecdef and has_function_privilege('authenticated', p.oid, 'EXECUTE')
               and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\mitem_stock_levels\M'))),
  '',
  'G5: no 0400 function raises 40001/40P01 (0367) or runs dynamic SQL; the DEFINER entry point gates in its own body (INV-25); the INVOKER preview never names item_stock_levels (INV-33)');
select is(
  (select (p.prosrc ~ 'for share nowait')::text || '/' || (p.prosrc ~ 'for update nowait')::text
          || '/' || (p.prosrc ~* 'exception when lock_not_available')::text
          || '/' || (p.prosrc !~* 'for (update|share)(?! nowait)')::text
     from pg_proc p where p.oid = 'public._display_grouping_apply(uuid,uuid,jsonb,uuid,text,text)'::regprocedure),
  'true/true/true/true',
  'G6: the apply step takes row locks only with NOWAIT (the records FOR SHARE, the groups FOR UPDATE) and answers a held row as busy: it never waits on a row');
select is(
  (select string_agg(n.nspname || '.' || p.proname, ',' order by n.nspname || '.' || p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname not in ('pg_catalog', 'information_schema')
      and n.nspname !~ '^pg_(toast_)?temp_'
      and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'item_display_group'),
  'public._display_grouping_apply,public.item_grouping_preview,public.tg_item_display_group_members_consistency',
  'G7: no function outside 0400 reads display groups: not the exchange selector, PO import, Book Order Totals, the report RPCs, the stock functions or the order catalog (a group is never a family, a kit, a substitute or an identity)');
select is(
  (select string_agg(distinct lower(m[2]) collate "C", ',' order by lower(m[2]) collate "C")
     from pg_proc p, regexp_matches(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'),
                                    '(insert into|update|delete from)\s+public\.([a-z_]+)', 'gi') m
    where p.oid in ('public._display_grouping_apply(uuid,uuid,jsonb,uuid,text,text)'::regprocedure,
                    'public.apply_item_grouping(jsonb,text)'::regprocedure,
                    'public.item_grouping_preview(jsonb)'::regprocedure)),
  'audit_logs,item_display_group_members,item_display_groups',
  'G8: the grouping functions write only the two group tables and audit_logs (the request row goes through 0399''s _item_grouping_record): never inventory_items, stock, reservations, orders, returns or product_groups');

-- ═══ A. The owner's case ══════════════════════════════════════════════════
insert into reqs values ('a1', pg_temp.greq(:mgr, array[:d1, :d2]::uuid[], pg_temp.new_t('Polo XXXL')));
insert into ans select 'a1', pg_temp.ap(:mgr, (select r from reqs where tag = 'a1'), pg_temp.k(1));
select is(pg_temp.brief((select r from ans where tag = 'a1')), 'applied/new/2/false',
  'A1: the manager groups two no-charter records on rack 15-A that carry different SKUs: a new group with both, not a replay');
select is(
  (select g.name || '/' || g.item_type || '/' || g.version::text || '/' || coalesce(g.closed_at::text, 'open') || '/'
          || (select count(*) from public.item_display_group_members m where m.group_id = g.id)::text || '/'
          || (g.id::text = ((select r from ans where tag = 'a1')::jsonb #>> '{group,id}'))::text
     from public.item_display_groups g where g.id = pg_temp.gid(:d1))
  || '|' || (pg_temp.gid(:d1) = pg_temp.gid(:d2))::text
  || '|' || (select string_agg(i.sku || '@' || i.bin_location || '@' || coalesce(i.charter_id::text, 'none'), ',' order by i.id)
               from public.inventory_items i where i.id in (:d1, :d2)),
  'Polo XXXL/product/1/open/2/true|true|X0400-POLO-A@15-A@none,X0400-POLO-B@15-A@none',
  'A2: one open group of type product at version 1 holds both records, as answered; each keeps its own SKU, rack and (no) charter: no identifier was copied, no charter changed (0234 untouched)');
select is(
  (select string_agg(k, ',' order by k) from jsonb_object_keys((select r from ans where tag = 'a1')::jsonb) k)
  || '|' || (select string_agg(k, ',' order by k) from jsonb_object_keys((select r from ans where tag = 'a1')::jsonb -> 'group') k)
  || '|' || (select string_agg(k, ',' order by k) from jsonb_object_keys((select r from ans where tag = 'a1')::jsonb #> '{changes,0}') k),
  'action,changes,closed_group_ids,created,group,outcome,replay|closed,id,item_type,name,version|from_group_id,item_id,to_group_id',
  'A3: the answer is exactly {action, outcome, group, changes, closed_group_ids, created, replay}');
select is(
  (select string_agg(a.event || '/' || (a.metadata->>'entity_type') || '/'
                     || case when a.metadata->>'entity_type' = 'inventory_item' then right(a.metadata->>'entity_id', 3)
                             else ((a.metadata->>'entity_id') = pg_temp.gid(:d1)::text)::text end || '/'
                     || coalesce(a.metadata#>>'{before,display_group_id}', 'null') || '/'
                     || coalesce(a.metadata#>>'{after,display_group_name}', a.metadata#>>'{after,name}') || '/'
                     || coalesce(a.metadata->>'previous_group_closed', jsonb_array_length(a.metadata->'member_item_ids')::text) || '/'
                     || coalesce((a.metadata->'changed_keys')::text, 'none') || '/'
                     || (a.metadata->>'request_key') || '/' || (a.metadata->>'request_hash' ~ '^[0-9a-f]{32}$')::text || '/'
                     || (a.metadata->>'surface') || '/' || (a.metadata->>'source') || '/' || a.user_id::text || '/'
                     || coalesce(a.ip::text, 'null') || '/' || coalesce(a.user_agent, 'null'),
                     E'\n' order by a.event, a.metadata->>'entity_id')
     from public.audit_logs a where a.organization_id = :orgA and a.event like 'inventory.group.%'),
  'inventory.group.created/item_display_group/true/null/Polo XXXL/2/none/04009000-0000-4000-8000-000000000001/true/web/apply_item_grouping/04000000-0000-0000-0000-0000000000a1/null/null' || E'\n'
  || 'inventory.group.members_added/inventory_item/101/null/Polo XXXL/false/["display_group"]/04009000-0000-4000-8000-000000000001/true/web/apply_item_grouping/04000000-0000-0000-0000-0000000000a1/null/null' || E'\n'
  || 'inventory.group.members_added/inventory_item/102/null/Polo XXXL/false/["display_group"]/04009000-0000-4000-8000-000000000001/true/web/apply_item_grouping/04000000-0000-0000-0000-0000000000a1/null/null',
  'A4: one inventory.group.created row for the group and one inventory.group.members_added row per record (its previous group: none), as the manager, with the key, the hash, the surface; no ip or user agent (written in SQL, design R9)');
select is(
  (select count(*)::text || '/' || string_agg(r.action || '/' || (r.outcome ? 'replay')::text || '/' || (r.outcome->>'outcome'), ',')
     from public.item_grouping_requests r where r.organization_id = :orgA and r.user_id = :mgr and r.key = pg_temp.k(1)::uuid),
  '1/group/false/applied',
  'A5: one request row under the key (0399''s table): the action and the outcome as answered (without the replay flag)');
select is(
  (select coalesce(string_agg(right(a.id::text, 3), ','), '')
     from pg_temp.fp_full(:orgA) a join before_items b on b.id = a.id where a.id in (:d1, :d2) and a.j <> b.j),
  '',
  'A6: both item rows are byte-identical, every column (updated_at included): grouping writes no item row, so the "Recently updated" order and realtime are untouched');

-- ═══ I. Idempotency ═══════════════════════════════════════════════════════
insert into ans select 'i1', pg_temp.ap(:mgr, (select r from reqs where tag = 'a1'), pg_temp.k(1));
select is(
  pg_temp.brief((select r from ans where tag = 'i1')) || '/'
  || (((select r from ans where tag = 'i1')::jsonb - 'replay') = ((select r from ans where tag = 'a1')::jsonb - 'replay'))::text || '/'
  || (select count(*) from public.item_display_groups where organization_id = :orgA and name = 'Polo XXXL')::text || '/'
  || (select count(*) from public.audit_logs where organization_id = :orgA and event like 'inventory.group.%')::text,
  'applied/new/2/true/true/1/3',
  'I1: the same key and body replays the first answer (replay true): no second group, no new audit row');
select is(
  pg_temp.brief(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:d1, :d2]::uuid[], pg_temp.new_t('Polo shirts')), pg_temp.k(1))),
  'P0001:idempotency_conflict',
  'I2: another body under a spent key is idempotency_conflict');
insert into ans select 'i3', pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:d1, :d2]::uuid[], pg_temp.new_t('Polo XXXL')), pg_temp.k(2));
insert into ans select 'i4', pg_temp.ap(:mgr, (select r from reqs where tag = 'a1'), pg_temp.k(3));
select is(
  pg_temp.brief((select r from ans where tag = 'i3')) || '/'
  || (((select r from ans where tag = 'i3')::jsonb #>> '{group,id}') = pg_temp.gid(:d1)::text)::text || '|'
  || pg_temp.brief((select r from ans where tag = 'i4')) || '/'
  || (((select r from ans where tag = 'i4')::jsonb #>> '{group,id}') = pg_temp.gid(:d1)::text)::text || '|'
  || (select count(*) from public.item_display_groups where organization_id = :orgA and name = 'Polo XXXL')::text || '/'
  || (select count(*) from public.item_grouping_requests where key in (pg_temp.k(2)::uuid, pg_temp.k(3)::uuid))::text || '/'
  || (select count(*) from public.audit_logs where organization_id = :orgA and event like 'inventory.group.%')::text,
  'noop/old/0/false/true|noop/old/0/false/true|1/2/3',
  'I3: a NEW key repeating the grouping, from a fresh screen or from a second tab that still saw no group, is a no-op naming the same group: never a second group, no audit row (the no-op is recorded under its key)');

-- ═══ C. Charters and books ════════════════════════════════════════════════
insert into ans select 'c1', pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:c1, :c2, :c3]::uuid[], pg_temp.new_t('Charter mix')), pg_temp.k(10));
insert into ans select 'c2', pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:s1, :s2]::uuid[], pg_temp.new_t('Same SKU')), pg_temp.k(11));
insert into ans select 'c3', pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:e1, :e2]::uuid[], pg_temp.new_t('Earth Science')), pg_temp.k(12));
select is(
  pg_temp.brief((select r from ans where tag = 'c1')) || '/'
  || (select count(distinct m.group_id)::text || ':' || count(*)::text from public.item_display_group_members m where m.item_id in (:c1, :c2, :c3)) || '/'
  || (select string_agg(coalesce(i.charter_id::text, 'none'), ',' order by i.id) from public.inventory_items i where i.id in (:c1, :c2, :c3)),
  'applied/new/3/false/1:3/04000000-0000-0000-0000-0000000000e1,04000000-0000-0000-0000-0000000000e2,none',
  'C1: records of charter chA, charter chB and no charter group together; each keeps its own charter (ownership and quantities stay separate)');
select is(
  pg_temp.brief((select r from ans where tag = 'c2')) || '/' || (pg_temp.gid(:s1) = pg_temp.gid(:s2))::text || '/'
  || (select string_agg(i.sku || '@' || i.bin_location, ',' order by i.id) from public.inventory_items i where i.id in (:s1, :s2)),
  'applied/new/2/false/true/X0400-SAME@1-A,X0400-SAME@2-A',
  'C2: two records of one SKU and one charter on two racks group explicitly; SKUs and racks unchanged');
select is(
  pg_temp.brief((select r from ans where tag = 'c3')) || '/'
  || (select g.item_type from public.item_display_groups g where g.id = pg_temp.gid(:e1)) || '/'
  || (select string_agg(i.sku || '@' || coalesce(i.barcode, '-') || '@[' || i.bin_location || ']', ',' order by i.id)
        from public.inventory_items i where i.id in (:e1, :e2)),
  'applied/new/2/false/book/X0400-E1@9780000000017@[],X0400-E2@9780000000024@[]',
  'C3: two books with one title and different ISBNs on the same empty rack make a book group; each keeps its own SKU and ISBN (equal titles are not one edition; no apparel-size rule, no sports gate)');

-- ═══ H. Hidden records ════════════════════════════════════════════════════
select is(
  pg_temp.sees(:stf, array[:c1, :c2, :c3]::uuid[]) || '|' || pg_temp.sees(:stfCh, array[:c1, :c2, :c3]::uuid[])
  || '|' || pg_temp.sees(:stfC, array[:c1, :c2, :c3]::uuid[]),
  '121,122,123|121,123|123',
  'H0: the personas read what 0229/0310 say: stf every charter at whA, stfCh the no-charter and chA records, stfC only the no-charter one');
select is(
  'stf=' || pg_temp.vis(:stf, array[:c1, :c2, :c3]::uuid[], pg_temp.gid(:c1))
  || ',stfCh=' || pg_temp.vis(:stfCh, array[:c1, :c2, :c3]::uuid[], pg_temp.gid(:c1))
  || ',stfC=' || pg_temp.vis(:stfC, array[:c1, :c2, :c3]::uuid[], pg_temp.gid(:c1))
  || ',mgrB=' || pg_temp.vis(:mgrB, array[:c1, :c2, :c3]::uuid[], pg_temp.gid(:c1))
  || ',nobody=' || pg_temp.vis(:nobody, array[:c1, :c2, :c3]::uuid[], pg_temp.gid(:c1))
  || ',dis=' || pg_temp.vis(:dis, array[:c1, :c2, :c3]::uuid[], pg_temp.gid(:c1)),
  'stf=3/1,stfCh=2/1,stfC=1/1,mgrB=0/0,nobody=0/0,dis=0/0',
  'H1: a membership is readable exactly when its record is, and the group when at least one of its records is: charter staff see their records'' memberships only; another org, an outsider and a disabled member see nothing');
insert into ans select 'h2', pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:hb1, :hb2]::uuid[], pg_temp.new_t('South only')), pg_temp.k(13));
select is(
  pg_temp.brief((select r from ans where tag = 'h2'))
  || '|' || pg_temp.vis(:stfCh, array[:hb1, :hb2]::uuid[], pg_temp.gid(:hb1))
  || '|' || pg_temp.vis(:stfC, array[:hb1, :hb2]::uuid[], pg_temp.gid(:hb1))
  || '|' || pg_temp.vis(:stf, array[:hb1, :hb2]::uuid[], pg_temp.gid(:hb1))
  || '|' || pg_temp.run('authenticated', :stfCh, 'select count(*)::text from public.item_display_groups where name = ''South only'''),
  'applied/new/2/false|0/0|0/0|2/1|0',
  'H2: a group made only of chB records is invisible to charter staff who cannot read chB, its name included; staff who can read every charter see it');
select is(
  pg_temp.brief(pg_temp.ap(:stfCh, pg_temp.greq(:stfCh, array[:c2, :k2]::uuid[], pg_temp.new_t('Peek')), pg_temp.k(600)))
  || '|' || pg_temp.ids_of(pg_temp.ap(:stfCh, pg_temp.greq(:stfCh, array[:c2, :k2]::uuid[], pg_temp.new_t('Peek')), pg_temp.k(600)))
  || '|' || pg_temp.brief(pg_temp.ap(:stfCh, pg_temp.greq(:stfCh, array[:gone, :k2]::uuid[], pg_temp.new_t('Peek')), pg_temp.k(601)))
  || '|' || pg_temp.ids_of(pg_temp.ap(:stfCh, pg_temp.greq(:stfCh, array[:gone, :k2]::uuid[], pg_temp.new_t('Peek')), pg_temp.k(601)))
  || '|' || (select count(*) from public.item_display_group_members where item_id = :k2)::text,
  'P0002:item_not_found|122|P0002:item_not_found|1ff|0',
  'H3: a record charter staff cannot read is item_not_found naming only the id sent, the same answer as an id that does not exist; a hidden record never joins');
insert into ans select 'h4', pg_temp.pv(:stfCh, array[:c1, :c2, :c3]::uuid[]);
select is(
  (select string_agg(right(e->>'id', 3), ',' order by ord) from jsonb_array_elements((select r from ans where tag = 'h4')::jsonb->'records') with ordinality x(e, ord))
  || '|' || ((select r from ans where tag = 'h4')::jsonb->>'unavailable_count')
  || '|' || ((select r from ans where tag = 'h4')::jsonb #>> '{records,0,display_group,name}')
  || '|' || ((select r from ans where tag = 'h4')::jsonb #>> '{candidate_groups,0,name}')
  || '|' || ((select r from ans where tag = 'h4')::jsonb #>> '{candidate_groups,0,member_count}')
  || '|' || ((select r from ans where tag = 'h4')::jsonb #>> '{candidate_groups,0,holds_selected}')
  || '|' || (exists (select 1 from jsonb_array_elements((select r from ans where tag = 'h4')::jsonb->'candidate_groups') e
                      where e->>'name' = 'South only'))::text
  || '|' || ((select r from ans where tag = 'h4')::jsonb #>> '{records,0,writable}'),
  '121,123|1|Charter mix|Charter mix|2|true|false|true',
  'H4: the preview, as charter staff over chA, chB and no-charter records, names only the two it can read (the third is a count), shows their group with 2 readable records first among the candidates, never offers the invisible chB group, and says the caller can edit the record');
insert into ans select 'h5', pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:q1, :q2]::uuid[], pg_temp.new_t('Cats')), pg_temp.k(14));
insert into ans select 'h5p', pg_temp.pv(:vwrCat, array[:q1, :q2]::uuid[]);
select is(
  pg_temp.brief((select r from ans where tag = 'h5'))
  || '|' || pg_temp.vis(:vwrCat, array[:q1, :q2]::uuid[], pg_temp.gid(:q1))
  || '|' || pg_temp.brief(pg_temp.ap(:vwrCat, pg_temp.greq(:vwrCat, array[:q1, :q2]::uuid[], pg_temp.new_t('Cat peek')), pg_temp.k(602)))
  || '|' || pg_temp.ids_of(pg_temp.ap(:vwrCat, pg_temp.greq(:vwrCat, array[:q1, :q2]::uuid[], pg_temp.new_t('Cat peek')), pg_temp.k(602)))
  || '|' || (select string_agg(right(e->>'id', 3), ',') from jsonb_array_elements((select r from ans where tag = 'h5p')::jsonb->'records') e)
  || '/' || ((select r from ans where tag = 'h5p')::jsonb->>'unavailable_count')
  || '/' || ((select r from ans where tag = 'h5p')::jsonb #>> '{records,0,writable}'),
  'applied/new/2/false|1/1|P0002:item_not_found|1a2|1a1/1/false',
  'H5: a category-restricted member reads the catA record''s membership only; naming the catB record is item_not_found; its preview names the catA record (not editable for a viewer) and counts the other');

-- ═══ P. Permission ════════════════════════════════════════════════════════
select is(
  (select string_agg(c.tag || '=' || pg_temp.brief(c.r), ',' order by c.tag)
     from (values
       ('a_vwr',     pg_temp.ap(:vwr,    pg_temp.greq(:vwr,    array[:v1, :v2]::uuid[], pg_temp.new_t('P')), pg_temp.k(500))),
       ('b_stfNo',   pg_temp.ap(:stfNo,  pg_temp.greq(:stfNo,  array[:v1, :v2]::uuid[], pg_temp.new_t('P')), pg_temp.k(501))),
       ('c_vwrUp',   pg_temp.ap(:vwrUp,  pg_temp.greq(:vwrUp,  array[:v1, :v2]::uuid[], pg_temp.new_t('P')), pg_temp.k(502))),
       ('d_actor',   pg_temp.ap(:stf,    pg_temp.greq(:mgr,    array[:v1, :v2]::uuid[], pg_temp.new_t('P')), pg_temp.k(503))),
       ('e_signout', pg_temp.ap(null,    pg_temp.greq(:mgr,    array[:v1, :v2]::uuid[], pg_temp.new_t('P')), pg_temp.k(504))),
       ('f_nobody',  pg_temp.ap(:nobody, pg_temp.greq(:nobody, array[:v1, :v2]::uuid[], pg_temp.new_t('P')), pg_temp.k(505))),
       ('g_dis',     pg_temp.ap(:dis,    pg_temp.greq(:dis,    array[:v1, :v2]::uuid[], pg_temp.new_t('P')), pg_temp.k(506))),
       ('h_mgrB',    pg_temp.ap(:mgrB,   pg_temp.greq(:mgrB,   array[:v1, :v2]::uuid[], pg_temp.new_t('P')), pg_temp.k(507))),
       ('i_mgrBown', pg_temp.ap(:mgrB,   pg_temp.greq(:mgrB,   array[:v1, :v2]::uuid[], pg_temp.new_t('P'), null, null, :orgB), pg_temp.k(508)))
     ) c(tag, r)),
  'a_vwr=42501:permission,b_stfNo=42501:permission,c_vwrUp=42501:item_not_writable,d_actor=42501:actor_mismatch,'
  'e_signout=42501:unauthenticated,f_nobody=42501:not_member,g_dis=42501:not_member,h_mgrB=42501:not_member,'
  'i_mgrBown=P0002:item_not_found',
  'P1: viewer and staff whose items:update is revoked are refused (the role floor is not enough, V5); a viewer granted items:update cannot write the warehouse; actor mismatch, signed out, outsider, disabled member and another org''s manager are refused; naming another org''s records from your own is item_not_found');
select is(
  (select string_agg(r.r || '=' || split_part(pg_temp.run(r.r, :mgr, format('select public.apply_item_grouping(%L::jsonb, %L)::text',
                                                     pg_temp.greq(:mgr, array[:v1, :v2]::uuid[], pg_temp.new_t('P')), pg_temp.k(509))), ':', 2), ',' order by r.r)
     from unnest(array['anon', 'service_role']) r(r))
  || '|' || (select string_agg(r.r || '=' || split_part(pg_temp.run(r.r, :mgr, format('select public.item_grouping_preview(%L::jsonb)::text',
                                                     jsonb_build_object('organization_id', :orgA, 'item_ids', jsonb_build_array(:v1)))), ':', 2), ',' order by r.r)
               from unnest(array['anon', 'service_role']) r(r)),
  'anon=42501,service_role=42501|anon=42501,service_role=42501',
  'P2: anon and service_role hold no EXECUTE on apply_item_grouping or item_grouping_preview');
select is(
  (select count(*)::text from public.item_display_group_members where item_id in (:v1, :v2)),
  '0',
  'P3: every refused caller left the records outside any group');

-- ═══ E. An existing group ═════════════════════════════════════════════════
insert into ans select 'e1', pg_temp.ap(:stf, pg_temp.greq(:stf, array[:v1, :v2]::uuid[], pg_temp.new_t('Versioned')), pg_temp.k(30));
insert into ans select 'e2', pg_temp.ap(:stf, pg_temp.greq(:stf, array[:v3]::uuid[], pg_temp.old_t(pg_temp.gid(:v1), 1)), pg_temp.k(31));
select is(
  pg_temp.brief((select r from ans where tag = 'e1')) || '|' || pg_temp.brief((select r from ans where tag = 'e2'))
  || '|' || (select g.version::text || '/' || (select count(*) from public.item_display_group_members m where m.group_id = g.id)::text
               from public.item_display_groups g where g.id = pg_temp.gid(:v1))
  || '|' || ((select r from ans where tag = 'e2')::jsonb #>> '{group,version}'),
  'applied/new/2/false|applied/old/1/false|2/3|2',
  'E1: staff group two records, then add a third to the existing group at the version they saw: the group moves to version 2 with three records');
select is(
  pg_temp.brief(pg_temp.ap(:stf, pg_temp.greq(:stf, array[:k2]::uuid[], pg_temp.old_t(pg_temp.gid(:v1), 1)), pg_temp.k(510)))
  || '|' || (select count(*) from public.item_display_group_members where item_id = :k2)::text,
  'P0001:group_changed|0',
  'E2: a stale version of the target group is group_changed, and nothing is written');
insert into ans select 'e3', pg_temp.ap(:stf, pg_temp.greq(:stf, array[:v1, :v2]::uuid[], pg_temp.old_t(pg_temp.gid(:v1))), pg_temp.k(32));
select is(
  pg_temp.brief((select r from ans where tag = 'e3'))
  || '|' || (select g.version::text from public.item_display_groups g where g.id = pg_temp.gid(:v1)),
  'noop/old/0/false|2',
  'E3: adding records already in the target is a no-op: no version change');
select is(
  pg_temp.brief(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2]::uuid[], pg_temp.old_t(pg_temp.gid(:e1))), pg_temp.k(511))),
  'P0001:mixed_item_types',
  'E4: a product cannot join a book group (Items and Books never share a group)');
select is(
  pg_temp.brief(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2]::uuid[], pg_temp.old_t(:gNone, 1)), pg_temp.k(512)))
  || '|' || pg_temp.brief(pg_temp.ap(:stfCh, pg_temp.greq(:stfCh, array[:k2]::uuid[], pg_temp.old_t(pg_temp.gid(:hb1))), pg_temp.k(513)))
  || '|' || pg_temp.brief(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2]::uuid[], pg_temp.old_t(:gB)), pg_temp.k(514))),
  'P0002:group_not_found|P0002:group_not_found|P0002:group_not_found',
  'E5: an unknown group, a group whose records the caller cannot read, and another organization''s group are the same answer: group_not_found');
select is(
  pg_temp.brief(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2]::uuid[], pg_temp.old_t(:gBig)), pg_temp.k(515)))
  || '|' || (select count(*) from public.item_display_group_members where group_id = :gBig)::text,
  'P0001:group_too_large|200',
  'E6: a group holds at most 200 records (one list unit is never cut across pages): the 201st is group_too_large');

-- ═══ M. Moves ═════════════════════════════════════════════════════════════
insert into ans select 'm0', pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:m1, :m2]::uuid[], pg_temp.new_t('Old group')), pg_temp.k(40));
select is(
  pg_temp.brief((select r from ans where tag = 'm0'))
  || '|' || pg_temp.brief(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:m2, :m3]::uuid[], pg_temp.new_t('New group')), pg_temp.k(520)))
  || '|' || pg_temp.ids_of(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:m2, :m3]::uuid[], pg_temp.new_t('New group')), pg_temp.k(520)))
  || '|' || (select count(*) from public.item_display_groups where name = 'New group')::text
  || '|' || (pg_temp.gid(:m2) = pg_temp.gnamed('Old group'))::text,
  'applied/new/2/false|P0001:membership_conflict|172|0|true',
  'M1: a selected record already in another group is never moved silently: membership_conflict names it, and nothing is written');
select is(
  pg_temp.brief(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:m2, :m3]::uuid[], pg_temp.new_t('New group'), array[:m2]::uuid[], null, :orgA,
                                              jsonb_build_object(:m2::text, null, :m3::text, null)), pg_temp.k(521)))
  || '|' || pg_temp.ids_of(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:m2, :m3]::uuid[], pg_temp.new_t('New group'), array[:m2]::uuid[], null, :orgA,
                                              jsonb_build_object(:m2::text, null, :m3::text, null)), pg_temp.k(521))),
  'P0001:membership_changed|172',
  'M2: a screen that saw no group on a record that is in one now is membership_changed');
insert into ans select 'm3', pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:m2, :m3]::uuid[], pg_temp.new_t('New group'), array[:m2]::uuid[]), pg_temp.k(41));
select is(
  pg_temp.brief((select r from ans where tag = 'm3'))
  || '|' || (select g.version::text || '/' || coalesce(g.closed_at::text, 'open') from public.item_display_groups g where g.id = pg_temp.gnamed('Old group'))
  || '|' || (select string_agg(right(i::text, 3) || '=' || case pg_temp.gid(i) when pg_temp.gnamed('Old group') then 'old'
                                                                     when pg_temp.gnamed('New group') then 'new' else 'none' end, ',' order by i)
               from unnest(array[:m1, :m2, :m3]::uuid[]) i)
  || '|' || (select (a.metadata->>'previous_group_id' = pg_temp.gnamed('Old group')::text)::text || '/' || (a.metadata->>'previous_group_closed')
                    || '/' || (a.metadata#>>'{before,display_group_name}')
               from public.audit_logs a where a.event = 'inventory.group.members_added' and a.metadata->>'entity_id' = :m2::text
                and a.metadata->>'request_key' = pg_temp.k(41)),
  'applied/new/2/false|2/open|171=old,172=new,173=new|true/false/Old group',
  'M3: with an explicit per-record move the record moves: the old group (still holding m1) goes to version 2 and stays open; the audit row records the group it left');
insert into ans select 'm4', pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:m1]::uuid[], pg_temp.old_t(pg_temp.gnamed('New group')), array[:m1]::uuid[]), pg_temp.k(42));
select is(
  pg_temp.brief((select r from ans where tag = 'm4'))
  || '|' || (select g.version::text || '/' || (g.closed_at is not null)::text || '/'
                    || (select count(*) from public.item_display_group_members m where m.group_id = g.id)::text
               from public.item_display_groups g where g.id = pg_temp.gnamed('Old group'))
  || '|' || (((select r from ans where tag = 'm4')::jsonb->'closed_group_ids') = jsonb_build_array(pg_temp.gnamed('Old group')))::text
  || '|' || (select a.metadata->>'previous_group_closed' from public.audit_logs a
              where a.event = 'inventory.group.members_added' and a.metadata->>'entity_id' = :m1::text and a.metadata->>'request_key' = pg_temp.k(42)),
  'applied/old/1/false|3/true/0|true|true',
  'M4: moving the last record out closes its old group (version 3, empty), the answer names it, and the audit row says so');
select is(
  pg_temp.run('authenticated', :mgr, format('select count(*)::text from public.item_display_groups where id = %L', pg_temp.gnamed('Old group')))
  || '|' || pg_temp.brief(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:m4]::uuid[], pg_temp.old_t(pg_temp.gnamed('Old group'))), pg_temp.k(522))),
  '0|P0002:group_not_found',
  'M5: a closed group is invisible, even to a manager, and cannot be a target');

-- ═══ Y. Product families ══════════════════════════════════════════════════
select is(
  pg_temp.brief(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:f1, :f3]::uuid[], pg_temp.new_t('Family mix')), pg_temp.k(523)))
  || '|' || pg_temp.ids_of(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:f1, :f3]::uuid[], pg_temp.new_t('Family mix')), pg_temp.k(523))),
  'P0001:product_family_conflict|161',
  'Y1: a product-family member joins only with the explicit acknowledgement');
insert into ans select 'y2', pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:f1, :f3]::uuid[], pg_temp.new_t('Family mix'), null, true), pg_temp.k(43));
select is(
  pg_temp.brief((select r from ans where tag = 'y2'))
  || '|' || (select string_agg(right(i.id::text, 3) || '=' || coalesce(i.group_id::text, 'none') || '/' || coalesce(i.variant_size, '-')
                               || '/' || coalesce(i.sku, '-'), ',' order by i.id)
               from public.inventory_items i where i.id in (:f1, :f2)),
  'applied/new/2/false|161=04000000-0000-0000-0000-0000000000e9/XS/X0400-F-XS,162=04000000-0000-0000-0000-0000000000e9/S/X0400-F-S',
  'Y2: with it, XS joins the display group and stays a distinct record: its product family, size and SKU are untouched, and so is its sibling S (a display group is never a family)');

-- ═══ R. Refusals ══════════════════════════════════════════════════════════
select is(
  (select pg_temp.brief(r) || '|' || pg_temp.reason_of(r) || '|' || pg_temp.ids_of(r)
     from (select pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k1, :k2]::uuid[], pg_temp.new_t('Kits')), pg_temp.k(530)) as r) z)
  || '#' || (select pg_temp.brief(r) || '|' || pg_temp.reason_of(r) || '|' || pg_temp.ids_of(r)
               from (select pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:r1, :k2]::uuid[], pg_temp.new_t('Rentals')), pg_temp.k(531)) as r) z),
  'P0001:not_groupable|kit|151#P0001:not_groupable|rental|153',
  'R1: a kit (owner decision) and a rental are not_groupable, with the reason and the record');
select is(
  pg_temp.brief(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2, :e1]::uuid[], pg_temp.new_t('Mixed')), pg_temp.k(532))),
  'P0001:mixed_item_types',
  'R2: an item and a book cannot share a group');
select is(
  pg_temp.brief(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:dl2, :del]::uuid[], pg_temp.new_t('Deleted')), pg_temp.k(533)))
  || '|' || pg_temp.ids_of(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:dl2, :del]::uuid[], pg_temp.new_t('Deleted')), pg_temp.k(533)))
  || '|' || pg_temp.brief(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2, :bx]::uuid[], pg_temp.new_t('Cross')), pg_temp.k(534)))
  || '|' || pg_temp.ids_of(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2, :bx]::uuid[], pg_temp.new_t('Cross')), pg_temp.k(534))),
  'P0002:item_not_found|1d1|P0002:item_not_found|1f1',
  'R3: a deleted record and another organization''s record are item_not_found');
select is(
  (select string_agg(c.tag || '=' || split_part(c.r, ':', 2) || ':' || split_part(c.r, ':', 3) || ':' || split_part(c.r, ':', 4), ',' order by c.tag)
     from (values
       ('a_action',   pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2, :m4]::uuid[], pg_temp.new_t('X')) || '{"action":"split_sku"}', pg_temp.k(540))),
       ('b_surface',  pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2, :m4]::uuid[], pg_temp.new_t('X')) || '{"surface":"fax"}', pg_temp.k(540))),
       ('c_empty',    pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[]::uuid[], pg_temp.new_t('X')), pg_temp.k(540))),
       ('d_dup',      pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2, :m4]::uuid[], pg_temp.new_t('X'))
                                         || jsonb_build_object('item_ids', jsonb_build_array(:k2, upper(:k2::text))), pg_temp.k(540))),
       ('e_notuuid',  pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2, :m4]::uuid[], pg_temp.new_t('X')) || '{"item_ids":["nope"]}', pg_temp.k(540))),
       ('f_many',     pg_temp.ap(:mgr, pg_temp.greq(:mgr, array(select gen_random_uuid() from generate_series(1, 101)), pg_temp.new_t('X')), pg_temp.k(540))),
       ('g_one',      pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2]::uuid[], pg_temp.new_t('Solo')), pg_temp.k(540))),
       ('h_blank',    pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2, :m4]::uuid[], pg_temp.new_t('   ')), pg_temp.k(540))),
       ('i_long',     pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2, :m4]::uuid[], pg_temp.new_t(repeat('x', 121))), pg_temp.k(540))),
       ('j_kind',     pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2, :m4]::uuid[], '{"kind":"old"}'::jsonb), pg_temp.k(540))),
       ('k_ver0',     pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2, :m4]::uuid[], pg_temp.old_t(pg_temp.gid(:v1), 0)), pg_temp.k(540))),
       ('l_verstr',   pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2, :m4]::uuid[],
                                         jsonb_build_object('kind', 'existing', 'group_id', pg_temp.gid(:v1), 'expected_version', '1')), pg_temp.k(540))),
       ('m_expmiss',  pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2, :m4]::uuid[], pg_temp.new_t('X'), null, null, :orgA,
                                                     jsonb_build_object(:k2::text, null)), pg_temp.k(540))),
       ('n_expextra', pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2, :m4]::uuid[], pg_temp.new_t('X'), null, null, :orgA,
                                                     jsonb_build_object(:k2::text, null, :m4::text, null, :m3::text, null)), pg_temp.k(540))),
       ('o_movenot',  pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2, :m4]::uuid[], pg_temp.new_t('X'), array[:m3]::uuid[]), pg_temp.k(540))),
       ('p_ack',      pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2, :m4]::uuid[], pg_temp.new_t('X')) || '{"acknowledge_product_family":"yes"}', pg_temp.k(540))),
       ('q_rmnull',   pg_temp.ap(:mgr, pg_temp.rreq(:mgr, array[:k2]::uuid[]), pg_temp.k(540))),
       ('r_rngid',    pg_temp.ap(:mgr, pg_temp.nreq(:mgr, pg_temp.gid(:v1), 'X') || '{"group_id":"nope"}', pg_temp.k(540))),
       ('s_rnname',   pg_temp.ap(:mgr, pg_temp.nreq(:mgr, pg_temp.gid(:v1), ''), pg_temp.k(540))),
       ('t_expnot',   pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2, :m4]::uuid[], pg_temp.new_t('X'), null, null, :orgA,
                                                     jsonb_build_object(:k2::text, 'nope', :m4::text, null)), pg_temp.k(540)))
     ) c(tag, r)),
  'a_action=22023:grouping_invalid:action,b_surface=22023:grouping_invalid:surface,c_empty=22023:grouping_invalid:item_ids,'
  'd_dup=22023:grouping_invalid:item_ids,e_notuuid=22023:grouping_invalid:item_ids,f_many=22023:grouping_invalid:item_ids,'
  'g_one=22023:grouping_invalid:item_ids,h_blank=22023:grouping_invalid:name,i_long=22023:grouping_invalid:name,'
  'j_kind=22023:grouping_invalid:target,k_ver0=22023:grouping_invalid:expected_version,'
  'l_verstr=22023:grouping_invalid:expected_version,m_expmiss=22023:grouping_invalid:expected_groups,'
  'n_expextra=22023:grouping_invalid:expected_groups,o_movenot=22023:grouping_invalid:move_item_ids,'
  'p_ack=22023:grouping_invalid:acknowledge_product_family,q_rmnull=22023:grouping_invalid:expected_groups,'
  'r_rngid=22023:grouping_invalid:group_id,s_rnname=22023:grouping_invalid:name,t_expnot=22023:grouping_invalid:expected_groups',
  'R4: every shape case is 22023 grouping_invalid naming its field: two rack rows of one record are ONE id (a duplicate is refused, the app sends distinct ids), a new group needs two records, at most 100 per request');
select is(
  pg_temp.brief(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2, :m4]::uuid[], pg_temp.new_t('X')), null)) || '|'
  || pg_temp.brief(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2, :m4]::uuid[], pg_temp.new_t('X')), '  ')) || '|'
  || pg_temp.brief(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:k2, :m4]::uuid[], pg_temp.new_t('X')), 'not-a-key')),
  '22023:idempotency_key_required|22023:idempotency_key_required|22023:idempotency_key_invalid',
  'R5: a missing or blank key is idempotency_key_required, a malformed one idempotency_key_invalid');

-- ═══ X. Remove ════════════════════════════════════════════════════════════
insert into ans select 'x0', pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:rm1, :rm2, :rm3]::uuid[], pg_temp.new_t('Remove me')), pg_temp.k(60));
insert into ans select 'x1', pg_temp.ap(:mgr, pg_temp.rreq(:mgr, array[:rm1]::uuid[]), pg_temp.k(61));
select is(
  pg_temp.brief((select r from ans where tag = 'x0')) || '|' || pg_temp.brief((select r from ans where tag = 'x1'))
  || '|' || (select g.version::text || '/' || coalesce(g.closed_at::text, 'open') || '/'
                    || (select count(*) from public.item_display_group_members m where m.group_id = g.id)::text
               from public.item_display_groups g where g.id = pg_temp.gnamed('Remove me'))
  || '|' || (select (a.metadata->>'group_closed') || '/' || (a.metadata#>>'{before,display_group_name}') || '/'
                    || coalesce(a.metadata#>>'{after,display_group_id}', 'null') || '/' || (a.metadata->>'surface')
               from public.audit_logs a where a.event = 'inventory.group.members_removed' and a.metadata->>'entity_id' = :rm1::text)
  || '|' || (select (i.j = b.j)::text from pg_temp.fp_full(:orgA) i join before_items b on b.id = i.id where i.id = :rm1),
  'applied/new/3/false|applied/old/1/false|2/open/2|false/Remove me/null/app|true',
  'X1: removing one record deletes only its membership: the group stays open at version 2 with two records; the audit row names the group it left; the record itself is byte-identical (no inventory deleted, no identifier rewritten)');
select is(
  pg_temp.brief(pg_temp.ap(:mgr, pg_temp.rreq(:mgr, array[:rm2]::uuid[], jsonb_build_object(:rm2::text, pg_temp.gnamed('Versioned'))), pg_temp.k(550)))
  || '|' || pg_temp.ids_of(pg_temp.ap(:mgr, pg_temp.rreq(:mgr, array[:rm2]::uuid[], jsonb_build_object(:rm2::text, pg_temp.gnamed('Versioned'))), pg_temp.k(550))),
  'P0001:membership_changed|192',
  'X2: a remove that names another group than the record is in is membership_changed');
insert into ans select 'x3', pg_temp.ap(:mgr, pg_temp.rreq(:mgr, array[:rm1]::uuid[], jsonb_build_object(:rm1::text, pg_temp.gnamed('Remove me'))), pg_temp.k(62));
insert into ans select 'x4', pg_temp.ap(:mgr, pg_temp.rreq(:mgr, array[:rm2, :rm3]::uuid[]), pg_temp.k(63));
select is(
  pg_temp.brief((select r from ans where tag = 'x3')) || '|' || pg_temp.brief((select r from ans where tag = 'x4'))
  || '|' || (select (g.closed_at is not null)::text || '/' || (select count(*) from public.item_display_group_members m where m.group_id = g.id)::text
               from public.item_display_groups g where g.name = 'Remove me' and g.organization_id = :orgA)
  || '|' || (jsonb_array_length((select r from ans where tag = 'x4')::jsonb->'closed_group_ids'))::text
  || '|' || (select string_agg(a.metadata->>'group_closed', ',' order by a.metadata->>'entity_id') from public.audit_logs a
              where a.event = 'inventory.group.members_removed' and a.metadata->>'request_key' = pg_temp.k(63)),
  'noop/old/0/false|applied/old/2/false|true/0|1|true,true',
  'X3: removing a record no longer in a group is a no-op; removing the last records closes the group, which is then empty');
insert into ans select 'x5', pg_temp.ap(:stfCh, pg_temp.rreq(:stfCh, array[:c1, :c3]::uuid[]), pg_temp.k(64));
select is(
  pg_temp.brief((select r from ans where tag = 'x5'))
  || '|' || (select coalesce(g.closed_at::text, 'open') || '/' || g.version::text from public.item_display_groups g where g.name = 'Charter mix')
  || '|' || pg_temp.vis(:stfCh, array[:c1, :c2, :c3]::uuid[], pg_temp.gnamed('Charter mix'))
  || '|' || pg_temp.vis(:mgr, array[:c1, :c2, :c3]::uuid[], pg_temp.gnamed('Charter mix')),
  'applied/old/2/false|open/2|0/0|1/1',
  'X4: charter staff removing the two records they can see leave the chB record (hidden from them) in its group, which stays open for the manager and disappears for them');

-- ═══ N. Rename ════════════════════════════════════════════════════════════
insert into ans select 'n0', pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:n1, :n2]::uuid[], pg_temp.new_t('Rename me')), pg_temp.k(70));
select is(
  pg_temp.brief((select r from ans where tag = 'n0'))
  || '|' || pg_temp.brief(pg_temp.ap(:stfCh, pg_temp.nreq(:stfCh, pg_temp.gnamed('Rename me'), 'By charter staff'), pg_temp.k(560))),
  'applied/new/2/false|42501:rename_not_permitted',
  'N1: charter staff who can see the group (n1) but cannot edit every record in it (n2, chB) cannot rename it (the words say only that a manager can)');
insert into ans select 'n2', pg_temp.ap(:stf, pg_temp.nreq(:stf, pg_temp.gnamed('Rename me'), 'Renamed by staff'), pg_temp.k(71));
select is(
  pg_temp.brief((select r from ans where tag = 'n2'))
  || '|' || (select g.version::text from public.item_display_groups g where g.name = 'Renamed by staff')
  || '|' || (select (a.metadata#>>'{before,name}') || '>' || (a.metadata#>>'{after,name}') || '/' || (a.metadata->>'entity_type')
               from public.audit_logs a where a.event = 'inventory.group.renamed' and a.metadata->>'request_key' = pg_temp.k(71)),
  'applied/old/0/false|2|Rename me>Renamed by staff/item_display_group',
  'N2: staff who can edit every record rename it: version 2, one inventory.group.renamed row with the old and new names');
select is(
  pg_temp.brief(pg_temp.ap(:mgr, pg_temp.nreq(:mgr, pg_temp.gnamed('Renamed by staff'), 'Stale', 1), pg_temp.k(561)))
  || '|' || pg_temp.brief(pg_temp.ap(:mgr, pg_temp.nreq(:mgr, pg_temp.gnamed('Renamed by staff'), 'Renamed by staff'), pg_temp.k(72)))
  || '|' || (select g.version::text from public.item_display_groups g where g.name = 'Renamed by staff'),
  'P0001:group_changed|noop/old/0/false|2',
  'N3: a stale version is group_changed; the same name is a no-op (no version change)');
insert into ans select 'n4', pg_temp.ap(:mgr, pg_temp.nreq(:mgr, pg_temp.gnamed('Renamed by staff'), '  Trimmed  '), pg_temp.k(73));
select is(
  pg_temp.brief((select r from ans where tag = 'n4'))
  || '|' || ((select r from ans where tag = 'n4')::jsonb #>> '{group,name}')
  || '|' || pg_temp.brief(pg_temp.ap(:stfCh, pg_temp.nreq(:stfCh, pg_temp.gnamed('South only'), 'Peek'), pg_temp.k(562)))
  || '|' || pg_temp.brief(pg_temp.ap(:mgr, pg_temp.nreq(:mgr, :gB, 'Peek', 1), pg_temp.k(563))),
  'applied/old/0/false|Trimmed|P0002:group_not_found|P0002:group_not_found',
  'N4: a name is trimmed; a group the caller cannot see and another organization''s group are group_not_found');

-- ═══ T. The consistency trigger ═══════════════════════════════════════════
select is(
  (select string_agg(c.tag || '=' || split_part(c.r, ':', 2) || ':' || split_part(c.r, ':', 3), ',' order by c.tag)
     from (values
       ('a_type',   pg_temp.run('postgres', null, format('insert into public.item_display_group_members (item_id, organization_id, group_id) values (%L, %L, %L) returning 1', :k2, :orgA, pg_temp.gnamed('Earth Science')))),
       ('b_del',    pg_temp.run('postgres', null, format('insert into public.item_display_group_members (item_id, organization_id, group_id) values (%L, %L, %L) returning 1', :del, :orgA, pg_temp.gid(:v1)))),
       ('c_closed', pg_temp.run('postgres', null, format('insert into public.item_display_group_members (item_id, organization_id, group_id) values (%L, %L, %L) returning 1', :m4, :orgA, pg_temp.gnamed('Old group'))))
     ) c(tag, r)),
  'a_type=23514:item_display_group_member_inconsistent,b_del=23514:item_display_group_member_inconsistent,c_closed=23514:item_display_group_member_inconsistent',
  'T1: even a direct row (no API role can write one) is refused when the item type differs, the record is deleted, or the group is closed');

-- ═══ F. Failure injection: nothing half-written ═══════════════════════════
create function public._zz0400_probe_member() returns trigger language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  if new.item_id::text like '04000000-0000-0000-0000-0000000001c%' then
    v_n := coalesce(nullif(current_setting('zz0400.n', true), ''), '0')::integer + 1;
    perform set_config('zz0400.n', v_n::text, true);
    if v_n >= 3 then
      raise exception 'probe: member' using errcode = 'P0001', hint = 'probe_member';
    end if;
  end if;
  return new;
end $$;
create trigger trg_aa_0400_probe_member before insert on public.item_display_group_members
  for each row execute function public._zz0400_probe_member();
insert into reqs values ('f1', pg_temp.greq(:mgr, array[:j1, :j2, :j3]::uuid[], pg_temp.new_t('Inject one')));
select is(
  pg_temp.brief(pg_temp.ap(:mgr, (select r from reqs where tag = 'f1'), pg_temp.k(80)))
  || '|' || (select count(*) from public.item_display_groups where name = 'Inject one')::text
  || '/' || (select count(*) from public.item_display_group_members where item_id in (:j1, :j2, :j3))::text
  || '/' || (select count(*) from public.audit_logs where metadata->>'request_key' = pg_temp.k(80))::text
  || '/' || (select count(*) from public.item_grouping_requests where key = pg_temp.k(80)::uuid)::text,
  'P0001:probe_member|0/0/0/0',
  'F1: a failure on the 3rd membership row leaves nothing: no group, no half-linked selection, no audit row, no request row');
drop trigger trg_aa_0400_probe_member on public.item_display_group_members;
drop function public._zz0400_probe_member();

create function public._zz0400_probe_audit() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.event = 'inventory.group.members_added' and new.metadata->>'entity_id' = '04000000-0000-0000-0000-0000000001c5' then
    raise exception 'probe: audit' using errcode = 'P0001', hint = 'probe_audit';
  end if;
  return new;
end $$;
create trigger trg_aa_0400_probe_audit before insert on public.audit_logs
  for each row execute function public._zz0400_probe_audit();
select is(
  pg_temp.brief(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:j4, :j5]::uuid[], pg_temp.new_t('Inject two')), pg_temp.k(81)))
  || '|' || (select count(*) from public.item_display_groups where name = 'Inject two')::text
  || '/' || (select count(*) from public.item_display_group_members where item_id in (:j4, :j5))::text
  || '/' || (select count(*) from public.audit_logs where metadata->>'request_key' = pg_temp.k(81))::text
  || '/' || (select count(*) from public.item_grouping_requests where key = pg_temp.k(81)::uuid)::text,
  'P0001:probe_audit|0/0/0/0',
  'F2: a failure on the audit insert rolls the group, its memberships and the created row back');
drop trigger trg_aa_0400_probe_audit on public.audit_logs;
drop function public._zz0400_probe_audit();

create function public._zz0400_probe_request() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.action = 'group' then
    raise exception 'probe: request' using errcode = 'P0001', hint = 'probe_request';
  end if;
  return new;
end $$;
create trigger trg_aa_0400_probe_request before insert on public.item_grouping_requests
  for each row execute function public._zz0400_probe_request();
select is(
  pg_temp.brief(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:j6, :j7]::uuid[], pg_temp.new_t('Inject three')), pg_temp.k(82)))
  || '|' || (select count(*) from public.item_display_groups where name = 'Inject three')::text
  || '/' || (select count(*) from public.item_display_group_members where item_id in (:j6, :j7))::text
  || '/' || (select count(*) from public.audit_logs where metadata->>'request_key' = pg_temp.k(82))::text,
  'P0001:probe_request|0/0/0',
  'F3: a failure on the request insert rolls the group, its memberships and its audit rows back');
drop trigger trg_aa_0400_probe_request on public.item_grouping_requests;
drop function public._zz0400_probe_request();

insert into ans select 'f4s', pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:j8, :j9]::uuid[], pg_temp.new_t('Inject source')), pg_temp.k(83));
create function public._zz0400_probe_close() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.name = 'Inject source' and new.closed_at is not null then
    raise exception 'probe: close' using errcode = 'P0001', hint = 'probe_close';
  end if;
  return new;
end $$;
create trigger trg_aa_0400_probe_close before update on public.item_display_groups
  for each row execute function public._zz0400_probe_close();
select is(
  pg_temp.brief((select r from ans where tag = 'f4s'))
  || '|' || pg_temp.brief(pg_temp.ap(:mgr, pg_temp.greq(:mgr, array[:j8, :j9]::uuid[], pg_temp.new_t('Inject target'), array[:j8, :j9]::uuid[]), pg_temp.k(84)))
  || '|' || (select g.version::text || '/' || coalesce(g.closed_at::text, 'open') from public.item_display_groups g where g.name = 'Inject source')
  || '|' || (select count(*) from public.item_display_group_members m where m.group_id = pg_temp.gnamed('Inject source'))::text
  || '|' || (select count(*) from public.item_display_groups where name = 'Inject target')::text
  || '/' || (select count(*) from public.audit_logs where metadata->>'request_key' = pg_temp.k(84))::text
  || '/' || (select count(*) from public.item_grouping_requests where key = pg_temp.k(84)::uuid)::text,
  'applied/new/2/false|P0001:probe_close|1/open|2|0/0/0',
  'F4: a failure while closing the emptied source group leaves both records in it, the source open at its version, and no new group, audit or request row');
drop trigger trg_aa_0400_probe_close on public.item_display_groups;
drop function public._zz0400_probe_close();
select is(
  pg_temp.brief(pg_temp.ap(:mgr, (select r from reqs where tag = 'f1'), pg_temp.k(80)))
  || '|' || (select count(*) from public.item_display_group_members where item_id in (:j1, :j2, :j3))::text,
  'applied/new/3/false|3',
  'F5: with the probes gone the first key applies (a rolled-back call recorded nothing under it)');

-- ═══ Z. Invariants ════════════════════════════════════════════════════════
select is(
  (select coalesce(string_agg(right(a.id::text, 3), ',' order by a.id), '')
     from (select * from pg_temp.fp_full(:orgA) union all select * from pg_temp.fp_full(:orgB)) a
     join before_items b on b.id = a.id
    where a.j <> b.j)
  || '|' || (select count(*) from before_items)::text
  || '/' || (select count(*) from (select * from pg_temp.fp_full(:orgA) union all select * from pg_temp.fp_full(:orgB)) z)::text,
  '|243/243',
  'Z1: no inventory_items row changed, in any column, in either organization (no SKU, barcode/ISBN, name, category, price, charter, rack, warehouse, quantity or updated_at), and none was added or removed');
select is(
  (select levels = (select md5(coalesce(string_agg(to_jsonb(s)::text, ',' order by s.item_id, s.location_id), ''))
                      from public.item_stock_levels s where s.organization_id in (:orgA, :orgB))
          and movements = (select md5(coalesce(string_agg(to_jsonb(m)::text, ',' order by m.id), ''))
                             from public.stock_movements m where m.organization_id in (:orgA, :orgB))
     from before_stock)::text,
  'true',
  'Z2: no stock movement and no holding was written or changed');
select is(
  (select (reservations = (select md5(coalesce(string_agg(to_jsonb(r)::text, ',' order by r.id), ''))
                             from public.stock_reservations r where r.organization_id in (:orgA, :orgB)))::text
          || '/' || (order_lines = (select md5(coalesce(string_agg(to_jsonb(l)::text, ',' order by l.id), ''))
                                      from public.order_request_lines l join public.order_requests o on o.id = l.order_request_id
                                     where o.organization_id in (:orgA, :orgB)))::text
          || '/' || (return_lines = (select md5(coalesce(string_agg(to_jsonb(l)::text, ',' order by l.id), ''))
                                       from public.return_lines l where l.organization_id in (:orgA, :orgB)))::text
          || '/' || (product_groups = (select md5(coalesce(string_agg(to_jsonb(g)::text, ',' order by g.id), ''))
                                         from public.product_groups g where g.organization_id in (:orgA, :orgB)))::text
          || '/' || n_res::text || '/' || n_retl::text
          || '/' || (pg_temp.gid(:s2) is not null)::text
     from before_other),
  'true/true/true/true/1/1/true',
  'Z3: the reservation, the order line and the return line on the grouped record s2, and the product family, are byte-identical (they key on the record id; a display group is none of them)');
select is(
  (select (idx0234 = pg_get_indexdef('public.inventory_items_org_sku_charter_bin_unique'::regclass))::text from before_other)
  || '|' || (select count(*)::text from (
               select organization_id, sku, charter_id, bin_location from public.inventory_items
                where deleted_at is null and organization_id in (:orgA, :orgB)
                group by 1, 2, 3, 4 having count(*) > 1) d),
  'true|0',
  'Z4: 0234 is unchanged and holds: duplicate identity rules were not relaxed to group anything');
select is(
  (select count(*) from public.item_grouping_requests r
    where r.organization_id = :orgA and r.key >= pg_temp.k(500)::uuid and r.key <= pg_temp.k(899)::uuid)::text
  || '/' || (select count(*) from public.audit_logs a
              where a.organization_id = :orgA and a.event like 'inventory.group.%'
                and not exists (select 1 from public.item_grouping_requests r
                                 where r.organization_id = a.organization_id and r.key = (a.metadata->>'request_key')::uuid))::text,
  '0/0',
  'Z5: no refused call recorded a request, and every inventory.group.* audit row belongs to a recorded request (audit iff applied)');
select is(
  (select count(*) from public.item_display_groups g
    where g.organization_id in (:orgA, :orgB) and g.closed_at is null
      and not exists (select 1 from public.item_display_group_members m join public.inventory_items i on i.id = m.item_id
                       where m.group_id = g.id and i.deleted_at is null))::text
  || '/' || (select count(*) from public.item_display_group_members m join public.item_display_groups g on g.id = m.group_id
              where g.organization_id in (:orgA, :orgB) and g.closed_at is not null)::text
  || '/' || (select count(*) from public.item_display_group_members m join public.inventory_items i on i.id = m.item_id
              where m.organization_id <> i.organization_id)::text,
  '0/0/0',
  'Z6: no open group is left without a live record, a closed group holds no row, and no membership crosses organizations');
select is(
  (select ((select version from public.item_display_groups where id = :gB) = gb_version)::text
          || '/' || ((select count(*) from public.item_display_group_members where group_id = :gB) = gb_members)::text
          || '/' || ((select count(*) from public.audit_logs where organization_id = :orgB) = b_audit)::text
     from before_b),
  'true/true/true',
  'Z7: the other organization''s group, its membership and its audit log are untouched');

select * from finish();
rollback;
