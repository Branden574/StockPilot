import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Security invariant (docket S16): no API route answers an error's own text.
 *
 * A route's last catch used to answer anything that was not a ServiceError
 * with `e instanceof Error ? e.message : ...`, and a few branches answered a
 * Supabase or Storage `error.message` without a catch. The caller then read
 * whatever the error said: a TypeError naming the server's property paths,
 * Postgres text naming tables, columns and row-level security policies, a
 * Storage error naming the bucket, an AI vendor's quota or billing text, a
 * failed request's URL with its token. Many of those branches reported
 * nothing, so the answer was the only copy of the error. They now answer
 * through server/lib/api-error-response.ts: a fixed sentence to the caller,
 * the error itself to reportError with the route's tag.
 *
 * WHAT IS READ. Every module under app/api, every response helper (http.ts,
 * *-http.ts, *error-response.ts, export-errors.ts) anywhere in src, and every
 * module an API route imports directly (`@/...` or a relative path, by
 * import, export-from or import()): a helper builds text a route answers as
 * it is (the AI ISBN extract's `notes` did, S16 review). Not the service
 * layer (server/services) nor Server Actions (server/actions): a service
 * answers through ServiceError, whose internal_error message is generic
 * (S13), and Server Actions are the B12 sweep's.
 *
 * WHAT COUNTS, from the TypeScript syntax tree (so comments and strings are
 * never code): an error's own text, wherever it is spelled
 *
 *   e.message, err?.stack, (e as Error).message, (e as any).message, e['message']
 *   String(e), e.toString(), JSON.stringify(e), `${e}`, 'failed: ' + e
 *   const { message } = e as Error
 *   NextResponse.json({ error }), { detail: err }, { ...err }   (a whole error in an answer)
 *
 * where an error is a catch clause's binding or a rejection handler's
 * parameter (whatever its name), or a name such as e, err, error, uploadErr,
 * pgError (also as a property: res.error.message). The text is followed
 * through what keeps it text: casts, string methods, `??`, `||`, `+`, a
 * branch of `?:`, a template.
 *
 * WHAT DOES NOT COUNT: text that goes only to the server, or becomes a yes or
 * no. Inside `new Error(...)` (it is only thrown or reported, and every catch
 * that answers is held to these same rules), `new ServiceError('internal_error',
 * ...)` (S13 keeps that text server side), `reportError(...)` and
 * `console.*(...)`; tested with `.includes()`, `.startsWith()`, a RegExp's
 * `.test()`, `===`, `.length`, `!` or `typeof`; read after `instanceof
 * ServiceError` or `instanceof ForbiddenError` (the app wrote those words); or
 * held in a const (or a destructured name) whose every use is one of these.
 *
 * Every remaining line is listed below with why it is safe, so a new one
 * fails here until someone reasons about it.
 */

const SRC = path.resolve(__dirname, '../..');
const API = path.join(SRC, 'app/api');

/** Response helpers outside app/api answer API callers too. */
const RESPONSE_HELPER = /^(?:.+-)?http\.ts$|^(?:.+-)?error-response\.ts$|^export-errors\.ts$/;

/** Imported by routes, but not read: see WHAT IS READ above. */
const NOT_READ = /^server\/(?:services|actions)\//;

/**
 * Files allowed to keep the shapes, with the number of lines and the reason.
 * Each line was read: none of them reaches an API caller.
 */
const ALLOWED: Record<string, { lines: number; why: string }> = {
  'app/api/admin/backfill-item-thumbs/route.ts': {
    lines: 3,
    why: "per-row results for the BACKFILL_ADMIN_SECRET holder, who needs them to diagnose a row (kept by the owner's default, S16 decision 2); the route's own failures answer through the helper",
  },
  'app/api/v1/mobile/snapshot/route.ts': {
    lines: 1,
    why: "the items read's failure, which goes to dbError: it reports the text and answers only the query's name",
  },
  'lib/ai/chat.ts': {
    lines: 1,
    why: "classifyToolErrorMessage: what a failed AI tool call tells the model (not an API answer): a fixed sentence, except a validation message (a ServiceError or the tool's own argument check), passed on at most 200 characters",
  },
  'lib/email/resend.ts': {
    lines: 1,
    why: "sendEmail's result for its caller: the API routes and the helpers they import count it or report it, never answer it",
  },
  'server/connectors/drainer.ts': {
    lines: 1,
    why: "a connector call's failure, stored in the sync log's last_error for the organization's integration status; the drain cron answers counts only",
  },
  'server/connectors/quickbooks/index.ts': {
    lines: 3,
    why: "the QuickBooks call's failure for the drainer, which stores it as last_error (above)",
  },
  'server/lib/account-deletion.ts': {
    lines: 4,
    why: 'readAuthEmail and soleOwnedOrganizationsWithMembers hand a failed read to the delete route, which reports it and answers ACCOUNT_DELETE_RETRY_COPY',
  },
  'server/loaders/inventory-list.ts': {
    lines: 2,
    why: "prewarmInventoryList's per-view failure, in the prewarm cron's results: answered only to the CRON_SECRET or BACKFILL_ADMIN_SECRET holder, and the deploy hook does not print the body",
  },
  'server/loaders/orders-new-catalog.ts': {
    lines: 1,
    why: "prewarmOrdersNewCatalog's photo map failure, in the prewarm cron's results (see inventory-list.ts above)",
  },
  'server/loaders/orders-phone-catalog.ts': {
    lines: 1,
    why: "prewarmPhoneThumbMap's failure, in the prewarm cron's results (see inventory-list.ts above)",
  },
};

interface Hit {
  line: number;
  text: string;
}

// ── What is read ─────────────────────────────────────────────────────────

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')
      ? [full]
      : [];
  });
}

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** The source file an `@/...` or relative specifier in `from` names, or null (a package). */
function moduleFile(specifier: string, from: string): string | null {
  const base = specifier.startsWith('@/')
    ? path.join(SRC, specifier.slice(2))
    : specifier.startsWith('.')
      ? path.resolve(path.dirname(from), specifier)
      : null;
  if (base === null) return null;
  const candidates = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  if (/\.tsx?$/.test(base)) candidates.unshift(base);
  return (
    candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
  );
}

/** The source modules a file imports: import and export-from, and import(). */
function importsOf(file: string): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file, readFileSync(file, 'utf8')));
  return out.flatMap((specifier) => moduleFile(specifier, file) ?? []);
}

/** Every module the census reads (see WHAT IS READ). */
function scope(): string[] {
  const api = files(API);
  const helpers = files(SRC).filter(
    (file) => !file.startsWith(API + path.sep) && RESPONSE_HELPER.test(path.basename(file)),
  );
  const imported = api
    .flatMap(importsOf)
    .filter(
      (file) =>
        file.startsWith(SRC + path.sep) &&
        !file.startsWith(API + path.sep) &&
        !/\.test\.tsx?$/.test(file) &&
        !NOT_READ.test(path.relative(SRC, file)),
    );
  return [...new Set([...api, ...helpers, ...imported])];
}

// ── What holds an error ──────────────────────────────────────────────────

const ERROR_NAME = /^(?:e|err|error|ex)$|(?:Err|Error|err|error)$/;
const TEXT_PROPERTIES = new Set(['message', 'stack']);
/** Classes whose message the app wrote (ServiceError: generic for internal_error, S13). */
const APP_ERRORS = new Set(['ServiceError', 'ForbiddenError']);
const BUILTIN_ERRORS = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError']);
/** String methods whose result is still the text. */
const TEXT_METHODS = new Set([
  'toLowerCase',
  'toUpperCase',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'trim',
  'trimStart',
  'trimEnd',
  'slice',
  'substring',
  'substr',
  'replace',
  'replaceAll',
  'normalize',
  'padStart',
  'padEnd',
  'concat',
  'at',
  'charAt',
]);
/** String methods whose result is a yes or no, or a position. */
const TEST_METHODS = new Set([
  'includes',
  'startsWith',
  'endsWith',
  'indexOf',
  'lastIndexOf',
  'search',
  'localeCompare',
]);
const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
/** `a ?? b`, `a || b`, `a && b`, `a + b`: the result can be (or hold) either side's text. */
const TEXT_OPERATORS = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.PlusToken,
]);

function isWrapper(
  node: ts.Node,
): node is
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.NonNullExpression
  | ts.TypeAssertion
  | ts.SatisfiesExpression {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
  );
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (isWrapper(current)) current = current.expression;
  return current;
}

function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function binds(name: ts.BindingName | undefined, text: string): boolean {
  if (!name) return false;
  if (ts.isIdentifier(name)) return name.text === text;
  return name.elements.some((el) => !ts.isOmittedExpression(el) && binds(el.name, text));
}

/** A function handed to `.catch(fn)` or as `.then(_, fn)`: its parameter is the rejection. */
function isRejectionHandler(fn: ts.Node): boolean {
  const call = fn.parent;
  if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) {
    return false;
  }
  const method = call.expression.name.text;
  return (
    (method === 'catch' && call.arguments[0] === fn) ||
    (method === 'then' && call.arguments[1] === fn)
  );
}

/** Whether the nearest declaration of `id` binds a thrown or rejected value. */
function bindsAThrow(id: ts.Identifier): boolean {
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
    if (ts.isCatchClause(n) && binds(n.variableDeclaration?.name, id.text)) return true;
    if (isFunction(n) && n.parameters.some((p) => binds(p.name, id.text))) {
      return isRejectionHandler(n);
    }
    if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)) {
      const declares = n.statements.some(
        (st) =>
          (ts.isVariableStatement(st) &&
            st.declarationList.declarations.some((d) => binds(d.name, id.text))) ||
          (ts.isFunctionDeclaration(st) && st.name?.text === id.text),
      );
      if (declares) return false;
    }
  }
  return false;
}

/** Whether `node` holds an error (see the header). */
function isError(node: ts.Expression): boolean {
  const x = unwrap(node);
  if (ts.isIdentifier(x)) return bindsAThrow(x) || ERROR_NAME.test(x.text);
  if (ts.isPropertyAccessExpression(x)) return ERROR_NAME.test(x.name.text) && x.name.text !== 'e';
  return false;
}

function nameOf(node: ts.Expression): string | null {
  const x = unwrap(node);
  return ts.isIdentifier(x) ? x.text : null;
}

// ── Where the text goes ──────────────────────────────────────────────────

/** `cond` proves `name` is an app error: `name instanceof ServiceError`, also inside && / ||. */
function provesAppError(cond: ts.Expression, name: string): boolean {
  const c = unwrap(cond);
  if (!ts.isBinaryExpression(c)) return false;
  switch (c.operatorToken.kind) {
    case ts.SyntaxKind.InstanceOfKeyword:
      return nameOf(c.left) === name && ts.isIdentifier(c.right) && APP_ERRORS.has(c.right.text);
    case ts.SyntaxKind.AmpersandAmpersandToken:
      return provesAppError(c.left, name) || provesAppError(c.right, name);
    case ts.SyntaxKind.BarBarToken:
      return provesAppError(c.left, name) && provesAppError(c.right, name);
    default:
      return false;
  }
}

/** The read sits where `name` was proved an app error (if, ?:, &&). */
function narrowedToAppError(read: ts.Node, name: string | null): boolean {
  if (!name) return false;
  let child: ts.Node = read;
  for (let n = read.parent; n && !isFunction(n); child = n, n = n.parent) {
    if (ts.isIfStatement(n) && child === n.thenStatement && provesAppError(n.expression, name)) {
      return true;
    }
    if (
      ts.isConditionalExpression(n) &&
      child === n.whenTrue &&
      provesAppError(n.condition, name)
    ) {
      return true;
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      child === n.right &&
      provesAppError(n.left, name)
    ) {
      return true;
    }
  }
  return false;
}

/** From a text value up through what keeps it text. */
function textOf(node: ts.Node): ts.Node {
  let current = node;
  for (;;) {
    const p = current.parent;
    if (!p) return current;
    if (isWrapper(p)) current = p;
    else if (
      ts.isPropertyAccessExpression(p) &&
      p.expression === current &&
      TEXT_METHODS.has(p.name.text) &&
      ts.isCallExpression(p.parent) &&
      p.parent.expression === p
    ) {
      current = p.parent;
    } else if (ts.isBinaryExpression(p) && TEXT_OPERATORS.has(p.operatorToken.kind)) current = p;
    else if (ts.isConditionalExpression(p) && p.condition !== current) current = p;
    else if (ts.isTemplateSpan(p) && p.expression === current) current = p.parent;
    else return current;
  }
}

/** A call that keeps its arguments on the server. */
function isServerSink(call: ts.Node, arg: ts.Node): boolean {
  if (ts.isNewExpression(call) && call.arguments?.includes(arg as ts.Expression)) {
    if (!ts.isIdentifier(call.expression)) return false;
    if (BUILTIN_ERRORS.has(call.expression.text)) return true;
    const first = call.arguments[0];
    return (
      call.expression.text === 'ServiceError' &&
      first !== undefined &&
      first !== arg &&
      ts.isStringLiteralLike(first) &&
      first.text === 'internal_error'
    );
  }
  if (ts.isCallExpression(call) && call.arguments.includes(arg as ts.Expression)) {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) return callee.text === 'reportError';
    return (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'console'
    );
  }
  return false;
}

/** Whether the text read at `read` goes only to the server, or becomes a yes or no. */
function staysOnServer(read: ts.Node, depth = 0): boolean {
  const node = textOf(read);
  const p = node.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.expression === node) {
    if (p.name.text === 'length') return true;
    if (TEST_METHODS.has(p.name.text) && ts.isCallExpression(p.parent)) return true;
  }
  if (
    ts.isCallExpression(p) &&
    p.arguments.includes(node as ts.Expression) &&
    ts.isPropertyAccessExpression(p.expression) &&
    p.expression.name.text === 'test'
  ) {
    return true;
  }
  if (ts.isBinaryExpression(p) && COMPARISONS.has(p.operatorToken.kind)) return true;
  if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return true;
  if (ts.isTypeOfExpression(p)) return true;
  if ((ts.isIfStatement(p) || ts.isWhileStatement(p)) && p.expression === node) return true;
  if (ts.isConditionalExpression(p) && p.condition === node) return true;
  let arg: ts.Node = node;
  for (
    let n: ts.Node | undefined = p;
    n && !isFunction(n) && !ts.isBlock(n);
    arg = n, n = n.parent
  ) {
    if (isServerSink(n, arg)) return true;
  }
  // A const that holds the text, or a name destructured from an error.
  if (depth < 4) {
    if (
      ts.isVariableDeclaration(p) &&
      p.initializer === node &&
      ts.isIdentifier(p.name) &&
      (ts.getCombinedNodeFlags(p) & ts.NodeFlags.Const) !== 0
    ) {
      return everyUseStaysOnServer(p.name, depth);
    }
    if (ts.isBindingElement(read) && ts.isIdentifier(read.name)) {
      return everyUseStaysOnServer(read.name, depth);
    }
  }
  return false;
}

function everyUseStaysOnServer(name: ts.Identifier, depth: number): boolean {
  let scopeNode: ts.Node = name.parent;
  while (!ts.isBlock(scopeNode) && !ts.isSourceFile(scopeNode) && !isFunction(scopeNode)) {
    scopeNode = scopeNode.parent;
  }
  const uses: ts.Identifier[] = [];
  const visit = (n: ts.Node) => {
    // A type (`{ message?: unknown }`) names a property, never the value.
    if (ts.isTypeNode(n)) return;
    if (ts.isIdentifier(n) && n.text === name.text && n !== name) {
      const p = n.parent;
      const isKey =
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isPropertyAssignment(p) && p.name === n) ||
        (ts.isBindingElement(p) && p.propertyName === n) ||
        (ts.isJsxAttribute(p) && p.name === n);
      if (!isKey) uses.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(scopeNode);
  return uses.every(
    (use) => !ts.isShorthandPropertyAssignment(use.parent) && staysOnServer(use, depth + 1),
  );
}

/** An object literal that is (inside) the body of `NextResponse.json(...)` or `Response.json(...)`. */
function isJsonAnswer(literal: ts.Node): boolean {
  let child = literal;
  let n = literal.parent;
  while (
    n &&
    (ts.isObjectLiteralExpression(n) ||
      ts.isArrayLiteralExpression(n) ||
      ts.isPropertyAssignment(n) ||
      ts.isShorthandPropertyAssignment(n) ||
      ts.isSpreadAssignment(n) ||
      isWrapper(n))
  ) {
    child = n;
    n = n.parent;
  }
  if (!n || !ts.isCallExpression(n) || n.arguments[0] !== child) return false;
  const callee = n.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'json' &&
    ts.isIdentifier(callee.expression) &&
    (callee.expression.text === 'NextResponse' || callee.expression.text === 'Response')
  );
}

// ── The census ───────────────────────────────────────────────────────────

/** The lines of `source` that answer, or may answer, an error's own text. */
function hitsIn(fileName: string, source: string): Hit[] {
  const sf = parse(fileName, source);
  const lines = new Set<number>();
  const hit = (node: ts.Node) =>
    lines.add(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
  const text = (node: ts.Node, error: ts.Expression) => {
    if (!narrowedToAppError(node, nameOf(error)) && !staysOnServer(node)) hit(node);
  };
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node)) {
      if (TEXT_PROPERTIES.has(node.name.text) && isError(node.expression))
        text(node, node.expression);
      if (
        node.name.text === 'toString' &&
        isError(node.expression) &&
        ts.isCallExpression(node.parent)
      ) {
        text(node.parent, node.expression);
      }
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      TEXT_PROPERTIES.has(node.argumentExpression.text) &&
      isError(node.expression)
    ) {
      text(node, node.expression);
    } else if (ts.isCallExpression(node) && node.arguments[0] && isError(node.arguments[0])) {
      const callee = node.expression;
      const isString = ts.isIdentifier(callee) && callee.text === 'String';
      const isStringify =
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'stringify' &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'JSON';
      if (isString || isStringify) text(node, node.arguments[0]);
    } else if (ts.isTemplateSpan(node) && isError(node.expression)) {
      text(node.expression, node.expression);
    } else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.PlusToken ||
        node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
    ) {
      for (const side of [node.left, node.right]) if (isError(side)) text(side, side);
    } else if (
      (ts.isShorthandPropertyAssignment(node) && isError(node.name)) ||
      (ts.isPropertyAssignment(node) &&
        ts.isIdentifier(unwrap(node.initializer)) &&
        isError(node.initializer)) ||
      (ts.isSpreadAssignment(node) && isError(node.expression))
    ) {
      if (isJsonAnswer(node.parent)) hit(node);
    } else if (ts.isObjectBindingPattern(node)) {
      const owner = node.parent;
      const fromError =
        (ts.isVariableDeclaration(owner) &&
          ((owner.initializer !== undefined && isError(owner.initializer)) ||
            ts.isCatchClause(owner.parent))) ||
        (ts.isParameter(owner) && isRejectionHandler(owner.parent));
      if (fromError) {
        for (const el of node.elements) {
          const key = el.propertyName ?? el.name;
          if (ts.isIdentifier(key) && TEXT_PROPERTIES.has(key.text) && !staysOnServer(el)) hit(el);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const sourceLines = source.split('\n');
  return [...lines]
    .sort((a, b) => a - b)
    .map((line) => ({ line, text: (sourceLines[line - 1] ?? '').trim() }));
}

function census(): Map<string, Hit[]> {
  const found = new Map<string, Hit[]>();
  for (const file of scope()) {
    const hits = hitsIn(file, readFileSync(file, 'utf8'));
    if (hits.length > 0) found.set(path.relative(SRC, file), hits);
  }
  return found;
}

/** `body` as the catch of a route, one statement per line from line 2. */
function inCatch(body: string[]): string {
  return ['export async function POST() { try { await work(); } catch (e) {', ...body, '} }'].join(
    '\n',
  );
}

describe("API routes never answer an error's own text", () => {
  it("no API route answers an error's own text: every remaining line is listed, as often as listed", () => {
    const found = census();
    // Every line of a file whose count is off, so a failure says where to look.
    const off = [...found]
      .filter(([file, hits]) => hits.length !== (ALLOWED[file]?.lines ?? 0))
      .flatMap(([file, hits]) => hits.map((hit) => `${file}:${hit.line}: ${hit.text}`));
    expect(off).toEqual([]);
    expect(Object.fromEntries([...found].map(([file, hits]) => [file, hits.length]))).toEqual(
      Object.fromEntries(Object.entries(ALLOWED).map(([file, { lines }]) => [file, lines])),
    );
  });

  it('every allowed file gives its reason', () => {
    for (const [file, { lines, why }] of Object.entries(ALLOWED)) {
      expect(lines, file).toBeGreaterThan(0);
      expect(why.length, file).toBeGreaterThan(20);
    }
  });

  it('the census sees every spelling of the text (control: one per line)', () => {
    const sample = inCatch([
      "return NextResponse.json({ error: 'internal_error', message: e instanceof Error ? e.message : 'unknown' });",
      "return NextResponse.json({ error: 'internal_error', message: String(e) }, { status: 500 });",
      "if (e instanceof Error) return NextResponse.json({ error: 'internal_error', message: e.message });",
      'return NextResponse.json({ error: `internal_error: ${e}` });',
      "return NextResponse.json({ error: 'invalid_form', message: (e as Error).message });",
      'return NextResponse.json({ message: (e as { message: string }).message });',
      'return NextResponse.json({ message: (e as any).message });',
      'const { message } = e as Error; return NextResponse.json({ message });',
      'return NextResponse.json({ message: e.toString() });',
      "return NextResponse.json({ message: 'failed: ' + e });",
      'return NextResponse.json({ detail: JSON.stringify(e) });',
      "return NextResponse.json({ message: e['message'] });",
      'const stack = e instanceof Error ? e.stack : undefined; return NextResponse.json({ stack });',
      'const msg = (e as Error).message.slice(0, 200); return NextResponse.json({ message: msg });',
      'return NextResponse.json({ message: rpcErr.message });',
      'return NextResponse.json({ error: `candidate query failed: ${error.message}` });',
      'return NextResponse.json({ detail: res.error?.message ?? null });',
      'return NextResponse.json({ error }, { status: 500 });',
      'return NextResponse.json({ ...uploadErr, ok: false });',
      "return { ok: false, notes: `AI extraction unavailable (${e instanceof Error ? e.message : 'error'}).` };",
      'return work().catch((problem) => NextResponse.json({ message: String(problem) }));',
      'return work().catch(({ message }) => NextResponse.json({ message }));',
    ]);
    expect(hitsIn('sample.ts', sample).map((hit) => hit.line)).toEqual(
      Array.from({ length: 22 }, (_, i) => i + 2),
    );
  });

  it('the census counts none of what stays on the server or is a yes or no (control)', () => {
    const sample = inCatch([
      '// return NextResponse.json({ message: e instanceof Error ? e.message : "x" });',
      '/* { detail: err.message } `${error.message}` */',
      "const accept = 'image/*'; const label = 'e.message ${e}';",
      'throw new Error(`org list: ${(error as Error).message}`);',
      'void reportError(e instanceof Error ? e : new Error(String(e)), { tag: "t" });',
      "console.error('[route] failed:', e instanceof Error ? e.message : e);",
      'if (e instanceof ServiceError) return NextResponse.json({ error: e.code, message: e.message });',
      "if (e instanceof ForbiddenError) throw new ServiceError('forbidden', e.message);",
      "const words = e instanceof ServiceError && e.code !== 'internal_error' ? e.message : 'Try again.';",
      "throw new ServiceError('internal_error', rpcErr.message);",
      "if ((error.message ?? '').toLowerCase().includes('duplicate key')) return conflict();",
      'if (/timeout/i.test(err.message) || err.message === "x" || !e.message) return retry();',
      "if (e.message && e.message.includes('JWT')) return reauth(); const kind = e.stack ? 'thrown' : 'plain';",
      'const cause = e instanceof Error ? e.message : String(e); throw new Error(`read failed: ${cause}`);',
      'const raw = e instanceof Error ? e.message : String(e); const lower = raw.toLowerCase(); if (lower.startsWith("x")) return a();',
      "const { message } = e as Error; void reportError(new Error(message), { tag: 't' });",
      "const n = typeof e.message === 'string' ? e.message.length : 0;",
      "return NextResponse.json({ error: 'internal_error', message: UNEXPECTED_ERROR_MESSAGE });",
      'return items.map((entry) => entry.message);',
    ]);
    expect(hitsIn('sample.ts', sample)).toEqual([]);
    // JSX text that looks like code or a comment is text.
    expect(hitsIn('sample.tsx', 'const el = <p>// {"{"}err.message{"}"} String(e)</p>;')).toEqual(
      [],
    );
    // A ServiceError other than internal_error answers its message as it is:
    // built from an error's text, it counts.
    expect(
      hitsIn('sample.ts', inCatch(["throw new ServiceError('validation_error', e.message);"])).map(
        (hit) => hit.line,
      ),
    ).toEqual([2]);
  });

  it('the census reads app/api, the response helpers and the modules routes import, and no tests', () => {
    const read = scope().map((file) => path.relative(SRC, file));
    expect(read.length).toBeGreaterThan(300);
    expect(read).toContain('app/api/v1/cycle-counts/[id]/lines/[lineId]/record/route.ts');
    expect(read).toContain('app/api/v1/exceptions/error-response.ts');
    expect(read).toContain('lib/reports/export-errors.ts');
    expect(read).toContain('lib/reports/book-order-totals/http.ts');
    expect(read).toContain('lib/verification/error-response.ts');
    expect(read).toContain('server/lib/order-submission-http.ts');
    expect(read).toContain('server/lib/api-error-response.ts');
    // Imported by routes: text a route answers can be built here (S16 review).
    expect(read).toContain('lib/books/isbn-ai-extract.ts');
    expect(read).toContain('server/loaders/inventory-list.ts');
    // Dynamically imported too (extract-isbns-ai: `await import('@/lib/xlsx-to-csv')`).
    expect(read).toContain('lib/xlsx-to-csv.ts');
    // A relative import out of app/api is followed like an `@/` one.
    const route = path.join(API, 'books/extract-isbns-ai/route.ts');
    expect(moduleFile('../../../../lib/books/isbn-ai-extract', route)).toBe(
      path.join(SRC, 'lib/books/isbn-ai-extract.ts'),
    );
    expect(moduleFile('@/lib/books/isbn-ai-extract', route)).toBe(
      path.join(SRC, 'lib/books/isbn-ai-extract.ts'),
    );
    expect(moduleFile('next/server', route)).toBeNull();
    expect(read.filter((file) => NOT_READ.test(file))).toEqual([]);
    expect(read.filter((file) => /\.test\.tsx?$/.test(file))).toEqual([]);
  });
});
