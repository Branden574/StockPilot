import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Vendor item mappings in the redesign (W-AD-05): every add-form field is
 * named by its label, the table keeps its columns and fallbacks, and the
 * delete confirm keeps its words and shows a refusal inside it.
 */

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const actions = vi.hoisted(() => ({ upsert: vi.fn(), remove: vi.fn() }));
vi.mock('@/server/actions/vendor-item-mappings', () => ({
  upsertVendorItemMappingAction: actions.upsert,
  deleteVendorItemMappingAction: actions.remove,
}));

import { VendorMappingsManager } from './vendor-mappings-manager';

const MAPPING = {
  id: 'm1',
  vendor_id: 's1',
  item_id: 'i-outside-the-500',
  vendor_item_number: '867474',
  vendor_product_number: null,
  auxiliary_number: null,
  vendor_description: null,
};

beforeEach(() => vi.clearAllMocks());

describe('VendorMappingsManager', () => {
  it('names every add-form field and keeps the table columns and the raw-id fallback', () => {
    render(
      <VendorMappingsManager
        mappings={[MAPPING]}
        suppliers={[{ id: 's1', name: 'Staples' }]}
        items={[{ id: 'i1', sku: 'AA-24', name: 'AA batteries' }]}
      />,
    );
    for (const label of ['Vendor', 'Internal item', 'Vendor item number', /Vendor description/]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    const table = screen.getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Vendor', 'Vendor item #', 'Internal item', '']);
    expect(within(table).getByText('Staples')).toBeInTheDocument();
    expect(within(table).getByText('i-outside-the-500')).toBeInTheDocument();
  });

  it('keeps the delete confirm words and shows a refusal inside it', async () => {
    actions.remove.mockResolvedValue({ ok: false, error: { message: 'Not allowed.' } });
    render(<VendorMappingsManager mappings={[MAPPING]} suppliers={[]} items={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/Future PO imports from this vendor will no longer auto-link/),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(actions.remove).toHaveBeenCalledWith('m1'));
    expect(await within(dialog).findByText('Not allowed.')).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
