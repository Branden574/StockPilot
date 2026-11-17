#!/usr/bin/env node
// Removes what seed.mjs made, from the LOCAL stack only.
//
//   node load-tests/k6/tools/teardown.mjs --manifest <manifest.json>
//   node load-tests/k6/tools/teardown.mjs --all     every loadtest-* organization
//                                                  and loadtest+* account
//
// Deletes every row of the organization from each public table that has an
// organization_id (repeating passes until foreign keys stop refusing), the
// organization, the rate-limit rows of its accounts, then the accounts
// themselves (auth.users; their sessions and identities go with them). Ends by
// counting what is left and fails if anything is.
import { lit, parseArgs, psql, readJson } from './local.mjs';

function orgIdsFor(args) {
  if (args.all) {
    const out = psql(
      `select id from public.organizations where slug::text like 'loadtest-%';`,
    ).trim();
    return out ? out.split('\n') : [];
  }
  if (!args.manifest) throw new Error('--manifest <path> or --all is required');
  const m = readJson(args.manifest);
  if (m.kind !== 'stockpilot-loadtest-manifest') throw new Error('not a seeder manifest');
  return [m.organizationId];
}

function userIdsFor(args) {
  if (args.all) {
    const out = psql(`select id from auth.users where email like 'loadtest+%@example.com';`).trim();
    return out ? out.split('\n') : [];
  }
  const m = readJson(args.manifest);
  return Object.values(m.users)
    .flat()
    .map((u) => u.id);
}

function teardownOrg(orgId) {
  // Only organizations the seeder made: the slug says so.
  const slug = psql(`select slug from public.organizations where id = ${lit(orgId)};`).trim();
  if (slug && !slug.startsWith('loadtest-'))
    throw new Error(`organization ${orgId} is not a load-test organization`);
  const report = psql(`
set statement_timeout = 0;
set lock_timeout = '10s';
create temp table _teardown(msg text);
do $$
declare
  v_org uuid := ${lit(orgId)};
  t text;
  n bigint;
  progress boolean;
  pass int := 0;
  stuck text[];
begin
  loop
    pass := pass + 1;
    progress := false;
    stuck := '{}';
    for t in
      select c.table_name
        from information_schema.columns c
        join information_schema.tables tb
          on tb.table_schema = c.table_schema and tb.table_name = c.table_name
       where c.table_schema = 'public' and c.column_name = 'organization_id'
         and tb.table_type = 'BASE TABLE' and c.table_name <> 'organizations'
       order by c.table_name
    loop
      begin
        execute format('delete from public.%I where organization_id = $1', t) using v_org;
        get diagnostics n = row_count;
        if n > 0 then progress := true; end if;
      exception when others then
        stuck := stuck || (t || ': ' || sqlerrm);
      end;
    end loop;
    exit when not progress or pass >= 25;
  end loop;
  begin
    delete from public.organizations where id = v_org;
  exception when others then
    stuck := stuck || ('organizations: ' || sqlerrm);
  end;
  insert into _teardown select unnest(stuck);
end $$;
select msg from _teardown;
`);
  return report.trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const orgs = orgIdsFor(args);
  const users = userIdsFor(args);
  for (const org of orgs) {
    const stuck = teardownOrg(org);
    if (stuck) console.log(`[teardown] could not delete (last pass):\n${stuck}`);
    console.log(`[teardown] organization ${org} done`);
  }
  if (users.length) {
    const ids = users.map(lit).join(',');
    psql(`
begin;
delete from public.rate_limit_buckets where ${users.map((u) => `key like ${lit(`%:${u}`)}`).join(' or ')};
delete from auth.users where id in (${ids}) and email like 'loadtest+%@example.com';
commit;`);
    console.log(`[teardown] ${users.length} accounts removed`);
  }
  // What is left, by table.
  const left = psql(`
create temp table _left(msg text);
do $$
declare t text; n bigint; total bigint := 0; orgs uuid[] := array[${orgs.map(lit).join(',') || 'null'}]::uuid[];
begin
  for t in select c.table_name from information_schema.columns c
             join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
            where c.table_schema = 'public' and c.column_name = 'organization_id' and tb.table_type = 'BASE TABLE'
  loop
    execute format('select count(*) from public.%I where organization_id = any($1)', t) using orgs into n;
    if n > 0 then insert into _left values (t || ': ' || n); total := total + n; end if;
  end loop;
  select count(*) into n from public.organizations where id = any(orgs);
  total := total + n;
  select count(*) into n from auth.users where id = any(array[${users.map(lit).join(',') || 'null'}]::uuid[]);
  total := total + n;
  if total > 0 then insert into _left values ('total: ' || total); end if;
end $$;
select coalesce(string_agg(msg, E'\n'), 'clean') from _left;`);
  if (left.trim() !== 'clean') throw new Error(`rows are left:\n${left.trim()}`);
  console.log(`[teardown] ${left.trim()}`);
}

try {
  main();
} catch (e) {
  console.error(`[teardown] ${e.message}`);
  process.exit(1);
}
