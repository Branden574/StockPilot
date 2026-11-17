#!/usr/bin/env node
// One command: seed a scale point, run a ladder of load steps, check the data,
// write the report, tear down. LOCAL ONLY.
//
//   node --env-file=<loadtest env file> load-tests/k6/run-scale.mjs \
//     --items 10001 --users-per-role 40 --ladder 25,50,100,250 --duration 5m --warmup 60s \
//     --out load-tests/results/<name>
//
// The env file (outside the repository, never printed) sets:
//   LOADTEST_BASE_URL                  the app, built and started locally (http://127.0.0.1:3600)
//   LOADTEST_SUPABASE_URL              the local Supabase API (http://127.0.0.1:<port>)
//   LOADTEST_SUPABASE_ANON_KEY         its anon key
//   LOADTEST_SUPABASE_SERVICE_ROLE_KEY its service key (seeding, and minting sessions in k6 setup())
//   LOADTEST_DB_URL                    its database (postgresql://...@127.0.0.1:<port>/postgres)
// Every one of them must name this machine; anything else is refused before
// any connection is made.
//
// Options:
//   --items N             1000 | 10001 | 50000 ... (default 1000)
//   --users-per-role N    accounts per role (default 20; 40-50 for the 250 step)
//   --ladder a,b,c        concurrent people per step (default 25,50,100,250)
//   --duration D          steady time per step, e.g. 3m (default 3m)
//   --warmup D            one run at the first rate before the ladder, not reported (default 30s; 0 to skip)
//   --scenario F          k6 scenario (default scenarios/10-roles-workload.js)
//   --manifest M          reuse an organization seeded earlier instead of seeding
//   --keep                do not tear down at the end
//   --continue-on-fail    run the next step even when a step failed its thresholds
//   --out DIR             the run folder (default load-tests/results/<timestamp>)
//
// Each step: database time -> pg_stat_statements snapshot -> connection
// sampler -> k6 -> snapshot -> correctness check. A step whose sign-in,
// authenticator, scope or correctness checks failed stops the ladder.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { localTarget } from './lib/safety.js';
import { localDb, localSupabase, parseArgs, psql, readJson } from './tools/local.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(HERE, 'tools');

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', env: process.env, ...opts });
  if (res.error) throw res.error;
  return res.status;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Every address, checked before anything connects.
  const target = localTarget(process.env);
  localSupabase();
  localDb();
  if (!process.env.LOADTEST_SUPABASE_ANON_KEY)
    throw new Error('LOADTEST_SUPABASE_ANON_KEY is not set.');
  if (spawnSync('k6', ['version'], { encoding: 'utf8' }).status !== 0)
    throw new Error('k6 is not installed (brew install k6).');

  const ladder = String(args.ladder ?? '25,50,100,250')
    .split(',')
    .map((s) => Number(s.trim()));
  if (ladder.some((n) => !Number.isFinite(n) || n <= 0))
    throw new Error('--ladder must be positive numbers');
  const duration = String(args.duration ?? '3m');
  const warmup = String(args.warmup ?? '30s');
  const scenario = resolve(HERE, String(args.scenario ?? 'scenarios/10-roles-workload.js'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = resolve(String(args.out ?? join(HERE, '..', 'results', stamp)));
  mkdirSync(join(out, 'steps'), { recursive: true });

  // The app answers on this machine.
  const ping = await fetch(`${target.baseUrl}/signin`, { redirect: 'manual' }).catch((e) => ({
    status: `unreachable (${e.message})`,
  }));
  if (ping.status !== 200)
    throw new Error(
      `The app at LOADTEST_BASE_URL answered /signin with ${ping.status}. Build and start it first (see README).`,
    );

  let manifestPath = args.manifest ? resolve(String(args.manifest)) : join(out, 'manifest.json');
  if (!args.manifest) {
    const code = run('node', [
      join(TOOLS, 'seed.mjs'),
      '--items',
      String(args.items ?? 1000),
      '--users-per-role',
      String(args['users-per-role'] ?? 20),
      '--out',
      manifestPath,
    ]);
    if (code !== 0) throw new Error('seeding failed');
  }
  const manifest = readJson(manifestPath);
  writeFileSync(
    join(out, 'run.json'),
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        label: args.label || null,
        baseUrl: target.baseUrl,
        organizationId: manifest.organizationId,
        items: manifest.scale.items,
        usersPerRole: manifest.scale.usersPerRole,
        ladder,
        duration,
        warmup,
        scenario: scenario.split('/load-tests/')[1] || scenario,
      },
      null,
      1,
    ),
  );

  const k6Env = (actors, dur, summaryOut) => ({
    ...process.env,
    LOADTEST_MANIFEST: manifestPath,
    LOADTEST_ACTORS: String(actors),
    LOADTEST_DURATION: dur,
    LOADTEST_SUMMARY_OUT: summaryOut,
    K6_NO_USAGE_REPORT: 'true',
  });

  if (warmup !== '0' && warmup !== '0s') {
    console.log(`\n== warm-up: ${ladder[0]} actors for ${warmup} (not reported)`);
    mkdirSync(join(out, 'warmup'), { recursive: true });
    run('k6', ['run', '-q', scenario], {
      env: k6Env(ladder[0], warmup, join(out, 'warmup', 'summary.json')),
    });
  }

  let failed = false;
  for (const actors of ladder) {
    const dir = join(out, 'steps', String(actors));
    mkdirSync(dir, { recursive: true });
    console.log(`\n== step: ${actors} actors for ${duration}`);
    const since = psql('select now();').trim();
    writeFileSync(join(dir, 'since.txt'), since);
    run('node', [join(TOOLS, 'pgstat.mjs'), 'snapshot', '--out', join(dir, 'pg-before.json')]);
    const sampler = spawn(
      'node',
      [
        join(TOOLS, 'pgstat.mjs'),
        'sample',
        '--out',
        join(dir, 'connections.jsonl'),
        '--every',
        '2',
      ],
      {
        stdio: 'ignore',
        env: process.env,
      },
    );
    const stopSampler = () => sampler.kill('SIGTERM');
    process.once('exit', stopSampler);
    const code = run('k6', ['run', '-q', scenario], {
      env: k6Env(actors, duration, join(dir, 'summary.json')),
    });
    stopSampler();
    process.removeListener('exit', stopSampler);
    writeFileSync(join(dir, 'k6-exit.txt'), String(code));
    run('node', [join(TOOLS, 'pgstat.mjs'), 'snapshot', '--out', join(dir, 'pg-after.json')]);
    let correctnessOk = false;
    if (existsSync(join(dir, 'summary.json'))) {
      console.log('-- correctness');
      correctnessOk =
        run('node', [
          join(TOOLS, 'check-correctness.mjs'),
          '--manifest',
          manifestPath,
          '--summary',
          join(dir, 'summary.json'),
          '--since',
          since,
          '--out',
          join(dir, 'correctness.json'),
        ]) === 0;
    }
    const summary = existsSync(join(dir, 'summary.json'))
      ? JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'))
      : null;
    const count = (n) => (summary && summary.metrics[n] ? summary.metrics[n].values.count : 0);
    const hardFail =
      !summary ||
      !correctnessOk ||
      count('signin_redirects') > 0 ||
      count('mfa_required') > 0 ||
      count('scope_violations') > 0 ||
      count('viewer_write_allowed') > 0 ||
      (summary.metrics.auth_ok && summary.metrics.auth_ok.values.rate < 1);
    if (code !== 0) failed = true;
    if (hardFail) {
      failed = true;
      console.log('!! sign-in, scope or correctness failed: the ladder stops here.');
      break;
    }
    if (code !== 0 && !args['continue-on-fail']) {
      console.log(
        `!! k6 exited ${code} (a threshold failed): the ladder stops here (--continue-on-fail runs on).`,
      );
      break;
    }
  }

  console.log('\n== report');
  run('node', [join(TOOLS, 'report.mjs'), '--dir', out]);
  console.log(`\nReport: ${join(out, 'report.md')}`);

  if (!args.keep && !args.manifest) {
    console.log('\n== teardown');
    run('node', [join(TOOLS, 'teardown.mjs'), '--manifest', manifestPath]);
  } else {
    console.log(
      `\nKept the organization. Remove it with: node --env-file=<env> ${join('load-tests', 'k6', 'tools', 'teardown.mjs')} --manifest ${manifestPath}`,
    );
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(`[run-scale] ${e.message}`);
  process.exit(1);
});
