#!/usr/bin/env node
// Prepares a separate LOCAL Supabase stack for load tests, in a folder outside
// the repository, so it never collides with the everyday local stack.
//
//   node load-tests/k6/tools/prepare-stack.mjs --dir <folder outside the repo> \
//        [--project-id spload] [--port-base 58420]
//   supabase start --workdir <folder> -x studio,imgproxy,edge-runtime,logflare,vector,supavisor,postgres-meta,mailpit
//
// Copies supabase/ (migrations, seed, config) into <folder>/supabase and edits
// the copy's config.toml: its own project_id, ports port-base+0..+4 (shadow,
// API, database, studio, mail), studio and edge functions off, and the auth
// rate limits raised: one machine mints hundreds of sessions in a run's
// setup(), which the default limit of 30 verifications per 5 minutes refuses.
// The repository's own config.toml is not touched. Never link this folder.
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parseArgs } from './local.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.dir) {
  console.error(
    'usage: prepare-stack.mjs --dir <folder outside the repo> [--project-id spload] [--port-base 58420]',
  );
  process.exit(2);
}
const repo = resolve(new URL('../../..', import.meta.url).pathname);
const dir = resolve(String(args.dir));
if (dir === repo || dir.startsWith(`${repo}/`)) {
  console.error('Use a folder outside the repository.');
  process.exit(2);
}
const projectId = String(args['project-id'] ?? 'spload');
if (!/^[a-z][a-z0-9-]{1,30}$/.test(projectId) || projectId === 'stockpilot') {
  console.error('--project-id must be a short lower-case name other than stockpilot.');
  process.exit(2);
}
const base = Number(args['port-base'] ?? 58420);
if (!Number.isInteger(base) || base < 1024 || base > 65000 || (base >= 54320 && base <= 54329)) {
  console.error('--port-base must be a free range away from the default 54320-54329.');
  process.exit(2);
}
if (existsSync(join(dir, 'supabase', '.temp', 'project-ref'))) {
  console.error('That folder is linked to a hosted project: refusing.');
  process.exit(2);
}

cpSync(join(repo, 'supabase'), join(dir, 'supabase'), { recursive: true });
const cfgPath = join(dir, 'supabase', 'config.toml');
let cfg = readFileSync(cfgPath, 'utf8');
const swap = (from, to) => {
  if (!cfg.includes(from)) throw new Error(`config.toml no longer has: ${from}`);
  cfg = cfg.replace(from, to);
};
swap('project_id = "stockpilot"', `project_id = "${projectId}"`);
swap('shadow_port = 54320', `shadow_port = ${base}`);
swap('port = 54321', `port = ${base + 1}`);
swap('port = 54322', `port = ${base + 2}`);
swap('port = 54323', `port = ${base + 3}`);
swap('api_url = "http://127.0.0.1:54321"', `api_url = "http://127.0.0.1:${base + 1}"`);
swap('port = 54324', `port = ${base + 4}`);
swap('[studio]\nenabled = true', '[studio]\nenabled = false');
swap('[edge_runtime]\nenabled = true', '[edge_runtime]\nenabled = false');
swap(
  '[auth.sms]',
  `# Load-test stack only (prepare-stack.mjs): setup() mints a session per account.
[auth.rate_limit]
token_verifications = 100000
token_refresh = 100000
sign_in_sign_ups = 100000
email_sent = 100000

[auth.sms]`,
);
writeFileSync(cfgPath, cfg);
console.log(
  `[prepare-stack] ${dir}/supabase ready: project ${projectId}, API http://127.0.0.1:${base + 1}, database 127.0.0.1:${base + 2}`,
);
