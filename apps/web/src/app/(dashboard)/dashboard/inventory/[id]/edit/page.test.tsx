import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Edit item page in the redesign (P4.A1, matrix W-IT-03): the shared page
// header with the way back, one form card titled with the record's name, the
// items:update gate and the not-found page, and a tab title of its own
// (CONFLICTS D16: the page had none).

const ctxHolder = vi.hoisted(() => ({
  current: { role: 'manager' as 'owner' | 'manager' | 'viewer' },
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: ctxHolder.current.role,
  })),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('not-found');
  }),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href, ...rest }, children),
  };
});
vi.mock('@/lib/auth/warehouse', () => ({ forcedWarehouseId: vi.fn(async () => null) }));
vi.mock('@/lib/warehouse-filter', () => ({ getActiveWarehouseFilter: vi.fn(async () => null) }));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: false, canManage: false })),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    }),
  })),
}));
const { svc } = vi.hoisted(() => ({
  svc: (methods: Record<string, unknown>) => ({ forCurrentUser: async () => methods }),
}));
vi.mock('@/server/services/categories', () => ({
  CategoriesService: svc({ list: async () => [] }),
}));
vi.mock('@/server/services/locations', () => ({
  LocationsService: svc({ list: async () => [] }),
}));
vi.mock('@/server/services/suppliers', () => ({
  SuppliersService: svc({ listForLookups: async () => [] }),
}));
vi.mock('@/server/services/tags', () => ({
  TagsService: svc({ list: async () => [], listForItem: async () => [] }),
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: svc({ listNames: async () => [{ id: 'wh-1', name: 'North DC' }] }),
}));
vi.mock('@/server/services/charters', () => ({ ChartersService: svc({ list: async () => [] }) }));
// The page's warehouse charter pairs, and the shared LOOKUP_ROW_CEILING (a
// getter, so a test can lower it: the page reads the binding on every render).
const { pairs, ceiling } = vi.hoisted(() => ({
  pairs: { current: [] as Array<{ warehouse_id: string; charter_id: string }> },
  ceiling: { value: 10_000 },
}));
vi.mock('@/server/services/warehouse-charters', () => ({
  WarehouseChartersService: svc({ listPairs: async () => pairs.current }),
}));
vi.mock('@/server/services/lib/lookup-ceiling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/lib/lookup-ceiling')>()),
  get LOOKUP_ROW_CEILING() {
    return ceiling.value;
  },
}));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: svc({
    get: async (id: string) => {
      if (id === 'missing') {
        const { ServiceError } = await import('@/server/services/context');
        throw new ServiceError('not_found', 'Not found');
      }
      return {
        id,
        name: 'Falcons Home Jersey',
        sku: 'FALC-07',
        quantity_on_hand: 4,
        unit_cost: 1,
        retail_price: 2,
        reorder_point: 0,
        reorder_quantity: 0,
        unit_of_measure: 'each',
        status: 'active',
        item_type: 'product',
        custom_fields: {},
      };
    },
  }),
}));
vi.mock('@/server/services/item-grouping', () => ({
  ItemGroupingService: svc({ countSkuSiblings: async () => 0 }),
}));
vi.mock('@/server/services/custom-fields', () => ({
  CustomFieldsService: svc({ listDefinitions: async () => [] }),
}));
const { formProps } = vi.hoisted(() => ({ formProps: vi.fn() }));
vi.mock('@/components/inventory/item-form', () => ({
  ItemForm: (props: Record<string, unknown>) => {
    formProps(props);
    return <p data-testid="item-form" />;
  },
}));

import EditItemPage, { metadata } from './page';

const page = (id = 'rec-1', ret?: string) =>
  EditItemPage({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve(ret === undefined ? {} : { return: ret }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  ctxHolder.current = { role: 'manager' };
  pairs.current = [];
  ceiling.value = 10_000;
});

describe('Edit item page', () => {
  it('has a tab title of its own (D16)', () => {
    expect(metadata.title).toBe('Edit item');
  });

  it('keeps the way back to the record, the heading and the card titled with its name', async () => {
    render(await page());
    expect(screen.getByRole('link', { name: '← Back to item' })).toHaveAttribute(
      'href',
      '/dashboard/inventory/rec-1',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Edit item' })).toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'Falcons Home Jersey' });
    expect(card).toContainElement(screen.getByTestId('item-form'));
    expect(formProps).toHaveBeenCalledWith(
      expect.objectContaining({ returnHref: '/dashboard/inventory/rec-1' }),
    );
  });

  it('goes back to the list it came from when the link carried one', async () => {
    render(await page('rec-1', '/dashboard/inventory?page=2'));
    expect(screen.getByRole('link', { name: '← Back to item' })).toHaveAttribute(
      'href',
      '/dashboard/inventory?page=2',
    );
  });

  it('still sends someone without items:update to the record, and a missing one to not found', async () => {
    await expect(page('missing')).rejects.toThrow('not-found');
    ctxHolder.current = { role: 'viewer' };
    await expect(page()).rejects.toThrow('redirect:/dashboard/inventory/rec-1');
  });
});

/**
 * B47 decisions round (2026-11-01): listPairs stops at LOOKUP_ROW_CEILING
 * links. At that many the list may be cut, so the page tells the form, which
 * then keeps the record's charter on a warehouse change instead of clearing it
 * from part of the list (the save checks the pair on the server).
 */
describe('Edit item page: the warehouse charter list at the ceiling', () => {
  const pairsOf = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      warehouse_id: 'wh-1',
      charter_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    }));

  it('a list that reached the ceiling is passed as cut', async () => {
    ceiling.value = 5;
    pairs.current = pairsOf(5);
    render(await page());
    expect(formProps).toHaveBeenCalledWith(
      expect.objectContaining({ warehouseCharters: pairs.current, warehouseChartersCapped: true }),
    );
  });

  it('a list under the ceiling is passed as whole', async () => {
    ceiling.value = 5;
    pairs.current = pairsOf(4);
    render(await page());
    expect(formProps).toHaveBeenCalledWith(
      expect.objectContaining({ warehouseChartersCapped: false }),
    );
  });
});
