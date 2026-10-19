import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import RentalsLoading from './loading';

/**
 * The Rentals section's loading screen (redesign P4.D1), drawn in the
 * checkouts list's shape instead of the generic stat-strip page: the page box,
 * the header, the section tabs, the five status views and the table card, with
 * the table's own narrow-width rule (Items hidden below sm, Checked out below
 * md). It shows grey bars only, never a word or a number.
 */
describe('Rentals loading screen', () => {
  it('draws bars only: no words, no numbers', () => {
    const { container } = render(<RentalsLoading />);
    expect(container.textContent).toBe('');
    const bars = container.querySelectorAll('.animate-pulse');
    expect(bars.length).toBeGreaterThan(20);
  });

  it('sits in the page box every dashboard page uses', () => {
    const { container } = render(<RentalsLoading />);
    const page = container.firstElementChild as HTMLElement;
    for (const cls of ['max-w-[1320px]', 'px-4', 'sm:px-8', 'pt-6', 'gap-4']) {
      expect(page.classList.contains(cls), cls).toBe(true);
    }
  });

  it('five status views and six table rows that pad like the table', () => {
    const { container } = render(<RentalsLoading />);
    const track = container.querySelector('.bg-sunk') as HTMLElement;
    expect(track.children).toHaveLength(5);
    const rows = Array.from(container.querySelectorAll<HTMLElement>('div[style]')).filter((el) =>
      el.style.paddingTop.includes('--row-py'),
    );
    expect(rows).toHaveLength(6);
  });

  it('hides the Items and Checked out columns where the table hides them', () => {
    const { container } = render(<RentalsLoading />);
    const card = container.querySelector('.rounded-lg.border.bg-card') as HTMLElement;
    const lines = Array.from(card.children) as HTMLElement[];
    // The header line and the six rows: six cells each, the second hidden
    // below sm and the third below md.
    expect(lines).toHaveLength(7);
    for (const line of lines) {
      const cells = Array.from(line.children) as HTMLElement[];
      expect(cells).toHaveLength(6);
      expect(cells[1]!.className).toMatch(/(^|\s)hidden sm:block(\s|$)/);
      expect(cells[2]!.className).toMatch(/(^|\s)hidden md:block(\s|$)/);
    }
  });
});
