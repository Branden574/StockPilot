// Shared helpers for the load-test tools. LOCAL ONLY: every address is checked
// by ../lib/safety.js before anything connects to it, and no value of a key or
// password is ever printed.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { assertLoopbackDbUrl, assertLoopbackUrl } from '../lib/safety.js';

/**
 * Node's environment proxy. With NODE_USE_ENV_PROXY=1 (or --use-env-proxy)
 * and HTTP_PROXY set, Node's fetch sends even 127.0.0.1 and [::1] requests to
 * the proxy unless NO_PROXY names them, and with them the service key. The
 * tools refuse to run that way rather than rely on NO_PROXY.
 */
export const PROXY_ENV = Object.freeze([
  'NODE_USE_ENV_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]);

/** Why this process would send its requests through a proxy, or null. */
export function envProxyReason(env = process.env, execArgv = process.execArgv) {
  if (env.NODE_USE_ENV_PROXY !== undefined && env.NODE_USE_ENV_PROXY !== '')
    return 'NODE_USE_ENV_PROXY is set';
  if (execArgv.some((a) => a.includes('use-env-proxy')))
    return 'node was started with --use-env-proxy';
  if (String(env.NODE_OPTIONS || '').includes('use-env-proxy'))
    return 'NODE_OPTIONS holds --use-env-proxy';
  return null;
}

/** Exits when an environment proxy is on (see envProxyReason). */
export function assertNoEnvProxy() {
  const why = envProxyReason();
  if (why) {
    console.error(
      `[loadtest] ${why}: Node would send local requests (and the service key) through a proxy. Unset it and run again.`,
    );
    process.exit(2);
  }
}
// Every tool and the runner import this module: refuse before anything runs.
assertNoEnvProxy();

/**
 * The environment for a child process: this one without the proxy settings
 * and without NODE_OPTIONS (which can load code or turn the proxy on).
 */
export function childEnv(extra = {}, env = process.env) {
  const out = { ...env };
  for (const k of [...PROXY_ENV, 'NODE_OPTIONS']) delete out[k];
  return { ...out, ...extra };
}

/** Reads `--name value` and `--flag` arguments. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      out[a.slice(2)] = argv[++i];
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

/** The local database, checked. */
export function localDb(env = process.env) {
  const url = assertLoopbackDbUrl('LOADTEST_DB_URL', env.LOADTEST_DB_URL);
  const u = new URL(url);
  return {
    PGHOST: u.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username || 'postgres'),
    PGPASSWORD: decodeURIComponent(u.password || ''),
    PGDATABASE: (u.pathname || '/postgres').slice(1) || 'postgres',
  };
}

/**
 * Runs SQL through psql against the local database. Returns stdout (tab
 * separated, unaligned). Throws with psql's stderr on any error; stderr never
 * carries the password (it is passed in PGPASSWORD, not on the command line).
 */
export function psql(sql, { env = process.env, timeoutMs = 30 * 60 * 1000 } = {}) {
  const pg = localDb(env);
  const res = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t'], {
    input: sql,
    env: { PATH: env.PATH, ...pg, PGAPPNAME: 'loadtest-tools', PGCONNECT_TIMEOUT: '5' },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`psql failed (exit ${res.status}): ${String(res.stderr).slice(0, 4000)}`);
  }
  return res.stdout;
}

/** psql, answering one JSON value (the query must select exactly one json column). */
export function psqlJson(sql, opts) {
  const out = psql(sql, opts).trim();
  return out === '' ? null : JSON.parse(out);
}

/** A SQL string literal. */
export function lit(v) {
  if (v === null || v === undefined) return 'null';
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** The local Supabase API and the service key (never printed). */
export function localSupabase(env = process.env) {
  const url = assertLoopbackUrl('LOADTEST_SUPABASE_URL', env.LOADTEST_SUPABASE_URL);
  const serviceKey = env.LOADTEST_SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error('LOADTEST_SUPABASE_SERVICE_ROLE_KEY is not set.');
  return { url, serviceKey };
}

/** A GoTrue admin call on the local stack. Errors name the status, never the key. */
export async function authAdmin(sb, method, path, body) {
  const res = await fetch(`${sb.url}/auth/v1${path}`, {
    method,
    headers: {
      apikey: sb.serviceKey,
      Authorization: `Bearer ${sb.serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // A redirect would carry the service key to wherever it points.
    redirect: 'error',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`auth ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Runs `fn` over `items`, at most `limit` at a time. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
