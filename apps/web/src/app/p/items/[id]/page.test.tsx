import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /p/items/[id], the page a printed label's QR opens (P5.1). It keeps the
 * strict public projection (CONFLICTS E2), says the on-hand state in words
 * as well as colour, and each state's colours read in both themes.
 */

const getPublicItem = vi.fn();
vi.mock('@/server/services/public-items', () => ({
  getPublicItem: (id: string) => getPublicItem(id),
}));

class NotFound extends Error {}
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFound('notFound');
  },
}));

vi.mock('next/image', async () => {
  const React = await import('react');
  return {
    default: ({ src, alt }: { src: string; alt: string }) =>
      React.createElement('img', { src, alt }),
  };
});

import PublicItemPage, { generateMetadata } from './page';

const ID = '5eed0000-0010-4000-8000-000000002001';

function item(extra: Record<string, unknown> = {}) {
  return {
    id: ID,
    name: 'Traffic Cones 18 in',
    itemType: 'product',
    imageUrl: null,
    quantityOnHand: 12,
    category: 'Athletics',
    bookAuthor: null,
    bookPublisher: null,
    bookPublishedDate: null,
    bookGrade: null,
    ...extra,
  };
}

async function open() {
  return render(await PublicItemPage({ params: Promise.resolve({ id: ID }) }));
}

beforeEach(() => {
  getPublicItem.mockReset();
});

describe('/p/items/[id]', () => {
  it('shows the name, type, category and On hand with its word, and nothing internal', async () => {
    getPublicItem.mockResolvedValue(item());
    const { container } = await open();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Traffic Cones 18 in' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Product')).toBeInTheDocument();
    expect(screen.getByText('Athletics')).toBeInTheDocument();
    expect(screen.getByText('On hand')).toBeInTheDocument();
    expect(screen.getByText('In stock')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\bSKU\b|supplier:|\bcost\b|\$|rack/i);
    expect(screen.getByRole('link', { name: 'sign in' })).toHaveAttribute('href', '/signin');
  });

  it.each([
    [0, 'Out of stock', 'out', 'bg-destructive-wash', 'text-destructive'],
    [1, 'Last one', 'last', 'bg-warning-wash', 'text-warning'],
    [7, 'In stock', 'in', 'bg-success-wash', 'text-success'],
  ])(
    'on hand %i reads "%s" on its own wash (never colour alone)',
    async (qty, word, state, wash, ink) => {
      getPublicItem.mockResolvedValue(item({ quantityOnHand: qty }));
      const { container } = await open();
      const panel = container.querySelector('[data-slot="public-on-hand"]') as HTMLElement;
      expect(panel.dataset.stock).toBe(state);
      expect(panel.textContent).toContain(word);
      expect(panel.textContent).toContain(String(qty));
      expect(panel.className).toContain(wash);
      expect(panel.className.split(/\s+/)).toContain(ink);
    },
  );

  it('Last one no longer uses text-warning-foreground on a 5% wash (1.06:1 in dark mode; P2.1 hand-off)', async () => {
    getPublicItem.mockResolvedValue(item({ quantityOnHand: 1 }));
    const { container } = await open();
    const panel = container.querySelector('[data-slot="public-on-hand"]') as HTMLElement;
    expect(panel.className).not.toMatch(/text-warning-foreground|bg-warning\/5/);
  });

  it('lists the four book fields as label and value pairs, for books only', async () => {
    getPublicItem.mockResolvedValue(
      item({
        itemType: 'book',
        bookAuthor: 'Ada Brook',
        bookPublisher: 'Brindlewick Press',
        bookPublishedDate: '2019',
        bookGrade: '4',
      }),
    );
    const { container } = await open();
    const terms = Array.from(container.querySelectorAll('dt')).map((dt) => dt.textContent);
    expect(terms).toEqual(['Author', 'Publisher', 'Published', 'Grade']);
    expect(screen.getByText('Ada Brook')).toBeInTheDocument();
    expect(screen.getByText('Book')).toBeInTheDocument();
  });

  it('an unknown or inactive item is the generic not-found', async () => {
    getPublicItem.mockResolvedValue(null);
    await expect(open()).rejects.toBeInstanceOf(NotFound);
  });

  it('titles carry no hand-written " · StockPilot" (the root template adds it; CONFLICTS D15)', async () => {
    getPublicItem.mockResolvedValue(item());
    const meta = await generateMetadata({ params: Promise.resolve({ id: ID }) });
    expect(meta.title).toBe('Traffic Cones 18 in');
    expect(meta.robots).toEqual({ index: false, follow: false });
    getPublicItem.mockResolvedValue(null);
    const missing = await generateMetadata({ params: Promise.resolve({ id: ID }) });
    expect(missing.title).toBe('Item not found');
  });
});
