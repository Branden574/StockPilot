import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The /r layout (redesign P5.1 step B): the bare frame of the public order
 * page, /r/track and /r/confirm. It keeps the book-cover preconnect, one
 * main, and the "Powered by StockPilot" footer, and reads nothing (it is a
 * plain server component with no session, cookie or database).
 */

vi.mock('@/components/orders/storefront/storefront.css', () => ({}));
vi.mock('@/components/orders/public-v2/public-orders.css', () => ({}));
vi.mock('@/components/theme/theme-toggle', () => ({
  ThemeToggle: () => <button type="button">Toggle theme</button>,
}));

import PublicOrderRequestLayout from './layout';

afterEach(() => {
  vi.unstubAllEnvs();
});

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

/**
 * The way back to Classic (plans/REVISION-DEFAULT.md R13, round 2 finding 5).
 * Under `default` a person who opens an emailed /r/<token> link with no
 * Design cookie sees Liquid Glass, and these pages draw their column inside
 * this layout (frame="column"), so ExternalShell's own corner never reaches
 * them: the layout draws the same glass-only corner menu.
 */
describe('/r layout: the appearance menu in a glass-only corner', () => {
  const corner = (container: HTMLElement) =>
    container.querySelector('[data-slot="external-appearance"]');

  it.each(['default', 'opt-in'])(
    '%s: the header appearance menu sits in the glass-only corner, outside the main',
    (rollout) => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
      const { container } = render(
        <PublicOrderRequestLayout>
          <p>the page</p>
        </PublicOrderRequestLayout>,
      );
      const slot = corner(container);
      expect(slot).not.toBeNull();
      expect(slot).toHaveAttribute('data-glass-only');
      expect(
        within(slot as HTMLElement).getByRole('button', { name: 'Toggle theme' }),
      ).toBeTruthy();
      expect(screen.getByRole('main')).not.toContainElement(slot as HTMLElement);
      expect(screen.getByRole('contentinfo')).not.toContainElement(slot as HTMLElement);
    },
  );

  it('off: today’s markup, no corner', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    const { container } = render(
      <PublicOrderRequestLayout>
        <p>the page</p>
      </PublicOrderRequestLayout>,
    );
    expect(container.innerHTML).not.toContain('external-appearance');
    expect(container.innerHTML).not.toContain('data-glass-only');
  });

  it('the 8.5 allowlist lists /r/[token], /r/track and /r/confirm for the corner', () => {
    const allowlist = JSON.parse(
      readFileSync(
        join(
          __dirname,
          '..',
          '..',
          '..',
          'tests',
          'e2e',
          'appearance',
          'glass-only-allowlist.json',
        ),
        'utf8',
      ),
    ) as { entries: { id: string; routes: string[] }[] };
    const entry = allowlist.entries.find((e) => e.id === 'external-appearance-menu');
    expect(entry?.routes).toEqual(expect.arrayContaining(['/r/[token]', '/r/track', '/r/confirm']));
  });
});
