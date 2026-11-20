#!/usr/bin/env node
// Database counters from the LOCAL stack, for before/after a run.
//
//   node load-tests/k6/tools/pgstat.mjs snapshot --out before.json
//   node load-tests/k6/tools/pgstat.mjs sample --out connections.jsonl [--every 2]
//      (writes one line of connection counts every N seconds until stopped)
//
// A snapshot holds pg_stat_statements (calls, time, rows, blocks per query,
// text cut to 400 characters) and the connections by role, application and
// state. Diffing two snapshots by queryid gives the statements a run caused,
// without resetting anything.
import { appendFileSync, writeFileSync } from 'node:fs';

import { parseArgs, psqlJson } from './local.mjs';

export function snapshot() {
  return psqlJson(`
select json_build_object(
  'takenAt', now(),
  'statements', (select coalesce(json_agg(s), '[]') from (
     select queryid::text as queryid, userid::regrole::text as role, left(regexp_replace(query, '\\s+', ' ', 'g'), 400) as query,
            calls, round(total_exec_time::numeric, 3) as total_ms, rows,
            shared_blks_hit as hit, shared_blks_read as read
       from pg_stat_statements
      where dbid = (select oid from pg_database where datname = current_database())) s),
  'connections', (select json_build_object(
     'total', count(*),
     'active', count(*) filter (where state = 'active'),
     'idle', count(*) filter (where state = 'idle'),
     'idleInTransaction', count(*) filter (where state like 'idle in transaction%'),
     'byRole', (select coalesce(json_object_agg(r, n), '{}') from (select coalesce(usename, '-') r, count(*) n from pg_stat_activity
                where backend_type = 'client backend' group by 1) x),
     'byApp', (select coalesce(json_object_agg(a, n), '{}') from (select coalesce(nullif(application_name, ''), '-') a, count(*) n
                from pg_stat_activity where backend_type = 'client backend' group by 1) y))
     from pg_stat_activity where backend_type = 'client backend'),
  'maxConnections', current_setting('max_connections')::int
);`);
}

function sampleOnce() {
  return psqlJson(`
select json_build_object('t', now(), 'total', count(*),
  'active', count(*) filter (where state = 'active'),
  'idleInTransaction', count(*) filter (where state like 'idle in transaction%'),
  'waitingOnLock', count(*) filter (where wait_event_type = 'Lock'))
  from pg_stat_activity where backend_type = 'client backend';`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args._[0];
  if (!args.out) throw new Error('--out is required');
  if (mode === 'snapshot') {
    writeFileSync(args.out, JSON.stringify(snapshot()));
    return;
  }
  if (mode === 'sample') {
    const every = Number(args.every ?? 2) * 1000;
    let stop = false;
    process.on('SIGTERM', () => (stop = true));
    process.on('SIGINT', () => (stop = true));
    const parent = process.ppid;
    // Stops by itself if the runner that started it is gone.
    while (!stop && process.ppid === parent) {
      try {
        appendFileSync(args.out, `${JSON.stringify(sampleOnce())}\n`);
      } catch (e) {
        appendFileSync(
          args.out,
          `${JSON.stringify({ t: new Date().toISOString(), error: String(e.message).slice(0, 200) })}\n`,
        );
      }
      await new Promise((r) => setTimeout(r, every));
    }
    return;
  }
  throw new Error('mode must be snapshot or sample');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`[pgstat] ${e.message}`);
    process.exit(1);
  });
}
