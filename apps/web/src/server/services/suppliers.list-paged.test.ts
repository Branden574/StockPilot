import { describe, expect, it } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import {
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type SupabaseStub,
} from '@/test/supabase-mock';

import { SuppliersService } from './suppliers';

/**
 * SuppliersService.list was ONE read ordered by name, with no range, so
 * PostgREST's 1000-row max_rows cut it off with no error: past 1000 suppliers
 * (a Sage 50 import can create that many at once), every supplier whose name
 * sorts after the first 1000 was missing from the Supplier picker on the add
 * and edit forms, the Supplier filter, purchase orders and the Suppliers page
 * (B47). The list is now read page by page, ordered by name and then id, and
 * still refuses before any read when the Suppliers module is off.
 */

const ORG = 'org-test';

function suppliers(
  n: number,
  over: Record<string, unknown> = {},
  prefix = 'A supplier',
  idPrefix = '00000000',
) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${idPrefix}-0000-4000-8000-${String(i).padStart(12, '0')}`,
    organization_id: ORG,
    name: `${prefix} ${String(i).padStart(4, '0')}`,
    deleted_at: null,
    ...over,
  }));
}

const ZEBRA = {
  id: 'ffffffff-0000-4000-8000-000000000001',
  organization_id: ORG,
  name: 'Zebra Supply',
  deleted_at: null,
};
const ARCHIVED = suppliers(4, { deleted_at: '2026-03-01T00:00:00Z' }, 'B archived', 'aaaaaaaa');
const OTHER_ORG = suppliers(2, { organization_id: 'org-other' }, 'A other', 'dddddddd');
const ROWS = [...suppliers(1200), ZEBRA, ...ARCHIVED, ...OTHER_ORG];

function pageArgs(stub: SupabaseStub, key: string, page: number, method: string): unknown[][] {
  const methods = stub.chainsAll.get(key)?.[page] ?? [];
  const args = stub.chainArgsAll.get(key)?.[page] ?? [];
  return methods.flatMap((m, i) => (m === method ? [args[i]!] : []));
}

function svc(suppliersOn: boolean) {
  const enabledModules = new Set<ModuleId>(DEFAULT_MODULE_IDS);
  if (suppliersOn) enabledModules.add('suppliers');
  else enabledModules.delete('suppliers');
  const stub = makeSupabaseStub({ 'suppliers.select': servedLikePostgrest(ROWS) });
  return {
    stub,
    service: new SuppliersService(makeServiceContext(stub.client, { enabledModules }) as never),
  };
}

describe('SuppliersService.list reads every page', () => {
  it('module on: list() returns all 1201 suppliers, the last by name included, in two pages by name then id', async () => {
    const { stub, service } = svc(true);

    const list = await service.list();

    expect(list).toHaveLength(1201);
    expect(list.at(-1)?.id).toBe(ZEBRA.id);
    expect(stub.chainsAll.get('suppliers.select')).toHaveLength(2);
    expect(pageArgs(stub, 'suppliers.select', 0, 'order').map((a) => a[0])).toEqual(['name', 'id']);
    expect(pageArgs(stub, 'suppliers.select', 0, 'range')).toEqual([[0, 999]]);
    expect(pageArgs(stub, 'suppliers.select', 1, 'range')).toEqual([[1000, 1999]]);
    for (const page of [0, 1]) {
      expect(pageArgs(stub, 'suppliers.select', page, 'eq')).toContainEqual([
        'organization_id',
        ORG,
      ]);
      expect(pageArgs(stub, 'suppliers.select', page, 'is')).toContainEqual(['deleted_at', null]);
    }
  });

  it('module on: listForLookups() returns the same 1201', async () => {
    const { service } = svc(true);

    const list = await service.listForLookups();

    expect(list).toHaveLength(1201);
    expect(list.at(-1)?.id).toBe(ZEBRA.id);
  });

  it('includeArchived returns only the archived suppliers', async () => {
    const { service } = svc(true);

    const list = await service.list({ includeArchived: true });

    expect(list.map((s) => s.id)).toEqual(ARCHIVED.map((s) => s.id));
  });

  it('module off: listForLookups() is [] and list() refuses, both before any read', async () => {
    const { stub, service } = svc(false);

    await expect(service.listForLookups()).resolves.toEqual([]);
    await expect(service.list()).rejects.toMatchObject({ code: 'module_disabled' });
    expect(stub.fromCalls).not.toContain('suppliers');
  });
});
