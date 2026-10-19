import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The /r layout (redesign P5.1 step B): the bare frame of the public order
 * page, /r/track and /r/confirm. It keeps the book-cover preconnect, one
 * main, and the "Powered by StockPilot" footer, and reads nothing (it is a
 * plain server component with no session, cookie or database).
 */

vi.mock('@/components/orders/storefront/storefront.css', () => ({}));
vi.mock('@/components/orders/public-v2/public-orders.css', () => ({}));

import PublicOrderRequestLayout from './layout';

describe('/r layout', () => {
  it('keeps the cover preconnect, one main around the page and the footer line', () => {
    render(
      <PublicOrderRequestLayout>
        <p>the page</p>
      </PublicOrderRequestLayout>,
    );
    // React hoists the two hints into <head>.
    const preconnect = document.querySelector('link[rel="preconnect"]');
    expect(preconnect).toHaveAttribute('href', 'https://covers.openlibrary.org');
    expect(preconnect).toHaveAttribute('crossorigin', 'anonymous');
    expect(document.querySelector('link[rel="dns-prefetch"]')).toHaveAttribute(
      'href',
      'https://covers.openlibrary.org',
    );
    const main = screen.getByRole('main');
    expect(main).toHaveTextContent('the page');
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Powered by StockPilot');
    expect(screen.getAllByText('Powered by StockPilot')).toHaveLength(1);
  });

  it('keeps the public page its own 1480 px width, main and footer (it has no sidebar)', () => {
    render(
      <PublicOrderRequestLayout>
        <p>the page</p>
      </PublicOrderRequestLayout>,
    );
    // From 1352 px the catalog column beside the 372 px rail holds four
    // 220 px cards, so a category's four-card preview stays one row. The
    // dashboard main's 1320 px width wrapped it to three plus one.
    const main = screen.getByRole('main');
    const footer = screen.getByRole('contentinfo');
    expect(main.className).toMatch(/(^|\s)max-w-\[1480px\](\s|$)/);
    expect(footer.className).toMatch(/(^|\s)max-w-\[1480px\](\s|$)/);
    expect(main.className).not.toMatch(/max-w-\[1320px\]/);
    expect(footer.className).not.toMatch(/max-w-\[1320px\]/);
  });

  it('is a plain synchronous component: no async read before the page', () => {
    expect(PublicOrderRequestLayout.constructor.name).toBe('Function');
  });
});
