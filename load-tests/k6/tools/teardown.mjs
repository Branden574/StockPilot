#!/usr/bin/env node
// Removes what seed.mjs made, from the LOCAL stack only.
//
//   node load-tests/k6/tools/teardown.mjs --manifest <manifest.json>
//   node load-tests/k6/tools/teardown.mjs --all          lists what it would delete
//   node load-tests/k6/tools/teardown.mjs --all --yes    and deletes it
//
// --all finds what the seeder makes and nothing else: organizations whose slug
// is loadtest-<4-16 letters or digits> AND whose name is "Load Test Org <the
// same id>", and accounts whose email is loadtest+<id>-<role>-<n>@example.com
// that belong to no other organization. Without --yes it only lists them.
//
// Deletes every row of the organization from each public table that has an
// organization_id (repeating passes until foreign keys stop refusing), the
// organization, the rate-limit rows of its accounts, then the accounts
// themselves (auth.users; their sessions and identities go with them). Ends by
// counting what is left and fails if anything is. The database must be on
// this machine (local.mjs refuses any other address).
import { lit, parseArgs, psql, readJson } from './local.mjs';
import {
  EMAIL_RE,
  EMAIL_RE_JS,
  SLUG_RE,
  seededOrgsSql,
  seededUsersSql,
  uuidArray,
} from './teardown-sql.mjs';

function lines(out) {
  const t = out.trim();
  return t ? t.split('\n') : [];
}

function orgsFor(args) {
  if (args.all) {
    return lines(psql(seededOrgsSql())).map((l) => {
      const [id, slug, name] = l.split('|');
      return { id, slug, name };
    });
  }
  if (!args.manifest) throw new Error('--manifest <path> or --all is required');
  const m = readJson(args.manifest);
  if (m.kind !== 'stockpilot-loadtest-manifest') throw new Error('not a seeder manifest');
  return [{ id: m.organizationId, slug: m.slug, name: null }];
}

function usersFor(args, orgIds) {
  if (args.all) {
    // Seeder accounts that belong to no organization but the load-test ones.
    return lines(psql(seededUsersSql(orgIds))).map((l) => {
      const [id, email] = l.split('|');
      return { id, email };
    });
  }
  const m = readJson(args.manifest);
  return Object.values(m.users)
    .flat()
    .filter((u) => EMAIL_RE_JS.test(String(u.email)))
    .map((u) => ({ id: u.id, email: u.email }));
}

function teardownOrg(orgId) {
  // Only organizations the seeder made: the slug and the name say so.
  const ok = psql(`select count(*) from public.organizations
                    where id = ${lit(orgId)} and slug::text ~ ${lit(SLUG_RE)}
                      and name = 'Load Test Org ' || substr(slug::text, 10);`).trim();
  const exists = psql(`select count(*) from public.organizations where id = ${lit(orgId)};`).trim();
  if (exists !== '0' && ok !== '1')
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
  const orgRows = orgsFor(args);
  const orgs = orgRows.map((o) => o.id);
  const userRows = usersFor(args, orgs);
  const users = userRows.map((u) => u.id);
  if (args.all && !args.yes) {
    console.log(`[teardown] --all would delete ${orgRows.length} organizations:`);
    for (const o of orgRows) console.log(`  ${o.slug}  ${o.name}  ${o.id}`);
    console.log(`[teardown] and ${userRows.length} accounts:`);
    for (const u of userRows) console.log(`  ${u.email}`);
    console.log('[teardown] Nothing deleted. Run again with --all --yes to delete them.');
    return;
  }
  for (const org of orgs) {
    const stuck = teardownOrg(org);
    if (stuck) console.log(`[teardown] could not delete (last pass):\n${stuck}`);
    console.log(`[teardown] organization ${org} done`);
  }
  if (users.length) {
    const ids = users.map(lit).join(',');
    // Only these accounts' limiter rows (keys end in :<user id>), and only
    // accounts with the seeder's email shape.
    psql(`
begin;
delete from public.rate_limit_buckets b
 using auth.users u
 where u.id in (${ids}) and u.email ~ ${lit(EMAIL_RE)}
   and b.key like '%:' || u.id::text;
delete from auth.users where id in (${ids}) and email ~ ${lit(EMAIL_RE)};
commit;`);
    console.log(`[teardown] ${users.length} accounts removed`);
  }
  // What is left, by table.
  const left = psql(`
create temp table _left(msg text);
do $$
declare t text; n bigint; total bigint := 0; orgs uuid[] := ${uuidArray(orgs)};
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
  select count(*) into n from auth.users where id = any(${uuidArray(users)});
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
