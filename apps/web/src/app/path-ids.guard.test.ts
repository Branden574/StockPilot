import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * A RECORD ID IN A LINK IS CHECKED BEFORE ANYTHING IS READ WITH IT (B63).
 *
 * WHAT WENT WRONG. An order link whose id had been mistyped or cut short
 * showed "Something broke loading this page" and filed an error report,
 * instead of Page not found. The page handed the id to
 * OrderRequestsService.get, whose `.eq('id', id)` on a uuid column makes
 * PostgREST answer with an error (22P02), not with an empty result; the
 * service turned that into an internal_error and the page re-threw it. 17 of
 * the 34 dynamic pages did the same, 18 of the 103 dynamic API routes
 * answered such an id with a 500 (the item barcode with a 403), and 14 routes
 * checked it with a 36-character pattern that 36 hyphens pass.
 *
 * THE RULE. Every page and route whose path carries a record id checks it
 * before its first use: a page with notFoundUnlessUuid (Page not found), a
 * route with invalidPathIdResponse (400 validation_error) or isUuid, or one of
 * the strict checks some files already had (core's uuidSchema,
 * z.string().uuid(), the strict pattern, invalidReturnId,
 * bookReportItemIdParam). Services stay loud, so an id our own code gets
 * wrong is still reported.
 *
 * HOW IT IS CHECKED. Every page, layout and route under a dynamic segment is
 * parsed (the syntax tree, so comments never count). Each way its handlers
 * read `params` is found: `await params`, `await context.params` and
 * `await Promise.all([params, ...])`, renames included. The FIRST reference
 * to each binding of a record id segment (resolved by symbol, so a shadowing
 * name elsewhere in the file does not count) must be the argument of an
 * accepted check whose answer is used, imported from the module that owns
 * it. A check on a body or query field does not count, and neither does the
 * loose 36-character pattern. Any other way of reading params fails, except
 * the named files below, each pinned to the call that checks the id for it.
 */
const APP = path.resolve(__dirname);
const SRC = path.resolve(APP, '..');

/** Dynamic segments that carry a record id (a uuid). */
const UUID_SEGMENTS = new Set([
  'id',
  'linkId',
  'lineId',
  'evidenceId',
  'attachmentId',
  'scanId',
  'sessionId',
  'groupId',
  'itemId',
  'key',
]);

/** Dynamic segments that do not, and what they carry instead. */
const OTHER_SEGMENTS: Record<string, string> = {
  slug: "a What's New release's or a report's name",
  token: 'a link token (sign, invite, maintenance, public request and return links)',
  provider: "an integration's name",
  n: "a photo's number",
};

/** The strict pattern: 8-4-4-4-12 hex digits, any case, any version. */
const STRICT_UUID_PATTERN = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';

type Kind = 'page' | 'route';

/** Checks called by name: the module each must be imported from (a path
 *  under src, or a package), and the files that may use it. A route never
 *  calls notFoundUnlessUuid: notFound() inside a route's try/catch is a 500
 *  (recurring bug pattern 23). */
const NAMED_CHECKS: Record<string, { from: string; kinds: Kind[] }> = {
  isUuid: { from: '@stockpilot/core', kinds: ['page', 'route'] },
  notFoundUnlessUuid: { from: 'server/lib/path-id', kinds: ['page'] },
  invalidPathIdResponse: { from: 'server/lib/path-id', kinds: ['route'] },
  invalidReturnId: { from: 'app/api/v1/returns/http', kinds: ['route'] },
  bookReportItemIdParam: { from: 'lib/reports/book-order-totals/http', kinds: ['route'] },
};

/**
 * Routes whose first use of the id is a service method that refuses one
 * that is not a uuid itself, before any read: the file -> the call it must
 * stay, and the method (file, name) that checks.
 */
const CHECKED_BY_THE_SERVICE: Record<string, { call: string; service: string; method: string }> = {
  'api/v1/items/[id]/verification/route.ts': {
    call: 'new VerificationService(ctx).item',
    service: 'server/services/verification.ts',
    method: 'item',
  },
  'api/v1/locations/[id]/verification/route.ts': {
    call: 'new VerificationService(ctx).location',
    service: 'server/services/verification.ts',
    method: 'location',
  },
  'api/v1/orders/catalog-visibility/family/[groupId]/route.ts': {
    call: 'new OrderCatalogVisibilityService(ctx).familyMembers',
    service: 'server/services/order-catalog-visibility.ts',
    method: 'familyMembers',
  },
};

/** Routes that hand `params` whole to a gate that reads and checks the id
 *  itself (the file -> the gate). The gate's module is swept like a route. */
const PARAMS_HANDED_TO_A_GATE: Record<string, string> = {
  'api/v1/orders/[id]/return-request/route.ts': 'memberRequesterGate',
  'api/v1/orders/[id]/return-request/options/route.ts': 'memberRequesterGate',
};
const GATE_MODULES = ['api/v1/orders/[id]/return-request/http.ts'];

/** The helpers a check may delegate to: each must check its first
 *  parameter with isUuid or the strict pattern before anything else uses it. */
const DELEGATED_CHECKS: Array<{ file: string; fn: string }> = [
  { file: 'server/lib/path-id.ts', fn: 'notFoundUnlessUuid' },
  { file: 'server/lib/path-id.ts', fn: 'invalidPathIdResponse' },
  { file: 'app/api/v1/returns/http.ts', fn: 'invalidReturnId' },
  { file: 'lib/reports/book-order-totals/http.ts', fn: 'bookReportItemIdParam' },
];

/* ------------------------------ the files ------------------------------ */

const SEGMENT = /^\[{1,2}(?:\.\.\.)?([^\]]+)\]{1,2}$/;

function segmentsOf(relPath: string): string[] {
  return relPath
    .split('/')
    .map((part) => SEGMENT.exec(part)?.[1])
    .filter((s): s is string => s !== undefined);
}

function walk(dir: string, out: { dirs: string[]; files: string[] }) {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) {
      out.dirs.push(abs);
      walk(abs, out);
    } else if (/^(page|layout|template|default)\.tsx$|^route\.tsx?$/.test(name)) {
      out.files.push(abs);
    }
  }
  return out;
}

const relApp = (abs: string) => path.relative(APP, abs).split(path.sep).join('/');
const relSrc = (abs: string) => path.relative(SRC, abs).split(path.sep).join('/');

const tree = walk(APP, { dirs: [], files: [] });
const dynamicFiles = tree.files.filter((f) => segmentsOf(relApp(f)).length > 0).sort();
const kindOf = (abs: string): Kind => (/\/route\.tsx?$/.test(abs) ? 'route' : 'page');

const gateFiles = GATE_MODULES.map((r) => path.join(APP, r));
const delegateFiles = [...new Set(DELEGATED_CHECKS.map((d) => path.join(SRC, d.file)))];
const serviceFiles = [
  ...new Set(Object.values(CHECKED_BY_THE_SERVICE).map((s) => path.join(SRC, s.service))),
];

// One program, no lib and no module resolution: only the binder's symbols
// are needed (which declaration a name refers to), never types.
const program = ts.createProgram({
  rootNames: [...dynamicFiles, ...gateFiles, ...delegateFiles, ...serviceFiles],
  options: { noLib: true, noResolve: true, noEmit: true, jsx: ts.JsxEmit.Preserve, types: [] },
});
const checker = program.getTypeChecker();

function sourceOf(abs: string): ts.SourceFile {
  const sf = program.getSourceFile(abs);
  if (!sf) throw new Error(`not parsed: ${abs}`);
  return sf;
}

/* ------------------------------ symbols ------------------------------ */

function symbolOf(id: ts.Identifier): ts.Symbol | undefined {
  if (ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id) {
    return checker.getShorthandAssignmentValueSymbol(id.parent);
  }
  return checker.getSymbolAtLocation(id);
}

/** A property or member name (`x.id`, `{ id: 1 }`, `<A id />`, a type's
 *  member): never a reference to a variable. */
function isMemberName(id: ts.Identifier): boolean {
  const p = id.parent;
  return (
    (ts.isPropertyAccessExpression(p) && p.name === id) ||
    (ts.isPropertyAssignment(p) && p.name === id) ||
    (ts.isPropertySignature(p) && p.name === id) ||
    (ts.isPropertyDeclaration(p) && p.name === id) ||
    (ts.isMethodDeclaration(p) && p.name === id) ||
    (ts.isQualifiedName(p) && p.right === id) ||
    ts.isJsxAttribute(p) ||
    ts.isTypeReferenceNode(p)
  );
}

const refsCache = new Map<ts.SourceFile, Map<ts.Symbol, ts.Identifier[]>>();

/** Every identifier in the file, by the symbol it refers to, in source order. */
function referencesIn(sf: ts.SourceFile): Map<ts.Symbol, ts.Identifier[]> {
  const cached = refsCache.get(sf);
  if (cached) return cached;
  const map = new Map<ts.Symbol, ts.Identifier[]>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && !isMemberName(node)) {
      const sym = symbolOf(node);
      if (sym) map.set(sym, [...(map.get(sym) ?? []), node]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  refsCache.set(sf, map);
  return map;
}

/** The uses of a declared name (its declaration excluded), in source order. */
function usesOf(name: ts.Identifier): ts.Identifier[] {
  const sym = checker.getSymbolAtLocation(name);
  if (!sym) return [];
  return (referencesIn(name.getSourceFile()).get(sym) ?? [])
    .filter((r) => r !== name)
    .sort((a, b) => a.getStart() - b.getStart());
}

/** Where an imported name comes from: the module as a path under src (or
 *  the package) and the name it is exported under. */
function importOf(id: ts.Identifier): { module: string; name: string } | null {
  const decl = checker.getSymbolAtLocation(id)?.declarations?.[0];
  if (!decl || !ts.isImportSpecifier(decl)) return null;
  const importDecl = decl.parent.parent.parent;
  if (!ts.isStringLiteral(importDecl.moduleSpecifier)) return null;
  const spec = importDecl.moduleSpecifier.text;
  let from = spec;
  if (spec.startsWith('@/')) from = spec.slice(2);
  else if (spec.startsWith('.')) {
    from = relSrc(path.resolve(path.dirname(decl.getSourceFile().fileName), spec));
  }
  return { module: from.replace(/\/index$/, ''), name: (decl.propertyName ?? decl.name).text };
}

/** The initializer of the const a name refers to, when it is one in this file. */
function constValue(id: ts.Identifier): ts.Expression | null {
  const decl = checker.getSymbolAtLocation(id)?.declarations?.[0];
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return null;
  if (decl.getSourceFile() !== id.getSourceFile()) return null;
  if (!ts.isVariableDeclarationList(decl.parent) || !(decl.parent.flags & ts.NodeFlags.Const)) {
    return null;
  }
  return decl.initializer;
}

function isStrictPattern(e: ts.Expression): boolean {
  if (ts.isRegularExpressionLiteral(e)) return e.text === STRICT_UUID_PATTERN;
  if (ts.isIdentifier(e)) {
    const value = constValue(e);
    return !!value && ts.isRegularExpressionLiteral(value) && value.text === STRICT_UUID_PATTERN;
  }
  return false;
}

/** `z.string().uuid()` with z from zod, or a const holding exactly that. */
function isZodUuid(e: ts.Expression): boolean {
  if (ts.isIdentifier(e)) {
    const value = constValue(e);
    return !!value && isZodUuid(value);
  }
  if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression)) return false;
  if (e.expression.name.text !== 'uuid') return false;
  const str = e.expression.expression;
  if (!ts.isCallExpression(str) || str.arguments.length !== 0) return false;
  if (!ts.isPropertyAccessExpression(str.expression) || str.expression.name.text !== 'string') {
    return false;
  }
  const z = str.expression.expression;
  if (!ts.isIdentifier(z)) return false;
  const from = importOf(z);
  return from?.module === 'zod' && from.name === 'z';
}

function isUuidSchema(e: ts.Expression): boolean {
  if (!ts.isIdentifier(e)) return false;
  const from = importOf(e);
  return from?.module === '@stockpilot/core' && from.name === 'uuidSchema';
}

function insideTryBlock(node: ts.Node): boolean {
  for (let n: ts.Node = node; n.parent && !ts.isFunctionLike(n); n = n.parent) {
    if (ts.isTryStatement(n.parent) && n.parent.tryBlock === n) return true;
  }
  return false;
}

/** Why `use` is not an accepted check for a `kind` file, or null when it is. */
function notACheck(use: ts.Identifier, kind: Kind): string | null {
  const call = use.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== use)
    return 'is not the argument of a check';
  const callee = call.expression;
  let named: string | null = null;
  if (ts.isIdentifier(callee)) {
    const from = importOf(callee);
    const check = from ? NAMED_CHECKS[from.name] : undefined;
    if (!from || !check || from.module !== check.from) return 'is not the argument of a check';
    if (!check.kinds.includes(kind))
      return `is checked with ${from.name}, which a ${kind} may not use`;
    named = from.name;
  } else if (ts.isPropertyAccessExpression(callee)) {
    const method = callee.name.text;
    const target = callee.expression;
    const ok =
      (method === 'safeParse' && (isUuidSchema(target) || isZodUuid(target))) ||
      (method === 'test' && isStrictPattern(target));
    if (!ok) {
      return method === 'test'
        ? 'is checked with a pattern that is not the strict uuid pattern'
        : 'is not the argument of a check';
    }
  } else {
    return 'is not the argument of a check';
  }
  if (named === 'notFoundUnlessUuid') {
    if (!ts.isExpressionStatement(call.parent))
      return 'is checked, but notFoundUnlessUuid is not its own statement';
  } else if (ts.isExpressionStatement(call.parent)) {
    return "is checked, but the check's answer is dropped";
  }
  if (kind === 'page' && insideTryBlock(call))
    return 'is checked inside a try block, whose catch can swallow Page not found';
  return null;
}

/* ------------------------------ params reads ------------------------------ */

interface Binding {
  key: string;
  name: ts.Identifier;
}

interface FileReport {
  rel: string;
  kind: Kind;
  bindings: Binding[];
  handedToGate: string[];
  problems: string[];
}

function lineOf(node: ts.Node): number {
  const sf = node.getSourceFile();
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Every expression that reads a handler's params in the file. */
function paramsReads(sf: ts.SourceFile, problems: string[]): ts.Expression[] {
  const reads: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) {
      for (const p of node.parameters) {
        if (ts.isObjectBindingPattern(p.name)) {
          for (const el of p.name.elements) {
            const key = el.propertyName ?? el.name;
            if (!ts.isIdentifier(key) || key.text !== 'params') continue;
            if (!ts.isIdentifier(el.name)) {
              problems.push(`L${lineOf(el)}: params is destructured in the signature`);
            } else {
              reads.push(...usesOf(el.name));
            }
          }
        } else if (ts.isIdentifier(p.name)) {
          for (const use of usesOf(p.name)) {
            if (p.name.text === 'params') reads.push(use);
            else if (
              ts.isPropertyAccessExpression(use.parent) &&
              use.parent.expression === use &&
              use.parent.name.text === 'params'
            ) {
              reads.push(use.parent);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return reads;
}

/** The object pattern a params read is destructured into, or why it is not. */
function patternOf(read: ts.Expression): ts.ObjectBindingPattern | string {
  const parent = read.parent;
  if (ts.isAwaitExpression(parent)) {
    const decl = parent.parent;
    if (ts.isVariableDeclaration(decl) && decl.initializer === parent) {
      return ts.isObjectBindingPattern(decl.name)
        ? decl.name
        : 'is awaited into a name, not destructured';
    }
    return 'is awaited, but not into a declaration';
  }
  // `const [{ id }, ctx] = await Promise.all([params, ...])`
  if (ts.isArrayLiteralExpression(parent)) {
    const call = parent.parent;
    const awaited = call.parent;
    const decl = awaited?.parent;
    if (
      ts.isCallExpression(call) &&
      call.arguments[0] === parent &&
      call.expression.getText() === 'Promise.all' &&
      ts.isAwaitExpression(awaited) &&
      decl &&
      ts.isVariableDeclaration(decl) &&
      ts.isArrayBindingPattern(decl.name)
    ) {
      const el = decl.name.elements[parent.elements.indexOf(read)];
      if (el && ts.isBindingElement(el) && ts.isObjectBindingPattern(el.name)) return el.name;
      return 'is read in Promise.all, but not destructured';
    }
  }
  return 'is read another way';
}

function reportFor(abs: string, kind: Kind): FileReport {
  const sf = sourceOf(abs);
  const rel = relApp(abs);
  const segments = segmentsOf(rel);
  const report: FileReport = { rel, kind, bindings: [], handedToGate: [], problems: [] };
  for (const read of paramsReads(sf, report.problems)) {
    const gate = PARAMS_HANDED_TO_A_GATE[rel];
    if (
      gate &&
      ts.isIdentifier(read) &&
      ts.isCallExpression(read.parent) &&
      read.parent.arguments.includes(read) &&
      ts.isIdentifier(read.parent.expression) &&
      importOf(read.parent.expression)?.name === gate
    ) {
      report.handedToGate.push(`L${lineOf(read)}`);
      continue;
    }
    const pattern = patternOf(read);
    if (typeof pattern === 'string') {
      report.problems.push(`L${lineOf(read)}: params ${pattern}`);
      continue;
    }
    for (const el of pattern.elements) {
      const key = el.propertyName ?? el.name;
      if (el.dotDotDotToken || !ts.isIdentifier(key) || !ts.isIdentifier(el.name)) {
        report.problems.push(`L${lineOf(el)}: params destructured into "${el.getText()}"`);
        continue;
      }
      if (!segments.includes(key.text)) {
        report.problems.push(
          `L${lineOf(el)}: reads "${key.text}", which is not a segment of its path`,
        );
        continue;
      }
      report.bindings.push({ key: key.text, name: el.name });
    }
  }
  for (const b of report.bindings) {
    if (!UUID_SEGMENTS.has(b.key)) continue;
    const first = usesOf(b.name)[0];
    const label = b.name.text === b.key ? b.key : `${b.key} (as ${b.name.text})`;
    if (!first) {
      report.problems.push(`L${lineOf(b.name)}: ${label} is bound but never used`);
      continue;
    }
    const pinned = CHECKED_BY_THE_SERVICE[rel];
    if (pinned) {
      const call = first.parent;
      const callee = ts.isCallExpression(call) ? call.expression.getText().replace(/\s+/g, '') : '';
      if (
        callee !== pinned.call.replace(/\s+/g, '') ||
        !ts.isCallExpression(call) ||
        call.arguments[0] !== first
      ) {
        report.problems.push(
          `L${lineOf(first)}: ${label}'s first use is no longer ${pinned.call}(${b.name.text})`,
        );
      }
      continue;
    }
    const why = notACheck(first, kind);
    if (why)
      report.problems.push(
        `L${lineOf(first)}: ${label} ${why} (first use: ${first.parent.getText().replace(/\s+/g, ' ').slice(0, 80)})`,
      );
  }
  return report;
}

const reports = dynamicFiles.map((f) => reportFor(f, kindOf(f)));
const reportOf = (rel: string) => {
  const r = reports.find((x) => x.rel === rel);
  if (!r) throw new Error(`not swept: ${rel}`);
  return r;
};

/** The first parameter of a function or method declared in a file. */
function firstParameterOf(abs: string, fn: string): ts.Identifier | null {
  let found: ts.Identifier | null = null;
  const visit = (node: ts.Node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === fn &&
      node.body
    ) {
      const p = node.parameters[0];
      if (p && ts.isIdentifier(p.name)) found = p.name;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sourceOf(abs));
  return found;
}

/* ------------------------------ the tests ------------------------------ */

describe('a record id in a link is checked before anything is read with it (B63)', () => {
  it('every dynamic segment is classed as a record id or as something else', () => {
    const names = new Set(
      tree.dirs
        .map((d) => SEGMENT.exec(path.basename(d))?.[1])
        .filter((n): n is string => n !== undefined),
    );
    const unclassed = [...names].filter((n) => !UUID_SEGMENTS.has(n) && !(n in OTHER_SEGMENTS));
    expect(unclassed).toEqual([]);
    // No stale entries: every classed name is a segment somewhere.
    const stale = [...UUID_SEGMENTS, ...Object.keys(OTHER_SEGMENTS)].filter((n) => !names.has(n));
    expect(stale).toEqual([]);
  });

  it('the sweep is not vacuous', () => {
    expect(reports.filter((r) => r.kind === 'page').length).toBeGreaterThanOrEqual(30);
    expect(reports.filter((r) => r.kind === 'route').length).toBeGreaterThanOrEqual(100);
    // The Promise.all form, three handlers in one file, a page with its metadata.
    expect(
      reportOf('(dashboard)/dashboard/orders/[id]/page.tsx').bindings.map((b) => b.key),
    ).toEqual(['id']);
    expect(reportOf('api/v1/orders/[id]/lines/route.ts').bindings.map((b) => b.key)).toEqual([
      'id',
      'id',
      'id',
    ]);
    expect(reportOf('p/items/[id]/page.tsx').bindings.map((b) => b.key)).toEqual(['id', 'id']);
    // A rename, two segments in one read, and a token page whose id is not a uuid.
    expect(
      reportOf('api/v1/po/[id]/receive-line/route.ts').bindings.map((b) => b.name.text),
    ).toEqual(['poId']);
    expect(
      reportOf('api/v1/cycle-counts/[id]/lines/[lineId]/record/route.ts').bindings.map(
        (b) => b.key,
      ),
    ).toEqual(['id', 'lineId']);
    expect(reportOf('orders/sign/[token]/page.tsx').bindings.map((b) => b.key)).toEqual(['token']);
  });

  it('every page and route checks each record id at its first use', () => {
    const problems = reports.flatMap((r) => r.problems.map((p) => `${r.rel} ${p}`));
    expect(problems).toEqual([]);
  });

  it('a gate handed params whole checks the id itself, with the strict pattern', () => {
    for (const [rel, gate] of Object.entries(PARAMS_HANDED_TO_A_GATE)) {
      const r = reportOf(rel);
      expect([rel, r.handedToGate.length > 0, r.bindings.length]).toEqual([rel, true, 0]);
      expect(gate).toBe('memberRequesterGate');
    }
    for (const abs of gateFiles) {
      const r = reportFor(abs, 'route');
      expect([r.rel, r.problems]).toEqual([r.rel, []]);
      expect([r.rel, r.bindings.map((b) => b.key)]).toEqual([r.rel, ['id']]);
      // The gate's check is the strict pattern (not a delegated helper).
      const first = usesOf(r.bindings[0]!.name)[0]!;
      const call = first.parent as ts.CallExpression;
      expect(
        ts.isPropertyAccessExpression(call.expression) &&
          isStrictPattern(call.expression.expression),
      ).toBe(true);
    }
  });

  it('a route that leaves the check to its service: the service refuses the id before any read', () => {
    for (const [rel, pinned] of Object.entries(CHECKED_BY_THE_SERVICE)) {
      expect([rel, reportOf(rel).problems]).toEqual([rel, []]);
      // The method's statements up to its id check hold no await, and the
      // check is `if (!STRICT.test(...)) throw new ServiceError('validation_error', ...)`.
      let method: ts.MethodDeclaration | undefined;
      const visit = (node: ts.Node) => {
        if (ts.isMethodDeclaration(node) && node.name.getText() === pinned.method) method = node;
        else ts.forEachChild(node, visit);
      };
      visit(sourceOf(path.join(SRC, pinned.service)));
      expect([rel, method !== undefined]).toEqual([rel, true]);
      let checked = false;
      for (const st of method!.body!.statements) {
        const hasAwait = (n: ts.Node): boolean =>
          ts.isAwaitExpression(n) || !!ts.forEachChild(n, hasAwait);
        if (
          ts.isIfStatement(st) &&
          ts.isPrefixUnaryExpression(st.expression) &&
          st.expression.operator === ts.SyntaxKind.ExclamationToken &&
          ts.isCallExpression(st.expression.operand) &&
          ts.isPropertyAccessExpression(st.expression.operand.expression) &&
          st.expression.operand.expression.name.text === 'test' &&
          isStrictPattern(st.expression.operand.expression.expression) &&
          /throw new ServiceError\('validation_error'/.test(st.thenStatement.getText())
        ) {
          checked = true;
          break;
        }
        expect([rel, st.getText().slice(0, 60), hasAwait(st)]).toEqual([
          rel,
          st.getText().slice(0, 60),
          false,
        ]);
      }
      expect([rel, pinned.method, checked]).toEqual([rel, pinned.method, true]);
    }
  });

  it('each helper a check delegates to checks its parameter first, with isUuid or the strict pattern', () => {
    for (const { file, fn } of DELEGATED_CHECKS) {
      const param = firstParameterOf(path.join(SRC, file), fn);
      expect([file, fn, param !== null]).toEqual([file, fn, true]);
      const first = usesOf(param!)[0];
      const call = first?.parent;
      const ok =
        !!first &&
        !!call &&
        ts.isCallExpression(call) &&
        call.arguments[0] === first &&
        ((ts.isIdentifier(call.expression) &&
          importOf(call.expression)?.module === '@stockpilot/core' &&
          importOf(call.expression)?.name === 'isUuid') ||
          (ts.isPropertyAccessExpression(call.expression) &&
            call.expression.name.text === 'test' &&
            isStrictPattern(call.expression.expression)));
      expect([file, fn, ok]).toEqual([file, fn, true]);
    }
  });

  it('no route calls notFoundUnlessUuid (notFound in a route is a 500, bug pattern 23)', () => {
    const routes = tree.files.filter((f) => kindOf(f) === 'route');
    const offenders = routes
      .filter((f) => /\bnotFoundUnlessUuid\b/.test(readFileSync(f, 'utf8')))
      .map(relApp);
    expect(offenders).toEqual([]);
  });

  it('every re-exported handler comes from a file the sweep checks', () => {
    const swept = new Set(dynamicFiles);
    const missing: string[] = [];
    for (const abs of dynamicFiles) {
      for (const st of sourceOf(abs).statements) {
        if (
          !ts.isExportDeclaration(st) ||
          !st.moduleSpecifier ||
          !ts.isStringLiteral(st.moduleSpecifier)
        )
          continue;
        const target = path.resolve(path.dirname(abs), st.moduleSpecifier.text);
        const file = ['.ts', '.tsx'].map((ext) => target + ext).find((f) => swept.has(f));
        if (!file) missing.push(`${relApp(abs)} -> ${st.moduleSpecifier.text}`);
      }
    }
    expect(missing).toEqual([]);
    // The one re-export today (the phone's signature alias).
    expect(
      dynamicFiles
        .filter((abs) =>
          sourceOf(abs).statements.some((st) => ts.isExportDeclaration(st) && !!st.moduleSpecifier),
        )
        .map(relApp),
    ).toEqual(['api/v1/orders/[id]/signature/route.ts']);
  });
});
