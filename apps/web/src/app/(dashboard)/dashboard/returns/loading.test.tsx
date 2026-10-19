import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ReturnsLoading from './loading';

/**
 * The Returns list's loading skeleton (redesign P4.B3) is drawn in the page's
 * own shape: the header, the search, the nine filter chips and the table card
 * whose rows pad like the table's.
 */
describe('Returns list loading skeleton', () => {
  it('draws grey bars only: no words or numbers to misread as data', () => {
    const { container } = render(<ReturnsLoading />);
    expect(container.textContent).toBe('');
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('draws the nine filter chips', () => {
    const { container } = render(<ReturnsLoading />);
    const chips = container.querySelector('[data-slot="returns-loading-chips"]');
    expect(chips?.children).toHaveLength(9);
  });

  it('draws the table card: 8 rows that pad like the table, 7 columns each', () => {
    const { container } = render(<ReturnsLoading />);
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[style]')).filter(
      (el) => el.style.paddingTop === 'var(--row-py, 11px)',
    );
    expect(rows).toHaveLength(8);
    // RMA, Order, Type, Requester, Returning, Status, Created.
    for (const row of rows) expect(row.children).toHaveLength(7);
  });
});
