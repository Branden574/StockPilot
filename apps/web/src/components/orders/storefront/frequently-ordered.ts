'use client';

import * as React from 'react';

import type { FrequentlyOrderedEntry } from '@/server/loaders/orders-frequently-ordered';

import type { CatalogItem } from '../v2/types';
import type { FreqEntry } from './storefront-cards';

/**
 * The value of a promise the SERVER started, once it arrives, WITHOUT
 * suspending: `null` until then. For the parts of the catalog that only get
 * better when the frequently-ordered list shows up (the "most ordered" sort,
 * the cart's suggestions) and must never wait for it. The strip itself uses
 * `React.use` inside its own Suspense boundary, so its cards and photos are in
 * the streamed HTML.
 */
export function useStreamed<T>(promise: Promise<T>): T | null {
  const [settled, setSettled] = React.useState<{ promise: Promise<T>; value: T } | null>(null);
  React.useEffect(() => {
    let live = true;
    promise.then(
      (value) => {
        if (live) setSettled({ promise, value });
      },
      () => {
        /* the loader never rejects; a rejection simply leaves the list empty */
      },
    );
    return () => {
      live = false;
    };
  }, [promise]);
  // A NEW promise (another warehouse) must not show the old warehouse's list.
  return settled !== null && settled.promise === promise ? settled.value : null;
}

/** Catalog rows for the frequently-ordered ids. Ids the catalog does not hold are dropped. */
export function toFreqEntries(
  list: FrequentlyOrderedEntry[],
  itemMap: Map<string, CatalogItem>,
): FreqEntry[] {
  return list.flatMap((f) => {
    const item = itemMap.get(f.itemId);
    if (!item) return [];
    // The loader signs a small thumbnail ONLY for a catalog row with no photo
    // URL of its own, so an item with a photo never shows a letter glyph.
    return [{ item: { ...item, imageUrl: item.imageUrl ?? f.fallbackImageUrl }, count: f.count }];
  });
}
