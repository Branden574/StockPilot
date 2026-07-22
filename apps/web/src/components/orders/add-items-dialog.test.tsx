// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';

import { addOrderRequestLinesAction } from '@/server/actions/order-requests';

import { AddItemsDialog, pickerEmptyMessage, summarizeAddLines } from './add-items-dialog';

const refreshSpy = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshSpy, push: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/server/actions/order-requests', () => ({
  addOrderRequestLinesAction: vi.fn(),
}));

const addLines = vi.mocked(addOrderRequestLinesAction);
const toastMock = vi.mocked(toast);

type Row = {
  id: string;
  sku: string;
  name: string;
  quantity_on_hand: number;
  item_type: string;
  warehouse_id: string | null;
};

function row(over: Partial<Row> & { id: string }): Row {
  return {
    sku: `SKU-${over.id}`,
    name: `Item ${over.id}`,
    quantity_on_hand: 3,
    item_type: 'product',
    warehouse_id: 'wh-1',
    ...over,
  };
}

function jsonResponse(items: Row[], total = items.length) {
  return { ok: true, json: async () => ({ items, total }) } as Response;
}

const fetchSpy = vi.fn();

type Props = React.ComponentProps<typeof AddItemsDialog>;

function baseProps(over: Partial<Props> = {}): Props {
  return {
    orderId: '11111111-1111-4111-8111-111111111111',
    status: 'approved',
    warehouseId: 'wh-1',
    warehouseName: 'Main DC',
    existingLines: [],
    ...over,
  };
}

function lastUrl(): URL {
  const call = fetchSpy.mock.calls.at(-1);
  if (!call) throw new Error('no fetch was made');
  return new URL(String(call[0]), 'https://example.com');
}

/** Render + open the dialog, waiting for page 1 to land. */
async function open(over: Partial<Props> = {}) {
  const user = userEvent.setup();
  render(<AddItemsDialog {...baseProps(over)} />);
  await user.click(screen.getByRole('button', { name: /add items/i }));
  await screen.findByRole('dialog');
  return user;
}

describe('AddItemsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchSpy);
    fetchSpy.mockResolvedValue(jsonResponse([]));
    addLines.mockResolvedValue({
      ok: true,
      data: { added: 1, merged: 0, pickSlipStale: false },
    });
  });

  // ── Ship gate ────────────────────────────────────────────────────
  it.each(['in_transit', 'completed', 'denied', 'cancelled'] as const)(
    'renders nothing on %s — the service would reject the add with a conflict',
    (status) => {
      const { container } = render(<AddItemsDialog {...baseProps({ status })} />);
      expect(container).toBeEmptyDOMElement();
    },
  );

  it.each(['pending_approval', 'approved', 'picking_in_progress', 'staged_for_delivery'] as const)(
    'offers the trigger on %s — adding is allowed right up until the order ships',
    (status) => {
      render(<AddItemsDialog {...baseProps({ status })} />);
      expect(screen.getByRole('button', { name: /add items/i })).toBeInTheDocument();
    },
  );

  // ── Warehouse pinning ────────────────────────────────────────────
  it('pins the browse search to THIS order’s warehouse and never offers a switcher', async () => {
    fetchSpy.mockResolvedValue(jsonResponse([row({ id: 'a', name: 'Alpha Charger' })]));
    await open();

    expect(await screen.findByText('Alpha Charger')).toBeInTheDocument();
    const url = lastUrl();
    expect(url.pathname).toBe('/api/items/search');
    expect(url.searchParams.get('wh')).toBe('wh-1');
    expect(url.searchParams.get('browse')).toBe('1');
    expect(url.searchParams.get('type')).toBe('product');
    // The order-creation catalog applies no item_type filter, so an asset or a
    // consumable can be ordered at creation — the Inventory tab has to reach
    // them too or those lines can never be topped up.
    expect(url.searchParams.getAll('type')).toEqual(['product', 'asset', 'consumable']);
    // Bundles are containers the order-creation catalog excludes; addLines has
    // no bundle check, so this dialog would otherwise be the one way in.
    expect(url.searchParams.get('bundles')).toBe('exclude');
    expect(url.searchParams.get('limit')).toBe('50');
    // An expected (awaiting-first-receipt) item is rejected by addLines, so the
    // picker must never opt into the expected view.
    expect(url.searchParams.get('expected')).toBeNull();
    expect(url.searchParams.get('q')).toBeNull();
    // The warehouse constraint is not user-editable.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('drops rows the API returned for a different warehouse', async () => {
    // /api/items/search treats `wh` as a convenience filter and force-narrows
    // warehouse-scoped users to their own assignments regardless of what we
    // pass, so a foreign-warehouse row can come back. It would fail server-side.
    fetchSpy.mockResolvedValue(
      jsonResponse([
        row({ id: 'a', name: 'Local Widget', warehouse_id: 'wh-1' }),
        row({ id: 'b', name: 'Foreign Widget', warehouse_id: 'wh-2' }),
      ]),
    );
    await open();

    expect(await screen.findByText('Local Widget')).toBeInTheDocument();
    expect(screen.queryByText('Foreign Widget')).not.toBeInTheDocument();
  });

  // ── Search ───────────────────────────────────────────────────────
  it('debounces typing into ONE server search carrying q', async () => {
    fetchSpy.mockResolvedValue(jsonResponse([row({ id: 'a', name: 'Alpha Charger' })]));
    const user = await open();
    await screen.findByText('Alpha Charger');
    const before = fetchSpy.mock.calls.length;

    await user.type(screen.getByRole('textbox', { name: /search items to add/i }), 'charg');
    await vi.waitFor(() => {
      expect(lastUrl().searchParams.get('q')).toBe('charg');
    });
    expect(fetchSpy.mock.calls.length).toBe(before + 1);
  });

  it('Books tab refetches with type=book and keeps the warehouse pin', async () => {
    fetchSpy.mockResolvedValue(jsonResponse([row({ id: 'a', name: 'Alpha Charger' })]));
    const user = await open();
    await screen.findByText('Alpha Charger');

    await user.click(screen.getByRole('button', { name: 'Books' }));
    await vi.waitFor(() => {
      expect(lastUrl().searchParams.get('type')).toBe('book');
    });
    // Books is a single type, not the Inventory tab's set.
    expect(lastUrl().searchParams.getAll('type')).toEqual(['book']);
    expect(lastUrl().searchParams.get('wh')).toBe('wh-1');
    expect(lastUrl().searchParams.get('bundles')).toBe('exclude');
  });

  // ── Top-up preview ───────────────────────────────────────────────
  it('shows a live top-up preview for an item already on the order', async () => {
    fetchSpy.mockResolvedValue(jsonResponse([row({ id: 'a', name: 'Widget' })]));
    const user = await open({
      existingLines: [{ itemId: 'a', name: 'Widget', quantity: 4 }],
    });

    await user.click(await screen.findByRole('button', { name: 'Select Widget' }));
    // Default quantity is 1, so the item total goes 4 -> 5.
    expect(screen.getByText(/going to 5 in total/i)).toBeInTheDocument();

    const qty = screen.getByRole('spinbutton', { name: 'Quantity for Widget' });
    await user.clear(qty);
    await user.type(qty, '3');
    expect(screen.getByText(/going to 7 in total/i)).toBeInTheDocument();
    await user.clear(qty);
    await user.type(qty, '5');
    expect(screen.getByText(/going to 9 in total/i)).toBeInTheDocument();
  });

  it('describes the ITEM total, never a single line, for a summed duplicate item', async () => {
    fetchSpy.mockResolvedValue(jsonResponse([row({ id: 'a', name: 'Widget' })]));
    // The page sums duplicate lines per item because addLines tops up against
    // the item. It tops up only ONE of those lines (its existingByItem Map is
    // last-row-wins), so promising "tops up line to 11" names a number that
    // appears on no line at all. The item total is true either way.
    const user = await open({
      existingLines: [{ itemId: 'a', name: 'Widget', quantity: 10 }],
    });

    await user.click(await screen.findByRole('button', { name: 'Select Widget' }));
    expect(screen.getByText(/going to 11 in total/i)).toBeInTheDocument();
    expect(screen.queryByText(/tops up line to/i)).not.toBeInTheDocument();
  });

  it('shows no top-up text for a picked item that is not on the order', async () => {
    fetchSpy.mockResolvedValue(jsonResponse([row({ id: 'z', name: 'Brand New' })]));
    const user = await open({
      existingLines: [{ itemId: 'a', name: 'Widget', quantity: 4 }],
    });

    await user.click(await screen.findByRole('button', { name: 'Select Brand New' }));
    expect(screen.queryByText(/in total/i)).not.toBeInTheDocument();
  });

  // ── Submit ───────────────────────────────────────────────────────
  it('submits every staged pick with its quantity, defaulting to 1', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse([
        row({ id: '22222222-2222-4222-8222-222222222222', name: 'First' }),
        row({ id: '33333333-3333-4333-8333-333333333333', name: 'Second' }),
      ]),
    );
    const user = await open();

    await user.click(await screen.findByRole('button', { name: 'Select First' }));
    await user.click(screen.getByRole('button', { name: 'Select Second' }));
    const qty = screen.getByRole('spinbutton', { name: 'Quantity for Second' });
    await user.clear(qty);
    await user.type(qty, '6');
    await user.click(screen.getByRole('button', { name: /add to order/i }));

    expect(addLines).toHaveBeenCalledTimes(1);
    expect(addLines).toHaveBeenCalledWith({
      id: '11111111-1111-4111-8111-111111111111',
      lines: [
        { itemId: '22222222-2222-4222-8222-222222222222', quantity: 1 },
        { itemId: '33333333-3333-4333-8333-333333333333', quantity: 6 },
      ],
    });
  });

  it('blocks submit with nothing staged, and again when a quantity is cleared', async () => {
    fetchSpy.mockResolvedValue(jsonResponse([row({ id: 'a', name: 'Widget' })]));
    const user = await open();

    expect(screen.getByRole('button', { name: /add to order/i })).toBeDisabled();

    await user.click(await screen.findByRole('button', { name: 'Select Widget' }));
    expect(screen.getByRole('button', { name: /add to order/i })).toBeEnabled();

    // A blank field parses to 0, which addLines rejects — catch it here rather
    // than round-tripping for a validation error.
    await user.clear(screen.getByRole('spinbutton', { name: 'Quantity for Widget' }));
    expect(screen.getByRole('button', { name: /add to order/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /add to order/i }));
    expect(addLines).not.toHaveBeenCalled();
  });

  it('reports added vs topped-up counts, refreshes and closes on success', async () => {
    fetchSpy.mockResolvedValue(jsonResponse([row({ id: 'a', name: 'Widget' })]));
    addLines.mockResolvedValue({
      ok: true,
      data: { added: 2, merged: 1, pickSlipStale: false },
    });
    const user = await open();

    await user.click(await screen.findByRole('button', { name: 'Select Widget' }));
    await user.click(screen.getByRole('button', { name: /add to order/i }));

    await vi.waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith('2 items added, 1 line topped up.');
    });
    expect(toastMock.warning).not.toHaveBeenCalled();
    expect(refreshSpy).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('warns to reprint when the add invalidated an already-printed pick slip', async () => {
    fetchSpy.mockResolvedValue(jsonResponse([row({ id: 'a', name: 'Widget' })]));
    addLines.mockResolvedValue({
      ok: true,
      data: { added: 1, merged: 0, pickSlipStale: true },
    });
    const user = await open();

    await user.click(await screen.findByRole('button', { name: 'Select Widget' }));
    await user.click(screen.getByRole('button', { name: /add to order/i }));

    await vi.waitFor(() => {
      expect(toastMock.warning).toHaveBeenCalledWith(
        'The printed pick slip is now out of date. Generate it again before picking.',
        { duration: 8000 },
      );
    });
  });

  it('keeps the dialog and the staged tray intact when the action fails', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse([
        row({ id: 'a', name: 'Widget' }),
        row({ id: 'b', name: 'Gadget' }),
      ]),
    );
    addLines.mockResolvedValue({
      ok: false,
      error: {
        code: 'conflict',
        message:
          'This order is already out for delivery — create a new order for the extra items.',
      },
    });
    const user = await open();

    await user.click(await screen.findByRole('button', { name: 'Select Widget' }));
    await user.click(screen.getByRole('button', { name: 'Select Gadget' }));
    await user.click(screen.getByRole('button', { name: /add to order/i }));

    await vi.waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        'This order is already out for delivery — create a new order for the extra items.',
      );
    });
    expect(refreshSpy).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByRole('spinbutton', { name: 'Quantity for Widget' }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('spinbutton', { name: 'Quantity for Gadget' }),
    ).toBeInTheDocument();
  });

  // ── Paging ───────────────────────────────────────────────────────
  it('pages by rows RECEIVED, not rows rendered, so a filtered page still advances', async () => {
    // Page 1 comes back with 2 rows, one of them foreign-warehouse (dropped).
    // Offsetting by the rendered count would re-request offset 1 forever.
    fetchSpy.mockResolvedValue(
      jsonResponse(
        [
          row({ id: 'a', name: 'Local Widget' }),
          row({ id: 'b', name: 'Foreign Widget', warehouse_id: 'wh-2' }),
        ],
        5,
      ),
    );
    const user = await open();
    await screen.findByText('Local Widget');

    fetchSpy.mockResolvedValueOnce(
      jsonResponse([row({ id: 'c', name: 'Second Page Widget' })], 5),
    );
    await user.click(screen.getByRole('button', { name: /load more/i }));

    expect(await screen.findByText('Second Page Widget')).toBeInTheDocument();
    expect(lastUrl().searchParams.get('offset')).toBe('2');
  });

  it('still offers Load more when the warehouse filter emptied the whole page', async () => {
    // InventoryService.list ignores `wh=` for warehouse-scoped users and
    // narrows to their assignments instead, so a page sorted name_asc can be
    // entirely another warehouse's stock. With Load more nested inside the
    // non-empty branch the user was stranded on a false empty state.
    fetchSpy.mockResolvedValue(
      jsonResponse(
        [
          row({ id: 'a', name: 'Foreign One', warehouse_id: 'wh-2' }),
          row({ id: 'b', name: 'Foreign Two', warehouse_id: 'wh-2' }),
        ],
        5,
      ),
    );
    const user = await open();

    const loadMore = await screen.findByRole('button', { name: /load more/i });
    expect(loadMore).toBeInTheDocument();
    // And the copy does not claim the warehouse is empty.
    expect(screen.getByText(/load more to keep looking/i)).toBeInTheDocument();

    fetchSpy.mockResolvedValueOnce(
      jsonResponse([row({ id: 'c', name: 'Second Page Widget' })], 5),
    );
    await user.click(loadMore);

    expect(await screen.findByText('Second Page Widget')).toBeInTheDocument();
    expect(lastUrl().searchParams.get('offset')).toBe('2');
  });

  it('points an empty final page at warehouse access rather than at empty stock', async () => {
    fetchSpy.mockResolvedValue(jsonResponse([], 0));
    await open();

    expect(
      await screen.findByText(/ask an administrator for access to it/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });
});

describe('pickerEmptyMessage', () => {
  it('never asserts the warehouse is empty on a final page — it may be access', () => {
    const msg = pickerEmptyMessage({ query: '', isBooks: false, morePages: false });
    expect(msg).toContain('ask an administrator for access');
    expect(msg).not.toMatch(/stocked at this warehouse yet/i);
  });

  it('sends the user to Load more while pages remain', () => {
    expect(pickerEmptyMessage({ query: '', isBooks: false, morePages: true })).toMatch(
      /load more to keep looking/i,
    );
    expect(pickerEmptyMessage({ query: 'pen', isBooks: true, morePages: true })).toMatch(
      /“pen”.*load more to keep looking/i,
    );
  });

  it('names the tab noun on an exhausted search', () => {
    expect(pickerEmptyMessage({ query: 'pen', isBooks: true, morePages: false })).toBe(
      'No books at this warehouse match “pen”.',
    );
    expect(pickerEmptyMessage({ query: ' pen ', isBooks: false, morePages: false })).toBe(
      'No items at this warehouse match “pen”.',
    );
  });
});

describe('summarizeAddLines', () => {
  it.each([
    [1, 0, '1 item added.'],
    [2, 0, '2 items added.'],
    [0, 1, '1 line topped up.'],
    [0, 2, '2 lines topped up.'],
    [2, 1, '2 items added, 1 line topped up.'],
    [0, 0, 'Nothing changed.'],
  ])('(%i added, %i merged) reads "%s"', (added, merged, expected) => {
    expect(summarizeAddLines(added, merged)).toBe(expected);
  });
});
