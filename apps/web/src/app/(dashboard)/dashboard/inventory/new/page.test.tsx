import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The New item page in the redesign (P4.A1, matrix W-IT-04): the shared page
// header with the New item tour, one form card, the items:create gate, and two
// Stage 1 defects:
//  - D7: the subline said "Use CSV import for bulk in Phase 5." long after the
//    import shipped; it now points to the import, for anyone it lets in;
//  - D16: the page had no tab title of its own.

const ctxHolder = vi.hoisted(() => ({
  current: {
    role: 'manager' as 'owner' | 'manager' | 'viewer',
    permissions: undefined as Set<string> | undefined,
  },
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: ctxHolder.current.role,
    permissions: ctxHolder.current.permissions,
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
  createClient: vi.fn(async () => {
    // Every read this page makes: the org's terminology and the size scales.
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      maybeSingle: async () => ({ data: null }),
      then: (done: (v: { data: unknown[] }) => unknown) => done({ data: [] }),
    };
    return { from: () => chain };
  }),
}));
vi.mock('@/components/onboarding/page-tour', () => ({
  PageTour: ({ tour }: { tour: { id: string } }) => (
    <button type="button">{`Tour ${tour.id}`}</button>
  ),
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

import NewItemPage, { metadata } from './page';

beforeEach(() => {
  vi.clearAllMocks();
  ctxHolder.current = { role: 'manager', permissions: undefined };
});

describe('New item page', () => {
  it('has a tab title of its own (D16)', () => {
    expect(metadata.title).toBe('New item');
  });

  it('keeps the way back, the heading, the tour and the Item details card around the form', async () => {
    render(await NewItemPage());
    expect(screen.getByRole('link', { name: '← Back to inventory' })).toHaveAttribute(
      'href',
      '/dashboard/inventory',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'New item' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tour new-item-form' })).toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'Item details' });
    expect(card).toContainElement(screen.getByTestId('item-form'));
  });

  it('points the subline to the CSV import instead of a "Phase 5" promise (D7)', async () => {
    const { container } = render(await NewItemPage());
    expect(container.textContent).not.toMatch(/Phase 5/);
    expect(screen.getByText(/Add a single item\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'import a CSV' })).toHaveAttribute(
      'href',
      '/dashboard/inventory/import',
    );
  });

  it('offers no import link to someone the import page would send away', async () => {
    ctxHolder.current = { role: 'manager', permissions: new Set(['items:create']) };
    render(await NewItemPage());
    expect(screen.getByText('Add a single item.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'import a CSV' })).not.toBeInTheDocument();
  });

  it('still sends someone without items:create back to the list', async () => {
    ctxHolder.current = { role: 'viewer', permissions: undefined };
    await expect(NewItemPage()).rejects.toThrow('redirect:/dashboard/inventory');
  });
});
