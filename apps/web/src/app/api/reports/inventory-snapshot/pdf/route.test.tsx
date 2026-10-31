import { Readable } from 'node:stream';

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { exportRateLimited } from '@/lib/export-rate-limit';
import type { SnapshotPdfWarehouseGroup } from '@/lib/pdf/inventory-snapshot';
import { makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/export-rate-limit', () => ({ exportRateLimited: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn() }));
vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: vi.fn().mockImplementation(function () {
    return { primaryImagesForServerDecoding: vi.fn(async () => new Map()) };
  }),
}));
vi.mock('@react-pdf/renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@react-pdf/renderer')>();
  return { ...actual, renderToStream: vi.fn(async () => Readable.from([]) as never) };
});
// The header logo: the document must get only what this answers.
vi.mock('@/lib/pdf/image-prefetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pdf/image-prefetch')>()),
  prefetchPdfLogo: vi.fn(async () => null),
}));

// Imported AFTER the mocks above so the route picks them up.
import { renderToStream } from '@react-pdf/renderer';
import { prefetchPdfLogo } from '@/lib/pdf/image-prefetch';
import { GET } from './route';

/**
 * The snapshot's Location column. The route used to re-read every active
 * item's bin label with `.in('id', <every item in the org>)`, then every
 * primary location with a second `.in()`, both with the error ignored: past
 * ~215 items the local gateway refused it, past ~395 production failed after
 * ~7 s of retries, and either way the whole column printed blank. The label
 * now comes from the valuation's own paged read.
 */
describe('GET /api/reports/inventory-snapshot/pdf — locations', () => {
  const N = 1200;
  function itemPage(call: MockCall) {
    const [from, to] = call.args[call.methods.indexOf('range')] as [number, number];
    const all = Array.from({ length: N }, (_, i) => ({
      id: `item-${String(i).padStart(5, '0')}`,
      sku: `SKU-${i}`,
      name: `Item ${i}`,
      quantity_on_hand: 1,
      unit_cost: 2,
      warehouse: { name: 'DC4' },
      category: null,
      // Even rows carry a bin label; odd rows only a primary location.
      bin_location: i % 2 === 0 ? `R-${i}` : '  ',
      location: { name: `Loc ${i}` },
    }));
    return { data: all.slice(from, to + 1), error: null };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(exportRateLimited).mockResolvedValue(null as never);
  });

  it('1200 items: every row prints a location, read in the paged valuation stream with no .in()', async () => {
    const stub = makeSupabaseStub({
      'vw_inventory_valuation_by_warehouse.select': { data: [], error: null },
      'vw_inventory_valuation_by_category.select': { data: [], error: null },
      'inventory_items.select': itemPage,
      'organizations.select': { data: { name: 'Acme', logo_url: null }, error: null },
    });
    vi.mocked(withApiContext).mockResolvedValue({
      organizationId: 'org-1',
      userId: 'user-1',
      role: 'admin',
      supabase: stub.client,
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: new Set<ModuleId>([...DEFAULT_MODULE_IDS]),
    } as never);

    const res = await GET(new NextRequest('https://test.local/api/reports/inventory-snapshot/pdf?photos=0'));

    expect(res.status).toBe(200);
    const element = vi.mocked(renderToStream).mock.calls[0]?.[0] as unknown as {
      props: { groups: SnapshotPdfWarehouseGroup[] };
    };
    const rows = element.props.groups.flatMap((g) => g.rows);
    expect(rows).toHaveLength(N);
    const byId = new Map(rows.map((r) => [r.itemId, r.location]));
    expect(byId.get('item-00000')).toBe('R-0');
    // A blank bin label falls back to the primary location's name.
    expect(byId.get('item-00001')).toBe('Loc 1');
    // Past the first 1000-row page as well.
    expect(byId.get('item-01199')).toBe('Loc 1199');
    expect(rows.every((r) => r.location)).toBe(true);
    // No id-list re-read of items or locations.
    for (const [key, chains] of stub.chainsAll) {
      for (const chain of chains) expect(chain, key).not.toContain('in');
    }
    expect(stub.fromCalls).not.toContain('locations');
  });
});

/**
 * Security invariant (2026-09-28): reports:export and the valuation report's
 * gate (reports:read) are checked BEFORE the shared export limit.
 */
describe('GET /api/reports/inventory-snapshot/pdf — checks before the export budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(exportRateLimited).mockResolvedValue(null as never);
  });

  it.each([
    ['no reports:export', { role: 'staff' }],
    ['reports:export without reports:read', { role: 'viewer', permissions: new Set(['reports:export']) }],
  ] as const)('%s: 403, budget untouched, nothing read', async (_label, who) => {
    const stub = makeSupabaseStub({});
    vi.mocked(withApiContext).mockResolvedValue({
      organizationId: 'org-1',
      userId: 'user-1',
      supabase: stub.client,
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: new Set<ModuleId>([...DEFAULT_MODULE_IDS]),
      ...who,
    } as never);
    const res = await GET(new NextRequest('https://test.local/api/reports/inventory-snapshot/pdf'));
    expect(res.status).toBe(403);
    expect(exportRateLimited).not.toHaveBeenCalled();
    expect(stub.fromCalls).toEqual([]);
  });
});

/**
 * The organization logo in the snapshot's header. logo_url is set by an owner
 * or admin and the database does not hold it to the logo bucket, so the route
 * resolves it through prefetchPdfLogo (a guarded fetch, bytes back) and the
 * document gets only that answer, never the stored value.
 */
describe('GET /api/reports/inventory-snapshot/pdf — the header logo', () => {
  const STORED = 'https://proj.supabase.co/storage/v1/object/public/org-logos/org-1/logo-1.png';
  const LOGO_BYTES = 'data:image/png;base64,TE9HTw==';

  function signInWithLogo() {
    const stub = makeSupabaseStub({
      'vw_inventory_valuation_by_warehouse.select': { data: [], error: null },
      'vw_inventory_valuation_by_category.select': { data: [], error: null },
      'inventory_items.select': { data: [], error: null },
      'organizations.select': { data: { name: 'Acme', logo_url: STORED }, error: null },
    });
    vi.mocked(withApiContext).mockResolvedValue({
      organizationId: 'org-1',
      userId: 'user-1',
      role: 'admin',
      supabase: stub.client,
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: new Set<ModuleId>([...DEFAULT_MODULE_IDS]),
    } as never);
  }

  function renderedOrg(): { name: string; logoUrl: string | null } {
    const element = vi.mocked(renderToStream).mock.calls[0]?.[0] as unknown as {
      props: { org: { name: string; logoUrl: string | null } };
    };
    return element.props.org;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(exportRateLimited).mockResolvedValue(null as never);
  });

  it('prints the stored logo from the bytes prefetchPdfLogo answers', async () => {
    signInWithLogo();
    vi.mocked(prefetchPdfLogo).mockResolvedValueOnce(LOGO_BYTES);
    const res = await GET(
      new NextRequest('https://test.local/api/reports/inventory-snapshot/pdf?photos=0'),
    );
    expect(res.status).toBe(200);
    expect(prefetchPdfLogo).toHaveBeenCalledTimes(1);
    expect(prefetchPdfLogo).toHaveBeenCalledWith(STORED);
    expect(renderedOrg()).toEqual({ name: 'Acme', logoUrl: LOGO_BYTES });
  });

  it('prints no logo when prefetchPdfLogo answers none, whatever is stored', async () => {
    signInWithLogo();
    vi.mocked(prefetchPdfLogo).mockResolvedValueOnce(null);
    const res = await GET(
      new NextRequest('https://test.local/api/reports/inventory-snapshot/pdf?photos=0'),
    );
    expect(res.status).toBe(200);
    expect(renderedOrg()).toEqual({ name: 'Acme', logoUrl: null });
  });
});
