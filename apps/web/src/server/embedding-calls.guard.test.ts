/**
 * RECURRENCE GUARD: every item embedding is held until it finishes.
 *
 * An embedding is written after the item, so a slow Gemini call never holds
 * up a create or an edit. Started as a bare `void (async () => ...)()`, it was
 * held by nothing once the response was sent, and a suspended instance could
 * cut it off. Every call of embedInventoryItem or embedItemsBatch in the
 * server code (src/server, src/lib, src/app/api) must therefore be AWAITED,
 * and the function that awaits it must itself be held:
 *   - a NAMED function (a method, a function, a const-bound function) is
 *     "awaited by its caller", and then each of its own call sites in the
 *     scanned code is held to this same rule (a wrapper called with `void`
 *     fails, wherever it is);
 *   - an anonymous async function is held only when its promise is handed to
 *     keepAlive (lib/defer.ts), or awaited by a held function: as an IIFE,
 *     through .then/.catch/.finally, as the callback of mapWithConcurrency,
 *     or inside Promise.all / Promise.allSettled over `.map(...)`.
 * Everything else is reported: `void`, a bare statement, a promise kept in a
 * variable, a forEach or setTimeout callback, after() / defer() (which start
 * the work only after the response), a dropped `await` inside the loop.
 *
 * The AST is read, so comments and strings never count as calls, and an
 * aliased import or a destructured lazy import is followed. It reuses the
 * dropped-promise approach of services/inventory-list-invalidation.guard
 * .test.ts (unwrap casts and parentheses, follow .then/.catch/.finally, treat
 * keepAlive by callee name).
 *
 * NOT FOLLOWED: a class method that awaits an embedding is checked at its
 * `this.method()` calls in its own class, not at instance calls from other
 * files; an object-literal method (an AI tool's execute) is dispatched by the
 * caller and is taken as awaited there. Neither shape exists today.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const WEB_SRC = path.resolve(__dirname, '..');
const ROOTS = ['server', 'lib', 'app/api'];
const EMBED_FNS = new Set(['embedInventoryItem', 'embedItemsBatch']);
/** Calls that run a callback per item and await every promise it returns. */
const AWAITING_RUNNERS = new Set(['mapWithConcurrency']);

/* ─────────────────────────────── the scan ─────────────────────────────── */

function unwrap(node: ts.Node): ts.Node {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isTypeAssertionExpression(n) ||
    ts.isSatisfiesExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

function isWrapperNode(n: ts.Node): boolean {
  return (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isTypeAssertionExpression(n) ||
    ts.isSatisfiesExpression(n)
  );
}

function calleeName(call: ts.CallExpression): string | null {
  const c = unwrap(call.expression);
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  return null;
}

/** The outermost expression still carrying `expr`'s promise: through
 *  parentheses and casts, and through .then/.catch/.finally chains. */
function promiseCarrier(expr: ts.Node): ts.Node {
  let n = expr;
  for (;;) {
    const p = n.parent;
    if (isWrapperNode(p)) {
      n = p;
      continue;
    }
    if (
      ts.isPropertyAccessExpression(p) &&
      ['then', 'catch', 'finally'].includes(p.name.text) &&
      ts.isCallExpression(p.parent) &&
      p.parent.expression === p
    ) {
      n = p.parent;
      continue;
    }
    return n;
  }
}

type FunctionLike =
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function enclosingFunction(node: ts.Node): FunctionLike | null {
  for (let n = node.parent; n; n = n.parent) {
    if (
      ts.isArrowFunction(n) ||
      ts.isFunctionExpression(n) ||
      ts.isFunctionDeclaration(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isConstructorDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n)
    ) {
      return n;
    }
  }
  return null;
}

/** A function a caller reaches by name, or null for an anonymous one. */
type Named =
  | { kind: 'function'; name: string }
  | { kind: 'method'; cls: string; name: string }
  | { kind: 'object-method'; name: string };

function namedFunction(fn: FunctionLike): Named | null {
  if (ts.isFunctionDeclaration(fn))
    return fn.name ? { kind: 'function', name: fn.name.text } : null;
  if (
    ts.isMethodDeclaration(fn) ||
    ts.isGetAccessorDeclaration(fn) ||
    ts.isSetAccessorDeclaration(fn)
  ) {
    const name = fn.name.getText();
    if (ts.isClassLike(fn.parent))
      return { kind: 'method', cls: fn.parent.name?.text ?? '<class>', name };
    return { kind: 'object-method', name };
  }
  if (ts.isConstructorDeclaration(fn)) return { kind: 'object-method', name: 'constructor' };
  let p: ts.Node = fn.parent;
  while (isWrapperNode(p)) p = p.parent;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name))
    return { kind: 'function', name: p.name.text };
  if (ts.isPropertyAssignment(p)) return { kind: 'object-method', name: p.name.getText() };
  return null;
}

type Verdict = { held: true; how: string } | { held: false; why: string };

interface FileScan {
  rel: string;
  abs: string;
  sf: ts.SourceFile;
}

interface Wrapper {
  file: string;
  named: Named;
}

class Analysis {
  readonly wrappers = new Map<string, Wrapper>();

  /** The promise of `expr` (a call): awaited by a held function, or kept alive. */
  isHeld(expr: ts.Node, file: string): Verdict {
    const n = promiseCarrier(expr);
    const p = n.parent;
    if (ts.isAwaitExpression(p)) return this.functionHeld(p, file);
    if (ts.isReturnStatement(p)) return this.functionHeld(p, file);
    if (ts.isArrowFunction(p) && p.body === n) return this.functionHeld(n, file);
    if (ts.isCallExpression(p) && p.expression !== n && calleeName(p) === 'keepAlive') {
      return { held: true, how: 'keepAlive' };
    }
    if (ts.isArrayLiteralExpression(p)) {
      let q: ts.Node = p.parent;
      while (isWrapperNode(q)) q = q.parent;
      if (ts.isCallExpression(q) && isPromiseCombinator(q)) return this.isHeld(q, file);
    }
    return { held: false, why: describeDrop(p) };
  }

  /** `node` is inside a function whose own promise must be held. */
  functionHeld(node: ts.Node, file: string): Verdict {
    const fn = enclosingFunction(node);
    if (!fn) return { held: false, why: 'awaited at module scope' };
    const named = namedFunction(fn);
    if (named) {
      if (named.kind !== 'object-method') {
        const key = `${file}#${named.kind === 'method' ? `${named.cls}.` : ''}${named.name}`;
        if (!this.wrappers.has(key)) this.wrappers.set(key, { file, named });
      }
      return { held: true, how: `awaited by ${named.name}` };
    }
    let outer: ts.Node = fn.parent;
    while (isWrapperNode(outer)) outer = outer.parent;
    if (ts.isCallExpression(outer) && unwrap(outer.expression) === fn) {
      return this.isHeld(outer, file);
    }
    if (ts.isCallExpression(outer) && outer.arguments.some((a) => unwrap(a) === fn)) {
      const name = calleeName(outer);
      if (name && AWAITING_RUNNERS.has(name)) return this.isHeld(outer, file);
      if (name === 'map') {
        let q: ts.Node = outer.parent;
        while (isWrapperNode(q)) q = q.parent;
        if (
          ts.isCallExpression(q) &&
          isPromiseCombinator(q) &&
          q.arguments.some((a) => unwrap(a) === outer)
        ) {
          return this.isHeld(q, file);
        }
      }
      return { held: false, why: `a callback of ${name ?? 'a call'}(), which does not await it` };
    }
    return { held: false, why: 'an anonymous function nobody awaits' };
  }
}

function isPromiseCombinator(call: ts.CallExpression): boolean {
  const c = unwrap(call.expression);
  return (
    ts.isPropertyAccessExpression(c) &&
    ts.isIdentifier(c.expression) &&
    c.expression.text === 'Promise' &&
    ['all', 'allSettled'].includes(c.name.text)
  );
}

function describeDrop(p: ts.Node): string {
  if (ts.isVoidExpression(p)) return 'voided';
  if (ts.isExpressionStatement(p)) return 'a bare statement';
  if (ts.isVariableDeclaration(p)) return 'kept in a variable';
  if (ts.isCallExpression(p)) return `passed to ${calleeName(p) ?? 'a call'}()`;
  return `dropped (${ts.SyntaxKind[p.kind]})`;
}

/** Local names that refer to an embedding writer in this file. */
function embedAliases(sf: ts.SourceFile): Set<string> {
  const names = new Set(EMBED_FNS);
  const visit = (n: ts.Node): void => {
    if (ts.isImportSpecifier(n) && EMBED_FNS.has((n.propertyName ?? n.name).text)) {
      names.add(n.name.text);
    }
    if (ts.isBindingElement(n) && ts.isIdentifier(n.name)) {
      const prop = n.propertyName ? n.propertyName.getText(sf) : n.name.text;
      if (EMBED_FNS.has(prop)) names.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

/** Every call of an embedding writer in the file. */
function embedCalls(sf: ts.SourceFile): ts.CallExpression[] {
  const aliases = embedAliases(sf);
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const c = unwrap(n.expression);
      if (
        (ts.isIdentifier(c) && aliases.has(c.text)) ||
        (ts.isPropertyAccessExpression(c) && EMBED_FNS.has(c.name.text))
      ) {
        out.push(n);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The top-level member a node belongs to: `Class.member`, `fn`, `const.prop`. */
function memberKey(node: ts.Node, sf: ts.SourceFile): string {
  let top = node;
  while (top.parent && !ts.isSourceFile(top.parent)) top = top.parent;
  const contains = (outer: ts.Node) => node.pos >= outer.pos && node.end <= outer.end;
  if (ts.isFunctionDeclaration(top)) return top.name?.text ?? '<default>';
  if (ts.isClassDeclaration(top)) {
    const m = top.members.find(contains);
    return `${top.name?.text ?? '<class>'}.${m?.name?.getText(sf) ?? 'constructor'}`;
  }
  if (ts.isVariableStatement(top)) {
    const d = top.declarationList.declarations.find(contains);
    const base = d?.name.getText(sf) ?? '<var>';
    const init = d?.initializer ? unwrap(d.initializer) : undefined;
    if (init && ts.isObjectLiteralExpression(init)) {
      const prop = init.properties.find(contains);
      return prop?.name ? `${base}.${prop.name.getText(sf)}` : base;
    }
    return base;
  }
  return '<top-level>';
}

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Resolve an app import (`@/x` or relative) to an absolute .ts/.tsx path. */
function resolveImport(fromAbs: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(WEB_SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromAbs), spec);
  else return null;
  for (const c of [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]) {
    try {
      readFileSync(c);
      return c;
    } catch {
      /* the next shape */
    }
  }
  return null;
}

/** Calls in `scan` of the wrapper `w` (defined in w.file). */
function wrapperCalls(
  scan: FileScan,
  w: Wrapper,
  byRel: Map<string, FileScan>,
): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const defAbs = byRel.get(w.file)?.abs;
  const sameFile = scan.rel === w.file;
  const localNames = new Set<string>();
  const namespaces = new Set<string>();
  if (w.named.kind === 'function') {
    if (sameFile) localNames.add(w.named.name);
    for (const st of scan.sf.statements) {
      if (!ts.isImportDeclaration(st) || st.importClause?.isTypeOnly) continue;
      const spec = (st.moduleSpecifier as ts.StringLiteral).text;
      if (!defAbs || resolveImport(scan.abs, spec) !== defAbs) continue;
      const nb = st.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const e of nb.elements) {
          if ((e.propertyName ?? e.name).text === w.named.name && !e.isTypeOnly)
            localNames.add(e.name.text);
        }
      }
      if (nb && ts.isNamespaceImport(nb)) namespaces.add(nb.name.text);
    }
  }
  const named = w.named;
  const visit = (n: ts.Node, cls: string | null): void => {
    const nextCls = ts.isClassDeclaration(n) && n.name ? n.name.text : cls;
    if (ts.isCallExpression(n)) {
      const c = unwrap(n.expression);
      if (named.kind === 'function') {
        if (ts.isIdentifier(c) && localNames.has(c.text)) out.push(n);
        if (
          ts.isPropertyAccessExpression(c) &&
          ts.isIdentifier(c.expression) &&
          namespaces.has(c.expression.text) &&
          c.name.text === named.name
        ) {
          out.push(n);
        }
      } else if (
        named.kind === 'method' &&
        sameFile &&
        cls === named.cls &&
        ts.isPropertyAccessExpression(c) &&
        c.expression.kind === ts.SyntaxKind.ThisKeyword &&
        c.name.text === named.name
      ) {
        out.push(n);
      }
    }
    ts.forEachChild(n, (child) => visit(child, nextCls));
  };
  visit(scan.sf, null);
  return out;
}

interface Report {
  /** `rel#member: callee` per direct call of an embedding writer. */
  sites: string[];
  /** `rel:line callee: why` per call whose promise nothing holds. */
  offenders: string[];
  /** Wrappers followed to their call sites. */
  wrappers: string[];
}

function analyze(files: FileScan[]): Report {
  const a = new Analysis();
  const byRel = new Map(files.map((f) => [f.rel, f]));
  const sites: string[] = [];
  const offenders: string[] = [];
  const check = (f: FileScan, call: ts.CallExpression) => {
    const v = a.isHeld(call, f.rel);
    if (!v.held) {
      const line = f.sf.getLineAndCharacterOfPosition(call.getStart(f.sf)).line + 1;
      offenders.push(`${f.rel}:${line} ${call.expression.getText(f.sf)}: ${v.why}`);
    }
  };
  for (const f of files) {
    for (const call of embedCalls(f.sf)) {
      sites.push(`${f.rel}#${memberKey(call, f.sf)}: ${calleeName(call)}`);
      check(f, call);
    }
  }
  // Follow wrappers to their call sites until no new wrapper appears.
  const done = new Set<string>();
  for (;;) {
    const next = [...a.wrappers.entries()].filter(([k]) => !done.has(k));
    if (next.length === 0) break;
    for (const [key, w] of next) {
      done.add(key);
      for (const f of files) for (const call of wrapperCalls(f, w, byRel)) check(f, call);
    }
  }
  return { sites: sites.sort(), offenders, wrappers: [...done].sort() };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts'))
      out.push(abs);
  }
  return out;
}

function realTree(): FileScan[] {
  return ROOTS.flatMap((r) => walk(path.join(WEB_SRC, r)))
    .sort()
    .map((abs) => ({
      abs,
      rel: path.relative(WEB_SRC, abs).split(path.sep).join('/'),
      sf: parse(abs, readFileSync(abs, 'utf8')),
    }));
}

/** One synthetic file, for the machinery tests. */
function probe(source: string): Report {
  const abs = path.join(WEB_SRC, 'server/probe.ts');
  return analyze([{ abs, rel: 'server/probe.ts', sf: parse(abs, source) }]);
}

/* ─────────────────────────── the machinery ─────────────────────────── */

describe('the scan machinery itself', () => {
  it('counts real calls only, never a comment or a string', () => {
    const r = probe(`
      // embedInventoryItem(id, ctx) in a comment
      /* embedItemsBatch(ctx) in a block comment */
      const text = 'embedInventoryItem(id, ctx) in a string';
      const tpl = \`embedItemsBatch(ctx)\`;
    `);
    expect(r.sites).toEqual([]);
  });

  it('holds a call awaited inside an IIFE handed to keepAlive, through .catch', () => {
    const r = probe(`
      import { embedInventoryItem } from '@/lib/ai/embeddings';
      export function start(id, ctx) {
        keepAlive((async () => { await embedInventoryItem(id, ctx); })().catch(() => {}));
      }
    `);
    expect(r.sites).toEqual(['server/probe.ts#start: embedInventoryItem']);
    expect(r.offenders).toEqual([]);
  });

  it('holds a call awaited in a mapWithConcurrency callback whose loop is kept alive', () => {
    const r = probe(`
      function embedAll(ids, ctx) {
        keepAlive(
          (async () => {
            const { embedInventoryItem } = await loadEmbeddings();
            await mapWithConcurrency(ids, 4, async (id) => {
              await embedInventoryItem(id, ctx);
            });
          })().catch((err) => console.warn(err)),
        );
      }
    `);
    expect(r.offenders).toEqual([]);
    expect(r.sites).toEqual(['server/probe.ts#embedAll: embedInventoryItem']);
  });

  it('reports a dropped inner await, even inside a loop handed to keepAlive', () => {
    const r = probe(`
      function embedAll(ids, ctx) {
        keepAlive((async () => {
          await mapWithConcurrency(ids, 4, async (id) => { embedInventoryItem(id, ctx); });
        })());
      }
    `);
    expect(r.offenders).toEqual(['server/probe.ts:4 embedInventoryItem: a bare statement']);
  });

  it('reports a loop that is started but not handed to keepAlive (void, bare, kept)', () => {
    const r = probe(`
      function a(id, ctx) { void (async () => { await embedInventoryItem(id, ctx); })(); }
      function b(id, ctx) { (async () => { await embedInventoryItem(id, ctx); })().catch(() => {}); }
      function c(ids, ctx) { void mapWithConcurrency(ids, 4, async (id) => { await embedInventoryItem(id, ctx); }); }
      function d(id, ctx) { const p = (async () => { await embedInventoryItem(id, ctx); })(); }
    `);
    expect(r.offenders.map((o) => o.split(': ')[1])).toEqual([
      'voided',
      'a bare statement',
      'voided',
      'kept in a variable',
    ]);
  });

  it('reports a direct call that is voided, bare, chained or kept, and callbacks nobody awaits', () => {
    const r = probe(`
      function a(id, ctx) { void embedInventoryItem(id, ctx); }
      function b(id, ctx) { embedInventoryItem(id, ctx); }
      function c(id, ctx) { embedInventoryItem(id, ctx).catch(() => {}); }
      async function d(id, ctx) { const p = embedInventoryItem(id, ctx); await p; }
      function e(ids, ctx) { ids.forEach(async (id) => { await embedInventoryItem(id, ctx); }); }
      function f(ctx) { after(async () => { await embedItemsBatch(ctx); }); }
      function g(ctx) { defer(async () => { await embedItemsBatch(ctx); }); }
      function h(ctx) { setTimeout(async () => { await embedItemsBatch(ctx); }, 0); }
    `);
    expect(r.offenders.map((o) => o.split(': ')[1])).toEqual([
      'voided',
      'a bare statement',
      'a bare statement',
      'kept in a variable',
      'a callback of forEach(), which does not await it',
      'a callback of after(), which does not await it',
      'a callback of defer(), which does not await it',
      'a callback of setTimeout(), which does not await it',
    ]);
  });

  it('holds Promise.all over .map(async ...) only when the Promise.all is held', () => {
    const r = probe(`
      async function a(ids, ctx) {
        await Promise.all(ids.map(async (id) => { await embedInventoryItem(id, ctx); }));
      }
      function b(ids, ctx) {
        void Promise.allSettled(ids.map(async (id) => { await embedInventoryItem(id, ctx); }));
      }
    `);
    expect(r.offenders).toEqual(['server/probe.ts:6 embedInventoryItem: voided']);
  });

  it('follows aliased and destructured imports, and calls through a module object', () => {
    const r = probe(`
      import { embedInventoryItem as embedOne } from '@/lib/ai/embeddings';
      async function a(id, ctx) {
        const { embedItemsBatch: batch } = await import('@/lib/ai/embeddings');
        void batch(ctx);
        embedOne(id, ctx);
        const mod = await import('@/lib/ai/embeddings');
        void mod.embedItemsBatch(ctx);
      }
    `);
    expect(r.offenders).toHaveLength(3);
  });

  it('a named function that awaits is held by its caller, and its own call sites are checked', () => {
    const r = probe(`
      async function backfill(ctx) { await embedItemsBatch(ctx); }
      export async function goodCaller(ctx) { await backfill(ctx); }
      export function badCaller(ctx) { void backfill(ctx); }
      const viaConst = async (ctx) => { await embedItemsBatch(ctx); };
      export function badConstCaller(ctx) { viaConst(ctx); }
      class S {
        async refresh() { await embedItemsBatch(this.ctx); }
        ok() { return this.refresh(); }
        bad() { void this.refresh(); }
      }
    `);
    expect(r.offenders).toEqual([
      'server/probe.ts:4 backfill: voided',
      'server/probe.ts:6 viaConst: a bare statement',
      'server/probe.ts:10 this.refresh: voided',
    ]);
    expect(r.wrappers).toEqual([
      'server/probe.ts#S.ok',
      'server/probe.ts#S.refresh',
      'server/probe.ts#backfill',
      // It awaits a wrapper, so it is one too, and its callers are checked.
      'server/probe.ts#goodCaller',
      'server/probe.ts#viaConst',
    ]);
  });
});

/* ───────────────────────────── the guard ───────────────────────────── */

describe('every item embedding in the server code is held until it finishes', () => {
  const report = analyze(realTree());

  it('finds every real call (and only real calls) of embedInventoryItem and embedItemsBatch', () => {
    // A new call site is a reviewed change: add it here, and it is checked
    // below like these.
    expect(report.sites).toEqual([
      'lib/ai/embeddings-sweep.ts#sweepMissingEmbeddings: embedItemsBatch',
      'lib/ai/tools.ts#backfillEmbeddingsTool.execute: embedItemsBatch',
      'server/actions/embeddings.ts#backfillItemEmbeddingsAction: embedItemsBatch',
      'server/services/inventory.ts#embedInBackground: embedInventoryItem',
    ]);
  });

  it('no embedding is fired and forgotten: each is awaited by a held function or kept alive', () => {
    expect(report.offenders, 'await it, or hand the work to keepAlive').toEqual([]);
  });

  it("the wrappers' own call sites are followed (the sweep's, from the cron route)", () => {
    expect(report.wrappers).toEqual(
      expect.arrayContaining([
        'lib/ai/embeddings-sweep.ts#sweepMissingEmbeddings',
        'server/actions/embeddings.ts#backfillItemEmbeddingsAction',
      ]),
    );
  });
});
