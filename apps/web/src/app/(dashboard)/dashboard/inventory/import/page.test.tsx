import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Import items page in the redesign (P4.A1, matrix W-IT-06): the shared
// page header over the import steps, the items:import gate, the destination
// warehouses and the org's word for a warehouse handed to the steps, and a tab
// title of its own (CONFLICTS D16: the page had none).

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
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/lib/auth/warehouse', () => ({ forcedWarehouseId: vi.fn(async () => null) }));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: true })),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { terminology: { warehouse_singular: 'Campus' } } }),
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
const { stepsProps } = vi.hoisted(() => ({ stepsProps: vi.fn() }));
vi.mock('@/components/inventory/csv-import', () => ({
  CsvImport: (props: Record<string, unknown>) => {
    stepsProps(props);
    return <p data-testid="csv-import" />;
  },
}));

import ImportPage, { metadata } from './page';

beforeEach(() => {
  vi.clearAllMocks();
  ctxHolder.current = { role: 'manager', permissions: undefined };
});

describe('Import items page', () => {
  it('has a tab title of its own (D16)', () => {
    expect(metadata.title).toBe('Import items');
  });

  it('keeps the way back, the heading and its sentence over the steps', async () => {
    render(await ImportPage());
    expect(screen.getByRole('link', { name: '← Back to inventory' })).toHaveAttribute(
      'href',
      '/dashboard/inventory',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Import items' })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Upload a CSV. We'll validate every row and show errors before anything goes into your inventory.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('csv-import')).toBeInTheDocument();
    expect(stepsProps).toHaveBeenCalledWith({
      sportsEnabled: true,
      warehouses: [{ id: 'wh-1', name: 'North DC' }],
      forcedWarehouseId: null,
      warehouseLabel: 'Campus',
    });
  });

  it('still sends someone without items:import back to the list', async () => {
    ctxHolder.current = { role: 'manager', permissions: new Set(['items:create']) };
    await expect(ImportPage()).rejects.toThrow('redirect:/dashboard/inventory');
  });
});
