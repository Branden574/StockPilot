// The Accounts panel in the redesign (P4.F2, row W-WS-10): expandable customer
// and price-list cards say whether they are open, the icon-only remove
// buttons have names, the item picker keeps its 8-match list over the items
// the page passed (the page reads at most 1,000; nothing here downloads the
// catalog), and its match rows hover on the neutral fill (the accent fill read
// 3.48:1 for the name and 1.21:1 for the SKU in light; P2.1 hand-off). The
// review fixes: the match rows' focus ring is drawn inside the clipped list, the
// price-list select has the control border, and an empty list says so through
// the shared StatePanel with its words unchanged.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage, requestUnconfirmedMessage } from '@/lib/request-failure';
import { offline } from '@/test/rejected-request';

const h = vi.hoisted(() => ({ addCatalog: vi.fn(), removeUser: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/customers', () => ({
  addCatalogItemAction: h.addCatalog,
  createCustomerAction: vi.fn(),
  createPriceListAction: vi.fn(),
  inviteCustomerUserAction: vi.fn(),
  removeCatalogItemAction: vi.fn(),
  removeCustomerUserAction: h.removeUser,
  removePriceAction: vi.fn(),
  setPriceAction: vi.fn(),
  updateCustomerAction: vi.fn(),
}));

import {
  createCustomerAction,
  createPriceListAction,
  inviteCustomerUserAction,
  removeCatalogItemAction,
  removePriceAction,
  setPriceAction,
  updateCustomerAction,
} from '@/server/actions/customers';

import { CustomersPanel, ITEM_MATCH_ROW } from './customers-panel';

import type { CustomerRow } from '@/server/services/customers';

beforeEach(() => {
  vi.clearAllMocks();
  h.addCatalog.mockResolvedValue({ ok: true, data: null });
  h.removeUser.mockResolvedValue({ ok: true, data: null });
});

const CUSTOMER = {
  id: 'cust-1',
  name: 'Westfield Academy',
  notes: null,
  status: 'active',
  price_list_id: null,
  price_list_name: null,
  user_count: 1,
  catalog_count: 1,
} as unknown as CustomerRow;

const ITEMS = Array.from({ length: 12 }, (_, i) => ({
  id: `item-${i}`,
  name: `Notebook ${i}`,
  sku: `NB-${i}`,
}));

function renderPanel(entitled = true) {
  render(
    <CustomersPanel
      customers={[CUSTOMER]}
      priceLists={[{ id: 'pl-1', name: 'Standard', item_count: 0 }]}
      items={ITEMS}
      usersByCustomer={{
        'cust-1': [
          {
            user_id: 'pu-1',
            email: 'buyer@westfield.test',
            invited_at: '2026-09-01',
            accepted_at: null,
          },
        ],
      }}
      catalogByCustomer={{ 'cust-1': [{ item_id: 'item-0', name: 'Notebook 0', sku: 'NB-0' }] }}
      pricesByList={{ 'pl-1': [] }}
      entitled={entitled}
    />,
  );
}

describe('CustomersPanel', () => {
  it('keeps the section headings with their counts', () => {
    renderPanel();
    expect(screen.getByRole('heading', { level: 2, name: 'Customers · 1' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Price lists · 1' })).toBeInTheDocument();
  });

  it('a card toggle says whether it is open and controls the detail it opens', async () => {
    const user = userEvent.setup();
    renderPanel();
    const toggle = screen.getByRole('button', { name: /Westfield Academy/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const detail = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(within(detail).getByLabelText('Price list')).toBeInTheDocument();

    const list = screen.getByRole('button', { name: /Standard/ });
    expect(list).toHaveAttribute('aria-expanded', 'false');
    await user.click(list);
    expect(list).toHaveAttribute('aria-expanded', 'true');
  });

  it('names the icon-only remove buttons and still removes the portal user', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /Westfield Academy/ }));
    expect(
      screen.getByRole('button', { name: 'Remove Notebook 0 from the catalog' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove buyer@westfield.test' }));
    await waitFor(() =>
      expect(h.removeUser).toHaveBeenCalledWith({ customerId: 'cust-1', userId: 'pu-1' }),
    );
  });

  it('the item picker shows at most 8 matches from the passed items, skips catalog items, and adds the pick', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /Westfield Academy/ }));
    await user.type(
      screen.getByPlaceholderText("Add an item to this customer's catalog…"),
      'notebook',
    );
    const matches = screen.getAllByRole('button').filter((b) => b.className === ITEM_MATCH_ROW);
    expect(matches).toHaveLength(8);
    expect(matches.map((m) => m.textContent)).not.toContain('Notebook 0NB-0');
    await user.click(matches[0]!);
    await waitFor(() =>
      expect(h.addCatalog).toHaveBeenCalledWith({ customerId: 'cust-1', itemId: 'item-1' }),
    );
  });

  it('match rows hover on the neutral fill with ink text, never the accent fill', () => {
    expect(ITEM_MATCH_ROW.split(/\s+/)).toEqual(
      expect.arrayContaining(['hover:bg-muted', 'hover:text-foreground']),
    );
    expect(ITEM_MATCH_ROW).not.toMatch(/bg-accent/);
  });

  // The match list clips its rows to its rounded corners (overflow-hidden),
  // and the global :focus-visible ring is drawn 2 px OUTSIDE the focused
  // element, so a keyboard-focused row showed only a sliver of its ring. The
  // row draws its own ring inside its box instead, as the card toggles do.
  it('a keyboard-focused match row draws its ring inside the row, where the list cannot clip it', async () => {
    expect(ITEM_MATCH_ROW.split(/\s+/)).toEqual(
      expect.arrayContaining([
        'focus-visible:ring-2',
        'focus-visible:ring-inset',
        'focus-visible:ring-offset-0',
        'focus-visible:ring-ring',
      ]),
    );
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /Westfield Academy/ }));
    await user.type(
      screen.getByPlaceholderText("Add an item to this customer's catalog…"),
      'notebook 1',
    );
    const row = screen.getAllByRole('button').find((b) => b.className === ITEM_MATCH_ROW)!;
    expect(row).toHaveTextContent('Notebook 1');
    await user.tab();
    expect(row).toHaveFocus();
  });

  // DESIGN-SPEC 2.4 item 3: a form control is never edged by the hairline
  // alone. The native price-list select drew --border, where the shared Input
  // and Select draw the stronger --ed-line-strong; it also stacks under its
  // label as the other fields do.
  it('the price-list select has the control border and sits under its label', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /Westfield Academy/ }));
    const select = screen.getByLabelText('Price list');
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveClass('border', 'border-line-strong', 'block');
    expect(select).not.toHaveClass('border-input');
  });

  it('says there are no customers and no price lists through the shared empty state, with the same words', () => {
    const { container } = render(
      <CustomersPanel
        customers={[]}
        priceLists={[]}
        items={ITEMS}
        usersByCustomer={{}}
        catalogByCustomer={{}}
        pricesByList={{}}
        entitled
      />,
    );
    const panels = container.querySelectorAll('[data-slot="state-panel"]');
    expect(panels).toHaveLength(2);
    expect(Array.from(panels).map((p) => p.getAttribute('data-state-kind'))).toEqual([
      'empty',
      'empty',
    ]);
    // h3s under the section h2s.
    expect(
      screen.getByRole('heading', { level: 3, name: 'No customers yet.' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Create one, assign a price list, and invite their first portal user.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: 'No price lists yet.' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Prices are explicit-only: an item with no price on a customer's list never appears in their portal.",
      ),
    ).toBeInTheDocument();
    // The section headings and their actions are unchanged.
    expect(screen.getByRole('heading', { level: 2, name: 'Customers · 0' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Price lists · 0' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New customer/ })).toBeEnabled();
  });

  it('keeps New customer and Invite off without the Business plan', async () => {
    const user = userEvent.setup();
    renderPanel(false);
    expect(screen.getByRole('button', { name: /New customer/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Westfield Academy/ }));
    await user.type(screen.getByPlaceholderText('buyer@customer.com'), 'x@y.test');
    expect(screen.getByRole('button', { name: 'Invite' })).toBeDisabled();
  });
});

// B40: every save here set the shared busy key, awaited the action with no
// catch and cleared the key only when it answered. A call that got no answer
// (offline, a server error, a deploy) left the control disabled with nothing
// said. Creating a customer or a price list twice would make two, so a lost
// create says to look before trying again.
describe('CustomersPanel when a request gets no answer', () => {
  function renderWithPrice() {
    render(
      <CustomersPanel
        customers={[CUSTOMER]}
        priceLists={[{ id: 'pl-1', name: 'Standard', item_count: 1 }]}
        items={ITEMS}
        usersByCustomer={{
          'cust-1': [
            {
              user_id: 'pu-1',
              email: 'buyer@westfield.test',
              invited_at: '2026-09-01',
              accepted_at: null,
            },
          ],
        }}
        catalogByCustomer={{ 'cust-1': [{ item_id: 'item-0', name: 'Notebook 0', sku: 'NB-0' }] }}
        pricesByList={{
          'pl-1': [{ item_id: 'item-3', name: 'Notebook 3', sku: 'NB-3', unit_price: 2 }],
        }}
        entitled
      />,
    );
  }

  it('New customer says to check the customer list, inside the dialog, and Create works again', async () => {
    const user = userEvent.setup();
    vi.mocked(createCustomerAction).mockRejectedValueOnce(offline());
    renderPanel();
    await user.click(screen.getByRole('button', { name: /New customer/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Northside Prep');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(
      await within(dialog).findByText(
        requestUnconfirmedMessage(offline(), 'the customer was added', 'the customer list'),
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('the Price list select says the list was not changed and can be used again', async () => {
    const user = userEvent.setup();
    vi.mocked(updateCustomerAction).mockRejectedValueOnce(offline());
    renderPanel();
    await user.click(screen.getByRole('button', { name: /Westfield Academy/ }));
    const select = screen.getByLabelText('Price list');
    await user.selectOptions(select, 'pl-1');
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'change the price list'),
      ),
    );
    expect(select).toBeEnabled();
  });

  it('Invite says the invite was not sent, under the field, and works again', async () => {
    const user = userEvent.setup();
    vi.mocked(inviteCustomerUserAction).mockRejectedValueOnce(offline());
    renderPanel();
    await user.click(screen.getByRole('button', { name: /Westfield Academy/ }));
    await user.type(screen.getByPlaceholderText('buyer@customer.com'), 'second@westfield.test');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      requestFailedMessage(offline(), 'send the invite'),
    );
    expect(screen.getByRole('button', { name: 'Invite' })).toBeEnabled();
  });

  it('removing a portal user, and adding or removing a catalog item, say what did not happen', async () => {
    const user = userEvent.setup();
    h.removeUser.mockRejectedValueOnce(offline());
    h.addCatalog.mockRejectedValueOnce(offline());
    vi.mocked(removeCatalogItemAction).mockRejectedValueOnce(offline());
    renderPanel();
    await user.click(screen.getByRole('button', { name: /Westfield Academy/ }));

    await user.click(screen.getByRole('button', { name: 'Remove buyer@westfield.test' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), 'remove the user')),
    );
    expect(screen.getByRole('button', { name: 'Remove buyer@westfield.test' })).toBeEnabled();

    await user.type(
      screen.getByPlaceholderText("Add an item to this customer's catalog…"),
      'notebook',
    );
    const matches = screen.getAllByRole('button').filter((b) => b.className === ITEM_MATCH_ROW);
    await user.click(matches[0]!);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'add the item to the catalog'),
      ),
    );

    const removeItem = screen.getByRole('button', { name: 'Remove Notebook 0 from the catalog' });
    await user.click(removeItem);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'remove the item from the catalog'),
      ),
    );
    expect(removeItem).toBeEnabled();
  });

  it('Add price list says to check the price lists; Save and remove a price say what did not happen', async () => {
    const user = userEvent.setup();
    vi.mocked(createPriceListAction).mockRejectedValueOnce(offline());
    vi.mocked(setPriceAction).mockRejectedValueOnce(offline());
    vi.mocked(removePriceAction).mockRejectedValueOnce(offline());
    renderWithPrice();

    await user.type(screen.getByLabelText('New price list name'), 'Summer');
    await user.click(screen.getByRole('button', { name: /Add/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestUnconfirmedMessage(offline(), 'the price list was created', 'the price lists'),
      ),
    );
    expect(screen.getByRole('button', { name: /Add/ })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: /Standard/ }));
    const removePrice = screen.getByRole('button', { name: 'Remove the price for Notebook 3' });
    await user.click(removePrice);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), 'remove the price')),
    );
    expect(removePrice).toBeEnabled();

    await user.type(screen.getByPlaceholderText('Price an item…'), 'notebook');
    const matches = screen.getAllByRole('button').filter((b) => b.className === ITEM_MATCH_ROW);
    await user.click(matches[0]!);
    await user.type(screen.getByLabelText(/^Price for /), '3.50');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), 'save the price')),
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});
