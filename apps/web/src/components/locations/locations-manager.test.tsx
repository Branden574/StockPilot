import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    expect(
      within(siteRow as HTMLElement).getByRole('button', { name: 'Edit' }),
    ).toBeInTheDocument();
    expect(
      within(siteRow as HTMLElement).getByRole('button', { name: /archive dc4/i }),
    ).toBeInTheDocument();
  });
});

describe('LocationsManager rows open the location page (F1-3)', () => {
  it('each row name links to /dashboard/locations/<id>, on every tab', async () => {
    const user = userEvent.setup();
    render(<LocationsManager initial={ROWS} canManage={false} />);
    expect(screen.getByRole('link', { name: 'DC4' })).toHaveAttribute(
      'href',
      '/dashboard/locations/site-1',
    );
    await user.click(screen.getByRole('button', { name: /system/i }));
    expect(
      screen.getAllByRole('link', { name: 'Staging' }).map((a) => a.getAttribute('href')),
    ).toEqual(['/dashboard/locations/sys-1', '/dashboard/locations/sys-2']);
  });

  it('archived rows link too (the page shows them as archived)', () => {
    render(<LocationsManager initial={[ROWS[0]!]} view="archived" canManage />);
    expect(screen.getByRole('link', { name: 'DC4' })).toHaveAttribute(
      'href',
      '/dashboard/locations/site-1',
    );
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
    // The page title names the table's scroll region.
    expect(screen.getByRole('region', { name: 'Locations' })).toContainElement(
      screen.getByRole('table'),
    );
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
    // Announced: the guard's words are the dialog's alert line. A screen reader
    // does not read a dialog's description again when it changes.
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent(
      '12 units of 3 items are still here.',
    );
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

/**
 * B9 review: once the actions passed the stock guard's details through, its
 * refusal reached the dialog, but only as the dialog's description, which is
 * not a live region, so a screen reader heard nothing after Archive except the
 * button's new name. Every other refusal of archive or restore was only a
 * toast, and a toast sits behind an open dialog (L112). Each refusal is now
 * the dialog's role="alert" line, cleared on open and on each try, as in the
 * warehouses, charters and bins managers.
 */
describe('LocationsManager — refusals are announced inside the dialog', () => {
  const STOCK = {
    ok: false,
    error: {
      code: 'validation_error',
      message: '12 units of 3 items are still here.',
      details: { locationHoldsStock: true },
    },
  };

  beforeEach(async () => {
    const actions = await import('@/server/actions/locations');
    vi.mocked(actions.archiveLocationAction).mockReset();
    vi.mocked(actions.restoreLocationAction).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it('archive: any other refusal is an alert in the dialog, and the button stays Archive', async () => {
    const { archiveLocationAction } = await import('@/server/actions/locations');
    vi.mocked(archiveLocationAction)
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'internal_error', message: 'Could not verify this location is empty.' },
      } as never)
      .mockResolvedValueOnce({ ok: true, data: undefined } as never);
    const user = userEvent.setup();
    render(<LocationsManager initial={ROWS} canManage />);
    await user.click(screen.getByRole('button', { name: /archive dc4/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'Could not verify this location is empty.',
      ),
    );
    // Nothing to acknowledge: not the stock guard, so no Archive anyway.
    expect(within(dialog).queryByRole('button', { name: 'Archive anyway' })).toBeNull();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Could not verify this location is empty.');
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(vi.mocked(archiveLocationAction).mock.calls.map((c) => c[1])).toEqual([
      { acknowledgeStock: false },
      { acknowledgeStock: false },
    ]);
  });

  it('archive: the stock refusal is not a toast, only the alert', async () => {
    const { archiveLocationAction } = await import('@/server/actions/locations');
    vi.mocked(archiveLocationAction).mockResolvedValueOnce(STOCK as never);
    const user = userEvent.setup();
    render(<LocationsManager initial={ROWS} canManage />);
    await user.click(screen.getByRole('button', { name: /archive dc4/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await within(dialog).findByRole('button', { name: 'Archive anyway' });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      '12 units of 3 items are still here.',
    );
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it('archive: when Archive anyway is refused for another reason, the stock is not acknowledged again until its words are back', async () => {
    const { archiveLocationAction } = await import('@/server/actions/locations');
    vi.mocked(archiveLocationAction)
      .mockResolvedValueOnce(STOCK as never)
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'internal_error', message: 'An internal error occurred. Please try again.' },
      } as never)
      .mockResolvedValueOnce(STOCK as never)
      .mockResolvedValueOnce({ ok: true, data: undefined } as never);
    const user = userEvent.setup();
    render(<LocationsManager initial={ROWS} canManage />);
    await user.click(screen.getByRole('button', { name: /archive dc4/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Archive anyway' }));
    // The new refusal replaces the guard's words, so the button goes back to
    // Archive: it never acknowledges stock whose words are not on screen.
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'An internal error occurred. Please try again.',
      ),
    );
    expect(within(dialog).queryByRole('button', { name: 'Archive anyway' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        '12 units of 3 items are still here.',
      ),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Archive anyway' }));
    expect(vi.mocked(archiveLocationAction).mock.calls.map((c) => c[1])).toEqual([
      { acknowledgeStock: false },
      { acknowledgeStock: true },
      { acknowledgeStock: false },
      { acknowledgeStock: true },
    ]);
  });

  it('archive: reopening the dialog starts clean, with no old refusal and plain Archive', async () => {
    const { archiveLocationAction } = await import('@/server/actions/locations');
    vi.mocked(archiveLocationAction).mockResolvedValueOnce(STOCK as never);
    const user = userEvent.setup();
    render(<LocationsManager initial={ROWS} canManage />);
    await user.click(screen.getByRole('button', { name: /archive dc4/i }));
    const first = await screen.findByRole('dialog');
    await user.click(within(first).getByRole('button', { name: 'Archive' }));
    await within(first).findByRole('button', { name: 'Archive anyway' });
    await user.click(within(first).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(screen.getByRole('button', { name: /archive dc4/i }));
    const again = await screen.findByRole('dialog');
    expect(within(again).queryByRole('alert')).toBeNull();
    expect(within(again).getByRole('button', { name: 'Archive' })).toBeInTheDocument();
  });

  it('restore: a refusal is an alert in the restore dialog', async () => {
    const { restoreLocationAction } = await import('@/server/actions/locations');
    vi.mocked(restoreLocationAction).mockResolvedValueOnce({
      ok: false,
      error: { code: 'conflict', message: 'A location with this name already exists.' },
    } as never);
    const user = userEvent.setup();
    render(<LocationsManager initial={[ROWS[0]!]} view="archived" canManage />);
    await user.click(screen.getByRole('button', { name: /Restore/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'A location with this name already exists.',
      ),
    );
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      'A location with this name already exists.',
    );
  });
});
