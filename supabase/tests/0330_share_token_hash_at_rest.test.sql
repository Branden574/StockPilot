-- supabase/tests/0330_share_token_hash_at_rest.test.sql
-- Proves migration 0330 (security MED-26): the three share/public-link token
-- columns no longer exist in PLAINTEXT form; each is replaced by a 64-hex
-- sha256 hash column with a UNIQUE index (literal-pinned names), and the
-- shape checks refuse non-digest values so a future writer cannot quietly
-- store a raw token in the hash column's clothes.
--
-- THE PROPERTY, NOT THE IMPLEMENTATION: the load-bearing assertions are
-- hasnt_column on the three plaintext columns (a DB dump can no longer
-- contain a working /r or /m credential) and the functional inserts below
-- (a digest-shaped value is accepted; a plausible RAW-token-shaped value —
-- mixed-length, uppercase, or non-hex — is refused with 23514).
--
-- Fixtures inserted as postgres (bypassing RLS — column existence and CHECK
-- constraints are not RLS boundaries). Namespace: a0330000. begin/rollback.

begin;

select plan(22);

-- ── 1) plaintext columns are GONE ───────────────────────────────────────────
select hasnt_column('public', 'public_request_links', 'token',
  'MED-26: public_request_links.token (plaintext) is dropped');
select hasnt_column('public', 'maintenance_request_share_links', 'token',
  'MED-26: maintenance_request_share_links.token (plaintext) is dropped');
select hasnt_column('public', 'organizations', 'public_request_token',
  'MED-26: organizations.public_request_token (plaintext) is dropped');

-- ── 2) hash columns exist with the right nullability ────────────────────────
select has_column('public', 'public_request_links', 'token_hash',
  'public_request_links.token_hash exists');
select col_not_null('public', 'public_request_links', 'token_hash',
  'public_request_links.token_hash is NOT NULL');
select has_column('public', 'maintenance_request_share_links', 'token_hash',
  'maintenance_request_share_links.token_hash exists');
select col_not_null('public', 'maintenance_request_share_links', 'token_hash',
  'maintenance_request_share_links.token_hash is NOT NULL');
select has_column('public', 'organizations', 'public_request_token_hash',
  'organizations.public_request_token_hash exists');
select col_is_null('public', 'organizations', 'public_request_token_hash',
  'organizations.public_request_token_hash stays nullable (orgs without the feature)');

-- ── 3) unique indexes on the hashes (literal-pinned names) ──────────────────
select has_index('public', 'public_request_links', 'public_request_links_token_hash_uniq',
  'unique index public_request_links_token_hash_uniq exists');
select index_is_unique('public', 'public_request_links', 'public_request_links_token_hash_uniq',
  'public_request_links_token_hash_uniq is UNIQUE');
select has_index('public', 'maintenance_request_share_links', 'maintenance_request_share_links_token_hash_uniq',
  'unique index maintenance_request_share_links_token_hash_uniq exists');
select index_is_unique('public', 'maintenance_request_share_links', 'maintenance_request_share_links_token_hash_uniq',
  'maintenance_request_share_links_token_hash_uniq is UNIQUE');
select has_index('public', 'organizations', 'organizations_public_request_token_hash_idx',
  'partial unique index organizations_public_request_token_hash_idx exists');
select index_is_unique('public', 'organizations', 'organizations_public_request_token_hash_idx',
  'organizations_public_request_token_hash_idx is UNIQUE');

-- The 0044-era plaintext unique index went down with its column.
select hasnt_index('public', 'organizations', 'organizations_public_request_token_idx',
  'the old plaintext unique index organizations_public_request_token_idx is gone');

-- ── 4) per-request track token (order_requests) ─────────────────────────────
select has_column('public', 'order_requests', 'public_track_token',
  'order_requests.public_track_token exists (per-request track credential for status emails)');

-- ── 5) functional shape checks: digest in, raw-token shapes out ─────────────
-- Fixtures.
insert into public.organizations (id, name, slug)
values ('a0330000-0000-0000-0000-000000000001', 'MED-26 Test Org', 'a0330000-med26');

-- A genuine sha256 hex digest is accepted (the positive that keeps the
-- negatives below honest — a constraint refusing everything fails here).
select lives_ok(
  $$ insert into public.public_request_links (organization_id, name, token_hash)
     values ('a0330000-0000-0000-0000-000000000001', 'ok link',
             encode(extensions.digest('a0330000 plaintext', 'sha256'), 'hex')) $$,
  'a 64-hex digest is accepted into public_request_links.token_hash');

-- A raw-token-shaped value the OLD column accepted (short hex, 32 chars —
-- length(token) between 16 and 128 allowed it) is refused: only exact
-- sha256-hex fits, so the hash column can never quietly hold a plaintext.
select throws_ok(
  $$ insert into public.public_request_links (organization_id, name, token_hash)
     values ('a0330000-0000-0000-0000-000000000001', 'short raw', repeat('ab', 16)) $$,
  '23514', null,
  'a 32-hex raw-token-shaped value is refused by public_request_links_token_hash_shape');

select throws_ok(
  $$ insert into public.public_request_links (organization_id, name, token_hash)
     values ('a0330000-0000-0000-0000-000000000001', 'uppercase', upper(repeat('ab', 32))) $$,
  '23514', null,
  'uppercase hex is refused (digests are minted lowercase; anything else is not a digest we wrote)');

select throws_ok(
  $$ update public.organizations
        set public_request_token_hash = 'not-a-digest-at-all'
      where id = 'a0330000-0000-0000-0000-000000000001' $$,
  '23514', null,
  'a non-hex value is refused by organizations_public_request_token_hash_shape');

-- order_requests fixtures would drag in warehouses/lines; the column-level
-- CHECK's existence is what matters here (its shape mirrors the three
-- above, which ARE functionally exercised).
select col_has_check('public', 'order_requests', 'public_track_token',
  'order_requests.public_track_token carries its 64-hex shape CHECK');

select * from finish();
rollback;
