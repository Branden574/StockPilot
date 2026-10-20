import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  SizeRunReceiveGrid,
  varianceToneClass,
  type ReceiveRunLine,
} from './size-run-receive-grid';

/**
 * The size run keeps its seven columns wider than a phone, and on a phone each
 * size stacks with every figure labelled, so nothing needs a sideways scroll.
 * The labels sit beside the figures, never inside them, so each figure's own
 * element (and test id) still holds only the number.
 */

function line(id: string, size: string, ordered: number, received = 0): ReceiveRunLine {
  return {
    id,
    name: `Jersey ${size}`,
    sku: `JRS-${size}`,
    quantityOrdered: ordered,
    quantityReceived: received,
    trackingType: 'none',
    groupId: 'g1',
    variantSize: size,
  };
}

const GROUP = { name: 'Lab Jersey · Navy', countingUnit: 'each' as const, sizeOrder: null };

describe('SizeRunReceiveGrid layout', () => {
  it('keeps the column labels and labels each figure on a phone, outside the figure', () => {
    render(
      <SizeRunReceiveGrid
        groupId="g1"
        group={GROUP}
        lines={[line('a', 'XS', 6), line('b', 'M', 6, 2)]}
        entries={{ a: { received: 4 } }}
        onChange={vi.fn()}
      />,
    );
    const run = screen.getByTestId('size-run');
    expect(run.textContent).toContain('Size run · 2 sizes · 12 each ordered');
    for (const label of [
      'Size',
      'Ordered',
      'Already',
      'Receiving',
      'Accepted',
      'Rejected',
      'Variance',
    ]) {
      expect(within(run).getAllByText(label).length, label).toBeGreaterThanOrEqual(1);
    }
    const [xs, m] = screen.getAllByTestId('size-run-row');
    for (const label of ['Ordered', 'Already', 'Accepted', 'Rejected', 'Variance']) {
      expect(within(xs!).getByText(label), label).toBeInTheDocument();
    }
    expect(within(xs!).getByTestId('size-run-ordered').textContent).toBe('6');
    expect(within(xs!).getByTestId('size-run-accepted').textContent).toBe('4');
    expect(within(xs!).getByTestId('size-run-rejected').textContent).toBe('0');
    expect(within(xs!).getByTestId('size-run-variance').textContent).toBe('2');
    expect(within(m!).getByTestId('size-run-already').textContent).toBe('2');
    expect(within(m!).getByTestId('size-run-variance').textContent).toBe('4');
    expect(within(m!).getByRole('spinbutton', { name: 'Receiving size M' })).toBeInTheDocument();
  });

  it('tones the variance as the flat rows do, in tokens that hold in both themes', () => {
    expect(varianceToneClass(3)).toBe('text-warning');
    expect(varianceToneClass(-1)).toBe('text-destructive');
    expect(varianceToneClass(0)).toBe('text-success');
  });
});
