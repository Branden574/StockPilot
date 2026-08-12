// @vitest-environment happy-dom
/**
 * The PO line-item picker's server-backed search.
 *
 * Before this, the picker filtered a page-level `list({ limit: 1000 })` array
 * in the browser and compared the typed query against it by NAME only. Two
 * consequences, both reproduced here:
 *   - a whole item TYPE (books) never reached the array, so no book was
 *     findable and the picker offered to "Create" a duplicate of one;
 *   - anything past the page cap was equally invisible, including the item a
 *     selected line already pointed at — which then rendered blank.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createPoAction = vi.fn(async (_payload: unknown) => ({
  ok: true,
  data: { id: 'po-new' },
}));
const updatePoAction = vi.fn(async (_id: string, _payload: unknown) => ({
  ok: true,
  data: { id: 'po-1' },
}));

vi.mock('@/server/actions/purchase-orders', () => ({
  createPoAction: (payload: unknown) => createPoAction(payload),
  updatePoAction: (id: string, payload: unknown) => updatePoAction(id, payload),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { PoForm } from './po-form';

// ── Fixtures ───────────────────────────────────────────────────────────────
// The org from the bug report: one product, one book. Both are SERVER rows
// (the `?slim=1` shape) — the picker's whole point is that it no longer needs
// them in the page-level array to find them.
const PRODUCT_A_ROW = {
  id: 'p-a',
  sku: 'SKU-A',
  name: 'Product A',
  barcode: '0123456789012',
  item_type: 'product',
  unit_cost: 4,
  group_id: null,
  variant_size: null,
};
const BOOK_B_ROW = {
  id: 'b-b',
  sku: 'BK-B',
  name: "Charlotte's Web",
  // For a book, barcode IS the ISBN. This one is stocked as the ISBN-13.
  barcode: '9780142407332',
  item_type: 'book',
  unit_cost: 6.5,
  group_id: null,
  variant_size: null,
};
/** A book stocked under its ISBN-10 instead — the equivalence case. */
const BOOK_TEN_ROW = {
  ...BOOK_B_ROW,
  id: 'b-ten',
  sku: 'BK-TEN',
  barcode: '014240733X',
};

const BASE_PROPS = {
  items: [],
  suppliers: [],
  locations: [],
  charters: [],
};

/** Requests the picker made, in order. */
let requests: string[];
/** q (or 'ids:<csv>') → rows the fake endpoint answers with. */
let responses: Map<string, Array<Record<string, unknown>>>;
/** Set to defer a response so out-of-order delivery can be forced. */
let deferred: Map<string, { resolve: () => void; promise: Promise<void> }>;

function keyFor(url: string): string {
  const p = new URL(url, 'https://example.test').searchParams;
  const ids = p.getAll('ids');
  if (ids.length > 0) return `ids:${ids.join(',')}`;
  return p.get('q') ?? '';
}

function installFetch() {
  requests = [];
  responses = new Map();
  deferred = new Map();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      requests.push(input);
      const key = keyFor(input);
      const gate = deferred.get(key);
      if (gate) await gate.promise;
      return {
        ok: true,
        json: async () => ({ items: responses.get(key) ?? [], total: (responses.get(key) ?? []).length }),
      } as unknown as Response;
    }),
  );
}

function defer(key: string) {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  deferred.set(key, { resolve, promise });
  return () => resolve();
}

/** Opens the picker on a freshly-added line and returns the popover input. */
async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /add line/i }));
  await user.click(screen.getByRole('button', { name: /pick or create an item/i }));
  return screen.getByPlaceholderText(/search by name, sku, barcode or isbn/i);
}

beforeEach(() => {
  vi.clearAllMocks();
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PO item picker — server-backed search', () => {
  it('THE REGRESSION: an org with Product A and Book B can find BOTH from the New PO picker', async () => {
    responses.set('prod', [PRODUCT_A_ROW]);
    responses.set('charlotte', [BOOK_B_ROW]);
    const user = userEvent.setup();
    render(<PoForm {...BASE_PROPS} />);
    const input = await openPicker(user);

    await user.type(input, 'prod');
    await waitFor(() => expect(screen.getByText('SKU-A')).toBeInTheDocument());

    await user.clear(input);
    await user.type(input, 'charlotte');
    await waitFor(() => expect(screen.getByText('BK-B')).toBeInTheDocument());
    expect(screen.getByText("Charlotte's Web")).toBeInTheDocument();
  });

  it('sends the PO item-type set, expected=any, isbn=1 and a small slim limit', async () => {
    responses.set('web', [BOOK_B_ROW]);
    const user = userEvent.setup();
    render(<PoForm {...BASE_PROPS} />);
    const input = await openPicker(user);
    await user.type(input, 'web');
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));

    const p = new URL(requests[requests.length - 1]!, 'https://example.test').searchParams;
    expect(p.getAll('type')).toEqual(['product', 'book']);
    expect(p.get('expected')).toBe('any');
    expect(p.get('isbn')).toBe('1');
    expect(p.get('slim')).toBe('1');
    expect(p.get('limit')).toBe('25');
    expect(p.get('q')).toBe('web');
  });

  it.each([
    ['title', 'charlotte'],
    ['SKU', 'BK-B'],
    ['barcode/ISBN-13', '9780142407332'],
  ])('finds the book by %s', async (_label, needle) => {
    responses.set(needle, [BOOK_B_ROW]);
    const user = userEvent.setup();
    render(<PoForm {...BASE_PROPS} />);
    const input = await openPicker(user);
    await user.type(input, needle);
    await waitFor(() => expect(screen.getByText("Charlotte's Web")).toBeInTheDocument());
  });

  it('a book row is marked Book and shows its ISBN; a product row is not', async () => {
    responses.set('web', [BOOK_B_ROW, PRODUCT_A_ROW]);
    const user = userEvent.setup();
    render(<PoForm {...BASE_PROPS} />);
    const input = await openPicker(user);
    await user.type(input, 'web');
    await waitFor(() => expect(screen.getByText('BK-B')).toBeInTheDocument());

    const bookRow = screen.getByText('BK-B').closest('[data-value]') as HTMLElement;
    expect(within(bookRow).getByText('Book')).toBeInTheDocument();
    expect(within(bookRow).getByText('9780142407332')).toBeInTheDocument();

    const productRow = screen.getByText('SKU-A').closest('[data-value]') as HTMLElement;
    expect(within(productRow).queryByText('Book')).not.toBeInTheDocument();
    expect(within(productRow).queryByText('0123456789012')).not.toBeInTheDocument();
  });

  it('ignores an out-of-order response — a slow earlier request never overwrites a newer one', async () => {
    responses.set('char', [PRODUCT_A_ROW]);
    responses.set('charlotte', [BOOK_B_ROW]);
    const releaseSlow = defer('char');

    const user = userEvent.setup();
    render(<PoForm {...BASE_PROPS} />);
    const input = await openPicker(user);

    await user.type(input, 'char');
    await user.type(input, 'lotte');
    await waitFor(() => expect(screen.getByText('BK-B')).toBeInTheDocument());

    // The stalled 'char' response lands LAST. Its rows must be dropped.
    releaseSlow();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('BK-B')).toBeInTheDocument();
    expect(screen.queryByText('SKU-A')).not.toBeInTheDocument();
  });
});

describe('PO item picker — "Create … as a new item" suppression', () => {
  it('does NOT offer to create a book that already exists under the typed ISBN', async () => {
    // The exact spec case: the buyer types the ISBN, the book comes back, and
    // minting a second book row for it must not be on offer.
    responses.set('9780142407332', [BOOK_B_ROW]);
    const user = userEvent.setup();
    render(<PoForm {...BASE_PROPS} />);
    const input = await openPicker(user);
    await user.type(input, '9780142407332');

    await waitFor(() => expect(screen.getByText("Charlotte's Web")).toBeInTheDocument());
    expect(screen.queryByText(/as a new item/i)).not.toBeInTheDocument();
  });

  it('suppresses create when the typed ISBN-13 matches a book stocked as its ISBN-10', async () => {
    // /api/items/search?isbn=1 returns the ISBN-10-stocked row for an
    // ISBN-13 query; the client-side suppression has to recognise the same
    // equivalence or it would still offer to create a duplicate.
    responses.set('9780142407332', [BOOK_TEN_ROW]);
    const user = userEvent.setup();
    render(<PoForm {...BASE_PROPS} />);
    const input = await openPicker(user);
    await user.type(input, '9780142407332');

    await waitFor(() => expect(screen.getByText('BK-TEN')).toBeInTheDocument());
    expect(screen.queryByText(/as a new item/i)).not.toBeInTheDocument();
  });

  it('suppresses create on an exact SKU match', async () => {
    responses.set('BK-B', [BOOK_B_ROW]);
    const user = userEvent.setup();
    render(<PoForm {...BASE_PROPS} />);
    const input = await openPicker(user);
    await user.type(input, 'BK-B');

    await waitFor(() => expect(screen.getByText("Charlotte's Web")).toBeInTheDocument());
    expect(screen.queryByText(/as a new item/i)).not.toBeInTheDocument();
  });

  it('still offers create for a genuinely new name', async () => {
    responses.set('Brand new title', []);
    const user = userEvent.setup();
    render(<PoForm {...BASE_PROPS} />);
    const input = await openPicker(user);
    await user.type(input, 'Brand new title');

    await waitFor(() =>
      expect(screen.getByText('"Brand new title"')).toBeInTheDocument(),
    );
    expect(screen.getByText(/as a new item/i)).toBeInTheDocument();
  });
});

describe('PO item picker — picking a book onto a line', () => {
  it('sets the real book item id and populates unit cost, through the ordinary line payload', async () => {
    responses.set('charlotte', [BOOK_B_ROW]);
    const user = userEvent.setup();
    render(<PoForm {...BASE_PROPS} />);
    const input = await openPicker(user);
    await user.type(input, 'charlotte');
    await waitFor(() => expect(screen.getByText("Charlotte's Web")).toBeInTheDocument());
    await user.click(screen.getByText("Charlotte's Web"));

    // The trigger now carries the book's label…
    expect(screen.getByRole('button', { name: /BK-B · Charlotte's Web/ })).toBeInTheDocument();
    // …and its unit cost landed on the line.
    expect(screen.getByPlaceholderText('0.00')).toHaveValue(6.5);

    await user.click(screen.getByRole('button', { name: /create po/i }));
    await waitFor(() => expect(createPoAction).toHaveBeenCalledTimes(1));
    const payload = createPoAction.mock.calls[0]?.[0] as {
      lines: Array<Record<string, unknown>>;
    };
    // No second "book PO" model: an ordinary itemId line, same as a product.
    expect(payload.lines).toEqual([
      { itemId: 'b-b', quantityOrdered: 1, unitCost: 6.5 },
    ]);
  });
});

describe('PO item picker — selected-line labels survive an absent result', () => {
  const EDIT_INITIAL = {
    supplierId: '',
    locationId: '',
    charterId: '',
    expectedAt: '',
    notes: '',
    poNumber: 'PO-1',
    lines: [{ itemId: 'b-b', quantityOrdered: 4, unitCost: 6.5 }],
  };

  it('resolves an edit-mode line by ID when its item is in neither `items` nor any search result', async () => {
    // `items` is deliberately EMPTY — the book is off-page, exactly the case
    // that used to render the line blank.
    responses.set('ids:b-b', [BOOK_B_ROW]);
    render(<PoForm {...BASE_PROPS} poId="po-1" initial={EDIT_INITIAL} />);

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /BK-B · Charlotte's Web/ }),
      ).toBeInTheDocument(),
    );
    expect(requests.some((u) => u.includes('ids=b-b'))).toBe(true);
  });

  it('keeps that label while the user searches for something else entirely', async () => {
    responses.set('ids:b-b', [BOOK_B_ROW]);
    responses.set('product', [PRODUCT_A_ROW]);
    const user = userEvent.setup();
    render(<PoForm {...BASE_PROPS} poId="po-1" initial={EDIT_INITIAL} />);
    const trigger = await screen.findByRole('button', { name: /BK-B · Charlotte's Web/ });

    await user.click(trigger);
    const input = screen.getByPlaceholderText(/search by name, sku, barcode or isbn/i);
    await user.type(input, 'product');
    await waitFor(() => expect(screen.getByText('SKU-A')).toBeInTheDocument());
    // The book is nowhere in the current result set; the label still holds.
    expect(screen.getByRole('button', { name: /BK-B · Charlotte's Web/ })).toBeInTheDocument();
  });

  it('does not re-fetch an id already covered by the `items` prop', async () => {
    render(
      <PoForm
        {...BASE_PROPS}
        items={[
          {
            id: 'b-b',
            name: "Charlotte's Web",
            sku: 'BK-B',
            unit_cost: 6.5,
            itemType: 'book',
            barcode: '9780142407332',
          },
        ]}
        poId="po-1"
        initial={EDIT_INITIAL}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /BK-B · Charlotte's Web/ })).toBeInTheDocument(),
    );
    expect(requests).toEqual([]);
  });
});
