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
 * The self-test at the bottom plants each violation, so this cannot pass by
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
