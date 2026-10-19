import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Bulk ISBN import page in the redesign (P4.A2, matrix W-BK-05): the
// shared page header (back link, the one h1, the subline, Backfill covers),
// the import gate, and the organization's own warehouse and charter words
// handed to the form (PLAN rule 10: no new terminology read, the one the
// page already makes).

const ctxHolder = vi.hoisted(() => ({
  role: 'manager' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  permissions: undefined as Set<string> | undefined,
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: ctxHolder.role,
    permissions: ctxHolder.permissions,
  })),
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));

vi.mock('@/lib/auth/warehouse', () => ({ forcedWarehouseId: vi.fn(async () => null) }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { terminology: { warehouse_singular: 'Site', charter_singular: 'School' } },
          }),
        }),
      }),
    }),
  })),
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: {
    forCurrentUser: async () => ({ listNames: async () => [{ id: 'wh-1', name: 'North DC' }] }),
  },
}));
vi.mock('@/server/services/charters', () => ({
  ChartersService: { forCurrentUser: async () => ({ list: async () => [] }) },
}));
vi.mock('@/server/services/warehouse-charters', () => ({
  WarehouseChartersService: { forCurrentUser: async () => ({ listPairs: async () => [] }) },
}));

const formProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('@/components/books/bulk-isbn-import', () => ({
  BulkIsbnImport: (props: Record<string, unknown>) => {
    formProps.current = props;
    return <div data-testid="isbn-import-form" />;
  },
}));
vi.mock('@/components/books/backfill-covers-button', () => ({
  BackfillCoversButton: () => <button type="button">Backfill covers</button>,
}));

import BulkIsbnImportPage, { maxDuration, metadata } from './page';

beforeEach(() => {
  ctxHolder.role = 'manager';
  ctxHolder.permissions = undefined;
  formProps.current = null;
});

describe('Bulk ISBN import page (redesign)', () => {
  it('draws the shared header: back link, one h1, the subline and Backfill covers', async () => {
    render(await BulkIsbnImportPage());
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent('Bulk ISBN import');
    expect(h1s[0]!.closest('[data-slot="page-header"]')).not.toBeNull();
    expect(screen.getByRole('link', { name: '← Back to books' })).toHaveAttribute(
      'href',
      '/dashboard/books',
    );
    expect(
      screen.getByText(/Paste up to 200 ISBNs, look them up across Google Books/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Backfill covers' })).toBeInTheDocument();
    expect(screen.getByTestId('isbn-import-form')).toBeInTheDocument();
  });

  it('hands the form the organization’s own words and the warehouse list', async () => {
    render(await BulkIsbnImportPage());
    expect(formProps.current).toMatchObject({
      warehouses: [{ id: 'wh-1', name: 'North DC' }],
      forcedWarehouseId: null,
      warehouseLabel: 'Site',
      charterLabel: 'School',
    });
  });

  it('keeps the import gate (items:import, else back to Books), the title and the 60 s limit', async () => {
    expect(metadata).toEqual({ title: 'Bulk ISBN import' });
    expect(maxDuration).toBe(60);
    ctxHolder.role = 'viewer';
    await expect(BulkIsbnImportPage()).rejects.toThrow('redirect:/dashboard/books');
  });
});
