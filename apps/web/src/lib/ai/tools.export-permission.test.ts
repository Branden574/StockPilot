import { beforeEach, describe, expect, it, vi } from 'vitest';

import { effectivePermissions, PERMISSION_META } from '@stockpilot/core';

import { EXPORT_FORBIDDEN_COPY } from '@/lib/exports/export-refusal';
import type { ServiceContext } from '@/server/services/context';

/**
 * B68: the AI assistant's exportInventory tool handed every member who may
 * chat (staff included: the chat route asks items:update) a link to
 * /api/inventory/export.csv, which answers only items:export. A staff member
 * who opened it got raw JSON {"error":"forbidden"}. The tool now answers the
 * export dialog's sentence instead, by the member's EFFECTIVE permission,
 * returned rather than thrown (both chat loops report a thrown tool error as a
 * fault). The mocks are tools.analytics-scale.test.ts's.
 */

const inventoryListMock = vi.fn();

vi.mock('@/server/services/inventory', () => ({
  InventoryService: class {
    list(...args: unknown[]) {
      return inventoryListMock(...args);
    }
  },
}));
vi.mock('@/server/services/movements', () => ({
  MovementsService: class {},
  getDashboardActions: vi.fn(),
  getDashboardSummary: vi.fn(),
  getLowStockItems: vi.fn(),
}));
vi.mock('@/server/services/categories', () => ({ CategoriesService: class {} }));
vi.mock('@/server/services/suppliers', () => ({ SuppliersService: class {} }));
vi.mock('@/server/services/warehouses', () => ({ WarehousesService: class {} }));
vi.mock('@/server/services/order-requests', () => ({ OrderRequestsService: class {} }));
vi.mock('@/server/services/purchase-orders', () => ({ PurchaseOrdersService: class {} }));
vi.mock('@/server/services/bundles', () => ({ BundlesService: class {} }));
vi.mock('@/server/services/books-import', () => ({ BooksImportService: class {} }));
vi.mock('@/server/services/forecasting', () => ({
  getItemVelocity: vi.fn(),
  suggestReorderPoint: vi.fn(),
}));
vi.mock('@/lib/books/lookup', () => ({ lookupIsbn: vi.fn() }));
vi.mock('@/lib/env', () => ({
  env: {
    GEMINI_API_KEY: 'test-key',
    GEMINI_MODEL: 'gemini-2.0-flash',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: 'claude-haiku-4-5',
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.test',
    NEXT_PUBLIC_APP_URL: 'https://app.stockpilot.test',
  },
}));

import { TOOL_CATALOG } from './tools';

type Role = ServiceContext['role'];

/** A request context as withContext builds it: the role and its EFFECTIVE set. */
function ctxFor(role: Role, granted?: boolean): ServiceContext {
  return {
    organizationId: 'org-x',
    userId: 'user-x',
    role,
    permissions: effectivePermissions(
      role,
      [],
      granted === undefined ? [] : [{ permission: 'items:export', granted }],
    ),
    supabase: {} as ServiceContext['supabase'],
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set(),
  } as ServiceContext;
}

const exportInventory = () => TOOL_CATALOG.exportInventory!;

beforeEach(() => {
  vi.clearAllMocks();
  inventoryListMock.mockResolvedValue({ total: 7, items: [] });
});

describe('exportInventory answers only members who hold items:export (B68)', () => {
  it.each([
    ['staff (not held by default)', ctxFor('staff')],
    ['a viewer (not held by default)', ctxFor('viewer')],
    ['a manager whose items:export was revoked', ctxFor('manager', false)],
  ])('%s: the sentence, no link, and no read', async (_who, ctx) => {
    const res = (await exportInventory().execute({ query: 'chromebook' }, ctx)) as Record<
      string,
      unknown
    >;
    expect(res).toEqual({ error: 'forbidden', message: EXPORT_FORBIDDEN_COPY });
    expect(res).not.toHaveProperty('url');
    expect(inventoryListMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a manager (held by default)', ctxFor('manager')],
    ['a viewer granted items:export', ctxFor('viewer', true)],
    ['staff granted items:export', ctxFor('staff', true)],
  ])('%s: the count and the link, as before', async (_who, ctx) => {
    const res = (await exportInventory().execute({ query: 'chromebook' }, ctx)) as {
      count: number;
      url: string;
    };
    expect(res.count).toBe(7);
    expect(res.url).toBe(
      'https://app.stockpilot.test/api/inventory/export.csv?scope=filtered&type=all&status=active&q=chromebook',
    );
    expect(inventoryListMock).toHaveBeenCalledTimes(1);
  });

  it('tells the model which permission it needs and to pass the message on', () => {
    const description = exportInventory().declaration.description ?? '';
    expect(description).toContain(`${PERMISSION_META['items:export'].label} permission`);
    expect(description).toMatch(/\{ error, message \}/);
    // A read tool: the write guard keys on the word WRITE.
    expect(description).not.toMatch(/\bWRITE\b/);
    expect(exportInventory().write).toBeUndefined();
  });
});
