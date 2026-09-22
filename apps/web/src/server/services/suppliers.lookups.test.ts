import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ModuleId } from '@stockpilot/core';
import { DEFAULT_MODULE_IDS } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { SuppliersService } from './suppliers';

/**
 * Suppliers is an optional module. Pages that only need supplier names for a
 * picker, a filter or a label used to call `list()`, which throws when the
 * module is off. On production on 2026-09-22, in an organization with
 * Suppliers off, that turned Items, Books and Rentals -> Items into "Something
 * broke loading this page" for a member of staff.
 */

const ROWS = [{ id: 's1', name: 'Acme', deleted_at: null }];

function svc(suppliersOn: boolean) {
  const enabledModules = new Set<ModuleId>(DEFAULT_MODULE_IDS);
  if (suppliersOn) enabledModules.add('suppliers');
  else enabledModules.delete('suppliers');
  const stub = makeSupabaseStub({ 'suppliers.select': { data: ROWS, error: null } });
  return { stub, service: new SuppliersService(makeServiceContext(stub.client, { enabledModules })) };
}

describe('SuppliersService.listForLookups', () => {
  it('module OFF: an empty list, and the table is never read', async () => {
    const { stub, service } = svc(false);
    await expect(service.listForLookups()).resolves.toEqual([]);
    expect(stub.fromCalls).not.toContain('suppliers');
  });

  it('module ON: exactly what list() returns', async () => {
    const { service } = svc(true);
    await expect(service.listForLookups()).resolves.toEqual(ROWS);
  });

  it('the strict list() still refuses when the module is off (the Suppliers screens and API rely on it)', async () => {
    const { service } = svc(false);
    await expect(service.list()).rejects.toMatchObject({ code: 'module_disabled' });
  });
});

describe('no page or route asks for suppliers in a way that crashes when the module is off', () => {
  const APP = path.resolve(__dirname, '../../app');
  const SUPPLIERS_SCREENS = path.join(APP, '(dashboard)/dashboard/suppliers');

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return files(full);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });
  }

  it('every caller outside the Suppliers screens uses listForLookups()', () => {
    const offenders: string[] = [];
    let callers = 0;
    for (const file of files(APP)) {
      if (file.startsWith(SUPPLIERS_SCREENS)) continue;
      const code = readFileSync(file, 'utf8');
      if (!code.includes('SuppliersService')) continue;
      callers += 1;
      // A SuppliersService instance (however it is named) calling the strict list().
      if (/(suppliers?Svc|SuppliersService\.forCurrentUser\(\)\))\.list\(/.test(code)) {
        offenders.push(path.relative(APP, file));
      }
    }
    // Proves the scan saw the callers it is meant to police.
    expect(callers).toBeGreaterThanOrEqual(15);
    expect(offenders).toEqual([]);
  });
});
