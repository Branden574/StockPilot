import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Product groups page in the redesign (P4.A1, matrix W-IT-08): the shared
// page header with the archived view and the review tool as its actions, the
// roll-up list, its three empty states, and both gates (the sports module,
// then sports:manage). Two reads for the whole page, the first 100 groups.

const ctxHolder = vi.hoisted(() => ({
  current: { role: 'manager' as 'owner' | 'manager' | 'staff' },
  moduleOn: true,
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: ctxHolder.current.role,
  })),
}));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: ctxHolder.moduleOn, canManage: true })),
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
vi.mock('@/server/services/context', () => ({ withContext: vi.fn(async () => ({})) }));
const { list, rollups, listProps } = vi.hoisted(() => ({
  list: vi.fn(),
  rollups: vi.fn(async () => new Map()),
  listProps: vi.fn(),
}));
vi.mock('@/server/services/product-groups', () => ({
  ProductGroupsService: class {
    list = list;
    rollups = rollups;
  },
}));
vi.mock('@/components/inventory/product-group-rollup-list', () => ({
  ProductGroupRollupList: (props: Record<string, unknown>) => {
    listProps(props);
    return <p data-testid="rollup-list" />;
  },
}));
vi.mock('@/components/dashboard/module-not-enabled', () => ({
  ModuleNotEnabled: ({ moduleId }: { moduleId: string }) => <h1>{`${moduleId} is off`}</h1>,
}));

import ProductGroupsPage, { metadata } from './page';

const GROUP = {
  id: 'g-1',
  name: 'Nike Pegasus 41',
  brand: 'Nike',
  model: 'Pegasus',
  style_number: null,
  team: null,
  subcategory_key: 'shoes',
  tracking_mode: 'QUANTITY',
  default_counting_unit: 'pair',
};

const page = (params: { q?: string; status?: string } = {}) =>
  ProductGroupsPage({ searchParams: Promise.resolve(params) });

beforeEach(() => {
  vi.clearAllMocks();
  ctxHolder.current = { role: 'manager' };
  ctxHolder.moduleOn = true;
  list.mockResolvedValue([GROUP]);
});

describe('Product groups page', () => {
  it('keeps its tab title', () => {
    expect(metadata.title).toBe('Product groups');
  });

  it('has the heading, its sentence and both actions, and reads the first 100 active groups', async () => {
    render(await page());
    expect(screen.getByRole('heading', { level: 1, name: 'Product groups' })).toBeInTheDocument();
    expect(screen.getByText(/One row per product\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View archived' })).toHaveAttribute(
      'href',
      '/dashboard/product-groups?status=archived',
    );
    expect(screen.getByRole('link', { name: 'Review suggested families' })).toHaveAttribute(
      'href',
      '/dashboard/product-groups/link',
    );
    expect(list).toHaveBeenCalledWith({ search: undefined, limit: 100, status: 'active' });
    expect(rollups).toHaveBeenCalledWith(['g-1']);
    expect(listProps).toHaveBeenCalledWith(
      expect.objectContaining({
        archived: false,
        groups: [expect.objectContaining({ id: 'g-1' })],
      }),
    );
  });

  it('the archived view keeps the search in its way back', async () => {
    render(await page({ status: 'archived', q: 'peg' }));
    expect(
      screen.getByRole('heading', { level: 1, name: 'Archived product groups' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to active groups' })).toHaveAttribute(
      'href',
      '/dashboard/product-groups?status=active&q=peg',
    );
    expect(list).toHaveBeenCalledWith({ search: 'peg', limit: 100, status: 'archived' });
  });

  it('shows each empty state in its own words', async () => {
    list.mockResolvedValue([]);
    const { unmount } = render(await page());
    expect(screen.getByText('No product groups yet')).toBeInTheDocument();
    unmount();
    const second = render(await page({ q: 'zzz' }));
    expect(screen.getByText('No product groups match that search')).toBeInTheDocument();
    second.unmount();
    render(await page({ status: 'archived' }));
    expect(screen.getByText('No archived product groups')).toBeInTheDocument();
  });

  it('keeps both gates: the module, then sports:manage', async () => {
    ctxHolder.moduleOn = false;
    render(await page());
    expect(screen.getByRole('heading', { name: 'sports is off' })).toBeInTheDocument();
    ctxHolder.moduleOn = true;
    ctxHolder.current = { role: 'staff' };
    await expect(page()).rejects.toThrow('redirect:/dashboard');
  });
});
