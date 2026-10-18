'use client';

import * as React from 'react';

import { ImageHoverPreview } from '@/components/ui/image-hover-preview';
import { cn } from '@/lib/utils';

/**
 * Renders a thumbnail when the item has a primary image, falling back to
 * the missing-photo hatch otherwise. We swap to the hatch on `onError` too,
 * since signed URLs can race expiry or the underlying file can have been
 * deleted between the API response and the <img> fetch — better a
 * placeholder than a broken-image glyph.
 *
 * Single source of truth for item thumbnails across the app:
 *   • PO detail line table (sm)
 *   • ⌘K command palette item rows (sm)
 *
 * Every instance wraps in an <ImageHoverPreview> so hovering the small
 * thumbnail surfaces a 280px floating preview of the actual image — the
 * signed URL serves the original upload, not a crop, so the preview is
 * genuinely sharp rather than a stretched 28px frame.
 *
 * Look (DESIGN-SPEC 4 and 6.14): a hairline (--line) box, the photo cropped to
 * fill it on a white tile in both themes (a cut-out photo shot on white reads
 * the same in either theme, and a dark one does not vanish into a dark tile);
 * no photo is the hatch in the line colour on sunk, the same placeholder the
 * Items table draws. When this branch rebases onto P2.6, the tile and the
 * hatch render through patterns/thumb.tsx and patterns/missing-photo.tsx and
 * the local HATCH goes (PLAN P2.4).
 */
interface Props {
  /** Small tile source (a ~200px thumb where available) — kept lightweight so
   *  a 28-40px tile doesn't download a 2048px master. */
  imageUrl: string | null | undefined;
  /** Larger source for the floating hover preview (the master). Falls back to
   *  `imageUrl` when omitted, so callers that only have one URL still work. */
  previewUrl?: string | null;
  alt: string;
  /** sm = 28×28 (compact rows); md = 40×40 (line tables / pickers). Default md. */
  size?: 'sm' | 'md';
  /**
   * When provided, resets the internal `failed` state any time the
   * itemId changes — useful for virtualised / re-keyed rows that reuse
   * the same component instance for different items.
   */
  itemId?: string;
  /** Optional rich preview metadata. Title defaults to `alt`. */
  previewTitle?: string | null;
  previewSubtitle?: string | null;
  previewMeta?: React.ReactNode;
}

/** The missing-photo hatch: 1px lines in the line colour every 6px (drawn
 *  over the tile's sunk fill). */
const HATCH = 'repeating-linear-gradient(45deg, var(--ed-line) 0 1px, transparent 1px 6px)';

export function ItemThumb({
  imageUrl,
  previewUrl,
  alt,
  size = 'md',
  itemId,
  previewTitle,
  previewSubtitle,
  previewMeta,
}: Props) {
  // Track failures so swapping back/forth in pagination doesn't
  // re-fetch a known-broken URL each time.
  const [failed, setFailed] = React.useState(false);
  // Reset when the URL OR the item changes — a fresh signed URL for the
  // same item should retry, and a different item gets its own attempt.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on open/close
    setFailed(false);
  }, [imageUrl, itemId]);

  // A server-rendered thumbnail whose file is gone can fail before hydration:
  // its error fired before React was listening, so onError never ran and the
  // broken-image glyph stayed (the alt text in a torn frame). An image that
  // finished with no pixels is asked for once more; that error reaches
  // onError, and the hatch replaces it. A lazy image not fetched yet is not
  // complete, so it is left alone.
  const imgRef = React.useRef<HTMLImageElement | null>(null);
  React.useEffect(() => {
    const img = imgRef.current;
    if (!img || !img.complete || img.naturalWidth > 0) return;
    const src = img.getAttribute('src');
    if (src) img.src = src;
  }, [imageUrl, itemId]);

  // 28px tiles take the 5px radius of the other 28px thumbnails; 40px the 6px.
  const boxClass = cn(
    'shrink-0 border border-border',
    size === 'sm' ? 'size-7 rounded-[5px]' : 'size-10 rounded-md',
  );

  const inner =
    imageUrl && !failed ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        ref={imgRef}
        src={imageUrl}
        alt={alt}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className={cn(boxClass, 'bg-white object-cover')}
      />
    ) : (
      <div
        className={cn(boxClass, 'bg-sunk')}
        style={{ backgroundImage: HATCH }}
        aria-hidden="true"
        data-testid="item-thumb-placeholder"
      />
    );

  return (
    <ImageHoverPreview
      src={imageUrl && !failed ? (previewUrl ?? imageUrl) : null}
      alt={alt}
      title={previewTitle ?? alt}
      subtitle={previewSubtitle ?? null}
      meta={previewMeta ?? null}
      className="shrink-0"
    >
      {inner}
    </ImageHoverPreview>
  );
}
