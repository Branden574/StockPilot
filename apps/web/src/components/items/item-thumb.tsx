'use client';

import * as React from 'react';

import { MissingPhoto } from '@/components/patterns/missing-photo';
import { Thumb, type ThumbSize } from '@/components/patterns/thumb';
import { ImageHoverPreview } from '@/components/ui/image-hover-preview';

/**
 * Renders a thumbnail when the item has a primary image, falling back to
 * the missing-photo hatch otherwise. We swap to the hatch on `onError` too,
 * since signed URLs can race expiry or the underlying file can have been
 * deleted between the API response and the <img> fetch — better a
 * placeholder than a broken-image glyph.
 *
 * Single source of truth for item thumbnails across the app:
 *   • PO detail line table (line, 32px)
 *   • ⌘K command palette item rows (sm)
 *
 * Every instance wraps in an <ImageHoverPreview> so hovering the small
 * thumbnail surfaces a 280px floating preview of the actual image — the
 * signed URL serves the original upload, not a crop, so the preview is
 * genuinely sharp rather than a stretched 28px frame.
 *
 * Look (DESIGN-SPEC 4 and 6.14): the frame is the shared Thumb pattern (a
 * hairline box on a white tile) and the no-photo placeholder is the shared
 * MissingPhoto hatch (line strokes on sunk), the same frame and hatch the
 * Items table, the grid card and the item cell draw. The photo is this
 * component's own <img> in that frame, so a failed load still swaps to the
 * hatch and drops the hover preview of a broken image, and the retry below
 * still reaches a photo that failed before hydration. The photo carries its
 * own white tile too, so a cut-out photo stays on white in both themes
 * whatever the frame draws.
 */
interface Props {
  /** Small tile source (a ~200px thumb where available) — kept lightweight so
   *  a 28-40px tile doesn't download a 2048px master. */
  imageUrl: string | null | undefined;
  /** Larger source for the floating hover preview (the master). Falls back to
   *  `imageUrl` when omitted, so callers that only have one URL still work. */
  previewUrl?: string | null;
  alt: string;
  /** sm = 28×28 (compact rows); line = 32×32 (PO lines); md = 40×40 (pickers).
   *  Default md. */
  size?: 'sm' | 'md' | 'line';
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

/** The Thumb frame for each size. sm is Thumb's own 28px frame (radius 5).
 *  line is Thumb's 32px frame (radius 6), the PO line's thumbnail (DESIGN-SPEC
 *  4 and 6.18; FX9: PO lines drew sm). Thumb's declared sizes stop at 34 below
 *  the 56 and 64 media, so md keeps ItemThumb's 40px box on the 32px frame and
 *  its 6px radius. */
const FRAME: Record<NonNullable<Props['size']>, { size: ThumbSize; className?: string }> = {
  sm: { size: 28 },
  line: { size: 32 },
  md: { size: 32, className: 'size-10' },
};

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

  const frame = FRAME[size];

  return (
    <ImageHoverPreview
      src={imageUrl && !failed ? (previewUrl ?? imageUrl) : null}
      alt={alt}
      title={previewTitle ?? alt}
      subtitle={previewSubtitle ?? null}
      meta={previewMeta ?? null}
      className="shrink-0"
    >
      <Thumb size={frame.size} className={frame.className}>
        {imageUrl && !failed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={imgRef}
            src={imageUrl}
            alt={alt}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className="absolute inset-0 h-full w-full bg-white object-cover"
          />
        ) : (
          <MissingPhoto className="absolute inset-0" data-testid="item-thumb-placeholder" />
        )}
      </Thumb>
    </ImageHoverPreview>
  );
}
