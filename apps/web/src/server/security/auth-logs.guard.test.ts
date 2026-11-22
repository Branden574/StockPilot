import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { SECURITY_BOT_FAMILIES, securityBotReason } from '@stockpilot/core';

import { AUTH_LOGS_REASONS, AUTH_LOGS_SOURCES } from './auth-logs';
import { LIMITER_BOT_PREFIXES, limiterSecurityEvent } from './limiter-events';

/**
 * Security invariant: the rows the auth-logs job's "already stored" check
 * reads are written by that job alone.
 *
 * The job (server/security/auth-logs.ts) stores each hour's counts once, and
 * knows an hour is stored when a row of the security-events record has no
 * organization, source phone or api, and one of the job's own reasons
 * (AUTH_LOGS_REASONS) in that hour. The writer ADDS on a repeat, so if any
 * other code could write such a row, outside traffic could make an hour look
 * stored and the job would skip it: those refused sign-ins would never be
 * recorded. So:
 *   1. only two modules call the writer, record_security_events: the
 *      recorder (server/security/events.ts) and the job. (A writer called by
 *      a name that is not a literal fails the rpc-active-organization guard.)
 *   2. every call of the recorder, recordSecurityEvent, anywhere under src
 *      (tests aside) is read on the syntax tree. A call whose source can be
 *      phone or api (written so, or not a literal) must name its reason as a
 *      literal that is not one of the job's. A call this reading cannot see
 *      into (a spread, a variable) must be listed in REVIEWED, with a check
 *      below that proves it. The recorder may not be used as a value, nor
 *      imported or exported under another name.
 *   3. the recorder itself invents one reason only, over_buffer_cap, and the
 *      limiter's events carry `<family>_paused`: neither is one of the job's.
 *      The database writer's own renames (repeated_..., over_minute_cap) are
 *      not either.
 *   4. the job's own lists of reasons and sources are pinned here by value,
 *      so neither can change without this guard changing with it.
 * The self-tests at the bottom plant each violation, so this cannot pass by
 * reading nothing.
 */

const WEB_SRC = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(WEB_SRC, rel), 'utf8');

/** The modules that may call record_security_events. */
const WRITER_MODULES = ['server/security/auth-logs.ts', 'server/security/events.ts'];

const JOB_REASONS: readonly string[] = AUTH_LOGS_REASONS;
const JOB_SOURCES: readonly string[] = AUTH_LOGS_SOURCES;

/**
 * Recorder calls this reading cannot see into, keyed `<file>#<argument>`
 * (white space folded), each with the check below that proves it.
 */
const REVIEWED: Record<string, string> = {
  "server/security/limiter-events.ts#{ ...event, outcome: 'blocked' }":
    "The event is limiterSecurityEvent(key): category bots, reason `<family>_paused`, source from LIMITER_BOT_PREFIXES; 'the limiter' below checks every prefix.",
};

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

type Field = { literal: string } | { dynamic: true } | { absent: true };

interface Scan {
  /** Where the file names record_security_events in code (never a comment). */
  writerSites: number;
  /** What this guard reports for the file. */
  violations: string[];
  /** Recorder calls read. */
  calls: number;
}

const folded = (text: string) => text.replace(/\s+/g, ' ').trim();

/** One property of an object literal written at a call: a literal, something else, or not there. */
function field(obj: ts.ObjectLiteralExpression, name: string): Field {
  for (const p of obj.properties) {
    if (!p.name || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) || p.name.text !== name)
      continue;
    if (ts.isPropertyAssignment(p)) {
      const init = p.initializer;
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init))
        return { literal: init.text };
    }
    return { dynamic: true };
  }
  return { absent: true };
}

/** What this guard finds in one file. `rel` is its path under src. */
function scan(rel: string, text: string): Scan {
  const sf = ts.createSourceFile(
    rel,
    text,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: Scan = { writerSites: 0, violations: [], calls: 0 };
  const where = (node: ts.Node) =>
    `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;

  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text === 'record_security_events'
    ) {
      out.writerSites += 1;
    }

    if (ts.isImportSpecifier(node)) {
      const imported = (node.propertyName ?? node.name).text;
      if (imported === 'recordSecurityEvent' && node.name.text !== 'recordSecurityEvent') {
        out.violations.push(`${where(node)}: imports recordSecurityEvent under another name`);
      }
    }

    // The same for an export: `export { recordSecurityEvent as rec }` (with
    // or without `from`) would let another module call the recorder by a
    // name this guard does not look for.
    if (ts.isExportSpecifier(node)) {
      const exported = (node.propertyName ?? node.name).text;
      if (exported === 'recordSecurityEvent' && node.name.text !== 'recordSecurityEvent') {
        out.violations.push(`${where(node)}: exports recordSecurityEvent under another name`);
      }
    }

    if (ts.isIdentifier(node) && node.text === 'recordSecurityEvent') {
      const parent = node.parent;
      const isCallee = ts.isCallExpression(parent) && parent.expression === node;
      const isDeclaration =
        (ts.isFunctionDeclaration(parent) && parent.name === node) ||
        ts.isImportSpecifier(parent) ||
        ts.isExportSpecifier(parent);
      if (!isCallee && !isDeclaration) {
        out.violations.push(
          `${where(node)}: uses recordSecurityEvent as a value, which this guard cannot read`,
        );
      }
      if (isCallee) {
        out.calls += 1;
        const call = parent as ts.CallExpression;
        const arg = call.arguments[0];
        const argText = arg ? folded(arg.getText(sf)) : '';
        const readable =
          arg !== undefined &&
          ts.isObjectLiteralExpression(arg) &&
          arg.properties.every((p) => !ts.isSpreadAssignment(p));
        if (!readable) {
          if (!Object.prototype.hasOwnProperty.call(REVIEWED, `${rel}#${argText}`)) {
            out.violations.push(
              `${where(call)}: an event this guard cannot read (${argText || 'no argument'})`,
            );
          }
        } else {
          const source = field(arg, 'source');
          const reason = field(arg, 'reason');
          const sourceMayBeJobs =
            'dynamic' in source || ('literal' in source && JOB_SOURCES.includes(source.literal));
          const reasonIsOther = 'literal' in reason && !JOB_REASONS.includes(reason.literal);
          if (sourceMayBeJobs && !reasonIsOther) {
            out.violations.push(
              `${where(call)}: may send source phone or api with one of the auth-logs job's reasons (${argText})`,
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("only the auth-logs job writes the rows its 'already stored' check reads", () => {
  const files = sourceFiles(WEB_SRC)
    .map((f) => path.relative(WEB_SRC, f).split(path.sep).join('/'))
    .filter((rel) => !isTestFile(rel));
  const scans = new Map(files.map((rel) => [rel, scan(rel, read(rel))]));

  it('reads a real tree, with the real recorder calls in it', () => {
    expect(files.length).toBeGreaterThan(500);
    const callers = [...scans].filter(([, s]) => s.calls > 0).map(([rel]) => rel);
    expect(callers).toEqual(
      expect.arrayContaining([
        'server/security/account-events.ts',
        'server/security/limiter-events.ts',
        'lib/auth/api-key.ts',
        'app/api/security/probe/[kind]/route.ts',
      ]),
    );
  });

  it('only the recorder and the job call record_security_events', () => {
    const sites = [...scans]
      .filter(([, s]) => s.writerSites > 0)
      .map(([rel]) => rel)
      .sort();
    expect(sites).toEqual(WRITER_MODULES);
  });

  it("no recorder call can send source phone or api with one of the job's reasons", () => {
    const found = [...scans.values()].flatMap((s) => s.violations);
    expect(found).toEqual([]);
  });

  it('every reviewed call is still there', () => {
    for (const key of Object.keys(REVIEWED)) {
      const [rel, argText] = [key.slice(0, key.indexOf('#')), key.slice(key.indexOf('#') + 1)];
      expect(folded(read(rel)), key).toContain(`recordSecurityEvent(${argText})`);
    }
  });

  it("the job's reasons and sources are the ones reviewed here, value for value", () => {
    // This guard reads both lists from the job's module. A reason or a source
    // taken off them there would make every check above pass for it without
    // anyone looking, and the job's check of what is already stored would
    // stop reading rows the job still writes. So a change to either list is
    // a change to this guard too.
    expect([...AUTH_LOGS_REASONS]).toEqual([
      'wrong_password',
      'wrong_code',
      'auth_rate_limited',
      'auth_log_over_cap',
      'unclassified_sign_in_refusals',
      'unrecorded_server_form_password',
      'unrecorded_server_form_code',
      'too_many_forms_to_count',
    ]);
    expect([...AUTH_LOGS_SOURCES]).toEqual(['phone', 'api']);
    // And every element the job can build carries one of them: its element
    // type takes its reason and source from these two lists (the compiler
    // holds that), and the lists are frozen in shape by `as const`.
    const source = read('server/security/auth-logs.ts');
    expect(source).toMatch(/export type AuthLogsReason = \(typeof AUTH_LOGS_REASONS\)\[number\];/);
    expect(source).toMatch(/export type AuthLogsSource = \(typeof AUTH_LOGS_SOURCES\)\[number\];/);
    expect(source).toMatch(/\n {2}reason: AuthLogsReason;\n {2}source: AuthLogsSource;\n/);
  });

  it("the limiter's events carry `<family>_paused`, never one of the job's reasons", () => {
    const prefixes = Object.keys(LIMITER_BOT_PREFIXES);
    expect(prefixes.length).toBeGreaterThan(10);
    for (const prefix of prefixes) {
      const event = limiterSecurityEvent(`${prefix}probe`);
      expect(event, prefix).not.toBeNull();
      expect(event!.category, prefix).toBe('bots');
      expect(JOB_REASONS, prefix).not.toContain(event!.reason);
    }
    for (const family of SECURITY_BOT_FAMILIES) {
      expect(JOB_REASONS, family).not.toContain(securityBotReason(family));
    }
  });

  it("the recorder invents one reason, over_buffer_cap; neither it nor the database writer's renames are the job's", () => {
    const sf = ts.createSourceFile(
      'events.ts',
      read('server/security/events.ts'),
      ts.ScriptTarget.Latest,
      true,
    );
    const invented = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'reason' &&
        (ts.isStringLiteral(node.initializer) ||
          ts.isNoSubstitutionTemplateLiteral(node.initializer))
      ) {
        invented.add(node.initializer.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect([...invented]).toEqual(['over_buffer_cap']);
    for (const other of ['over_buffer_cap', 'over_minute_cap'])
      expect(JOB_REASONS).not.toContain(other);
    for (const reason of JOB_REASONS) expect(reason.startsWith('repeated_'), reason).toBe(false);
  });
});

describe('the guard finds what it is meant to find (self-test)', () => {
  const planted = (body: string) =>
    scan(
      'server/planted.ts',
      `import { recordSecurityEvent } from '@/server/security/events';\n${body}\n`,
    );

  it.each([
    [
      "recordSecurityEvent({ category: 'password_guessing', outcome: 'blocked', reason: 'wrong_password', source: 'phone' });",
    ],
    [
      "recordSecurityEvent({ category: 'bots', outcome: 'blocked', reason: 'auth_rate_limited', source: 'api' });",
    ],
    [
      "recordSecurityEvent({ category: 'password_guessing', outcome: 'blocked', reason: 'auth_log_over_cap', source: 'api' }, h);",
    ],
    ["recordSecurityEvent({ category: 'bots', outcome: 'blocked', reason, source: 'api' });"],
    ["recordSecurityEvent({ category: 'bots', outcome: 'blocked', reason: r, source: 'phone' });"],
    [
      "recordSecurityEvent({ category: 'password_guessing', outcome: 'blocked', reason: 'wrong_code', source: s });",
    ],
    ['recordSecurityEvent(event);'],
    ["recordSecurityEvent({ ...event, outcome: 'blocked' });"],
    ['recordSecurityEvent();'],
    ['const go = recordSecurityEvent;'],
    ['[e].forEach(recordSecurityEvent);'],
  ])('reports %s', (body) => {
    expect(planted(body).violations).toHaveLength(1);
  });

  it('reports the recorder imported under another name', () => {
    const s = scan(
      'server/planted.ts',
      "import { recordSecurityEvent as rec } from './events';\nrec(e);\n",
    );
    expect(s.violations).toEqual([
      'server/planted.ts:1: imports recordSecurityEvent under another name',
    ]);
  });

  it.each([
    ["export { recordSecurityEvent as rec } from './events';"],
    ["export { recordSecurityEvent as default } from '@/server/security/events';"],
    ["import { recordSecurityEvent } from './events';\nexport { recordSecurityEvent as rec };"],
  ])('reports the recorder exported under another name: %s', (text) => {
    // Under another name its calls elsewhere would not be read at all.
    const s = scan('server/planted.ts', `${text}\n`);
    expect(s.violations).toEqual([
      expect.stringMatching(
        /^server\/planted\.ts:\d+: exports recordSecurityEvent under another name$/,
      ),
    ]);
  });

  it('passes the recorder exported under its own name (its calls are still read by that name)', () => {
    expect(
      scan('server/planted.ts', "export { recordSecurityEvent } from './events';\n").violations,
    ).toEqual([]);
  });

  it.each([
    [
      "recordSecurityEvent({ category: 'password_guessing', outcome: 'blocked', reason: 'wrong_password', source: 'web' });",
    ],
    [
      "recordSecurityEvent({ category: 'password_guessing', outcome: 'blocked', reason, source: 'web', organizationId });",
    ],
    [
      "recordSecurityEvent({ category: 'password_guessing', outcome: 'blocked', reason: 'unknown_api_key', source: 'api' }, req.headers);",
    ],
    [
      "recordSecurityEvent({ category: 'bots', outcome: 'blocked', reason: 'public_api_paused', source: s });",
    ],
    [
      "// recordSecurityEvent({ category: 'bots', outcome: 'blocked', reason: 'wrong_code', source: 'api' });",
    ],
  ])('passes %s', (body) => {
    expect(planted(body).violations).toEqual([]);
  });

  it('counts a writer call by its literal name, and never a comment', () => {
    expect(scan('x.ts', "admin.rpc('record_security_events', { p_events: [] });").writerSites).toBe(
      1,
    );
    expect(scan('x.ts', 'admin.rpc(`record_security_events`, { p_events: [] });').writerSites).toBe(
      1,
    );
    expect(
      scan('x.ts', '// record_security_events\n/* record_security_events */').writerSites,
    ).toBe(0);
  });
});
