import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceError } from '@/server/services/context';

/**
 * B66: four record pages answered Page not found for ANY failed read of their
 * record, so a database error or a timeout told the person the bundle or the
 * order did not exist, and nothing was reported. Each now says not found only
 * for a missing record; any other failure reaches the dashboard's error page,
 * which says the page could not be loaded, offers Try again and reports it
 * (app/(dashboard)/error.tsx). The module-off case is module-gates.check-failed
 * .test.tsx's: the page checks its module before it reads.
 */

const h = vi.hoisted(() => ({ failure: null as unknown }));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: true })),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'owner',
    permissions: new Set(['bundles:read', 'bundles:manage', 'bundles:distribute']),
  })),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    throw new Error('read past the record');
  }),
}));
const rejectRecord = vi.fn(async () => {
  throw h.failure;
});
vi.mock('@/server/services/bundles', () => ({
  BundlesService: { forCurrentUser: vi.fn(async () => ({ get: rejectRecord })) },
}));
vi.mock('@/server/services/order-requests', () => ({
  OrderRequestsService: { forCurrentUser: vi.fn(async () => ({ get: rejectRecord })) },
}));
vi.mock('@/server/services/order-readiness', () => ({
  OrderReadinessService: {
    forCurrentUser: vi.fn(async () => ({ result: vi.fn(async () => ({ state: 'failed' })) })),
  },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: { forCurrentUser: vi.fn(async () => ({ listNames: vi.fn(async () => []) })) },
}));
vi.mock('@/lib/error-reporter', () => ({
  reportError: vi.fn(async () => {}),
  isNextControlFlowError: () => false,
}));

import EditBundlePage from './bundles/[id]/edit/page';
import BundlePage from './bundles/[id]/page';
import PickOrderPage from './orders/[id]/pick/page';
import PrintOrderPage from './orders/[id]/print/page';

const ID = '11111111-1111-4111-8111-111111111111';
const props = { params: Promise.resolve({ id: ID }) };

const PAGES: Array<[string, (p: typeof props) => Promise<unknown>]> = [
  ['A bundle', BundlePage],
  ['Edit bundle', EditBundlePage],
  ["An order's pick", PickOrderPage],
  ["An order's print view", PrintOrderPage],
];

beforeEach(() => {
  vi.clearAllMocks();
  h.failure = null;
});

describe('a record page whose record could not be read (B66)', () => {
  it.each(PAGES)('%s is Page not found only when the record is missing', async (_name, page) => {
    h.failure = new ServiceError('not_found', 'Not found');
    await expect(page(props)).rejects.toThrow('notFound');
    expect(rejectRecord).toHaveBeenCalledWith(ID);
  });

  it.each(PAGES)(
    '%s lets a failed read reach the error page, which says so and offers Try again',
    async (_name, page) => {
      const failure = new ServiceError('internal_error', 'canceling statement due to timeout');
      h.failure = failure;
      await expect(page(props)).rejects.toBe(failure);
    },
  );

  it.each(PAGES)('%s lets an unexpected error through as itself', async (_name, page) => {
    const failure = new TypeError('fetch failed');
    h.failure = failure;
    await expect(page(props)).rejects.toBe(failure);
  });
});
