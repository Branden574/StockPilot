import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { LIMITER_BOT_PREFIXES, LIMITER_NOT_SECURITY_EVENTS } from './limiter-events';

/**
 * RECURRENCE GUARD: every limiter key is decided in the one map of
 * server/security/limiter-events.ts.
 *
 * checkRateLimit records a refusal as a security event only when its key's
 * prefix is on LIMITER_BOT_PREFIXES (an anonymous public endpoint). A new
 * limiter on a public endpoint whose prefix is on no list would be silently
 * missing from Blocked activity; one put on the wrong list would count a busy
 * member as an attack. So every checkRateLimit call site under src (tests
 * aside, comments taken out) is read:
 *   - a first argument that is a string literal, or a template literal up to
 *     its first `${`, is the key's prefix, and must be a key of exactly one
 *     of the two lists;
 *   - any other first argument (a variable, a helper's answer) must be
 *     listed in NON_LITERAL_CALL_SITES with the prefixes it uses, each of
 *     which must be on one list and appear as the head of a literal in some
 *     source file (the helper that builds the key);
 *   - every listed prefix is used by some call site, so the lists cannot rot.
 * The self-test at the bottom plants a call site with an unlisted prefix and
 * one with an unlisted non-literal key, so this cannot pass by reading
 * nothing.
 */

const WEB_SRC = path.resolve(__dirname, '../..');

/** Call sites whose key is not a literal: file -> the prefixes its keys use. */
const NON_LITERAL_CALL_SITES: Readonly<Record<string, readonly string[]>> = {
  // accountDeleteRateKey (server/lib/account-deletion.ts).
  'app/api/v1/account/delete/route.ts': ['account-delete:'],
  'server/actions/profile.ts': ['account-delete:'],
  // sessionNoteKey and accountNoteKey (lib/auth/session-note.ts).
  'app/api/v1/auth/signed-in/route.ts': ['auth-note:in:', 'auth-note:user:'],
  'app/api/v1/auth/signed-out/route.ts': ['auth-note:out:', 'auth-note:user:'],
  // returnOptions*/returnToken*/returnPageIp* BucketKey (lib/returns/public-limits.ts).
  'app/api/v1/public/returns/options/route.ts': [
    'public-return-options:ip:',
    'public-return-options:token:',
  ],
  'app/api/v1/public/returns/route.ts': ['public-return-request:token:'],
  'app/returns/request/[token]/page.tsx': ['public-return-page:'],
  // linkKey, built in the same file.
  'app/unsubscribe/route.ts': ['unsubscribe:link:'],
  // allowRecoveryPress(key, limit), called with three literal keys.
  'server/actions/mfa-recovery.ts': ['mfa-recovery:', 'mfa-recovery-password:', 'mfa-recovery-code:'],
  // allow(key), with accountDelete*Key (same file).
  'server/lib/account-deletion-credential.ts': [
    'account-delete-password:',
    'account-delete-code-send:',
    'account-delete-code-check:',
  ],
};

/** The source with comments removed (a `//` after `:` is kept: URLs). */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function isTestFile(rel: string): boolean {
  return (
    rel.startsWith('test/') ||
    rel.includes('/__tests__/') ||
    rel.includes('/__mocks__/') ||
    /\.(test|spec)\.(ts|tsx)$/.test(rel)
  );
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue;
      sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Each checkRateLimit call in a source: the head of a template key up to its
 * first `${` (a prefix, which must be listed as it is), a whole literal key
 * (which the longest listed prefix it starts with decides, as at run time),
 * or null when the key is not a literal.
 */
type CallSite = { prefix: string; whole: boolean } | null;
function callSites(source: string): CallSite[] {
  const text = code(source);
  const sites: CallSite[] = [];
  for (const m of text.matchAll(/(?<![\w.$])checkRateLimit\(\s*/g)) {
    if (/function\s+$/.test(text.slice(Math.max(0, m.index - 30), m.index))) continue;
    const rest = text.slice(m.index + m[0].length);
    const template = rest.match(/^`((?:[^`\\$]|\\.|\$(?!\{))*)(\$\{|`)/);
    const quoted = rest.match(/^(['"])((?:(?!\1)[^\\]|\\.)*)\1/);
    if (template) sites.push({ prefix: template[1]!, whole: template[2] === '`' });
    else if (quoted) sites.push({ prefix: quoted[2]!, whole: true });
    else sites.push(null);
  }
  return sites;
}

/** Every listed prefix, longest first (the run-time rule for a whole key). */
const LISTED_LONGEST_FIRST = [
  ...Object.keys(LIMITER_BOT_PREFIXES),
  ...Object.keys(LIMITER_NOT_SECURITY_EVENTS),
].sort((a, b) => b.length - a.length);

const ON_A_LIST = (prefix: string) =>
  Object.prototype.hasOwnProperty.call(LIMITER_BOT_PREFIXES, prefix) !==
  Object.prototype.hasOwnProperty.call(LIMITER_NOT_SECURITY_EVENTS, prefix);

/** Problems with one tree of sources (rel -> text), as messages. */
function problems(files: ReadonlyMap<string, string>): { problems: string[]; used: Set<string> } {
  const found: string[] = [];
  const used = new Set<string>();
  for (const [rel, src] of files) {
    if (isTestFile(rel)) continue;
    let nonLiteral = 0;
    for (const site of callSites(src)) {
      if (site === null) {
        nonLiteral += 1;
        continue;
      }
      const prefix = site.whole
        ? (LISTED_LONGEST_FIRST.find((p) => site.prefix.startsWith(p)) ?? site.prefix)
        : site.prefix;
      used.add(prefix);
      if (!ON_A_LIST(prefix)) found.push(`${rel}: prefix ${JSON.stringify(prefix)} is on neither list (or on both)`);
    }
    const listed = NON_LITERAL_CALL_SITES[rel];
    if (nonLiteral > 0 && !listed) {
      found.push(`${rel}: ${nonLiteral} checkRateLimit call(s) with a key that is not a literal, not in NON_LITERAL_CALL_SITES`);
    }
    if (listed && nonLiteral === 0) {
      found.push(`${rel}: listed in NON_LITERAL_CALL_SITES, but has no such call`);
    }
  }
  return { problems: found, used };
}

describe('every checkRateLimit key is decided in the limiter map', () => {
  const files = new Map(
    sourceFiles(WEB_SRC)
      .map((f) => path.relative(WEB_SRC, f).split(path.sep).join('/'))
      .filter((rel) => !isTestFile(rel))
      .map((rel) => [rel, readFileSync(path.join(WEB_SRC, rel), 'utf8')] as const),
  );

  it('reads a real tree', () => {
    const sites = [...files.values()].flatMap(callSites);
    expect(sites.length).toBeGreaterThan(100);
    expect(sites.filter((s) => s === null).length).toBeGreaterThanOrEqual(10);
  });

  it('every call site’s prefix is on exactly one list, and every other key is accounted for', () => {
    expect(problems(files).problems).toEqual([]);
  });

  it('every prefix of a non-literal call site is on one list and is the head of a literal somewhere', () => {
    const all = [...files.values()].map(code).join('\n');
    for (const [rel, prefixes] of Object.entries(NON_LITERAL_CALL_SITES)) {
      expect(files.has(rel), `${rel} exists`).toBe(true);
      for (const prefix of prefixes) {
        expect(ON_A_LIST(prefix), `${rel}: ${prefix}`).toBe(true);
        const head = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        expect(all, `${rel}: no literal starts with ${prefix}`).toMatch(new RegExp(`[\`'"]${head}`));
      }
    }
  });

  it('every listed prefix is used by a call site (the lists cannot rot)', () => {
    const { used } = problems(files);
    for (const prefixes of Object.values(NON_LITERAL_CALL_SITES)) for (const p of prefixes) used.add(p);
    const listed = [...Object.keys(LIMITER_BOT_PREFIXES), ...Object.keys(LIMITER_NOT_SECURITY_EVENTS)];
    expect(listed.filter((p) => !used.has(p))).toEqual([]);
  });
});

describe('self-test: an undecided limiter is found', () => {
  it('a planted call site with a prefix on no list', () => {
    const planted = new Map([
      ['app/api/v1/public/new-form/route.ts', "const rl = await checkRateLimit(`public-new-form:${ip}`, 5, 60_000, 'closed');"],
    ]);
    expect(problems(planted).problems).toEqual([
      'app/api/v1/public/new-form/route.ts: prefix "public-new-form:" is on neither list (or on both)',
    ]);
  });

  it('a planted call site with a key that is not a literal', () => {
    const planted = new Map([['lib/x.ts', 'await checkRateLimit(keyFor(ip), 5, 60_000);']]);
    expect(problems(planted).problems).toHaveLength(1);
  });

  it('a listed prefix, a string literal and a comment are read as they are', () => {
    const planted = new Map([
      [
        'lib/y.ts',
        "// checkRateLimit(`nope:${x}`)\nawait checkRateLimit('stock-adjust:fixed', 5, 1);\nawait checkRateLimit(`signin:${e}`, 5, 1);",
      ],
    ]);
    expect(problems(planted)).toEqual({ problems: [], used: new Set(['stock-adjust:', 'signin:']) });
  });
});
