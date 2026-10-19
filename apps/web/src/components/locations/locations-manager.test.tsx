import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/locations',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

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
    expect(screen.getByText('DC4', { selector: 'td' })).toBeInTheDocument(); // Warehouse column
    expect(screen.getByText('ETC Lancaster')).toBeInTheDocument();

    expect(screen.getAllByText('Auto-managed')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /archive staging/i })).not.toBeInTheDocument();
  });

  it('keeps Edit/Archive on normal rows (Sites tab)', () => {
    render(<LocationsManager initial={ROWS} canManage />);
    const siteRow = screen.getByRole('link', { name: 'DC4' }).closest('tr')!;
    expect(within(siteRow as HTMLElement).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(
      within(siteRow as HTMLElement).getByRole('button', { name: /archive dc4/i }),
    ).toBeInTheDocument();
  });
});

describe('LocationsManager rows open the location page (F1-3)', () => {
  it('each row name links to /dashboard/locations/<id>, on every tab', async () => {
    const user = userEvent.setup();
    render(<LocationsManager initial={ROWS} canManage={false} />);
    expect(screen.getByRole('link', { name: 'DC4' })).toHaveAttribute('href', '/dashboard/locations/site-1');
    await user.click(screen.getByRole('button', { name: /system/i }));
    expect(
      screen.getAllByRole('link', { name: 'Staging' }).map((a) => a.getAttribute('href')),
    ).toEqual(['/dashboard/locations/sys-1', '/dashboard/locations/sys-2']);
  });

  it('archived rows link too (the page shows them as archived)', () => {
    render(<LocationsManager initial={[ROWS[0]!]} view="archived" canManage />);
    expect(screen.getByRole('link', { name: 'DC4' })).toHaveAttribute('href', '/dashboard/locations/site-1');
  });
});

/**
 * The redesign (W-BK-12): the shared page header carries the Active /
 * Archived toggle and New location; the three groups are the shared
 * segmented control with their counts; the archive confirm keeps the stock
 * guard's words and "Archive anyway".
 */
describe('LocationsManager — header, groups and archive guard (redesign)', () => {
  it('one h1, the subline, the toggle and New location for a manager', () => {
    render(<LocationsManager initial={ROWS} canManage />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Locations');
    expect(
      screen.getByText('Warehouses, rooms, shelves, vehicles, job sites — wherever stock lives.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'View filter' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New location/ })).toBeInTheDocument();
  });

  it('a reader without locations:manage gets no New, Edit or Archive', () => {
    render(<LocationsManager initial={ROWS} canManage={false} />);
    expect(screen.queryByRole('button', { name: /New location/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /archive dc4/i })).not.toBeInTheDocument();
  });

  it('the groups keep their counts and say which is shown (aria-pressed)', async () => {
    const user = userEvent.setup();
    render(<LocationsManager initial={ROWS} canManage />);
    const group = screen.getByRole('group', { name: 'Location groups' });
    const sites = within(group).getByRole('button', { name: /Sites/ });
    const racks = within(group).getByRole('button', { name: /Racks & shelves/ });
    const system = within(group).getByRole('button', { name: /System/ });
    expect(sites).toHaveTextContent('Sites1');
    expect(racks).toHaveTextContent('Racks & shelves0');
    expect(system).toHaveTextContent('System2');
    expect(sites).toHaveAttribute('aria-pressed', 'true');
    await user.click(racks);
    expect(racks).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('No racks or shelves yet')).toBeInTheDocument();
  });

  it('the archived view says so and offers Restore', () => {
    render(<LocationsManager initial={[ROWS[0]!]} view="archived" canManage />);
    expect(
      screen.getByText('Locations you archived. Restore one to bring it back into pick lists.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Restore/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New location/ })).not.toBeInTheDocument();
  });

  it('archive: a stock refusal shows the guard words in the dialog and the button becomes Archive anyway', async () => {
    const { archiveLocationAction } = await import('@/server/actions/locations');
    vi.mocked(archiveLocationAction)
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'conflict',
          message: '12 units of 3 items are still here.',
          details: { locationHoldsStock: true },
        },
      } as never)
      .mockResolvedValueOnce({ ok: true, data: undefined } as never);
    const user = userEvent.setup();
    render(<LocationsManager initial={ROWS} canManage />);
    await user.click(screen.getByRole('button', { name: /archive dc4/i }));
    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    expect(await screen.findByText('12 units of 3 items are still here.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Archive anyway' }));
    expect(vi.mocked(archiveLocationAction).mock.calls.map((c) => c[1])).toEqual([
      { acknowledgeStock: false },
      { acknowledgeStock: true },
    ]);
  });

  it('the action buttons sit in a flex row inside the cell, not a flex cell', () => {
    render(<LocationsManager initial={ROWS} canManage />);
    const siteRow = screen.getByRole('link', { name: 'DC4' }).closest('tr')!;
    const edit = within(siteRow as HTMLElement).getByRole('button', { name: 'Edit' });
    const cell = edit.closest('td')!;
    expect(cell.className.split(/\s+/)).not.toContain('flex');
  });
});
