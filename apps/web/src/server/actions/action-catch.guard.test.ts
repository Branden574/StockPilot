import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { scanActionCatches, type CatchFinding, type ScanFile } from '@/test/action-catch-scan';

/**
 * RECURRENCE GUARD: no Server Action catch swallows a redirect.
 *
 * withContext() -> requireOrgContext() answers a signed-out session with
 * redirect() to sign-in (a disabled account goes to /account-disabled, a member
 * with no organization to /onboarding), and Next.js carries a redirect as a
 * THROWN error. Most action modules caught everything their work threw and
 * mapped it to an ActionResult, so the redirect came back as
 * `internal_error: 'NEXT_REDIRECT'` or "Something went wrong", and the person
 * stayed on a page that could no longer save.
 *
 * Every catch in a `'use server'` module whose try block can reach a redirect
 * (see src/test/action-catch-scan.ts for what is followed) must rethrow it as
 * its first statement: `rethrowControlFlow(e)` from lib/control-flow.ts, or a
 * mapper whose own first statement does (the modules' toResult). Every catch in
 * other code around a call to a Server Action must put control flow first too:
 * a client component stops quietly (`if (isControlFlow(e)) return;`), because
 * the router is already navigating and a toast would still be on screen on the
 * sign-in page.
 */

const WEB_SRC = path.resolve(__dirname, '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      walk(full, out);
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.test\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function describeFinding(f: CatchFinding): string {
  return `${path.relative(WEB_SRC, f.file)}:${f.line} ${f.fn} (${f.kind} around ${f.reaches}): ${f.problem}`;
}

/* ─────────────────────────────── self-test ─────────────────────────────── */

const V = '/virtual/src';
const PLANTED: ScanFile[] = [
  {
    path: `${V}/lib/control-flow.ts`,
    text: `export function rethrowControlFlow(e: unknown) {}\nexport function isControlFlow(e: unknown) { return false; }\n`,
  },
  {
    path: `${V}/lib/auth/session.ts`,
    text: [
      `import { cache } from 'react';`,
      `import { redirect } from 'next/navigation';`,
      `export const requireOrgContext = cache(async () => {`,
      `  const s = await load();`,
      `  if (!s) redirect('/signin');`,
      `  return s;`,
      `});`,
      `async function load() { return null; }`,
    ].join('\n'),
  },
  {
    path: `${V}/server/services/context.ts`,
    text: [
      `import { cache } from 'react';`,
      `import { requireOrgContext } from '@/lib/auth/session';`,
      `export const withContext = cache(async () => ({ ...(await requireOrgContext()) }));`,
    ].join('\n'),
  },
  {
    path: `${V}/server/services/things.ts`,
    text: [
      `import { withContext } from './context';`,
      `export class ThingsService {`,
      `  constructor(private ctx: unknown) {}`,
      `  static async forCurrentUser() { return new ThingsService(await withContext()); }`,
      `  async list() { return []; }`,
      `}`,
    ].join('\n'),
  },
  {
    path: `${V}/lib/helpers.ts`,
    text: [
      `export function parse(x: string) { return JSON.parse(x); }`,
      `export async function gate() {`,
      `  const { withContext } = await import('@/server/services/context');`,
      `  return withContext();`,
      `}`,
    ].join('\n'),
  },
  {
    path: `${V}/lib/barrel.ts`,
    text: `export { gate as gateAgain } from './helpers';\n`,
  },
  {
    path: `${V}/server/actions/planted.ts`,
    text: [
      `'use server';`,
      `import { redirect } from 'next/navigation';`,
      `import { rethrowControlFlow } from '@/lib/control-flow';`,
      `import { withContext } from '@/server/services/context';`,
      `import { ThingsService } from '@/server/services/things';`,
      `import { gate, parse } from '@/lib/helpers';`,
      `import { gateAgain } from '@/lib/barrel';`,
      ``,
      `function toResult(e: unknown) { rethrowControlFlow(e); return { ok: false as const }; }`,
      `function fail(tag: string, e: unknown) { rethrowControlFlow(e); return { ok: false as const, tag }; }`,
      `function badResult(e: unknown) { return { ok: false as const, e }; }`,
      `async function loadCtx() { return withContext(); }`,
      ``,
      `export async function swallowedAction() { try { await withContext(); return { ok: true }; } catch (e) { return { ok: false, e }; } }`,
      `export async function guardedAction() { try { await withContext(); return { ok: true }; } catch (e) { rethrowControlFlow(e); return { ok: false }; } }`,
      `export async function mapperAction() { try { await withContext(); return { ok: true }; } catch (e) { return toResult(e); } }`,
      `export async function secondParamMapperAction() { try { await withContext(); return { ok: true }; } catch (err) { const f = fail('tag', err); return f; } }`,
      `export async function unguardedMapperAction() { try { await withContext(); return { ok: true }; } catch (e) { return badResult(e); } }`,
      `export async function transitiveAction() { try { await loadCtx(); return { ok: true }; } catch (e) { return null; } }`,
      `export async function staticMethodAction() { try { const s = await ThingsService.forCurrentUser(); return s.list(); } catch (e) { return null; } }`,
      `export async function dynamicImportAction() { try { await gate(); return 1; } catch (e) { return null; } }`,
      `export async function reexportAction() { try { await gateAgain(); return 1; } catch (e) { return null; } }`,
      `export async function bindinglessAction() { try { await withContext(); return 1; } catch { return null; } }`,
      `export async function promiseCatchAction() { return withContext().catch(() => null); }`,
      `export async function promiseCatchMapperAction() { return withContext().catch(toResult); }`,
      `export async function promiseThenAction() { return withContext().then((c) => c, (e) => ({ e })); }`,
      `export async function safeTryAction(x: string) { try { return parse(x); } catch { return null; } }`,
      `export async function logsFirstAction() { try { await withContext(); return 1; } catch (e) { console.error(e); rethrowControlFlow(e); return 0; } }`,
      `export async function allSettledAction() { const [a] = await Promise.allSettled([withContext()]); return a; }`,
      `export async function directRedirectAction(x: boolean) { try { if (x) redirect('/x'); return 1; } catch (e) { return 0; } }`,
      `export async function callbackRefAction(ids: string[]) { try { return await Promise.all(ids.map(loadCtx)); } catch (e) { return []; } }`,
    ].join('\n'),
  },
  {
    path: `${V}/components/planted-client.tsx`,
    text: [
      `'use client';`,
      `import { isControlFlow, rethrowControlFlow } from '@/lib/control-flow';`,
      `import { guardedAction, mapperAction } from '@/server/actions/planted';`,
      `declare const toast: { error(m: string): void };`,
      `export async function clientSwallows() { try { await guardedAction(); } catch { toast.error('Something went wrong'); } }`,
      `export async function clientQuiet() { try { await guardedAction(); } catch (e) { if (isControlFlow(e)) return; toast.error('x'); } }`,
      `export async function clientRethrows() { try { await guardedAction(); } catch (e) { rethrowControlFlow(e); toast.error('x'); } }`,
      `export function clientPromiseCatch() { void mapperAction().catch(() => toast.error('x')); }`,
      `export function clientPromiseQuiet() { void mapperAction().catch((e) => { if (isControlFlow(e)) return; toast.error('x'); }); }`,
    ].join('\n'),
  },
  {
    path: `${V}/lib/server-helper.ts`,
    text: [
      `import { isControlFlow } from '@/lib/control-flow';`,
      `import { guardedAction } from '@/server/actions/planted';`,
      `export async function serverCallerReturns() { try { return await guardedAction(); } catch (e) { if (isControlFlow(e)) return null; return null; } }`,
      `export async function serverCallerThrows() { try { return await guardedAction(); } catch (e) { if (isControlFlow(e)) throw e; return null; } }`,
    ].join('\n'),
  },
  {
    path: `${V}/app/page.tsx`,
    text: [
      `import { withContext } from '@/server/services/context';`,
      `export default function Page() {`,
      `  async function save() { 'use server'; try { await withContext(); } catch (e) { return null; } }`,
      `  async function load() { try { await withContext(); } catch (e) { return null; } }`,
      `  return [save, load];`,
      `}`,
    ].join('\n'),
  },
];

describe('the action-catch scan (self-test on planted files)', () => {
  const scan = scanActionCatches(PLANTED, V);
  const serverFns = scan.serverFindings.map((f) => f.fn).sort();
  const callerFns = scan.callerFindings.map((f) => f.fn).sort();

  it('follows redirects through wrappers, statics, dynamic imports and re-exports', () => {
    expect(scan.redirecting).toContain(`${V}/lib/auth/session.ts#requireOrgContext`);
    expect(scan.redirecting).toContain(`${V}/server/services/context.ts#withContext`);
    expect(scan.redirecting).toContain(
      `${V}/server/services/things.ts#ThingsService.forCurrentUser`,
    );
    expect(scan.redirecting).toContain(`${V}/lib/helpers.ts#gate`);
    expect(scan.redirecting).not.toContain(`${V}/lib/helpers.ts#parse`);
    expect(scan.actionModules).toEqual([`${V}/server/actions/planted.ts`]);
  });

  it('reports every planted Server Action catch that swallows a redirect, and only those', () => {
    expect(serverFns).toEqual(
      [
        'allSettledAction',
        'bindinglessAction',
        'callbackRefAction',
        'directRedirectAction',
        'dynamicImportAction',
        'logsFirstAction',
        'promiseCatchAction',
        'promiseThenAction',
        'reexportAction',
        'save',
        'staticMethodAction',
        'swallowedAction',
        'transitiveAction',
        'unguardedMapperAction',
      ].sort(),
    );
  });

  it('accepts the rethrow, a rethrowing mapper (any parameter), and a mapper passed to .catch', () => {
    for (const fn of [
      'guardedAction',
      'mapperAction',
      'secondParamMapperAction',
      'promiseCatchMapperAction',
    ]) {
      expect(serverFns).not.toContain(fn);
    }
    // A try block that cannot redirect is not a Server Action concern at all,
    // and a page render's own catch is not a Server Action.
    expect(serverFns).not.toContain('safeTryAction');
    expect(serverFns).not.toContain('load');
    expect(scan.guardedServerCatches).toBe(4);
  });

  it('says what is wrong in each report', () => {
    const byFn = new Map(scan.serverFindings.map((f) => [f.fn, f]));
    expect(byFn.get('bindinglessAction')?.problem).toMatch(/binds no error/);
    expect(byFn.get('logsFirstAction')?.problem).toMatch(/starts with `console\.error\(e\);`/);
    expect(byFn.get('staticMethodAction')?.reaches).toBe('ThingsService.forCurrentUser');
    expect(byFn.get('allSettledAction')?.kind).toBe('all-settled');
  });

  it('reports a caller that toasts over a redirect, and lets one that stops first through', () => {
    expect(callerFns).toEqual(
      ['clientPromiseCatch', 'clientSwallows', 'serverCallerReturns'].sort(),
    );
    expect(scan.guardedCallerCatches).toBe(4);
  });
});

/* ─────────────────────────────── the real tree ─────────────────────────────── */

describe('Server Action catches in apps/web/src', () => {
  const files = walk(WEB_SRC).map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));
  const scan = scanActionCatches(files, WEB_SRC);

  it('finds what it is meant to find (guards the scan itself)', () => {
    expect(scan.actionModules.length).toBeGreaterThan(80);
    expect(scan.redirecting).toContain(
      path.join(WEB_SRC, 'server/services/context.ts#withContext'),
    );
    expect(scan.redirecting).toContain(path.join(WEB_SRC, 'lib/auth/session.ts#requireOrgContext'));
    expect(scan.redirecting).toContain(path.join(WEB_SRC, 'lib/auth/session.ts#requireSession'));
    expect(scan.redirecting).toContain(path.join(WEB_SRC, 'lib/auth/session.ts#getServerSession'));
    expect(scan.redirecting).toContain(
      path.join(WEB_SRC, 'server/services/inventory.ts#InventoryService.forCurrentUser'),
    );
    expect(scan.guardedServerCatches).toBeGreaterThan(250);
  });

  it('has no Server Action catch that swallows a redirect', () => {
    expect(scan.serverFindings.map(describeFinding)).toEqual([]);
  });

  it('has no caller that shows an error for a Server Action that redirected', () => {
    expect(scan.callerFindings.map(describeFinding)).toEqual([]);
  });
});
