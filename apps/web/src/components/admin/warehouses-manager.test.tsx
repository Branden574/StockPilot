import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The admin Warehouses list and dialog in the redesign (W-AD-03, W-AD-03a):
 * the header carries the Active / Archived toggle and "New", the table keeps
 * its columns and row actions, and "Charters serviced" is a real multi-select
 * whose state no longer rests on colour alone.
 */

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
  usePathname: () => '/dashboard/admin/warehouses',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const actions = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  restore: vi.fn(),
}));
vi.mock('@/server/actions/warehouses', () => ({
  createWarehouseAction: actions.create,
  updateWarehouseAction: actions.update,
  archiveWarehouseAction: actions.archive,
  restoreWarehouseAction: actions.restore,
}));

import { WarehousesManager } from './warehouses-manager';

const ROW = {
  id: 'w1',
  name: 'North DC',
  code: 'NDC',
  charters: [{ id: 'c1', name: 'Harbor' }],
  contact_name: null,
  contact_email: null,
  contact_phone: null,
  manager_user_id: null,
  manager_name: null,
  status: 'active' as const,
  notes: null,
  user_count: 4,
  item_count: 120,
};

const CHARTERS = [
  { id: 'c1', name: 'Harbor' },
  { id: 'c2', name: 'Ridge' },
];

function renderManager(view: 'active' | 'archived' = 'active') {
  return render(
    <WarehousesManager
      view={view}
      initial={[ROW]}
      charters={CHARTERS}
      managers={[{ id: 'm1', name: 'Morgan Manager' }]}
      termSingular="Depot"
      charterSingular="Region"
      eyebrow="Admin"
      title="Depots"
      subline="Physical locations stock lives in."
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WarehousesManager', () => {
  it('draws the page header with the terminology title, the view toggle and New', () => {
    renderManager();
    expect(screen.getByRole('heading', { level: 1, name: 'Depots' })).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'View filter' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Archived' })).toHaveAttribute(
      'href',
      '/dashboard/admin/warehouses?view=archived',
    );
    expect(screen.getByRole('button', { name: 'New depot' })).toBeInTheDocument();
  });

  it('keeps every column, the detail link and the row actions; the actions sit in a box inside a real cell', () => {
    renderManager();
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Name',
      'Code',
      'Region',
      'Manager',
      'Users',
      'Items',
      'Actions',
    ]);
    expect(screen.getByRole('link', { name: 'North DC' })).toHaveAttribute(
      'href',
      '/dashboard/warehouses/w1',
    );
    const row = screen.getByRole('link', { name: 'North DC' }).closest('tr')!;
    const edit = within(row).getByRole('button', { name: 'Edit' });
    const archive = within(row).getByRole('button', { name: 'Archive' });
    // The cell stays a table cell: the flex layout is on a box inside it.
    const cell = edit.closest('td')!;
    expect(cell.className).not.toMatch(/(^|\s)flex(\s|$)/);
    expect(archive.closest('td')).toBe(cell);
  });

  it('hides New in the archived view and offers Restore with its confirm', async () => {
    actions.restore.mockResolvedValue({ ok: false, error: { message: 'Restore refused.' } });
    renderManager('archived');
    expect(screen.queryByRole('button', { name: 'New depot' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Restore/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Restore "North DC"?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    // A refusal is said inside the dialog, where it can be seen.
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Restore refused.');
    expect(actions.restore).toHaveBeenCalledWith('w1');
  });

  it('makes Charters serviced a named multi-select of pressed toggles with a non-colour tick', async () => {
    actions.update.mockResolvedValue({ ok: true });
    renderManager();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    const group = within(dialog).getByRole('group', { name: 'Charters serviced' });
    const harbor = within(group).getByRole('button', { name: 'Harbor' });
    const ridge = within(group).getByRole('button', { name: 'Ridge' });
    expect(harbor).toHaveAttribute('aria-pressed', 'true');
    expect(harbor.querySelector('svg')).not.toBeNull();
    expect(ridge).toHaveAttribute('aria-pressed', 'false');
    expect(ridge.querySelector('svg')).toBeNull();

    fireEvent.click(ridge);
    expect(ridge).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(harbor);
    expect(harbor).toHaveAttribute('aria-pressed', 'false');

    // The contact boxes are named, and the manager select is tied to its label.
    expect(within(dialog).getByRole('textbox', { name: 'Contact name' })).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Contact email' })).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Contact phone' })).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: /Manager/ })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(actions.update).toHaveBeenCalled());
    expect(actions.update).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({
        name: 'North DC',
        code: 'NDC',
        charterIds: ['c2'],
        status: 'active',
      }),
    );
  });

  it('keeps the submit button’s words beside the spinner while it saves', async () => {
    let finish: (v: unknown) => void = () => {};
    actions.update.mockReturnValue(new Promise((r) => (finish = r)));
    renderManager();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Save changes' })).toBeDisabled(),
    );
    finish({ ok: true });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
