import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * SP-030 regression guard for scripts/dev-local.sh.
 *
 * WHAT WENT WRONG: `apps/web/.env.local` and `apps/web/.env.local.prod` are
 * SYMLINKS into ~/Developer/stockpilot-env (the env files moved outside the
 * repo on 2026-06-26). The old dev-local.sh did `cat > "$WEB_ENV"`, which
 * FOLLOWS the symlink and rewrote the CANONICAL file with only the ten keys
 * its heredoc + five-key whitelist knew about — silently deleting
 * ANTHROPIC_API_KEY, GOOGLE_BOOKS_API_KEY, STOCKPILOT_PLATFORM_ADMIN_EMAILS
 * and VERCEL_OIDC_TOKEN. There was no backup either: the backup step is
 * guarded by `[ ! -f "$WEB_ENV_PROD" ]`, and `-f` follows the symlink to a
 * prod backup that already exists, so it self-skips.
 *
 * WHAT STOPS IT NOW: the script writes NO env file at all. It exports the
 * local-stack values into the environment and execs the dev server —
 * @next/env never overwrites a variable already present in process.env, so
 * the local stack wins for that process while every other key in the
 * canonical file still loads normally.
 *
 * The test runs the REAL script inside a throwaway repo whose env files are
 * symlinks, with stub `docker` / `supabase` / `pnpm` on PATH so nothing
 * touches Docker or the developer's actual stack.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'dev-local.sh');

// Fake, obviously-not-real values: nothing here may resemble a live secret.
const STUB_ANON = 'stub-local-anon-key';
const STUB_SERVICE = 'stub-local-service-role-key';

const CANONICAL_ENV_LOCAL = [
  'NEXT_PUBLIC_APP_URL=https://app.example.test',
  'NEXT_PUBLIC_SITE_NAME=StockPilot',
  'NEXT_PUBLIC_SUPABASE_URL=https://hosted.supabase.test',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY=hosted-anon',
  'SUPABASE_SERVICE_ROLE_KEY=hosted-service',
  'GEMINI_API_KEY=hosted-gemini',
  'RESEND_API_KEY=hosted-resend',
  // The four keys the old heredoc dropped on the floor:
  'ANTHROPIC_API_KEY=hosted-anthropic',
  'GOOGLE_BOOKS_API_KEY=hosted-google-books',
  'STOCKPILOT_PLATFORM_ADMIN_EMAILS=owner@example.test',
  'VERCEL_OIDC_TOKEN=hosted-oidc',
  '',
].join('\n');

// The stale 10-key backup, mirroring the real .env.local.prod: it does NOT
// contain the four keys above, which is exactly why rewriting from it loses.
const CANONICAL_ENV_PROD = [
  'NEXT_PUBLIC_APP_URL=https://app.example.test',
  'NEXT_PUBLIC_SITE_NAME=StockPilot',
  'NEXT_PUBLIC_SUPABASE_URL=https://hosted.supabase.test',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY=hosted-anon',
  'SUPABASE_SERVICE_ROLE_KEY=hosted-service',
  'GEMINI_API_KEY=hosted-gemini',
  'RESEND_API_KEY=hosted-resend',
  'STRIPE_SECRET_KEY=hosted-stripe-secret',
  'STRIPE_WEBHOOK_SECRET=hosted-stripe-webhook',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=hosted-stripe-pub',
  '',
].join('\n');

let workspace: string | null = null;

afterEach(() => {
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

type Harness = {
  root: string;
  canonicalEnvLocal: string;
  devEnvDump: string;
  run: () => { status: number | null; stdout: string; stderr: string };
};

/**
 * Build a throwaway repo that reproduces the real layout: env files inside
 * the repo are symlinks pointing at a canonical directory that lives
 * elsewhere (the stand-in for ~/Developer/stockpilot-env).
 */
function makeHarness(): Harness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-dev-local-'));
  workspace = base;

  const canonical = path.join(base, 'stockpilot-env', 'apps', 'web');
  const root = path.join(base, 'repo');
  const webDir = path.join(root, 'apps', 'web');
  const binDir = path.join(base, 'bin');
  fs.mkdirSync(canonical, { recursive: true });
  fs.mkdirSync(webDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  const canonicalEnvLocal = path.join(canonical, '.env.local');
  const canonicalEnvProd = path.join(canonical, '.env.local.prod');
  fs.writeFileSync(canonicalEnvLocal, CANONICAL_ENV_LOCAL);
  fs.writeFileSync(canonicalEnvProd, CANONICAL_ENV_PROD);

  fs.symlinkSync(canonicalEnvLocal, path.join(webDir, '.env.local'));
  fs.symlinkSync(canonicalEnvProd, path.join(webDir, '.env.local.prod'));

  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'dev-local.sh'));
  fs.chmodSync(path.join(root, 'scripts', 'dev-local.sh'), 0o755);

  // Stub binaries so the script never reaches real Docker / Supabase / pnpm.
  const devEnvDump = path.join(base, 'dev-env.txt');
  fs.writeFileSync(path.join(binDir, 'docker'), '#!/usr/bin/env bash\nexit 0\n');
  fs.writeFileSync(
    path.join(binDir, 'supabase'),
    [
      '#!/usr/bin/env bash',
      'if [ "$1" = "status" ]; then',
      `  echo 'ANON_KEY="${STUB_ANON}"'`,
      `  echo 'SERVICE_ROLE_KEY="${STUB_SERVICE}"'`,
      `  echo 'API_URL="http://127.0.0.1:54321"'`,
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  // The dev server stub records the environment it was handed, which is how
  // the local-stack override is asserted now that no file is written.
  fs.writeFileSync(
    path.join(binDir, 'pnpm'),
    ['#!/usr/bin/env bash', `printenv > "${devEnvDump}"`, 'exit 0', ''].join('\n'),
  );
  for (const b of ['docker', 'supabase', 'pnpm']) fs.chmodSync(path.join(binDir, b), 0o755);

  return {
    root,
    canonicalEnvLocal,
    devEnvDump,
    run: () => {
      try {
        const stdout = execFileSync('bash', [path.join(root, 'scripts', 'dev-local.sh')], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
        });
        return { status: 0, stdout, stderr: '' };
      } catch (err) {
        const e = err as { status?: number | null; stdout?: string; stderr?: string };
        return { status: e.status ?? null, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
      }
    },
  };
}

function parseDump(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

describe('scripts/dev-local.sh', () => {
  it('never writes through the .env.local symlink onto the canonical env file', () => {
    const h = makeHarness();
    const before = fs.readFileSync(h.canonicalEnvLocal, 'utf8');

    h.run();

    const after = fs.readFileSync(h.canonicalEnvLocal, 'utf8');
    // Byte-identical: the canonical file outside the repo is not this
    // script's to rewrite. (The old version replaced it wholesale.)
    expect(after).toBe(before);
    // Named explicitly so a partial-whitelist regression is unmissable.
    for (const key of [
      'ANTHROPIC_API_KEY',
      'GOOGLE_BOOKS_API_KEY',
      'STOCKPILOT_PLATFORM_ADMIN_EMAILS',
      'VERCEL_OIDC_TOKEN',
    ]) {
      expect(after).toContain(`${key}=`);
    }
    // And the repo-side path must still be a symlink, not a regular file.
    expect(fs.lstatSync(path.join(h.root, 'apps', 'web', '.env.local')).isSymbolicLink()).toBe(
      true,
    );
  });

  it('hands the dev server the local stack via the environment', () => {
    const h = makeHarness();

    const res = h.run();
    expect(res.status).toBe(0);
    expect(fs.existsSync(h.devEnvDump)).toBe(true);

    const env = parseDump(h.devEnvDump);
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe('http://127.0.0.1:54321');
    expect(env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe(STUB_ANON);
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe(STUB_SERVICE);
    expect(env.NEXT_PUBLIC_APP_URL).toBe('http://localhost:3000');
  });

  it('does not create or overwrite any env file in the repo', () => {
    const h = makeHarness();
    const webDir = path.join(h.root, 'apps', 'web');
    const beforeProd = fs.readFileSync(path.join(webDir, '.env.local.prod'), 'utf8');

    h.run();

    expect(fs.readFileSync(path.join(webDir, '.env.local.prod'), 'utf8')).toBe(beforeProd);
    // No stray generated env files either — the fix is "write nothing", not
    // "write somewhere else the dev server will not read".
    const strays = fs
      .readdirSync(webDir)
      .filter((f) => f.startsWith('.env') && f !== '.env.local' && f !== '.env.local.prod');
    expect(strays).toEqual([]);
  });
});
