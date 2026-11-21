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
 *   - a WRAPPER is followed one step: a function of the same file that
 *     hands its own first parameter to checkRateLimit as the key
 *     (`allowRecoveryPress(key, limit)`, `allow(key)`). Every call of it in
 *     that file is read like a call site of checkRateLimit: a literal key's
 *     prefix must be on exactly one list AND among the prefixes its file
 *     lists in NON_LITERAL_CALL_SITES, so a new key sent through a listed
 *     wrapper is decided here too. A wrapper may not be exported: its calls
 *     in other files would not be read;
 *   - every listed prefix is used by some call site, so the lists cannot rot.
 * Not followed: a key built by a helper (`allow(accountDeleteKey(id))`,
 * `checkRateLimit(returnTokenBucketKey(token))`). Those stay accounted for
 * by file in NON_LITERAL_CALL_SITES, and the third test checks each listed
 * prefix is the head of a literal somewhere.
 * The self-tests at the bottom plant a call site with an unlisted prefix, one
 * with an unlisted non-literal key, and a wrapper handed an undecided key,
 * so this cannot pass by reading nothing.
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
    sites.push(firstArgument(rest));
  }
  return sites;
}

/** The first argument of a call whose text starts at `rest`: a key's head, or null when it is not a literal. */
function firstArgument(rest: string): CallSite {
  const template = rest.match(/^`((?:[^`\\$]|\\.|\$(?!\{))*)(\$\{|`)/);
  const quoted = rest.match(/^(['"])((?:(?!\1)[^\\]|\\.)*)\1/);
  if (template) return { prefix: template[1]!, whole: template[2] === '`' };
  if (quoted) return { prefix: quoted[2]!, whole: true };
  return null;
}

/**
 * The wrappers of a source: functions that hand their own first parameter to
 * checkRateLimit as the key. For each, whether it is exported and the key of
 * every call of it in the same source.
 */
function wrappers(source: string): Array<{ name: string; exported: boolean; calls: CallSite[] }> {
  const text = code(source);
  // Every function of the file, by where it starts, with its first parameter.
  const declared = [
    ...text.matchAll(
      /(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)?|(export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(\s*([A-Za-z_$][\w$]*)?/g,
    ),
  ].map((m) => ({
    at: m.index,
    name: (m[2] ?? m[5])!,
    exported: Boolean(m[1] ?? m[4]),
    firstParameter: m[3] ?? m[6] ?? null,
  }));
  const found = new Map<string, { name: string; exported: boolean; calls: CallSite[] }>();
  for (const m of text.matchAll(/(?<![\w.$])checkRateLimit\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) {
    // The function this call sits in: the last one declared before it.
    const inside = declared.filter((d) => d.at < m.index).pop();
    if (!inside || inside.name === 'checkRateLimit' || inside.firstParameter !== m[1]) continue;
    if (found.has(inside.name)) continue;
    const calls: CallSite[] = [];
    const name = inside.name.replace(/[$]/g, '\\$&');
    for (const call of text.matchAll(new RegExp(`(?<![\\w.$])${name}\\(\\s*`, 'g'))) {
      const before = text.slice(Math.max(0, call.index - 30), call.index);
      if (/function\s+$/.test(before)) continue;
      calls.push(firstArgument(text.slice(call.index + call[0].length)));
    }
    found.set(inside.name, { name: inside.name, exported: inside.exported, calls });
  }
  return [...found.values()];
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
    // A wrapper's calls: each literal key is decided like a direct call site,
    // and must be one of the prefixes its file is listed with.
    for (const wrapper of wrappers(src)) {
      if (wrapper.exported) {
        found.push(`${rel}: ${wrapper.name} hands its key to checkRateLimit and is exported; its calls elsewhere are not read`);
      }
      for (const site of wrapper.calls) {
        if (site === null) continue;
        const prefix = site.whole
          ? (LISTED_LONGEST_FIRST.find((p) => site.prefix.startsWith(p)) ?? site.prefix)
          : site.prefix;
        used.add(prefix);
        if (!ON_A_LIST(prefix)) {
          found.push(`${rel}: prefix ${JSON.stringify(prefix)}, sent through ${wrapper.name}, is on neither list (or on both)`);
        } else if (!listed?.includes(prefix)) {
          found.push(`${rel}: prefix ${JSON.stringify(prefix)}, sent through ${wrapper.name}, is not among this file's prefixes in NON_LITERAL_CALL_SITES`);
        }
      }
    }
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

  it('finds the wrappers of the real tree, and the literal keys sent through them', () => {
    const recovery = wrappers(files.get('server/actions/mfa-recovery.ts')!);
    expect(recovery.map((w) => [w.name, w.exported])).toEqual([['allowRecoveryPress', false]]);
    expect(recovery[0]!.calls).toEqual([
      { prefix: 'mfa-recovery:', whole: false },
      { prefix: 'mfa-recovery-password:', whole: false },
      { prefix: 'mfa-recovery-code:', whole: false },
    ]);
    const deletion = wrappers(files.get('server/lib/account-deletion-credential.ts')!);
    expect(deletion.map((w) => [w.name, w.exported])).toEqual([['allow', false]]);
    // Its keys come from helpers, which are not followed: listed by file instead.
    expect(deletion[0]!.calls).toEqual([null, null, null]);
    // No other file wraps the limiter.
    const all = [...files].flatMap(([rel, src]) => wrappers(src).map((w) => `${rel}#${w.name}`));
    expect(all.sort()).toEqual([
      'server/actions/mfa-recovery.ts#allowRecoveryPress',
      'server/lib/account-deletion-credential.ts#allow',
    ]);
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

describe('self-test: a key sent through a listed wrapper is decided too', () => {
  const recovery = 'server/actions/mfa-recovery.ts';
  const wrapper =
    "async function allowRecoveryPress(key: string, limit: number) {\n  return (await checkRateLimit(key, limit, 900_000, 'closed')).allowed;\n}\n";

  it('a new key on no list', () => {
    const planted = new Map([[recovery, `${wrapper}await allowRecoveryPress(\`mfa-recovery-new:\${id}\`, 5);`]]);
    expect(problems(planted).problems).toEqual([
      `${recovery}: prefix "mfa-recovery-new:", sent through allowRecoveryPress, is on neither list (or on both)`,
    ]);
  });

  it('a key that is on a list, but not one of the file’s own prefixes', () => {
    const planted = new Map([[recovery, `${wrapper}await allowRecoveryPress(\`public-order-request:\${ip}\`, 5);`]]);
    expect(problems(planted).problems).toEqual([
      `${recovery}: prefix "public-order-request:", sent through allowRecoveryPress, is not among this file's prefixes in NON_LITERAL_CALL_SITES`,
    ]);
  });

  it('an arrow-function wrapper, and a whole literal key', () => {
    const planted = new Map([
      [
        recovery,
        "const allowPress = async (key: string) => (await checkRateLimit(key, 5, 1)).allowed;\nawait allowPress('never-listed-key');",
      ],
    ]);
    expect(problems(planted).problems).toEqual([
      `${recovery}: prefix "never-listed-key", sent through allowPress, is on neither list (or on both)`,
    ]);
  });

  it('an exported wrapper: its calls in other files would not be read', () => {
    const planted = new Map([[recovery, `export ${wrapper}await allowRecoveryPress(\`mfa-recovery:\${id}\`, 5);`]]);
    expect(problems(planted).problems).toEqual([
      `${recovery}: allowRecoveryPress hands its key to checkRateLimit and is exported; its calls elsewhere are not read`,
    ]);
  });

  it('the file’s own prefixes pass, and a local variable handed to checkRateLimit is not a wrapper', () => {
    const planted = new Map([
      [
        recovery,
        `${wrapper}await allowRecoveryPress(\`mfa-recovery:\${id}:\${ip}\`, 5);\nawait allowRecoveryPress(\`mfa-recovery-code:\${id}\`, 5);`,
      ],
      [
        'app/unsubscribe/route.ts',
        "export async function POST(req: Request) {\n  const linkKey = `unsubscribe:link:${hash}`;\n  await checkRateLimit(linkKey, 5, 1);\n}",
      ],
    ]);
    expect(problems(planted).problems).toEqual([]);
    expect(wrappers(planted.get('app/unsubscribe/route.ts')!)).toEqual([]);
  });
});
