import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { screenCallback } from './__fixtures__/screen-functions';
import { createSequenceGuard } from './debounced-list-load';

/**
 * THE ADMIN LISTS DRAW ONLY ROWS READ FOR THE WORKSPACE ON SCREEN (B124).
 *
 * Audit log, Bins, Charters, Units of measure, Vendor mappings and
 * Warehouses keep their rows with the workspace they were read for. They drew
 * those rows without comparing it to the workspace on screen, and nothing
 * stopped an older read from landing last: after a switch, the previous
 * workspace's rows stood under the new one until its own read landed, or for
 * good when the older read finished later. Now each screen draws its rows
 * only for the workspace on screen (the receive.tsx pattern), and numbers its
 * reads with the sequence guard so only the newest one changes the list.
 *
 * Each screen's own `load` is RUN here twice, for workspace A and then B,
 * with A's read answering last (screen-functions.ts).
 */

const ORG_A = '0a000000-0000-0000-0000-00000000000a';
const ORG_B = '0b000000-0000-0000-0000-00000000000b';

const SCREENS = [
  'app/(drawer)/admin/audit.tsx',
  'app/(drawer)/admin/bins.tsx',
  'app/(drawer)/admin/charters.tsx',
  'app/(drawer)/admin/uom-conversions.tsx',
  'app/(drawer)/admin/vendor-mappings.tsx',
  'app/(drawer)/admin/warehouses.tsx',
] as const;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A PostgREST builder: every call returns it, and awaiting it answers `result` once `gate` opens. */
function query(result: unknown, gate: Promise<void>): unknown {
  const q: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            gate.then(() => result).then(res, rej);
        }
        return () => q;
      },
    },
  );
  return q;
}

/** One row per table, named for the workspace it was read for. */
function rowFor(org: string, table: string) {
  return {
    id: `${table}-${org}`,
    name: `${table} of ${org}`,
    event: 'item.updated',
    created_at: '2026-11-01T00:00:00Z',
    warehouse_id: `warehouses-${org}`,
    charter_id: `charters-${org}`,
  };
}

function clientFor(org: string, gate: Promise<void>) {
  return {
    from: (table: string) => query({ data: [rowFor(org, table)], error: null }, gate),
  };
}

function runScreen(file: string) {
  const state: { list: { orgId: string; rows: { id: string }[] } | null } = { list: null };
  const setList = (v: unknown) => {
    state.list =
      typeof v === 'function'
        ? (v as (p: unknown) => typeof state.list)(state.list)
        : (v as typeof state.list);
  };
  const guard = { current: createSequenceGuard() };
  const build = (orgId: string, gate: Promise<void>) =>
    screenCallback<() => Promise<void>>(file, 'load', {
      orgId,
      canView: true,
      isAdmin: true,
      supabase: clientFor(orgId, gate),
      setList,
      setFailed: () => undefined,
      setLoading: () => undefined,
      isRowPersonDeleted: () => false,
      guard,
      console: { warn: vi.fn() },
    });
  return { state, build };
}

describe('an older read that lands last never replaces the newer workspace’s rows', () => {
  it.each(SCREENS)('%s', async (file) => {
    const { state, build } = runScreen(file);
    const slowA = deferred();
    const loadA = build(ORG_A, slowA.promise)();
    // The switch to B: B's read answers first.
    await build(ORG_B, Promise.resolve())();
    expect(state.list?.orgId).toBe(ORG_B);
    // A's read lands last.
    slowA.resolve();
    await loadA;
    expect(state.list?.orgId).toBe(ORG_B);
    expect(state.list?.rows.every((r) => r.id.endsWith(ORG_B))).toBe(true);
  });
});

describe('only rows read for the workspace on screen are drawn', () => {
  it.each(SCREENS)('%s', (file) => {
    const src = readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
    expect(src).toContain(
      'const rows = list !== null && list.orgId === orgId ? list.rows : NO_ROWS;',
    );
    expect(src).toContain('const guard = React.useRef(createSequenceGuard());');
  });
});
