import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Backups & restore. The Snapshots table is wider than a phone, and with one
// restore point its row has no control while the restore runs, so its scroll
// area can become a Tab stop: that area is the region named by the card's
// Snapshots heading, and the card itself then carries no name, so the page
// lists Snapshots once (axe landmark-unique). With no table the card is that
// one region.

const orgRow = vi.hoisted(() => ({
  current: { plan: 'business' } as Record<string, unknown> | null,
}));
const listSnapshots = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));

vi.mock('@/server/services/context', () => ({
  withContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'user-1',
    role: 'owner',
    permissions: new Set(['organization:update']),
    supabase: {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: orgRow.current, error: null }),
          }),
        }),
      }),
    },
  })),
}));

vi.mock('@/server/services/restore-points', () => ({
  listSnapshots: (...args: unknown[]) => listSnapshots(...args),
}));

vi.mock('@/components/settings/create-restore-point-button', () => ({
  CreateRestorePointButton: () => <button type="button">Create restore point</button>,
}));
vi.mock('@/components/settings/restore-snapshot-button', () => ({
  RestorePointTime: ({ iso }: { iso: string }) => <span>{iso}</span>,
  RestoreSnapshotButton: () => <button type="button">Restore</button>,
}));

import RestorePointsPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  orgRow.current = { plan: 'business' };
  listSnapshots.mockResolvedValue([
    {
      id: 'rp-1',
      createdAt: '2026-10-18T03:00:00.000Z',
      createdBy: null,
      kind: 'auto',
      label: null,
      itemCount: 120,
      capped: false,
    },
  ]);
});

describe('Backups & restore: the Snapshots table', () => {
  it('names the table by the card title, and lists that name once', async () => {
    render(await RestorePointsPage());
    const heading = screen.getByRole('heading', { level: 2, name: 'Snapshots' });
    expect(heading).toHaveAttribute('id', 'restore-points-snapshots-heading');
    const table = screen.getByRole('table');
    const regions = screen.getAllByRole('region', { name: 'Snapshots' });
    expect(regions).toHaveLength(1);
    expect(regions[0]).toBe(table.parentElement);
    expect(regions[0]).toContainElement(table);
    // The card keeps its title as its heading, but is not a region of its own.
    expect(heading.closest('section')).not.toHaveAttribute('aria-labelledby');
    // The other card on the page is still a region named by its title.
    expect(screen.getByRole('region', { name: 'Create a restore point' })).toBeInTheDocument();
  });

  it('with no restore points yet, the card itself is the one Snapshots region', async () => {
    listSnapshots.mockResolvedValue([]);
    render(await RestorePointsPage());
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText(/No restore points yet/)).toBeInTheDocument();
    const heading = screen.getByRole('heading', { level: 2, name: 'Snapshots' });
    const regions = screen.getAllByRole('region', { name: 'Snapshots' });
    expect(regions).toHaveLength(1);
    expect(regions[0]).toBe(heading.closest('section'));
  });
});
