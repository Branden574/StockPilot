import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StatStrip } from '@/components/patterns/stat-strip';

import { StockAvailabilityLine } from './stock-availability-line';

/**
 * The reserved and available figures render as two cells of the item page's
 * figure strip (redesign P3.3), so each case renders them inside the strip the
 * page puts them in. The words are the same: "reserved for open orders" is the
 * reserved figure's label and "available" the other's.
 */
function renderStrip(props: { onHand: number; reserved: number; unit?: string }) {
  return render(
    <StatStrip variant="detail" data-testid="strip">
      <StockAvailabilityLine {...props} />
    </StatStrip>,
  );
}

describe('StockAvailabilityLine', () => {
  it('renders nothing when nothing is reserved', () => {
    // "46 available · 0 reserved" beside "46 on hand" is three ways of saying
    // one number. The figures must earn their space.
    const { container } = render(<StockAvailabilityLine onHand={46} reserved={0} unit="unit" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows what a new order can actually take', () => {
    renderStrip({ onHand: 100, reserved: 72, unit: 'unit' });
    expect(screen.getByText('28')).toBeInTheDocument();
    // Visual-only update (P3.3): the line "28 available · 72 reserved for open
    // orders" became two labelled strip cells. The same figures with the same
    // words are asserted, each label beside its own number.
    expect(screen.getByTestId('item-reserved')).toHaveTextContent(
      /^Reserved for open orders72 unit$/,
    );
    expect(screen.getByTestId('item-available')).toHaveTextContent(/^Available28 unit$/);
  });

  it('the two figures are direct cells of the strip (no wrapper), in order', () => {
    renderStrip({ onHand: 100, reserved: 72 });
    const cells = Array.from(
      screen.getByTestId('strip').querySelectorAll('[data-slot="stat-strip-item"]'),
    );
    expect(cells.map((c) => c.getAttribute('data-testid'))).toEqual([
      'item-reserved',
      'item-available',
    ]);
    for (const cell of cells) {
      expect(cell.parentElement?.parentElement).toBe(screen.getByTestId('strip'));
    }
  });

  it('fully reserved shows 0 available and no alarm', () => {
    renderStrip({ onHand: 40, reserved: 40 });
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.queryByText(/short of what is promised/)).not.toBeInTheDocument();
  });

  it('OVER-reserved is called out, not left looking sold out', () => {
    // 12 promised against 10 owned clamps to "0 available", which is identical
    // on screen to plainly sold out. Sold out is normal; this is a promise
    // nobody can keep, so it gets its own words.
    renderStrip({ onHand: 10, reserved: 12 });
    expect(screen.getByText(/2 short of what is promised/)).toBeInTheDocument();
    expect(screen.getByTestId('item-available')).toHaveTextContent(/2 short of what is promised/);
  });

  it('does not signal severity with colour alone', () => {
    // Warehouse screens get read on cheap handsets in bad light.
    const { container } = renderStrip({ onHand: 10, reserved: 12 });
    expect(container.querySelector('svg')).not.toBeNull();
    expect(screen.getByText(/short of what is promised/)).toBeInTheDocument();
  });
});
