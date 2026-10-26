import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  scanPendingFlags,
  type PendingFlagFinding,
  type ScanFile,
  type ScanRoot,
} from '@/test/pending-flag-scan';

/**
 * RECURRENCE GUARD (B40): no busy flag is cleared only when a request resolves.
 *
 * Items > Save view set `saving`, awaited createSavedViewAction with no catch
 * and cleared `saving` on the next line. A Server Action call rejects when the
 * browser is offline, when the connection drops, when the server fails before
 * the action can answer and when a deploy no longer has the action; the
 * phone's api() rejects on every answer that is not 2xx. The clearing line was
 * never reached: the spinner stayed on and nothing was said.
 *
 * Every web component and every phone screen that sets a busy flag, then
 * awaits something that can reject (a Server Action, fetch, the phone's api(),
 * or a function that reaches one of them), must clear the flag in `finally`
 * (or in a catch), and say what did not happen. See src/test/pending-flag-scan.ts
 * for what counts as a flag and what is followed.
 *
 * IF THIS FAILS: wrap the call in try/catch/finally. The catch lets Next's
 * control flow through first (`if (isControlFlow(e)) return;`, lib/control-flow.ts,
 * which B12's guard also enforces), then shows the component's own failure
 * message (on the web, requestFailedMessage('save the view') from
 * lib/request-failure.ts; on the phone, the screen's own copy or
 * CONNECTION_FAILURE_COPY); `finally` clears the flag.
 */

const WEB_ROOT = path.resolve(__dirname, '../..');
const WEB_SRC = path.join(WEB_ROOT, 'src');
const MOBILE_ROOT = path.resolve(WEB_ROOT, '../mobile');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        ['node_modules', '.next', '.expo', 'dist', '__fixtures__', '__mocks__'].includes(entry.name)
      )
        continue;
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

function describeFinding(f: PendingFlagFinding, base: string): string {
  const where = `${path.relative(base, f.file)}:${f.line} ${f.fn}: ${f.flag} (set at ${f.setLine}, cleared at ${f.clearLine})`;
  return f.problem === 'stays-set'
    ? `${where} stays set when the ${f.kind} of ${f.reaches} rejects`
    : `${where} is cleared in finally, but nothing catches the ${f.kind} of ${f.reaches}, so a rejection says nothing`;
}

/* ─────────────────────────────── self-test ─────────────────────────────── */

const V = '/virtual/web/';
const M = '/virtual/mobile/';
const PLANTED_ROOTS: ScanRoot[] = [
  { prefix: V, srcRoot: `${V}src` },
  { prefix: M, srcRoot: `${M}src` },
];
const PLANTED: ScanFile[] = [
  {
    path: `${V}src/server/actions/things.ts`,
    text: [
      `'use server';`,
      `export async function saveThingAction(name: string) { return { ok: true as const, name }; }`,
      `export async function deleteThingAction(id: string) { return { ok: true as const, id }; }`,
    ].join('\n'),
  },
  {
    path: `${V}src/lib/thing-client.ts`,
    text: [
      `import { saveThingAction } from '@/server/actions/things';`,
      `export async function loadThings() { const r = await fetch('/api/things'); return r.json(); }`,
      `export async function quietLoad() { try { return await fetch('/api/things'); } catch { return null; } }`,
      `export function saveViaHelper(name: string) { return saveThingAction(name); }`,
      `export const arrowHelper = (name: string) => saveThingAction(name);`,
      `export function check(x: unknown) { if (!x) throw new Error('missing'); return x; }`,
    ].join('\n'),
  },
  {
    path: `${V}src/lib/barrel.ts`,
    text: `export { loadThings as loadAgain } from './thing-client';\n`,
  },
  {
    path: `${V}src/components/planted.tsx`,
    text: [
      `'use client';`,
      `import * as React from 'react';`,
      `import { isControlFlow } from '@/lib/control-flow';`,
      `import { saveThingAction, deleteThingAction } from '@/server/actions/things';`,
      `import * as things from '@/server/actions/things';`,
      `import { loadThings, quietLoad, saveViaHelper, arrowHelper, check } from '@/lib/thing-client';`,
      `import { loadAgain } from '@/lib/barrel';`,
      `declare const toast: { error(m: string): void };`,
      `declare const supabase: { from(t: string): { update(v: unknown): Promise<{ error: unknown }> } };`,
      `export function Planted() {`,
      `  const [saving, setSaving] = React.useState(false);`,
      `  const [busy, setBusy] = React.useState<string | null>(null);`,
      `  const [phase, setPhase] = React.useState<'idle' | 'saving' | 'done'>('idle');`,
      `  const [items, setItems] = React.useState<unknown[]>([]);`,
      `  const [editing, setEditing] = React.useState(false);`,
      `  const [error, setError] = React.useState<string | null>(null);`,
      `  const busyRef = React.useRef(false);`,
      `  const load = React.useCallback(async () => { try { setItems(await loadThings()); } catch { setError('x'); } }, []);`,
      `  const loadLoud = React.useCallback(async () => { setItems(await loadThings()); }, []);`,
      // Reported:
      `  async function b40Shape() { setSaving(true); const res = await saveThingAction('a'); setSaving(false); if (!res.ok) toast.error('x'); }`,
      `  async function stringFlag(id: string) { setBusy(\`del-\${id}\`); await deleteThingAction(id); setBusy(null); }`,
      `  async function phaseFlag() { setPhase('saving'); await saveThingAction('a'); setPhase('done'); }`,
      `  async function viaFetchHelper() { setSaving(true); setItems(await loadThings()); setSaving(false); }`,
      `  async function viaReturnedAction() { setSaving(true); await saveViaHelper('a'); setSaving(false); }`,
      `  async function viaArrowHelper() { setSaving(true); await arrowHelper('a'); setSaving(false); }`,
      `  async function viaReexport() { setSaving(true); await loadAgain(); setSaving(false); }`,
      `  async function viaNamespace() { setSaving(true); await things.saveThingAction('a'); setSaving(false); }`,
      `  async function viaLocalCallback() { setSaving(true); await loadLoud(); setSaving(false); }`,
      `  async function viaFetch() { setSaving(true); await fetch('/x'); setSaving(false); }`,
      `  async function viaAll() { setSaving(true); await Promise.all(['a'].map((n) => saveThingAction(n))); setSaving(false); }`,
      `  async function throwsInWindow() { setSaving(true); const { error: e } = await supabase.from('t').update({}); if (e) throw e; setSaving(false); }`,
      `  async function viaThrowingHelper(x: unknown) { setSaving(true); await check(x); setSaving(false); }`,
      `  async function catchReturnsEarly() { setSaving(true); try { await saveThingAction('a'); } catch (e) { if (isControlFlow(e)) return; toast.error('x'); return; } setSaving(false); }`,
      `  async function catchRethrows() { setSaving(true); try { await saveThingAction('a'); } catch (e) { throw e; } setSaving(false); }`,
      `  async function clearedInsideTry() { setSaving(true); try { await saveThingAction('a'); setSaving(false); } catch (e) { if (isControlFlow(e)) return; toast.error('x'); } }`,
      `  function thenNoCatch() { setSaving(true); void saveThingAction('a').then(() => setSaving(false)); }`,
      `  function thenCatchKeepsFlag() { setSaving(true); saveThingAction('a').then(() => setSaving(false)).catch(() => toast.error('x')); }`,
      `  async function refFlag() { busyRef.current = true; await saveThingAction('a'); busyRef.current = false; }`,
      // Not reported:
      `  async function finallyClears() { setSaving(true); try { const res = await saveThingAction('a'); if (!res.ok) toast.error('x'); } catch (e) { if (isControlFlow(e)) return; toast.error('y'); } finally { setSaving(false); } }`,
      `  async function catchClears() { setSaving(true); try { await saveThingAction('a'); } catch (e) { if (isControlFlow(e)) return; setSaving(false); toast.error('x'); return; } setSaving(false); }`,
      `  async function catchFallsThrough() { setSaving(true); let ok = false; try { await saveThingAction('a'); ok = true; } catch (e) { if (isControlFlow(e)) return; toast.error('x'); } setSaving(false); if (ok) toast.error('done'); }`,
      `  async function quietHelper() { setSaving(true); await quietLoad(); setSaving(false); }`,
      `  async function quietCallback() { setSaving(true); await load(); setSaving(false); }`,
      `  async function supabaseOnly() { setSaving(true); const { error: e } = await supabase.from('t').update({}); setSaving(false); if (e) toast.error('x'); }`,
      `  async function allSettled() { setSaving(true); await Promise.allSettled([saveThingAction('a')]); setSaving(false); }`,
      `  async function caughtChain() { setSaving(true); await saveThingAction('a').catch(() => null); setSaving(false); }`,
      `  function thenCatchClears() { setSaving(true); void saveThingAction('a').then(() => toast.error('ok')).catch(() => setSaving(false)).finally(() => setSaving(false)); }`,
      `  async function notAFlag() { setItems([]); setItems(await loadThings()); }`,
      `  async function editingIsNotBusy() { setEditing(true); await saveThingAction('a'); setEditing(false); }`,
      `  async function errorIsNotBusy() { setError(null); await saveThingAction('a'); setError('x'); }`,
      `  async function setAfterOnly() { const res = await saveThingAction('a'); setSaving(false); return res; }`,
      `  async function nestedCallbackClears() { setSaving(true); window.setTimeout(() => setSaving(false), 10); await saveThingAction('a'); }`,
      // A callback made while the flag is set, which awaits and then clears it:
      `  function effectTimer() { setSaving(true); const t = window.setTimeout(async () => { await saveThingAction('a'); setSaving(false); }, 10); return () => window.clearTimeout(t); }`,
      `  function transitionAfterFlag() { setSaving(true); React.startTransition(async () => { await saveThingAction('a'); setSaving(false); }); }`,
      `  function effectTimerCaught() { setBusy('x'); window.setTimeout(async () => { try { await saveThingAction('a'); } catch (e) { if (isControlFlow(e)) return; toast.error('x'); } finally { setBusy(null); } }, 10); }`,
      `  function callbackOwnsItsWindow() { setSaving(true); window.setTimeout(async () => { setSaving(true); try { await saveThingAction('a'); } catch (e) { if (isControlFlow(e)) return; toast.error('x'); } finally { setSaving(false); } }, 10); setSaving(false); }`,
      // A finally clears the flag, but a rejection reaches no catch (reported unless a caller here catches):
      `  async function finallyOnlyHandler() { setSaving(true); try { await saveThingAction('a'); } finally { setSaving(false); } }`,
      `  async function finallyOnlyCaught() { setSaving(true); try { await saveThingAction('a'); } finally { setSaving(false); } }`,
      `  async function callsAndCatches() { try { await finallyOnlyCaught(); } catch (e) { if (isControlFlow(e)) return; toast.error('x'); } }`,
      `  function thenFinallyOnly() { setSaving(true); void saveThingAction('a').then(() => toast.error('ok')).finally(() => setSaving(false)); }`,
      `  const handlers = { onClick: finallyOnlyHandler, onSave: callsAndCatches, onThen: thenFinallyOnly };`,
      `  return [saving, busy, phase, items, editing, error, handlers];`,
      `}`,
      `export async function exportedFinallyOnly(setSaving: (b: boolean) => void) { setSaving(true); try { await saveThingAction('a'); } finally { setSaving(false); } }`,
    ].join('\n'),
  },
  {
    path: `${M}src/lib/api.ts`,
    text: [
      `export async function api<T>(p: string): Promise<T> {`,
      `  try { const res = await fetch(p); if (!res.ok) throw new Error('refused'); return (await res.json()) as T; }`,
      `  catch (err) { throw err; }`,
      `}`,
      `export async function fetchRows() { return api<unknown[]>('/rows'); }`,
    ].join('\n'),
  },
  {
    path: `${M}app/rows.tsx`,
    text: [
      `import * as React from 'react';`,
      `import { api, fetchRows } from '@/lib/api';`,
      `export default function Rows() {`,
      `  const [refreshing, setRefreshing] = React.useState(false);`,
      `  const [loadingMore, setLoadingMore] = React.useState(false);`,
      `  const [rows, setRows] = React.useState<unknown[]>([]);`,
      `  const load = React.useCallback(async () => { try { setRows(await fetchRows()); } catch { setRows([]); } }, []);`,
      `  async function refresh() { setRefreshing(true); await load(); setRefreshing(false); }`,
      `  async function loadMore() { setLoadingMore(true); const more = await api<unknown[]>('/rows?page=2'); setRows((r) => [...r, ...more]); setLoadingMore(false); }`,
      `  const [saving, setSaving] = React.useState(false);`,
      `  async function saveRow() { setSaving(true); try { await api('/rows', { method: 'POST' }); } finally { setSaving(false); } }`,
      `  const props = { onPress: saveRow };`,
      `  return [refreshing, loadingMore, rows, refresh, loadMore, saving, props];`,
      `}`,
    ].join('\n'),
  },
];

/**
 * Planted windows that are cleared on every path AND whose rejection is
 * handled: finallyClears, catchClears, catchFallsThrough, thenCatchClears,
 * effectTimerCaught, the timer in callbackOwnsItsWindow, finallyOnlyCaught
 * (its caller catches) and exportedFinallyOnly (its callers are in other
 * modules, so it is not judged).
 */
const GUARDED_PLANTED = 8;

describe('the pending-flag scan (self-test on planted files)', () => {
  const scan = scanPendingFlags(PLANTED, PLANTED_ROOTS);
  const reported = scan.findings.map((f) => f.fn).sort();

  it('reports every planted flag that a rejection leaves set, and only those', () => {
    expect(reported).toEqual(
      [
        'b40Shape',
        '(React.startTransition callback)',
        '(window.setTimeout callback)',
        'catchReturnsEarly',
        'catchRethrows',
        'clearedInsideTry',
        'finallyOnlyHandler',
        'loadMore',
        'phaseFlag',
        'refFlag',
        'stringFlag',
        'saveRow',
        'thenCatchKeepsFlag',
        'thenFinallyOnly',
        'thenNoCatch',
        'throwsInWindow',
        'viaAll',
        'viaArrowHelper',
        'viaFetch',
        'viaFetchHelper',
        'viaLocalCallback',
        'viaNamespace',
        'viaReexport',
        'viaReturnedAction',
        'viaThrowingHelper',
      ].sort(),
    );
  });

  it('accepts finally, a catch that clears, a catch that falls through, and calls that cannot reject', () => {
    for (const fn of [
      'finallyClears',
      'catchClears',
      'catchFallsThrough',
      'quietHelper',
      'quietCallback',
      'supabaseOnly',
      'allSettled',
      'caughtChain',
      'thenCatchClears',
      'notAFlag',
      'editingIsNotBusy',
      'errorIsNotBusy',
      'setAfterOnly',
      'nestedCallbackClears',
      'refresh',
      'effectTimerCaught',
      'callbackOwnsItsWindow',
      'finallyOnlyCaught',
      'callsAndCatches',
      'exportedFinallyOnly',
    ]) {
      expect(reported).not.toContain(fn);
    }
    expect(scan.guarded).toBe(GUARDED_PLANTED);
  });

  it('says what stays set and what can reject', () => {
    const byFn = new Map(scan.findings.map((f) => [f.fn, f]));
    expect(byFn.get('b40Shape')).toMatchObject({
      flag: 'setSaving',
      kind: 'await',
      reaches: 'saveThingAction',
    });
    expect(byFn.get('viaFetchHelper')?.reaches).toBe('loadThings');
    expect(byFn.get('viaNamespace')?.reaches).toBe('saveThingAction');
    expect(byFn.get('throwsInWindow')?.kind).toBe('throw');
    expect(byFn.get('thenNoCatch')?.kind).toBe('then');
    expect(byFn.get('refFlag')?.flag).toBe('busyRef.current');
    expect(byFn.get('loadMore')).toMatchObject({ flag: 'setLoadingMore', reaches: 'api' });
    expect(scan.rejecting.size).toBeGreaterThan(0);
  });

  it('tells a flag left set apart from a rejection that says nothing', () => {
    const byFn = new Map(scan.findings.map((f) => [f.fn, f]));
    expect(byFn.get('b40Shape')?.problem).toBe('stays-set');
    expect(byFn.get('(window.setTimeout callback)')).toMatchObject({
      problem: 'stays-set',
      flag: 'setSaving',
    });
    for (const fn of ['finallyOnlyHandler', 'thenFinallyOnly', 'saveRow']) {
      expect(byFn.get(fn)?.problem).toBe('says-nothing');
    }
  });
});

/* ─────────────────────────────── the real trees ─────────────────────────────── */

describe('busy flags in the web app and the phone app', () => {
  const files = [
    ...walk(WEB_SRC),
    ...walk(path.join(MOBILE_ROOT, 'app')),
    ...walk(path.join(MOBILE_ROOT, 'src')),
  ].map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));
  const roots: ScanRoot[] = [
    { prefix: `${WEB_ROOT}${path.sep}`, srcRoot: WEB_SRC },
    { prefix: `${MOBILE_ROOT}${path.sep}`, srcRoot: path.join(MOBILE_ROOT, 'src') },
  ];
  const scan = scanPendingFlags(files, roots);
  const base = path.resolve(WEB_ROOT, '../..');

  it('finds what it is meant to find (guards the scan itself)', () => {
    const keys = [...scan.rejecting];
    // The phone's api() and a web fetch helper are followed.
    expect(keys.some((k) => k.startsWith(path.join(MOBILE_ROOT, 'src/lib/api.ts#')))).toBe(true);
    expect(scan.guarded).toBeGreaterThan(100);
  });

  it('has no busy flag that a rejected request leaves set', () => {
    expect(scan.findings.map((f) => describeFinding(f, base))).toEqual([]);
  });
});
