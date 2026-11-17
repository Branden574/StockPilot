// Shared helpers for the load-test tools. LOCAL ONLY: every address is checked
// by ../lib/safety.js before anything connects to it, and no value of a key or
// password is ever printed.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { assertLoopbackDbUrl, assertLoopbackUrl } from '../lib/safety.js';

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
