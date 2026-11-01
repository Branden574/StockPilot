import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage } from '@/lib/request-failure';
import {
  offline,
  outOfDate,
  recordEscapedRejections,
  signInRedirect,
} from '@/test/rejected-request';

/**
 * Vendor item mappings in the redesign (W-AD-05): every add-form field is
 * named by its label, the table keeps its columns and fallbacks, and the
 * delete confirm keeps its words and shows a refusal inside it.
 */

const refresh = vi.fn();
// The real unstable_rethrow stays, so isControlFlow recognises a redirect.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), refresh }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const actions = vi.hoisted(() => ({ upsert: vi.fn(), remove: vi.fn() }));
vi.mock('@/server/actions/vendor-item-mappings', () => ({
  upsertVendorItemMappingAction: actions.upsert,
  deleteVendorItemMappingAction: actions.remove,
}));

import { STICKY_ACTIONS } from './sticky-actions';
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
    // Every organization sees the example, so it names no real brand (S17).
    expect(screen.getByLabelText(/Vendor description/)).toHaveAttribute(
      'placeholder',
      'AA batteries, 24 pack',
    );
    const table = screen.getByRole('table');
    // The page's title (titleId="vendor-mappings-title") names the table's scroll region.
    expect(table.parentElement).toHaveAttribute('role', 'region');
    expect(table.parentElement).toHaveAttribute('aria-labelledby', 'vendor-mappings-title');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Vendor', 'Vendor item #', 'Internal item', '']);
    expect(within(table).getByText('Staples')).toBeInTheDocument();
    expect(within(table).getByText('i-outside-the-500')).toBeInTheDocument();
  });

  // Look-only expectations (review 1b): the 560 px minimum applies from sm up
  // only, so a phone keeps the auto layout that showed every column whole, and
  // the Delete column carries the shared pin recipe, so it stays on screen
  // below md.
  it('keeps the minimum width to sm and up and pins Delete below md', () => {
    render(<VendorMappingsManager mappings={[MAPPING]} suppliers={[]} items={[]} />);
    const table = screen.getByRole('table');
    expect(table).toHaveClass('sm:min-w-[560px]');
    expect(table).not.toHaveClass('min-w-[560px]');
    const pin = STICKY_ACTIONS.split(' ');
    const heads = within(table).getAllByRole('columnheader');
    expect(heads[heads.length - 1]).toHaveClass(...pin);
    expect(within(table).getByRole('button', { name: 'Delete' }).closest('td')).toHaveClass(...pin);
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

// B40: a request that got no answer (offline, a server error, a deploy) used
// to leave the spinner on with nothing said.
describe('VendorMappingsManager when the request gets no answer', () => {
  it('Delete stops its spinner and says why inside the confirm, which stays open', async () => {
    actions.remove.mockRejectedValueOnce(offline());
    render(
      <VendorMappingsManager
        mappings={[MAPPING]}
        suppliers={[{ id: 's1', name: 'Staples' }]}
        items={[{ id: 'i1', sku: 'AA-24', name: 'AA batteries' }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      requestFailedMessage(offline(), 'delete the vendor mapping'),
    );
    expect(toast.error).toHaveBeenCalledWith(
      requestFailedMessage(offline(), 'delete the vendor mapping'),
    );
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
  });

  async function saveOne() {
    const user = userEvent.setup();
    render(
      <VendorMappingsManager
        mappings={[]}
        suppliers={[{ id: 's1', name: 'Sample Supply' }]}
        items={[{ id: 'i1', sku: 'AA-24', name: 'AA batteries' }]}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Vendor' }));
    await user.click(await screen.findByRole('option', { name: 'Sample Supply' }));
    await user.click(screen.getByRole('combobox', { name: 'Internal item' }));
    await user.click(await screen.findByRole('option', { name: 'AA-24 — AA batteries' }));
    await user.type(screen.getByLabelText('Vendor item number'), '100200');
    await user.click(screen.getByRole('button', { name: 'Save mapping' }));
  }

  for (const [row, error] of [
    ['no answer', offline],
    ['a page older than the server', outOfDate],
  ] as const) {
    it(`Save mapping, ${row}: says the mapping was not saved, keeps what was typed, and works again`, async () => {
      actions.upsert.mockRejectedValueOnce(error());
      await saveOne();
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          requestFailedMessage(error(), 'save the vendor mapping'),
        ),
      );
      const button = screen.getByRole('button', { name: 'Save mapping' });
      expect(button).toBeEnabled();
      expect(button).not.toHaveAttribute('aria-busy', 'true');
      expect(screen.getByLabelText('Vendor item number')).toHaveValue('100200');
      expect(toast.success).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    });
  }

  it('Save mapping answered with a redirect says nothing, and nothing is left to escape', async () => {
    actions.upsert.mockRejectedValueOnce(signInRedirect());
    await saveOne();
    await waitFor(() => expect(actions.upsert).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(escaped, 'the redirect is handled, never left to escape').toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});

// A redirect handled by the page leaves nothing behind (see recordEscapedRejections).
const escaped = recordEscapedRejections();
