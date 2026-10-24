/**
 * RECURRENCE GUARD: work left running with `void` in server code holds the
 * invocation open until it finishes.
 *
 * WHAT WENT WRONG. A promise left running with `void` as a route or action
 * answered was held by nothing: Vercel may suspend the instance once the
 * response is sent, and the work was cut off (an alert never posted, a
 * webhook delivery row never inserted, a notification or an email never
 * sent) or failed with a timeout when a later request resumed the instance.
 * #352 fixed it for audit rows; it was the same for `void reportError(...)`,
 * `void dispatchEvent(...)`, `void broadcastOrderChanged(...)`, and for the
 * purchase order and maintenance notifications, the support ticket emails,
 * a PO fan-out, a schedule close, two last-used stamps and a push token
 * clean-up.
 *
 * THE RULE. In server code (src/server, src/app/api, route files, 'use
 * server' files and every 'server-only' module), `void` may only be put in
 * front of a call to a function that keeps its own work alive (it hands it
 * to keepAlive, lib/defer.ts, and returns the same promise), named in
 * KEEPS_ITSELF_ALIVE and imported from its own module (an alias is followed,
 * so the isomorphic core reporter, which keeps nothing alive, does not pass
 * for the server one). Anything else is handed to keepAlive(...) where it
 * starts, deferred with defer(...), awaited, or listed in REVIEWED with why
 * nothing needs to outlive the response. Each KEEPS_ITSELF_ALIVE function is
 * checked to call keepAlive itself, so the list cannot outlive the fact.
 *
 * The AST is read: comments and strings never count. `.then` / `.catch` /
 * `.finally` chains are followed to the call they start from, and an async
 * IIFE is its own callee. `void x` of a name (not a call) is not looked at.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const WEB_SRC = path.resolve(__dirname, '..');

/** Module (path under src, no extension) -> the functions in it that keep their own work alive. */
const KEEPS_ITSELF_ALIVE: Record<string, readonly string[]> = {
  'lib/error-reporter': ['reportError'],
  'server/services/integration-events': ['dispatchEvent'],
  'server/services/audit': ['audit', 'auditMany', 'insertAuditRowReported'],
  'lib/realtime/broadcast': [
    'broadcastToChannel',
    'broadcastOrderChanged',
    'broadcastPermissionsChanged',
  ],
};

/** `file: callee` -> why nothing has to outlive the response. */
const REVIEWED: Record<string, string> = {
  'server/services/lib/defer.ts: run':
    "defer's own fallback outside a request scope, where there is no response to outlive",
  'lib/ssrf-guard.ts: agent.close':
    "closes safeFetch's per-request connection pool once the response is in hand; nothing to deliver",
  'lib/exports/export-images.ts: reader.cancel':
    'cancels an oversized image stream the request already aborted; nothing to deliver',
};

/* ------------------------------ the scan ------------------------------ */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const rel = (file: string) => path.relative(WEB_SRC, file).split(path.sep).join('/');

function directive(text: string, word: string): boolean {
  return new RegExp(`^(?:\\s|//[^\\n]*\\n|/\\*[\\s\\S]*?\\*/)*['"]${word}['"]`).test(text);
}

function isServerFile(file: string, text: string): boolean {
  const r = rel(file);
  if (directive(text, 'use client')) return false;
  return (
    r.startsWith('server/') ||
    r.startsWith('app/api/') ||
    /(^|\/)route\.ts$/.test(r) ||
    directive(text, 'use server') ||
    /^import 'server-only';/m.test(text)
  );
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** The module a specifier names, as a path under src without extension, or null for a package. */
function moduleOf(fromFile: string, spec: string): string | null {
  if (spec.startsWith('@/')) return spec.slice(2).replace(/\/index$/, '');
  if (spec.startsWith('.')) {
    return rel(path.resolve(path.dirname(fromFile), spec)).replace(/\/index$/, '');
  }
  return null;
}

/** local name -> { module, imported name } for the file's named imports. */
function importsOf(
  file: string,
  sf: ts.SourceFile,
): Map<string, { module: string | null; name: string }> {
  const out = new Map<string, { module: string | null; name: string }>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      out.set(el.name.text, {
        module: moduleOf(file, st.moduleSpecifier.text),
        name: (el.propertyName ?? el.name).text,
      });
    }
  }
  return out;
}

function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)) {
    n = n.expression;
  }
  return n;
}

/** The call a voided expression starts from, through .then/.catch/.finally; null when it is not a call. */
function startingCall(expr: ts.Expression): ts.CallExpression | null {
  let e = unwrap(expr);
  while (ts.isCallExpression(e)) {
    const callee = unwrap(e.expression);
    if (
      ts.isPropertyAccessExpression(callee) &&
      ['then', 'catch', 'finally'].includes(callee.name.text)
    ) {
      e = unwrap(callee.expression);
      continue;
    }
    return e;
  }
  return null;
}

interface Finding {
  where: string;
  callee: string;
  file: string;
}

function scan(): Finding[] {
  const findings: Finding[] = [];
  for (const file of sourceFiles(WEB_SRC)) {
    const text = readFileSync(file, 'utf8');
    if (!isServerFile(file, text)) continue;
    const sf = parse(file, text);
    const imports = importsOf(file, sf);
    const visit = (node: ts.Node) => {
      if (ts.isVoidExpression(node)) {
        const call = startingCall(node.expression);
        if (call) {
          const callee = unwrap(call.expression);
          let label: string;
          let ok = false;
          if (ts.isIdentifier(callee)) {
            label = callee.text;
            const imp = imports.get(callee.text);
            ok = !!imp?.module && (KEEPS_ITSELF_ALIVE[imp.module] ?? []).includes(imp.name);
          } else if (ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) {
            label = '(async IIFE)';
          } else {
            label = callee.getText(sf).replace(/\s+/g, '');
          }
          const key = `${rel(file)}: ${label}`;
          if (!ok && !(key in REVIEWED)) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            findings.push({ where: `${rel(file)}:${line + 1}`, callee: label, file: rel(file) });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return findings;
}

function findingsIn(source: string, file = 'server/services/example.ts'): string[] {
  const sf = parse(path.join(WEB_SRC, file), source);
  const imports = importsOf(path.join(WEB_SRC, file), sf);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVoidExpression(node)) {
      const call = startingCall(node.expression);
      if (call) {
        const callee = unwrap(call.expression);
        const imp = ts.isIdentifier(callee) ? imports.get(callee.text) : undefined;
        const ok = !!imp?.module && (KEEPS_ITSELF_ALIVE[imp.module] ?? []).includes(imp.name);
        if (!ok) out.push(callee.getText(sf).replace(/\s+/g, ' ').slice(0, 40));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/* ------------------------------ the tests ------------------------------ */

describe('server code leaves nothing running that the response can cut off', () => {
  it('scans the source tree (a wrong path would pass vacuously)', () => {
    const files = sourceFiles(WEB_SRC).filter((f) => isServerFile(f, readFileSync(f, 'utf8')));
    expect(files.length).toBeGreaterThan(300);
    expect(files.map(rel)).toContain('server/services/purchase-orders.ts');
    expect(files.map(rel)).toContain('lib/export-rate-limit.ts');
  });

  it('every `void` call is to a function that keeps itself alive, or reviewed', () => {
    expect(scan().map((f) => `${f.where}  void ${f.callee}(...)`)).toEqual([]);
  });

  it('every REVIEWED entry still exists (a stale one would hide a new call of the same name)', () => {
    const present = new Set<string>();
    for (const key of Object.keys(REVIEWED)) {
      const [file, callee] = key.split(': ');
      const text = readFileSync(path.join(WEB_SRC, file!), 'utf8');
      if (text.replace(/\s+/g, '').includes(`void${callee}(`)) present.add(key);
    }
    expect([...present].sort()).toEqual(Object.keys(REVIEWED).sort());
  });

  it('each function that is trusted to keep itself alive calls keepAlive (or one that does)', () => {
    for (const [module, names] of Object.entries(KEEPS_ITSELF_ALIVE)) {
      const file = path.join(WEB_SRC, `${module}.ts`);
      const sf = parse(file, readFileSync(file, 'utf8'));
      for (const name of names) {
        const fn = sf.statements.find(
          (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name,
        );
        expect(fn, `${module}.${name}`).toBeDefined();
        const body = fn!.body!.getText(sf);
        const delegates = names.some(
          (other) => other !== name && new RegExp(`\\b${other}\\(`).test(body),
        );
        expect(/\bkeepAlive\(/.test(body) || delegates, `${module}.${name}`).toBe(true);
      }
    }
  });

  it('server code imports the server reporter (the core is for modules a browser bundle reaches)', () => {
    const coreImporters = sourceFiles(WEB_SRC)
      .filter((f) => {
        const text = readFileSync(f, 'utf8');
        return (
          isServerFile(f, text) &&
          /from '@\/lib\/error-reporter-core'|from '\.\/error-reporter-core'/.test(text)
        );
      })
      .map(rel)
      .sort();
    expect(coreImporters).toEqual(['lib/error-reporter.ts']);
  });

  // The rule itself, on small sources.
  it('flags what is cut off and passes what keeps itself alive', () => {
    expect(
      findingsIn(`
        import { reportError } from '@/lib/error-reporter';
        import { reportError as reportCore } from '@/lib/error-reporter-core';
        import { reportError as reportSrvError } from '@/lib/error-reporter';
        import { dispatchEvent } from './integration-events';
        import { sendEmail } from '@/lib/email/resend';
        void reportError(e, ctx);
        void reportSrvError(e, ctx).catch(() => {});
        void dispatchEvent(org, 'po.updated', {});
        void reportCore(e, ctx);
        void sendEmail({}).catch(() => {});
        void (async () => { await work(); })();
        void admin.from('t').delete().eq('id', 1).then(() => {}, () => {});
        void opts;
        keepAlive(sendEmail({}));
      `),
    ).toEqual([
      'reportCore',
      'sendEmail',
      'async () => { await work(); }',
      "admin.from('t').delete().eq",
    ]);
  });
});
