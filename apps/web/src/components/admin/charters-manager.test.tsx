import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The admin Charters list and dialog in the redesign (W-AD-02, W-AD-02a):
 * terminology in the header and buttons, the shipping-address warning as a
 * worded status label, a bounded address cell, the archive confirm, and every
 * dialog field with its limits.
 */

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
  usePathname: () => '/dashboard/admin/charters',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const actions = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  restore: vi.fn(),
}));
vi.mock('@/server/actions/charters', () => ({
  createCharterAction: actions.create,
  updateCharterAction: actions.update,
  archiveCharterAction: actions.archive,
  restoreCharterAction: actions.restore,
}));

import { ChartersManager } from './charters-manager';

const BASE = {
  code: null,
  description: null,
  notes: null,
  status: 'active' as const,
  contact_name: null,
  contact_email: null,
  contact_phone: null,
  warehouse_count: 2,
  user_count: 5,
};
const NO_ADDRESS = { ...BASE, id: 'c1', name: 'Harbor', address: null };
const WITH_ADDRESS = {
  ...BASE,
  id: 'c2',
  name: 'Ridge',
  code: 'RDG',
  address: {
    line1: '1200 A Very Long Industrial Parkway Building 7',
    city: 'Fresno',
    region: 'CA',
    postalCode: '93706',
    country: 'USA',
  },
};

function renderManager(rows = [NO_ADDRESS, WITH_ADDRESS]) {
  return render(
    <ChartersManager
      initial={rows}
      termSingular="Region"
      eyebrow="Admin"
      title="Regions"
      subline="Top-level groupings for warehouses."
    />,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('ChartersManager', () => {
  it('uses the org terminology in the heading and the New button', () => {
    renderManager();
    expect(screen.getByRole('heading', { level: 1, name: 'Regions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New region' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Active' })).toHaveAttribute('aria-selected', 'true');
  });

  it('says a missing address is needed for shipping labels in words, and wraps a long address in a bounded cell', () => {
    renderManager();
    expect(screen.getByText('Needed for shipping labels')).toBeInTheDocument();
    const address = screen.getByText(
      /1200 A Very Long Industrial Parkway Building 7, Fresno, CA 93706, USA/,
    );
    const cell = address.closest('td')!;
    expect(cell.className).toMatch(/max-w-\[280px\]/);
    expect(address.className).toMatch(/break-words/);
    expect(cell.className).not.toMatch(/whitespace-nowrap/);
  });

  it('opens the archive confirm with its words and archives on confirm', async () => {
    actions.archive.mockResolvedValue({ ok: true });
    renderManager([NO_ADDRESS]);
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Archive "Harbor"?')).toBeInTheDocument();
    expect(within(dialog).getByText(/Existing warehouses keep working/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(actions.archive).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('keeps every dialog field, and its limits and the name rule stop a save', async () => {
    renderManager([NO_ADDRESS]);
    fireEvent.click(screen.getByRole('button', { name: 'New region' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'New region' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Name')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Code/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Description/)).toBeInTheDocument();
    for (const name of [
      'Address line 1',
      'Address line 2',
      'City',
      'State or region',
      'Postal code',
      'Country',
      'Contact name',
      'Contact email',
      'Contact phone',
    ]) {
      expect(within(dialog).getByRole('textbox', { name })).toBeInTheDocument();
    }
    expect(within(dialog).getByLabelText(/Internal notes/)).toBeInTheDocument();
    const create = within(dialog).getByRole('button', { name: 'Create region' });

    // Empty name: the rule's words, and nothing is sent.
    fireEvent.click(create);
    expect(await within(dialog).findByText('Name is required.')).toBeInTheDocument();

    // A name over 120 characters is refused the same way (react-hook-form
    // checks the limit on submit; it never reaches the server).
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'x'.repeat(121) },
    });
    fireEvent.click(create);
    expect(await within(dialog).findByText('Name is required.')).toBeInTheDocument();

    // A code over 32 characters stops the save too.
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Harbor' } });
    fireEvent.change(within(dialog).getByLabelText(/Code/), { target: { value: 'C'.repeat(33) } });
    fireEvent.click(create);
    await new Promise((r) => setTimeout(r, 50));
    expect(actions.create).not.toHaveBeenCalled();
  });
});
