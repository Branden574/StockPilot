#!/usr/bin/env node
// Writes the two env files a local load test needs, from `supabase status -o env`
// of the LOCAL load-test stack, without printing a single value.
//
//   supabase status -o env --workdir <stack dir> | \
//     node load-tests/k6/tools/local-env.mjs --app-env <file> --loadtest-env <file> [--port 3600]
//
// --app-env       the app's environment (NODE_ENV, the public Supabase address
//                 and anon key, the service key), for `next build` and
//                 `next start`: `set -a; . <file>; set +a` in that shell.
// --loadtest-env  the LOADTEST_* settings, for `node --env-file=<file> run-scale.mjs`.
// Keep both OUTSIDE the repository (they hold keys). Written with mode 600.
// Refuses a status whose API or database is not on this machine.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { assertLoopbackDbUrl, assertLoopbackUrl } from '../lib/safety.js';
import { parseArgs } from './local.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args['app-env'] || !args['loadtest-env']) {
  console.error(
    'usage: supabase status -o env --workdir <dir> | local-env.mjs --app-env <file> --loadtest-env <file> [--port 3600]',
  );
  process.exit(2);
}
const repo = resolve(new URL('../../..', import.meta.url).pathname);
for (const f of [args['app-env'], args['loadtest-env']]) {
  if (resolve(f).startsWith(`${repo}/`)) {
    console.error('Write the env files outside the repository.');
    process.exit(2);
  }
}
const kv = {};
for (const line of readFileSync(0, 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
  if (m) kv[m[1]] = m[2];
}
const port = Number(args.port ?? 3600);
try {
  assertLoopbackUrl('API_URL', kv.API_URL);
  assertLoopbackDbUrl('DB_URL', kv.DB_URL);
  if (!kv.ANON_KEY || !kv.SERVICE_ROLE_KEY)
    throw new Error('the status has no ANON_KEY or SERVICE_ROLE_KEY');
} catch (e) {
  console.error(`[local-env] ${e.message}`);
  process.exit(1);
}
const app = [
  'NODE_ENV=production',
  `NEXT_PUBLIC_APP_URL=http://127.0.0.1:${port}`,
  `NEXT_PUBLIC_SUPABASE_URL=${kv.API_URL}`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY=${kv.ANON_KEY}`,
  `SUPABASE_SERVICE_ROLE_KEY=${kv.SERVICE_ROLE_KEY}`,
  'NEXT_TELEMETRY_DISABLED=1',
];
const lt = [
  `LOADTEST_BASE_URL=http://127.0.0.1:${port}`,
  `LOADTEST_SUPABASE_URL=${kv.API_URL}`,
  `LOADTEST_SUPABASE_ANON_KEY=${kv.ANON_KEY}`,
  `LOADTEST_SUPABASE_SERVICE_ROLE_KEY=${kv.SERVICE_ROLE_KEY}`,
  `LOADTEST_DB_URL=${kv.DB_URL}`,
];
writeFileSync(args['app-env'], `${app.join('\n')}\n`, { mode: 0o600 });
writeFileSync(args['loadtest-env'], `${lt.join('\n')}\n`, { mode: 0o600 });
console.log(`[local-env] wrote ${args['app-env']} and ${args['loadtest-env']}`);
