// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A return's line names. The page read every line's item in one `.in()` with
 * the error ignored; a return's lines follow its order's, which have no total
 * cap. Now 100 ids per request, and a failure (names are labels only) shows
 * the lines unnamed and is reported instead of vanishing silently.
 */

const { stubRef, rmaGet, reportError } = vi.hoisted(() => ({
  stubRef: { current: null as unknown },
  rmaGet: vi.fn(),
  reportError: vi.fn(async () => {}),
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  redirect: vi.fn(),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async (m: string) => ({ enabled: m === 'returns', canManage: false })),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'admin',
    permissions: new Set(['returns:read']),
  })),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => stubRef.current) }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/server/services/returns', () => ({
  RMAService: { forCurrentUser: vi.fn(async () => ({ get: rmaGet })) },
}));
vi.mock('@/server/services/shipping', () => ({ ShippingService: { forCurrentUser: vi.fn() } }));
vi.mock('@/components/returns/return-actions-panel', () => ({ ReturnActionsPanel: () => null }));

import { inFilters, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import ReturnDetailPage from './page';

const itemId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

beforeEach(() => {
  vi.clearAllMocks();
  rmaGet.mockResolvedValue({
    id: 'r1',
    return_number: 'RMA-1',
    status: 'requested',
    source: 'internal',
    reason: 'damaged',
    notes: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    order_request_id: '22222222-2222-2222-2222-222222222222',
    order_number: 7,
    reason_code: 'damaged',
    requester_name: null,
    requester_email: null,
    denial_reason: null,
    approved_at: null,
    received_at: null,
    closed_at: null,
    denied_at: null,
    lines: Array.from({ length: 250 }, (_, i) => ({
      id: `rl-${i}`,
      item_id: itemId(i),
      quantity: 1,
      disposition: null,
      applied: false,
    })),
  });
});

function stubWith(items: (call: MockCall) => { data: unknown; error: unknown }) {
  stubRef.current = makeSupabaseStub({ 'inventory_items.select': items as never }).client;
}

describe('return detail with 250 lines', () => {
  it('names every line, reading items 100 at a time', async () => {
    const lists: string[][] = [];
    stubWith((call) => {
      const ids = (inFilters(call).find(([c]) => c === 'id')?.[1] ?? []) as string[];
      lists.push(ids);
      return { data: ids.map((id) => ({ id, name: `Item ${id.slice(-3)}`, sku: null })), error: null };
    });
    render(await ReturnDetailPage({ params: Promise.resolve({ id: 'r1' }) }));
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(screen.getByText('Item 249')).toBeTruthy();
  });

  it('a failed batch still shows the return, and reports the missing names', async () => {
    let n = 0;
    stubWith(() =>
      ++n === 2 ? { data: null, error: { message: 'fetch failed' } } : { data: [], error: null },
    );
    render(await ReturnDetailPage({ params: Promise.resolve({ id: 'r1' }) }));
    expect(screen.getByText('RMA-1')).toBeTruthy();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'returns.detail.item_names', level: 'warning' }),
    );
  });
});
