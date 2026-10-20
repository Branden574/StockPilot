import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Start a count page (redesign M6 / P-FORM): the way back, the page's one
// h1 and its sentence, and the Scope card holding the form, with the gates it
// always had: stock:adjust to open it, cycle_counts:assign for the member list
// (read only then), and the sports module for the Product groups tab.

const ctxHolder = vi.hoisted(() => ({
  current: {
    role: 'manager' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
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
const modules = vi.hoisted(() => ({ current: new Set<string>(['cycle_counts']) }));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getModulesForRequest: vi.fn(async () => modules.current),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ({})) }));
const listNames = vi.fn(async () => [{ id: 'wh-1', name: 'North DC', extra: 'x' }]);
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: { forCurrentUser: vi.fn(async () => ({ listNames })) },
}));
const fetchCountAssignees = vi.fn(async () => [
  { id: 'u-leo', name: 'Leo Fairbanks', email: 'l@x' },
]);
vi.mock('@/server/lib/count-assignees', () => ({
  fetchCountAssignees: (...a: unknown[]) => fetchCountAssignees(...(a as [])),
}));
const shellProps = vi.fn();
vi.mock('@/components/cycle-counts/new-cycle-count', () => ({
  NewCycleCount: (props: Record<string, unknown>) => {
    shellProps(props);
    return <p data-testid="new-count-form" />;
  },
}));

import NewCycleCountPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  ctxHolder.current = { role: 'manager', permissions: undefined };
  modules.current = new Set(['cycle_counts']);
});

describe('Start a count page', () => {
  it('has the way back, its heading and sentence, and the Scope card around the form', async () => {
    render(await NewCycleCountPage());
    expect(screen.getByRole('link', { name: '← Back to cycle counts' })).toHaveAttribute(
      'href',
      '/dashboard/cycle-counts',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Start a count' })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Pick the exact items to count below, or snapshot a whole warehouse. Starting the count records each item's current quantity-on-hand so we can compute variance later.",
      ),
    ).toBeInTheDocument();
    const scope = screen.getByRole('region', { name: 'Scope' });
    expect(scope).toContainElement(screen.getByTestId('new-count-form'));
  });

  it('a manager gets the member list to assign from; warehouses go in by id and name', async () => {
    render(await NewCycleCountPage());
    expect(shellProps).toHaveBeenCalledWith(
      expect.objectContaining({
        canAssign: true,
        members: [{ id: 'u-leo', name: 'Leo Fairbanks', email: 'l@x' }],
        warehouses: [{ id: 'wh-1', name: 'North DC' }],
        sportsEnabled: false,
      }),
    );
  });

  it('staff can open it but the member list is never read for them', async () => {
    ctxHolder.current = { role: 'staff', permissions: undefined };
    render(await NewCycleCountPage());
    expect(fetchCountAssignees).not.toHaveBeenCalled();
    expect(shellProps).toHaveBeenCalledWith(
      expect.objectContaining({ canAssign: false, members: [] }),
    );
  });

  it('the sports module unlocks the Product groups tab', async () => {
    modules.current = new Set(['cycle_counts', 'sports']);
    render(await NewCycleCountPage());
    expect(shellProps).toHaveBeenCalledWith(expect.objectContaining({ sportsEnabled: true }));
  });

  it('someone without stock:adjust is sent away before any read', async () => {
    ctxHolder.current = { role: 'viewer', permissions: new Set(['cycle_counts:read']) };
    await expect(NewCycleCountPage()).rejects.toThrow('redirect:/dashboard');
    expect(listNames).not.toHaveBeenCalled();
  });
});
