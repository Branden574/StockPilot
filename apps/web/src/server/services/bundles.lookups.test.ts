import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';
import { DEFAULT_MODULE_IDS } from '@stockpilot/core';

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { BundlesService } from './bundles';

/**
 * Bundles is an optional module, and Schedule depends only on Inventory, so an
 * organization can have the Schedule with Bundles off. New event and Edit
 * event loaded their Bundle box with `list()`, which throws when the module is
 * off, so both were "Something broke loading this page" and no event could be
 * added or changed on the web (B67). The same class as the Suppliers pickers
 * (suppliers.lookups.test.ts).
 */

const BUNDLE_ID = '0a000000-0000-4000-8000-0000000000b7';
const ROWS = [
  {
    id: BUNDLE_ID,
    name: 'Sample starter kit',
    sku: 'KIT-1',
    is_active: true,
    preassembly_enabled: false,
    phantom_item_id: null,
    archived_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    components: [{ item_id: 'item-1' }],
    phantom: null,
  },
];

function svc(bundlesOn: boolean) {
  const enabledModules = new Set<ModuleId>(DEFAULT_MODULE_IDS);
  if (bundlesOn) enabledModules.add('bundles');
  else enabledModules.delete('bundles');
  const stub = makeSupabaseStub({
    'bundles.select': { data: ROWS, error: null },
    'bundle_distributions.select': { data: [], error: null },
  });
  return { stub, service: new BundlesService(makeServiceContext(stub.client, { enabledModules })) };
}

describe('BundlesService.listForLookups', () => {
  it('module OFF: an empty list, and the table is never read', async () => {
    const { stub, service } = svc(false);
    await expect(service.listForLookups()).resolves.toEqual([]);
    expect(stub.fromCalls).not.toContain('bundles');
  });

  it('module ON: exactly what list() returns', async () => {
    const { service } = svc(true);
    const listed = await service.list();
    expect(listed.map((b) => b.id)).toEqual([BUNDLE_ID]);
    await expect(service.listForLookups()).resolves.toEqual(listed);
  });

  it('the strict list() still refuses when the module is off (the Bundles screens and API rely on it)', async () => {
    const { service } = svc(false);
    await expect(service.list()).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('module ON and the read fails: it throws, never an empty Bundle box for a list that could not be read', async () => {
    // A deliberate decision (B67): turning a failed read into [] would show
    // an empty Bundle box, as if the organization had no bundles, for a list
    // that could not be read. The page fails and the error is reported.
    const enabledModules = new Set<ModuleId>(DEFAULT_MODULE_IDS);
    enabledModules.add('bundles');
    const stub = makeSupabaseStub({
      'bundles.select': { data: null, error: { message: 'canceling statement due to statement timeout' } },
      'bundle_distributions.select': { data: [], error: null },
    });
    const service = new BundlesService(makeServiceContext(stub.client, { enabledModules }));
    await expect(service.listForLookups()).rejects.toMatchObject({ code: 'internal_error' });
    expect(stub.fromCalls).toContain('bundles');
  });
});

describe('no page outside Bundles asks for bundles in a way that crashes when the module is off', () => {
  const DASHBOARD = path.resolve(__dirname, '../../app/(dashboard)/dashboard');
  const BUNDLES_SCREENS = path.join(DASHBOARD, 'bundles');

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return files(full);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });
  }

  it('every caller outside the Bundles screens uses listForLookups()', () => {
    const offenders: string[] = [];
    let callers = 0;
    for (const file of files(DASHBOARD)) {
      if (file.startsWith(BUNDLES_SCREENS + path.sep)) continue;
      const code = readFileSync(file, 'utf8');
      if (!code.includes('BundlesService')) continue;
      callers += 1;
      // A BundlesService instance (however it is named) calling the strict list().
      if (/(bundlesSvc|BundlesService\.forCurrentUser\(\)\))\.list\(/.test(code)) {
        offenders.push(path.relative(DASHBOARD, file));
      }
    }
    // Proves the scan saw the callers it is meant to police: New event, Edit
    // event and the event's page.
    expect(callers).toBeGreaterThanOrEqual(3);
    expect(offenders).toEqual([]);
  });
});
