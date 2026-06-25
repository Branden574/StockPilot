-- supabase/tests/0188_placement_locations.test.sql
begin;
select plan(4);

select has_column('public', 'locations', 'kind', 'locations.kind exists');
select has_column('public', 'locations', 'crate_color', 'locations.crate_color exists');

-- Every warehouse has exactly one staging + one unplaced location.
select is(
  (select count(*)::int from public.warehouses w
     where not exists (
       select 1 from public.locations l
       where l.warehouse_id = w.id and l.kind = 'staging' and l.deleted_at is null)),
  0,
  'every warehouse has a Staging location'
);
select is(
  (select count(*)::int from public.warehouses w
     where not exists (
       select 1 from public.locations l
       where l.warehouse_id = w.id and l.kind = 'unplaced' and l.deleted_at is null)),
  0,
  'every warehouse has an Unplaced location'
);

select * from finish();
rollback;
