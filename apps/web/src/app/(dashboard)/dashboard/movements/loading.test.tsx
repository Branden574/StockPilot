import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import MovementsLoading from './loading';

describe('Movements loading skeleton', () => {
  it('draws grey bars only: no words or numbers to misread as data', () => {
    const { container } = render(<MovementsLoading />);
    expect(container.textContent).toBe('');
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('draws the ledger card: a header row, 12 rows that pad like the table and the footer', () => {
    const { container } = render(<MovementsLoading />);
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[style]')).filter(
      (el) => el.style.paddingTop === 'var(--row-py, 11px)',
    );
    expect(rows).toHaveLength(12);
    // Seven columns per row: When, Item, Type, Δ, After, By, Note.
    for (const row of rows) expect(row.children).toHaveLength(7);
  });

  it('draws the 11 type chips (All types and the 10 types)', () => {
    const { container } = render(<MovementsLoading />);
    const chips = Array.from(container.querySelectorAll<HTMLElement>('[style]')).filter(
      (el) => el.style.height === '30px',
    );
    expect(chips).toHaveLength(11);
  });
});
