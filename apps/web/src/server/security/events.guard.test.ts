import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Security invariant: the security-events recorder and its detector helpers
 * are server code, never Server Actions.
 *
 * recordSecurityEvent stores an event with the service role for whatever
 * category, reason and organization it is handed. Exported from a 'use server'
 * module it would be a Server Action: an endpoint anyone could call to write
 * security events in any organization's name, or to flood the record. The same
 * holds for the helpers that call it with a caller-chosen account or email
 * (server/security/account-events.ts) and for the flush.
 *
 * So:
 *   1. every module under server/security that is not a test starts with
 *      `import 'server-only';` and has no 'use server' directive;
 *   2. no 'use server' module anywhere under src (tests aside) defines a
 *      function by one of their names, re-exports anything from
 *      server/security, or exports (by name, by `export const x = ...` or as
 *      default) a binding it imported from server/security.
 *   3. THE ORGANIZATION COMES FROM THE SERVER. recordSecurityEvent stores
 *      whatever organization it is handed, so the only code that may hand it
 *      one is server/security itself (account-events.ts, which finds the
 *      organization of an account on the server, after the response).
 *      Everywhere else under src (tests aside) a call must be written as
 *      `recordSecurityEvent({ category, outcome, reason, source }, ...)`: an
 *      object written out at the call, with those four keys and no other, no
 *      spread and no computed key. So no route or Server Action can pass an
 *      organization that came from a request, by name or inside a variable.
 *      The recorder may not be imported under another name, as a namespace or
 *      by import(), and may not be used as a value (handed on, bound, stored):
 *      each would be a call this guard cannot read. Two guard lists rest on
 *      this (authenticator-write NOT_WRITES and rpc-active-organization
 *      REGISTRY, for record_security_events).
 * The self-tests at the bottom plant each violation, so this cannot pass by
 * reading nothing.
 */

const WEB_SRC = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(WEB_SRC, rel), 'utf8');
/** The source with comments removed (a `//` after `:` is kept: URLs). */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const RECORDER_NAMES = [
  'recordSecurityEvent',
  'flushSecurityEvents',
  'recordSignInBlocked',
  'recordAccountCodeBlocked',
  'organizationForSignInEmail',
  'recordLimiterRefusal',
];

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

const isServerModule = (src: string) => /^\s*['"]use server['"]/.test(code(src));

/**
 * What a 'use server' module does wrong with the recorder, as messages. `rel`
 * is the file's path under src, so a relative import is read against it.
 */
function violations(rel: string, src: string): string[] {
  const text = code(src);
  if (!/^\s*['"]use server['"]/.test(text)) return [];
  const found: string[] = [];
  const fromSecurity = (spec: string) => {
    if (spec.startsWith('@/server/security/')) return true;
    if (!spec.startsWith('.')) return false;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
    return resolved.startsWith('server/security/');
  };

  for (const name of RECORDER_NAMES) {
    if (new RegExp(`function\\s+${name}\\b`).test(text)) found.push(`defines ${name}`);
  }

  // Bindings imported from server/security.
  const imported = new Set<string>();
  for (const m of text.matchAll(/import\s+(?:type\s+)?([^;]*?)\s+from\s+(['"])([^'"]+)\2/g)) {
    if (!fromSecurity(m[3]!)) continue;
    const clause = m[1]!;
    const named = clause.match(/\{([^}]*)\}/);
    if (named) {
      for (const part of named[1]!.split(',')) {
        const local = part.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, '').trim();
        if (local) imported.add(local);
      }
    }
    const ns = clause.match(/\*\s+as\s+(\w+)/);
    if (ns) imported.add(ns[1]!);
    const def = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+\w+/, '').replace(/,/g, '').trim();
    if (def) imported.add(def);
  }

  for (const m of text.matchAll(/export\s+(?:type\s+)?(\*|\{[^}]*\})(?:\s+as\s+\w+)?\s+from\s+(['"])([^'"]+)\2/g)) {
    if (fromSecurity(m[3]!)) found.push(`re-exports from ${m[3]}`);
  }
  for (const m of text.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/g)) {
    for (const part of m[1]!.split(',')) {
      const local = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (local && imported.has(local)) found.push(`exports ${local}`);
    }
  }
  for (const m of text.matchAll(/export\s+(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?([A-Za-z_$][\w$]*)/g)) {
    if (imported.has(m[1]!)) found.push(`exports a binding of ${m[1]}`);
  }
  for (const m of text.matchAll(/export\s+default\s+([A-Za-z_$][\w$]*)/g)) {
    if (imported.has(m[1]!)) found.push(`exports ${m[1]} as default`);
  }
  return found;
}

describe('the security-events recorder stays out of Server Actions', () => {
  const files = sourceFiles(WEB_SRC)
    .map((f) => path.relative(WEB_SRC, f).split(path.sep).join('/'))
    .filter((rel) => !isTestFile(rel));

  it('reads a real tree, with server modules in it', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.filter((rel) => isServerModule(read(rel))).length).toBeGreaterThan(20);
  });

  it('every module under server/security starts with server-only and is never a server module', () => {
    const modules = files.filter((rel) => rel.startsWith('server/security/'));
    expect(modules).toEqual(
      expect.arrayContaining(['server/security/events.ts', 'server/security/account-events.ts']),
    );
    for (const rel of modules) {
      const src = read(rel);
      if (!/export\s/.test(src)) continue;
      if (rel === 'server/security/monitors.ts') {
        // Pure helpers of the monitoring crons: no I/O, nothing the recorder exports.
        expect(code(src), rel).not.toMatch(/['"]use server['"]/);
        continue;
      }
      expect(src.trimStart().startsWith("import 'server-only';"), rel).toBe(true);
      expect(code(src), rel).not.toMatch(/['"]use server['"]/);
    }
  });

  it('the recorder and the helpers are where this guard looks for them', () => {
    expect(read('server/security/events.ts')).toMatch(/export async function recordSecurityEvent\(/);
    expect(read('server/security/events.ts')).toMatch(/export async function flushSecurityEvents\(/);
    expect(read('server/security/account-events.ts')).toMatch(/export function recordSignInBlocked\(/);
    expect(read('server/security/account-events.ts')).toMatch(
      /export function recordAccountCodeBlocked\(/,
    );
  });

  it('no server module defines, re-exports or exports them', () => {
    const found: string[] = [];
    for (const rel of files) {
      for (const v of violations(rel, read(rel))) found.push(`${rel}: ${v}`);
    }
    expect(found).toEqual([]);
  });
});

describe('self-test: each violation is found', () => {
  const at = 'server/actions/x.ts';
  it.each([
    ["'use server';\nexport { recordSecurityEvent } from '@/server/security/events';"],
    ["'use server';\nexport * from '@/server/security/events';"],
    ["'use server';\nexport { recordSignInBlocked as r } from '../security/account-events';"],
    ["'use server';\nimport { recordSecurityEvent } from '@/server/security/events';\nexport { recordSecurityEvent };"],
    ["'use server';\nimport { recordSecurityEvent as rec } from '@/server/security/events';\nexport { rec as go };"],
    ["'use server';\nimport { recordSecurityEvent } from '@/server/security/events';\nexport const go = recordSecurityEvent;"],
    ["'use server';\nimport * as ev from '@/server/security/events';\nexport { ev };"],
    ["'use server';\nimport { flushSecurityEvents } from '@/server/security/events';\nexport default flushSecurityEvents;"],
    ["'use server';\nexport async function recordSecurityEvent() {}"],
    ['"use server";\nasync function organizationForSignInEmail() {}'],
  ])('finds %j', (src) => {
    expect(violations(at, src).length).toBeGreaterThanOrEqual(1);
  });

  it.each([
    // Calling the recorder from an action is fine: nothing of it is exported.
    ["'use server';\nimport { recordSecurityEvent } from '@/server/security/events';\nexport async function act() { await recordSecurityEvent(e); }"],
    // Not a server module.
    ["import 'server-only';\nexport { recordSecurityEvent } from './events';"],
    // A comment is not code.
    ["'use server';\n// export { recordSecurityEvent } from '@/server/security/events';"],
    ["'use server';\nimport { other } from '@/server/services/x';\nexport { other };"],
  ])('does not count %j', (src) => {
    expect(violations(at, src)).toEqual([]);
  });
});

// ── 3. The organization comes from the server ───────────────────────────────

/** The only keys a call outside server/security may give the recorder's event. */
const EVENT_KEYS_OUTSIDE = new Set(['category', 'outcome', 'reason', 'source']);

/**
 * The end of the bracketed text that opens at `open` ('(' or '{' or '['), or
 * -1. Strings and template literals are stepped over.
 */
function closingOf(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) return -1;
      i = j;
    } else if (pairs[c]) {
      stack.push(pairs[c]!);
    } else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** `text` cut at its top-level commas (not inside brackets or strings). */
function topLevelParts(text: string): string[] | null {
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) return null;
      i = j;
    } else if (c === '(' || c === '{' || c === '[') {
      const end = closingOf(text, i);
      if (end === -1) return null;
      i = end;
    } else if (c === ',') {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * What a file outside server/security does with the recorder that could carry
 * an organization from anywhere but the server, as messages. `rel` is the
 * file's path under src.
 */
function organizationFromOutside(rel: string, src: string): string[] {
  if (rel.startsWith('server/security/')) return [];
  const text = code(src);
  const found: string[] = [];
  const isRecorderModule = (spec: string) => {
    if (spec === '@/server/security/events') return true;
    if (!spec.startsWith('.')) return false;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
    return resolved === 'server/security/events';
  };

  // How the recorder is imported: by its own name, in a named import, only.
  let rest = text;
  for (const m of text.matchAll(/import\s+(?:type\s+)?([^;]*?)\s+from\s+(['"])([^'"]+)\2/g)) {
    const clause = m[1]!;
    if (!isRecorderModule(m[3]!)) {
      // A module that hands the recorder on would hide its calls from this guard.
      if (/\brecordSecurityEvent\b/.test(clause)) {
        found.push('imports recordSecurityEvent from a module other than server/security/events');
        rest = rest.replace(m[0], '');
      }
      continue;
    }
    if (/\*\s+as\s+\w+/.test(clause)) found.push('imports the recorder module as a namespace');
    if (/\brecordSecurityEvent\s+as\s+\w+/.test(clause)) {
      found.push('imports recordSecurityEvent under another name');
    }
    rest = rest.replace(m[0], '');
  }
  for (const m of text.matchAll(/(?:\bimport|\brequire)\s*\(\s*(['"`])([^'"`]+)\1/g)) {
    if (isRecorderModule(m[2]!)) found.push('loads the recorder module with import() or require()');
  }

  // Every other mention must be a call, with its event written out in place.
  for (const m of rest.matchAll(/(?<![\w$])recordSecurityEvent\b/g)) {
    const after = rest.slice(m.index + m[0].length);
    const call = after.match(/^\s*\(/);
    if (!call) {
      found.push('uses recordSecurityEvent as a value, not a call');
      continue;
    }
    const open = m.index + m[0].length + call[0].length - 1;
    const close = closingOf(rest, open);
    const args = close === -1 ? null : topLevelParts(rest.slice(open + 1, close));
    const event = args?.[0];
    if (!event) {
      found.push('calls recordSecurityEvent in a way this guard cannot read');
      continue;
    }
    if (!event.startsWith('{') || closingOf(event, 0) !== event.length - 1) {
      found.push('passes recordSecurityEvent an event that is not written out at the call');
      continue;
    }
    const properties = topLevelParts(event.slice(1, -1));
    if (properties === null) {
      found.push('calls recordSecurityEvent in a way this guard cannot read');
      continue;
    }
    for (const property of properties) {
      if (property.startsWith('...')) {
        found.push('spreads another object into the event');
        continue;
      }
      const key = property.match(/^(?:(['"])([^'"]*)\1|([A-Za-z_$][\w$]*))\s*(?::|$)/);
      const name = key ? (key[2] ?? key[3]!) : null;
      if (name === null) found.push(`gives the event a key this guard cannot read (${property.slice(0, 24)})`);
      else if (!EVENT_KEYS_OUTSIDE.has(name)) found.push(`gives the event the key ${name}`);
    }
  }
  return found;
}

describe('the organization of a security event comes from the server', () => {
  const files = sourceFiles(WEB_SRC)
    .map((f) => path.relative(WEB_SRC, f).split(path.sep).join('/'))
    .filter((rel) => !isTestFile(rel));

  it('reads real call sites outside server/security, and the one inside that passes an organization', () => {
    const callers = files.filter(
      (rel) => !rel.startsWith('server/security/') && /(?<![\w$])recordSecurityEvent\s*\(/.test(code(read(rel))),
    );
    expect(callers).toEqual(
      expect.arrayContaining(['app/api/security/probe/[kind]/route.ts', 'lib/auth/api-key.ts']),
    );
    // The reviewed place an organization is passed from: found on the server.
    expect(code(read('server/security/account-events.ts'))).toMatch(
      /recordSecurityEvent\(\s*\{[^}]*\borganizationId\b/,
    );
  });

  it('nothing outside server/security passes recordSecurityEvent an organization, or an event it did not write out', () => {
    const found: string[] = [];
    for (const rel of files) {
      for (const v of organizationFromOutside(rel, read(rel))) found.push(`${rel}: ${v}`);
    }
    expect(found).toEqual([]);
  });
});

describe('self-test: an organization from outside is found', () => {
  const at = 'app/api/v1/things/route.ts';
  const imported = "import { recordSecurityEvent } from '@/server/security/events';\n";
  const fixed = "category: 'bots', outcome: 'blocked', reason: 'thing_paused', source: 'api'";
  it.each([
    ['an organization from the request', `${imported}await recordSecurityEvent({ ${fixed}, organizationId: body.organizationId }, req.headers);`],
    ['an organization from the session', `${imported}await recordSecurityEvent({ ${fixed}, organizationId: ctx.organizationId });`],
    ['a shorthand organization', `${imported}await recordSecurityEvent({ ${fixed}, organizationId });`],
    ['a quoted key', `${imported}await recordSecurityEvent({ ${fixed}, 'organizationId': id });`],
    ['a computed key', `${imported}await recordSecurityEvent({ ${fixed}, [key]: id });`],
    ['a spread', `${imported}await recordSecurityEvent({ ...input, ${fixed} });`],
    ['an event in a variable', `${imported}const event = build(body);\nawait recordSecurityEvent(event, req.headers);`],
    ['an event from a call', `${imported}await recordSecurityEvent(eventFor(body));`],
    ['an event in brackets', `${imported}await recordSecurityEvent(({ ${fixed}, organizationId: id }));`],
    ['an event with a cast', `${imported}await recordSecurityEvent({ ${fixed} } as never);`],
    ['another name', "import { recordSecurityEvent as rec } from '@/server/security/events';\nawait rec(event);"],
    ['a namespace', "import * as events from '@/server/security/events';\nawait events.recordSecurityEvent(event);"],
    ['a relative path', "import * as events from '../../../../server/security/events';\nawait events.recordSecurityEvent(event);"],
    ['import()', "const { recordSecurityEvent: rec } = await import('@/server/security/events');\nawait rec(event);"],
    ['a module that hands the recorder on', "import { recordSecurityEvent } from '@/server/lib/record';\nawait recordSecurityEvent({ category, outcome, reason, source });"],
    ['handed on as a value', `${imported}await each(events, recordSecurityEvent);`],
    ['stored under another name', `${imported}const rec = recordSecurityEvent;\nawait rec(event);`],
    ['a call that never closes', `${imported}await recordSecurityEvent({ ${fixed}`],
  ])('finds %s', (_what, src) => {
    expect(organizationFromOutside(at, src).length).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['the four fixed keys', `${imported}await recordSecurityEvent({ ${fixed} }, req.headers);`],
    ['a reason from a checked value', `${imported}await recordSecurityEvent(\n  { category: 'exploit', outcome: 'blocked', reason: kind, source: 'web' },\n  req.headers,\n);`],
    ['shorthand of the four keys', `${imported}await recordSecurityEvent({ category, outcome, reason, source });`],
    ['a comment', `${imported}// await recordSecurityEvent({ ${fixed}, organizationId: id });`],
    ['a file that never calls it', "export const x = 1;"],
  ])('does not count %s', (_what, src) => {
    expect(organizationFromOutside(at, src)).toEqual([]);
  });

  it('server/security itself may pass an organization: it is where the server finds one', () => {
    const src = `import { recordSecurityEvent } from './events';\nawait recordSecurityEvent({ ${fixed}, organizationId }, headers);`;
    expect(organizationFromOutside('server/security/account-events.ts', src)).toEqual([]);
    // A folder that only looks like it is not exempt.
    expect(organizationFromOutside('server/securityx/y.ts', src)).toEqual([
      'imports recordSecurityEvent from a module other than server/security/events',
      'gives the event the key organizationId',
    ]);
  });
});
