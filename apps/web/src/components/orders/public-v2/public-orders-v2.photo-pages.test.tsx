import { act, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The public order page's lazy fields (B32, integrator decision 3).
 *
 * The page's cached catalog carries only what a card needs to be listed and
 * searched by name. Each item's photo, its blur placeholder and its public
 * description come after first paint from the photo pages
 * (/api/v1/public/catalog-thumbnails, 500 items a page), and the storefront
 * fills them in as each page arrives: the photo where the card has no image
 * (a cover in the row stays), the blur, and the description, which the card
 * shows and the search reads.
 */

const hook = vi.hoisted(() => ({
  pages: { urls: {}, lqip: {}, descriptions: {} } as {
    urls: Record<string, string>;
    lqip: Record<string, string>;
    descriptions: Record<string, string>;
  },
  asked: [] as Array<string | null>,
}));
vi.mock('@/lib/use-catalog-thumbnails', () => ({
  useCatalogPages: (url: string | null) => {
    hook.asked.push(url);
    return hook.pages;
  },
  // The hook before this change answered the photo map alone.
  useCatalogThumbnails: (url: string | null) => {
    hook.asked.push(url);
    return hook.pages.urls;
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/image', () => ({
  default: ({ src, alt, blurDataURL }: { src: string; alt: string; blurDataURL?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element -- a test double for next/image
    <img src={src} alt={alt} data-blur={blurDataURL ?? ''} />
  ),
}));

import { publicPhotoPageUrl } from './photo-pages';
import { PublicOrdersV2 } from './public-orders-v2';
import type { PublicCatalogItem } from './types';

const WH = 'wh-n';
const COVER = 'https://covers.example.test/novel.jpg';

function item(over: Partial<PublicCatalogItem> & { id: string }): PublicCatalogItem {
  return {
    displayName: `Item ${over.id}`,
    publicDescription: null,
    categoryId: null,
    categoryLabel: null,
    imageUrl: null,
    lqip: null,
    availability: { kind: 'exact', count: 20 },
    maxQty: null,
    ...over,
  };
}

/** As the page expands the cached catalog: no description or blur yet. */
const ITEMS = [
  item({ id: 'candles', displayName: 'Candles', categoryId: 'c-1', categoryLabel: 'Supplies' }),
  item({
    id: 'novel',
    displayName: 'Novel',
    categoryId: 'c-2',
    categoryLabel: 'Books',
    imageUrl: COVER,
  }),
  item({ id: 'glue', displayName: 'Glue', categoryId: 'c-1', categoryLabel: 'Supplies' }),
];

function page() {
  return (
    <PublicOrdersV2
      token="tok-1"
      orgName="Demo Co"
      warehouses={[{ id: WH, name: 'North DC' }]}
      initialWarehouseId={WH}
      items={ITEMS}
      availabilityDisplay="exact"
      chartersForWarehouse={[]}
    />
  );
}

async function open() {
  let utils!: ReturnType<typeof render>;
  await act(async () => {
    utils = render(page());
  });
  return utils;
}

/** The photo pages answer. */
async function pagesArrive(utils: ReturnType<typeof render>, pages: typeof hook.pages) {
  hook.pages = pages;
  await act(async () => {
    utils.rerender(page());
  });
}

const card = (name: string) =>
  screen.getByText(name, { selector: '.sf-card-nm' }).closest('.sf-card') as HTMLElement;

beforeEach(() => {
  hook.pages = { urls: {}, lqip: {}, descriptions: {} };
  hook.asked = [];
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('the photo pages fill in the lazy fields', () => {
  it('asks for the first photo page at its one URL', async () => {
    await open();
    expect(hook.asked).toContain(publicPhotoPageUrl('tok-1', WH));
  });

  // Mutation caught: a storefront that takes only the photo map (the hook's
  // old answer), so no card ever shows a description or a blur again.
  it('a card shows its photo, blur and description once its page arrives', async () => {
    const utils = await open();
    expect(card('Candles').querySelector('.sfp-desc')).toBeNull();
    expect(card('Candles').querySelector('img')).toBeNull();

    await pagesArrive(utils, {
      urls: { candles: 'https://signed.test/candles.webp' },
      lqip: { candles: 'data:image/webp;base64,AAAA' },
      descriptions: { candles: 'Hand-poured beeswax.' },
    });
    const img = card('Candles').querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://signed.test/candles.webp');
    expect(img.getAttribute('data-blur')).toBe('data:image/webp;base64,AAAA');
    expect(card('Candles').querySelector('.sfp-desc')?.textContent).toBe('Hand-poured beeswax.');
  });

  it('the search finds a word that is only in a description once that page has arrived', async () => {
    const utils = await open();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Search catalog'), { target: { value: 'beeswax' } });
    });
    expect(screen.queryByText('Candles', { selector: '.sf-card-nm' })).toBeNull();

    await pagesArrive(utils, {
      urls: {},
      lqip: {},
      descriptions: { candles: 'Hand-poured beeswax.' },
    });
    expect(screen.getByText('Candles', { selector: '.sf-card-nm' })).toBeTruthy();
  });

  it('a cover the catalog row carries stays: the page never replaces it', async () => {
    const utils = await open();
    await pagesArrive(utils, {
      urls: {
        novel: 'https://signed.test/other.webp',
        glue: 'https://covers.example.test/glue.jpg',
      },
      lqip: {},
      descriptions: {},
    });
    expect(card('Novel').querySelector('img')?.getAttribute('src')).toBe(COVER);
    // A long cover the row could not carry comes with the page.
    expect(card('Glue').querySelector('img')?.getAttribute('src')).toBe(
      'https://covers.example.test/glue.jpg',
    );
  });
});
