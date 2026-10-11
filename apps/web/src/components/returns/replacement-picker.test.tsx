// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ReplacementPicker } from './replacement-picker';

/**
 * RX-2 review fix P3: the picker never cuts an item's name (the size was lost
 * in the approval review's half-width card), and below the `sm` breakpoint the
 * availability goes under the name instead of squeezing it.
 */

const LONG = 'Walk Exchange Tee With A Very Long Product Name - 2XL';

function load() {
  return vi.fn(async () => ({
    ok: true as const,
    data: {
      orderId: 'o',
      orderRequestLineId: 'l',
      returnedItemId: 'm',
      groupId: 'g',
      siblings: [
        { itemId: 'xxl', name: LONG, sku: 'WET-2XL', variantSize: '2XL', variantKey: null, groupId: 'g', sibling: true, isReturnedItem: false, onHand: 0, held: 0, free: 0 },
      ],
      matches: [],
    },
  }));
}

describe('ReplacementPicker rows', () => {
  it('show the whole name (wrapped, never truncated) with the availability under it below sm', async () => {
    render(<ReplacementPicker load={load()} needed={1} selectedItemId={null} onSelect={() => {}} label="Walk Exchange Tee - M" />);
    const name = await screen.findByText(LONG);
    expect(name.className).not.toMatch(/\btruncate\b/);
    expect(name.className).toMatch(/\bbreak-words\b/);
    const availability = screen.getByText('Short: 0 available, 1 needed.');
    // The name and the availability share one column that stacks below sm
    // and sits side by side from sm up.
    const column = availability.closest('[data-replacement-row]') as HTMLElement | null;
    expect(column).not.toBeNull();
    expect(column!.contains(name)).toBe(true);
    expect(column!.className).toMatch(/\bflex-col\b/);
    expect(column!.className).toMatch(/\bsm:flex-row\b/);
  });
});
