import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Intacct import's existing-SKU check batches each 500-record page.
 *
 * 500 SKUs in one `.in()` is far past the URL limit (a ~30-character SKU
 * costs about what a uuid does), so every page failed. The check decides what
 * gets created, so a failed batch throws: a missed "already exists" would
 * create a duplicate item.
 */

const created = vi.hoisted(() => [] as string[]);
const pages = vi.hoisted(() => ({ records: [] as Array<Record<string, unknown>> }));
/** What creating a SKU throws, for the per-row failure cases (S31). */
const failures = vi.hoisted(() => new Map<string, unknown>());

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

// The real ForbiddenError: RowFailures tells a warehouse refusal by it.
vi.mock('@/lib/auth/warehouse', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/warehouse')>()),
  getWarehouseAccess: vi.fn(async () => ({
    writableIds: ['wh-1'],
    readableIds: ['wh-1'],
    hasAllAccess: true,
  })),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
vi.mock('@/server/connectors/secret-store', () => ({
  getConnectionSecret: vi.fn(async () => ({
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  })),
  putConnectionSecret: vi.fn(),
}));
vi.mock('@/server/connectors/sage-intacct/oauth', () => ({ refreshTokens: vi.fn() }));
vi.mock('@/server/connectors/sage-intacct/client', () => ({
  IntacctClient: class {
    async queryPage(args: { object: string; start: number }) {
      if (args.object === 'inventory-control/item' && args.start === 1) {
        return { records: pages.records, nextStart: null };
      }
      return { records: [], nextStart: null };
    }
  },
}));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: class {
    async create(input: { sku: string }) {
      if (failures.has(input.sku)) throw failures.get(input.sku);
      created.push(input.sku);
      return { id: `id-${input.sku}` };
    }
  },
}));

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { encodedInValueLength, IN_FILTER_MAX_ENCODED_CHARS } from '@/lib/supabase/in-filter';
import {
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { reportError } from '@/lib/error-reporter';

import { ServiceError, type ServiceContext } from './context';
import { importItemsFromIntacct } from './intacct-import';

const skus = Array.from(
  { length: 500 },
  (_, i) => `SKU-${String(i).padStart(5, '0')}-${'X'.repeat(20)}`,
);

function ctxWith(itemsSelect: (call: MockCall) => { data: unknown; error: unknown }) {
  const stub = makeSupabaseStub({
    'org_connections.select': {
      data: [{ id: 'conn-1', status: 'active', secret_id: 'sec-1' }],
      error: null,
    },
    'inventory_items.select': itemsSelect as never,
  });
  const ctx = makeServiceContext(stub.client, {
    permissions: new Set(['integrations:manage', 'items:import']),
    enabledModules: new Set([...DEFAULT_MODULE_IDS, 'integrations' as ModuleId]),
  }) as unknown as ServiceContext;
  return ctx;
}

beforeEach(() => {
  vi.clearAllMocks();
  failures.clear();
  created.length = 0;
  pages.records = skus.map((id) => ({ id, name: id }));
});

describe('importItemsFromIntacct existing-SKU check', () => {
  it('checks a 500-SKU page in batches within the URL budget and skips an existing SKU from the last batch', async () => {
    const lists: string[][] = [];
    const ctx = ctxWith((call) => {
      const list = (inFilters(call).find(([c]) => c === 'sku')?.[1] ?? []) as string[];
      lists.push(list);
      return { data: list.includes(skus[499] as string) ? [{ sku: skus[499] }] : [], error: null };
    });
    const summary = await importItemsFromIntacct(ctx, { warehouseId: 'wh-1' });
    expect(lists.length).toBeGreaterThanOrEqual(5);
    expect(lists.flat()).toHaveLength(500);
    for (const l of lists) {
      expect(l.length).toBeLessThanOrEqual(100);
      expect(l.reduce((n, v) => n + encodedInValueLength(v) + 3, 0)).toBeLessThanOrEqual(
        IN_FILTER_MAX_ENCODED_CHARS,
      );
    }
    expect(summary.skippedExisting).toBe(1);
    expect(summary.created).toBe(499);
    expect(created).not.toContain(skus[499]);
  });

  it('throws and creates nothing when a batch fails', async () => {
    let n = 0;
    const ctx = ctxWith(() => {
      n += 1;
      return n === 3
        ? { data: null, error: { message: 'fetch failed' } }
        : { data: [], error: null };
    });
    await expect(importItemsFromIntacct(ctx, { warehouseId: 'wh-1' })).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(created).toEqual([]);
  });
});

// S31: the Intacct card showed each failed item's error text ("First errors:
// SKU: <message>"), and nothing was reported. A refusal the app wrote keeps
// its words; anything else says the fixed sentence, and the run sends one
// report.
describe("importItemsFromIntacct: a failed item never shows the error's text (S31)", () => {
  it('three unexpected failures: the fixed sentence on each, ONE report; a refusal keeps its words', async () => {
    const first = new Error('null value in column "name" of relation "inventory_items"');
    failures.set(skus[0] as string, first);
    failures.set(
      skus[1] as string,
      new TypeError("Cannot read properties of undefined (reading 'id')"),
    );
    failures.set(skus[2] as string, new Error('canceling statement due to statement timeout'));
    failures.set(
      skus[3] as string,
      new ServiceError('conflict', 'An item with that SKU already exists.'),
    );
    pages.records = skus.slice(0, 5).map((id) => ({ id, name: id }));
    const ctx = ctxWith(() => ({ data: [], error: null }));

    const summary = await importItemsFromIntacct(ctx, { warehouseId: 'wh-1' });

    expect(summary.created).toBe(1);
    expect(summary.failed).toBe(4);
    expect(summary.errors.map((e) => e.message)).toEqual([
      'Could not import this row.',
      'Could not import this row.',
      'Could not import this row.',
      'An item with that SKU already exists.',
    ]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(first, {
      tag: 'intacct_import.rows',
      organizationId: ctx.organizationId,
      extra: { failed: 3 },
    });
  });
});
