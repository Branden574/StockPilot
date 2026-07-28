import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import {
  linkFamily,
  suggestFamilies,
  unlinkItems,
} from '@/server/services/product-group-linking';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { DELETE, GET, POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: Date.now() + 60_000 })),
}));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));
vi.mock('@/server/services/product-groups', () => ({ ProductGroupsService: vi.fn() }));
vi.mock('@/server/services/product-group-linking', () => ({
  suggestFamilies: vi.fn(),
  linkFamily: vi.fn(),
  unlinkItems: vi.fn(),
}));

const ITEM_A = '11111111-1111-1111-1111-111111111111';
const GROUP_A = '22222222-2222-2222-2222-222222222222';

function buildCtx(over: Partial<{ role: 'owner' | 'manager' | 'staff'; modules: ModuleId[] }> = {}) {
  const stub = makeSupabaseStub({});
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: over.role ?? ('owner' as const),
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(over.modules ?? ['inventory', 'sports']),
  };
}

function req(method: string, body?: unknown, query = '') {
  return new Request(`https://test.local/api/v1/product-groups/linking${query}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as Parameters<typeof POST>[0];
}

const VALID_LINK = {
  groupId: GROUP_A,
  members: [{ itemId: ITEM_A, variantSize: '10' }],
  reason: 'Checked the rack',
};

beforeEach(() => vi.clearAllMocks());

describe('GET /api/v1/product-groups/linking', () => {
  it('401s without an auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    expect((await GET(req('GET'))).status).toBe(401);
  });

  it('403s when the sports module is off, without reading anything', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ modules: ['inventory'] }));
    const res = await GET(req('GET'));
    expect(res.status).toBe(403);
    expect(suggestFamilies).not.toHaveBeenCalled();
  });

  it('403s for a member without sports:manage', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ role: 'staff' }));
    const res = await GET(req('GET'));
    expect(res.status).toBe(403);
    expect(suggestFamilies).not.toHaveBeenCalled();
  });

  it('returns suggestions for an entitled caller', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    vi.mocked(suggestFamilies).mockResolvedValueOnce([
      {
        styleKey: 'pink shirt',
        baseName: 'Pink Shirt',
        members: [],
        caveats: ['Matched on the item name only.'],
        confidence: 'medium',
      },
    ]);
    const res = await GET(req('GET', undefined, '?limit=10'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });
});

describe('POST /api/v1/product-groups/linking', () => {
  it('401s without an auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    expect((await POST(req('POST', VALID_LINK))).status).toBe(401);
  });

  it('400s a body with no reason, and never reaches the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const res = await POST(req('POST', { ...VALID_LINK, reason: '  ' }));
    expect(res.status).toBe(400);
    expect(linkFamily).not.toHaveBeenCalled();
  });

  it('400s a body that names both an existing group and a new one', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const res = await POST(
      req('POST', {
        ...VALID_LINK,
        group: { name: 'X', subcategoryKey: 'shoes', defaultCountingUnit: 'pair' },
      }),
    );
    expect(res.status).toBe(400);
    expect(linkFamily).not.toHaveBeenCalled();
  });

  it('400s a member that is not a real item id (no heuristic input is accepted)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const res = await POST(
      req('POST', { ...VALID_LINK, members: [{ itemId: 'everything-like-this' }] }),
    );
    expect(res.status).toBe(400);
    expect(linkFamily).not.toHaveBeenCalled();
  });

  it('links and reports the count', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    vi.mocked(linkFamily).mockResolvedValueOnce({ groupId: GROUP_A, linked: 1 });
    const res = await POST(req('POST', VALID_LINK));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, groupId: GROUP_A, linked: 1 });
  });

  it('maps a service conflict (already in another group) to 409', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    vi.mocked(linkFamily).mockRejectedValueOnce(new ServiceError('conflict', 'already grouped'));
    expect((await POST(req('POST', VALID_LINK))).status).toBe(409);
  });
});

describe('DELETE /api/v1/product-groups/linking', () => {
  it('401s without an auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    expect((await DELETE(req('DELETE', { itemIds: [ITEM_A], reason: 'x' }))).status).toBe(401);
  });

  it('400s without a reason', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const res = await DELETE(req('DELETE', { itemIds: [ITEM_A], reason: '' }));
    expect(res.status).toBe(400);
    expect(unlinkItems).not.toHaveBeenCalled();
  });

  it('unlinks and reports the count', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    vi.mocked(unlinkItems).mockResolvedValueOnce({ unlinked: 1 });
    const res = await DELETE(req('DELETE', { itemIds: [ITEM_A], reason: 'wrong family' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, unlinked: 1 });
  });
});
