import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * GUARD (source): every place a route handler under app/api hands the API
 * context to code that may ask about a module sits on a path that answers a
 * module state that could not be read (docket S81).
 *
 * withApiContext holds a module state it could not read as unknown
 * (lib/modules/module-state.ts): asking about such a module throws
 * ModulesUnavailableError wherever the question is asked. Route handlers have
 * no shared wrapper around their bodies (withApiContext and the API context
 * gate wrap only the context step), so a handler with no catch on that path
 * lets the error escape as the framework's own 500 page, logged as uncaught.
 *
 * WHAT IT READS. Every route file under app/api that gets the context
 * (withApiContext, apiContextGate, returnsContext, memberRequesterGate), and
 * the two context helpers (http.ts). In each exported handler (each exported
 * function of a helper), a "reach" is:
 *   - a call that hands `ctx` itself to another function, other than the
 *     reviewed callees in NO_MODULE_READ;
 *   - a method call on a service built from `ctx` (`new X(ctx).m()`, or a
 *     const holding one), other than the reviewed NO_MODULE_READ_SERVICES;
 *   - any read of `.enabledModules`.
 * A call of a function declared in the same file is followed into that
 * function instead. A reach is covered when it sits inside a `try` whose
 * catch either names ModulesUnavailableError or answerModuleState, or throws
 * nothing (the catch answers for every error). Inline callbacks inherit the
 * coverage of where they are written.
 *
 * WHAT IT DOES NOT CATCH.
 *   - A context held under another name than `ctx`, or passed inside an
 *     object (`{ ctx }`), or a module read on a ctx a callee builds itself.
 *   - A catch that answers every error but answers this one as a 2xx or a 4xx
 *     (it counts as covered here); the table guard
 *     (module-state-refusals.guard.test.ts) holds the reviewed routes to the
 *     right answer.
 *   - A callback that runs after the handler returned (a deferred `after()`):
 *     it inherits the coverage of where it is written, not of when it runs.
 *   - Whether a callee really asks about a module: any unreviewed callee that
 *     is handed `ctx` counts as a reach. That is the safe direction.
 */

const SRC = path.resolve(__dirname, '../..');
const API = 'app/api';

/** Callees handed `ctx` that read no module state, each reviewed for it. */
const NO_MODULE_READ = new Set([
  // Permission checks (services/context.ts, @stockpilot/core): permissions and
  // the MFA label only.
  'can',
  'assertPermission',
  'assertAnyPermission',
  'mfaGateError',
  // The caller's warehouse rows (lib/auth/warehouse.ts).
  'getWarehouseAccess',
  // Error answers that take ctx for its organization id only.
  'exceptionsErrorResponse',
  'bookReportErrorResponse',
  'verificationErrorResponse',
  'returnsErrorResponse',
  'contextFailedResponse',
  // Bookkeeping that catches every error itself and answers { recorded: false }
  // (services/return-request-draft.ts).
  'recordReturnRequestDrafted',
  // Hand-over rules (server/lib/order-secrets.ts): orders:approve, the assigned
  // driver, and the warehouse access read; no module.
  'isHandOverEntitled',
  'mayHandOverOrder',
  // Rack holdings for items (server/services/rack-holdings.ts): placement rows.
  'fetchRackHoldingsByItem',
]);

/**
 * Services built on `ctx` whose methods read no module state, each reviewed:
 * ItemImagesService (server/services/item-images.ts) reads image rows and
 * signs storage paths; it never asks about a module.
 */
const NO_MODULE_READ_SERVICES = new Set(['ItemImagesService']);

const CONTEXT_SOURCES = /withApiContext\(|apiContextGate\(|returnsContext\(|memberRequesterGate\(/;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function routeFiles(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/^(route\.tsx?|http\.ts)$/.test(name)) {
        const src = readFileSync(full, 'utf8');
        if (CONTEXT_SOURCES.test(src)) {
          out.set(path.relative(SRC, full).split(path.sep).join('/'), src);
        }
      }
    }
  };
  walk(path.join(SRC, API));
  return out;
}

const passesCtx = (args: ts.NodeArray<ts.Expression> | undefined) =>
  (args ?? []).some((a) => ts.isIdentifier(a) && a.text === 'ctx');

function calleeName(call: ts.CallExpression): string {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return '(expression)';
}

/** A catch that answers this error: it names it (or the helper), or throws nothing. */
function catchAnswers(clause: ts.CatchClause, sf: ts.SourceFile): boolean {
  if (/ModulesUnavailableError|answerModuleState/.test(clause.block.getText(sf))) return true;
  let throws = false;
  const visit = (n: ts.Node): void => {
    if (ts.isThrowStatement(n)) throws = true;
    if (ts.isFunctionLike(n)) return;
    ts.forEachChild(n, visit);
  };
  visit(clause.block);
  return !throws;
}

/** Every uncovered reach of every exported handler in one file. */
function uncoveredReaches(file: string, source: string): string[] {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const isHelper = file.endsWith('http.ts');
  const local = new Map<string, ts.FunctionLikeDeclaration>();
  const handlers: Array<[string, ts.FunctionLikeDeclaration | string]> = [];
  const services = new Map<string, string>();
  const exported = (st: ts.Statement) =>
    ts.canHaveModifiers(st) &&
    (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) {
      local.set(st.name.text, st);
      if (exported(st) && (HTTP_METHODS.has(st.name.text) || isHelper)) {
        handlers.push([st.name.text, st]);
      }
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const init = d.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          local.set(d.name.text, init);
          if (exported(st) && HTTP_METHODS.has(d.name.text)) handlers.push([d.name.text, init]);
        } else if (ts.isIdentifier(init) && exported(st) && HTTP_METHODS.has(d.name.text)) {
          handlers.push([d.name.text, init.text]);
        }
      }
    }
  }
  const findServices = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      ts.isNewExpression(n.initializer) &&
      passesCtx(n.initializer.arguments)
    ) {
      services.set(n.name.text, n.initializer.expression.getText(sf));
    }
    ts.forEachChild(n, findServices);
  };
  findServices(sf);

  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const reach = (n: ts.Node): string | null => {
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'enabledModules') {
      return '.enabledModules';
    }
    if (!ts.isCallExpression(n)) return null;
    if (ts.isPropertyAccessExpression(n.expression)) {
      let target: ts.Expression = n.expression.expression;
      while (ts.isParenthesizedExpression(target)) target = target.expression;
      if (ts.isNewExpression(target) && passesCtx(target.arguments)) {
        const cls = target.expression.getText(sf);
        if (NO_MODULE_READ_SERVICES.has(cls)) return null;
        return `new ${cls}(ctx).${n.expression.name.text}`;
      }
      if (ts.isIdentifier(target) && services.has(target.text)) {
        if (NO_MODULE_READ_SERVICES.has(services.get(target.text)!)) return null;
        return `${target.text}.${n.expression.name.text}`;
      }
    }
    if (ts.isIdentifier(n.expression) && local.has(n.expression.text)) return null;
    if (passesCtx(n.arguments) && !NO_MODULE_READ.has(calleeName(n))) return calleeName(n);
    return null;
  };

  const memo = new Map<ts.Node, string[]>();
  const uncovered = (fn: ts.FunctionLikeDeclaration, seen: Set<ts.Node>): string[] => {
    const known = memo.get(fn);
    if (known) return known;
    if (seen.has(fn)) return [];
    seen.add(fn);
    const found: string[] = [];
    const visit = (n: ts.Node, covered: boolean): void => {
      if (n !== fn && ts.isFunctionDeclaration(n)) return;
      if (ts.isTryStatement(n)) {
        const answers = !!n.catchClause && catchAnswers(n.catchClause, sf);
        visit(n.tryBlock, covered || answers);
        if (n.catchClause) visit(n.catchClause.block, covered);
        if (n.finallyBlock) visit(n.finallyBlock, covered);
        return;
      }
      if (!covered) {
        const r = reach(n);
        if (r) found.push(`${r} (line ${line(n)})`);
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
          const callee = local.get(n.expression.text);
          if (callee && callee !== fn) {
            const inner = uncovered(callee, seen);
            if (inner.length)
              found.push(`${n.expression.text}() (line ${line(n)}): ${inner.join(', ')}`);
          }
        }
      }
      ts.forEachChild(n, (c) => visit(c, covered));
    };
    if (fn.body) visit(fn.body, false);
    memo.set(fn, found);
    return found;
  };

  const out: string[] = [];
  for (const [name, fn] of handlers) {
    const node = typeof fn === 'string' ? local.get(fn) : fn;
    if (!node) {
      out.push(`${file} ${name}: a handler this guard cannot read`);
      continue;
    }
    const found = uncovered(node, new Set());
    if (found.length) out.push(`${file} ${name}: ${found.join('; ')}`);
  }
  return out;
}

describe('route handlers answer a module state that could not be read (source guard)', () => {
  it('reads real route files', () => {
    const files = routeFiles();
    expect(files.size).toBeGreaterThan(100);
    expect(files.has('app/api/v1/me/releases/route.ts')).toBe(true);
    expect(files.has('app/api/v1/orders/[id]/return-request/http.ts')).toBe(true);
  });

  it(
    'no handler reaches a module question outside a path that answers it',
    { timeout: 60_000 },
    () => {
      const found = [...routeFiles()].flatMap(([file, src]) => uncoveredReaches(file, src));
      expect(found).toEqual([]);
    },
  );

  it('plants: an uncovered reach of each kind fails it; a covered one passes', () => {
    const plant = (body: string) =>
      uncoveredReaches(
        'app/api/v1/plant/route.ts',
        `import { withApiContext } from '@/lib/auth/api-context';
         export async function GET(req: Request) {
           const ctx = await withApiContext(req);
           if (!ctx) return new Response(null, { status: 401 });
           ${body}
         }`,
      );
    expect(plant(`return Response.json(await listReleasesFor(ctx));`)).toEqual([
      'app/api/v1/plant/route.ts GET: listReleasesFor (line 5)',
    ]);
    expect(plant(`return Response.json(await new ThingsService(ctx).list());`)).toEqual([
      'app/api/v1/plant/route.ts GET: new ThingsService(ctx).list (line 5)',
    ]);
    expect(
      plant(`const svc = new ThingsService(ctx); return Response.json(await svc.list());`),
    ).toEqual(['app/api/v1/plant/route.ts GET: svc.list (line 5)']);
    expect(plant(`return Response.json({ on: ctx.enabledModules.has('rentals') });`)).toEqual([
      'app/api/v1/plant/route.ts GET: .enabledModules (line 5)',
    ]);
    // A catch that throws the error on is no answer.
    expect(
      plant(
        `try { assertModuleEnabled(ctx, 'ai'); } catch (e) { if (isOff(e)) return off(); throw e; }`,
      ),
    ).toEqual(['app/api/v1/plant/route.ts GET: assertModuleEnabled (line 5)']);
    // A local helper is followed.
    expect(
      uncoveredReaches(
        'app/api/v1/plant/route.ts',
        `import { withApiContext } from '@/lib/auth/api-context';
         async function load(ctx) { return listReleasesFor(ctx); }
         export async function GET(req: Request) {
           const ctx = await withApiContext(req);
           return Response.json(await load(ctx));
         }`,
      ),
    ).toEqual(['app/api/v1/plant/route.ts GET: load() (line 5): listReleasesFor (line 2)']);
    // Covered: the catch answers it, or answers every error.
    expect(
      plant(
        `try { return Response.json(await listReleasesFor(ctx)); } catch (e) { return answerModuleState(e, 'tag'); }`,
      ),
    ).toEqual([]);
    expect(
      plant(`try { return Response.json(await listReleasesFor(ctx)); } catch { return fail(); }`),
    ).toEqual([]);
    // A reviewed callee is no reach.
    expect(
      plant(`if (!can(ctx, 'items:read')) return new Response(null, { status: 403 });`),
    ).toEqual([]);
  });
});
