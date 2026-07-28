// @vitest-environment happy-dom
/**
 * The Task 16 review-fix regression guard: the "Add size run" picker must
 * source its variants from the UNCAPPED, group-scoped read (`groupItems`),
 * not from `items` — the page-level `list({ limit: 1000 })` result. Before
 * this fix, an org with more than 1000 items could have a group whose
 * 1001st+ variant simply never appeared here, silently under-counting a
 * size run and letting the buyer order an incomplete one.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/server/actions/purchase-orders', () => ({
  createPoAction: vi.fn(),
  updatePoAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { PoForm } from './po-form';
import type { SizeRunGroup } from './size-run-receive-grid';

const shoeGroup: SizeRunGroup = {
  name: 'Nike Mercurial · Black',
  countingUnit: 'pair',
  sizeOrder: new Map([
    ['9', 0],
    ['10', 1],
    ['11', 2],
  ]),
};

// Simulates a >1000-item org: `items` (the page's capped list() result) only
// carries two of this group's three variants. The third — size 11 — is "the
// 1001st item", past PostgREST's max_rows cap.
const cappedItems = [
  { id: 'v9', name: 'Mercurial 9', sku: 'SKU-9', unit_cost: 100, groupId: 'g1', variantSize: '9' },
  { id: 'v10', name: 'Mercurial 10', sku: 'SKU-10', unit_cost: 100, groupId: 'g1', variantSize: '10' },
];
// `groupItems` is the UNCAPPED, group-scoped read the fix adds; it carries
// every variant under the group regardless of catalog size.
const uncappedGroupItems = [
  ...cappedItems,
  { id: 'v11', name: 'Mercurial 11', sku: 'SKU-11', unit_cost: 100, groupId: 'g1', variantSize: '11' },
];

async function openSizeRunDialog(props: Parameters<typeof PoForm>[0]) {
  const user = userEvent.setup();
  render(<PoForm {...props} />);
  await user.click(screen.getByRole('button', { name: /add size run/i }));
  return user;
}

describe('PoForm — "Add size run" picker sourcing (Task 16 review fix)', () => {
  it('shows the 1001st item — a variant present only in `groupItems`, not in the capped `items`', async () => {
    await openSizeRunDialog({
      items: cappedItems,
      groupItems: uncappedGroupItems,
      productGroups: { g1: shoeGroup },
      suppliers: [],
      locations: [],
      charters: [],
    });

    // All three sizes render, including the one absent from `items`.
    expect(screen.getByLabelText('Quantity for size 9')).toBeInTheDocument();
    expect(screen.getByLabelText('Quantity for size 10')).toBeInTheDocument();
    expect(screen.getByLabelText('Quantity for size 11')).toBeInTheDocument();
    expect(screen.getByText('SKU-11')).toBeInTheDocument();
  });

  it('without `groupItems`, falls back to the (possibly capped) `items` prop', async () => {
    await openSizeRunDialog({
      items: cappedItems,
      productGroups: { g1: shoeGroup },
      suppliers: [],
      locations: [],
      charters: [],
    });

    expect(screen.getByLabelText('Quantity for size 9')).toBeInTheDocument();
    expect(screen.getByLabelText('Quantity for size 10')).toBeInTheDocument();
    expect(screen.queryByLabelText('Quantity for size 11')).not.toBeInTheDocument();
    expect(screen.queryByText('SKU-11')).not.toBeInTheDocument();
  });
});

describe('PoForm — "Add size run" toast (review fix: pure setLines updater)', () => {
  it('fires the success toast exactly once even under StrictMode double-invoke', async () => {
    // The old code called toast.success() INSIDE the setLines updater
    // function, which StrictMode intentionally invokes twice to surface
    // impure updaters — doubling the toast. Rendering inside StrictMode here
    // reproduces that check; the fix moved the toast out to a plain side
    // effect so it fires once regardless.
    const { toast } = await import('sonner');
    const user = userEvent.setup();
    render(
      <React.StrictMode>
        <PoForm
          items={cappedItems}
          groupItems={uncappedGroupItems}
          productGroups={{ g1: shoeGroup }}
          suppliers={[]}
          locations={[]}
          charters={[]}
        />
      </React.StrictMode>,
    );
    await user.click(screen.getByRole('button', { name: /add size run/i }));
    await user.type(screen.getByLabelText('Quantity for size 9'), '3');
    await user.click(screen.getByRole('button', { name: /^add \d+ lines?$/i }));

    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});
