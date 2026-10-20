import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The New book page in the redesign (P4.A1, matrix W-BK-04): the shared page
// header and one form card, the items:create gate, and two Stage 1 defects:
//  - D3: the Books scan shortcut's "Create new book" sends ?isbn=, which this
//    page never read, so the scanned ISBN had to be typed in again;
//  - D16: the page had no tab title of its own.

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
vi.mock('@/server/services/tags', () => ({ TagsService: svc({ list: async () => [] }) }));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: svc({ listNames: async () => [{ id: 'wh-1', name: 'North DC' }] }),
}));
vi.mock('@/server/services/charters', () => ({ ChartersService: svc({ list: async () => [] }) }));
vi.mock('@/server/services/warehouse-charters', () => ({
  WarehouseChartersService: svc({ listPairs: async () => [] }),
}));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: svc({ getRecentDefaults: async () => null }),
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

import NewBookPage, { metadata } from './page';

const page = (isbn?: string | string[]) =>
  NewBookPage({ searchParams: Promise.resolve(isbn === undefined ? {} : { isbn }) });

beforeEach(() => {
  vi.clearAllMocks();
  ctxHolder.current = { role: 'manager' };
});

describe('New book page', () => {
  it('has a tab title of its own (D16)', () => {
    expect(metadata.title).toBe('New book');
  });

  it('keeps the way back, the heading, its sentence and the Book details card around the form', async () => {
    render(await page());
    expect(screen.getByRole('link', { name: '← Back to books' })).toHaveAttribute(
      'href',
      '/dashboard/books',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'New book' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Books are tracked alongside regular inventory but live on their own tab. Title, ISBN, author, qty.',
      ),
    ).toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'Book details' });
    expect(card).toContainElement(screen.getByTestId('item-form'));
    expect(formProps).toHaveBeenCalledWith(expect.objectContaining({ itemType: 'book' }));
  });

  it('fills the ISBN a scan link hands it (D3)', async () => {
    render(await page(' 9780140283334 '));
    expect(formProps.mock.calls[0]![0]).toMatchObject({
      defaults: { warehouseId: null, primaryLocationId: null, barcode: '9780140283334' },
    });
  });

  it('leaves the ISBN empty with no link value, a repeated one or an over-long one', async () => {
    for (const value of [undefined, '   ', ['978', '979'], 'x'.repeat(129)]) {
      formProps.mockClear();
      render(await page(value));
      const defaults = (formProps.mock.calls[0]![0] as { defaults: Record<string, unknown> })
        .defaults;
      expect(defaults).not.toHaveProperty('barcode');
    }
  });

  it('still sends a viewer back to the books list', async () => {
    ctxHolder.current = { role: 'viewer' };
    await expect(page()).rejects.toThrow('redirect:/dashboard/books');
  });
});
