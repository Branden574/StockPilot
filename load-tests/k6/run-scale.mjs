#!/usr/bin/env node
// One command: start the app, seed a scale point, run a ladder of load steps,
// check the data, write the report, tear down, stop the app. LOCAL ONLY.
//
//   node --env-file=<loadtest env file> load-tests/k6/run-scale.mjs --app-env <app env file> \
//     --items 10001 --users-per-role 40 --ladder 25,50,100,250 --duration 5m --warmup 60s \
//     --out load-tests/results/<name>
//
// The loadtest env file (outside the repository, never printed) sets:
//   LOADTEST_BASE_URL                  where the app will listen (http://127.0.0.1:3600)
//   LOADTEST_SUPABASE_URL              the local Supabase API (http://127.0.0.1:<port>)
//   LOADTEST_SUPABASE_ANON_KEY         its anon key
//   LOADTEST_SUPABASE_SERVICE_ROLE_KEY its service key (seeding, and minting sessions in k6 setup())
//   LOADTEST_DB_URL                    its database (postgresql://...@127.0.0.1:<port>/postgres)
// Every one of them must name this machine (127.0.0.1 or [::1]); anything
// else is refused before any connection is made. Node's environment proxy
// must be off (tools/local.mjs refuses NODE_USE_ENV_PROXY and
// --use-env-proxy), and no child process gets a proxy setting or NODE_OPTIONS.
//
// The app: build it first in this worktree with the app env file
// (README). The runner then starts it ITSELF, from this worktree's apps/web,
// as `node --require tools/outbound-guard.cjs next start -p <port> -H <host>`
// with an environment made only of the app env file plus PATH and HOME. It
// refuses to start when the port is already taken, uses only the server it
// started, and stops it at the end. The outbound guard refuses every
// connection the server tries to make to anything but this machine; any
// refusal fails the step.
//
// It also refuses:
//   - an apps/web/.env* file (other than *.example) in this checkout: Next.js
//     reads those files, and a checkout's env file may hold real keys;
//   - an app env file that does not name LOADTEST_SUPABASE_URL, or that does
//     not set every outside-service key, proxy setting and pinned switch
//     (tools/app-env.mjs) to empty, or has no NEXT_PUBLIC_LIQUID_GLASS value;
//   - an app whose Content-Security-Policy connect-src names any Supabase
//     address other than LOADTEST_SUPABASE_URL (a build made with another
//     NEXT_PUBLIC_SUPABASE_URL, or with none, which falls back to the
//     production project).
//
// Options:
//   --app-env FILE        the app env file local-env.mjs wrote (required)
//   --items N             1000 | 10001 | 50000 ... (default 1000)
//   --users-per-role N    accounts per role (default 20; 40-50 for the 250 step)
//   --ladder a,b,c        concurrent people per step (default 25,50,100,250)
//   --duration D          steady time per step, e.g. 3m (default 3m)
//   --warmup D            one run at the first rate before the ladder, not reported (default 30s; 0 to skip)
//   --scenario F          k6 scenario, a file in load-tests/k6/scenarios/
//                         (default scenarios/10-roles-workload.js)
//   --manifest M          reuse an organization seeded earlier instead of seeding
//   --keep                do not tear down at the end
//   --continue-on-fail    run the next step even when a step failed its thresholds
//   --out DIR             the run folder (default load-tests/results/<timestamp>)
//
// Each step: database time -> pg_stat_statements snapshot -> connection
// sampler -> k6 -> wait for the database to go quiet -> snapshot ->
// correctness check. A step whose sign-in, authenticator, scope, outbound or
// correctness checks failed stops the ladder.
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isLoopbackUrl, localTarget } from './lib/safety.js';
import {
  isAppEnvFile,
  LIQUID_GLASS_VALUES,
  OUTSIDE_SERVICE_ENV,
  PINNED_DEFAULT_ENV,
} from './tools/app-env.mjs';
import {
  assertNoEnvProxy,
  childEnv,
  localDb,
  localSupabase,
  parseArgs,
  PROXY_ENV,
  psql,
  readJson,
} from './tools/local.mjs';

// Also done when local.mjs loads; stated here so the runner never depends on it.
assertNoEnvProxy();

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(HERE, 'tools');
const SCENARIOS = join(HERE, 'scenarios');
const CHECKOUT = resolve(HERE, '..', '..');
const WEB = join(CHECKOUT, 'apps', 'web');
const GUARD = join(TOOLS, 'outbound-guard.cjs');

/** apps/web/.env* files (not *.example) in this checkout. */
function appEnvFilesInCheckout() {
  const found = [];
  for (const dir of [CHECKOUT, WEB]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) if (isAppEnvFile(name)) found.push(join(dir, name));
  }
  return found;
}

/**
 * The app env file: NAME=value lines (local-env.mjs writes them unquoted), read
 * without printing a value, and checked.
 */
function readAppEnv(file, target) {
  if (!file)
    throw new Error('--app-env <file> is required (the app env file local-env.mjs wrote).');
  const real = realpathSync(resolve(String(file)));
  if (real.startsWith(`${realpathSync(CHECKOUT)}${sep}`))
    throw new Error('The app env file must be outside the repository.');
  const env = {};
  for (const line of readFileSync(real, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
  if (env.NEXT_PUBLIC_SUPABASE_URL !== target.supabaseUrl)
    throw new Error(
      'The app env file does not name LOADTEST_SUPABASE_URL as NEXT_PUBLIC_SUPABASE_URL.',
    );
  const notEmpty = [
    ...OUTSIDE_SERVICE_ENV,
    ...PINNED_DEFAULT_ENV,
    ...PROXY_ENV,
    'NODE_OPTIONS',
  ].filter((n) => env[n] !== '');
  if (notEmpty.length)
    throw new Error(
      `The app env file must set these to empty: ${notEmpty.join(', ')}. Write it again with local-env.mjs.`,
    );
  if (!LIQUID_GLASS_VALUES.includes(env.NEXT_PUBLIC_LIQUID_GLASS))
    throw new Error(
      `The app env file must pin NEXT_PUBLIC_LIQUID_GLASS to one of ${LIQUID_GLASS_VALUES.join(', ')}.`,
    );
  if (env.NODE_ENV !== 'production')
    throw new Error('The app env file must set NODE_ENV=production.');
  return env;
}

/** Process ids listening on `port` on this machine (lsof). */
function listeners(port) {
  const res = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
  });
  return String(res.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l))
    .map(Number);
}

/** The process and its children (pgrep -P). */
function familyOf(pid) {
  const kids = String(spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout || '')
    .split('\n')
    .filter((l) => /^\d+$/.test(l.trim()))
    .map(Number);
  return new Set([pid, ...kids]);
}

/** Lines in the outbound guard's log: one per refused connection. */
function refusals(file) {
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
}

/**
 * Starts the built app from this worktree under the outbound guard, with an
 * environment made only of the app env file plus PATH and HOME, and waits until
 * it answers. Refuses a port that is already taken.
 */
async function startServer(target, appEnv, out) {
  const url = new URL(target.baseUrl);
  const port = url.port;
  if (!port) throw new Error('LOADTEST_BASE_URL must name its port (http://127.0.0.1:3600).');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (listeners(port).length)
    throw new Error(
      `Port ${port} is already taken. Stop whatever listens there: the runner starts the app itself.`,
    );
  if (!existsSync(join(WEB, '.next', 'BUILD_ID')))
    throw new Error(
      'apps/web has no production build. Build it first with the app env file (README).',
    );
  const nextBin = join(WEB, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!existsSync(nextBin)) throw new Error('apps/web/node_modules has no next: install first.');
  const outboundLog = join(out, 'outbound-refused.log');
  writeFileSync(outboundLog, '');
  const logFd = openSync(join(out, 'server.log'), 'a');
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...appEnv,
    LOADTEST_OUTBOUND_LOG: outboundLog,
  };
  const child = spawn(
    process.execPath,
    ['--require', GUARD, nextBin, 'start', '-p', port, '-H', host],
    { cwd: WEB, env, stdio: ['ignore', logFd, logFd] },
  );
  closeSync(logFd);
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = signal || String(code);
  });
  const stop = () => {
    if (exited === null) child.kill('SIGTERM');
  };
  process.once('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM'])
    process.once(sig, () => {
      stop();
      process.exit(130);
    });
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (exited !== null)
      throw new Error(`The app exited while starting (${exited}); see ${join(out, 'server.log')}.`);
    const res = await fetch(`${target.baseUrl}/signin`, { redirect: 'error' }).catch(() => null);
    if (res && res.status === 200) break;
    if (Date.now() > deadline) {
      stop();
      throw new Error(
        `The app did not answer /signin within 120 s; see ${join(out, 'server.log')}.`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // Only the server this run started may be the one answering.
  const family = familyOf(child.pid);
  const strangers = listeners(port).filter((pid) => !family.has(pid));
  if (strangers.length) {
    stop();
    throw new Error(`Another process also listens on port ${port}; refusing to measure it.`);
  }
  return { stop, outboundLog, pid: child.pid };
}

/** Refuses an app built for anything but the local stack (its CSP connect-src). */
async function checkBuildIsLocal(target) {
  const res = await fetch(`${target.baseUrl}/signin`, { redirect: 'error' });
  if (res.status !== 200) throw new Error(`The app answered /signin with ${res.status}.`);
  const csp = res.headers.get('content-security-policy') || '';
  const connect = /(?:^|;)\s*connect-src\s+([^;]*)/.exec(csp);
  if (!connect) throw new Error('The app sent no Content-Security-Policy connect-src.');
  const sources = connect[1].trim().split(/\s+/);
  const local = new URL(target.supabaseUrl);
  const wantHttp = local.origin;
  const wantWs = `ws://${local.host}`;
  for (const src of sources) {
    if (/supabase/i.test(src))
      throw new Error(
        `The app's connect-src names ${src}: it was built for another Supabase project. Rebuild it with the local env file.`,
      );
    if (
      /^(https?|wss?):\/\//i.test(src) &&
      /:\d+$/.test(src) &&
      !isLoopbackUrl(src.replace(/^ws/i, 'http'))
    )
      throw new Error(`The app's connect-src names ${src}, which is not on this machine.`);
  }
  if (!sources.includes(wantHttp) || !sources.includes(wantWs))
    throw new Error(
      "The app's connect-src does not name LOADTEST_SUPABASE_URL: it was built for another Supabase address. Rebuild it with the local env file.",
    );
}

/** The scenario file, which must be a .js file in load-tests/k6/scenarios/. */
function scenarioFile(arg) {
  const file = resolve(HERE, String(arg ?? 'scenarios/10-roles-workload.js'));
  const real = existsSync(file) ? realpathSync(file) : file;
  if (!real.startsWith(realpathSync(SCENARIOS) + sep) || !real.endsWith('.js') || !existsSync(real))
    throw new Error('--scenario must be a .js file in load-tests/k6/scenarios/.');
  return real;
}

/**
 * Waits until no request from the app is still running in the database (k6
 * has stopped, but the server may still be finishing a request it was sent),
 * so the snapshot and the correctness check see every committed write.
 */
function waitForQuietDatabase(maxSeconds = 60) {
  const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const deadline = Date.now() + maxSeconds * 1000;
  let quietReads = 0;
  while (Date.now() < deadline) {
    const busy = Number(
      psql(
        "select count(*) from pg_stat_activity where backend_type = 'client backend' " +
          "and pid <> pg_backend_pid() and usename in ('authenticator', 'supabase_auth_admin') " +
          "and state <> 'idle';",
      ).trim(),
    );
    quietReads = busy === 0 ? quietReads + 1 : 0;
    if (quietReads >= 3) return true;
    pause(1000);
  }
  console.log(`!! the database was still busy after ${maxSeconds} s; checking anyway.`);
  return false;
}

/** Runs a child to the end, with the proxy settings and NODE_OPTIONS removed. */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', env: childEnv(), ...opts });
  if (res.error) throw res.error;
  return res.status;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Only the suite's own scenarios, before anything else.
  const scenario = scenarioFile(args.scenario);
  // Every address, checked before anything connects.
  const target = localTarget(process.env);
  localSupabase();
  localDb();
  if (!process.env.LOADTEST_SUPABASE_ANON_KEY)
    throw new Error('LOADTEST_SUPABASE_ANON_KEY is not set.');
  const appEnv = readAppEnv(args['app-env'], target);
  const own = appEnvFilesInCheckout();
  if (own.length)
    throw new Error(
      `This checkout has app env files (${own.map((f) => f.slice(CHECKOUT.length + 1)).join(', ')}). ` +
        'Build and run load tests only in a worktree with no apps/web/.env* file.',
    );
  if (spawnSync('k6', ['version'], { encoding: 'utf8', env: childEnv() }).status !== 0)
    throw new Error('k6 is not installed (brew install k6).');

  const ladder = String(args.ladder ?? '25,50,100,250')
    .split(',')
    .map((s) => Number(s.trim()));
  if (ladder.some((n) => !Number.isFinite(n) || n <= 0))
    throw new Error('--ladder must be positive numbers');
  const duration = String(args.duration ?? '3m');
  const warmup = String(args.warmup ?? '30s');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = resolve(String(args.out ?? join(HERE, '..', 'results', stamp)));
  mkdirSync(join(out, 'steps'), { recursive: true });

  // The app: started here, under the outbound guard, and checked.
  console.log(`== starting the app (${target.baseUrl}, outbound guard on)`);
  const server = await startServer(target, appEnv, out);
  try {
    await checkBuildIsLocal(target);
    if (refusals(server.outboundLog) > 0)
      throw new Error(
        `The app tried to reach outside this machine while starting; see ${server.outboundLog}.`,
      );
    process.exitCode = await runLadder({
      args,
      target,
      appEnv,
      scenario,
      ladder,
      duration,
      warmup,
      out,
      server,
    });
  } finally {
    server.stop();
  }
}

async function runLadder({
  args,
  target,
  appEnv,
  scenario,
  ladder,
  duration,
  warmup,
  out,
  server,
}) {
  const manifestPath = args.manifest ? resolve(String(args.manifest)) : join(out, 'manifest.json');
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
        server: 'started by run-scale.mjs from this worktree, outbound guard on',
        liquidGlass: appEnv.NEXT_PUBLIC_LIQUID_GLASS,
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

  const k6Env = (actors, dur, summaryOut) =>
    childEnv({
      LOADTEST_MANIFEST: manifestPath,
      LOADTEST_ACTORS: String(actors),
      LOADTEST_DURATION: dur,
      LOADTEST_SUMMARY_OUT: summaryOut,
      K6_NO_USAGE_REPORT: 'true',
      // Each adjust's token, sent and answered, into the console output.
      LOADTEST_WRITE_LOG: '1',
    });

  let failed = false;
  if (warmup !== '0' && warmup !== '0s') {
    console.log(`\n== warm-up: ${ladder[0]} actors for ${warmup} (not reported)`);
    mkdirSync(join(out, 'warmup'), { recursive: true });
    const before = refusals(server.outboundLog);
    run('k6', ['run', '-q', '--console-output', join(out, 'warmup', 'k6-console.log'), scenario], {
      env: k6Env(ladder[0], warmup, join(out, 'warmup', 'summary.json')),
    });
    if (refusals(server.outboundLog) > before) {
      console.log(
        `!! the app tried to reach outside this machine during the warm-up (${server.outboundLog}).`,
      );
      failed = true;
    }
  }

  for (const actors of failed ? [] : ladder) {
    const dir = join(out, 'steps', String(actors));
    mkdirSync(dir, { recursive: true });
    console.log(`\n== step: ${actors} actors for ${duration}`);
    const since = psql('select now();').trim();
    writeFileSync(join(dir, 'since.txt'), since);
    const refusedBefore = refusals(server.outboundLog);
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
      { stdio: 'ignore', env: childEnv() },
    );
    const stopSampler = () => sampler.kill('SIGTERM');
    process.once('exit', stopSampler);
    const consoleLog = join(dir, 'k6-console.log');
    const code = run('k6', ['run', '-q', '--console-output', consoleLog, scenario], {
      env: k6Env(actors, duration, join(dir, 'summary.json')),
    });
    stopSampler();
    process.removeListener('exit', stopSampler);
    writeFileSync(join(dir, 'k6-exit.txt'), String(code));
    writeFileSync(join(dir, 'settled.txt'), String(waitForQuietDatabase()));
    const refused = refusals(server.outboundLog) - refusedBefore;
    writeFileSync(join(dir, 'outbound-refused.txt'), String(refused));
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
          '--console',
          consoleLog,
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
    if (refused > 0)
      console.log(
        `!! the app tried to reach outside this machine ${refused} time(s) in this step (${server.outboundLog}).`,
      );
    const hardFail =
      !summary ||
      !correctnessOk ||
      refused > 0 ||
      count('signin_redirects') > 0 ||
      count('mfa_required') > 0 ||
      count('scope_violations') > 0 ||
      count('viewer_write_allowed') > 0 ||
      (summary.metrics.auth_ok && summary.metrics.auth_ok.values.rate < 1);
    if (code !== 0) failed = true;
    if (hardFail) {
      failed = true;
      console.log('!! sign-in, scope, outbound or correctness failed: the ladder stops here.');
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
  return failed ? 1 : 0;
}

main().catch((e) => {
  console.error(`[run-scale] ${e.message}`);
  process.exit(1);
});
