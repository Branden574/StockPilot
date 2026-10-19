import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  deriveRentalStatus,
  RENTAL_STATUS_LABELS,
  RentalStatusBadge,
  type RentalStatusDisplay,
} from './rental-status-badge';

/**
 * The rental status label (redesign P4.D1). The list and the detail page each
 * drew their own pill in hard-coded blue / red / emerald / gray; both now draw
 * this one, on the six status tones, with the four words kept and Overdue
 * still derived from the clock (core's rule, shared with the daily sweep).
 */

const NOW = Date.parse('2026-10-18T12:00:00.000Z');

describe('deriveRentalStatus', () => {
  it('an out rental past its expected return reads Overdue; before it, Out', () => {
    expect(
      deriveRentalStatus({ status: 'out', expected_return_at: '2026-10-18T11:59:00.000Z' }, NOW),
    ).toBe('overdue');
    expect(
      deriveRentalStatus({ status: 'out', expected_return_at: '2026-10-18T12:01:00.000Z' }, NOW),
    ).toBe('out');
  });

  it('returned and cancelled keep their stored status even when the date has passed', () => {
    const past = '2026-10-01T00:00:00.000Z';
    expect(deriveRentalStatus({ status: 'returned', expected_return_at: past }, NOW)).toBe(
      'returned',
    );
    expect(deriveRentalStatus({ status: 'cancelled', expected_return_at: past }, NOW)).toBe(
      'cancelled',
    );
  });
});

describe('RentalStatusBadge', () => {
  const cases: Array<[RentalStatusDisplay, string, string]> = [
    ['out', 'Out', 'bg-sunk'],
    ['overdue', 'Overdue', 'text-destructive'],
    ['returned', 'Returned', 'text-success'],
    ['cancelled', 'Cancelled', 'text-muted-foreground'],
  ];

  it.each(cases)('%s prints "%s" on its token tone', (status, word, toneClass) => {
    render(<RentalStatusBadge status={status} />);
    const badge = screen.getByText(word);
    expect(badge.textContent).toBe(word);
    expect(badge.getAttribute('data-rental-status')).toBe(status);
    // Look-only: the tone comes from the shared Badge variants.
    expect(badge.className).toContain(toneClass);
    expect(badge.className).not.toMatch(/\b(blue|red|emerald|gray)-\d/);
  });

  it('keeps the four words', () => {
    expect(RENTAL_STATUS_LABELS).toEqual({
      out: 'Out',
      overdue: 'Overdue',
      returned: 'Returned',
      cancelled: 'Cancelled',
    });
  });

  it('no rentals component draws a status in a hard-coded palette colour any more', () => {
    for (const file of [
      'rentals-list-table.tsx',
      'rental-detail-header.tsx',
      'rental-emails-card.tsx',
      'borrower-picker.tsx',
      'rental-actions-panel.tsx',
      'rental-create-form.tsx',
    ]) {
      const src = readFileSync(path.join(__dirname, file), 'utf8');
      expect(src, file).not.toMatch(
        /\b(?:text|bg|border)-(?:blue|red|emerald|amber|gray|green)-\d/,
      );
    }
  });
});
