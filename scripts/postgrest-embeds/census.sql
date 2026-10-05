-- Read-only census of what PostgREST builds embed relationships from, in the
-- public schema. One JSON document:
--   {"fks":   [[table, constraint, referenced table, [columns], [referenced columns]], ...],
--    "pks":   {table: [primary key columns], ...},
--    "views": [view names]}
-- scripts/gen-postgrest-embed-snapshot.mjs turns it into
-- scripts/postgrest-embeds/relationships.snapshot.json. It only reads the
-- catalog, so it may be run against any database (for production, through a
-- read-only channel; save the output and pass it with --census).
--
-- Partition clones are left out (conparentid <> 0, relispartition), as
-- PostgREST leaves them out.
select json_build_object(
  'fks', coalesce((
    select json_agg(
             json_build_array(
               t.relname, c.conname, rt.relname,
               (select json_agg(a.attname order by k.ord)
                  from unnest(c.conkey) with ordinality as k(attnum, ord)
                  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum),
               (select json_agg(a.attname order by k.ord)
                  from unnest(c.confkey) with ordinality as k(attnum, ord)
                  join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum))
             order by t.relname, c.conname)
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      join pg_class rt on rt.oid = c.confrelid
      join pg_namespace rn on rn.oid = rt.relnamespace
     where c.contype = 'f'
       and c.conparentid = 0
       and n.nspname = 'public'
       and rn.nspname = 'public'
       and not t.relispartition
       and not rt.relispartition), '[]'::json),
  'pks', coalesce((
    select json_object_agg(
             t.relname,
             (select json_agg(a.attname order by k.ord)
                from unnest(c.conkey) with ordinality as k(attnum, ord)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
             order by t.relname)
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where c.contype = 'p'
       and n.nspname = 'public'
       and not t.relispartition), '{}'::json),
  'views', coalesce((
    select json_agg(t.relname order by t.relname)
      from pg_class t
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relkind in ('v', 'm')), '[]'::json)
)::text as census;
