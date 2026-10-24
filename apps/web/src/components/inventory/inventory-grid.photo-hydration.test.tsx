import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hydrateAcrossClockShift } from '@/test/hydration';

/**
 * R8, the case a client-only render cannot show. The Grid is the server's
 * first paint when a viewer picked it, and the first cards' covers load with
 * that HTML (priority), long before the page hydrates. So a cover that fails
 * usually fails while React is not listening yet, and its error is lost.
 * next/image answers that only for an image given an onError: once mounted it
 * sets the same address again, the browser asks once more, and that error
 * reaches the handler. Without one the card stayed blank for good.
 *
 * This runs the REAL next/image (inventory-grid.test.tsx mocks it) through a
 * real server render and hydration (src/test/hydration.ts). happy-dom loads no
 * http image, so the browser's side is played here: every time an img is
 * given the failing address, the request "fails" and the img fires 'error', as
 * a cover that 404s does. Parsing the server HTML does not count as such a
 * request (happy-dom's parser never calls the img's src setter), which is the
 * failure nobody heard before hydration. So the card can only learn about it
 * if something asks for the address again after hydration.
 * Mutation caught: CardPhoto without onError (the photo stays), or a
 * next/image upgrade that stops setting the address again.
 */
const FAILING_COVER = 'https://img.test/deleted-cover.webp';
const WORKING_COVER = 'https://img.test/bp-thumb.webp';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/dashboard/inventory',
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => {
    const { prefetch: _p, scroll: _s, replace: _r, ...anchor } = rest;
    return (
      <a
        href={typeof href === 'string' ? href : '#'}
        {...(anchor as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
      >
        {children}
      </a>
    );
  },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }));
vi.mock('@/server/actions/saved-views', () => ({
  createSavedViewAction: vi.fn(),
  deleteSavedViewAction: vi.fn(),
  setActiveWarehouseAction: vi.fn(),
  toggleSavedViewShareAction: vi.fn(),
}));
vi.mock('@/lib/download-export', () => ({ downloadInventoryExport: vi.fn() }));
vi.mock('@/lib/cycle-counts/use-count-selection', () => ({
  useCountSelection: (selector: (s: { add: () => void }) => unknown) => selector({ add: vi.fn() }),
}));
vi.mock('@/components/inventory/display-group-dialogs', () => ({
  GroupSelectedDialog: () => null,
  RemoveFromGroupDialog: () => null,
  RenameGroupDialog: () => null,
}));
vi.mock('@/components/inventory/bulk-actions', () => ({ BulkActions: () => null }));

import { InventoryTable } from './inventory-table';

const LOOKUPS = {
  categories: new Map<string, { name: string; color: string | null }>([
    ['cat-swag', { name: 'Swag', color: null }],
  ]),
  locations: new Map<string, { name: string }>([['loc-north', { name: 'North DC' }]]),
  charters: new Map<string, { name: string; code: string | null }>(),
};

/** One record with only a thumb (served as it is, never through the optimizer). */
function backpack(thumb: string) {
  return {
    id: 'bp',
    name: 'Laptop Backpack',
    sku: 'SKU-bp',
    status: 'active' as const,
    quantity_on_hand: 10,
    reorder_point: 0,
    unit_cost: 2,
    retail_price: 5,
    category_id: 'cat-swag',
    charter_id: null,
    primary_location_id: 'loc-north',
    barcode: null,
    model_number: null,
    custom_fields: null,
    item_type: 'product',
    display_group_id: null,
    display_group_name: null,
    display_group_version: null,
    image_url: null,
    image_thumb_url: thumb,
    image_lqip: null,
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-02T00:00:00+00:00',
  };
}

// The browser's side (see above): addresses given to an img, and a failed
// request for FAILING_COVER each time.
const requested: string[] = [];
const imgProto = window.HTMLImageElement.prototype;
const nativeSrc = Object.getOwnPropertyDescriptor(imgProto, 'src')!;

beforeEach(() => {
  requested.length = 0;
  Object.defineProperty(imgProto, 'src', {
    configurable: true,
    enumerable: nativeSrc.enumerable,
    get(this: HTMLImageElement) {
      return nativeSrc.get!.call(this);
    },
    set(this: HTMLImageElement, value: string) {
      nativeSrc.set!.call(this, value);
      requested.push(value);
      if (value === FAILING_COVER) this.dispatchEvent(new Event('error'));
    },
  });
});

afterEach(() => {
  Object.defineProperty(imgProto, 'src', nativeSrc);
});

async function hydrateGrid(thumb: string) {
  // The same clock on both sides: this test is about the photo, not the time.
  const at = Date.parse('2026-10-24T18:00:00Z');
  return hydrateAcrossClockShift(
    () => (
      <InventoryTable
        items={[backpack(thumb)] as never}
        lookups={LOOKUPS}
        total={1}
        initialQuery=""
        pageSize={30}
        canUngroup
        initialView="grid"
      />
    ),
    { serverNow: at, browserNow: at },
  );
}

const mediaOf = (container: HTMLElement) =>
  container.querySelector('[data-row-key="bp"] [data-slot="grid-card-media"]')! as HTMLElement;

describe('a Grid cover that failed before the page hydrated (R8)', () => {
  it('shows the missing-photo hatch once the page hydrates', async () => {
    const run = await hydrateGrid(FAILING_COVER);
    try {
      // The server sent the photo, and React took over that HTML as it was:
      // a mismatch would have drawn the card again and asked anew.
      expect(run.html).toContain(`src="${FAILING_COVER}"`);
      expect(run.errors).toEqual([]);
      // next/image asked for the cover again once hydrated, and heard it fail.
      expect(requested).toContain(FAILING_COVER);
      const media = mediaOf(run.container);
      expect(media.querySelector('img')).toBeNull();
      expect(media.querySelector('[data-slot="missing-photo"]')).not.toBeNull();
    } finally {
      run.unmount();
    }
  });

  it('a cover that loads keeps its photo through hydration', async () => {
    const run = await hydrateGrid(WORKING_COVER);
    try {
      expect(run.errors).toEqual([]);
      const media = mediaOf(run.container);
      expect(media.querySelector('img')).toHaveAttribute('src', WORKING_COVER);
      expect(media.querySelector('[data-slot="missing-photo"]')).toBeNull();
    } finally {
      run.unmount();
    }
  });
});
