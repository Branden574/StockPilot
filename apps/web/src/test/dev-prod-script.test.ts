import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * B19 regression guard for scripts/dev-prod.sh, the sibling of SP-030.
 *
 * WHAT WENT WRONG: `apps/web/.env.local` and `apps/web/.env.local.prod` are
 * SYMLINKS into the env folder that lives outside the repo (the files moved
 * there on 2026-06-26). dev-prod.sh "restored" the dev env with
 * `cp "$WEB_ENV_PROD" "$WEB_ENV"`, and cp writes THROUGH a symlink, so one
 * run replaced the CANONICAL env file with the older backup and dropped every
 * line the backup lacked. That is the loss SP-030 fixed in dev-local.sh
 * (dev-local-script.test.ts). The restore also had nothing left to undo:
 * dev-local.sh stopped writing .env.local in SP-030. In a checkout whose env
 * files are plain files the copy did the same damage without any link.
 *
 * WHAT STOPS IT NOW: the script writes no env file in any layout. It says it
 * leaves .env.local alone (and refuses the link by name when it finds one),
 * then only stops the local Supabase stack, which no longer depends on the
 * backup existing.
 *
 * The test runs the REAL script inside a throwaway repo. `supabase` is a stub
 * that records its arguments, and the PATH holds only that stub and the system
 * directories, so nothing can reach the real Supabase CLI or a developer's
 * stack. No real env file is read or written: every file here is made up.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'dev-prod.sh');

// Dull, made-up values: nothing here may resemble a live setting.
const LIVE_ENV_LOCAL = [
  'NEXT_PUBLIC_APP_URL=https://app.example.test',
  'NEXT_PUBLIC_SUPABASE_URL=https://hosted.example.test',
  // Lines the older backup does not have. A restore from it dropped them.
  'ONLY_IN_LIVE_FILE_A=kept',
  'ONLY_IN_LIVE_FILE_B=kept-too',
  '',
].join('\n');

const OLDER_BACKUP = [
  'NEXT_PUBLIC_APP_URL=https://app.example.test',
  'NEXT_PUBLIC_SUPABASE_URL=https://hosted.example.test',
  '',
].join('\n');

// Text that must never appear in the script's output: it has no reason to
// read an env file, let alone print one.
const FILE_ONLY_TEXT = ['ONLY_IN_LIVE_FILE_A', 'hosted.example.test', 'kept-too'];

/**
 * - linked: the real layout. Both repo paths are links into the env folder.
 * - plain: a checkout whose env files are ordinary files in apps/web.
 * - linked-no-backup: the links are there, but no backup exists.
 * - dangling: .env.local links to a file that does not exist (yet).
 */
type Layout = 'linked' | 'plain' | 'linked-no-backup' | 'dangling';

type Entry = { kind: 'link'; target: string } | { kind: 'file'; text: string };

let workspace: string | null = null;

afterEach(() => {
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

function makeHarness(layout: Layout) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-dev-prod-'));
  workspace = base;

  // The stand-in for the env folder outside the repo.
  const envFolder = path.join(base, 'env-folder', 'apps', 'web');
  const root = path.join(base, 'repo');
  const webDir = path.join(root, 'apps', 'web');
  const binDir = path.join(base, 'bin');
  const supabaseLog = path.join(base, 'supabase-calls.log');
  for (const dir of [envFolder, webDir, path.join(root, 'scripts'), binDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const envLocal = path.join(webDir, '.env.local');
  const envProd = path.join(webDir, '.env.local.prod');
  const folderLocal = path.join(envFolder, '.env.local');
  const folderProd = path.join(envFolder, '.env.local.prod');

  if (layout === 'plain') {
    fs.writeFileSync(envLocal, LIVE_ENV_LOCAL);
    fs.writeFileSync(envProd, OLDER_BACKUP);
  } else {
    if (layout !== 'dangling') fs.writeFileSync(folderLocal, LIVE_ENV_LOCAL);
    fs.symlinkSync(folderLocal, envLocal);
    if (layout !== 'linked-no-backup') {
      fs.writeFileSync(folderProd, OLDER_BACKUP);
      fs.symlinkSync(folderProd, envProd);
    }
  }

  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'dev-prod.sh'));
  fs.chmodSync(path.join(root, 'scripts', 'dev-prod.sh'), 0o755);

  // The stub records each call, which is how "it still stops the stack" is
  // asserted. It never reaches Docker.
  fs.writeFileSync(
    path.join(binDir, 'supabase'),
    ['#!/bin/sh', `printf '%s\\n' "$*" >> '${supabaseLog}'`, 'exit 0', ''].join('\n'),
  );
  fs.chmodSync(path.join(binDir, 'supabase'), 0o755);

  return {
    base,
    envFolder,
    webDir,
    supabaseCalls: (): string[] =>
      fs.existsSync(supabaseLog)
        ? fs.readFileSync(supabaseLog, 'utf8').split('\n').filter(Boolean)
        : [],
    run: () => {
      const res = spawnSync('bash', [path.join(root, 'scripts', 'dev-prod.sh')], {
        encoding: 'utf8',
        // Only the stub and the system tools: the real `supabase` lives
        // elsewhere (Homebrew, node_modules/.bin) and stays out of reach.
        // Nothing else is inherited from the developer's environment.
        env: { PATH: `${binDir}:/usr/bin:/bin`, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (res.error) throw res.error;
      return { status: res.status, stdout: res.stdout, stderr: res.stderr };
    },
  };
}

/**
 * Every link (with its target) and every file (with its bytes) under the env
 * folder and apps/web. Equal snapshots before and after a run mean nothing was
 * written, replaced, created or removed, through a link or otherwise.
 */
function snapshot(dirs: string[]): Record<string, Entry> {
  const out: Record<string, Entry> = {};
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[p] = { kind: 'link', target: fs.readlinkSync(p) };
      else if (st.isDirectory()) walk(p);
      else out[p] = { kind: 'file', text: fs.readFileSync(p, 'utf8') };
    }
  };
  for (const dir of dirs) walk(dir);
  return out;
}

describe('scripts/dev-prod.sh', () => {
  it.each<Layout>(['linked', 'plain', 'linked-no-backup', 'dangling'])(
    'writes no env file and still stops the local stack (%s layout)',
    (layout) => {
      const h = makeHarness(layout);
      const before = snapshot([h.envFolder, h.webDir]);

      const res = h.run();

      expect(res.stderr).toBe('');
      expect(res.status).toBe(0);
      // Byte-identical, same links, nothing new: the env files are not this
      // script's to rewrite. (The old cp replaced the live file wholesale.)
      expect(snapshot([h.envFolder, h.webDir])).toEqual(before);
      expect(h.supabaseCalls()).toEqual(['stop']);
      for (const text of FILE_ONLY_TEXT) expect(res.stdout).not.toContain(text);
    },
  );

  it('keeps the live env file whole when it is a link into the env folder', () => {
    const h = makeHarness('linked');
    const live = path.join(h.envFolder, '.env.local');

    const res = h.run();

    expect(fs.readFileSync(live, 'utf8')).toBe(LIVE_ENV_LOCAL);
    // Named explicitly so a partial restore is unmissable.
    expect(fs.readFileSync(live, 'utf8')).toContain('ONLY_IN_LIVE_FILE_A=kept');
    expect(fs.lstatSync(path.join(h.webDir, '.env.local')).isSymbolicLink()).toBe(true);
    // It says why it will not write there, rather than failing in silence.
    expect(res.stdout).toContain('never writes through a link');
  });

  it('does not create the env file a dangling link points at', () => {
    const h = makeHarness('dangling');

    h.run();

    // cp would have created it through the link (or refused, depending on
    // the platform's cp). Either way the script must not try.
    expect(fs.existsSync(path.join(h.envFolder, '.env.local'))).toBe(false);
  });
});
