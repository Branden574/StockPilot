import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The page checks reports:read and both modules itself, before any read (a
// layout's check does not stop its page), and hands the body only what the
// verified context says: the organization, the person, and whether they may
// export.

const ctxHolder = vi.hoisted(() => ({
  current: {
    role: 'manager' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
    permissions: undefined as Set<string> | undefined,
  },
}));
const modules = vi.hoisted(() => ({ on: new Set<string>(['orders', 'books']) }));
const bodyProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

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
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async (id: string) => ({ enabled: modules.on.has(id), canManage: true })),
}));
vi.mock('@/components/reports/book-order-totals/report-body', () => ({
  BookOrderTotalsBody: (props: Record<string, unknown>) => {
    bodyProps.last = props;
    return <div data-testid="body" />;
  },
}));

import BookOrderTotalsPage from './page';

async function renderPage() {
  render(await BookOrderTotalsPage({ searchParams: Promise.resolve({}) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  ctxHolder.current = { role: 'manager', permissions: undefined };
  modules.on = new Set(['orders', 'books']);
  bodyProps.last = null;
});

describe('Book Order Totals page gates', () => {
  it('sends someone without reports:read back to the dashboard', async () => {
    ctxHolder.current = { role: 'viewer', permissions: new Set() };
    await expect(renderPage()).rejects.toThrow('redirect:/dashboard');
  });

  it.each([
    ['orders', 'Orders'],
    ['books', 'Books'],
  ])('shows the module state when %s is off, and reads nothing', async (off) => {
    modules.on.delete(off);
    await renderPage();
    expect(screen.getByText(/isn't enabled/)).toBeInTheDocument();
    expect(screen.queryByTestId('body')).toBeNull();
  });

  it('a manager gets the report with export; staff get it without', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Book Order Totals' })).toBeInTheDocument();
    expect(bodyProps.last).toMatchObject({
      organizationId: 'org-1',
      userId: 'u-1',
      canExport: true,
      hasWarehouseView: true,
    });
    ctxHolder.current = { role: 'staff', permissions: undefined };
    await renderPage();
    expect(bodyProps.last).toMatchObject({ canExport: false, hasWarehouseView: false });
  });
});
