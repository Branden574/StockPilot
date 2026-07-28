// @vitest-environment happy-dom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCountSelection } from '@/lib/cycle-counts/use-count-selection';

import { CountItemPicker } from './count-item-picker';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

type Row = {
  id: string;
  sku: string;
  name: string;
  quantity_on_hand: number;
  item_type: string;
  custom_fields: Record<string, unknown> | null;
};

function row(over: Partial<Row> & { id: string }): Row {
  return {
    sku: `SKU-${over.id}`,
    name: `Item ${over.id}`,
    quantity_on_hand: 3,
    item_type: 'product',
    custom_fields: null,
    ...over,
  };
}

function jsonResponse(items: Row[], total = items.length) {
  return {
    ok: true,
    json: async () => ({ items, total }),
  } as Response;
}

const WAREHOUSES = [{ id: 'w1', name: 'Main DC' }];

describe('CountItemPicker', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useCountSelection.getState().clear();
    vi.stubGlobal('fetch', fetchSpy);
    fetchSpy.mockResolvedValue(jsonResponse([]));
  });

  function lastUrl(): URL {
    const call = fetchSpy.mock.calls.at(-1)!;
    return new URL(String(call[0]), 'https://example.com');
  }

  it('browse-fetches products on open (browse=1 + type=product, org scope enforced server-side by the API)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse([row({ id: 'a', name: 'Alpha Charger' })]));
    render(<CountItemPicker warehouses={WAREHOUSES} />);

    expect(await screen.findByText('Alpha Charger')).toBeInTheDocument();
    const url = lastUrl();
    expect(url.pathname).toBe('/api/items/search');
    expect(url.searchParams.get('browse')).toBe('1');
    expect(url.searchParams.get('type')).toBe('product');
    expect(url.searchParams.get('limit')).toBe('50');
    // No q param before the user types (browse mode, not a search).
    expect(url.searchParams.get('q')).toBeNull();
  });

  it('Books tab refetches with type=book', async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValue(jsonResponse([row({ id: 'b1', name: 'Algebra I', item_type: 'book' })]));
    render(<CountItemPicker warehouses={WAREHOUSES} />);
    await screen.findByText('Algebra I');

    await user.click(screen.getByRole('button', { name: 'Books' }));
    await vi.waitFor(() => {
      expect(lastUrl().searchParams.get('type')).toBe('book');
    });
  });

  it('typing debounces into ONE server search carrying q', async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValue(jsonResponse([row({ id: 'a', name: 'Alpha Charger' })]));
    render(<CountItemPicker warehouses={WAREHOUSES} />);
    await screen.findByText('Alpha Charger');
    const callsBefore = fetchSpy.mock.calls.length;

    await user.type(screen.getByRole('textbox', { name: /search items to count/i }), 'charg');
    await vi.waitFor(() => {
      expect(lastUrl().searchParams.get('q')).toBe('charg');
    });
    // 5 keystrokes inside the 250ms window collapse into a single fetch.
    expect(fetchSpy.mock.calls.length).toBe(callsBefore + 1);
  });

  it('checking a row writes the SHARED count-selection store; unchecking removes it', async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValue(
      jsonResponse([row({ id: 'a', name: 'Alpha Charger', sku: 'SP-A' })]),
    );
    render(<CountItemPicker warehouses={WAREHOUSES} />);

    const box = await screen.findByRole('checkbox', { name: 'Select Alpha Charger' });
    await user.click(box);
    expect(useCountSelection.getState().picks['a']).toEqual({
      id: 'a',
      sku: 'SP-A',
      name: 'Alpha Charger',
      itemType: 'product',
    });
    expect(screen.getByTestId('picker-selected-bar')).toHaveTextContent('1 item selected');

    await user.click(box);
    expect(useCountSelection.getState().picks['a']).toBeUndefined();
    expect(screen.getByTestId('picker-selected-bar')).toHaveTextContent('0 items selected');
  });

  it('rows already in the store (legacy Items-page select-mode path) render pre-checked', async () => {
    useCountSelection
      .getState()
      .add([{ id: 'a', sku: 'SP-A', name: 'Alpha Charger', itemType: 'product' }]);
    fetchSpy.mockResolvedValue(jsonResponse([row({ id: 'a', name: 'Alpha Charger' })]));
    render(<CountItemPicker warehouses={WAREHOUSES} />);

    const box = await screen.findByRole('checkbox', { name: 'Select Alpha Charger' });
    expect(box).toBeChecked();
  });

  it('a checked Books-tab row is stored with itemType book (grouping downstream)', async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValue(
      jsonResponse([row({ id: 'b1', name: 'Algebra I', sku: 'BK-1', item_type: 'book' })]),
    );
    render(<CountItemPicker warehouses={WAREHOUSES} />);
    await user.click(screen.getByRole('button', { name: 'Books' }));

    await user.click(await screen.findByRole('checkbox', { name: 'Select Algebra I' }));
    expect(useCountSelection.getState().picks['b1']?.itemType).toBe('book');
  });

  it('Clear in the selected bar empties the store', async () => {
    useCountSelection
      .getState()
      .add([{ id: 'a', sku: 'SP-A', name: 'Alpha', itemType: 'product' }]);
    const user = userEvent.setup();
    render(<CountItemPicker warehouses={WAREHOUSES} />);

    await user.click(await screen.findByRole('button', { name: 'Clear' }));
    expect(useCountSelection.getState().picks).toEqual({});
  });

  it('Load more appends the next offset page', async () => {
    const user = userEvent.setup();
    const first = Array.from({ length: 50 }, (_, i) => row({ id: `p${i}`, name: `Part ${i}` }));
    fetchSpy.mockResolvedValue(jsonResponse(first, 60));
    render(<CountItemPicker warehouses={WAREHOUSES} />);
    await screen.findByText('Part 0');

    fetchSpy.mockResolvedValueOnce(
      jsonResponse([row({ id: 'p50', name: 'Part 50' })], 60),
    );
    await user.click(screen.getByRole('button', { name: /load more/i }));

    expect(await screen.findByText('Part 50')).toBeInTheDocument();
    expect(screen.getByText('Part 0')).toBeInTheDocument();
    expect(lastUrl().searchParams.get('offset')).toBe('50');
  });

  it('a stale load-more response from a previous tab is dropped, not appended', async () => {
    const user = userEvent.setup();
    const first = Array.from({ length: 50 }, (_, i) => row({ id: `p${i}`, name: `Part ${i}` }));
    fetchSpy.mockResolvedValue(jsonResponse(first, 60));
    render(<CountItemPicker warehouses={WAREHOUSES} />);
    await screen.findByText('Part 0');

    // Hold the product page-2 response open while the user switches tabs.
    let releaseStale!: (r: Response) => void;
    fetchSpy.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (releaseStale = resolve)),
    );
    await user.click(screen.getByRole('button', { name: /load more/i }));

    fetchSpy.mockResolvedValue(
      jsonResponse([row({ id: 'b1', name: 'Algebra I', item_type: 'book' })]),
    );
    await user.click(screen.getByRole('button', { name: 'Books' }));
    await screen.findByText('Algebra I');

    // The orphaned PRODUCT page 2 finally lands — it must NOT append onto
    // the Books list (the tab switch aborted it).
    await act(async () => {
      releaseStale(jsonResponse([row({ id: 'p50', name: 'Part 50' })], 60));
      await Promise.resolve();
    });
    expect(screen.queryByText('Part 50')).not.toBeInTheDocument();
    expect(screen.getByText('Algebra I')).toBeInTheDocument();
  });

  it('a failed load-more keeps the loaded rows and shows an inline retryable error', async () => {
    const user = userEvent.setup();
    const first = Array.from({ length: 50 }, (_, i) => row({ id: `p${i}`, name: `Part ${i}` }));
    fetchSpy.mockResolvedValue(jsonResponse(first, 60));
    render(<CountItemPicker warehouses={WAREHOUSES} />);
    await screen.findByText('Part 0');

    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    await user.click(screen.getByRole('button', { name: /load more/i }));

    // Page 1 stays rendered; the error is a small inline notice, NOT the
    // destructive whole-list failed state.
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t load more/i);
    expect(screen.getByText('Part 0')).toBeInTheDocument();
    expect(screen.queryByText(/check your connection/i)).not.toBeInTheDocument();

    // The Load more button doubles as the retry and clears the notice.
    fetchSpy.mockResolvedValueOnce(jsonResponse([row({ id: 'p50', name: 'Part 50' })], 60));
    await user.click(screen.getByRole('button', { name: /load more/i }));
    expect(await screen.findByText('Part 50')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps an unobtrusive escape hatch to the full Inventory page', async () => {
    render(<CountItemPicker warehouses={WAREHOUSES} />);
    const link = screen.getByRole('link', { name: /full inventory page/i });
    expect(link).toHaveAttribute('href', '/dashboard/inventory');
  });
});

/**
 * The Product groups tab: counting BY VARIANT with per-variant expansion.
 *
 * Ticking a group never creates a group-shaped selection entry — a group owns
 * no quantity, so there is nothing at group level to count. It expands into
 * the group's variant ITEMS, which is what a cycle_count_lines row FKs.
 */
describe('CountItemPicker — product groups', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useCountSelection.getState().clear();
    vi.stubGlobal('fetch', fetchSpy);
  });

  function groupsResponse(groups: unknown[]) {
    return { ok: true, json: async () => ({ groups }) } as Response;
  }
  function variantsResponse(variants: unknown[]) {
    return { ok: true, json: async () => ({ variants }) } as Response;
  }

  const PEGASUS = {
    id: 'g1',
    name: 'Nike Pegasus 41',
    brand: 'Nike',
    model: 'Pegasus 41',
    styleNumber: 'FD2722',
    team: null,
    countingUnit: 'pair',
    variantCount: 3,
    totalQuantity: 12,
  };

  it('is HIDDEN for an org without the sports module', () => {
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ items: [], total: 0 }) } as Response);
    render(<CountItemPicker warehouses={WAREHOUSES} />);
    expect(screen.queryByRole('button', { name: 'Product groups' })).toBeNull();
  });

  it('lists groups with their DERIVED roll-up', async () => {
    const user = userEvent.setup();
    fetchSpy.mockImplementation(async (url: string) =>
      String(url).includes('/api/v1/product-groups')
        ? groupsResponse([PEGASUS])
        : ({ ok: true, json: async () => ({ items: [], total: 0 }) } as Response),
    );
    render(<CountItemPicker warehouses={WAREHOUSES} sportsEnabled />);

    await user.click(screen.getByRole('button', { name: 'Product groups' }));
    expect(await screen.findByText('Nike Pegasus 41')).toBeInTheDocument();
    expect(screen.getByText('3 variants · 12 pair')).toBeInTheDocument();
  });

  it('ticking a group adds EVERY variant as its own pick, named by variant', async () => {
    const user = userEvent.setup();
    fetchSpy.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/variants')) {
        return variantsResponse([
          { id: 'v9', sku: 'PEG-9', name: 'Nike Pegasus 41', label: 'Size 9' },
          { id: 'v10', sku: 'PEG-10', name: 'Nike Pegasus 41', label: 'Size 10' },
        ]);
      }
      if (u.includes('/api/v1/product-groups')) return groupsResponse([PEGASUS]);
      return { ok: true, json: async () => ({ items: [], total: 0 }) } as Response;
    });
    render(<CountItemPicker warehouses={WAREHOUSES} sportsEnabled />);
    await user.click(screen.getByRole('button', { name: 'Product groups' }));
    await screen.findByText('Nike Pegasus 41');

    await user.click(
      screen.getByRole('checkbox', { name: /count every variant of nike pegasus 41/i }),
    );

    await vi.waitFor(() => {
      const picks = useCountSelection.getState().picks;
      expect(Object.keys(picks).sort()).toEqual(['v10', 'v9']);
      // The group id is NEVER a pick — it has no quantity to count.
      expect(picks['g1']).toBeUndefined();
      expect(picks['v9']!.name).toBe('Nike Pegasus 41 · Size 9');
      expect(picks['v10']!.name).toBe('Nike Pegasus 41 · Size 10');
    });
  });

  it('un-ticking a group takes its variants back out', async () => {
    const user = userEvent.setup();
    fetchSpy.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/variants')) {
        return variantsResponse([
          { id: 'v9', sku: 'PEG-9', name: 'Nike Pegasus 41', label: 'Size 9' },
        ]);
      }
      if (u.includes('/api/v1/product-groups')) return groupsResponse([PEGASUS]);
      return { ok: true, json: async () => ({ items: [], total: 0 }) } as Response;
    });
    render(<CountItemPicker warehouses={WAREHOUSES} sportsEnabled />);
    await user.click(screen.getByRole('button', { name: 'Product groups' }));
    await screen.findByText('Nike Pegasus 41');
    const box = screen.getByRole('checkbox', { name: /count every variant of nike pegasus 41/i });

    await user.click(box);
    await vi.waitFor(() => {
      expect(Object.keys(useCountSelection.getState().picks)).toEqual(['v9']);
    });
    await user.click(box);
    await vi.waitFor(() => {
      expect(Object.keys(useCountSelection.getState().picks)).toEqual([]);
    });
  });

  it('says so rather than silently ticking a group with no active variants', async () => {
    const user = userEvent.setup();
    fetchSpy.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/variants')) return variantsResponse([]);
      if (u.includes('/api/v1/product-groups')) return groupsResponse([PEGASUS]);
      return { ok: true, json: async () => ({ items: [], total: 0 }) } as Response;
    });
    render(<CountItemPicker warehouses={WAREHOUSES} sportsEnabled />);
    await user.click(screen.getByRole('button', { name: 'Product groups' }));
    await screen.findByText('Nike Pegasus 41');

    await user.click(
      screen.getByRole('checkbox', { name: /count every variant of nike pegasus 41/i }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Nike Pegasus 41 has no active variants to count.',
    );
    expect(Object.keys(useCountSelection.getState().picks)).toEqual([]);
  });
});
