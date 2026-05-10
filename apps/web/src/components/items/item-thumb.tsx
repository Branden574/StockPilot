'use client';

import { Package } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Renders a thumbnail when the item has a primary image, falling back to
 * the brand-styled Package icon otherwise. We swap to the icon on
 * `onError` too, since signed URLs can race expiry or the underlying
 * file can have been deleted between the API response and the <img>
 * fetch — better a placeholder than a broken-image glyph.
 *
 * Single source of truth for item thumbnails across the app:
 *   • new-shipment picker rows (md)
 *   • shipment detail line table (md)
 *   • PO detail line table (sm)
 *   • ⌘K command palette item rows (sm)
 */
interface Props {
  imageUrl: string | null | undefined;
  alt: string;
  /** sm = 28×28 (compact rows); md = 40×40 (line tables / pickers). Default md. */
  size?: 'sm' | 'md';
  /**
   * When provided, resets the internal `failed` state any time the
   * itemId changes — useful for virtualised / re-keyed rows that reuse
   * the same component instance for different items.
   */
  itemId?: string;
}

export function ItemThumb({ imageUrl, alt, size = 'md', itemId }: Props) {
  // Track failures so swapping back/forth in pagination doesn't
  // re-fetch a known-broken URL each time.
  const [failed, setFailed] = React.useState(false);
  // Reset when the URL OR the item changes — a fresh signed URL for the
  // same item should retry, and a different item gets its own attempt.
  React.useEffect(() => {
    setFailed(false);
  }, [imageUrl, itemId]);

  const sizeClass =
    size === 'sm' ? 'h-7 w-7' : 'h-10 w-10';
  const iconClass = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';

  if (imageUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt={alt}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className={cn(
          'bg-muted flex-shrink-0 rounded-md object-cover',
          sizeClass,
        )}
      />
    );
  }
  return (
    <div
      className={cn(
        'bg-muted text-muted-foreground/70 flex flex-shrink-0 items-center justify-center rounded-md',
        sizeClass,
      )}
      aria-hidden="true"
    >
      <Package className={iconClass} />
    </div>
  );
}
