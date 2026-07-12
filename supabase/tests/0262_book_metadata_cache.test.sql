-- supabase/tests/0262_book_metadata_cache.test.sql
-- Proves migration 0262 (persistent ISBN metadata cache):
--   S1. Table exists with the expected columns + isbn primary key.
--   S2. Column defaults (authors/sources '[]', fetched_at now()).
--   S3. RLS enabled with NO policies (service-role-only reference cache).
--   S4. Upsert on the isbn PK replaces the row (cache refresh semantics).
-- Namespace ab026200. Wrapped in begin/rollback.

begin;

select plan(10);

-- S1. Structure
select has_table('public', 'book_metadata_cache', 'book_metadata_cache table exists');
select col_is_pk('public', 'book_metadata_cache', 'isbn', 'isbn is the primary key');
select has_column('public', 'book_metadata_cache', 'thumbnail_url', 'has thumbnail_url');
select has_column('public', 'book_metadata_cache', 'sources', 'has sources');

-- S2. Defaults
insert into public.book_metadata_cache (isbn, title) values ('9780000000001', 'Test Title');
select is(
  (select authors from public.book_metadata_cache where isbn = '9780000000001'),
  '[]'::jsonb,
  'authors defaults to []'
);
select is(
  (select sources from public.book_metadata_cache where isbn = '9780000000001'),
  '[]'::jsonb,
  'sources defaults to []'
);
select isnt(
  (select fetched_at from public.book_metadata_cache where isbn = '9780000000001'),
  null,
  'fetched_at is defaulted'
);

-- S3. RLS enabled, no policies
select is(
  (select relrowsecurity from pg_class where oid = 'public.book_metadata_cache'::regclass),
  true,
  'RLS is enabled'
);
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'book_metadata_cache'),
  0,
  'no RLS policies (service-role only)'
);

-- S4. Upsert on isbn PK refreshes the row
insert into public.book_metadata_cache (isbn, title, publisher)
  values ('9780000000001', 'Refreshed Title', 'New Publisher')
  on conflict (isbn) do update
    set title = excluded.title, publisher = excluded.publisher;
select is(
  (select title || '|' || publisher from public.book_metadata_cache where isbn = '9780000000001'),
  'Refreshed Title|New Publisher',
  'upsert on isbn refreshes the cached row'
);

select * from finish();
rollback;
