import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/locations',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/server/actions/locations', () => ({
  archiveLocationAction: vi.fn(),
  createLocationAction: vi.fn(),
  restoreLocationAction: vi.fn(),
  updateLocationAction: vi.fn(),
}));

import { LocationsManager } from './locations-manager';

// ---------------------------------------------------------------------------
// Field report 2026-07-07: two warehouses → two identical "Staging" rows with
// no way to tell them apart, plus Edit/Archive offered on rows the receiving
// flow owns. Pins: the Warehouse column renders, and system rows show
// "Auto-managed" instead of Edit/Archive.
// ---------------------------------------------------------------------------

const ROWS = [
  {
    id: 'site-1',
    name: 'DC4',
    type: 'warehouse',
    kind: null,
    notes: null,
    warehouseName: null,
  },
  {
    id: 'sys-1',
    name: 'Staging',
    type: null,
    kind: 'staging',
    notes: null,
    warehouseName: 'DC4',
  },
  {
    id: 'sys-2',
    name: 'Staging',
    type: null,
    kind: 'staging',
    notes: null,
    warehouseName: 'ETC Lancaster',
  },
];

describe('LocationsManager warehouse column + system-row lock', () => {
  it('shows each system row with its owning warehouse and no Edit/Archive', async () => {
    const user = userEvent.setup();
    render(<LocationsManager initial={ROWS} canManage />);

    await user.click(screen.getByRole('button', { name: /system/i }));

    expect(screen.getByText('Warehouse')).toBeInTheDocument();
    expect(screen.getByText('DC4', { selector: 'td' })).toBeInTheDocument();
    expect(screen.getByText('ETC Lancaster')).toBeInTheDocument();

    expect(screen.getAllByText('Auto-managed')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /archive staging/i })).not.toBeInTheDocument();
  });

  it('keeps Edit/Archive on normal rows (Sites tab)', () => {
    render(<LocationsManager initial={ROWS} canManage />);
    const siteRow = screen.getByText('DC4', { selector: 'td' }).closest('tr')!;
    expect(within(siteRow as HTMLElement).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(
      within(siteRow as HTMLElement).getByRole('button', { name: /archive dc4/i }),
    ).toBeInTheDocument();
  });
});
