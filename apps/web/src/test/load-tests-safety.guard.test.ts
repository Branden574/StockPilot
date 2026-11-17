import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createServerClient } from '@supabase/ssr';
import { describe, expect, it } from 'vitest';

/**
 * The k6 load tests (load-tests/k6) run against a LOCAL build of the app and a
 * LOCAL Supabase stack only. These checks keep it that way:
 *
 *   - every scenario imports the shared guard (lib/safety.js) and calls
 *     localTarget(__ENV) at its top level, so a bad address stops k6 in its
 *     init stage, before setup() and before any request;
 *   - every k6 request goes through assertRequestUrl(), and no file in the
 *     suite holds an address that is not this machine (no production default
 *     anywhere, no old BASE_URL fallback);
 *   - the guard itself accepts 127.0.0.1, localhost and [::1] and refuses
 *     everything else, including the parser tricks that make a URL look local;
 *   - the session cookie the suite builds (lib/cookie.js) is read back as the
 *     same session by the installed @supabase/ssr, so signed-in page tests
 *     measure the page and not a redirect to sign-in.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const K6 = path.join(REPO_ROOT, 'load-tests', 'k6');
const SCENARIOS = path.join(K6, 'scenarios');

type Safety = {
  LOOPBACK_HOSTS: readonly string[];
  assertLoopbackUrl: (name: string, value: unknown, schemes?: string[]) => string;
  assertLoopbackDbUrl: (name: string, value: unknown) => string;
  assertRequestUrl: (url: string) => string;
  isLoopbackUrl: (value: unknown) => boolean;
  localTarget: (
    env: Record<string, string | undefined>,
    opts?: { needSupabase?: boolean },
  ) => { baseUrl: string; supabaseUrl: string | null };
};
type Cookie = {
  MAX_CHUNK_SIZE: number;
  sessionCookies: (
    supabaseUrl: string,
    session: Record<string, unknown>,
  ) => Array<{ name: string; value: string }>;
  storageKeyFor: (supabaseUrl: string) => string;
};

async function load<T>(rel: string): Promise<T> {
  return (await import(/* @vite-ignore */ pathToFileURL(path.join(K6, rel)).href)) as T;
}

function filesUnder(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(p, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(p);
  }
  return out;
}

/** Source without // and /* comments, so prose cannot satisfy a code check. */
function codeOf(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const scenarioFiles = fs
  .readdirSync(SCENARIOS)
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.join(SCENARIOS, f));

describe('load tests: every scenario is held to this machine', () => {
  it('finds the scenarios', () => {
    expect(scenarioFiles.length).toBeGreaterThanOrEqual(8);
  });

  it.each(scenarioFiles.map((f) => [path.basename(f), f]))(
    '%s imports the guard and calls localTarget(__ENV) at its top level',
    (_name, file) => {
      const code = codeOf(fs.readFileSync(file, 'utf8'));
      expect(code).toMatch(
        /import\s*\{[^}]*\blocalTarget\b[^}]*\}\s*from\s*'\.\.\/lib\/safety\.js'/,
      );
      // At the top level: a line that starts with the call (or assigns from it).
      expect(code).toMatch(/^(?:const\s+[\w{}\s,]+=\s*)?localTarget\(__ENV\b/m);
    },
  );

  it('no k6 request is sent without assertRequestUrl', () => {
    const files = [...scenarioFiles, ...filesUnder(path.join(K6, 'lib'), ['.js'])];
    const unguarded: string[] = [];
    for (const file of files) {
      const code = codeOf(fs.readFileSync(file, 'utf8'));
      const re = /\bhttp\.(get|post|put|patch|del|head|options|request|batch)\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        const after = code.slice(m.index + m[0].length, m.index + m[0].length + 200);
        const guarded =
          m[1] === 'request'
            ? /^\s*[\w.'"]+\s*,\s*assertRequestUrl\(/.test(after)
            : /^\s*assertRequestUrl\(/.test(after);
        if (!guarded) unguarded.push(`${path.relative(REPO_ROOT, file)}: http.${m[1]}`);
      }
    }
    expect(unguarded).toEqual([]);
  });

  it('no file in the suite holds an address that is not this machine, or reads BASE_URL', () => {
    const files = filesUnder(K6, ['.js', '.mjs', '.sh']);
    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const rel = path.relative(REPO_ROOT, file);
      if (/stockpilotusa\.com/i.test(src)) offenders.push(`${rel}: production domain`);
      const urls = src.match(/\bhttps?:\/\/[^\s'"`)<>]+/g) ?? [];
      for (const u of urls) {
        if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?=[:/]|$)/i.test(u))
          offenders.push(`${rel}: ${u}`);
      }
      const readsOldVar = file.endsWith('.sh')
        ? /\$\{?BASE_URL\b/.test(src)
        : /__ENV\.BASE_URL\b|process\.env\.BASE_URL\b/.test(codeOf(src));
      if (readsOldVar) offenders.push(`${rel}: reads BASE_URL`);
    }
    expect(offenders).toEqual([]);
  });

  it('every tool reaches the database and Supabase only through the checked helpers', () => {
    const tools = filesUnder(path.join(K6, 'tools'), ['.mjs']).filter(
      (f) => !f.endsWith('local.mjs'),
    );
    for (const file of tools) {
      const code = codeOf(fs.readFileSync(file, 'utf8'));
      expect(code, path.basename(file)).toMatch(/from '\.\/local\.mjs'/);
      expect(code, path.basename(file)).not.toMatch(/\bfetch\(|spawnSync\('psql'|spawn\('psql'/);
    }
    const local = codeOf(fs.readFileSync(path.join(K6, 'tools', 'local.mjs'), 'utf8'));
    expect(local).toMatch(/assertLoopbackDbUrl\('LOADTEST_DB_URL'/);
    expect(local).toMatch(/assertLoopbackUrl\('LOADTEST_SUPABASE_URL'/);
  });
});

describe('load tests: the address guard', () => {
  it('accepts this machine', async () => {
    const s = await load<Safety>('lib/safety.js');
    for (const ok of [
      'http://127.0.0.1:3600',
      'http://127.0.0.1:3600/',
      'http://localhost:3600',
      'HTTP://LOCALHOST:3600',
      'http://[::1]:3600',
      'http://127.0.0.1',
    ]) {
      expect(s.isLoopbackUrl(ok), ok).toBe(true);
    }
    expect(s.assertLoopbackUrl('X', 'http://127.0.0.1:3600/')).toBe('http://127.0.0.1:3600');
  });

  it('refuses every other address, and the tricks that look local', async () => {
    const s = await load<Safety>('lib/safety.js');
    for (const bad of [
      'https://stockpilotusa.com',
      'https://www.stockpilotusa.com/dashboard',
      'https://preview-abc.vercel.app',
      'https://abcdefgh.supabase.co',
      'http://127.0.0.1.example.com:3600',
      'http://localhost.example.com',
      'http://localhost@example.com',
      'http://127.0.0.1:3600@example.com',
      'http://example.com#@127.0.0.1',
      'http://example.com?@127.0.0.1',
      'http://127.0.0.1\\@example.com',
      'http://example.com/http://127.0.0.1',
      'http:// 127.0.0.1',
      'http://0.0.0.0:3600',
      'http://127.1:3600',
      'http://[::2]:3600',
      'http://10.0.0.5:3600',
      '127.0.0.1:3600',
      '//127.0.0.1:3600',
      '',
    ]) {
      expect(s.isLoopbackUrl(bad), bad).toBe(false);
      expect(() => s.assertLoopbackUrl('LOADTEST_BASE_URL', bad), bad).toThrow();
    }
    expect(() => s.assertLoopbackUrl('LOADTEST_BASE_URL', undefined)).toThrow(/not set/);
    expect(() => s.assertLoopbackUrl('X', 'ftp://127.0.0.1')).toThrow(/http/);
    expect(() => s.assertRequestUrl('https://stockpilotusa.com/api/search')).toThrow(
      /leave this machine/,
    );
  });

  it('never names the refused value (a database address carries a password)', async () => {
    const s = await load<Safety>('lib/safety.js');
    const secretish = 'postgresql://postgres:not-a-real-password@db.example.com:5432/postgres';
    let message = '';
    try {
      s.assertLoopbackDbUrl('LOADTEST_DB_URL', secretish);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/LOADTEST_DB_URL/);
    expect(message).not.toContain('not-a-real-password');
    expect(message).not.toContain('db.example.com');
  });

  it('checks the database address the same way', async () => {
    const s = await load<Safety>('lib/safety.js');
    expect(
      s.assertLoopbackDbUrl('D', 'postgresql://postgres:postgres@127.0.0.1:58422/postgres'),
    ).toContain('127.0.0.1');
    expect(() =>
      s.assertLoopbackDbUrl(
        'D',
        'postgresql://postgres.abc:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres',
      ),
    ).toThrow();
    expect(() => s.assertLoopbackDbUrl('D', 'http://127.0.0.1:58422')).toThrow(/postgres/);
  });

  it('localTarget needs both local addresses and ignores the old BASE_URL', async () => {
    const s = await load<Safety>('lib/safety.js');
    expect(() => s.localTarget({ BASE_URL: 'http://127.0.0.1:3600' })).toThrow(
      /LOADTEST_BASE_URL is not set/,
    );
    expect(() => s.localTarget({ LOADTEST_BASE_URL: 'http://127.0.0.1:3600' })).toThrow(
      /LOADTEST_SUPABASE_URL/,
    );
    expect(
      s.localTarget({ LOADTEST_BASE_URL: 'http://127.0.0.1:3600' }, { needSupabase: false })
        .baseUrl,
    ).toBe('http://127.0.0.1:3600');
    expect(() =>
      s.localTarget({
        LOADTEST_BASE_URL: 'http://127.0.0.1:3600',
        LOADTEST_SUPABASE_URL: 'https://abc.supabase.co',
      }),
    ).toThrow(/LOADTEST_SUPABASE_URL/);
  });
});

describe('load tests: the session cookie is the one @supabase/ssr reads', () => {
  const SUPABASE_URL = 'http://127.0.0.1:58421';

  async function readBack(cookies: Array<{ name: string; value: string }>) {
    const client = createServerClient(SUPABASE_URL, 'stub-anon-key', {
      cookies: { getAll: () => cookies, setAll: () => {} },
    });
    const { data } = await client.auth.getSession();
    return data.session;
  }

  function session(fullName: string) {
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: 'stub.access.token',
      refresh_token: 'stub-refresh-token',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: now + 3600,
      user: {
        id: '00000000-0000-4000-8000-000000000001',
        aud: 'authenticated',
        email: 'loadtest+stub@example.com',
        user_metadata: { full_name: fullName },
        app_metadata: {},
        created_at: new Date().toISOString(),
      },
    };
  }

  it('names the cookie after the local Supabase host, as supabase-js does', async () => {
    const c = await load<Cookie>('lib/cookie.js');
    expect(c.storageKeyFor(SUPABASE_URL)).toBe('sb-127-auth-token');
    expect(c.storageKeyFor('http://localhost:54321')).toBe('sb-localhost-auth-token');
  });

  it('one cookie: read back as the same session', async () => {
    const c = await load<Cookie>('lib/cookie.js');
    const cookies = c.sessionCookies(SUPABASE_URL, session('Load staff 1 é'));
    expect(cookies).toHaveLength(1);
    expect(cookies[0]!.value.startsWith('base64-')).toBe(true);
    const back = await readBack(cookies);
    expect(back?.access_token).toBe('stub.access.token');
    expect(back?.user.user_metadata.full_name).toBe('Load staff 1 é');
  });

  it('a session too long for one cookie is chunked the way @supabase/ssr chunks it', async () => {
    const c = await load<Cookie>('lib/cookie.js');
    const cookies = c.sessionCookies(SUPABASE_URL, session('x'.repeat(6000)));
    expect(cookies.length).toBeGreaterThan(1);
    expect(cookies.map((k) => k.name)).toEqual(cookies.map((_k, i) => `sb-127-auth-token.${i}`));
    for (const k of cookies)
      expect(encodeURIComponent(k.value).length).toBeLessThanOrEqual(c.MAX_CHUNK_SIZE);
    const back = await readBack(cookies);
    expect(back?.access_token).toBe('stub.access.token');
    expect(back?.user.user_metadata.full_name).toHaveLength(6000);
  });
});
