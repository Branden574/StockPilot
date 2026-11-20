import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createServerClient } from '@supabase/ssr';
import { describe, expect, it } from 'vitest';

/**
 * The k6 load tests (load-tests/k6) run against a LOCAL build of the app and a
 * LOCAL Supabase stack only. These checks keep it that way:
 *
 *   - every scenario (any .js or .mjs under scenarios/, subfolders included)
 *     imports the shared guard (lib/safety.js) and calls localTarget(__ENV) at
 *     its top level, so a bad address stops k6 in its init stage, before
 *     setup() and before any request;
 *   - k6 code imports k6/http one way only (`import http from 'k6/http'`),
 *     no other network module (websockets, gRPC, browser, experimental), and
 *     every request, async ones included, goes through assertRequestUrl();
 *     no scenario follows redirects;
 *   - no file in the suite holds an address that is not this machine (no
 *     production default anywhere, no old BASE_URL fallback);
 *   - the Node tools reach the network only with fetch(..., redirect:
 *     'error'), never through node:http/https/net, and only local.mjs starts
 *     psql; run-scale.mjs runs only the suite's own scenarios;
 *   - the guard itself accepts 127.0.0.1 and [::1] (not the name localhost,
 *     which a proxy setting can send elsewhere) and refuses everything else,
 *     including the parser tricks that make a URL look local;
 *   - the app env file the tools write sets every outside-service key the
 *     app reads to empty (so a checkout's apps/web/.env* cannot supply one),
 *     and every such key the app's sources name is on that list;
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

const scenarioFiles = filesUnder(SCENARIOS, ['.js', '.mjs']);
/** Everything k6 runs: the scenarios and the shared library. */
const k6Files = [...scenarioFiles, ...filesUnder(path.join(K6, 'lib'), ['.js', '.mjs'])];
/** Everything Node runs: the tools and the runner. */
const nodeFiles = [
  ...filesUnder(path.join(K6, 'tools'), ['.js', '.mjs', '.cjs']),
  ...fs
    .readdirSync(K6)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => path.join(K6, f)),
];
const rel = (f: string) => path.relative(REPO_ROOT, f);
/** The one file allowed to load node:net (to restrict it): the app server's outbound guard. */
const OUTBOUND_GUARD = path.join(K6, 'tools', 'outbound-guard.cjs');
/** A child's environment with no LOADTEST_* or other settings: only PATH. */
const BARE_ENV: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', NODE_ENV: 'test' };

describe('load tests: every scenario is held to this machine', () => {
  it('finds the scenarios', () => {
    expect(scenarioFiles.length).toBeGreaterThanOrEqual(8);
  });

  it.each(scenarioFiles.map((f) => [path.basename(f), f]))(
    '%s imports the guard and calls localTarget(__ENV) at its top level',
    (_name, file) => {
      const code = codeOf(fs.readFileSync(file, 'utf8'));
      expect(code).toMatch(
        /import\s*\{[^}]*\blocalTarget\b[^}]*\}\s*from\s*'(?:\.\.\/)+lib\/safety\.js'/,
      );
      // At the top level: a line that starts with the call (or assigns from it).
      expect(code).toMatch(/^(?:const\s+[\w{}\s,]+=\s*)?localTarget\(__ENV\b/m);
    },
  );

  it.each(scenarioFiles.map((f) => [path.basename(f), f]))(
    '%s never follows a redirect (maxRedirects: 0, itself or through buildOptions)',
    (_name, file) => {
      const code = codeOf(fs.readFileSync(file, 'utf8'));
      expect(/\bmaxRedirects:\s*0\b/.test(code) || /\bbuildOptions\(/.test(code)).toBe(true);
    },
  );

  it('buildOptions sets maxRedirects: 0', () => {
    const code = codeOf(fs.readFileSync(path.join(K6, 'lib', 'workload.js'), 'utf8'));
    expect(code).toMatch(/\bmaxRedirects:\s*0\b/);
  });

  it('k6 code imports k6/http one way only, and no other network module', () => {
    const offenders: string[] = [];
    for (const file of k6Files) {
      const code = codeOf(fs.readFileSync(file, 'utf8'));
      // Every mention of the module must be the one default import.
      const mentions = code.match(/['"]k6\/http['"]/g) ?? [];
      const plain = code.match(/^import http from 'k6\/http';$/gm) ?? [];
      if (mentions.length !== plain.length)
        offenders.push(`${rel(file)}: k6/http imported another way`);
      if (/\bhttp\s*\[|[=(,:]\s*http\s*[;,)}]|\.\.\.\s*http\b|=\s*http\s*;?\s*$/m.test(code))
        offenders.push(`${rel(file)}: http passed on or indexed`);
      if (/['"]k6\/(ws|browser|net\/grpc|experimental\/[\w/-]+)['"]/.test(code))
        offenders.push(`${rel(file)}: a network module other than k6/http`);
      if (/\brequire\s*\(|\bimport\s*\(/.test(code)) offenders.push(`${rel(file)}: dynamic import`);
      if (/\[\s*['"`]fetch['"`]\s*\]/.test(code)) offenders.push(`${rel(file)}: fetch by name`);
    }
    expect(offenders).toEqual([]);
  });

  it('no k6 request is sent without assertRequestUrl', () => {
    const unguarded: string[] = [];
    for (const file of k6Files) {
      const code = codeOf(fs.readFileSync(file, 'utf8'));
      const re = /\bhttp\.(\w+)\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        const after = code.slice(m.index + m[0].length, m.index + m[0].length + 200);
        // Helpers that send nothing.
        if (m[1] === 'expectedStatuses' || m[1] === 'setResponseCallback') continue;
        const guarded =
          m[1] === 'request' || m[1] === 'asyncRequest'
            ? /^\s*[\w.'"]+\s*,\s*assertRequestUrl\(/.test(after)
            : /^\s*assertRequestUrl\(/.test(after);
        if (!guarded) unguarded.push(`${rel(file)}: http.${m[1]}`);
      }
    }
    expect(unguarded).toEqual([]);
  });

  it('no file in the suite holds an address that is not this machine, or reads BASE_URL', () => {
    const files = filesUnder(K6, ['.js', '.mjs', '.cjs', '.sh']);
    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const rel = path.relative(REPO_ROOT, file);
      if (/stockpilotusa\.com/i.test(src)) offenders.push(`${rel}: production domain`);
      const urls = src.match(/\bhttps?:\/\/[^\s'"`)<>]+/g) ?? [];
      for (const u of urls) {
        if (!/^https?:\/\/(127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(u))
          offenders.push(`${rel}: ${u}`);
      }
      const readsOldVar = file.endsWith('.sh')
        ? /\$\{?BASE_URL\b/.test(src)
        : /__ENV\.BASE_URL\b|process\.env\.BASE_URL\b/.test(codeOf(src));
      if (readsOldVar) offenders.push(`${rel}: reads BASE_URL`);
    }
    expect(offenders).toEqual([]);
  });

  it('the Node tools reach the network only through fetch that refuses redirects', () => {
    const offenders: string[] = [];
    for (const file of nodeFiles) {
      const code = codeOf(fs.readFileSync(file, 'utf8'));
      const NET_IMPORT =
        /(?:\bfrom|\bimport\s*\(?|\brequire\s*\()\s*['"`](node:)?(http|https|http2|net|tls|dgram|undici|pg|postgres)['"`]/;
      // The outbound guard loads node:net only to wrap it; nothing else may.
      if (file !== OUTBOUND_GUARD && NET_IMPORT.test(code))
        offenders.push(`${rel(file)}: imports a network or database client`);
      if (/\[\s*['"`]fetch['"`]\s*\]/.test(code)) offenders.push(`${rel(file)}: fetch by name`);
      // A shell can run anything: no exec/execSync, no shell option, no shell started.
      if (
        /import\s*\{[^}]*\bexec(?:Sync)?\b[^}]*\}\s*from\s*['"](node:)?child_process['"]/.test(code)
      )
        offenders.push(`${rel(file)}: imports exec (a shell)`);
      // Named as themselves, so the command check below sees every start.
      if (
        /import\s*(?:\*|\{[^}]*\bas\b[^}]*\})\s*(?:as\s+\w+\s*)?from\s*['"](node:)?child_process['"]/.test(
          code,
        ) ||
        /require\s*\(\s*['"](node:)?child_process['"]\s*\)/.test(code)
      )
        offenders.push(`${rel(file)}: child_process imported under another name`);
      if (/\bshell\s*:\s*(?!false\b)/.test(code)) offenders.push(`${rel(file)}: shell option`);
      const START =
        /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\(\s*['"`]([\w./-]+)/g;
      for (const [, cmd] of code.matchAll(START)) {
        if (/^(curl|wget|supabase|nc|ssh|npx|pnpm|sh|bash|zsh|dash|env|xargs)$/.test(cmd!))
          offenders.push(`${rel(file)}: starts ${cmd}`);
        if (/^(psql|pg_dump|pg_restore)$/.test(cmd!) && !file.endsWith(`${path.sep}local.mjs`))
          offenders.push(`${rel(file)}: starts ${cmd} itself (use local.mjs)`);
      }
      const re = /\bfetch\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        // The call's arguments, up to its closing parenthesis.
        let depth = 1;
        let i = m.index + m[0].length;
        while (i < code.length && depth > 0) {
          if (code[i] === '(') depth++;
          else if (code[i] === ')') depth--;
          i++;
        }
        if (!/\bredirect:\s*'error'/.test(code.slice(m.index, i)))
          offenders.push(`${rel(file)}: fetch without redirect: 'error'`);
      }
    }
    expect(offenders).toEqual([]);
    const local = codeOf(fs.readFileSync(path.join(K6, 'tools', 'local.mjs'), 'utf8'));
    expect(local).toMatch(/assertLoopbackDbUrl\('LOADTEST_DB_URL'/);
    expect(local).toMatch(/assertLoopbackUrl\('LOADTEST_SUPABASE_URL'/);
  });

  it("Node's environment proxy is refused, and children never get one", () => {
    const tools = path.join(K6, 'tools');
    const cases: Array<[string, string[], Record<string, string>]> = [
      ['NODE_USE_ENV_PROXY', [path.join(tools, 'report.mjs')], { NODE_USE_ENV_PROXY: '1' }],
      ['--use-env-proxy', ['--use-env-proxy', path.join(tools, 'report.mjs')], {}],
      ['NODE_OPTIONS', [path.join(tools, 'report.mjs')], { NODE_OPTIONS: '--use-env-proxy' }],
      ['run-scale', [path.join(K6, 'run-scale.mjs')], { NODE_USE_ENV_PROXY: '1' }],
    ];
    for (const [label, args, env] of cases) {
      const res = spawnSync(process.execPath, args, {
        encoding: 'utf8',
        env: { ...BARE_ENV, ...env },
      });
      expect(res.status, label).toBe(2);
      expect(res.stderr, label).toMatch(/through a proxy/);
    }
    const local = codeOf(fs.readFileSync(path.join(tools, 'local.mjs'), 'utf8'));
    // At the top level of the module every tool imports.
    expect(local).toMatch(/^assertNoEnvProxy\(\);$/m);
    const runner = codeOf(fs.readFileSync(path.join(K6, 'run-scale.mjs'), 'utf8'));
    expect(runner).toMatch(/^assertNoEnvProxy\(\);$/m);
    // No child inherits this process's environment as it is.
    expect(runner).not.toMatch(/env:\s*process\.env\b|\.\.\.process\.env\b/);
  });

  it('childEnv drops every proxy setting and NODE_OPTIONS', async () => {
    const l = await load<{
      childEnv: (extra?: object, env?: object) => Record<string, string>;
    }>('tools/local.mjs');
    const env = {
      PATH: '/bin',
      HTTP_PROXY: 'x',
      https_proxy: 'x',
      ALL_PROXY: 'x',
      no_proxy: 'x',
      NODE_USE_ENV_PROXY: '1',
      NODE_OPTIONS: '--require x',
    };
    expect(l.childEnv({ A: '1' }, env)).toEqual({ PATH: '/bin', A: '1' });
  });

  it('run-scale.mjs serves the app itself, under the outbound guard, from app.env only', () => {
    const runner = codeOf(fs.readFileSync(path.join(K6, 'run-scale.mjs'), 'utf8'));
    expect(runner).toMatch(/\['--require', GUARD, nextBin, 'start', '-p', port, '-H', host\]/);
    expect(runner).toMatch(
      /const env = \{\s*PATH: process\.env\.PATH,\s*HOME: process\.env\.HOME,\s*\.\.\.appEnv,\s*LOADTEST_OUTBOUND_LOG: outboundLog,\s*\};/,
    );
    expect(runner).toMatch(/already taken/);
    expect(runner).toMatch(/refused > 0/);
  });

  it('the outbound guard refuses every connection off this machine, and logs it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-guard-'));
    try {
      // Every target goes nowhere even unguarded: 192.0.2.1 is TEST-NET-1 and
      // .invalid never resolves.
      const probe = path.join(dir, 'probe.cjs');
      fs.writeFileSync(
        probe,
        `const raw = globalThis.fetch;
require(${JSON.stringify(OUTBOUND_GUARD)});
const http = require('node:http'), https = require('node:https'), net = require('node:net'), tls = require('node:tls');
const out = [];
const settle = (name, p) => p.then(() => out.push(name + ' connected'), (e) => out.push(name + ' ' + String((e && e.cause && e.cause.message) || (e && e.message) || e)));
const ev = (name, mk) => new Promise((res) => { const s = mk(); const t = setTimeout(() => { out.push(name + ' timeout'); s.destroy(); res(); }, 4000); s.on('error', (e) => { clearTimeout(t); out.push(name + ' ' + e.message); res(); }); s.on('connect', () => { clearTimeout(t); out.push(name + ' connected'); s.destroy(); res(); }); });
(async () => {
  await settle('fetch', fetch('http://192.0.2.1:8080/x'));
  await settle('fetch-name', fetch('https://example.invalid/x'));
  await settle('undici', raw('http://192.0.2.1:8080/x'));
  await ev('http', () => http.get('http://192.0.2.1:8080/x'));
  await ev('https', () => https.get('https://example.invalid/x'));
  await ev('net', () => net.connect(8080, '192.0.2.1'));
  await ev('tls', () => tls.connect({ host: '192.0.2.1', port: 443 }));
  await ev('local', () => net.connect(1, '127.0.0.1'));
  console.log(JSON.stringify(out));
})();
`,
      );
      const log = path.join(dir, 'refused.log');
      const res = spawnSync(process.execPath, [probe], {
        encoding: 'utf8',
        env: { ...BARE_ENV, LOADTEST_OUTBOUND_LOG: log },
        timeout: 60_000,
      });
      const out: string[] = JSON.parse(res.stdout.trim().split('\n').pop()!);
      for (const name of ['fetch', 'fetch-name', 'undici', 'http', 'https', 'net', 'tls']) {
        const line = out.find((l) => l.startsWith(`${name} `));
        expect(line, name).toMatch(/outbound guard/);
      }
      // This machine is still reachable (a closed port answers ECONNREFUSED).
      expect(out.find((l) => l.startsWith('local '))).toMatch(/ECONNREFUSED/);
      expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(7);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('teardown --all never selects an account in another organization, also when no load-test organization is left', async () => {
    const t = await load<{
      seededUsersSql: (ids: string[]) => string;
      uuidArray: (ids: string[]) => string;
    }>('tools/teardown-sql.mjs');
    const none = t.seededUsersSql([]);
    expect(none).toContain("not (om.organization_id = any('{}'::uuid[]))");
    expect(none).not.toMatch(/null/i);
    const one = t.seededUsersSql(['00000000-0000-4000-8000-000000000001']);
    expect(one).toContain(
      "not (om.organization_id = any(array['00000000-0000-4000-8000-000000000001']::uuid[]))",
    );
    expect(() => t.uuidArray(["x'); drop table y; --"])).toThrow(/uuid/);
    const teardown = codeOf(fs.readFileSync(path.join(K6, 'tools', 'teardown.mjs'), 'utf8'));
    expect(teardown).not.toMatch(/array\[\$\{/);
  });

  it('k6 runs only through run-scale.mjs: no script, workflow or document runs it bare', () => {
    const offenders: string[] = [];
    const runner = path.join(K6, 'run-scale.mjs');
    // run-all.sh holds the one k6 run line, behind a gate (next test).
    const runAll = path.join(K6, 'run-all.sh');
    // Every file of the suite, the repository's scripts and workflows, and the docs.
    const files = [
      ...filesUnder(path.join(REPO_ROOT, 'load-tests'), [
        '.js',
        '.mjs',
        '.cjs',
        '.sh',
        '.md',
        '.json',
      ]),
      ...filesUnder(path.join(REPO_ROOT, 'scripts'), ['.sh', '.mjs', '.js', '.ts']),
      ...filesUnder(path.join(REPO_ROOT, '.github'), ['.yml', '.yaml']),
      ...filesUnder(path.join(REPO_ROOT, 'docs'), ['.md']),
      path.join(REPO_ROOT, 'package.json'),
      path.join(REPO_ROOT, 'apps', 'web', 'package.json'),
    ].filter((f) => fs.existsSync(f));
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      // `k6 run <something>` or `k6 cloud <something>`: a command line.
      if (file !== runAll && /(^|[\s"'`(;&|])k6\s+(run|cloud|archive)\s+[^\s`]/m.test(src))
        offenders.push(`${rel(file)}: k6 run`);
      if (
        file !== runner &&
        /\b(?:spawn|spawnSync|execFile|execFileSync|run)\(\s*['"`]k6['"`]/.test(src)
      )
        offenders.push(`${rel(file)}: starts k6`);
    }
    expect(offenders).toEqual([]);
  });

  it('run-all.sh runs only when run-scale.mjs started it, and refuses otherwise', () => {
    const runAll = path.join(K6, 'run-all.sh');
    const src = fs.readFileSync(runAll, 'utf8');
    // The gate comes before anything else the script does, and before k6.
    const gate = src.indexOf('LOADTEST_RUNNER_PID');
    const k6 = src.search(/^\s*if ! k6 run /m);
    expect(gate).toBeGreaterThan(0);
    expect(k6).toBeGreaterThan(gate);
    expect(src.slice(0, src.indexOf('cd "$(dirname "$0")'))).toMatch(/exit 2\n\s*fi/);
    // The one k6 command in the script is that line: none before the gate.
    const code = src
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    const k6Commands = [...code.matchAll(/(^|[\s;&|(`])k6\s+[a-z-]/gm)];
    expect(k6Commands).toHaveLength(1);
    expect(k6Commands[0]?.index ?? -1).toBeGreaterThan(code.indexOf('exit 2'));
    // Bare, and with the variable forged by a parent that is not the runner.
    for (const env of [{}, { LOADTEST_RUNNER_PID: String(process.pid) }]) {
      const res = spawnSync(runAll, [], {
        encoding: 'utf8',
        env: { ...BARE_ENV, ...env, LOADTEST_MANIFEST: '/nonexistent' },
      });
      expect(res.status, JSON.stringify(env)).toBe(2);
      expect(res.stderr).toMatch(/use load-tests\/k6\/run-scale\.mjs --scenario <name>/);
      expect(res.stdout).not.toMatch(/Running/);
    }
    // The runner starts it as its own child, with its own process id.
    const runner = codeOf(fs.readFileSync(path.join(K6, 'run-scale.mjs'), 'utf8'));
    expect(runner).toMatch(/run\(join\(HERE, 'run-all\.sh'\), \[\]/);
    expect(runner).toMatch(/LOADTEST_RUNNER_PID: String\(process\.pid\)/);
  });

  it.each(scenarioFiles.map((f) => [path.basename(f), f]))(
    '%s writes the JSON summary the runner reads, without setup_data',
    (_name, file) => {
      const code = codeOf(fs.readFileSync(file, 'utf8'));
      expect(code).toMatch(
        /export function handleSummary\(data\)\s*\{\s*return (summarize|plainSummary)\(data\);/,
      );
    },
  );

  it('every outbound refusal is placed in its phase, after the last step and at shutdown too', async () => {
    const o = await load<{
      parseRefusals: (t: string) => Array<Record<string, unknown>>;
      assignPhases: (
        r: Array<Record<string, unknown>>,
        p: Array<{ name: string; at: number }>,
      ) => Array<{ phase: string }>;
    }>('tools/outbound-phases.mjs');
    const t0 = Date.parse('2026-11-17T10:00:00Z');
    const phases = [
      { name: 'start-up', at: t0 },
      { name: 'seeding', at: t0 + 10_000 },
      { name: 'step 5', at: t0 + 20_000 },
      { name: 'after step 5', at: t0 + 80_000 },
      { name: 'teardown', at: t0 + 90_000 },
      { name: 'shutdown', at: t0 + 95_000 },
    ];
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    const log = [15_000, 30_000, 85_000, 92_000, 96_000]
      .map((ms) => JSON.stringify({ at: at(ms), kind: 'fetch', target: 'http://192.0.2.1:8080' }))
      .concat(['not json'])
      .join('\n');
    const placed = o.assignPhases(o.parseRefusals(log), phases);
    expect(placed.map((r) => r.phase)).toEqual([
      'seeding',
      'step 5',
      'after step 5',
      'teardown',
      'shutdown',
      'unknown time',
    ]);
    const runner = codeOf(fs.readFileSync(path.join(K6, 'run-scale.mjs'), 'utf8'));
    // The run-level check reads the whole log after the server has stopped.
    expect(runner).toMatch(/mark\('shutdown'\);\s*await server\.stop\(\);/);
    expect(runner).toMatch(/if \(refused\.length\) \{\s*code = 1;/);
  });

  it('run-scale.mjs runs only a scenario of the suite', () => {
    for (const bad of [
      '../../../etc/x.js',
      'run-all.sh',
      'lib/workload.js',
      'scenarios/../lib/auth.js',
    ]) {
      const res = spawnSync(process.execPath, [path.join(K6, 'run-scale.mjs'), '--scenario', bad], {
        encoding: 'utf8',
        // No LOADTEST_* at all: the scenario check must come first.
        env: BARE_ENV,
      });
      expect(res.status, bad).toBe(1);
      expect(res.stderr, bad).toMatch(
        /--scenario must be a \.js file in load-tests\/k6\/scenarios/,
      );
    }
  });
});

describe('load tests: the address guard', () => {
  it('accepts this machine', async () => {
    const s = await load<Safety>('lib/safety.js');
    for (const ok of [
      'http://127.0.0.1:3600',
      'http://127.0.0.1:3600/',
      'HTTP://127.0.0.1:3600',
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
      // A name, not an address: an environment proxy can send it elsewhere.
      'http://localhost:3600',
      'HTTP://LOCALHOST:3600',
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

type AppEnv = {
  OUTSIDE_SERVICE_ENV: readonly string[];
  PINNED_DEFAULT_ENV: readonly string[];
  LEFT_UNSET_ENV: Record<string, string>;
  isAppEnvFile: (name: string) => boolean;
};

describe('load tests: the app under test reaches no outside service', () => {
  const WEB = path.join(REPO_ROOT, 'apps', 'web');
  /** The local stack and the app's own address: what the env file sets. */
  const LOCAL_ENV = new Set([
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'NEXT_PUBLIC_APP_URL',
  ]);
  /** What an outside-service key, secret or address looks like. */
  const OUTSIDE =
    /^(NEXT_PUBLIC_)?(RESEND|ANTHROPIC|GEMINI|OPENAI|GOOGLE|STRIPE|POSTHOG|MAPTILER|SENTRY|QBO|SAGE|EXPO|APNS|FCM|UPSTASH|VERCEL|SLACK|ZENDESK|EASYPOST|TWILIO|AWS|SMTP|AI_|CRON|BACKFILL|UNSUBSCRIBE|STOCKPILOT_PLATFORM|ERROR_WEBHOOK|UPCITEM|OPENLIBRARY)|_(API_KEY|SECRET|TOKEN|DSN|WEBHOOK\w*|KEY|URL|HOST)$/;

  /** Every environment variable the app's own sources (not its tests) name. */
  function appEnvNames(): Set<string> {
    const files = [
      ...filesUnder(path.join(WEB, 'src'), ['.ts', '.tsx']).filter(
        (f) => !/\.test\.tsx?$|[\\/]test[\\/]/.test(f),
      ),
      path.join(WEB, 'next.config.ts'),
      // Workspace packages the app bundles.
      ...filesUnder(path.join(REPO_ROOT, 'packages'), ['.ts', '.tsx']).filter(
        (f) => !/\.test\.tsx?$|[\\/](test|node_modules|dist)[\\/]/.test(f),
      ),
    ];
    const names = new Set<string>();
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/process\.env(?:\.|\[\s*['"])([A-Z][A-Z0-9_]+)/g))
        names.add(m[1]!);
      // An env object passed in and read by name (env.RETURNS_EXCHANGE_CREATE).
      for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) names.add(m[1]!);
    }
    // The schema's keys (read through the parsed env object, not process.env).
    for (const file of ['env.ts', 'env.client.ts']) {
      const src = fs.readFileSync(path.join(WEB, 'src', 'lib', file), 'utf8');
      for (const m of src.matchAll(/^\s+([A-Z][A-Z0-9_]+):/gm)) names.add(m[1]!);
    }
    return names;
  }

  it('every outside-service variable the app reads is on the list local-env.mjs writes empty', async () => {
    const e = await load<AppEnv>('tools/app-env.mjs');
    const known = new Set([
      ...e.OUTSIDE_SERVICE_ENV,
      ...e.PINNED_DEFAULT_ENV,
      ...Object.keys(e.LEFT_UNSET_ENV),
      ...LOCAL_ENV,
    ]);
    const names = appEnvNames();
    // The scan itself works.
    for (const n of ['RESEND_API_KEY', 'ANTHROPIC_API_KEY', 'NEXT_PUBLIC_SUPABASE_URL'])
      expect(names.has(n), n).toBe(true);
    const missing = [...names].filter((n) => OUTSIDE.test(n) && !known.has(n)).sort();
    expect(missing).toEqual([]);
  });

  it('the lists do not overlap, and none of them holds the local stack settings', async () => {
    const e = await load<AppEnv>('tools/app-env.mjs');
    const all = [
      ...e.OUTSIDE_SERVICE_ENV,
      ...e.PINNED_DEFAULT_ENV,
      ...Object.keys(e.LEFT_UNSET_ENV),
    ];
    expect(new Set(all).size).toBe(all.length);
    for (const n of LOCAL_ENV) expect(all, n).not.toContain(n);
  });

  it('local-env.mjs writes them empty, mode 600, outside the repository only', async () => {
    const e = await load<AppEnv>('tools/app-env.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-env-'));
    try {
      const status = [
        'API_URL="http://127.0.0.1:58421"',
        'DB_URL="postgresql://postgres:postgres@127.0.0.1:58422/postgres"',
        'ANON_KEY="stub-anon"',
        'SERVICE_ROLE_KEY="stub-service"',
      ].join('\n');
      const app = path.join(dir, 'app.env');
      const lt = path.join(dir, 'loadtest.env');
      // An existing file keeps its loose mode unless the tool fixes it.
      fs.writeFileSync(app, 'old\n', { mode: 0o644 });
      const tool = path.join(K6, 'tools', 'local-env.mjs');
      const res = spawnSync(process.execPath, [tool, '--app-env', app, '--loadtest-env', lt], {
        input: status,
        encoding: 'utf8',
        env: BARE_ENV,
      });
      expect(res.status, res.stderr).toBe(0);
      const lines = fs.readFileSync(app, 'utf8').split('\n');
      for (const n of [...e.OUTSIDE_SERVICE_ENV, ...e.PINNED_DEFAULT_ENV])
        expect(lines, n).toContain(`${n}=`);
      for (const n of Object.keys(e.LEFT_UNSET_ENV))
        expect(
          lines.some((l) => l.startsWith(`${n}=`)),
          n,
        ).toBe(false);
      expect(lines).toContain('NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:58421');
      const l = await load<{ PROXY_ENV: readonly string[] }>('tools/local.mjs');
      for (const n of [...l.PROXY_ENV, 'NODE_OPTIONS']) expect(lines, n).toContain(`${n}=`);
      expect(lines).toContain('NEXT_PUBLIC_LIQUID_GLASS=opt-in');
      expect(fs.statSync(app).mode & 0o777).toBe(0o600);
      expect(fs.statSync(lt).mode & 0o777).toBe(0o600);
      expect(res.stdout).not.toContain('stub-service');

      const inRepo = spawnSync(
        process.execPath,
        [tool, '--app-env', path.join(K6, 'app.env'), '--loadtest-env', lt],
        { input: status, encoding: 'utf8', env: BARE_ENV },
      );
      expect(inRepo.status).toBe(2);
      expect(fs.existsSync(path.join(K6, 'app.env'))).toBe(false);

      const remote = spawnSync(process.execPath, [tool, '--app-env', app, '--loadtest-env', lt], {
        input: status.replace('http://127.0.0.1:58421', 'https://abc.supabase.co'),
        encoding: 'utf8',
        env: BARE_ENV,
      });
      expect(remote.status).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the checkout env files the runner refuses', async () => {
    const e = await load<AppEnv>('tools/app-env.mjs');
    for (const f of [
      '.env',
      '.env.local',
      '.env.production',
      '.env.production.local',
      '.env.local.prod',
    ])
      expect(e.isAppEnvFile(f), f).toBe(true);
    for (const f of ['.env.example', '.env.local.example', 'env.ts', 'next.config.ts'])
      expect(e.isAppEnvFile(f), f).toBe(false);
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
