import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Roles & permissions for a member who cannot configure roles: the read-only
// matrix of every role. It is wider than a phone and its rows hold no
// control, so its scroll area is a Tab stop, named by the card's title. The
// card itself carries no name, so the page lists All roles at a glance once
// (axe landmark-unique).

const ctxHolder = vi.hoisted(() => ({
  current: { role: 'staff' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer' },
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'user-1',
    role: ctxHolder.current.role,
    permissions: null,
  })),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/components/settings/role-permission-matrix', () => ({
  RolePermissionMatrix: () => <div data-testid="role-permission-matrix" />,
}));

import RolesPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  ctxHolder.current = { role: 'staff' };
});

describe('Roles & permissions: the read-only matrix', () => {
  it('names the matrix scroll area by the card title, and lists that name once', async () => {
    render(await RolesPage());
    expect(screen.queryByTestId('role-permission-matrix')).toBeNull();
    const regions = screen.getAllByRole('region', { name: 'All roles at a glance' });
    expect(regions).toHaveLength(1);
    expect(regions[0]!.tagName).toBe('DIV');
    expect(regions[0]).toHaveAttribute('tabindex', '0');
    expect(within(regions[0]!).getByRole('table')).toBeInTheDocument();
    // The card keeps its title as its heading, but is not a region of its own.
    expect(
      screen.getByRole('heading', { level: 2, name: 'All roles at a glance' }).closest('section'),
    ).not.toHaveAttribute('aria-labelledby');
  });
});
