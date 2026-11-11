#!/usr/bin/env node
// @ts-check
/**
 * Applies seed-fidelity.sql (Liquid Glass stage 5, plan 8.1 "Same data") to a LAB database,
 * and nowhere else.
 *
 *   node seed-fidelity.mjs --docker supabase_db_rlab --port 55422 [--check]
 *   STAGE5_DB_URL=postgresql://...@127.0.0.1:55422/postgres node seed-fidelity.mjs --url-env STAGE5_DB_URL [--check]
 *
 * Refuses (exit 2) unless the database is on this machine:
 *  - URL mode: the URL's host is 127.0.0.1, localhost or ::1 (the URL is read from the named
 *    environment variable and never printed: it may hold the lab password);
 *  - docker mode: DOCKER_HOST is unset or a unix socket (the local engine), and the container
 *    publishes its 5432 on 127.0.0.1, 0.0.0.0 or :: (this machine) at the given port.
 * --check prints whether the seed is applied (exit 0 applied, 3 not applied) and writes nothing.
 * Otherwise: if the seed is already applied, says so and exits 0 (restart-safe); else runs the
 * SQL in ONE transaction (psql -1, ON_ERROR_STOP) and prints its last line (FIDELITY SEED OK).
 * Apply it only inside a lab snapshot that is restored afterwards (the stage 5 runner does).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const LOCAL_BINDS = new Set(['127.0.0.1', '0.0.0.0', '::', '[::]', '::1', '[::1]']);
const MARKER =
  "select count(*) from public.charters where id = '5eed0000-f1d0-4000-8000-000000000001'";

/**
 * Why a database URL may not be used (null: it is local).
 * @param {string | undefined} url
 * @returns {string | null}
 */
export function urlRefusal(url) {
  if (!url) return 'no database URL';
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'the database URL does not parse';
  }
  if (!/^postgres(ql)?:$/u.test(u.protocol)) return `not a postgres URL (${u.protocol})`;
  if (!LOCAL_HOSTS.has(u.hostname.toLowerCase()))
    return `the database host ${u.hostname} is not 127.0.0.1 or localhost`;
  return null;
}

/**
 * Why a docker container may not be used (null: it is the local engine, published locally on `port`).
 * @param {{ dockerHost: string | undefined, portLines: string, port: string }} input
 *   portLines: the output of `docker port <container> 5432/tcp` (one "host:port" per line)
 * @returns {string | null}
 */
export function dockerRefusal({ dockerHost, portLines, port }) {
  if (dockerHost && !dockerHost.startsWith('unix://'))
    return `DOCKER_HOST ${dockerHost} is not the local engine`;
  const lines = portLines
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return 'the container publishes no 5432';
  for (const line of lines) {
    const i = line.lastIndexOf(':');
    const host = line.slice(0, i);
    const p = line.slice(i + 1);
    if (!LOCAL_BINDS.has(host))
      return `the container publishes 5432 on ${host}, not on this machine only`;
    if (p !== port) return `the container publishes 5432 on port ${p}, not ${port}`;
  }
  return null;
}

/** @param {string[]} argv */
function main(argv) {
  const arg = (/** @type {string} */ n) =>
    argv.indexOf(n) === -1 ? undefined : argv[argv.indexOf(n) + 1];
  const check = argv.includes('--check');
  const sqlFile = join(dirname(fileURLToPath(import.meta.url)), 'seed-fidelity.sql');
  /** @type {(args: string[], input?: string) => import('node:child_process').SpawnSyncReturns<string>} */
  let psql;
  const container = arg('--docker');
  if (container) {
    const port = arg('--port');
    if (!port) return fail('--docker needs --port (the published host port)');
    const ports = spawnSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' });
    if (ports.status !== 0) return fail(`docker port ${container} failed`);
    const why = dockerRefusal({
      dockerHost: process.env.DOCKER_HOST,
      portLines: ports.stdout,
      port,
    });
    if (why) return fail(why);
    psql = (args, input) =>
      spawnSync(
        'docker',
        ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', ...args],
        {
          encoding: 'utf8',
          input,
        },
      );
  } else {
    const name = arg('--url-env');
    if (!name) return fail('give --docker <container> --port <port> or --url-env <VAR>');
    const url = process.env[name];
    const why = urlRefusal(url);
    if (why) return fail(why);
    psql = (args, input) =>
      spawnSync('psql', [/** @type {string} */ (url), '-X', ...args], { encoding: 'utf8', input });
  }

  const marker = psql(['-At', '-v', 'ON_ERROR_STOP=1', '-c', MARKER]);
  if (marker.status !== 0)
    return fail(`could not read the marker: ${marker.stderr.trim().split('\n').pop()}`);
  const applied = marker.stdout.trim() === '1';
  if (check) {
    console.info(applied ? 'fidelity seed: applied' : 'fidelity seed: not applied');
    return applied ? 0 : 3;
  }
  if (applied) {
    console.info('fidelity seed: already applied, nothing to do');
    return 0;
  }
  const run = psql(
    ['-1', '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-f', '-'],
    readFileSync(sqlFile, 'utf8'),
  );
  if (run.status !== 0) {
    console.error('fidelity seed FAILED (rolled back as one transaction):');
    console.error(
      run.stderr
        .split('\n')
        .filter((l) => /ERROR|DETAIL|HINT|CONTEXT/u.test(l))
        .slice(0, 8)
        .join('\n'),
    );
    return 1;
  }
  console.info(run.stdout.trim().split('\n').pop());
  return 0;
}

/** @param {string} why */
function fail(why) {
  console.error(`seed-fidelity: refusing: ${why}`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main(process.argv.slice(2)));
