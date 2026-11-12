import { render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href, ...rest }, children),
  };
});

import {
  ItemGlassAside,
  ItemGlassSummary,
  stockAlert,
  type ItemGlassFacts,
} from './item-glass-summary';

/**
 * The item page's glass summary card and side column (Item-Detail.dc.html,
 * Book-Detail.dc.html). Words, figures and one gated link, from values the
 * page already holds; not rendered at all under the off rollout.
 */
afterEach(() => vi.unstubAllEnvs());

const FACTS: ItemGlassFacts = {
  isBook: false,
  unit: 'each',
  onHand: 6,
  reserved: 2,
  reorderPoint: 10,
  reorderQuantity: 24,
  retailPrice: 35,
  unitCost: 22,
  value: 132,
  status: 'active',
  awaitingFirstReceipt: false,
  staged: 0,
  photoSrc: null,
  book: null,
  ordering: null,
  inFamily: false,
  bookReportHref: null,
};

describe('ItemGlassSummary and ItemGlassAside', () => {
  it('render nothing at all under the off rollout (and with the flag unset)', () => {
    for (const flag of ['off', '']) {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', flag);
      expect(render(<ItemGlassSummary facts={FACTS} />).container.innerHTML).toBe('');
      expect(render(<ItemGlassAside facts={FACTS} />).container.innerHTML).toBe('');
    }
  });

  it('under default: a glass-only section and aside, with no class (only glass draws them) and no control', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const s = render(<ItemGlassSummary facts={FACTS} />).container.firstElementChild!;
    const a = render(<ItemGlassAside facts={FACTS} />).container.firstElementChild!;
    for (const [el, tag] of [
      [s, 'SECTION'],
      [a, 'ASIDE'],
    ] as const) {
      expect(el.tagName).toBe(tag);
      expect(el).toHaveAttribute('data-glass-only', '');
      expect(el).not.toHaveAttribute('class');
      expect(el).not.toHaveAttribute('hidden');
      expect(el.querySelectorAll('[class]:not([data-slot="missing-photo"]):not(svg)')).toHaveLength(
        0,
      );
      expect(el.querySelectorAll('a, button, input, select, textarea')).toHaveLength(0);
    }
  });

  it('stockAlert follows StockStatusBadge: out at zero, low at or under a set reorder point, none otherwise', () => {
    expect(stockAlert({ ...FACTS, onHand: 0 })).toBe('out');
    expect(stockAlert({ ...FACTS, onHand: 10 })).toBe('low');
    expect(stockAlert({ ...FACTS, onHand: 11 })).toBeNull();
    expect(stockAlert({ ...FACTS, reorderPoint: 0, onHand: 3 })).toBeNull();
    expect(stockAlert({ ...FACTS, status: 'discontinued' })).toBeNull();
    expect(stockAlert({ ...FACTS, awaitingFirstReceipt: true, onHand: 0 })).toBeNull();
  });

  it('over-reserved: Available is 0 in the danger tone with the shortfall, and the Reserved card says so', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const facts = { ...FACTS, onHand: 4, reserved: 9 };
    const s = render(<ItemGlassSummary facts={facts} />).container;
    const available = Array.from(s.querySelectorAll('[data-glass-part="well"]'))[1]!;
    expect(available).toHaveAttribute('data-glass-tone', 'danger');
    expect(available.querySelector('dd')).toHaveTextContent('0 each');
    expect(available).toHaveTextContent('5 short of what is promised');
    const a = render(<ItemGlassAside facts={facts} />).container;
    expect(a).toHaveTextContent('9 each reserved for open orders, so 0 each available.');
  });

  it('Ordering on a record awaiting its first receipt: the Expected badge Manage order items shows, and orderable from that receipt', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const ordering = (facts: ItemGlassFacts) => {
      const a = render(<ItemGlassAside facts={facts} />).container as HTMLElement;
      const card = within(a).getByRole('heading', { name: 'Ordering' }).closest('section')!;
      const badges = Array.from(card.querySelectorAll('[data-glass-part="badge"]')).map(
        (b) => b.textContent,
      );
      return { badges, text: card.textContent ?? '' };
    };
    // Manage order items' StateBadges: the state badge, then Expected
    // (order-catalog-visibility.ts: expected = awaiting_first_receipt).
    const shown = ordering({ ...FACTS, ordering: { visible: true }, awaitingFirstReceipt: true });
    expect(shown.badges).toEqual(['Shown in Orders', 'Expected']);
    expect(shown.text).toContain(
      'Requesters can order this record in Place an Order from its first receipt, where they are allowed to order.',
    );
    const hidden = ordering({ ...FACTS, ordering: { visible: false }, awaitingFirstReceipt: true });
    expect(hidden.badges).toEqual(['Hidden from Orders', 'Expected']);
    expect(hidden.text).toContain('Requesters cannot order this record in Place an Order.');
    // Received: one badge and today's sentence.
    const received = ordering({ ...FACTS, ordering: { visible: true } });
    expect(received.badges).toEqual(['Shown in Orders']);
    expect(received.text).toContain(
      'Requesters can order this record in Place an Order where they are allowed to order.',
    );
  });

  it('the Book Order Totals link renders only when the page passes its href (the page checks the gate)', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const book = { ...FACTS, isBook: true, bookReportHref: '/dashboard/reports/book-order-totals' };
    const a = render(<ItemGlassAside facts={book} />).container;
    const link = within(a as HTMLElement).getByRole('link', { name: 'Open the report' });
    expect(link).toHaveAttribute('href', '/dashboard/reports/book-order-totals');
  });
});
