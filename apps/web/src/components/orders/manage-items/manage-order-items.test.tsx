import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ORDER_ITEMS_BUSY_COPY,
  ORDER_ITEMS_FORBIDDEN_COPY,
  ORDER_ITEMS_HIDE_CONFIRM_BODY_COPY,
  ORDER_ITEMS_ITEMS_UNAVAILABLE_COPY,
  ORDER_ITEMS_KITS_NOTE_COPY,
  ORDER_ITEMS_SHOW_CONFIRM_BODY_COPY,
  type OrderCatalogManageListAnswer,
  type OrderCatalogManageQuery,
  type OrderCatalogManageRow,
} from '@stockpilot/core';

// ═══ MANAGE ORDER ITEMS, the web page (ordering visibility, design 8.2, 3.7) ═══
//
// The interactive part over a server answer: shown and hidden records with
// their state, a confirmed Hide in the owner's words, Show and Hide selected
// over explicit ids kept across pages, the review of every selected record,
// the family disclosure, and every outcome decided by details.reason: saved
// (exactly what changed), unavailable (deselect), busy and step-up (resend the
// SAME operationId), forbidden (lock, no repeated failed clicks). The
// selection is cleared when the page's organization changes.

const h = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  action: vi.fn(),
  ensure: vi.fn(async () => true),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push, refresh: h.refresh }) }));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _p,
    scroll: _s,
    replace: _r,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    prefetch?: unknown;
    scroll?: unknown;
    replace?: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/actions/order-catalog-visibility', () => ({
  setOrderCatalogVisibilityAction: (...args: unknown[]) => h.action(...args),
}));
vi.mock('@/components/auth/step-up-modal', () => ({
  useStepUp: () => ({ ensure: h.ensure, modal: null }),
}));

import { ManageOrderItems } from './manage-order-items';

const ORG_A = '0a000000-0000-4000-8000-00000000000a';
const ORG_B = '0a000000-0000-4000-8000-00000000000b';
const USER = '6d80b722-1e44-4059-aa99-efd69718cb14';
const WH = '0a000000-0000-4000-8000-0000000000d1';
const FAMILY = '0a000000-0000-4000-8000-0000000000f0';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const id = (n: number) => `0a000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function row(n: number, over: Partial<OrderCatalogManageRow> = {}): OrderCatalogManageRow {
  return {
    id: id(n),
    name: `Record ${n}`,
    sku: `SKU-${n}`,
    identifier: null,
    itemType: 'item',
    sizeOrEdition: null,
    warehouseId: WH,
    warehouseName: 'North',
    categoryName: null,
    familyId: null,
    familyName: null,
    expected: false,
    visible: true,
    hiddenSince: null,
    thumbUrl: null,
    ...over,
  };
}

const SHIRT_XS = row(1, {
  name: 'New Hire Shirt',
  sizeOrEdition: 'XS',
  familyId: FAMILY,
  familyName: 'New Hire Shirt',
  visible: false,
  hiddenSince: '2026-10-25T18:00:00Z',
});
const SHIRT_S = row(2, {
  name: 'New Hire Shirt',
  sizeOrEdition: 'S',
  familyId: FAMILY,
  familyName: 'New Hire Shirt',
});
const BOOK = row(3, {
  name: 'Field Guide to Ponds',
  itemType: 'book',
  sizeOrEdition: 'A. Example',
  identifier: '9780000000002',
  expected: true,
});

function answerOf(
  rows: OrderCatalogManageRow[],
  page = 1,
  total = 60,
  org = ORG_A,
): OrderCatalogManageListAnswer {
  return { organizationId: org, viewer: { canManage: true }, page, pageSize: 25, total, rows };
}

const FILTERS: OrderCatalogManageQuery = {
  q: '',
  visibility: 'all',
  type: 'all',
  warehouseId: null,
  categoryId: null,
  page: 1,
};

function view(
  props: {
    answer?: OrderCatalogManageListAnswer;
    org?: string;
    filters?: OrderCatalogManageQuery;
  } = {},
) {
  return (
    <ManageOrderItems
      organizationId={props.org ?? ORG_A}
      userId={USER}
      answer={props.answer ?? answerOf([SHIRT_XS, SHIRT_S, BOOK])}
      filters={props.filters ?? FILTERS}
      warehouses={[{ id: WH, name: 'North' }]}
      categories={[]}
      orgTimezone="America/Los_Angeles"
    />
  );
}

const saved = (visible: boolean, changed: string[], unchanged: string[] = []) => ({
  ok: true,
  data: { organizationId: ORG_A, operationId: 'x', visible, changed, unchanged },
});
const refused = (code: string, details: Record<string, unknown>, message = 'server words') => ({
  ok: false,
  error: { code, message, details },
});

const confirmDialog = () => screen.getByRole('dialog');
const pressConfirm = async (label: RegExp) => {
  await act(async () => {
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: label }));
  });
};
const sentOperation = (call: number) =>
  (h.action.mock.calls[call]![0] as { operationId: string }).operationId;

beforeEach(() => {
  h.push.mockReset();
  h.refresh.mockReset();
  h.action.mockReset();
  h.ensure.mockReset();
  h.ensure.mockResolvedValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the list', () => {
  it('shows each record with its ordering visibility, Expected, hidden since, and a named per-row action', () => {
    render(view());
    const xs = screen.getByRole('button', { name: 'Show New Hire Shirt in Orders' });
    expect(xs).toHaveTextContent('Show in Orders');
    expect(
      screen.getByRole('button', { name: 'Hide Field Guide to Ponds from Orders' }),
    ).toHaveTextContent('Hide from Orders');
    const xsRow = xs.closest('tr')!;
    expect(within(xsRow).getByText('Hidden from Orders')).toBeInTheDocument();
    expect(within(xsRow).getByText('Hidden since Oct 25, 2026')).toBeInTheDocument();
    expect(within(xsRow).getByText('New Hire Shirt · XS')).toBeInTheDocument();
    const bookRow = screen.getByText('Field Guide to Ponds').closest('tr')!;
    expect(within(bookRow).getByText('Shown in Orders')).toBeInTheDocument();
    expect(within(bookRow).getByText('Expected')).toBeInTheDocument();
    expect(within(bookRow).getByText('SKU-3 · 9780000000002')).toBeInTheDocument();
    expect(screen.getByText(ORDER_ITEMS_KITS_NOTE_COPY)).toBeInTheDocument();
  });

  it('keeps the filters in the URL: the visibility tabs link to their views', () => {
    render(view({ filters: { ...FILTERS, q: 'shirt', page: 3 } }));
    const tabs = screen.getByRole('tablist', { name: 'Ordering visibility' });
    expect(within(tabs).getByRole('tab', { name: 'Hidden from Orders' }).getAttribute('href')).toBe(
      '/dashboard/orders/manage-items?q=shirt&visibility=hidden',
    );
    expect(within(tabs).getByRole('tab', { name: 'All' }).getAttribute('href')).toBe(
      '/dashboard/orders/manage-items?q=shirt',
    );
  });

  it('searches on the server after a pause, from page 1', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(view({ filters: { ...FILTERS, page: 2 } }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '9780000000002' } });
    expect(h.push).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(h.push).toHaveBeenCalledWith('/dashboard/orders/manage-items?q=9780000000002');
  });

  it('pages at 25 with the exact total', () => {
    render(view({ answer: answerOf([SHIRT_XS], 2, 1240) }));
    expect(screen.getByText(/Showing/).textContent).toBe('Showing 26–50 of 1,240');
  });

  it('an empty view says so for its filter, never as a failure', () => {
    render(view({ answer: answerOf([], 1, 0), filters: { ...FILTERS, visibility: 'hidden' } }));
    expect(screen.getByText('No items are hidden from Orders.')).toBeInTheDocument();
  });
});

describe('Hide and Show one record', () => {
  it('Hide asks first in the owner words, sends exactly that id with an operation id, and says what changed', async () => {
    h.action.mockResolvedValueOnce(saved(false, [BOOK.id]));
    render(view());
    fireEvent.click(screen.getByRole('button', { name: 'Hide Field Guide to Ponds from Orders' }));
    expect(within(confirmDialog()).getByText('Hide 1 item from Orders?')).toBeInTheDocument();
    expect(
      within(confirmDialog()).getByText(ORDER_ITEMS_HIDE_CONFIRM_BODY_COPY),
    ).toBeInTheDocument();
    expect(h.action).not.toHaveBeenCalled();

    await pressConfirm(/hide from orders/i);
    expect(h.action).toHaveBeenCalledTimes(1);
    const sent = h.action.mock.calls[0]![0] as {
      itemIds: string[];
      visible: boolean;
      operationId: string;
    };
    expect(sent.itemIds).toEqual([BOOK.id]);
    expect(sent.visible).toBe(false);
    expect(sent.operationId).toMatch(UUID);

    expect(screen.getByRole('status')).toHaveTextContent('Hidden 1 item.');
    const bookRow = screen.getByText('Field Guide to Ponds').closest('tr')!;
    expect(within(bookRow).getByText('Hidden from Orders')).toBeInTheDocument();
    expect(h.refresh).toHaveBeenCalled();
  });

  it('Show of one record needs no confirmation', async () => {
    h.action.mockResolvedValueOnce(saved(true, [SHIRT_XS.id]));
    render(view());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show New Hire Shirt in Orders' }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.action.mock.calls[0]![0]).toMatchObject({ itemIds: [SHIRT_XS.id], visible: true });
    expect(screen.getByRole('status')).toHaveTextContent('Shown 1 item.');
  });
});

describe('the selection', () => {
  it('keeps explicit ids across pages, the header box takes this page only, and the review lists off-page records', async () => {
    const { rerender } = render(view());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Field Guide to Ponds' }));
    expect(screen.getByRole('region', { name: 'Selection' })).toHaveTextContent('1 selected');

    // Page 2 of the same organization: the selection stays.
    rerender(view({ answer: answerOf([row(30), row(31)], 2) }));
    expect(screen.getByRole('region', { name: 'Selection' })).toHaveTextContent('1 selected');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select every item on this page' }));
    expect(screen.getByRole('region', { name: 'Selection' })).toHaveTextContent('3 selected');

    fireEvent.click(screen.getByRole('button', { name: 'Review selection' }));
    const list = await screen.findByRole('list', { name: 'Selected items' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining('Field Guide to Ponds'),
      expect.stringContaining('Record 30'),
      expect.stringContaining('Record 31'),
    ]);
  });

  it('Hide selected sends exactly the selected ids and says what changed; the selection is cleared', async () => {
    h.action.mockResolvedValueOnce(saved(false, [SHIRT_S.id, BOOK.id], [SHIRT_XS.id]));
    render(view());
    for (const name of ['Select New Hire Shirt', 'Select Field Guide to Ponds']) {
      for (const box of screen.getAllByRole('checkbox', { name })) fireEvent.click(box);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Hide selected' }));
    expect(within(confirmDialog()).getByText('Hide 3 items from Orders?')).toBeInTheDocument();
    await pressConfirm(/hide from orders/i);
    const sent = h.action.mock.calls[0]![0] as { itemIds: string[] };
    expect([...sent.itemIds].sort()).toEqual([SHIRT_XS.id, SHIRT_S.id, BOOK.id].sort());
    expect(screen.getByRole('status')).toHaveTextContent('Hidden 2 items. 1 was already hidden.');
    expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
  });

  it('Show selected confirms with its own sentence', () => {
    render(view());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Field Guide to Ponds' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show selected' }));
    expect(within(confirmDialog()).getByText('Show 1 item in Orders?')).toBeInTheDocument();
    expect(
      within(confirmDialog()).getByText(ORDER_ITEMS_SHOW_CONFIRM_BODY_COPY),
    ).toBeInTheDocument();
  });

  it('is cleared when the page moves to another organization (a workspace switch), review sheet included', async () => {
    const { rerender } = render(view());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Field Guide to Ponds' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review selection' }));
    expect(await screen.findByRole('list', { name: 'Selected items' })).toBeInTheDocument();

    rerender(view({ org: ORG_B, answer: answerOf([row(40)], 1, 1, ORG_B) }));
    expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Selected items' })).toBeNull();

    // Back to the first organization: nothing comes back.
    rerender(view());
    expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
  });
});

describe('outcomes', () => {
  it('items unavailable: nothing changed, the named ids are deselected, the list is re-read', async () => {
    h.action.mockResolvedValueOnce(
      refused('conflict', { reason: 'items_unavailable', itemIds: [BOOK.id] }),
    );
    render(view());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Field Guide to Ponds' }));
    for (const box of screen.getAllByRole('checkbox', { name: 'Select New Hire Shirt' }))
      fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Hide selected' }));
    await pressConfirm(/hide from orders/i);
    expect(screen.getByRole('alert')).toHaveTextContent(ORDER_ITEMS_ITEMS_UNAVAILABLE_COPY);
    expect(screen.getByRole('region', { name: 'Selection' })).toHaveTextContent('2 selected');
    expect(screen.getByRole('checkbox', { name: 'Select Field Guide to Ponds' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(h.refresh).toHaveBeenCalled();
  });

  it('busy: the sentence in the dialog, and Try again resends the SAME operation id', async () => {
    h.action
      .mockResolvedValueOnce(refused('conflict', { reason: 'busy', retryable: true }))
      .mockResolvedValueOnce(saved(false, [BOOK.id]));
    render(view());
    fireEvent.click(screen.getByRole('button', { name: 'Hide Field Guide to Ponds from Orders' }));
    await pressConfirm(/hide from orders/i);
    expect(within(confirmDialog()).getByRole('alert')).toHaveTextContent(ORDER_ITEMS_BUSY_COPY);
    await pressConfirm(/hide from orders/i);
    expect(h.action).toHaveBeenCalledTimes(2);
    expect(sentOperation(1)).toBe(sentOperation(0));
    expect(screen.getByRole('status')).toHaveTextContent('Hidden 1 item.');
  });

  it('a stale step-up prompts, then the same operation is sent again', async () => {
    h.action
      .mockResolvedValueOnce(refused('forbidden', { reason: 'aal2_required' }))
      .mockResolvedValueOnce(saved(true, [SHIRT_XS.id]));
    render(view());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show New Hire Shirt in Orders' }));
    });
    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(h.action).toHaveBeenCalledTimes(2);
    expect(sentOperation(1)).toBe(sentOperation(0));
    expect(screen.getByRole('status')).toHaveTextContent('Shown 1 item.');
  });

  it('an answer that never came keeps the operation: Try again on the page resends it', async () => {
    h.action
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(saved(true, [SHIRT_XS.id]));
    render(view());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show New Hire Shirt in Orders' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent("That change couldn't be confirmed.");
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(sentOperation(1)).toBe(sentOperation(0));
  });

  it('forbidden is final: the page locks, the list stays readable, and nothing else can be sent', async () => {
    h.action.mockResolvedValueOnce(refused('forbidden', { reason: 'forbidden' }));
    render(view());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show New Hire Shirt in Orders' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(ORDER_ITEMS_FORBIDDEN_COPY);
    expect(screen.getByText('Field Guide to Ponds')).toBeInTheDocument();
    for (const b of screen.getAllByRole('button', { name: /in Orders|from Orders/ }))
      expect(b).toBeDisabled();
    for (const c of screen.getAllByRole('checkbox')) expect(c).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Hide Field Guide to Ponds from Orders' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.action).toHaveBeenCalledTimes(1);
  });
});

describe('Select family', () => {
  it('lists the family records the caller can read, pre-checked, and adds exactly the checked ones', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        organizationId: ORG_A,
        familyId: FAMILY,
        familyName: 'New Hire Shirt',
        rows: [
          SHIRT_XS,
          SHIRT_S,
          row(4, { name: 'New Hire Shirt', sizeOrEdition: 'M', familyId: FAMILY }),
        ],
        truncated: false,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(view());
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Select family: New Hire Shirt' })[0]!);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/orders/catalog-visibility/family/${FAMILY}`,
      expect.objectContaining({ cache: 'no-store' }),
    );
    const list = await screen.findByRole('list', { name: 'Family records' });
    const boxes = within(list).getAllByRole('checkbox');
    expect(boxes.map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'true', 'true']);
    fireEvent.click(boxes[0]!); // leave XS out
    fireEvent.click(screen.getByRole('button', { name: 'Add to selection' }));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Family records' })).toBeNull());
    expect(screen.getByRole('region', { name: 'Selection' })).toHaveTextContent('2 selected');
  });

  it('drops an answer for another organization', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          organizationId: ORG_B,
          familyId: FAMILY,
          familyName: 'x',
          rows: [row(9)],
          truncated: false,
        }),
      })),
    );
    render(view());
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Select family: New Hire Shirt' })[0]!);
    });
    expect(await screen.findByText("Couldn't load items. Try again.")).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Family records' })).toBeNull();
  });
});
