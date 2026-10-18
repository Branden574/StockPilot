import { render, screen } from '@testing-library/react';
import type * as React from 'react';
import { describe, expect, it } from 'vitest';

import { badgeVariants } from '@/components/ui/badge';

import { StockStatusBadge } from './stock-status-badge';

// Task 8: the "Auto-archived" sub-badge distinguishes a SYSTEM archive
// (the zero-stock cron, migration 0266) from a manual one.
describe('StockStatusBadge — autoArchived sub-badge', () => {
  it('shows only "Archived" when the item was archived manually', () => {
    render(<StockStatusBadge quantity={0} reorderPoint={0} itemStatus="archived" />);
    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(screen.queryByText('Auto-archived')).not.toBeInTheDocument();
  });

  it('shows both "Archived" and "Auto-archived" when the system archived it', () => {
    render(
      <StockStatusBadge quantity={0} reorderPoint={0} itemStatus="archived" autoArchived />,
    );
    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(screen.getByText('Auto-archived')).toBeInTheDocument();
  });

  it('never shows the sub-badge for a non-archived status, even if autoArchived is stale-true', () => {
    render(
      <StockStatusBadge quantity={5} reorderPoint={0} itemStatus="active" autoArchived />,
    );
    expect(screen.queryByText('Auto-archived')).not.toBeInTheDocument();
    expect(screen.getByText('In stock')).toBeInTheDocument();
  });
});

// Mig 0277: items auto-created from an inbound PO that have never
// received stock render "Expected" instead of the misleading
// "Out of stock" pill.
describe('StockStatusBadge — awaitingFirstReceipt ("Expected") pill', () => {
  it('replaces "Out of stock" with "Expected" for an active zero-qty flagged item', () => {
    render(
      <StockStatusBadge quantity={0} reorderPoint={0} itemStatus="active" awaitingFirstReceipt />,
    );
    expect(screen.getByText('Expected')).toBeInTheDocument();
    expect(screen.queryByText('Out of stock')).not.toBeInTheDocument();
  });

  it('renders the verbose detail-page label when expectedVerbose is set', () => {
    render(
      <StockStatusBadge
        quantity={0}
        reorderPoint={0}
        itemStatus="active"
        awaitingFirstReceipt
        expectedVerbose
      />,
    );
    expect(screen.getByText('Expected — awaiting first receipt')).toBeInTheDocument();
  });

  it('an UNFLAGGED zero-qty item still reads "Out of stock" (established items keep today\'s pill)', () => {
    render(<StockStatusBadge quantity={0} reorderPoint={0} itemStatus="active" />);
    expect(screen.getByText('Out of stock')).toBeInTheDocument();
    expect(screen.queryByText('Expected')).not.toBeInTheDocument();
  });

  it('archived status wins over a stale flag — the Archived pill renders, never Expected', () => {
    render(
      <StockStatusBadge quantity={0} reorderPoint={0} itemStatus="archived" awaitingFirstReceipt />,
    );
    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(screen.queryByText('Expected')).not.toBeInTheDocument();
  });
});

// The redesign (P2.4, DESIGN-SPEC 6.10): every stock word sits on one of the
// six Badge tones through the existing variant names, led by a 5px dot. The
// tone is read from the live Badge recipe (classes all six tones share are
// ignored), so restyling the recipe cannot break this check, and a word that
// moved to another tone (or a new tier) would.
const TONES = ['default', 'secondary', 'destructive', 'success', 'warning', 'outline'] as const;
function toneOf(el: Element): string {
  const own = new Set(el.className.split(/\s+/));
  const recipes = TONES.map((t) => badgeVariants({ variant: t }).split(/\s+/));
  const shared = recipes.reduce((a, r) => a.filter((c) => r.includes(c)));
  return TONES.filter((_, i) => recipes[i]!.every((c) => shared.includes(c) || own.has(c))).join(
    '|',
  );
}

describe('StockStatusBadge — the real vocabulary on the status tones', () => {
  const cases: Array<[string, React.ComponentProps<typeof StockStatusBadge>, string]> = [
    ['In stock', { quantity: 5, reorderPoint: 0 }, 'success'],
    ['In stock', { quantity: 6, reorderPoint: 5 }, 'success'],
    ['Low stock', { quantity: 5, reorderPoint: 5 }, 'warning'],
    ['Low stock', { quantity: 2, reorderPoint: 5 }, 'warning'],
    ['Out of stock', { quantity: 0, reorderPoint: 5 }, 'destructive'],
    ['Out of stock', { quantity: -3, reorderPoint: 0 }, 'destructive'],
    ['Expected', { quantity: 0, reorderPoint: 5, awaitingFirstReceipt: true }, 'secondary'],
    [
      'Expected — awaiting first receipt',
      { quantity: 0, reorderPoint: 5, awaitingFirstReceipt: true, expectedVerbose: true },
      'secondary',
    ],
    ['Archived', { quantity: 0, reorderPoint: 0, itemStatus: 'archived' }, 'outline'],
    ['Discontinued', { quantity: 9, reorderPoint: 0, itemStatus: 'discontinued' }, 'outline'],
  ];

  it.each(cases)('"%s" (%j) is the %s tone, led by its dot', (word, props, tone) => {
    render(<StockStatusBadge {...props} />);
    const pill = screen.getByText(word);
    expect(toneOf(pill)).toBe(tone);
    expect(pill.textContent).toBe(word);
    const dot = pill.querySelector('span[aria-hidden]');
    expect(dot).not.toBeNull();
    expect(dot!.textContent).toBe('');
    // One line: the dot never sits alone above a wrapped label.
    expect(pill).toHaveClass('whitespace-nowrap');
  });

  it('Auto-archived is the neutral tone beside the outline Archived pill', () => {
    render(<StockStatusBadge quantity={0} reorderPoint={0} itemStatus="archived" autoArchived />);
    expect(toneOf(screen.getByText('Archived'))).toBe('outline');
    expect(toneOf(screen.getByText('Auto-archived'))).toBe('secondary');
  });

  it('adds no tier: far under the reorder point still reads "Low stock", never "Critical"', () => {
    render(<StockStatusBadge quantity={1} reorderPoint={40} />);
    expect(screen.getByText('Low stock')).toBeInTheDocument();
    expect(screen.queryByText(/critical/i)).not.toBeInTheDocument();
  });
});
