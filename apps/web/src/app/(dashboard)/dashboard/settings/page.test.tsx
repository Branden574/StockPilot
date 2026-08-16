import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Binding constraint 6: the maintenance-requests hub tile must be hidden
// when the module is disabled AND respect the configure-only permission gate
// (C2) — this is the FIRST hub tile in this hand-maintained array gated on
// an off-by-default optional module (registry `defaultOnFor: []`), so
// there's no existing precedent test in this file to extend; this suite is
// scoped to that one tile's visibility matrix.

const ctxHolder = vi.hoisted(() => ({
  current: {
    role: 'owner' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
    permissions: undefined as ReadonlySet<string> | undefined,
  },
}));

function setCtx(role: typeof ctxHolder.current.role, permissions?: string[]) {
  ctxHolder.current = { role, permissions: permissions ? new Set(permissions) : undefined };
}

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    organizationName: 'Org',
    role: ctxHolder.current.role,
    ...(ctxHolder.current.permissions ? { permissions: ctxHolder.current.permissions } : {}),
  })),
}));

const moduleAccess = vi.hoisted(() => ({ current: { enabled: true, canManage: false } }));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async (moduleId: string) => {
    if (moduleId !== 'maintenance_requests') throw new Error(`unexpected module ${moduleId}`);
    return moduleAccess.current;
  }),
}));

vi.mock('@/components/onboarding/page-tour', () => ({ PageTour: () => null }));
vi.mock('@/lib/onboarding/tours', () => ({ SETTINGS_TOUR: {} }));

import SettingsPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  setCtx('owner');
  moduleAccess.current = { enabled: true, canManage: false };
});

describe('Maintenance requests hub tile', () => {
  it('is hidden when the module is disabled, even for the owner', async () => {
    moduleAccess.current = { enabled: false, canManage: true };
    render(await SettingsPage());
    expect(screen.queryByText('Maintenance requests')).not.toBeInTheDocument();
  });

  it('is hidden from an admin who lacks the configure grant, even when the module is enabled', async () => {
    setCtx('admin');
    moduleAccess.current = { enabled: true, canManage: true };
    render(await SettingsPage());
    expect(screen.queryByText('Maintenance requests')).not.toBeInTheDocument();
  });

  it('is visible to the owner when the module is enabled, with the exact href/title/description', async () => {
    render(await SettingsPage());
    const link = screen.getByRole('link', { name: /Maintenance requests/ });
    expect(link).toHaveAttribute('href', '/dashboard/settings/maintenance');
    expect(screen.getByText('Categories, notification audiences, and photo link settings.')).toBeInTheDocument();
  });

  it('is visible to an admin who holds an explicit configure override (Andrew\'s real grant path, in reverse)', async () => {
    setCtx('admin', [
      'maintenance_requests:submit',
      'maintenance_requests:read_all',
      'maintenance_requests:manage',
      'maintenance_requests:configure',
    ]);
    render(await SettingsPage());
    expect(screen.getByRole('link', { name: /Maintenance requests/ })).toBeInTheDocument();
  });
});

describe('Email routing hub tile (per-org email routing, migration 0337)', () => {
  it('is visible to roles holding organization:update, with the exact href/title/description', async () => {
    setCtx('admin');
    render(await SettingsPage());
    const link = screen.getByRole('link', { name: /Email routing/ });
    expect(link).toHaveAttribute('href', '/dashboard/settings/email-routing');
    expect(
      screen.getByText(
        'Where delivery and maintenance request emails are addressed for your organization.',
      ),
    ).toBeInTheDocument();
  });

  it('is hidden from a manager — the tile gate matches the RLS floor (organizations_update = admin)', async () => {
    setCtx('manager');
    render(await SettingsPage());
    expect(screen.queryByText('Email routing')).not.toBeInTheDocument();
  });

  it('does NOT depend on the maintenance module: delivery requests are core, and admins of an unconfigured org need the tile to learn why the action is hidden', async () => {
    moduleAccess.current = { enabled: false, canManage: false };
    render(await SettingsPage());
    expect(screen.getByRole('link', { name: /Email routing/ })).toBeInTheDocument();
  });
});
