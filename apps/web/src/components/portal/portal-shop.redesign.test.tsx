import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PortalShop } from './portal-shop';

/**
 * The B2B portal after the redesign (P5.1 step B): it shows the portal's own
 * fields and nothing more, keeps every word of its panels, and keeps its cart
 * bar opaque (no blur) with the order rows wrapping inside their card.
 */

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

const actions = vi.hoisted(() => ({
  submitPortalOrderAction: vi.fn(),
  requestPortalReturnAction: vi.fn(),
  portalReturnSheetAction: vi.fn(),
  portalReturnOptionsAction: vi.fn(),
}));
vi.mock('@/server/actions/portal', () => actions);

/** Values an internal item or order holds that the portal must never show. */
const INTERNAL = {
  unitCost: 987.65,
  binLocation: 'RACK 9-Q SHELF 4',
  locationName: 'Back Room Cage',
  reservedQuantity: 4242,
  reorderPoint: 3131,
  internalNotes: 'internal note: never shown to a customer',
  supplierName: 'Wholesale Secret Supplier',
  approvedByName: 'Morgan Staffmember',
  denialReason: 'staff-only reason',
};

const NOTEBOOK = {
  itemId: 'i-1',
  name: 'Composition Notebook',
  sku: 'NB-001',
  imageUrl: null,
  unitPrice: 12.5,
  quotable: false,
  quantityAvailable: 28,
};
const MARKERS = {
  itemId: 'i-2',
  name: 'Dry Erase Markers',
  sku: null,
  imageUrl: null,
  unitPrice: null,
  quotable: true,
  quantityAvailable: 0,
};

function order(over: Record<string, unknown> = {}) {
  return {
    id: 'abcdef12-3456-4789-8abc-def012345678',
    status: 'pending_approval',
    created_at: '2026-10-06T18:30:00.000Z',
    total: 25,
    lines: [
      {
        orderRequestLineId: 'ol-1',
        itemId: 'i-1',
        name: 'Composition Notebook',
        quantity: 2,
        unitPrice: 12.5,
        quantityFulfilled: 0,
        quantityReturned: 0,
        quantityPendingReturn: 0,
      },
    ],
    returns: [],
    ...over,
  };
}

type ShopProps = React.ComponentProps<typeof PortalShop>;

function shop(over: Partial<ShopProps> = {}) {
  return render(
    <PortalShop
      catalog={[NOTEBOOK, MARKERS]}
      orders={[]}
      returnsEnabled={false}
      pricingMode="priced"
      {...over}
    />,
  );
}

beforeEach(() => {
  refresh.mockReset();
  for (const fn of Object.values(actions)) fn.mockReset();
});

describe('the portal shows its own fields only', () => {
  it('a catalog card is name, SKU, available units and price or Request quote, even when the object carries more', () => {
    const leaky = [NOTEBOOK, MARKERS].map((it) => ({ ...it, ...INTERNAL }));
    const leakyOrder = { ...order(), ...INTERNAL };
    const { container } = shop({
      catalog: leaky as ShopProps['catalog'],
      orders: [leakyOrder] as ShopProps['orders'],
    });

    expect(screen.getByText('Composition Notebook', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('NB-001')).toBeInTheDocument();
    expect(screen.getByText('28 available')).toBeInTheDocument();
    expect(screen.getByText('Out of stock — ships when available')).toBeInTheDocument();
    expect(screen.getByText('$12.50')).toBeInTheDocument();
    expect(screen.getByText('Request quote')).toBeInTheDocument();

    const html = container.innerHTML;
    for (const [field, value] of Object.entries(INTERNAL)) {
      expect(html, field).not.toContain(String(value));
    }
  });

  it('in no-charge mode prints no price, no quote and no total anywhere', () => {
    shop({ pricingMode: 'no_charge', orders: [order()] });
    fireEvent.click(screen.getByRole('button', { name: 'Add one Composition Notebook' }));
    expect(screen.queryByText(/\$/)).toBeNull();
    expect(screen.queryByText('Request quote')).toBeNull();
    expect(screen.getByText('1 units')).toBeInTheDocument();
  });
});

describe('the portal keeps its words', () => {
  it('names the catalog and its count, and the orders section', () => {
    const { rerender } = shop();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Catalog · 2 items' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Your orders' })).toBeInTheDocument();
    rerender(
      <PortalShop catalog={[NOTEBOOK]} orders={[]} returnsEnabled={false} pricingMode="priced" />,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Catalog · 1 item' })).toBeInTheDocument();
  });

  it('says an empty catalog in the words of its pricing mode, and an empty history', () => {
    const { rerender } = shop({ catalog: [], pricingMode: 'priced' });
    expect(
      screen.getByText(
        "Your catalog is empty right now — your supplier hasn't priced any items for your account yet.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('No orders yet — your history will appear here.')).toBeInTheDocument();
    rerender(
      <PortalShop catalog={[]} orders={[]} returnsEnabled={false} pricingMode="no_charge" />,
    );
    expect(
      screen.getByText("Your supplier hasn't added any items to this account's catalog yet."),
    ).toBeInTheDocument();
  });

  it('prints each order status in its own words: the shared label, or the stored key when it has none', () => {
    shop({
      orders: [
        order({ id: '11111111-0000-4000-8000-000000000001', status: 'pending_approval' }),
        order({ id: '22222222-0000-4000-8000-000000000002', status: 'completed' }),
        order({ id: '33333333-0000-4000-8000-000000000003', status: 'some_new_status' }),
      ],
    });
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Delivered')).toBeInTheDocument();
    expect(screen.getByText('some_new_status')).toBeInTheDocument();
    expect(screen.getByText('#11111111')).toBeInTheDocument();
    expect(screen.getAllByText('2× Composition Notebook')).toHaveLength(3);
  });

  it('the cart bar counts units and the total, and Place order sends the lines and notes, then says Order submitted', async () => {
    actions.submitPortalOrderAction.mockResolvedValue({
      ok: true,
      data: { id: 'fedcba98-7654-4321-8abc-def012345678' },
    });
    shop();
    fireEvent.click(screen.getByRole('button', { name: 'Add one Composition Notebook' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add one Composition Notebook' }));
    expect(screen.getByText(/^2 units/)).toBeInTheDocument();
    expect(screen.getByText('$25.00')).toBeInTheDocument();

    const notes = screen.getByRole('textbox', { name: 'Notes for your supplier (optional)' });
    expect(notes).toHaveAttribute('placeholder', 'Notes for your supplier (optional)');
    expect(notes).toHaveAttribute('maxLength', '2000');
    fireEvent.change(notes, { target: { value: 'Leave at the front desk' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Place order' }));
    });
    expect(actions.submitPortalOrderAction).toHaveBeenCalledWith({
      lines: [{ itemId: 'i-1', quantity: 2 }],
      notes: 'Leave at the front desk',
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Order submitted — your supplier will review and confirm it. Reference: FEDCBA98',
    );
    // The cart is empty again, so the bar is gone.
    expect(screen.queryByRole('button', { name: 'Place order' })).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a reorder that skips items says so in the cart bar', () => {
    shop({
      orders: [
        order({
          lines: [
            ...order().lines,
            {
              orderRequestLineId: 'ol-2',
              itemId: 'gone',
              name: 'Discontinued Folder',
              quantity: 1,
              unitPrice: 1,
              quantityFulfilled: 0,
              quantityReturned: 0,
              quantityPendingReturn: 0,
            },
          ],
        }),
      ],
    });
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Reorder' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      '1 item is no longer available and was left out.',
    );
    expect(screen.getByText(/^2 units/)).toBeInTheDocument();
  });

  it('the stepper keeps its names and rules: minus off at zero, digits only, at most 100000', () => {
    shop();
    const minus = screen.getByRole('button', { name: 'Remove one Composition Notebook' });
    const qty = screen.getByRole('textbox', { name: 'Quantity of Composition Notebook' });
    expect(minus).toBeDisabled();
    expect(qty).toHaveAttribute('inputMode', 'numeric');
    expect(qty).toHaveAttribute('placeholder', '0');
    fireEvent.change(qty, { target: { value: '12a3' } });
    expect(qty).toHaveValue('123');
    fireEvent.change(qty, { target: { value: '999999' } });
    expect(qty).toHaveValue('100000');
    expect(minus).toBeEnabled();
  });
});

describe('the portal look keeps the performance and phone rules', () => {
  it('the cart bar is opaque: nothing on the page blurs what is behind it', () => {
    const { container } = shop();
    fireEvent.click(screen.getByRole('button', { name: 'Add one Composition Notebook' }));
    const bar = screen
      .getByRole('button', { name: 'Place order' })
      .closest('.fixed') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.className).toMatch(/\bbg-card\b/);
    expect(container.innerHTML).not.toMatch(/backdrop-blur|bg-background\/\d+/);
  });

  it('on a phone the cart bar puts the count on its own line, then the notes and Place order in the order a keyboard reaches them', () => {
    shop();
    fireEvent.click(screen.getByRole('button', { name: 'Add one Composition Notebook' }));
    const count = screen.getByText(/^1 units/);
    expect((count.parentElement as HTMLElement).className).toMatch(/\bmax-sm:basis-full\b/);
    const notes = screen.getByRole('textbox', { name: 'Notes for your supplier (optional)' });
    const place = screen.getByRole('button', { name: 'Place order' });
    expect(notes.compareDocumentPosition(place) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing moves a control away from its place in the focus order.
    const bar = place.closest('.fixed') as HTMLElement;
    expect(bar.innerHTML).not.toMatch(/\border-(?:first|last|\d+)\b/);
  });

  it('the stepper ends are 44 px on a phone and on coarse pointers (a touch tablet too), as the rental stepper', () => {
    shop();
    for (const item of [NOTEBOOK, MARKERS]) {
      const minus = screen.getByRole('button', { name: `Remove one ${item.name}` });
      const plus = screen.getByRole('button', { name: `Add one ${item.name}` });
      for (const button of [minus, plus]) {
        const label = button.getAttribute('aria-label') ?? '';
        expect(button.className, label).toMatch(/(^|\s)max-sm:w-11(\s|$)/);
        expect(button.className, label).toMatch(/(^|\s)pointer-coarse:w-11(\s|$)/);
      }
      // One joined control: both ends share the stepper, which is 44 px tall
      // on a phone and on a touch screen.
      const stepper = minus.parentElement as HTMLElement;
      expect(plus.parentElement).toBe(stepper);
      expect(stepper.className, `${item.name} stepper`).toMatch(/(^|\s)max-sm:h-11(\s|$)/);
      expect(stepper.className, `${item.name} stepper`).toMatch(/(^|\s)pointer-coarse:h-11(\s|$)/);
    }
  });

  it('an order row lets its status, total and actions wrap under its words (they ran off a 390 px screen)', () => {
    shop({ orders: [order({ status: 'completed' })], returnsEnabled: true });
    const reorder = screen.getByRole('button', { name: 'Reorder' });
    const actionsRow = reorder.parentElement as HTMLElement;
    expect(actionsRow.className).toMatch(/\bflex-wrap\b/);
    expect(actionsRow.className).not.toMatch(/\bshrink-0\b/);
    expect((actionsRow.parentElement as HTMLElement).className).toMatch(/\bflex-wrap\b/);
    expect(within(actionsRow).getByText('Delivered')).toBeInTheDocument();
  });
});
