-- Census of the privileges the Data API roles hold on public relations.
--
-- READ-ONLY: one SELECT that prints one JSON document. It is safe to run against
-- production (psql -X -A -t -q -f scripts/explicit-grants/census.sql "<url>" > census.json)
-- or against a scratch database loaded from `supabase db dump --schema public`.
-- scripts/gen-explicit-grants-sql.mjs turns the JSON into GRANT statements.
--
-- Scope: every relation in schema public (tables r, partitioned tables p, views v,
-- materialized views m, sequences S, foreign tables f) that is not an extension
-- member, its table-level privileges and its column-level privileges, for the
-- roles anon, authenticated and service_role. A NULL relacl means the owner's
-- default (acldefault), which gives these roles nothing unless one of them owns
-- the relation.
with roles as (
  select r.oid, r.rolname
  from pg_catalog.pg_roles r
  where r.rolname in ('anon', 'authenticated', 'service_role')
),
rels as (
  select c.oid, c.relname, c.relkind, c.relowner, c.relacl,
         exists (
           select 1 from pg_catalog.pg_depend d
           where d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
             and d.objid = c.oid and d.deptype = 'e'
         ) as ext_member
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
),
rel_privs as (
  select r.oid, ro.rolname, a.privilege_type, a.is_grantable
  from rels r
  cross join lateral pg_catalog.aclexplode(coalesce(
    r.relacl,
    pg_catalog.acldefault(case when r.relkind = 'S' then 's'::"char" else 'r'::"char" end, r.relowner)
  )) a
  join roles ro on ro.oid = a.grantee
  where not r.ext_member
),
col_privs as (
  select r.oid, att.attname, ro.rolname, a.privilege_type, a.is_grantable
  from rels r
  join pg_catalog.pg_attribute att on att.attrelid = r.oid and att.attnum > 0 and not att.attisdropped
  cross join lateral pg_catalog.aclexplode(att.attacl) a
  join roles ro on ro.oid = a.grantee
  where not r.ext_member and att.attacl is not null
)
select pg_catalog.json_build_object(
  'census', 'scripts/explicit-grants/census.sql',
  'database', pg_catalog.current_database(),
  'server_version', pg_catalog.current_setting('server_version'),
  'taken_at', pg_catalog.to_char(pg_catalog.now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'roles', (select pg_catalog.json_agg(rolname order by rolname) from roles),
  'extension_members', (
    select coalesce(pg_catalog.json_agg(relname order by relname), '[]'::json)
    from rels where ext_member
  ),
  'relations', (
    select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object(
      'name', r.relname,
      'ident', pg_catalog.quote_ident(r.relname),
      'kind', r.relkind,
      'owner', pg_catalog.pg_get_userbyid(r.relowner),
      'privileges', (
        select coalesce(pg_catalog.json_agg(
          pg_catalog.json_build_array(p.rolname, p.privilege_type, p.is_grantable)
          order by p.rolname, p.privilege_type), '[]'::json)
        from rel_privs p where p.oid = r.oid
      ),
      'columns', (
        select coalesce(pg_catalog.json_agg(
          pg_catalog.json_build_array(
            p.attname, pg_catalog.quote_ident(p.attname), p.rolname, p.privilege_type, p.is_grantable)
          order by p.rolname, p.privilege_type, p.attname), '[]'::json)
        from col_privs p where p.oid = r.oid
      )
    ) order by r.relname), '[]'::json)
    from rels r where not r.ext_member
  )
);
