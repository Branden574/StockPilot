import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Recovery page under the shared page header: the Settings / Recovery
// crumb sits in the header's back slot as plain text and a link. The topbar
// already renders the one navigation landmark named "Breadcrumb", so the page
// must not add a second one with the same name (axe landmark-unique).

const ctxHolder = vi.hoisted(() => ({
  current: { role: 'owner' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer' },
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'user-1',
    role: ctxHolder.current.role,
  })),
}));

const rowsByEntity = vi.hoisted(() => ({
  current: {} as Record<string, Array<Record<string, unknown>>>,
}));

vi.mock('@/server/services/recovery', () => ({
  RECOVERY_AUDIT_ENTITY_TYPE: {
    inventory_items: 'inventory_item',
    categories: 'category',
    locations: 'location',
    suppliers: 'supplier',
  },
  RecoveryService: {
    forCurrentUser: vi.fn(async () => ({
      listDeleted: vi.fn(async (entity: string) => rowsByEntity.current[entity] ?? []),
    })),
  },
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
}));

vi.mock('@/components/settings/restore-button', () => ({
  RestoreButton: ({ label }: { label: string }) => <button type="button">Restore {label}</button>,
  DeletedAtTooltip: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

import RecoveryPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  ctxHolder.current = { role: 'owner' };
  rowsByEntity.current = {};
});

describe('Recovery page', () => {
  it('keeps the Settings crumb link to /dashboard/settings', async () => {
    render(await RecoveryPage());
    expect(screen.getByRole('heading', { level: 1, name: 'Recovery' })).toBeInTheDocument();
    const crumb = screen.getByRole('link', { name: 'Settings' });
    expect(crumb).toHaveAttribute('href', '/dashboard/settings');
    expect(within(crumb.parentElement as HTMLElement).getByText('Recovery')).toBeInTheDocument();
  });

  it('adds no navigation landmark named Breadcrumb (the topbar owns that one)', async () => {
    render(await RecoveryPage());
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    expect(screen.queryAllByRole('navigation')).toHaveLength(0);
  });

  it('shows the empty state when nothing is soft-deleted', async () => {
    render(await RecoveryPage());
    expect(screen.getByText('Nothing to restore')).toBeInTheDocument();
  });

  it('lists a deleted row with its restore button and history link', async () => {
    rowsByEntity.current = {
      categories: [
        {
          id: 'cat-1',
          name: 'Old shelf',
          sku: null,
          deleted_at: '2026-10-18T21:22:32.000Z',
          deleted_by_name: 'Pat',
        },
      ],
    };
    render(await RecoveryPage());
    expect(screen.getByRole('heading', { level: 2, name: 'Categories' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore Old shelf' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View history' })).toHaveAttribute(
      'href',
      '/dashboard/audit?entityType=category&entityId=cat-1',
    );
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
  });

  it('is not found for a role without items:delete', async () => {
    ctxHolder.current = { role: 'viewer' };
    await expect(RecoveryPage()).rejects.toThrow('notFound');
  });
});
