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
 * THE RULE. In every module that can run on the server, `void` may only be
 * put in front of a call to a function that keeps its own work alive (it
 * hands it to keepAlive, lib/defer.ts, and returns the same promise), named in
 * KEEPS_ITSELF_ALIVE and imported from its own module (an alias is followed,
 * so the isomorphic core reporter, which keeps nothing alive, does not pass
 * for the server one). Anything else is handed to keepAlive(...) where it
 * starts, deferred with defer(...), awaited, or listed in REVIEWED with why
 * nothing needs to outlive the response. Each KEEPS_ITSELF_ALIVE function is
 * checked to call keepAlive itself, so the list cannot outlive the fact.
 *
 * WHAT IS SCANNED. All of src except client components ('use client'), the
 * BROWSER_ONLY modules and test helpers: Server Component pages, layouts and
 * their generateMetadata, route handlers, Server Actions, services and lib
 * modules, with or without the 'server-only' marker. The scan first covered
 * only src/server, src/app/api, route files, 'use server' files and
 * 'server-only' modules, which left out every Server Component page and
 * server modules without the marker (lib/supabase/admin.ts, lib/books/
 * lookup.ts and more). Each BROWSER_ONLY module is checked to be imported only
 * from client code, so a server import of one fails the guard.
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
  'lib/supabase/url-length-guard.ts: report':
    "the guard's injected reporter: the server clients pass the server reportError, which keeps itself alive (url-length-guard.server.ts, pinned in url-length-guard.wiring.test.ts); the browser client passes the core one, with no response to outlive",
};

/**
 * Modules with no 'use client' directive of their own that run only in the
 * browser (path under src -> why). They are not scanned. Each is imported only
 * by client components and other modules listed here, which the tests check,
 * so a server import of one fails the guard instead of running its `void`
 * calls on the server unscanned.
 */
const BROWSER_ONLY: Record<string, string> = {
  'components/marketing/landing/film.ts':
    "the landing page's film, drawn on a canvas by cinema.tsx",
  'lib/analytics.ts': 'the PostHog wrapper: posthog-js runs in the browser',
  'lib/notifications/live-toast.ts':
    "the bell's desktop notifications and sound (Notification, AudioContext, Web Locks)",
  'lib/perf/rum.ts': 'real-user performance events, sent through lib/analytics.ts',
  'lib/updates/update-store.ts': "the update center's What's New store",
  'lib/use-catalog-thumbnails.ts': 'a React hook whose requests start in effects',
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

/** Test helpers and mocks under src (src/test, __mocks__): they never ship. */
function isTestHelper(r: string): boolean {
  return r.startsWith('test/') || r.split('/').includes('__mocks__');
}

/** Every module that can run on the server (see WHAT IS SCANNED). */
function isScanned(file: string, text: string): boolean {
  const r = rel(file);
  return !directive(text, 'use client') && !(r in BROWSER_ONLY) && !isTestHelper(r);
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

interface Source {
  file: string;
  text: string;
  sf?: ts.SourceFile;
}

const sourceFileOf = (src: Source): ts.SourceFile => (src.sf ??= parse(src.file, src.text));

/** The source tree, read and parsed once for every test. */
let tree: Source[] | null = null;
function treeSources(): Source[] {
  tree ??= sourceFiles(WEB_SRC).map((file) => ({ file, text: readFileSync(file, 'utf8') }));
  return tree;
}

/** Abs path of a file under src, for sources built in a test. */
const abs = (r: string) => path.join(WEB_SRC, r);

function scan(sources: Source[] = treeSources()): Finding[] {
  const findings: Finding[] = [];
  for (const src of sources) {
    const { file, text } = src;
    if (!isScanned(file, text)) continue;
    const sf = sourceFileOf(src);
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

/** Every module a file imports or re-exports at runtime (type-only imports run nothing). */
function specifiersOf(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.importClause?.isTypeOnly) out.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (!node.isTypeOnly) out.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      out.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** `importer imports module` for every BROWSER_ONLY module imported from code that can run on the server. */
function serverImportsOfBrowserModules(sources: Source[] = treeSources()): string[] {
  const browser = new Map(
    Object.keys(BROWSER_ONLY).map((f) => [f.replace(/\.(ts|tsx)$/, ''), f] as const),
  );
  const out: string[] = [];
  for (const src of sources) {
    const r = rel(src.file);
    if (r in BROWSER_ONLY || isTestHelper(r) || directive(src.text, 'use client')) continue;
    for (const spec of specifiersOf(sourceFileOf(src))) {
      const target = browser.get(moduleOf(src.file, spec) ?? '');
      if (target) out.push(`${r} imports ${target}`);
    }
  }
  return out;
}

/**
 * `importer imports lib/error-reporter` for every client module (a 'use
 * client' component or a BROWSER_ONLY module) that imports the server
 * reporter. That reporter is server-only (it imports 'server-only' and
 * keepAlive's after()), so a browser bundle that reaches it fails the build.
 */
function clientImportsOfServerReporter(sources: Source[] = treeSources()): string[] {
  const out: string[] = [];
  for (const src of sources) {
    const r = rel(src.file);
    if (isTestHelper(r) || !(r in BROWSER_ONLY || directive(src.text, 'use client'))) continue;
    for (const spec of specifiersOf(sourceFileOf(src))) {
      if (moduleOf(src.file, spec) === 'lib/error-reporter') {
        out.push(`${r} imports lib/error-reporter`);
      }
    }
  }
  return out;
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
    const scanned = treeSources()
      .filter((s) => isScanned(s.file, s.text))
      .map((s) => rel(s.file));
    expect(scanned.length).toBeGreaterThan(900);
    for (const file of [
      'server/services/purchase-orders.ts',
      'lib/export-rate-limit.ts',
      // Server Component pages and layouts, and server modules without the
      // 'server-only' marker: the first scan skipped all of these.
      'app/(dashboard)/layout.tsx',
      'app/(dashboard)/dashboard/orders/[id]/page.tsx',
      'app/r/[token]/page.tsx',
      'lib/books/lookup.ts',
      'lib/supabase/admin.ts',
      'lib/verification/error-response.ts',
      'proxy.ts',
    ]) {
      expect(scanned, file).toContain(file);
    }
    // Never a client component, a browser-only module or a test helper.
    expect(scanned).not.toContain('components/marketing/landing/cinema.tsx');
    expect(scanned).not.toContain('lib/analytics.ts');
    expect(scanned).not.toContain('test/setup.ts');
  });

  // Mutation caught: a scan that reads only src/server, src/app/api, route
  // files and marked modules, which passed a `void` in any page.
  it('flags a `void` call in a Server Component page or a server module without the marker', () => {
    const page = [
      "import { sendEmail } from '@/lib/email/resend';",
      'export default async function Page() {',
      '  void sendEmail({});',
      '  return null;',
      '}',
    ].join('\n');
    const found = scan([
      { file: abs('app/(dashboard)/dashboard/example/page.tsx'), text: page },
      { file: abs('app/(dashboard)/dashboard/example/layout.tsx'), text: page },
      { file: abs('lib/example/lookup.ts'), text: "export function go() { void fetch('/x'); }" },
      // Not server code:
      { file: abs('components/example/panel.tsx'), text: `'use client';\n${page}` },
      { file: abs('lib/analytics.ts'), text: page },
      { file: abs('test/example-helper.ts'), text: page },
    ]).map((f) => `${f.where}  void ${f.callee}(...)`);
    expect(found).toEqual([
      'app/(dashboard)/dashboard/example/page.tsx:3  void sendEmail(...)',
      'app/(dashboard)/dashboard/example/layout.tsx:3  void sendEmail(...)',
      'lib/example/lookup.ts:1  void fetch(...)',
    ]);
  });

  it('every BROWSER_ONLY module is imported only from client code (a server import would run its `void` calls unscanned)', () => {
    expect(serverImportsOfBrowserModules()).toEqual([]);
    for (const file of Object.keys(BROWSER_ONLY)) {
      const text = readFileSync(abs(file), 'utf8');
      // A module that gained 'use client' needs no entry.
      expect(directive(text, 'use client'), file).toBe(false);
    }
  });

  // The importer check itself, on small sources.
  it('the importer check names a server import, and passes client code and type-only imports', () => {
    expect(
      serverImportsOfBrowserModules([
        { file: abs('app/example/page.tsx'), text: "import { capture } from '@/lib/analytics';" },
        {
          file: abs('server/services/example.ts'),
          text: "const m = await import('@/lib/perf/rum');",
        },
        { file: abs('lib/example/re-export.ts'), text: "export { capture } from '../analytics';" },
        {
          file: abs('components/example/a.tsx'),
          text: "'use client';\nimport { capture } from '@/lib/analytics';",
        },
        {
          file: abs('lib/example/types.ts'),
          text: "import type { Release } from '@/lib/updates/update-store';",
        },
        { file: abs('lib/perf/rum.ts'), text: "import { capture } from '../analytics';" },
      ]),
    ).toEqual([
      'app/example/page.tsx imports lib/analytics.ts',
      'server/services/example.ts imports lib/perf/rum.ts',
      'lib/example/re-export.ts imports lib/analytics.ts',
    ]);
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
    const coreImporters = treeSources()
      .filter(
        (s) =>
          isScanned(s.file, s.text) &&
          /from '@\/lib\/error-reporter-core'|from '\.\/error-reporter-core'/.test(s.text),
      )
      .map((s) => rel(s.file))
      .sort();
    // error-reporter.ts wraps the core. url-length-guard.ts is isomorphic: its
    // browser instance reports through the core, and the server clients use
    // url-length-guard.server.ts, which passes the server reporter.
    expect(coreImporters).toEqual(['lib/error-reporter.ts', 'lib/supabase/url-length-guard.ts']);
  });

  // The other half. Caught at the merge with main at 0132fbd25: the settings
  // error boundary main added (#391), a client component, imported the server
  // reporter, so its browser bundle reached 'server-only' and the build
  // failed ("'server-only' cannot be imported from a Client Component
  // module"). Only the build saw it; no unit test did.
  it('client code imports the core reporter (the server one is server-only, and a browser bundle that reaches it fails the build)', () => {
    expect(clientImportsOfServerReporter()).toEqual([]);
    // Not vacuous: the client modules that report errors are read, through the core.
    const coreClients = treeSources()
      .filter(
        (s) => directive(s.text, 'use client') && /from '@\/lib\/error-reporter-core'/.test(s.text),
      )
      .map((s) => rel(s.file));
    for (const file of [
      'app/(dashboard)/error.tsx',
      'app/(dashboard)/dashboard/settings/error.tsx',
      'components/maintenance/maintenance-email-action.tsx',
      'components/orders/storefront/delivery-request-action.tsx',
    ]) {
      expect(coreClients, file).toContain(file);
    }
  });

  // The client check itself, on small sources.
  it('the client check names a client import of the server reporter, and passes the core, type-only imports and server code', () => {
    expect(
      clientImportsOfServerReporter([
        {
          file: abs('app/example/error.tsx'),
          text: "'use client';\nimport { reportError } from '@/lib/error-reporter';",
        },
        {
          file: abs('components/example/panel.tsx'),
          text: "'use client';\nimport { reportError } from '../../lib/error-reporter';",
        },
        { file: abs('lib/analytics.ts'), text: "import { reportError } from './error-reporter';" },
        {
          file: abs('components/example/core.tsx'),
          text: "'use client';\nimport { reportError } from '@/lib/error-reporter-core';",
        },
        {
          file: abs('components/example/types.tsx'),
          text: "'use client';\nimport type { ErrorContext } from '@/lib/error-reporter';",
        },
        {
          file: abs('server/services/example.ts'),
          text: "import { reportError } from '@/lib/error-reporter';",
        },
      ]),
    ).toEqual([
      'app/example/error.tsx imports lib/error-reporter',
      'components/example/panel.tsx imports lib/error-reporter',
      'lib/analytics.ts imports lib/error-reporter',
    ]);
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
