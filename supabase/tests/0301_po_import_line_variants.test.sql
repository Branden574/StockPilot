-- supabase/tests/0301_po_import_line_variants.test.sql
--
-- Proves 0301: po_import_lines carries the sports variant fields, and that
-- adding them changed NOTHING about the prod-hardened import chassis.
--
-- Assertion index (26):
--    1-11  all eleven new columns exist
--   12     every one of them is NULLABLE (an existing import path that has
--          never heard of them must keep inserting)
--   13-15  the types that matter: jersey_number is TEXT (never numeric),
--          suggested_group_id is uuid, mapping_confidence is numeric(4,3)
--   16     suggested_group_id FKs product_groups
--   17     ...with ON DELETE SET NULL (a suggestion never blocks a delete)
--   18     the partial index on suggested_group_id exists
--   19     ANTI-VACUITY / backward compatibility: a line inserted with only
--          the pre-0301 columns still succeeds
--   20     ...and every new column reads back NULL on it (missing stays
--          missing — no default back-filled a value nobody supplied)
--   21-23  LEADING ZEROES: '07', '00' and '0' round-trip byte-for-byte.
--          A numeric column would return 7, 0 and 0.
--   24     a long, unbounded source string survives verbatim
--          (variant_size_original is "exactly as printed", never truncated)
--   25     mapping_confidence keeps its three decimals
--   26     deleting the suggested group nulls the suggestion and LEAVES THE
--          LINE (the 0233 suggestion-not-link discipline, group edition)
--
-- Namespace: b0300000. Wrapped in begin/rollback - nothing leaks.

begin;

select plan(26);

\set org   '\'b0300000-0000-0000-0000-000000000001\''
\set usr   '\'b0300000-0000-0000-0000-000000000002\''
\set wh    '\'b0300000-0000-0000-0000-000000000003\''
\set imp   '\'b0300000-0000-0000-0000-000000000004\''
\set grp   '\'b0300000-0000-0000-0000-000000000005\''
\set ln_a  '\'b0300000-0000-0000-0000-00000000000a\''
\set ln_b  '\'b0300000-0000-0000-0000-00000000000b\''
\set ln_c  '\'b0300000-0000-0000-0000-00000000000c\''
\set ln_d  '\'b0300000-0000-0000-0000-00000000000d\''
\set ln_e  '\'b0300000-0000-0000-0000-00000000000e\''

-- ── 1-11. The columns exist ────────────────────────────────────────────────
select has_column('public', 'po_import_lines', 'variant_size',
  'po_import_lines has variant_size');
select has_column('public', 'po_import_lines', 'variant_size_original',
  'po_import_lines has variant_size_original');
select has_column('public', 'po_import_lines', 'variant_size_system',
  'po_import_lines has variant_size_system');
select has_column('public', 'po_import_lines', 'variant_width',
  'po_import_lines has variant_width');
select has_column('public', 'po_import_lines', 'variant_fit',
  'po_import_lines has variant_fit');
select has_column('public', 'po_import_lines', 'variant_color',
  'po_import_lines has variant_color');
select has_column('public', 'po_import_lines', 'jersey_number',
  'po_import_lines has jersey_number');
select has_column('public', 'po_import_lines', 'player_name',
  'po_import_lines has player_name');
select has_column('public', 'po_import_lines', 'group_hint',
  'po_import_lines has group_hint');
select has_column('public', 'po_import_lines', 'suggested_group_id',
  'po_import_lines has suggested_group_id');
select has_column('public', 'po_import_lines', 'mapping_confidence',
  'po_import_lines has mapping_confidence');

-- ── 12. Every new column is nullable ───────────────────────────────────────
select is(
  (select count(*)::int
     from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'po_import_lines'
      and is_nullable  = 'NO'
      and column_name in (
        'variant_size','variant_size_original','variant_size_system',
        'variant_width','variant_fit','variant_color','jersey_number',
        'player_name','group_hint','suggested_group_id','mapping_confidence')),
  0,
  'none of the eleven new columns is NOT NULL');

-- ── 13-15. Types ───────────────────────────────────────────────────────────
-- TEXT, deliberately: a numeric jersey number loses '07' and '00'.
select col_type_is('public', 'po_import_lines', 'jersey_number', 'text',
  'jersey_number is text, never a number type');
select col_type_is('public', 'po_import_lines', 'suggested_group_id', 'uuid',
  'suggested_group_id is uuid');
select col_type_is('public', 'po_import_lines', 'mapping_confidence', 'numeric(4,3)',
  'mapping_confidence is numeric(4,3), matching match_confidence');

-- ── 16-17. The advisory FK ─────────────────────────────────────────────────
select fk_ok('public', 'po_import_lines', 'suggested_group_id',
             'public', 'product_groups', 'id',
  'suggested_group_id references product_groups(id)');
select is(
  (select confdeltype::text from pg_constraint
    where conrelid = 'public.po_import_lines'::regclass
      and contype  = 'f'
      and conkey   = array[(select attnum from pg_attribute
                             where attrelid = 'public.po_import_lines'::regclass
                               and attname  = 'suggested_group_id')]),
  'n',
  'the suggested_group_id FK is ON DELETE SET NULL');

-- ── 18. The lookup index ───────────────────────────────────────────────────
select has_index('public', 'po_import_lines', 'po_import_lines_suggested_group_idx',
  'po_import_lines_suggested_group_idx exists');

-- ── Fixtures ───────────────────────────────────────────────────────────────
insert into auth.users (id, email) values (:usr, 'u-0301@example.test')
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:org, 'Sports 0301 Org', 'sports-0301-org')
  on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :usr, 'manager', now())
  on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code) values
  (:wh, :org, 'WH 0301', 'WH0301')
  on conflict (id) do nothing;
insert into public.po_imports
  (id, organization_id, uploaded_by, source_type, file_name, file_mime_type,
   file_size, storage_path, sha256)
  values (:imp, :org, :usr, 'pdf', 'po-0301.pdf', 'application/pdf', 100,
          'b0300000/po-imports/po-0301.pdf', repeat('b', 64));
insert into public.product_groups
  (id, organization_id, subcategory_key, name, brand, model, group_key,
   default_counting_unit)
  values (:grp, :org, 'shoes', 'Nike Pegasus 41', 'Nike', 'Pegasus 41',
          'shoes|nike|pegasus 41||', 'pair');

-- ── 19-20. Backward compatibility: the pre-0301 insert shape still works ───
select lives_ok(
  $$ insert into public.po_import_lines
       (id, po_import_id, line_number, line_type, description,
        qty_ordered_original, unit_cost)
     values ('b0300000-0000-0000-0000-00000000000a',
             'b0300000-0000-0000-0000-000000000004', 1, 'inventory',
             'Legacy line, no variant data', 3, 9.99) $$,
  'a line inserted with only the pre-0301 columns still succeeds');

select is(
  (select num_nonnulls(variant_size, variant_size_original, variant_size_system,
                       variant_width, variant_fit, variant_color, jersey_number,
                       player_name, group_hint, suggested_group_id,
                       mapping_confidence)
     from public.po_import_lines where id = :ln_a),
  0,
  'a legacy line reads back NULL in all eleven columns (no back-filled default)');

-- ── 21-23. Leading zeroes survive ──────────────────────────────────────────
insert into public.po_import_lines
  (id, po_import_id, line_number, line_type, description, jersey_number,
   variant_size, variant_size_original, variant_size_system, variant_width,
   variant_fit, variant_color, player_name, group_hint, suggested_group_id,
   mapping_confidence)
  values
  (:ln_b, :imp, 2, 'inventory', 'Falcons Home Jersey - M', '07',
   'M', 'Medium', 'ALPHA', null, 'mens', 'Red/Black', 'A. Rosas',
   'Falcons Home Jersey 2026', :grp, 0.875),
  (:ln_c, :imp, 3, 'inventory', 'Falcons Home Jersey - L', '00',
   'L', 'Large', 'ALPHA', null, 'mens', 'Red/Black', null, null, null, null),
  (:ln_d, :imp, 4, 'inventory', 'Falcons Home Jersey - XL', '0',
   'XL', 'X-Large', 'ALPHA', null, null, null, null, null, null, null);

select is(
  (select jersey_number from public.po_import_lines where id = :ln_b),
  '07',
  E'jersey number \'07\' round-trips with its leading zero intact');
select is(
  (select jersey_number from public.po_import_lines where id = :ln_c),
  '00',
  E'jersey number \'00\' round-trips as two characters, not 0');
select is(
  (select jersey_number from public.po_import_lines where id = :ln_d),
  '0',
  E'jersey number \'0\' round-trips as the string 0');

-- ── 24. A long source string is preserved verbatim ─────────────────────────
-- variant_size_original is deliberately unbounded: it is what the DOCUMENT
-- printed, and a vendor is free to print something absurd. Truncating it
-- would break "preserve source values".
insert into public.po_import_lines
  (id, po_import_id, line_number, line_type, description,
   variant_size_original, group_hint, player_name)
  values (:ln_e, :imp, 5, 'inventory', 'Absurd source row',
          repeat('SIZE 10.5 WIDE ', 200), repeat('g', 5000), repeat('p', 1000));

select is(
  (select length(variant_size_original) from public.po_import_lines where id = :ln_e),
  3000,
  'a 3000-character variant_size_original is stored untruncated');

-- ── 25. mapping_confidence keeps three decimals ────────────────────────────
select is(
  (select mapping_confidence from public.po_import_lines where id = :ln_b),
  0.875::numeric(4,3),
  'mapping_confidence keeps its three decimal places');

-- ── 26. Deleting the suggested group nulls the hint, never the line ────────
delete from public.product_groups where id = :grp;

select is(
  (select coalesce(suggested_group_id::text, 'NULL') || '/' || description
     from public.po_import_lines where id = :ln_b),
  'NULL/Falcons Home Jersey - M',
  'deleting the suggested group nulls suggested_group_id and keeps the line');

select * from finish();
rollback;
